// M16-r34 日常模式（daily）：自动化用户 5 步习惯 plan→verify→修订→执行→核对。
// 一条流全 tier（S/M/L），tier 只改委派与否；砍 test_design/reconcile/build_review/fixing。
// mode 选择：新 intake 默认 daily，[FULL] 显式完整流；存量无 mode → full（兼容）。
// 纯函数（FLOWS_DAILY/GATES_DAILY/evaluateTransition/guidance）+ 全链路（verdict 记账/返工回路）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import {
  FLOWS, FLOWS_DAILY, GATES_DAILY, NEXT_DAILY, evaluateTransition, flowFor, isDaily,
} from "../server/lib.ts";
import { guidance } from "../server/guidance.ts"; // M16-r39 T08：guidance 拆分

const DIR = "/tmp/opencode/wf-daily";
const DB = `${DIR}/.workflow/wf.db`;
const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const tools = []; const cmds = []; const entries = [];
  let hookFn = null;
  const ctx = {
    options: { probe: false },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    session: {
      get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }),
      wait: async () => {}, prompt: async () => {}, hook: async () => ({ dispose() {} }),
      instructions: { entry: { put: async (i) => entries.push(i), list: async () => entries, remove: async () => {} } },
    },
    tool: { transform: (fn) => { fn({ add: (d) => tools.push(d), list: () => tools.map((t) => ({ name: t.name })) }); return { dispose() {} }; }, hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
    command: { transform: (fn) => { fn({ add: (d) => cmds.push(d) }); return { dispose() {} }; } },
  };
  return { ctx, tools, cmds, entries, hook: () => hookFn };
};
// M16-r44：方案确认交互模拟——leader 在确认窗口调 question（选项含锚定批准标签）
const confirm = (m, sid) => m.hook()({ tool: "question", sessionID: sid, agent: "workflow",
  input: { questions: [{ question: "方案确认", header: "方案确认", options: [{ label: "批准执行" }, { label: "修改方案" }, { label: "终止任务" }] }] } }, {});
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (sid = "ses_d") => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
const blank = (over = {}) => ({ slug: "t", phase: null, rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, artifacts: {}, lanes: {}, ...over });
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

test("r34 FLOWS_DAILY 边表：7 命令、砍四阶段、wf:fix 返工指 building 复用 test_fix", () => {
  assert.deepEqual(Object.keys(FLOWS_DAILY).toSorted(),
    ["wf:build", "wf:done", "wf:fix", "wf:intake", "wf:plan", "wf:review", "wf:test"].toSorted());
  assert.equal(FLOWS_DAILY["wf:build"].to, "building");
  assert.ok(FLOWS_DAILY["wf:build"].from.includes("review"), "daily build 从 review 进");
  assert.equal(FLOWS_DAILY["wf:fix"].to, "building", "daily wf:fix 返工指 building（非 fixing）");
  assert.equal(FLOWS_DAILY["wf:fix"].counter, "test_fix", "复用 test_fix 计数");
  assert.deepEqual(FLOWS_DAILY["wf:fix"].from, ["testing"]);
  assert.ok(FLOWS_DAILY["wf:test"].from.includes("building"), "daily test 从 building 进");
  assert.equal(FLOWS_DAILY["wf:review"].counter, "plan_review");
  assert.match(NEXT_DAILY.testing, /FAIL→\/wf:fix/, "daily testing 下一步指 fix 返工");
  assert.match(NEXT_DAILY.review, /wf:build/, "daily review 下一步指 build");
  // 完整流不受影响
  assert.equal(FLOWS["wf:fix"].to, "fixing");
  assert.ok(FLOWS["wf:test-design"], "full 保留 test-design");
});

test("r34 mode 选择：isDaily/flowFor（无 mode=full 兼容，daily 用子表）", () => {
  assert.equal(isDaily(blank()), false, "存量无 mode → full");
  assert.equal(isDaily(blank({ mode: "full" })), false);
  assert.equal(isDaily(blank({ mode: "daily" })), true);
  assert.equal(flowFor(blank(), "wf:fix").to, "fixing", "full 用 FLOWS");
  assert.equal(flowFor(blank({ mode: "daily" }), "wf:fix").to, "building", "daily 用 FLOWS_DAILY");
  assert.equal(flowFor(blank({ mode: "daily" }), "wf:test-design"), undefined, "daily 无 test-design");
});

