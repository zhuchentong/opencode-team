// wf-workflow — 状态存取层（P1 重设计：SQLite 单库替代 ctx.storage 行键）
// 库路径 <项目>/.workflow/wf.db（bun:sqlite, WAL）。表：
//   tasks    — 状态整份 JSON 快照（state_json 为唯一真相）+ 查询投影列（slug/phase/project_id/…）。
//              乐观锁 rev：load 随快照带出，save 比对，stale 快照拒写（防陈旧覆盖新进度，
//              对应 goopspec wouldRegress 语义；此处不能用阶段 rank 倒退判定——M10-a 返工边合法）。
//              partial unique index 记录「一会话一活跃任务」意图（PK 已蕴含，索引为文档化约束）。
//   events   — append-only 流转流水（save 时按 st.log 增量尾追）。
//   reports  — 命令输出槽（替代旧 storage 键 wf-workflow/report/<sid>；TUI 轮询 state.lastReport 主通道）。
// resolveState：wf/* 子会话经 project_id 列反查管辖状态（替代旧项目索引键）。
// 一次性迁移：首次初始化且 tasks 为空时，从旧 ctx.storage 行导入（旧键保留不删，作备份）。
// 原则：本文件只放与持久化/session 相关的存取逻辑；纯流转校验见 lib.ts，组装接线见 index.ts。
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { type FlowLogEntry } from "./lib.ts";

// instructions.entry 的 key（非存储键——P1 不动 entry 通道）
export const ENTRY_KEY = "wf.phase";
export const HINT_KEY = "wf.hint"; // P3：自动激活一次性提示（不入状态机，reset 一并清除）

// 旧 storage 行前缀（仅一次性迁移使用）
export const STATE_PREFIX = "wf-workflow/state/";
export const REPORT_PREFIX = "wf-workflow/report/";

export const logAdd = (st: any, entry: FlowLogEntry) => {
  st.log = Array.isArray(st.log) ? st.log : [];
  st.log.push(entry);
  if (st.log.length > 50) st.log = st.log.slice(-50);
};

