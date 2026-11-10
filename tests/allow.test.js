// P0-b：越权放行判定测试（marker 双形态 + 测试文件正则 + 反斜杠路径）
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ALLOW_MARKERS, DEFAULT_ALLOW_RES, makeAllowChecker } from "../server/lib.ts";

const isAllowed = makeAllowChecker(DEFAULT_ALLOW_MARKERS, DEFAULT_ALLOW_RES);

test("放行：.workflow / .learnings / 测试目录（绝对路径）", () => {
  assert.equal(isAllowed("/proj/.workflow/demo/plan.md"), true);
  assert.equal(isAllowed("/proj/.learnings/foo.md"), true);
  assert.equal(isAllowed("/proj/tests/unit/a.js"), true);
  assert.equal(isAllowed("/proj/test/x.js"), true);
  assert.equal(isAllowed("/proj/__tests__/y.js"), true);
});

test("放行：相对路径（marker 无前导斜杠变体比对）", () => {
  assert.equal(isAllowed(".workflow/demo/plan.md"), true);
  assert.equal(isAllowed(".learnings/foo.md"), true);
  assert.equal(isAllowed("tests/unit/a.js"), true);
});

test("放行：*.test.* / *.spec.* / test_*.{py,go} 正则", () => {
  assert.equal(isAllowed("/proj/src/a.test.js"), true);
  assert.equal(isAllowed("/proj/src/a.spec.ts"), true);
  assert.equal(isAllowed("/proj/src/a.spec.mjs"), true);
  assert.equal(isAllowed("/proj/src/a.test.cjs"), true);
  assert.equal(isAllowed("/proj/tests/test_something.py"), true);
  assert.equal(isAllowed("/pkg/test_helper.go"), true);
});

test("放行：反斜杠（Windows 风格）路径归一化", () => {
  assert.equal(isAllowed("C:\\proj\\.workflow\\demo\\plan.md"), true);
  assert.equal(isAllowed("C:\\proj\\src\\a.test.js"), true);
});

test("拒绝：业务代码文件", () => {
  assert.equal(isAllowed("/proj/src/index.js"), false);
  assert.equal(isAllowed("/proj/src/app.tsx"), false);
  assert.equal(isAllowed("src/lib.rs"), false);
  assert.equal(isAllowed("/proj/README.md"), false);
});

test("拒绝：仅目录名碰巧含子串的文件不算放行（marker 需完整出现在路径中）", () => {
  // ".workflow" 子串命中 "/.workflow/" 无斜杠变体 ".workflow/" 的情况：
  // "/proj/.workflowX/a.md" 不含 ".workflow/" → 拒绝
  assert.equal(isAllowed("/proj/.workflowX/a.md"), false);
});

test("拒绝：null/undefined/空串", () => {
  assert.equal(isAllowed(null), false);
  assert.equal(isAllowed(undefined), false);
  assert.equal(isAllowed(""), false);
});

test("自定义 marker/regex 合并生效", () => {
  const check = makeAllowChecker(["/.gen/"], [/\.generated\./]);
  assert.equal(check("/proj/.gen/a.md"), true);
  assert.equal(check("/proj/x.generated.ts"), true);
  assert.equal(check("/proj/src/a.js"), false);
});
