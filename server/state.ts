// wf-workflow — 状态存取层（P1 重设计：SQLite 单库替代 ctx.storage 行键）
// 库路径 <项目>/.workflow/wf.db（bun:sqlite, WAL）。表：
//   tasks    — 状态整份 JSON 快照（state_json 为唯一真相）+ 查询投影列（slug/phase/project_id/…）。
//              乐观锁 rev：load 随快照带出，save 比对，stale 快照拒写（防陈旧覆盖新进度，
//              对应 goopspec wouldRegress 语义；此处不能用阶段 rank 倒退判定——M10-a 返工边合法）。
//              partial unique index 记录「一会话一活跃任务」意图（PK 已蕴含，索引为文档化约束）。
//   events   — append-only 流转流水（save 时按 st.log 增量尾追）。
//   reports  — 命令输出槽（替代旧 storage 键 wf-workflow/report/<sid>；TUI 轮询 state.lastReport 主通道）。
// resolveState：wf/* 子会话经 project_id 列反查管辖状态（替代旧项目索引键）。
// 一次性迁移：meta.migrated 未置位且 tasks 为空时，从旧 ctx.storage 行导入——仅导入 directory 与
// 本项目一致的行（项目维度过滤，migrate-meta-fix T02；旧键保留不删，作备份）。
// 原则：本文件只放与持久化/session 相关的存取逻辑；纯流转校验见 lib.ts，组装接线见 index.ts。
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type FlowLogEntry, type ReportLevel, type WfState, isLeader, normalizeState, DAY_MS } from "./lib.ts";
import { type Host } from "./host.ts"; // T03：createStore 收 Host（原 ctx:any）
import { swallow } from "./observe.ts"; // T01：静默 catch → 环形审计记账

/** instructions.entry 阶段指引槽 key（写入宿主系统提示 context 块，非存储键）。 */
export const ENTRY_KEY = "wf.phase";
/** 自动激活一次性提示槽 key（P3 hint 通道；reset 一并清除）。 */
export const HINT_KEY = "wf.hint"; // P3：自动激活一次性提示（不入状态机，reset 一并清除）
// 旧 storage 行前缀（仅一次性迁移使用）
export const STATE_PREFIX = "wf-workflow/state/";
export const REPORT_PREFIX = "wf-workflow/report/";

/** 追加一条流转审计日志：维护单调序号 logSeq（截断 50 不影响 events 增量判定），超 50 条裁最旧。
 * @param st 工作流状态快照（原地修改 st.log/st.logSeq）
 * @param entry 流水条目（at/cmd/from/to/ok/note…）
 * @returns 无 */
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
/** 单语句 CAS 原子写 tasks 行：null→INSERT rev=1（UNIQUE 冲突=并发抢先）；number→UPDATE…WHERE rev 比对。
 * @param db 已打开的 SQLite 连接（bun:sqlite）
 * @param row 投影列行（TaskRow 形状）
 * @param expectedRev 期望的当前 rev（null=新建插入）
 * @returns {ok:true, rev} 写入后的新 rev；或 {ok:false, reason:"stale-rev"|"write-error"}（UNIQUE 冲突归 stale-rev 可重试） */
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

// ── M16-r39 T06：deps 类型化（Store 契约）；T03：宿主入参 ctx→host（Host 防腐层），内部数据流用领域类型──
export type SaveResult = { ok: boolean; reason?: string; rev?: number };
// notification-brief-display T01：行形状扩 brief/level（nullable——旧行/未携新字段的写入为 null，
// TUI 本地降级 briefOf 消费；wire 经 additionalProperties 透传）
export interface ReportRow { sessionID: string; text: string; at: string | null; brief: string | null; level: ReportLevel | null }
export interface StateListItem {
  sessionID: string; slug: string; phase: string | null;
  rounds: Record<string, number>; testPlanWritten: boolean; // 投影形状不变（R3 T3.1 子步 B：取值改读 verdicts 子对象）
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
  /** W6-3（可选）：events 表按 cmd 计数（diagnose 长任务直查；mock/缺省可不带，调用方须判空） */
  countEvents?(cmd: string): Promise<number>;
  ready: Promise<void>;
  close(): void;
}

