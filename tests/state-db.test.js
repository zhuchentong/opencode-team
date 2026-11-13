// P1 状态层（SQLite）行为锚：乐观锁 rev 防陈旧覆盖、reports 形状（bug A 教训）、done GC、
// 项目过滤（A6/M14 语义）、wf/* 项目反查、一次性 storage 迁移、events 增量流水、gitignore 防护。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { createStore, logAdd, writeTaskRow } from "../server/state.ts";

const tmpDir = () => fs.mkdtempSync("/tmp/opencode/wf-state-");
const dbFile = (dir) => `${dir}/.workflow/wf.db`;
const mkCtx = (dir, extra = {}) => ({
  location: { directory: dir },
  storage: { scan: async () => ({ entries: [] }), get: async () => null, set: async () => {}, remove: async () => {} },
  session: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: dir } }) },
  ...extra,
});
const newStore = async (dir, extra) => {
  const s = createStore(mkCtx(dir, extra));
  await s.ready;
  return s;
};

test("save/load roundtrip：整份快照 + rev 附着 + 无行返回 null", async () => {
  const s = await newStore(tmpDir());
  const r1 = await s.save({ sessionID: "ses_a", slug: "demo", phase: "intake", rounds: { plan_review: 0 }, log: [] });
  assert.equal(r1.ok, true);
  assert.equal(r1.rev, 1);
  const loaded = await s.load("ses_a");
  assert.equal(loaded.slug, "demo");
  assert.equal(loaded.phase, "intake");
  assert.equal(loaded.rev, 1); // load 快照携带 rev（乐观锁的前提）
  assert.equal(await s.load("ses_none"), null);
  s.close();
});

test("乐观锁：stale rev 拒写（防陈旧快照覆盖新进度）", async () => {
  const s = await newStore(tmpDir());
  await s.save({ sessionID: "ses_a", slug: "x", phase: "intake", rounds: {}, log: [] });
  const a = await s.load("ses_a"); // rev1
  const b = await s.load("ses_a"); // rev1（同一份的陈旧副本）
  a.phase = "planning";
  assert.equal((await s.save(a)).ok, true); // rev2
  b.phase = "review";
  const rb = await s.save(b);
  assert.equal(rb.ok, false);
  assert.equal(rb.reason, "stale-rev");
  assert.equal((await s.load("ses_a")).phase, "planning", "陈旧写不得覆盖");
  s.close();
});

test("无 rev 的新建快照：显式覆盖放行（intake 重建语义）", async () => {
  const s = await newStore(tmpDir());
  await s.save({ sessionID: "ses_a", slug: "old", phase: "review", rounds: {}, log: [] });
  const rf = await s.save({ sessionID: "ses_a", slug: "new", phase: "intake", rounds: {}, log: [] });
  assert.equal(rf.ok, true);
  assert.equal((await s.load("ses_a")).slug, "new");
  s.close();
});

test("reports：roundtrip 形状 {sessionID,text,at,brief,level}（bug A 锚 + T01 新列缺省 null）+ removeState 清行", async () => {
  const s = await newStore(tmpDir());
  await s.putReport({ sessionID: "ses_r", text: "hello", at: "2026-11-10T00:00:00.000Z" });
  assert.deepEqual(await s.getReport("ses_r"), { sessionID: "ses_r", text: "hello", at: "2026-11-10T00:00:00.000Z", brief: null, level: null });
  assert.equal(await s.getReport("ses_none"), null);
  await s.save({ sessionID: "ses_r", slug: "", phase: "testing", rounds: {}, log: [] });
  await s.removeState("ses_r");
  assert.equal(await s.getReport("ses_r"), null, "reset 清报告槽（防新挂载重放旧 toast）");
  assert.equal(await s.load("ses_r"), null);
  s.close();
});

