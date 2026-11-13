// M16-r39 T02（A2）：plan 修订清双通道记账——kind=plan 写入（content/patch、任何 mode）
// 清 planReviewVerdict + testPlanWritten，防「plan 已改、旧审核结论/旧测试计划仍蒙混过关」。
// 输出追加模式感知提示（daily→重新 wf:review；full→wf:review / wf:test-design）。
// mkCtx 与 daily-mode.test.js 同源（mock 形状=server 真实写入形状）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js"; // T04：装配收敛（_ctx=setup(ctx) 消费者视图）

const DIR = "/tmp/opencode/wf-plan-inval";
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
// M16-r44：方案确认交互模拟（leader question，选项含锚定批准标签）
const confirm = (m, sid) => m.hook()({ tool: "question", sessionID: sid, agent: "workflow",
  input: { questions: [{ question: "方案确认", header: "方案确认", options: [{ label: "批准执行" }, { label: "修改方案" }, { label: "终止任务" }] }] } }, {});
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

test("T02 daily M：plan-review PASS 后 patch 改 plan → 验证结论被清，wf:build 拒；重写 PASS 恢复放行", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const sid = "ses_inv_d";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[M] inv-daily" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan\n\n旧方案\n" }, { sessionID: sid, agent: "wf/planner" });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan-review", content: "**结论**: PASS\n通过" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  assert.equal(stOf(sid).verdicts?.planReview, "PASS");
  await confirm(m, sid); // M16-r44：build 关卡须方案确认
  assert.ok(stOf(sid).verdicts?.confirmedAt, "question 观察记账 planConfirmedAt");
  // plan 修订（patch）→ 旧 PASS 结论必须被清；M16-r44：确认记账同点作废
  const p = await tool(m).execute({ kind: "plan", patch: [{ old: "旧方案", new: "新方案" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(p.content, /已写入/);
  assert.equal(stOf(sid).verdicts?.planReview, undefined, "plan 修订清 planReviewVerdict");
  assert.equal(stOf(sid).verdicts?.confirmedAt, undefined, "plan 修订清 planConfirmedAt");
  await confirm(m, sid); // 重新确认后再验 verdict 关卡
  const rej = await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} });
  assert.match(rej, /验证关卡未过/, "修订后旧 PASS 不得蒙混 wf:build");
  // 恢复：重新独立验证 PASS → 放行
  await tool(m).execute({ kind: "plan-review", content: "**结论**: PASS\n复审通过" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  assert.match(await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} }), /building/);
});

test("T02 full：test-plan 已写后 content 改 plan → 记账被清，wf:test-design 拒；重写 test-plan 恢复放行", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const sid = "ses_inv_f";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[FULL] inv-full" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "test-plan", content: "# 用例" }, { sessionID: sid, agent: "wf/tester" });
  assert.equal(stOf(sid).verdicts?.testPlanWritten, true);
  // plan 修订（content 全量重写）→ 旧 test-plan 记账必须被清
  const w = await tool(m).execute({ kind: "plan", content: "# plan v2\n方案变更\n" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(w.content, /已写入/);
  assert.equal(stOf(sid).verdicts?.testPlanWritten, undefined, "plan 修订清 testPlanWritten");
  const rej = await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} });
  assert.match(rej, /双通道关卡未过/, "修订后旧 test-plan 不得蒙混 wf:test-design");
  // 恢复：重写 test-plan → 放行
  await tool(m).execute({ kind: "test-plan", content: "# 用例 v2" }, { sessionID: sid, agent: "wf/tester" });
  assert.match(await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} }), /test_design/);
});

test("T02 提示模式感知：daily 含 wf:review 不含 wf:test-design；full 含两者", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const sidD = "ses_note_d";
  await cmd(m, "wf:intake").execute({ sessionID: sidD, prompt: { text: "note-daily" } });
  await cmd(m, "wf:plan").execute({ sessionID: sidD, prompt: {} });
  const rd = await tool(m).execute({ kind: "plan", content: "# plan\n" }, { sessionID: sidD, agent: "wf/planner" });
  assert.match(rd.content, /plan 已修订/, "kind=plan 输出应含修订提示");
  assert.match(rd.content, /wf:review/);
  assert.ok(!rd.content.includes("wf:test-design"), "daily 提示不得含 wf:test-design");
  const sidF = "ses_note_f";
  await cmd(m, "wf:intake").execute({ sessionID: sidF, prompt: { text: "[FULL] note-full" } });
  await cmd(m, "wf:plan").execute({ sessionID: sidF, prompt: {} });
  const rf = await tool(m).execute({ kind: "plan", content: "# plan\n" }, { sessionID: sidF, agent: "wf/planner" });
  assert.match(rf.content, /wf:review/);
  assert.match(rf.content, /wf:test-design/, "full 提示应含 wf:test-design");
});

// ── verify 补充边界（M16-r39 testing）：full 双记账并存 → patch 一次同清两字段 ──
// plan 原例分别只断言单字段（daily 查 planReviewVerdict / full 查 testPlanWritten）；
// 此处锁「双通道同时失效」：patch 修订后两字段同清，test-design 拒，重写 test-plan 恢复。
test("T02 边界：full 双记账并存（PASS+testPlanWritten）→ patch 改 plan 同清两字段", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const sid = "ses_inv_both";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[FULL] inv-both" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan\n\n旧方案\n" }, { sessionID: sid, agent: "wf/planner" });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan-review", content: "**结论**: PASS\n通过" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  await tool(m).execute({ kind: "test-plan", content: "# 用例" }, { sessionID: sid, agent: "wf/tester" });
  const before = stOf(sid);
  assert.equal(before.verdicts?.planReview, "PASS");
  assert.equal(before.verdicts?.testPlanWritten, true);
  const p = await tool(m).execute({ kind: "plan", patch: [{ old: "旧方案", new: "新方案" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(p.content, /已写入/);
  const after = stOf(sid);
  assert.equal(after.verdicts?.planReview, undefined, "patch 修订同清 planReviewVerdict");
  assert.equal(after.verdicts?.testPlanWritten, undefined, "patch 修订同清 testPlanWritten");
  assert.match(await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} }), /双通道关卡未过/);
  await tool(m).execute({ kind: "test-plan", content: "# 用例 v2" }, { sessionID: sid, agent: "wf/tester" });
  assert.match(await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} }), /test_design/);
});