// P2：options.limits 实例覆盖 + wf:ping 报告纯函数测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTransition, guidance, entryValue, pingReport, WF_ROLES, FLOWS } from "../server/lib.ts";

const mkSt = (phase = "review", rounds = { plan_review: 0, build_review: 0, test_fix: 0 }) => ({
  sessionID: "s", slug: "d", phase, rounds, artifacts: {}, lanes: {},
});

test("limits 覆盖：plan_review 上限=1 时第 2 次 review 被拒", () => {
  const st = mkSt("planning");
  const r1 = evaluateTransition("wf:review", st, "", undefined, { plan_review: 1 });
  assert.equal(r1.ok, true);
  assert.equal(st.rounds.plan_review, 1);
  st.phase = "review";
  evaluateTransition("wf:plan", st, ""); // 返工回 planning
  st.phase = "planning";
  const r2 = evaluateTransition("wf:review", st, "", undefined, { plan_review: 1 });
  assert.equal(r2.ok, false);
  assert.equal(r2.note, "limit-exceeded");
  assert.match(r2.msg, /plan_review 已 1\/1 轮/);
});

test("limits 缺项回退默认（只覆盖 test_fix 时 review 仍 3）", () => {
  const st = mkSt("planning", { plan_review: 3, build_review: 0, test_fix: 0 });
  const r = evaluateTransition("wf:review", st, "", undefined, { test_fix: 1 });
  assert.equal(r.ok, false);
  assert.match(r.msg, /plan_review 已 3\/3 轮/);
});

test("guidance/entryValue 使用覆盖后的上限显示", () => {
  const g = guidance("review", { slug: "d", rounds: { plan_review: 2 } }, { plan_review: 5 });
  assert.match(g, /第 2\/5 轮/);
  const e = entryValue({ phase: "fixing", slug: "d", rounds: { test_fix: 2 } }, { test_fix: 10 });
  assert.match(e, /第 2\/10 轮/);
});

test("pingReport：注册齐全", () => {
  const agents = WF_ROLES.map((name) => ({ name, model: { providerID: "p", id: "m" } }));
  const r = pingReport(agents);
  assert.match(r, /wf 角色：7\/7 已注册/);
  assert.ok(!r.includes("缺失"));
  assert.match(r, /model=p\/m/);
});

test("pingReport：缺失/额外/无 model/{agents} 包裹 形状容错", () => {
  const r = pingReport({ agents: [{ id: "wf/planner" }, { name: "wf/superbot", model: { providerID: "x" } }] });
  assert.match(r, /wf 角色：2\/7 已注册/);
  assert.match(r, /⚠️ 缺失：wf\/planner-reviewer/);
  assert.match(r, /model=x\/\?/);
  assert.match(r, /wf\/planner model=\(继承会话模型\)/);
  assert.match(r, /ℹ️ 额外：wf\/superbot/);
});

// 2.2.6 真机形状：ctx.agent.list() 返回 {location, data:[...]}（agent-probe 实证；曾因不认 data 恒报 0/7）
test("pingReport：{location,data} 真机形状", () => {
  const r = pingReport({ location: { directory: "/p" }, data: WF_ROLES.map((name) => ({ id: name, mode: "subagent" })) });
  assert.match(r, /wf 角色：7\/7 已注册/);
  assert.ok(!r.includes("缺失"));
});

test("pingReport：空/异常形状不崩", () => {
  assert.match(pingReport([]), /0\/7/);
  assert.match(pingReport(null), /0\/7/);
  assert.match(pingReport(undefined), /0\/7/);
});