// ── notification-brief-display T01：reports 表加列（brief/level）─────────────
test("T01 putReport 携 brief/level → getReport 逐字段读回（含二次覆写更新）", async () => {
  const s = await newStore(tmpDir());
  await s.putReport({ sessionID: "ses_b", text: "全文", at: "2026-11-13T00:00:00.000Z", brief: "x", level: "warn" });
  assert.deepEqual(await s.getReport("ses_b"), { sessionID: "ses_b", text: "全文", at: "2026-11-13T00:00:00.000Z", brief: "x", level: "warn" });
  // 覆盖写：不带新字段 → 归 null（旧调用方语义，不做保留合并）
  await s.putReport({ sessionID: "ses_b", text: "全文2", at: "t2" });
  assert.deepEqual(await s.getReport("ses_b"), { sessionID: "ses_b", text: "全文2", at: "t2", brief: null, level: null });
  s.close();
});

test("T01 旧库升级：手工建旧形状表（无新列）→ createStore 迁移加列、旧行读回 null、二次打开幂等", async () => {
  const dir = tmpDir();
  fs.mkdirSync(`${dir}/.workflow`, { recursive: true });
  // 模拟旧版本 wf.db：reports 只有 (session_id, text, at) 三列 + 存量行
  const d0 = new Database(dbFile(dir));
  d0.run("CREATE TABLE reports (session_id TEXT PRIMARY KEY, text TEXT NOT NULL, at TEXT)");
  d0.run("INSERT INTO reports (session_id, text, at) VALUES ('ses_old', '旧报告', '2026-11-01T00:00:00.000Z')");
  d0.close();
  const s1 = await newStore(dir);
  assert.deepEqual(await s1.getReport("ses_old"), {
    sessionID: "ses_old", text: "旧报告", at: "2026-11-01T00:00:00.000Z", brief: null, level: null,
  }, "旧行 brief/level 读回 null");
  await s1.putReport({ sessionID: "ses_new", text: "新报告", at: "t", brief: "b", level: "info" });
  s1.close();
  // 二次打开：ALTER 已跑过 → 幂等不报错，数据保留
  const s2 = await newStore(dir);
  assert.deepEqual(await s2.getReport("ses_new"), { sessionID: "ses_new", text: "新报告", at: "t", brief: "b", level: "info" });
  assert.equal((await s2.getReport("ses_old"))?.brief, null);
  s2.close();
});

test("scanStates：done 且 >14 天 GC；新鲜 done 保留", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_g1", slug: "", phase: "done", rounds: {}, log: [] });
  await s.save({ sessionID: "ses_g2", slug: "", phase: "done", rounds: {}, log: [] });
  const d = new Database(dbFile(dir));
  d.run("UPDATE tasks SET updated_at = '2020-01-01T00:00:00.000Z' WHERE session_id = 'ses_g1'");
  d.close();
  const list = await s.scanStates(null, null);
  assert.equal(list.find((x) => x.sessionID === "ses_g1"), undefined, "陈旧 done 被 GC");
  assert.ok(list.find((x) => x.sessionID === "ses_g2"), "新鲜 done 保留");
  s.close();
});

// ── F3（selfmod-concurrency-guard 第二批）：幽灵行显式 GC ──
// 12 库取证：slug='' 且 phase 空=迁移产物（11-10 同秒出现于全部库），现 GC 只清 done → 永不回收。
// 无误杀边界：空 slug+phase 非空（intake 开发态）与空 slug+done（新鲜 done 锚）都不删。
test("F3 幽灵行 GC：slug='' 且 phase NULL/'' 在 scanStates 即删；带 phase 与 done 空 slug 行保留", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_keep", slug: "", phase: "intake", rounds: {}, log: [] });
  {
    const d = new Database(dbFile(dir));
    d.run("INSERT INTO tasks (session_id, slug, phase, is_active, rev, updated_at, state_json) VALUES ('ses_gh1', '', NULL, NULL, 1, '2026-11-10T06:57:22.000Z', ?)",
      JSON.stringify({ sessionID: "ses_gh1", slug: "", phase: null, rounds: {} }));
    d.run("INSERT INTO tasks (session_id, slug, phase, is_active, rev, updated_at, state_json) VALUES ('ses_gh2', '', '', NULL, 1, '2026-11-10T06:57:22.000Z', ?)",
      JSON.stringify({ sessionID: "ses_gh2", slug: "", phase: "", rounds: {} }));
    d.close();
  }
  const list = await s.scanStates(null, null);
  assert.ok(list.find((x) => x.sessionID === "ses_keep"), "空 slug+带 phase 的开发态行不得误杀");
  const d2 = new Database(dbFile(dir), { readonly: true });
  assert.equal(d2.query("SELECT COUNT(*) AS n FROM tasks WHERE session_id IN ('ses_gh1','ses_gh2')").get().n, 0, "双空幽灵行（NULL 与 '' 两种 phase）均被回收");
  d2.close();
  s.close();
});

