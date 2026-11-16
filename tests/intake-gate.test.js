// intake-discuss-gate T04：intake 讨论确认关卡注册 + 拒绝文案（wf:plan 入口；full/daily 同对象复用）。
// 谓词（冻结）：phase!=="intake" || tierOf(size)==="S" || intakeConfirmOff===true || verdicts.intakeConfirmedAt。
// 作废语义复用既有：force re-intake 整组重置 verdicts={}（L267 不动）；wf:plan 只 delete confirmedAt（L291 不动）
// ——intakeConfirmedAt 经 wf:plan 重入保留。诚实边界：关卡只保「出过卡」，文案不得断言用户已批准/未批准。
// mock 底座=tests/_preload.js 自举 + helpers/host-stub（禁散装自举副本；仿 plan-confirm mkCtx/ask/stOf）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js";
import { GATES, GATES_DAILY, evaluateTransition, flowFor } from "../server/lib.ts";
import { withVerdicts } from "./helpers/state-fixture.js";

const DIR = "/tmp/opencode/wf-intake-gate";
const DB = `${DIR}/.workflow/wf.db`;
const mkCtx = (options = {}) => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const entries = [];
  let hookFn = null;
  const host = mkHostStub({
    options: { probe: false, ...options },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) },
    instructions: { put: async (i) => { entries.push(i); }, list: async () => entries },
    tools: { hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
  });
  return { ctx: host.rawCtx, cmds: host.cmdDefs, entries, hook: () => hookFn };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
// leader question 调用模拟（默认=intake 讨论确认卡三选项，锚「需求无误」）
const ask = (m, sid, agent = "workflow", labels = ["需求无误，开始规划", "补充修正", "终止任务"]) =>
  m.hook()({ tool: "question", sessionID: sid, agent,
    input: { questions: [{ question: "需求确认", header: "需求确认", options: labels.map((label) => ({ label })) }] } }, {});
const blank = (over = {}) => withVerdicts({ slug: "t", phase: null, rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, artifacts: {}, lanes: {}, ...over });
const advance = (st, cmdName, text) => {
  const r = evaluateTransition(cmdName, st, text);
  if (r.ok) st.phase = flowFor(st, cmdName).to;
  return r;
};
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// ── 纯函数：关卡矩阵（full GATES["wf:plan"]）─────────────────────────
test("T04 关卡：M/L intake 无记账 wf:plan 拒（gate=intake-confirm、❌ 文案指路出卡）", () => {
  for (const size of ["M", "L"]) {
    const st = blank({ phase: "intake", size });
    const before = { ...st.rounds };
    const r = advance(st, "wf:plan", "");
    assert.equal(r.ok, false, `${size} 无记账应拒`);
    assert.equal(r.note, "gate-rejected");
    assert.equal(r.gate, "intake-confirm", "拒绝附 gate.id");
    assert.ok(String(r.msg).startsWith("❌"), "REJECT_PREFIX 不变量");
    assert.match(r.msg, /需求确认关卡未过/);
    assert.match(r.msg, /尚未观测到需求确认交互/);
    assert.match(r.msg, /需求无误/, "指路含固定选项锚");
    assert.match(r.msg, /baseline\.md/, "指路先落需求基线");
    assert.match(r.msg, /question/, "指路宿主 question 出卡");
    assert.match(r.msg, /补充修正/);
    assert.match(r.msg, /终止任务/);
    assert.doesNotMatch(r.msg, /用户已批准|用户未批准/, "诚实边界：不得断言用户批准与否");
    assert.equal(st.verdicts.gateStatus.id, "intake-confirm", "gateStatus 快照 id");
    assert.equal(st.verdicts.gateStatus.ok, false);
    assert.equal(typeof st.verdicts.gateStatus.at, "string");
    assert.deepEqual(st.rounds, before, "拒绝不消耗额度");
    assert.equal(st.phase, "intake", "拒绝阶段不变");
  }
});

test("T04 关卡：有记账放行（gateStatus ok 快照）；S 豁免；intakeConfirmOff===true 放行", () => {
  const g = GATES["wf:plan"];
  assert.equal(g.id, "intake-confirm");
  const st = blank({ phase: "intake", size: "M", intakeConfirmedAt: "2026-01-01T00:00:00Z" });
  const r = advance(st, "wf:plan", "");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(st.phase, "planning");
  assert.equal(st.verdicts.gateStatus.id, "intake-confirm");
  assert.equal(st.verdicts.gateStatus.ok, true, "放行亦写快照");
  // S 豁免（无记账、开关未关）
  const s = blank({ phase: "intake", size: "S" });
  assert.equal(advance(s, "wf:plan", "").ok, true, "S 级豁免");
  // 显式 opt-out（M/L 均放行）
  for (const size of ["M", "L"]) {
    const off = blank({ phase: "intake", size, intakeConfirmOff: true });
    assert.equal(advance(off, "wf:plan", "").ok, true, `intakeConfirmOff===true ${size} 放行`);
  }
  // 缺省 size（存量无 size → tierOf=M）仍受闸
  assert.equal(advance(blank({ phase: "intake" }), "wf:plan", "").ok, false, "缺省 size 按 M 受闸");
});

