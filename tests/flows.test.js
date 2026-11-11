// P0-b：流转状态机测试——来源合法性 / GATES / 计数器「进入即计数」/ intake 守卫与重置
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOWS, LIMITS, evaluateTransition } from "../server/lib.ts";

const mkSt = (phase = null, extra = {}) => ({
  sessionID: "ses_test",
  slug: "",
  phase,
  rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
  lanes: {},
  artifacts: {},
  ...extra,
});

const advance = (st, cmd, text, at) => {
  const r = evaluateTransition(cmd, st, text, at);
  if (r.ok) st.phase = FLOWS[cmd].to;
  return r;
};

test("FLOWS 全表正向流转链（主路径，无返工；M16-r28：assign 并入 test-design）", () => {
  const st = mkSt();
  const steps = ["wf:intake", "wf:plan", "wf:review", "wf:test-design",
    "wf:build", "wf:reconcile", "wf:review-build", "wf:test", "wf:done"];
  for (const cmd of steps) {
    if (cmd === "wf:test-design") st.testPlanWritten = true; // gate 前置条件
    if (cmd === "wf:done") st.testReportVerdict = "PASS"; // gate 前置条件
    const r = advance(st, cmd, "demo-task");
    assert.equal(r.ok, true, `${cmd} 应通过：${JSON.stringify(r)}`);
  }
  assert.equal(st.phase, "done");
});

test("非法来源被拒（building 状态不可直接 wf:test）", () => {
  const st = mkSt("building");
  const r = advance(st, "wf:test");
  assert.equal(r.ok, false);
  assert.equal(r.note, "illegal-transition");
  assert.match(r.msg, /不能从阶段「building」进入「testing」/);
  assert.match(r.msg, /下一步.*\/wf:reconcile/s);
});

test("非法来源被拒（planning 状态不可直接 wf:build）", () => {
  const st = mkSt("planning");
  const r = advance(st, "wf:build");
  assert.equal(r.ok, false);
  assert.equal(r.note, "illegal-transition");
});

test("gate-rejected：review 未产出 test-plan 时 wf:test-design 被拒（不消耗额度；M16-r28 关卡随 assign 迁移）", () => {
  const st = mkSt("review");
  const before = { ...st.rounds };
  const r = advance(st, "wf:test-design");
  assert.equal(r.ok, false);
  assert.equal(r.note, "gate-rejected");
  assert.match(r.msg, /test-plan\.md/);
  assert.match(r.msg, /wf_command\(name="wf:test-design"\)/, "拒绝文案指路新命令名");
  assert.deepEqual(st.rounds, before, "拒绝不得改变计数器");
  assert.equal(st.phase, "review", "阶段不变");
});

test("M16-r28 存量兼容：卡在 assign 阶段的在途任务可直接 wf:test-design", () => {
  const st = mkSt("assign", { testPlanWritten: true });
  const r = advance(st, "wf:test-design");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(st.phase, "test_design");
});

test("gate-rejected：testReportVerdict=FAIL 时 wf:done 被拒", () => {
  const st = mkSt("testing", { testReportVerdict: "FAIL" });
  const r = advance(st, "wf:done");
  assert.equal(r.ok, false);
  assert.equal(r.note, "gate-rejected");
  assert.match(r.msg, /「FAIL」（要求 PASS）|「FAIL」\(要求 PASS\)/);
  assert.match(r.msg, /\/wf:fix/);
});

test("gate-rejected：testReportVerdict 缺失时 wf:done 被拒", () => {
  const st = mkSt("testing");
  const r = advance(st, "wf:done");
  assert.equal(r.ok, false);
  assert.match(r.msg, /未产出/);
});

test("计数器「进入即计数」：review 首入=1，重复递增，达 LIMITS 拒绝", () => {
  const st = mkSt("planning");
  assert.equal(advance(st, "wf:review").ok, true);
  assert.equal(st.rounds.plan_review, 1, "首次进入=1");
  assert.equal(st.phase, "review");
  // 返工边 review→plan 不消耗额度
  assert.equal(advance(st, "wf:plan").ok, true);
  assert.equal(st.rounds.plan_review, 1, "wf:plan 无计数器");
  assert.equal(advance(st, "wf:review").ok, true);
  assert.equal(st.rounds.plan_review, 2);
  assert.equal(advance(st, "wf:plan").ok, true);
  assert.equal(advance(st, "wf:review").ok, true);
  assert.equal(st.rounds.plan_review, 3);
  assert.equal(st.rounds.plan_review, LIMITS.plan_review, "达上限");
  const r = advance(st, "wf:plan");
  assert.equal(r.ok, true);
  const r4 = advance(st, "wf:review");
  assert.equal(r4.ok, false);
  assert.equal(r4.note, "limit-exceeded");
  assert.equal(st.rounds.plan_review, 3, "拒绝不递增");
  assert.match(r4.msg, /plan_review 已 3\/3 轮/);
});