test("scanStates 项目过滤（A6 + M14 directory 回退语义）", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_p1", slug: "a", phase: "intake", rounds: {}, projectID: "pi1", directory: dir, log: [] });
  await s.save({ sessionID: "ses_p2", slug: "b", phase: "intake", rounds: {}, directory: dir, log: [] });
  assert.equal((await s.scanStates(null, null)).length, 2, "全局枚举");
  assert.equal((await s.scanStates("pi1", dir)).length, 2, "无 projectID 的旧状态按 directory 回退命中");
  assert.equal((await s.scanStates("pi2", dir)).length, 1, "pi1 行不匹配被滤；directory 回退行保留（M14）");
  assert.equal((await s.scanStates("pi2", "/other/dir")).length, 0);
  s.close();
});

test("resolveState：own 优先；wf/* agent 经项目反查；普通 agent 不受管辖", async () => {
  const s = await newStore(tmpDir());
  await s.save({ sessionID: "ses_own", slug: "m", phase: "planning", rounds: {}, projectID: "pi1", log: [] });
  assert.equal((await s.resolveState("ses_own", "build")).slug, "m", "own 状态优先");
  assert.equal(await s.resolveState("ses_child", "general-agent"), null, "非 wf/* 不反查");
  const owner = await s.resolveState("ses_child", "wf/planner");
  assert.equal(owner?.sessionID, "ses_own", "wf/* 子会话经 project_id 反查管辖状态");
  s.close();
});

test("一次性迁移：旧 storage 状态行/报告行导入，updatedAt 保留，events 一并导入", async () => {
  const dir = tmpDir();
  const legacy = { sessionID: "ses_old", slug: "legacy", phase: "review", rounds: { plan_review: 1 }, updatedAt: "2026-11-01T00:00:00.000Z", log: [{ cmd: "wf:review", at: "2026-11-01T00:00:00.000Z" }] };
  const s = await newStore(dir, {
    storage: {
      scan: async (o) => {
        if (o?.prefix === "wf-workflow/state/") return { entries: [{ key: "wf-workflow/state/ses_old", value: legacy }] };
        if (o?.prefix === "wf-workflow/report/") return { entries: [{ key: "wf-workflow/report/ses_old", value: { sessionID: "ses_old", text: "旧报告", at: "2026-11-01T00:00:00.000Z" } }] };
        return { entries: [] };
      },
    },
  });
  const st = await s.load("ses_old");
  assert.equal(st.slug, "legacy");
  assert.equal(st.rev, 1);
  assert.equal(st.updatedAt, "2026-11-01T00:00:00.000Z", "迁移不得重置 GC 时钟");
  assert.equal((await s.getReport("ses_old"))?.text, "旧报告");
  const d = new Database(dbFile(dir), { readonly: true });
  assert.equal(d.query("SELECT COUNT(*) AS n FROM events").get().n, 1, "迁移导入流转流水");
  d.close();
  s.close();
});