test("T04 关卡：planning/review/test_design 重入不受闸（谓词首项 phase!==intake）", () => {
  for (const phase of ["planning", "review", "test_design"]) {
    const st = blank({ phase, size: "M" }); // full 表：test_design 亦 wf:plan 合法来源
    assert.equal(advance(st, "wf:plan", "").ok, true, `${phase} 重入不受闸`);
  }
});

test("T04 双表：GATES_DAILY[\"wf:plan\"] === GATES[\"wf:plan\"]（同对象复用，同 wf:done 模式）", () => {
  assert.equal(GATES_DAILY["wf:plan"], GATES["wf:plan"], "daily/full 同对象");
  assert.equal(GATES_DAILY["wf:done"], GATES["wf:done"], "既有复用模式不变");
  // daily 行为矩阵：M 拒 / 记账放行 / S 豁免
  const rej = blank({ mode: "daily", phase: "intake", size: "M" });
  const r = advance(rej, "wf:plan", "");
  assert.equal(r.ok, false);
  assert.equal(r.gate, "intake-confirm");
  const okSt = blank({ mode: "daily", phase: "intake", size: "L", intakeConfirmedAt: "t" });
  assert.equal(advance(okSt, "wf:plan", "").ok, true);
  const s = blank({ mode: "daily", phase: "intake", size: "S" });
  assert.equal(advance(s, "wf:plan", "").ok, true);
});

// ── 纯函数：作废/保留语义（复用既有重置点，L267/L291 不动）──────────
test("T04 作废：force re-intake 清 intakeConfirmedAt（verdicts 整组重置守卫为唯一判据）", () => {
  const st = blank({ phase: "intake", size: "M", slug: "old", intakeConfirmedAt: "2026-01-01T00:00:00Z" });
  const r = advance(st, "wf:intake", "! new-task");
  assert.equal(r.ok, true);
  assert.equal(st.verdicts?.intakeConfirmedAt, undefined, "新任务清 intake 确认记账");
  assert.equal(st.slug, "new-task");
  // 清账后 M 级重新受闸
  assert.equal(advance(st, "wf:plan", "").ok, false, "re-intake 后须重新出卡");
});

test("T04 保留：wf:plan 重入后 intakeConfirmedAt 仍在（只作废 confirmedAt，既有语义不变）", () => {
  const st = blank({ phase: "planning", size: "M", intakeConfirmedAt: "2026-01-01T00:00:00Z", planConfirmedAt: "2026-01-01T00:00:00Z" });
  const r = advance(st, "wf:plan", "");
  assert.equal(r.ok, true);
  assert.equal(st.verdicts?.intakeConfirmedAt, "2026-01-01T00:00:00Z", "wf:plan 不清 intake 账");
  assert.equal(st.verdicts?.confirmedAt, undefined, "方案确认作废语义逐字保留");
});

test("T04 拒绝不误清：非法来源被拒时 intakeConfirmedAt 保留", () => {
  const st = blank({ phase: "building", size: "M", intakeConfirmedAt: "2026-01-01T00:00:00Z" });
  const r = advance(st, "wf:plan", ""); // building 非 wf:plan 合法来源
  assert.equal(r.ok, false);
  assert.equal(r.note, "illegal-transition");
  assert.equal(st.verdicts?.intakeConfirmedAt, "2026-01-01T00:00:00Z", "拒绝路径不清记账");
});

// ── harness e2e：intake→拒→question 出卡→放行 ───────────────────────
test("T04 e2e：daily M——intake 后 wf:plan 拒；question 出卡（锚需求无误）后放行", async () => {
  const sid = "ses_ig1"; const m = mkCtx(); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[M] ig-e2e" } });
  const rej = await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  assert.match(rej, /需求确认关卡未过/, "未出卡 wf:plan 被拒");
  assert.match(rej, /需求无误/, "拒绝文案指路固定选项");
  assert.equal(stOf(sid).phase, "intake", "拒绝阶段不变");
  await ask(m, sid); // intake 窗口出卡（T03 观测记账）
  assert.ok(stOf(sid).verdicts?.intakeConfirmedAt, "出卡记账");
  assert.match(await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} }), /planning/, "出卡后放行");
});

test("T04 e2e：opt-out（requireIntakeConfirm=false）免出卡直接放行", async () => {
  const sid = "ses_ig2"; const m = mkCtx({ requireIntakeConfirm: false }); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[M] ig-off" } });
  assert.equal(stOf(sid).intakeConfirmOff, true);
  assert.match(await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} }), /planning/, "opt-out 免出卡");
});

test("T04 e2e：S 级 intake 免出卡直接 wf:plan", async () => {
  const sid = "ses_ig3"; const m = mkCtx(); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[S] ig-s" } });
  assert.match(await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} }), /planning/, "S 豁免");
});