// ── M16-r39 T07：状态写回重试归一（transition/lane/artifact 记账三处同源）────
// 语义：attempt=1..max；load null→gone；apply 返回串→halt（不重试，msg 透传）；
// save ok→{ok:true,st}；stale-rev 且 attempt<max→重载重放；否则终败（reason 归一）。
// apply 每 attempt 恰一次（审计记账不翻倍）；load(1) 由调用方决定复用首快照或新建。
export type RetryResult = { ok: true; st: WfState } | { ok: false; reason: string; msg?: string };
/** 状态写回重试归一（transition/lane/artifact 记账三处同源）：attempt=1..max；load null→gone；
 * apply 返回串→halt（不重试）；save stale-rev 且未达上限→重载重放；apply 每 attempt 恰一次（审计不翻倍）。
 * @param opts load（返回克隆或 null）/apply（返回 halt 文案或 null）/save/maxAttempts（缺省 3）
 * @returns {ok:true, st} 落库后的最新快照；或 {ok:false, reason, msg?}（gone/halt/stale-rev/write-error） */
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

const STALE_MS = 14 * DAY_MS; // A7：done 状态 14 天 GC（原 storage 版语义保留；DAY_MS 单点见 domain/types）
const DB_BUSY_TIMEOUT_MS = 10000; // SQLite busy_timeout（多会话并发写 wf.db 的写锁等待窗口；test_007 实证 5s 窗口内多 lane 并发登记仍写错误→加倍）
// r54 批次 A：WAL 收口与 GC 节流常量（test_008 实证：默认 autocheckpoint=1000 页≈4MB 使 45KB WAL
// 永不自动收拢，任务态唯一副本悬在 -wal 文件上，-wal/-shm 被清即审计整体蒸发）。
const WAL_AUTOCHECKPOINT_PAGES = 64; // ≈256KB 触发自动 checkpoint（远小于默认 1000 页）
const GC_THROTTLE_MS = 60000; // scanStates GC 节流窗口（TUI 5s 轮询空闲项目也会触发 list→scanStates，60s 内不重复跑 DELETE）
/** GC 节流判定（模块级纯函数，bun test 直测）：now 距上次执行 ≥ GC_THROTTLE_MS 才允许再跑。
 * @param now 当前时钟（ms）
 * @param lastAt 上次 GC 执行时钟（ms；0=从未执行）
 * @returns 是否应执行本轮 GC */
export const shouldRunGc = (now: number, lastAt: number): boolean => now - lastAt >= GC_THROTTLE_MS;

// ── P1-A（arch-maintenance-p1）：selfmod 护栏域拆分至 ./state-scan.ts（与 CAS 红线域文件级隔离；
// 平铺顶层——swallow-coverage 守卫 readdirSync 非递归，子目录会逃逸静默 catch 扫描）。
// re-export 保持消费面零改动（11 文件经本模块导入的历史路径不变）。
export {
  PROJECT_DBS, PROJECTS_FILE_DEFAULT, projectsListFile, registerProject, scanActiveTasks,
  type ActiveOther,
} from "./state-scan.ts";
import { registerProject } from "./state-scan.ts"; // createStore 自身调用（re-export 不入当前作用域）


/** 建表 DDL（W15-b 导出：测试夹具直开裸库时须先 run(SCHEMA)——惰性化后 setup 不再建库）。 */
export const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// 行→快照解析（模块级纯函数：只读 row.state_json，不依赖 createStore 闭包；lint function-scoping 上提）
// R3 T3.1：出口接 normalizeState——旧平铺形状在此收敛为分组新形（内存恒新形，save 写新形；
// 幂等，已有新形原样通过）。所有读路径（load/resolveState/scanStates/…）都经 parse，出口单点。
const parse = (row: any): WfState | null => {
  try { return normalizeState(JSON.parse(row.state_json)); } catch { return null; }
};

/** 创建 SQLite 状态存取层：<项目>/.workflow/wf.db（WAL + busy_timeout），含建表、reports 加列迁移、
 * 一次性旧 ctx.storage 导入（ready）与 done GC/幽灵行清理。load 出口经 normalizeState 收敛旧形状。
 * @param host T03 防腐层（location.directory 定库；sessions/storage 用于反查与迁移）
 * @returns Store 契约实现（load/save/removeState/resolveState/resolveProjectDir/scanStates/putReport/getReport/dumpStates/ready/close） */
