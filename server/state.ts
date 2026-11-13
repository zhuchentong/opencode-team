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
import * as os from "node:os";
import { dirname, join } from "node:path";
import { type ActiveOther, type FlowLogEntry, type ReportLevel, type WfState, isLeader } from "./lib.ts";

// instructions.entry 的 key（非存储键——P1 不动 entry 通道）
export const ENTRY_KEY = "wf.phase";
export const HINT_KEY = "wf.hint"; // P3：自动激活一次性提示（不入状态机，reset 一并清除）

// 旧 storage 行前缀（仅一次性迁移使用）
export const STATE_PREFIX = "wf-workflow/state/";
export const REPORT_PREFIX = "wf-workflow/report/";

export const logAdd = (st: WfState, entry: FlowLogEntry) => {
  st.log = Array.isArray(st.log) ? st.log : [];
  // M16-r39 T01：单调序号——截断 50 不影响 events 增量判定（修审计停追）；
  // 存量快照无 logSeq → 以当前 length 为基数（手工 push 场景同语义）
  st.logSeq = (typeof st.logSeq === "number" ? st.logSeq : st.log.length) + 1;
  st.log.push(entry);
  if (st.log.length > 50) st.log = st.log.slice(-50);
};

// ── M16-r39 T04：单语句 CAS 原子写原语 ────────────────────────────────
// 旧 save 读-比-写三步非原子（同进程 TOCTOU 窗口：qGet 与 qUpsert 之间并发写者插入）。
// 新原语把胜负判定压进单条 SQL：null→INSERT rev=1（UNIQUE 冲突=并发抢先→stale-rev 可重试）；
// number→UPDATE…WHERE session_id AND rev（changes=0→stale-rev）。跨进程原子性由单测证明。
export interface TaskRow {
  sessionID: string; slug: string; phase: string | null;
  projectID: string | null; directory: string | null;
  isActive: number | null; updatedAt: string; stateJson: string;
}
export function writeTaskRow(db: Database, row: TaskRow, expectedRev: number | null):
  { ok: true; rev: number } | { ok: false; reason: "stale-rev" | "write-error" } {
  try {
    if (expectedRev == null) {
      db.prepare(
        `INSERT INTO tasks (session_id, slug, phase, project_id, directory, is_active, rev, updated_at, state_json)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(row.sessionID, row.slug, row.phase, row.projectID, row.directory, row.isActive, row.updatedAt, row.stateJson);
      return { ok: true, rev: 1 };
    }
    const r = db.prepare(
      `UPDATE tasks SET slug=?, phase=?, project_id=?, directory=?, is_active=?, rev=?, updated_at=?, state_json=?
       WHERE session_id=? AND rev=?`,
    ).run(row.slug, row.phase, row.projectID, row.directory, row.isActive, expectedRev + 1, row.updatedAt, row.stateJson,
      row.sessionID, expectedRev);
    if (r.changes === 0) return { ok: false, reason: "stale-rev" };
    return { ok: true, rev: expectedRev + 1 };
  } catch (e) {
    // UNIQUE 冲突（并发 INSERT 抢先）→ stale-rev 可重试；其余写错误 → write-error
    if (/UNIQUE/i.test(String((e as Error)?.message ?? e))) return { ok: false, reason: "stale-rev" };
    return { ok: false, reason: "write-error" };
  }
}

// ── M16-r39 T06：deps 类型化（Store 契约；宿主入参 ctx 保留 any，内部数据流用领域类型）──
export type SaveResult = { ok: boolean; reason?: string; rev?: number };
// notification-brief-display T01：行形状扩 brief/level（nullable——旧行/未携新字段的写入为 null，
// TUI 本地降级 briefOf 消费；wire 经 additionalProperties 透传）
export interface ReportRow { sessionID: string; text: string; at: string | null; brief: string | null; level: ReportLevel | null }
export interface StateListItem {
  sessionID: string; slug: string; phase: string | null;
  rounds: Record<string, number>; testPlanWritten: boolean;
  testReportVerdict: string | null; updatedAt: string | null;
}
export interface Store {
  load(sessionID: string): Promise<WfState | null>;
  save(st: WfState): Promise<SaveResult>;
  removeState(sessionID: string): Promise<void>;
  resolveState(sessionID: string, agent?: string): Promise<WfState | null>;
  resolveProjectDir(st: WfState | null, sessionID: string): Promise<string>;
  scanStates(projectID?: string | null, directory?: string | null): Promise<StateListItem[]>;
  putReport(r: { sessionID: string; text: string; at: string; brief?: string; level?: ReportLevel }): Promise<void>;
  getReport(sessionID: string): Promise<ReportRow | null>;
  dumpStates(): Promise<{ key: string; value: unknown }[]>;
  ready: Promise<void>;
  close(): void;
}

// ── M16-r39 T07：状态写回重试归一（transition/lane/artifact 记账三处同源）────
// 语义：attempt=1..max；load null→gone；apply 返回串→halt（不重试，msg 透传）；
// save ok→{ok:true,st}；stale-rev 且 attempt<max→重载重放；否则终败（reason 归一）。
// apply 每 attempt 恰一次（审计记账不翻倍）；load(1) 由调用方决定复用首快照或新建。
export type RetryResult = { ok: true; st: WfState } | { ok: false; reason: string; msg?: string };
export async function withStateRetry(opts: {
  load: (attempt: number) => Promise<WfState | null>;
  apply: (st: WfState, attempt: number) => string | null | Promise<string | null>;
  save: (st: WfState) => Promise<SaveResult>;
  maxAttempts?: number; // 缺省 3
}): Promise<RetryResult> {
  const max = opts.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= max; attempt++) {
    const st = await opts.load(attempt);
    if (!st) return { ok: false, reason: "gone" };
    const halt = await opts.apply(st, attempt);
    if (typeof halt === "string") return { ok: false, reason: "halt", msg: halt };
    const saved = await opts.save(st);
    if (saved.ok) return { ok: true, st };
    if (saved.reason === "stale-rev" && attempt < max) continue;
    return { ok: false, reason: saved.reason ?? "write-error" };
  }
  return { ok: false, reason: "write-error" }; // 不可达（末次 attempt 必在循环内返回）
}

const STALE_MS = 14 * 24 * 3600 * 1000; // A7：done 状态 14 天 GC（原 storage 版语义保留）

// ── selfmod-concurrency-guard T01（F2 v2）：跨项目活动任务扫描 ──────────────────
// v1 进程内存注册表两处盲区（双任务+implant 卡死日志实证）：①休眠未收尾任务不在内存——用户多日
//   resume 习惯下恰是主要干扰源；②模块级内存表随热载清零——护栏静默失明（I-1，正击穿其保护目标）。
// v2 = PROJECT_DBS 内存表（加速）∪ 持久项目清单（append-only JSONL，热载后仍在）；扫描逐库校验
//   存在性。全链 fail-open：只产告警素材绝不阻断流转；单坏库跳过不影响其它；写清单失败静默降级纯内存。
// 隔离钩子：WF_PROJECTS_FILE 显式设置=只读该文件、忽略内存表与写入（测试确定性，防同进程他文件库污染）。
export const PROJECT_DBS = new Map<string, string>();
export const PROJECTS_FILE_DEFAULT = (() => {
  try {
    const base = process.env.XDG_DATA_HOME || join(process.env.HOME ?? os.homedir(), ".local", "share");
    return join(base, "opencode", "wf-projects.jsonl");
  } catch { return ""; }
})();
export function projectsListFile(): string { return process.env.WF_PROJECTS_FILE || PROJECTS_FILE_DEFAULT; }
// 登记（createStore 调用）：内存恒记；文件仅在未设 WF_PROJECTS_FILE 时追加（env 钩子=完全接管语义）。
// JSONL 逐行 append：无读-改-写竞态（多进程并发安全，坏行=撕裂写，扫描侧跳过）。
export function registerProject(dir: string, dbFile: string): void {
  try {
    if (!dir || !dbFile) return;
    PROJECT_DBS.set(dir, dbFile);
    if (process.env.WF_PROJECTS_FILE !== undefined) return;
    const f = projectsListFile();
    if (!f) return;
    fs.mkdirSync(dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ dir, dbFile }) + "\n");
  } catch { /* fail-open：持久化失败退化为纯内存表 */ }
}
function readProjectsList(): string[] {
  try {
    const txt = fs.readFileSync(projectsListFile(), "utf8");
    const out: string[] = [];
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.dbFile === "string" && o.dbFile) out.push(o.dbFile);
      } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch { return []; }
}
// 扫描其它会话的活动任务（intake 自改命中时调用）。排除自身会话行；防御性过滤（无 slug/done 行
// 即使 is_active=1 也不展示——外部写库形状漂移兜底）。updatedAt 原样带出（lib 侧分级措辞消费）。
export function scanActiveTasks(excludeSessionID: string): ActiveOther[] {
  const sid = String(excludeSessionID ?? "");
  const files = new Set<string>();
  if (!process.env.WF_PROJECTS_FILE) for (const f of PROJECT_DBS.values()) files.add(f);
  for (const f of readProjectsList()) files.add(f);
  const out: ActiveOther[] = [];
  for (const f of files) {
    let d: any = null;
    try {
      if (!fs.existsSync(f)) continue; // 清单条目对应项目已删（存在性逐条目校验，防清单虚胖）
      // S-3 降级链：readonly 打开（不扰活写者）→ WAL 恢复等失败退普通打开（create:false 不建库）→ 仍败跳过
      try { d = new Database(f, { readonly: true }); }
      catch { d = new Database(f, { create: false }); }
      const rows = d.prepare(
        "SELECT slug, phase, directory, updated_at FROM tasks WHERE is_active = 1 AND session_id != ?",
      ).all(sid) as { slug: string; phase: string | null; directory: string | null; updated_at: string | null }[];
      for (const r of rows) {
        if (!r?.slug || r.phase === "done") continue;
        out.push({ slug: String(r.slug), phase: r.phase ?? null, directory: r.directory ?? null, updatedAt: r.updated_at ?? null });
      }
    } catch { /* 单库失败（锁死/损坏/无表）=跳过该库 */ }
    finally { try { d?.close(); } catch { /* 句柄释放 best-effort */ } }
  }
  out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return out;
}

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
  at TEXT,
  brief TEXT,
  level TEXT
);
`;

// 行→快照解析（模块级纯函数：只读 row.state_json，不依赖 createStore 闭包；lint function-scoping 上提）
const parse = (row: any): WfState | null => {
  try { return JSON.parse(row.state_json); } catch { return null; }
};

export function createStore(ctx: any): Store {
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
  // selfmod-guard F2 v2：登记本项目库到内存表+持久清单（供引擎自改 intake 跨库扫描；fail-open 见函数内）
  registerProject(dir, dbFile);
  // notification-brief-display T01：旧库 reports 表加列迁移（CREATE IF NOT EXISTS 对存量表
  // 是 no-op，不会补列）。PRAGMA table_info 检查缺列才 ALTER——幂等，二次打开零操作不报错。
  for (const col of ["brief", "level"]) {
    try {
      const cols = db.prepare("PRAGMA table_info(reports)").all() as { name: string }[];
      if (!cols.some((c) => c?.name === col)) db.run(`ALTER TABLE reports ADD COLUMN ${col} TEXT`);
    } catch { /* 单列迁移失败不阻塞启动（读写路径自带 ?? null 降级） */ }
  }

  const qGet = db.prepare("SELECT state_json, rev FROM tasks WHERE session_id = ?");
  // M16-r39 T04：qUpsert 仅留一次性迁移用（save 路径改委托 writeTaskRow 单语句 CAS）
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
    "INSERT INTO reports (session_id, text, at, brief, level) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text=excluded.text, at=excluded.at, brief=excluded.brief, level=excluded.level",
  );
  const qRepGet = db.prepare("SELECT session_id, text, at, brief, level FROM reports WHERE session_id = ?");
  const qRepDel = db.prepare("DELETE FROM reports WHERE session_id = ?");
  const qTaskDel = db.prepare("DELETE FROM tasks WHERE session_id = ?");
  const qProj = db.prepare(
    "SELECT state_json FROM tasks WHERE project_id = ? AND session_id != ? ORDER BY updated_at DESC LIMIT 1",
  );
  const qAll = db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC");
  const qGc = db.prepare("DELETE FROM tasks WHERE phase = 'done' AND updated_at IS NOT NULL AND updated_at < ?");
  // F3（双库幽灵行取证）：slug='' 且 phase 空=历史缺陷/迁移产物，恒非活动且现 GC（只清 done）永不回收 → 显式清理。
  // 无误杀论证：intake 落库 slug 恒非空（slugify ‖ st.slug ‖ "untitled"）；拒绝路径无前行不落盘（T02）；
  //   持 phase 的行（如空 slug+phase=intake 的开发态）与空 slug+done（新鲜 done 存量锚）均不满足双空条件，不受影响。
  const qGhost = db.prepare("DELETE FROM tasks WHERE slug = '' AND (phase IS NULL OR phase = '')");
  const qCount = db.prepare("SELECT COUNT(*) AS n FROM tasks");

  const load = async (sessionID: string): Promise<WfState | null> => {
    try { return parse(qGet.get(String(sessionID ?? ""))) ?? null; } catch { return null; }
  };

  // save：乐观锁写入。行已存在且快照携带的 rev 与当前行不一致 → 拒写（旧 last-write-wins 会静默
  // 丢更新，现在保新弃旧；console.warn 进 server 日志可回看）。无 rev 的新建快照 → 显式覆盖。
  // M16-r39 T04：pre-check 快速路径保留，实际写入委托 writeTaskRow 单语句 CAS（消除读-写窗口）。
  const save = async (st: WfState): Promise<SaveResult> => {
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
      const w = writeTaskRow(db, {
        sessionID: sid, slug: String(st.slug ?? ""), phase: st.phase ?? null,
        projectID: st.projectID != null ? String(st.projectID) : null,
        directory: st.directory != null ? String(st.directory) : null,
        isActive, updatedAt: st.updatedAt, stateJson: JSON.stringify(st),
      }, prev ? prev.rev : null);
      if (!w.ok) {
        try { console.warn(`[wf] save rejected (${w.reason}): session=${sid} incoming=${st.rev} current=${prev?.rev ?? "(无行)"}`); } catch { }
        return { ok: false, reason: w.reason };
      }
      // append-only 流水：仅追加上次落盘后新增的 log 尾项。M16-r39 T01：按 logSeq 单调序号差判定
      // （旧 length 比对在 50 条截断后恒差 0 → 审计停追）；存量无 logSeq → length 回退（手工 push 兼容）
      const prevSt = prev ? parse(prev) : null;
      const newLog = Array.isArray(st.log) ? st.log : [];
      const prevSeq = prevSt?.logSeq ?? prevSt?.log?.length ?? 0;
      const curSeq = st.logSeq ?? newLog.length;
      const n = Math.max(0, Math.min(curSeq - prevSeq, newLog.length));
      for (const e of newLog.slice(newLog.length - n)) qEv.run(sid, String(e?.at ?? st.updatedAt), JSON.stringify(e ?? {}));
    } catch (e) {
      try { console.warn(`[wf] save failed: ${String((e as Error)?.message ?? e)}`); } catch { }
      return { ok: false, reason: "write-error" };
    }
    return { ok: true, rev };
  };

  // reset：清除任务行与报告槽（events 流水为审计保留，不删）
  const removeState = async (sessionID: string): Promise<void> => {
    try { qTaskDel.run(String(sessionID ?? "")); } catch { }
    try { qRepDel.run(String(sessionID ?? "")); } catch { }
  };

  // M10-b：wf/* 子会话经项目反查管辖状态（原项目索引键 IDX 的 SQL 等价：同 project 最近落盘）
  const resolveState = async (sessionID: string, agent?: string): Promise<WfState | null> => {
    const own = await load(sessionID);
    if (own) return own;
    const a = String(agent ?? "");
    // 仅 wf/* agent 与 leader（workflow，兼容 wf/leader）受项目管辖；普通会话不受影响（M16-r38）
    if (!a.startsWith("wf/") && !isLeader(a)) return null;
    try {
      const s = await ctx.session.get({ sessionID });
      const pid = s?.projectID;
      if (!pid) return null;
      return parse(qProj.get(String(pid), String(sessionID))) ?? null;
    } catch { return null; }
  };

  // 落盘目录三级回退同源提取：优先管辖状态的 directory，回退本会话 session.get，再回退 cwd
  const resolveProjectDir = async (st: WfState | null, sessionID: string): Promise<string> => {
    let d = st?.directory ?? null;
    if (!d) {
      const sess = await ctx.session.get({ sessionID }).catch(() => null);
      d = sess?.location?.directory ?? null;
    }
    return d ?? process.cwd();
  };

  // M8-b 状态枚举 + A7 done GC + A6/M14 项目过滤（输出形状与 storage 版逐字段一致，rpc-bridge 直接消费）
  const scanStates = async (projectID?: string | null, directory?: string | null): Promise<StateListItem[]> => {
    const out: StateListItem[] = [];
    try {
      try { qGc.run(new Date(Date.now() - STALE_MS).toISOString()); } catch { /* GC 失败按保留处理 */ }
      try { qGhost.run(); } catch { /* F3 幽灵行清理失败按保留处理 */ }
      for (const row of qAll.all()) {
        const v = parse(row);
        if (!v || typeof v !== "object") continue;
        // A6：按项目过滤（M14：无 projectID 的旧状态回退 directory 比较，匹配则显示）
        if (projectID) {
          if (row.project_id) { if (String(row.project_id) !== String(projectID)) continue; }
          else if (!(directory && v.directory && String(v.directory) === String(directory))) continue;
        }
        out.push({
          sessionID: String(v.sessionID ?? row.session_id),
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

  // ── reports 命令输出槽（r29e 主通道的 SQLite 化；形状必须保持含 sessionID
  //    ——bug A 教训：缺 sessionID 字段 TUI toastReport 过滤器会把 toast 全拦掉。
  //    T01 扩 brief/level：可选入参，缺省落 null（旧调用方零改动）──
  const putReport = async (r: { sessionID: string; text: string; at: string; brief?: string; level?: ReportLevel }): Promise<void> => {
    qRep.run(String(r.sessionID ?? ""), String(r.text ?? ""), r.at ? String(r.at) : null,
      r.brief != null ? String(r.brief) : null, r.level != null ? String(r.level) : null);
  };
  const getReport = async (sessionID: string): Promise<ReportRow | null> => {
    const row = qRepGet.get(String(sessionID ?? ""));
    if (!row) return null;
    return { sessionID: row.session_id, text: row.text, at: row.at ?? null, brief: row.brief ?? null, level: row.level ?? null };
  };

  // wf:debug 转储用：近似旧 storage scan 的 [{key, value}] 形状
  const dumpStates = async (): Promise<{ key: string; value: unknown }[]> => {
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
        v.logSeq = Array.isArray(v.log) ? v.log.length : 0; // M16-r39 T01：存量序号初始化（后续 logAdd 自此递增）
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
          qRep.run(String(v.sessionID ?? ks.slice(REPORT_PREFIX.length)), String(v.text), v.at ? String(v.at) : null, null, null);
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