// M16-r44：方案确认交互关卡——question 观察记账（planConfirmedAt）+ wf:build 关卡校验 + 三路清零。
// 语义：leader 在确认窗口（review/test_design）调宿主 question 工具、选项含锚定批准标签
//（^批准/approve）→ guard-hook 记账；GATES/GATES_DAILY["wf:build"] 校验；plan 修订
//（wf:plan 推进 / wf_write_artifact kind=plan）与新任务 intake 即作废。
// 诚实边界：用户实际选择不可观测（只回模型）——本套件锁「问过了」，不锁「答的是批准」。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js"; // T04：装配收敛（_ctx=setup(ctx) 消费者视图）
import { GATES, evaluateTransition, flowFor } from "../server/lib.ts";

const DIR = "/tmp/opencode/wf-plan-confirm";
const DB = `${DIR}/.workflow/wf.db`;
const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const entries = [];
  let hookFn = null;
  // T04：装配收敛 helpers/host-stub（tools/cmds=stub 注册捕获数组；question 取证=tools.hook 覆盖）
  const host = mkHostStub({
    options: { probe: false },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) },
    instructions: { put: async (i) => { entries.push(i); }, list: async () => entries },
    tools: { hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
  });
  return { ctx: host._ctx, tools: host._toolDefs, cmds: host._cmdDefs, entries, hook: () => hookFn };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
// leader question 调用模拟；labels 可定制（默认含批准执行）
const ask = (m, sid, agent = "workflow", labels = ["批准执行", "修改方案", "终止任务"]) =>
  m.hook()({ tool: "question", sessionID: sid, agent,
    input: { questions: [{ question: "方案确认", header: "方案确认", options: labels.map((label) => ({ label })) }] } }, {});
const blank = (over = {}) => ({ slug: "t", phase: null, rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, artifacts: {}, lanes: {}, ...over });
const advance = (st, cmdName, text) => {
  const r = evaluateTransition(cmdName, st, text);
  if (r.ok) st.phase = flowFor(st, cmdName).to;
  return r;
};
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// ── 纯函数：关卡矩阵 ─────────────────────────────────────────────────
test("M16-r44 full wf:build 关卡：无确认拒（指路 question）、有确认放行", () => {
  const msg = GATES["wf:build"](blank({ phase: "test_design" }));
  assert.match(String(msg), /方案确认关卡未过/);
  assert.match(String(msg), /question/, "拒绝文案指路 question 交互");
  assert.match(String(msg), /批准执行/, "指路含固定选项标签");
  assert.equal(GATES["wf:build"](blank({ phase: "test_design", planConfirmedAt: "2026-01-01T00:00:00Z" })), null);
});

test("M16-r44 清零：wf:plan 重开规划作废确认（纯函数）", () => {
  const st = blank({ mode: "daily", phase: "review", planConfirmedAt: "2026-01-01T00:00:00Z" });
  const r = advance(st, "wf:plan", "");
  assert.equal(r.ok, true);
  assert.equal(st.planConfirmedAt, undefined, "wf:plan 推进即作废旧确认");
  assert.equal(st.phase, "planning");
});

test("M16-r44 清零：intake ! 强制重置作废确认（纯函数）", () => {
  const st = blank({ mode: "daily", phase: "testing", slug: "old", planConfirmedAt: "2026-01-01T00:00:00Z" });
  const r = advance(st, "wf:intake", "! new-task");
  assert.equal(r.ok, true);
  assert.equal(st.planConfirmedAt, undefined, "新任务清方案确认记账");
  assert.equal(st.slug, "new-task");
});

test("M16-r44 拒绝不误清：wf:plan 非法来源被拒时确认保留", () => {
  const st = blank({ mode: "daily", phase: "building", planConfirmedAt: "2026-01-01T00:00:00Z" });
  const r = advance(st, "wf:review", ""); // daily 无此边（building 来源非法）
  assert.equal(r.ok, false);
  assert.equal(st.planConfirmedAt, "2026-01-01T00:00:00Z", "拒绝路径不清记账");
});

// ── harness：question 观察分支 ───────────────────────────────────────
const setupAtReview = async (sid, prefix = "[M] confirm-t") => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: prefix } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} }); // → review（确认窗口）
  return m;
};

test("M16-r44 观察：review 窗口批准选项 → 记账 + 审计 plan:confirm", async () => {
  const sid = "ses_pc1"; const m = await setupAtReview(sid);
  await ask(m, sid);
  const st = stOf(sid);
  assert.ok(st.planConfirmedAt, "planConfirmedAt 已记账");
  const ev = st.log.find((l) => l.cmd === "plan:confirm");
  assert.ok(ev, "审计含 plan:confirm");
  assert.equal(ev.note, "question-observed");
});

test("M16-r44 观察：不含批准类选项（澄清问）不记账", async () => {
  const sid = "ses_pc2"; const m = await setupAtReview(sid);
  await ask(m, sid, "workflow", ["继续澄清", "跳过"]);
  assert.equal(stOf(sid).planConfirmedAt, undefined, "无锚定批准标签不记账");
  await ask(m, sid, "workflow", ["不批准执行", "终止任务"]); // 锚定：不批准 ≠ 批准
  assert.equal(stOf(sid).planConfirmedAt, undefined, "「不批准」不误记账");
});