test("events 增量流水：两次 save 只追加新增 log 尾项", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_e", slug: "", phase: "intake", rounds: {}, log: [{ cmd: "wf:intake", at: "t1" }] });
  const st = await s.load("ses_e");
  st.phase = "planning";
  st.log.push({ cmd: "wf:plan", at: "t2" });
  await s.save(st);
  const d = new Database(dbFile(dir), { readonly: true });
  const rows = d.query("SELECT entry_json FROM events WHERE session_id = 'ses_e' ORDER BY id").all();
  d.close();
  assert.equal(rows.length, 2);
  assert.equal(JSON.parse(rows[0].entry_json).cmd, "wf:intake");
  assert.equal(JSON.parse(rows[1].entry_json).cmd, "wf:plan");
  s.close();
});

test(".workflow/.gitignore 防护：状态库与 WAL/SHM 不入 git", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  const gi = fs.readFileSync(`${dir}/.workflow/.gitignore`, "utf8");
  assert.match(gi, /wf\.db/);
  assert.match(gi, /wf\.db-\*/);
  s.close();
});

// ── T01（M16-r39 A1）：logSeq 修审计停追 ─────────────────────────────
// 旧缺陷：save 按 oldLog.length 比对增量，log 截断 50 后 length 恒 50 → events 永远停追。
// 修复：logAdd 维护单调 logSeq，save 按序号差追加；存量无 logSeq 回退 length。
test("T01 logSeq：60 次 logAdd+save → events=60、log 截断 50、logSeq=60（审计不停追）", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_seq", slug: "seq", phase: "intake", rounds: {}, log: [] });
  for (let i = 1; i <= 60; i++) {
    const st = await s.load("ses_seq");
    logAdd(st, { cmd: "wf:x", at: `t${i}`, ok: true });
    assert.equal((await s.save(st)).ok, true);
  }
  const d = new Database(dbFile(dir), { readonly: true });
  const n = d.query("SELECT COUNT(*) AS n FROM events WHERE session_id = 'ses_seq'").get().n;
  d.close();
  const fin = await s.load("ses_seq");
  assert.equal(n, 60, "events 不得因 50 条截断停追");
  assert.equal(fin.log.length, 50, "快照 log 仍截断 50");
  assert.equal(fin.logSeq, 60, "logSeq 单调累计");
  s.close();
});

test("T01 logSeq：存量行无 logSeq（SQL 删字段）→ logAdd+save 恰追加 1 条（length 回退）", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_leg", slug: "leg", phase: "planning", rounds: {}, log: [{ cmd: "wf:intake", at: "t0" }, { cmd: "wf:plan", at: "t1" }] });
  // 模拟存量快照：SQL 删除 logSeq 字段（旧版本落盘的行无此字段）
  const d = new Database(dbFile(dir));
  const row = d.query("SELECT state_json FROM tasks WHERE session_id = 'ses_leg'").get();
  const v = JSON.parse(row.state_json);
  delete v.logSeq;
  d.run("UPDATE tasks SET state_json = ? WHERE session_id = 'ses_leg'", JSON.stringify(v));
  const before = d.query("SELECT COUNT(*) AS n FROM events WHERE session_id = 'ses_leg'").get().n;
  d.close();
  const st = await s.load("ses_leg");
  logAdd(st, { cmd: "wf:review", at: "t2", ok: true });
  assert.equal((await s.save(st)).ok, true);
  const d2 = new Database(dbFile(dir), { readonly: true });
  const after = d2.query("SELECT COUNT(*) AS n FROM events WHERE session_id = 'ses_leg'").get().n;
  const last = d2.query("SELECT entry_json FROM events WHERE session_id = 'ses_leg' ORDER BY id DESC LIMIT 1").get();
  d2.close();
  assert.equal(after - before, 1, "存量无 logSeq 恰追加 1 条（length 回退，不重放全量）");
  assert.equal(JSON.parse(last.entry_json).cmd, "wf:review");
  s.close();
});

