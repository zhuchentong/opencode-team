// M16-r29：阶段纪律——产物错位告警（纯函数）+ guidance 纪律文案锚
// 背景：真机 auth-login(r28) leader 把 reviewer/tester 提前塞进 planning，产物重复写浪费工时。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_PHASE, artifactPhaseWarning, guidance } from "../server/lib.ts";

const mkSt = (phase, extra = {}) => ({
  sessionID: "ses_pd", slug: "demo", phase,
  rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
  lanes: {}, artifacts: {}, ...extra,
});

test("ARTIFACT_PHASE：六类产物期望阶段映射齐全", () => {
  assert.deepEqual(ARTIFACT_PHASE, {
    plan: "planning", "plan-review": "review", "test-plan": "review",
    "build-review": "build_review", "test-report": "testing", lessons: "done",
  });
});

test("artifactPhaseWarning：错位才告警，归位/未知/无阶段不告警", () => {
  // 错位（提前委派）→ 告警
  assert.match(artifactPhaseWarning("plan-review", "planning"), /产物阶段错位.*plan-review.*review.*planning/);
  assert.match(artifactPhaseWarning("test-plan", "intake"), /产物阶段错位/);
  assert.match(artifactPhaseWarning("plan", "intake"), /产物阶段错位/);
  // 归位 → null
  assert.equal(artifactPhaseWarning("test-plan", "review"), null);
  assert.equal(artifactPhaseWarning("plan-review", "review"), null);
  assert.equal(artifactPhaseWarning("test-report", "testing"), null);
  assert.equal(artifactPhaseWarning("plan", "planning"), null);
  assert.equal(artifactPhaseWarning("lessons", "done"), null);
  // 未知 kind / 无阶段 → null（不阻断）
  assert.equal(artifactPhaseWarning("bogus", "planning"), null);
  assert.equal(artifactPhaseWarning("plan-review", null), null);
  assert.equal(artifactPhaseWarning("plan-review", undefined), null);
});

test("guidance：planning/intake 含阶段纪律（禁止提前委派）", () => {
  const p = guidance("planning", mkSt("planning"));
  assert.match(p, /阶段纪律/);
  assert.match(p, /只委派 wf\/planner/);
  assert.match(p, /禁止提前委派/);
  const i = guidance("intake", mkSt("intake"));
  assert.match(i, /阶段纪律/);
  assert.match(i, /勿委派任何 wf 角色/);
  assert.match(i, /!intake 重置/);
});

test("guidance：review 阶段纪律文案不误伤（reviewer/tester 本就属 review）", () => {
  const rv = guidance("review", mkSt("review", { rounds: { plan_review: 1, build_review: 0, test_fix: 0 } }));
  assert.match(rv, /wf\/planner-reviewer/);
  assert.match(rv, /wf\/tester\(mode=feasibility/);
  assert.ok(!/禁止提前委派/.test(rv), "review 阶段不应出现 planning 的提前委派禁令");
});