test("M16-r44 观察：approve 标签同样记账（英文锚定）", async () => {
  const sid = "ses_pc3"; const m = await setupAtReview(sid);
  await ask(m, sid, "workflow", ["Approve", "Revise"]);
  assert.ok(stOf(sid).planConfirmedAt, "approve（大小写不敏感）记账");
});

test("M16-r44 观察：planning 窗口外不记账；test_design 窗口记账（full）", async () => {
  const sid = "ses_pc4"; const m = mkCtx(); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[FULL] pc-window" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} }); // planning
  await ask(m, sid);
  assert.equal(stOf(sid).planConfirmedAt, undefined, "planning 澄清问不记账");
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: "ses_pc4p", agent: "wf/planner" });
  await ask(m, sid); // review 窗口
  assert.ok(stOf(sid).planConfirmedAt, "review 窗口记账");
  await tool(m).execute({ kind: "test-plan", content: "# 用例" }, { sessionID: "ses_pc4t", agent: "wf/tester" });
  await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} }); // test_design 窗口
  assert.ok(stOf(sid).planConfirmedAt, "test_design 仍在窗口（不重复记账也无副作用）");
});

test("M16-r44 观察：非 leader / 无活动任务不记账", async () => {
  const sid = "ses_pc5"; const m = await setupAtReview(sid);
  await ask(m, "ses_pc5", "wf/planner", ["批准执行"]); // 子会话 question 不记账
  assert.equal(stOf(sid).planConfirmedAt, undefined, "非 leader 不记账");
  await ask(m, "ses_pc5", "build", ["批准执行"]); // 普通主会话 agent 不记账
  assert.equal(stOf(sid).planConfirmedAt, undefined, "普通 agent 不记账");
  const m2 = mkCtx(); await plugin.setup(m2.ctx);
  await ask(m2, "ses_ghost", "workflow", ["批准执行"]); // 无任务会话：不崩、不落盘
  assert.equal(stOf("ses_ghost"), undefined, "无任务不落状态行");
});

test("M16-r44 观察：重复批准幂等（审计恰一条）", async () => {
  const sid = "ses_pc6"; const m = await setupAtReview(sid);
  await ask(m, sid);
  await ask(m, sid);
  const st = stOf(sid);
  assert.equal(st.log.filter((l) => l.cmd === "plan:confirm").length, 1, "重复 question 不重复审计");
  assert.ok(st.planConfirmedAt, "记账仍在");
});

// ── harness：三路清零 + 关卡 e2e ─────────────────────────────────────
test("M16-r44 e2e：full 链——未确认 wf:build 拒；确认后放行；确认记账贯穿至 done", async () => {
  const sid = "ses_pc7"; const m = mkCtx(); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[FULL] pc-e2e" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: "ses_pc7p", agent: "wf/planner" });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "test-plan", content: "# 用例" }, { sessionID: "ses_pc7t", agent: "wf/tester" });
  await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} });
  const rejB = await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} });
  assert.match(rejB, /方案确认关卡未过/, "未确认 wf:build 被拒");
  await ask(m, sid); // test_design 窗口补确认
  assert.ok(stOf(sid).planConfirmedAt);
  assert.match(await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} }), /building/, "确认后放行");
  assert.match(await cmd(m, "wf:reconcile").execute({ sessionID: sid, prompt: {} }), /reconcile/);
  assert.match(await cmd(m, "wf:review-build").execute({ sessionID: sid, prompt: {} }), /build_review/);
  assert.match(await cmd(m, "wf:test").execute({ sessionID: sid, prompt: {} }), /testing/);
  await tool(m).execute({ kind: "test-report", content: "**结论**: PASS\n证据" }, { sessionID: "ses_pc7t", agent: "wf/tester" });
  assert.match(await cmd(m, "wf:done").execute({ sessionID: sid, prompt: {} }), /done/, "确认记账不拦 done（贯穿全程）");
});

test("M16-r44 e2e：plan 内容修订（content 全量）作废确认（artifact 主锚）", async () => {
  const sid = "ses_pc8"; const m = mkCtx(); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[M] pc-inval" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan\n旧方案" }, { sessionID: "ses_pc8p", agent: "wf/planner" });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await ask(m, sid);
  assert.ok(stOf(sid).planConfirmedAt);
  // planner content 全量重写 plan → 确认作废（与 planReviewVerdict/testPlanWritten 同点）
  await tool(m).execute({ kind: "plan", content: "# plan v2\n新方案" }, { sessionID: "ses_pc8p", agent: "wf/planner" });
  assert.equal(stOf(sid).planConfirmedAt, undefined, "kind=plan 写入清 planConfirmedAt");
  const rej = await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} });
  assert.match(rej, /方案确认关卡未过/, "作废后 wf:build 重新被确认关卡拒");
});