// ── T04（M16-r39 A4）：writeTaskRow 单语句 CAS 原子写 ─────────────────// 旧 save 读-比-写三步非原子（同进程 TOCTOU 窗口）；新原语 INSERT/UPDATE…WHERE rev
// 单语句定胜负。跨进程原子性由本原语单测证明，save 保留 pre-check 快速路径。
const mkCasRow = (phase) => ({
  sessionID: "ses_cas", slug: "cas", phase, projectID: null, directory: null,
  isActive: 1, updatedAt: "2026-11-12T00:00:00.000Z",
  stateJson: JSON.stringify({ sessionID: "ses_cas", slug: "cas", phase, rounds: {} }),
});
test("T04 writeTaskRow：null→INSERT rev1；同 expectedRev 二次调用→stale-rev；UNIQUE 冲突→stale-rev", async () => {
  const dir = tmpDir();
  const s = await newStore(dir); // 建库/schema
  const d = new Database(dbFile(dir));
  // null → INSERT rev=1
  assert.deepEqual(writeTaskRow(d, mkCasRow("intake"), null), { ok: true, rev: 1 });
  // expectedRev=1 → UPDATE 成功 rev=2
  assert.deepEqual(writeTaskRow(d, mkCasRow("planning"), 1), { ok: true, rev: 2 });
  // 同一 expectedRev=1 二次调用 → stale-rev（CAS 定胜负，陈旧写不得覆盖）
  assert.deepEqual(writeTaskRow(d, mkCasRow("review"), 1), { ok: false, reason: "stale-rev" });
  const cur = d.query("SELECT phase, rev FROM tasks WHERE session_id = 'ses_cas'").get();
  assert.equal(cur.phase, "planning", "stale 写不得覆盖 DB 现势");
  assert.equal(cur.rev, 2);
  // null → INSERT 遇 UNIQUE 冲突 → stale-rev（可重试语义）
  assert.deepEqual(writeTaskRow(d, mkCasRow("intake"), null), { ok: false, reason: "stale-rev" });
  d.close();
  s.close();
});

test("T04 save pre-check 回归锚：load 后外部 UPDATE rev → save 拒 stale-rev 且 DB 不变", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_pc", slug: "pc", phase: "intake", rounds: {}, log: [] });
  const st = await s.load("ses_pc");
  const d = new Database(dbFile(dir));
  d.run("UPDATE tasks SET rev = rev + 5 WHERE session_id = 'ses_pc'");
  const before = d.query("SELECT state_json, rev FROM tasks WHERE session_id = 'ses_pc'").get();
  d.close();
  st.phase = "planning";
  const r = await s.save(st);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale-rev");
  const d2 = new Database(dbFile(dir), { readonly: true });
  const after = d2.query("SELECT state_json, rev FROM tasks WHERE session_id = 'ses_pc'").get();
  d2.close();
  assert.equal(after.state_json, before.state_json, "拒写后 DB 快照不变");
  assert.equal(after.rev, before.rev, "拒写后 rev 不变");
  s.close();
});

// ── verify 补充边界（M16-r39 testing）：writeTaskRow 异常分支 ──
// plan 原例覆盖 INSERT/UPDATE/stale/UNIQUE；此处补：行不存在时 UPDATE（changes=0）
// 必须归一 stale-rev（可重试）而非 write-error；db 关闭后写 → write-error（不抛）。
test("T04 边界：行不存在 UPDATE→stale-rev；db 已关闭→write-error 不抛", async () => {
  const dir = tmpDir();
  const s = await newStore(dir); // 建库/schema（空 tasks）
  const d = new Database(dbFile(dir));
  assert.deepEqual(writeTaskRow(d, mkCasRow("intake"), 5), { ok: false, reason: "stale-rev" },
    "空表 UPDATE changes=0 → stale-rev（可重试语义，不得误报 write-error）");
  assert.equal(d.query("SELECT COUNT(*) AS n FROM tasks").get().n, 0, "拒写不得建行");
  d.close();
  const d2 = new Database(dbFile(dir));
  d2.close(); // 关闭后 prepare/run 抛 → 须捕获归一 write-error
  const r = writeTaskRow(d2, mkCasRow("intake"), null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "write-error");
  s.close();
});