test("r34 intake：默认 daily；[FULL] 选完整流；前缀任意序；size 沿用", () => {
  const a = blank({ phase: null, slug: "" });
  assert.ok(evaluateTransition("wf:intake", a, "[S] my-task").ok);
  assert.equal(a.mode, "daily"); assert.equal(a.size, "S"); assert.equal(a.slug, "my-task");
  const b = blank({ phase: null, slug: "" });
  evaluateTransition("wf:intake", b, "[FULL][L] big-task");
  assert.equal(b.mode, "full"); assert.equal(b.size, "L");
  const c = blank({ phase: null, slug: "" });
  evaluateTransition("wf:intake", c, "[M][FULL] x");
  assert.equal(c.mode, "full"); assert.equal(c.size, "M");
  const d = blank({ phase: null, slug: "" });
  evaluateTransition("wf:intake", d, "plain");
  assert.equal(d.mode, "daily"); assert.equal(d.size, "M", "缺省 M");
});

test("r34 daily 边表流转：review→build→test→done；full-only 命令被拒", () => {
  const st = blank({ mode: "daily", phase: "review", size: "S", planConfirmedAt: "2026-01-01T00:00:00Z" });
  assert.ok(evaluateTransition("wf:build", st, "").ok, "S 级（已确认）build 跳过 verify 关卡");
  const stNo = blank({ mode: "daily", phase: "review", size: "S" });
  const rNo = evaluateTransition("wf:build", stNo, "");
  assert.equal(rNo.ok, false, "M16-r44：S 级未确认也被方案确认关卡拒");
  assert.match(rNo.msg, /方案确认关卡未过/);
  assert.equal(st.phase, "review"); // evaluateTransition 不改 phase（transition 改）
  const st2 = blank({ mode: "daily", phase: "building" });
  assert.ok(evaluateTransition("wf:test", st2, "").ok);
  const st3 = blank({ mode: "daily", phase: "testing", testReportVerdict: "PASS" });
  assert.ok(evaluateTransition("wf:done", st3, "").ok);
  // daily 无 test-design/reconcile/review-build
  const st4 = blank({ mode: "daily", phase: "review" });
  const r = evaluateTransition("wf:test-design", st4, "");
  assert.equal(r.ok, false); assert.equal(r.note, "unknown-command");
});

test("r34 verify 关卡：M/L build 须 planReviewVerdict=PASS（S 跳结论）；M16-r44 方案确认全 tier 必经", () => {
  const gate = GATES_DAILY["wf:build"];
  assert.match(gate(blank({ mode: "daily", size: "M" })), /方案确认关卡未过/, "M 未确认 → 方案确认关卡拒");
  assert.match(gate(blank({ mode: "daily", size: "M", planReviewVerdict: "FAIL" })), /方案确认关卡未过/, "未确认优先于结论校验");
  assert.match(gate(blank({ mode: "daily", size: "M", planConfirmedAt: "x" })), /验证关卡未过/, "已确认无 verdict → verdict 关卡拒");
  assert.match(gate(blank({ mode: "daily", size: "M", planConfirmedAt: "x", planReviewVerdict: "FAIL" })), /验证关卡未过/, "FAIL → 拒");
  assert.equal(gate(blank({ mode: "daily", size: "M", planConfirmedAt: "x", planReviewVerdict: "PASS" })), null, "PASS+确认 → 放行");
  assert.match(gate(blank({ mode: "daily", size: "S" })), /方案确认关卡未过/, "S 未确认也拒（全 tier 必经）");
  assert.equal(gate(blank({ mode: "daily", size: "S", planConfirmedAt: "x" })), null, "S 已确认跳过结论（自验自律）");
  assert.equal(gate(blank({ mode: "daily", size: "L", planConfirmedAt: "x", planReviewVerdict: "PASS" })), null);
});

test("r34 FAIL 返工回路：testing→wf:fix→building，test_fix 计数，≤3 上限", () => {
  const st = blank({ mode: "daily", phase: "testing", testReportVerdict: "FAIL" });
  for (let i = 1; i <= 3; i++) {
    st.phase = "testing";
    const r = evaluateTransition("wf:fix", st, "");
    assert.ok(r.ok, `第 ${i} 轮返工应放行`);
    assert.equal(st.rounds.test_fix, i);
  }
  st.phase = "testing";
  const over = evaluateTransition("wf:fix", st, "");
  assert.equal(over.ok, false); assert.equal(over.note, "limit-exceeded");
});