export function createStore(host: Host): Store {
  const dir = host.location.directory ?? process.cwd();
  const dbFile = join(dir, ".workflow", "wf.db");

  // ── 幻影自愈批 O1（test_53 H1）：let 可重绑定 + openAll 统一初始化 + ensureAlive 存活检测 ──
  // 守护进程按项目目录缓存 setup 产物——项目目录被 rm -rf 后缓存 store 仍持有指向已删 inode 的连接
  //（unlink 幻影），同目录新会话复用该 store：状态写入进不可见库、intake slug 唯一性闸（同库
  // peers 查询）读到幻影旧行误报冲突、headless 磁盘监控轨永久失明（test_53 实证）。
  // ensureAlive 在各方法头检测 dbFile 消失/同路径换 inode（目录重建）→ 关旧连接重跑 openAll。
  // 扫描通道（state-scan.ts）无辜：每次开新 readonly 连接且逐条目 existsSync，不在本修复面。
  // ── W15-b 惰性创建：setup 阶段零磁盘副作用（评审 B-必改①②③落地）──
  // openAll() 从构造期移出；opened 与 curIno 哨兵分离（curIno===undefined 兼作「记录失败」退化态，
  // 若混用「未开」会命中 ensureAlive 防御分支 → 永不 open → 全站静默失明）；读口无建（load/
  // scanStates/getReport/dumpStates/countEvents 未开且库文件不存在 → 空态返回，不物化目录）、
  // 写口有建（save/putReport/removeState 首达 ensureOpen）；并发经 openPromise 单槽去重 +
  // 失败 CAS 回滚（防「半开库误报无任务」——幻影事故镜像形态，评审时序角度阻断项）。
  // 未开态不参与 inode 判定：首开天然取新 inode（O1 简化红利）。
  let db: any;
  let curIno: number | undefined; // openAll 成功后的 inode；undefined=记录失败（退化为现状：仅按消失检测）
  let closed = false;             // close() 置位——防迟到调用经 ensureAlive 复活已删目录（mkdirSync 副作用）
  let opened = false;             // W15-b：是否已 openAll（独立于 curIno；勿混用哨兵）
  let openPromise: Promise<void> | null = null; // W15-b：单槽 in-flight（null=无进行中/已结算）
  let migration: Promise<void> | null = null;   // 一次性迁移（惰性单飞；原构造期 eager IIFE 改造）
  let migrateDone = false;                      // 迁移收口闩（本 store 生命周期一次；幻影重开不重跑=现状语义）
  // 幻影自愈批 O1：15 条 prepared 语句 const→let（openAll 重开时统一重建；SQL 文本单一来源在 openAll 内）
  let qGet: any; let qUpsert: any; let qEv: any; let qRep: any; let qRepGet: any; let qRepDel: any;
  let qTaskDel: any; let qProj: any; let qAll: any; let qGc: any; let qGhost: any; let qEvCount: any;
  let qCount: any; let qMetaGet: any; let qMetaSet: any;
  const openAll = (): void => {
    fs.mkdirSync(dirname(dbFile), { recursive: true });
    // git 防护：状态库与 WAL/SHM 文件不入 git（产物 md 不受影响，仍可提交）
    try {
      const gi = join(dirname(dbFile), ".gitignore");
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, "wf.db\nwf.db-*\n");
    } catch (e) { swallow(e, "state:gitignore-write-fail"); }
    db = new Database(dbFile, { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run(`PRAGMA busy_timeout=${DB_BUSY_TIMEOUT_MS}`); // SQLite 写锁等待上限（多会话并发写 wf.db 容忍窗口）
    db.run(`PRAGMA wal_autocheckpoint=${WAL_AUTOCHECKPOINT_PAGES}`); // r54 A1a：WAL 自动收拢阈值（默认 1000 页过大，任务态长期悬于 -wal）
    db.run(SCHEMA);
    // selfmod-guard F2 v2：登记本项目库到内存表+持久清单（供引擎自改 intake 跨库扫描；fail-open 见函数内；
    // reopen 后重登幂等——state-scan SEEN 同 dir+dbFile 去重）
    registerProject(dir, dbFile);
    // notification-brief-display T01：旧库 reports 表加列迁移（CREATE IF NOT EXISTS 对存量表
    // 是 no-op，不会补列）。PRAGMA table_info 检查缺列才 ALTER——幂等，二次打开零操作不报错。
    for (const col of ["brief", "level"]) {
      try {
        const cols = db.prepare("PRAGMA table_info(reports)").all() as { name: string }[];
        if (!cols.some((c) => c?.name === col)) db.run(`ALTER TABLE reports ADD COLUMN ${col} TEXT`);
      } catch (e) { swallow(e, "state:reports-col-migrate-fail"); }
    }
    // headless-orch M2：slug 唯一性并发收口（check-then-insert TOCTOU 兜底）——partial unique index。
    // 不入 SCHEMA 字符串：存量库可能有既有重复行，SCHEMA 批量执行遇 IntegrityError 会阻塞启动；
    // 独立 try/catch fail-open：swallow 记账（不阻塞启动，闸逻辑仍在前置），手工清理重复行后下次
    // 启动建索引生效；新库天然生效。回滚：DROP INDEX IF EXISTS tasks_unique_active_slug;
    try {
      db.run("CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_slug ON tasks(slug) WHERE is_active = 1 AND slug != ''");
    } catch (e) { swallow(e, "state:slug-unique-index-fail"); }
    // O1 F5：curIno 记录（openAll 收尾）。退化模式：OS ino 复用致误匹配 → 不重开 → 退化为现状（不劣于不修）。
    try { curIno = fs.statSync(dbFile).ino; } catch { curIno = undefined; }
    qGet = db.prepare("SELECT state_json, rev FROM tasks WHERE session_id = ?");
    // M16-r39 T04：qUpsert 仅留一次性迁移用（save 路径改委托 writeTaskRow 单语句 CAS）
    qUpsert = db.prepare(
      `INSERT INTO tasks (session_id, slug, phase, project_id, directory, is_active, rev, updated_at, state_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         slug=excluded.slug, phase=excluded.phase, project_id=excluded.project_id,
         directory=excluded.directory, is_active=excluded.is_active, rev=excluded.rev,
         updated_at=excluded.updated_at, state_json=excluded.state_json`,
    );
    qEv = db.prepare("INSERT INTO events (session_id, at, entry_json) VALUES (?, ?, ?)");
    qRep = db.prepare(
      "INSERT INTO reports (session_id, text, at, brief, level) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET text=excluded.text, at=excluded.at, brief=excluded.brief, level=excluded.level",
    );
    qRepGet = db.prepare("SELECT session_id, text, at, brief, level FROM reports WHERE session_id = ?");
    qRepDel = db.prepare("DELETE FROM reports WHERE session_id = ?");
    qTaskDel = db.prepare("DELETE FROM tasks WHERE session_id = ?");
    qProj = db.prepare(
      "SELECT state_json FROM tasks WHERE project_id = ? AND session_id != ? ORDER BY updated_at DESC LIMIT 1",
    );
    qAll = db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC");
    qGc = db.prepare("DELETE FROM tasks WHERE phase = 'done' AND updated_at IS NOT NULL AND updated_at < ?");
    // F3（双库幽灵行取证）：slug='' 且 phase 空=历史缺陷/迁移产物，恒非活动且现 GC（只清 done）永不回收 → 显式清理。
    // 无误杀论证：intake 落库 slug 恒非空（slugify ‖ st.slug ‖ "untitled"）；拒绝路径无前行不落盘（T02）；
    //   持 phase 的行（如空 slug+phase=intake 的开发态）与空 slug+done（新鲜 done 存量锚）均不满足双空条件，不受影响。
    qGhost = db.prepare("DELETE FROM tasks WHERE slug = '' AND (phase IS NULL OR phase = '')");
    // W6-3：events 按 cmd 计数（diagnose 直查，绕 st.log 50 条截断的低估；json_extract 与 wrapper W2 同款）
    qEvCount = db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(entry_json,'$.cmd') = ?");
    qCount = db.prepare("SELECT COUNT(*) AS n FROM tasks");
    // migrate-meta-fix T01：迁移幂等标记——过滤迁移后 tasks 可能仍为空，原「tasks 空=未迁移」判定会
    // 每次启动重触发；且 done GC 14 天清空 tasks 后重迁移会向无唯一约束的 events 整批重复追加。
    // meta.migrated=1 显式收口（迁移完成即写，含零导入）。
    qMetaGet = db.prepare("SELECT value FROM meta WHERE key = ?");
    qMetaSet = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  };
  // r54 A1b：显式 WAL 收口（done 终态/reset 后调用；并发读 busy 时 PRAGMA 自身返回 busy=1 不抛错，
  // 失败仅 swallow 记账，绝不影响 save/removeState 返回值——数据安全增益，fail-open 语义）。
  const checkpointWal = (): void => {
    try { db.run("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) { swallow(e, "state:checkpoint-fail"); }
  };
  // W15-b：写口单槽 ensureOpen——openAll 保持同步体（单线程下 check-and-set 原子，把 await 边界
  // 压到迁移一处）；失败 CAS 回滚（允许下个事件重试，不留永久坏 promise；判等防旧 catch 迟到误清新槽）。
  const ensureOpen = (): Promise<void> => {
    if (closed) return Promise.resolve(); // F3 次序不变量：closed 最先，绝不建目录
    if (!openPromise) {
      const p = (async () => {
        if (!opened) { openAll(); opened = true; } // 同步首开：无 await，不可能半开
        if (!migrateDone && !migration) migration = runMigration(); // F4：迁移窗口先收口再放行
        if (migration) await migration;
      })();
      openPromise = p.catch((e) => {
        swallow(e, "state:lazy-open-fail");
        if (openPromise === p) openPromise = null; // CAS 清槽：防竞态误清新 promise
      });
    }
    return openPromise;
  };
  // O1 幻影存活检测 + W15-b 惰性打开合并单点（各公开方法头调用：读口 create=false / 写口 true）。
  // 次序铁律：closed 早退 → 未开则 open（读口要求库文件已存在，否则空态返回不物化目录）→ 幻影检测。
  // 未开态不参与 inode 判定（首开天然取新 inode——O1 简化红利）；close 后迟到调用维持
  // throw→swallow→write-error 路径，不复活已删目录（O1③ 语义不变）。
  const ensureAlive = async (create: boolean): Promise<void> => {
    try {
      if (closed) return;
      if (!opened) {
        if (!create) {
          try { if (!fs.existsSync(dbFile)) return; } catch { return; } // 读口无建：库不存在=空态
        }
        await ensureOpen();
      }
      let st: fs.Stats | null = null;
      try { st = fs.statSync(dbFile); } catch { st = null; }
      if (st && curIno !== undefined && st.ino === curIno) return; // 正常：同 inode，无需重开
      if (!st && curIno === undefined) return;                     // 防御：两者皆不可证 → 维持现状
      try { db.close(); } catch (e) { swallow(e, "state:phantom-close-fail"); }
      openAll();
      opened = true;
      swallow(new Error("phantom reopened"), "state:phantom-db-reopen"); // 观测形状先例 state:migrate-skip-no-dir
    } catch (e) { swallow(e, "state:phantom-ensure-fail"); }
  };

  const load = async (sessionID: string): Promise<WfState | null> => {
    await ensureAlive(false);
    try { return parse(qGet.get(String(sessionID ?? ""))) ?? null; } catch { return null; }
  };

  // save：乐观锁写入。行已存在且快照携带的 rev 与当前行不一致 → 拒写（旧 last-write-wins 会静默
  // 丢更新，现在保新弃旧；console.warn 进 server 日志可回看）。无 rev 的新建快照 → 显式覆盖。
  // M16-r39 T04：pre-check 快速路径保留，实际写入委托 writeTaskRow 单语句 CAS（消除读-写窗口）。
  const save = async (st: WfState): Promise<SaveResult> => {
    await ensureAlive(true);
    if (!st || st.sessionID == null) return { ok: false, reason: "no-session" };
    st.updatedAt = new Date().toISOString();
    const sid = String(st.sessionID);
    let prev: any = null;
    try { prev = qGet.get(sid); } catch (e) { swallow(e, "state:save-prev-read-fail"); }
    if (prev && typeof st.rev === "number" && st.rev !== prev.rev) {
      try { console.warn(`[wf] stale-rev save rejected: session=${sid} incoming=${st.rev} current=${prev.rev}`); } catch (e) { swallow(e, "state:console-warn-fail"); }
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
        try { console.warn(`[wf] save rejected (${w.reason}): session=${sid} incoming=${st.rev} current=${prev?.rev ?? "(无行)"}`); } catch (e) { swallow(e, "state:console-warn-fail"); }
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
      try { console.warn(`[wf] save failed: ${String((e as Error)?.message ?? e)}`); } catch (err) { swallow(err, "state:console-warn-fail"); }
      return { ok: false, reason: "write-error" };
    }
    // r54 A1b：done 终态落库成功即收拢 WAL（该任务后续大概率无高频写，及时把审计副本收进主文件）
    if (st.phase === "done") checkpointWal();
    return { ok: true, rev };
  };

  // reset：清除任务行与报告槽（events 流水为审计保留，不删）；r54 A1b：收拢 WAL（events 是 reset 后唯一剩余数据）
  const removeState = async (sessionID: string): Promise<void> => {
    await ensureAlive(true);
    try { qTaskDel.run(String(sessionID ?? "")); } catch (e) { swallow(e, "state:task-del-fail"); }
    try { qRepDel.run(String(sessionID ?? "")); } catch (e) { swallow(e, "state:report-del-fail"); }
    checkpointWal();
  };

  // M10-b：wf/* 子会话经项目反查管辖状态（原项目索引键 IDX 的 SQL 等价：同 project 最近落盘）
  // W6-0（test_49 复盘）：三级回退 own → projectID → parentID——projectID 身份漂移实证（intake 期
  //   git init 致 opencode 项目身份切换：任务行锁旧目录身份、子会话继承新 git 仓库身份 → qProj 全
  //   miss → roleSessions 登记表全程空 + 子会话阶段闸门失明）。守卫次序（核查 P1）：parentID 回退
  //   仅在 wf/* 非 leader 分支内、守卫之后——普通 agent 子会话（M16-r38 不受管辖）绝不误绑。
  //   单跳即止：嵌套子代理 parentID 指向另一 wf/* 子会话 → load miss → null（孙代不可达，无死循环）。
  //   备忘录（核查 P2）：childSid→parentSid 有界 Map，命中即短路，消除长任务 sessions.get 放大
  //   （超限整表清空=退化重算，正确性不依赖缓存）。
  const parentMemo = new Map<string, string>();
  const PARENT_MEMO_CAP = 512;
  const resolveState = async (sessionID: string, agent?: string): Promise<WfState | null> => {
    // W15-b 评审曾提「agent 身份门前置」——实现期被既有测试契约证伪（resolveState own 优先锚锁死
    // 普通 agent 命中自有行也须返回，:382 门只在项目反查分支），且读口 ensureAlive(false) 对未开库
    // 本就零 IO（existsSync 短路），前置门无增量收益——不采纳，保持原语义。
    await ensureAlive(false);
    const own = await load(sessionID);
    if (own) return own;
    const a = String(agent ?? "");
    // 仅 wf/* agent 与 leader（workflow，兼容 wf/leader）受项目管辖；普通会话不受影响（M16-r38）
    if (!a.startsWith("wf/") && !isLeader(a)) return null;
    const sidS = String(sessionID ?? "");
    const memoSid = parentMemo.get(sidS);
    if (memoSid) return load(memoSid);
    try {
      const s = await host.sessions.get({ sessionID });
      const pid = s?.projectID;
      if (pid) {
        const hit = parse(qProj.get(String(pid), sidS));
        if (hit) return hit;
      }
      // W6-0：projectID 反查 miss（身份漂移/无 projectID）→ parentID 单跳反查 leader 任务行
      const parentId = s?.parentID ?? null;
      if (!parentId || String(parentId) === sidS) return null;
      const parent = await load(String(parentId));
      if (!parent) return null;
      if (parentMemo.size >= PARENT_MEMO_CAP) parentMemo.clear();
      parentMemo.set(sidS, String(parentId));
      return parent;
    } catch { return null; }
  };

  // 落盘目录三级回退同源提取：优先管辖状态的 directory，回退本会话 session.get，再回退 cwd
  const resolveProjectDir = async (st: WfState | null, sessionID: string): Promise<string> => {
    let d = st?.directory ?? null;
    if (!d) {
      const sess = await host.sessions.get({ sessionID }).catch(() => null);
      d = sess?.location?.directory ?? null;
    }
    return d ?? process.cwd();
  };

  // M8-b 状态枚举 + A7 done GC + A6/M14 项目过滤（输出形状与 storage 版逐字段一致，rpc-bridge 直接消费）
  // r54 A3：GC 节流——TUI 对空闲项目每 5s 调 list→scanStates，旧实现每次白跑 2 条 DELETE 写事务
  //（写放大 + WAL 空帧 + 锁竞争窗口）；60s 窗口内跳过，判定纯函数 shouldRunGc 可直测。
  let lastGcAt = 0;
  const scanStates = async (projectID?: string | null, directory?: string | null): Promise<StateListItem[]> => {
    await ensureAlive(false);
    const out: StateListItem[] = [];
    try {
      const now = Date.now();
      if (shouldRunGc(now, lastGcAt)) {
        lastGcAt = now;
        try { qGc.run(new Date(now - STALE_MS).toISOString()); } catch (e) { swallow(e, "state:gc-fail"); }
        try { qGhost.run(); } catch (e) { swallow(e, "state:ghost-clean-fail"); }
      }
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
          testPlanWritten: !!v.verdicts?.testPlanWritten,
          testReportVerdict: v.verdicts?.testReport ?? null,
          updatedAt: v.updatedAt ?? null,
        });
      }
    } catch (e) { swallow(e, "state:scan-states-fail"); }
    out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return out.slice(0, 20);
  };

  // ── reports 命令输出槽（r29e 主通道的 SQLite 化；形状必须保持含 sessionID
  //    ——bug A 教训：缺 sessionID 字段 TUI toastReport 过滤器会把 toast 全拦掉。
  //    T01 扩 brief/level：可选入参，缺省落 null（旧调用方零改动）──
  const putReport = async (r: { sessionID: string; text: string; at: string; brief?: string; level?: ReportLevel }): Promise<void> => {
    await ensureAlive(true);
    qRep.run(String(r.sessionID ?? ""), String(r.text ?? ""), r.at ? String(r.at) : null,
      r.brief != null ? String(r.brief) : null, r.level != null ? String(r.level) : null);
  };
  const getReport = async (sessionID: string): Promise<ReportRow | null> => {
    await ensureAlive(false);
    if (!opened) return null; // W15-b：读口未开态显式空返（qRepGet 未备语句，裸引用=TypeError——lazy-state 锚捕获）
    const row = qRepGet.get(String(sessionID ?? ""));
    if (!row) return null;
    return { sessionID: row.session_id, text: row.text, at: row.at ?? null, brief: row.brief ?? null, level: row.level ?? null };
  };

  // wf:debug 转储用：近似旧 storage scan 的 [{key, value}] 形状
  const dumpStates = async (): Promise<{ key: string; value: unknown }[]> => {
    await ensureAlive(false);
    try {
      return qAll.all().map((row: any) => ({
        key: `${STATE_PREFIX}${row.session_id}`,
        value: parse(row) ?? row.state_json,
      }));
    } catch { return []; }
  };

  // 一次性迁移：meta.migrated 未置位且 tasks 为空时，从旧 ctx.storage 行导入（旧键保留不删作备份）。
  // migrate-meta-fix T02：项目维度过滤（test_45 双重复现：全局 storage.scan 无项目维度，新项目库被
  // 灌入外项目行）——directory 是唯一权威维度（csvkit 行 projectID="global" 但 directory 正确，
  // projectID 不可信，勿做 fallback）；无 directory 行跳过+记账（scanStates A6 下本就项目不可见，
  // 与现有读语义一致）。双侧 path.resolve 纯串归一（与 A6 先例同款，勿引 realpathSync）。
  // 失败按空库处理（新开始，不阻塞启动）。
  // W15-b：迁移体惰性单飞（原构造期 eager IIFE）。前置条件：openAll 已执行（备语句可用）。
  // 体内逻辑逐字平移；migrateDone 闩=本 store 生命周期一次（幻影重开不重跑=既有语义：ready 只结算一次）。
  const runMigration = async (): Promise<void> => {
    try {
      // 幂等收口：迁移完成即置 meta.migrated=1（含零导入），此后永不再触发——
      // 防过滤后空库反复扫描 + 防 done GC 清空 tasks 后 events 整批重复追加（events 无唯一约束）。
      if (String(qMetaGet.get("migrated")?.value ?? "") === "1") return;
      const storeDir = resolve(dir);
      const n = Number(qCount.get()?.n ?? 0);
      if (n > 0) { qMetaSet.run("migrated", "1"); return; } // 既有新形库：直接收口，不再迁移
      const res = await host.storage.scan({ prefix: STATE_PREFIX });
      if (res === undefined) { qMetaSet.run("migrated", "1"); return; } // T03：缺失信号=旧 !ctx?.storage?.scan 分支
      const entries = Array.isArray(res) ? res : (res?.entries ?? []);
      const importedSids = new Set<string>();
      for (const e of entries) {
        const k = e?.key ?? e?.[0];
        let v = e?.value ?? e?.[1];
        const ks = Array.isArray(k) ? k.join("/") : String(k);
        if (!ks.startsWith(STATE_PREFIX)) continue;
        if (typeof v === "string") { try { v = JSON.parse(v); } catch { continue; } }
        if (!v || typeof v !== "object") continue;
        // 项目归属判定：directory 缺失=归属不可证 → 跳过并记账（fail-open 可观测）
        const vDir = v.directory != null ? String(v.directory).trim() : "";
        if (!vDir) { swallow(new Error(`skip-no-dir: ${ks}`), "state:migrate-skip-no-dir"); continue; }
        if (resolve(vDir) !== storeDir) continue; // 外项目行：跳过（旧键保留 storage 作备份）
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
        importedSids.add(sid);
        for (const le of (Array.isArray(v.log) ? v.log : [])) qEv.run(sid, String(le?.at ?? v.updatedAt ?? ""), JSON.stringify(le ?? {}));
      }
      const rr = await host.storage.scan({ prefix: REPORT_PREFIX });
      const re = Array.isArray(rr) ? rr : (rr?.entries ?? []);
      for (const e of re) {
        const k = e?.key ?? e?.[0];
        let v = e?.value ?? e?.[1];
        const ks = Array.isArray(k) ? k.join("/") : String(k);
        if (!ks.startsWith(REPORT_PREFIX)) continue;
        if (typeof v === "string") { try { v = JSON.parse(v); } catch { continue; } }
        if (v && typeof v === "object" && v.text != null) {
          const sid = String(v.sessionID ?? ks.slice(REPORT_PREFIX.length));
          if (!importedSids.has(sid)) continue; // 报告仅随已导入任务行（同源过滤）
          qRep.run(sid, String(v.text), v.at ? String(v.at) : null, null, null);
        }
      }
      qMetaSet.run("migrated", "1");
    } catch (e) { swallow(e, "state:storage-migrate-fail"); }
    migrateDone = true; // 成功/失败均收口：失败按空库处理（新开始），不重试阻塞后续事件
  };

  return {
    load, save, removeState, resolveState, resolveProjectDir, scanStates,
    putReport, getReport, dumpStates,
    // W15-b：ready 契约键保留（helpers-contract 逐键断言 + store-stub 同步面），语义改=「显式
    // open+迁移触发」——生产装配期消费者已删（index.ts），唯一遗留消费面是测试 helper（newStore
    // 的 await s.ready 正好充当触发点）；任何生产代码新增 await store.ready 即等于显式建库，慎用。
    get ready() { return ensureOpen(); },
    countEvents: async (cmd: string) => { await ensureAlive(false); try { return Number(qEvCount.get(String(cmd))?.n ?? 0); } catch { return 0; } },
    // W15-b：closed 置位保持最前（拦截迟到调用）；未开态 close no-op——杜绝 db.close() 抛 TypeError
    // 污染 swallow 环（诊断面假故障）。
    close: () => { closed = true; if (opened) { try { db.close(); } catch (e) { swallow(e, "state:store-close-fail"); } } },
  };
}