test("计数器独立：build_review 与 test_fix 各自计数", () => {
  const st = mkSt("test_design");
  assert.equal(advance(st, "wf:build").ok, true);
  assert.equal(advance(st, "wf:reconcile").ok, true);
  assert.equal(advance(st, "wf:review-build").ok, true);
  assert.equal(st.rounds.build_review, 1);
  assert.equal(st.rounds.plan_review, 0, "plan_review 不受影响");
  // testing → fixing → testing → fixing：test_fix 递增
  assert.equal(advance(st, "wf:test").ok, true);
  st.testReportVerdict = "FAIL";
  assert.equal(advance(st, "wf:fix").ok, true);
  assert.equal(st.rounds.test_fix, 1);
  assert.equal(advance(st, "wf:test").ok, true);
  assert.equal(advance(st, "wf:fix").ok, true);
  assert.equal(st.rounds.test_fix, 2);
});

test("intake-guard：活动中（非 done）intake 无 ! 前缀被拒", () => {
  const st = mkSt("planning", { slug: "old-task" });
  const r = advance(st, "wf:intake", "new-task");
  assert.equal(r.ok, false);
  assert.equal(r.note, "intake-guard");
  assert.match(r.msg, /已有活动任务.*old-task/);
  assert.match(r.msg, /\/wf:reset/);
  assert.equal(st.slug, "old-task", "slug 不变");
});

test("intake 强制（! 前缀）：重置 rounds/artifacts/gate 记账并留 prev", () => {
  const st = mkSt("building", {
    slug: "old-task",
    artifacts: { "plan.md": { bytes: 10 } },
    testPlanWritten: true,
    testReportVerdict: "FAIL",
    updatedAt: "2026-11-09T00:00:00.000Z",
  });
  const r = advance(st, "wf:intake", "!New Task");
  assert.equal(r.ok, true);
  assert.equal(st.slug, "new-task", "slugify 后小写连字符");
  assert.deepEqual(st.rounds, { plan_review: 0, build_review: 0, test_fix: 0 }, "计数器重置");
  assert.deepEqual(st.artifacts, {}, "产物记账重置");
  assert.equal(st.testPlanWritten, undefined, "test-plan 记账清除");
  assert.equal(st.testReportVerdict, undefined, "verdict 记账清除");
  assert.deepEqual(st.prev, { slug: "old-task", phase: "building", at: "2026-11-09T00:00:00.000Z" });
});

test("intake 从 done 重开：允许且重置", () => {
  const st = mkSt("done", { slug: "finished", testReportVerdict: "PASS" });
  const r = advance(st, "wf:intake", "next-thing");
  assert.equal(r.ok, true);
  assert.equal(st.slug, "next-thing");
  assert.equal(st.testReportVerdict, undefined);
  assert.equal(st.prev.slug, "finished");
  assert.equal(st.prev.phase, "done");
  assert.ok(st.prev.at, "prev.at 记录时间");
});

test("intake 首次（无阶段）：设置 slug；空文本回退 untitled", () => {
  const st = mkSt();
  assert.equal(advance(st, "wf:intake", "My Cool Feature!").ok, true);
  assert.equal(st.slug, "my-cool-feature");
  const st2 = mkSt();
  assert.equal(advance(st2, "wf:intake", "").ok, true);
  assert.equal(st2.slug, "untitled");
  const st3 = mkSt();
  assert.equal(advance(st3, "wf:intake", { text: "对象形态 slug" }).ok, true, "prompt 对象形态");
  assert.equal(st3.slug, "对象形态-slug", "T01：Unicode slug 保留中文");
});

test("intake 非重置分支下 slug 仍被新 text 覆盖（锁定现状：slugify 非空即覆盖），rounds 保留", () => {
  // from=null 且 st.slug 非空：重置分支不走，但末行 slug 赋值无条件执行
  const st = mkSt(null, { slug: "kept", rounds: { plan_review: 2, build_review: 1, test_fix: 0 } });
  const r = advance(st, "wf:intake", "ignored");
  assert.equal(r.ok, true);
  assert.equal(st.slug, "ignored", "现状：slug 无条件覆盖");
  assert.equal(st.rounds.plan_review, 2, "计数器保留");
  assert.equal(st.testPlanWritten, undefined, "记账字段未被动过");
});

test("返工边完整覆盖：fixing→reconcile 合法（M10-a 返工边）", () => {
  const st = mkSt("fixing");
  assert.equal(advance(st, "wf:reconcile").ok, true);
  assert.equal(st.phase, "reconcile");
});
