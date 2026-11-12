// P1 状态层（SQLite）行为锚：乐观锁 rev 防陈旧覆盖、reports 形状（bug A 教训）、done GC、
// 项目过滤（A6/M14 语义）、wf/* 项目反查、一次性 storage 迁移、events 增量流水、gitignore 防护。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { createStore } from "../server/state.ts";

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

test("reports：roundtrip 形状 {sessionID,text,at}（bug A 锚）+ removeState 清行", async () => {
  const s = await newStore(tmpDir());
  await s.putReport({ sessionID: "ses_r", text: "hello", at: "2026-11-10T00:00:00.000Z" });
  assert.deepEqual(await s.getReport("ses_r"), { sessionID: "ses_r", text: "hello", at: "2026-11-10T00:00:00.000Z" });
  assert.equal(await s.getReport("ses_none"), null);
  await s.save({ sessionID: "ses_r", slug: "", phase: "testing", rounds: {}, log: [] });
  await s.removeState("ses_r");
  assert.equal(await s.getReport("ses_r"), null, "reset 清报告槽（防新挂载重放旧 toast）");
  assert.equal(await s.load("ses_r"), null);
  s.close();
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