const STALE_MS = 14 * 24 * 3600 * 1000; // A7：done 状态 14 天 GC（原 storage 版语义保留）

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  session_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL DEFAULT '',
  phase TEXT,
  project_id TEXT,
  directory TEXT,
  is_active INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  state_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active_per_session
  ON tasks(session_id) WHERE is_active = 1;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at TEXT,
  entry_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  session_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  at TEXT
);
`;

export function createStore(ctx: any) {
  const dir = ctx?.location?.directory ?? process.cwd();
  const dbFile = join(dir, ".workflow", "wf.db");
  fs.mkdirSync(dirname(dbFile), { recursive: true });
  // git 防护：状态库与 WAL/SHM 文件不入 git（产物 md 不受影响，仍可提交）
  try {
    const gi = join(dirname(dbFile), ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "wf.db\nwf.db-*\n");
  } catch { /* 写入失败不阻塞（宿主项目自行管理 gitignore 亦可） */ }

  const db: any = new Database(dbFile, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA busy_timeout=5000");
  db.run(SCHEMA);

  const qGet = db.prepare("SELECT state_json, rev FROM tasks WHERE session_id = ?");
  const qUpsert = db.prepare(
    `INSERT INTO tasks (session_id, slug, phase, project_id, directory, is_active, rev, updated_at, state_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       slug=excluded.slug, phase=excluded.phase, project_id=excluded.project_id,
       directory=excluded.directory, is_active=excluded.is_active, rev=excluded.rev,
       updated_at=excluded.updated_at, state_json=excluded.state_json`,
  );
  const qEv = db.prepare("INSERT INTO events (session_id, at, entry_json) VALUES (?, ?, ?)");
  const qRep = db.prepare(
    "INSERT INTO reports (session_id, text, at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text=excluded.text, at=excluded.at",
  );
  const qRepGet = db.prepare("SELECT session_id, text, at FROM reports WHERE session_id = ?");
  const qRepDel = db.prepare("DELETE FROM reports WHERE session_id = ?");
  const qTaskDel = db.prepare("DELETE FROM tasks WHERE session_id = ?");
  const qProj = db.prepare(
    "SELECT state_json FROM tasks WHERE project_id = ? AND session_id != ? ORDER BY updated_at DESC LIMIT 1",
  );
  const qAll = db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC");
  const qGc = db.prepare("DELETE FROM tasks WHERE phase = 'done' AND updated_at IS NOT NULL AND updated_at < ?");
  const qCount = db.prepare("SELECT COUNT(*) AS n FROM tasks");

  const parse = (row: any) => {
    try { return JSON.parse(row.state_json); } catch { return null; }
  };

  const load = async (sessionID: string): Promise<any> => {
    try { return parse(qGet.get(String(sessionID ?? ""))) ?? null; } catch { return null; }
  };

  // save：乐观锁写入。行已存在且快照携带的 rev 与当前行不一致 → 拒写（旧 last-write-wins 会静默
  // 丢更新，现在保新弃旧；console.warn 进 server 日志可回看）。无 rev 的新建快照 → 显式覆盖。
  const save = async (st: any): Promise<{ ok: boolean; reason?: string; rev?: number }> => {
    if (!st || st.sessionID == null) return { ok: false, reason: "no-session" };
    st.updatedAt = new Date().toISOString();
    const sid = String(st.sessionID);
    let prev: any = null;
    try { prev = qGet.get(sid); } catch { /* 读失败按无前行处理 */ }
    if (prev && typeof st.rev === "number" && st.rev !== prev.rev) {
      try { console.warn(`[wf] stale-rev save rejected: session=${sid} incoming=${st.rev} current=${prev.rev}`); } catch { }
      return { ok: false, reason: "stale-rev" };
    }
    const rev = Number(prev?.rev ?? 0) + 1;
    st.rev = rev;
    const isActive = st.phase && st.phase !== "done" ? 1 : null;
    try {
      qUpsert.run(sid, String(st.slug ?? ""), st.phase ?? null,
        st.projectID != null ? String(st.projectID) : null,
        st.directory != null ? String(st.directory) : null,
        isActive, rev, st.updatedAt, JSON.stringify(st));
      // append-only 流水：仅追加上次落盘后新增的 log 尾项（logAdd 的 50 条截断不影响判定）
      const oldLog = prev ? (parse(prev)?.log ?? []) : [];
      const newLog = Array.isArray(st.log) ? st.log : [];
      for (const e of newLog.slice(oldLog.length)) qEv.run(sid, String(e?.at ?? st.updatedAt), JSON.stringify(e ?? {}));
    } catch (e) {
      try { console.warn(`[wf] save failed: ${String((e as Error)?.message ?? e)}`); } catch { }
      return { ok: false, reason: "write-error" };
    }
    return { ok: true, rev };
  };

  // reset：清除任务行与报告槽（events 流水为审计保留，不删）
  const removeState = async (sessionID: string) => {
    try { qTaskDel.run(String(sessionID ?? "")); } catch { }
    try { qRepDel.run(String(sessionID ?? "")); } catch { }
  };

  // M10-b：wf/* 子会话经项目反查管辖状态（原项目索引键 IDX 的 SQL 等价：同 project 最近落盘）
  const resolveState = async (sessionID: string, agent?: string): Promise<any> => {
    const own = await load(sessionID);
    if (own) return own;
    if (!String(agent ?? "").startsWith("wf/")) return null; // 仅 wf/* agent 受项目管辖；普通会话不受影响
    try {
      const s = await ctx.session.get({ sessionID });
      const pid = s?.projectID;
      if (!pid) return null;
      return parse(qProj.get(String(pid), String(sessionID))) ?? null;
    } catch { return null; }
  };

  // 落盘目录三级回退同源提取：优先管辖状态的 directory，回退本会话 session.get，再回退 cwd
  const resolveProjectDir = async (st: any, sessionID: string) => {
    let d = st?.directory ?? null;
    if (!d) {
      const sess = await ctx.session.get({ sessionID }).catch(() => null);
      d = sess?.location?.directory ?? null;
    }
    return d ?? process.cwd();
  };

  // M8-b 状态枚举 + A7 done GC + A6/M14 项目过滤（输出形状与 storage 版逐字段一致，rpc-bridge 直接消费）
  const scanStates = async (projectID?: string | null, directory?: string | null) => {
    const out: any[] = [];
    try {
      try { qGc.run(new Date(Date.now() - STALE_MS).toISOString()); } catch { /* GC 失败按保留处理 */ }
      for (const row of qAll.all()) {
        const v = parse(row);
        if (!v || typeof v !== "object") continue;
        // A6：按项目过滤（M14：无 projectID 的旧状态回退 directory 比较，匹配则显示）
        if (projectID) {
          if (row.project_id) { if (String(row.project_id) !== String(projectID)) continue; }
          else if (!(directory && v.directory && String(v.directory) === String(directory))) continue;
        }
        out.push({
          sessionID: v.sessionID ?? row.session_id,
          slug: v.slug ?? "",
          phase: v.phase ?? null,
          rounds: v.rounds ?? {},
          testPlanWritten: !!v.testPlanWritten,
          testReportVerdict: v.testReportVerdict ?? null,
          updatedAt: v.updatedAt ?? null,
        });
      }
    } catch { /* 扫描失败按空处理 */ }
    out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return out.slice(0, 20);
  };

  // ── reports 命令输出槽（r29e 主通道的 SQLite 化；形状必须保持 {sessionID,text,at}
  //    ——bug A 教训：缺 sessionID 字段 TUI toastReport 过滤器会把 toast 全拦掉）──
  const putReport = async (r: { sessionID: string; text: string; at: string }) => {
    qRep.run(String(r.sessionID ?? ""), String(r.text ?? ""), r.at ? String(r.at) : null);
  };
  const getReport = async (sessionID: string): Promise<any> => {
    const row = qRepGet.get(String(sessionID ?? ""));
    if (!row) return null;
    return { sessionID: row.session_id, text: row.text, at: row.at ?? null };
  };

  // wf:debug 转储用：近似旧 storage scan 的 [{key, value}] 形状
  const dumpStates = async () => {
    try {
      return qAll.all().map((row: any) => ({
        key: `${STATE_PREFIX}${row.session_id}`,
        value: parse(row) ?? row.state_json,
      }));
    } catch { return []; }
  };

  // 一次性迁移：tasks 为空且旧 ctx.storage 行存在 → 导入（updatedAt 原样保留，不重置 GC 时钟；
  // 旧键保留不删作备份）。失败按空库处理（新开始，不阻塞启动）。
  const ready = (async () => {
    try {
      const n = Number(qCount.get()?.n ?? 0);
      if (n > 0 || !ctx?.storage?.scan) return;
      const res = await ctx.storage.scan({ prefix: STATE_PREFIX });
      const entries = Array.isArray(res) ? res : (res?.entries ?? []);
      for (const e of entries) {
        const k = e?.key ?? e?.[0];
        let v = e?.value ?? e?.[1];
        const ks = Array.isArray(k) ? k.join("/") : String(k);
        if (!ks.startsWith(STATE_PREFIX)) continue;
        if (typeof v === "string") { try { v = JSON.parse(v); } catch { continue; } }
        if (!v || typeof v !== "object") continue;
        const sid = String(v.sessionID ?? ks.slice(STATE_PREFIX.length));
        if (!sid) continue;
        v.sessionID = sid;
        v.rev = 1; // 与 save 路径语义一致：快照携带 rev，迁移后 load→save 走乐观锁
        const isActive = v.phase && v.phase !== "done" ? 1 : null;
        qUpsert.run(sid, String(v.slug ?? ""), v.phase ?? null,
          v.projectID != null ? String(v.projectID) : null,
          v.directory != null ? String(v.directory) : null,
          isActive, 1, v.updatedAt ?? null, JSON.stringify(v));
        for (const le of (Array.isArray(v.log) ? v.log : [])) qEv.run(sid, String(le?.at ?? v.updatedAt ?? ""), JSON.stringify(le ?? {}));
      }
      const rr = await ctx.storage.scan({ prefix: REPORT_PREFIX });
      const re = Array.isArray(rr) ? rr : (rr?.entries ?? []);
      for (const e of re) {
        const k = e?.key ?? e?.[0];
        let v = e?.value ?? e?.[1];
        const ks = Array.isArray(k) ? k.join("/") : String(k);
        if (!ks.startsWith(REPORT_PREFIX)) continue;
        if (typeof v === "string") { try { v = JSON.parse(v); } catch { continue; } }
        if (v && typeof v === "object" && v.text != null) {
          qRep.run(String(v.sessionID ?? ks.slice(REPORT_PREFIX.length)), String(v.text), v.at ? String(v.at) : null);
        }
      }
    } catch { /* 迁移失败不阻塞 */ }
  })();

  return {
    load, save, removeState, resolveState, resolveProjectDir, scanStates,
    putReport, getReport, dumpStates, ready,
    close: () => { try { db.close(); } catch { } },
  };
}