test("r34 guidance：S 覆盖两条契约（亲自实现+自写）；M/L 委派+独立验证", () => {
  const s = guidance("planning", blank({ mode: "daily", size: "S" }));
  assert.match(s, /亲自/, "S leader 亲自实现");
  assert.match(s, /自写|自行.*落盘/, "S leader 自写产物");
  assert.ok(!/leader 禁止代写/.test(s), "S 不得含 WRITE_CONTRACT 禁代写");
  const m = guidance("planning", blank({ mode: "daily", size: "M" }));
  assert.match(m, /wf\/planner/, "M 委派 planner");
  assert.match(m, /功能点|T<nn>|T01/, "M 拆功能点");
  assert.match(m, /leader 禁止代写/, "M 保留写入契约");
  const rv = guidance("review", blank({ mode: "daily", size: "M" }));
  assert.match(rv, /独立|五维/, "M 独立五维验证");
  assert.match(rv, /\*\*结论\*\*: PASS\|FAIL/, "M plan-review 首行 verdict");
  const rs = guidance("review", blank({ mode: "daily", size: "S" }));
  assert.match(rs, /自验|自行验证/, "S 自验");
  // full 模式 guidance 不变
  const full = guidance("planning", blank({ mode: "full", size: "M" }));
  assert.match(full, /委派 subagent wf\/planner/);
});

test("r34 全链路 S：intake→plan→review→build→test→done，leader 自写产物，零 sub-agent", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const sid = "ses_d";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[S] todo" } });
  assert.equal(stOf(sid).mode, "daily"); assert.equal(stOf(sid).size, "S");
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan\n轻量" }, { sessionID: sid, agent: "wf/leader" });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await confirm(m, sid); // M16-r44：build 前方案确认（S 也须确认）
  // S 自验，无 plan-review 产物也可 build
  const b = await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} });
  assert.match(b, /building/); assert.equal(stOf(sid).phase, "building");
  await cmd(m, "wf:test").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "test-report", content: "**结论**: PASS\n证据：bun test 全绿" }, { sessionID: sid, agent: "wf/leader" });
  const d = await cmd(m, "wf:done").execute({ sessionID: sid, prompt: {} });
  assert.match(d, /done/); assert.equal(stOf(sid).phase, "done");
});

test("r34 全链路 M：plan-review verdict 关卡 + FAIL→wf:fix 返工", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const sid = "ses_m";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[M] feat" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan\nT01 功能点" }, { sessionID: sid, agent: "wf/planner" });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  // 未确认 → 方案确认关卡拒（M16-r44）；确认后未写 plan-review → verdict 关卡拒
  assert.match(await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} }), /方案确认关卡未过/);
  await confirm(m, sid);
  // 未写 plan-review → build 被关卡拒
  const rej = await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} });
  assert.match(rej, /验证关卡未过/);
  // reviewer 写 plan-review FAIL → 仍拒
  await tool(m).execute({ kind: "plan-review", content: "**结论**: FAIL\n问题清单" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  assert.equal(stOf(sid).planReviewVerdict, "FAIL");
  assert.match(await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} }), /验证关卡未过/);
  // 修订后 PASS → 放行
  await tool(m).execute({ kind: "plan-review", content: "**结论**: PASS\n通过" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  assert.equal(stOf(sid).planReviewVerdict, "PASS");
  assert.match(await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} }), /building/);
  await cmd(m, "wf:test").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "test-report", content: "**结论**: FAIL\n缺陷" }, { sessionID: sid, agent: "wf/tester" });
  // FAIL → wf:fix 回 building（非 fixing）
  await cmd(m, "wf:fix").execute({ sessionID: sid, prompt: {} });
  assert.equal(stOf(sid).phase, "building", "daily wf:fix 返工回 building");
  assert.equal(stOf(sid).rounds.test_fix, 1);
});

test("r34 兼容：存量无 mode 任务走 full（test-design 可用）；[FULL] 新任务走 full", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const sid = "ses_full";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[FULL] legacy" } });
  assert.equal(stOf(sid).mode, "full");
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "test-plan", content: "# 用例" }, { sessionID: sid, agent: "wf/tester" });
  const td = await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} });
  assert.match(td, /test_design/, "full 模式 test-design 可用");
});