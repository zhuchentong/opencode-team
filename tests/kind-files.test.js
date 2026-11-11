// P0-b：产物 kind → 文件名测试（M14 off-by-one 回归锚点：进入即计数语义下轮次即编号）
import { test } from "node:test";
import assert from "node:assert/strict";
import { KIND_FILES } from "../server/lib.ts";

test("非循环产物固定文件名", () => {
  assert.equal(KIND_FILES.plan({}), "plan.md");
  assert.equal(KIND_FILES["test-plan"]({}), "test-plan.md");
  assert.equal(KIND_FILES["test-report"]({}), "test-report.md");
  assert.equal(KIND_FILES.lessons({}), "lessons.md");
});

test("循环产物按当前轮次编号（M14 off-by-one 回归：首轮 r1 而非 r2）", () => {
  assert.equal(KIND_FILES["plan-review"]({ rounds: { plan_review: 1 } }), "plan-review-r1.md");
  assert.equal(KIND_FILES["plan-review"]({ rounds: { plan_review: 2 } }), "plan-review-r2.md");
  assert.equal(KIND_FILES["build-review"]({ rounds: { build_review: 1 } }), "build-review-r1.md");
  assert.equal(KIND_FILES["build-review"]({ rounds: { build_review: 3 } }), "build-review-r3.md");
});

test("rounds 缺失时回退 r1（不产生 r0/rNaN）", () => {
  assert.equal(KIND_FILES["plan-review"]({}), "plan-review-r1.md");
  assert.equal(KIND_FILES["plan-review"]({ rounds: {} }), "plan-review-r1.md");
  assert.equal(KIND_FILES["build-review"]({ rounds: null }), "build-review-r1.md");
});

test("kind 键集与产物命名守卫", () => {
  assert.deepEqual(Object.keys(KIND_FILES).toSorted(),
    ["build-review", "lessons", "plan", "plan-review", "test-plan", "test-report"]);
});
