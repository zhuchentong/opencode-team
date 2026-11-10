// P0-b：test-report「**结论**」解析测试（宽松值匹配 + 严格行首格式探测）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, hasStrictVerdictLine } from "../server/lib.js";

test("PASS / FAIL 正常解析", () => {
  assert.equal(parseVerdict("**结论**: PASS\n\n其余内容"), "PASS");
  assert.equal(parseVerdict("**结论**: FAIL"), "FAIL");
});

test("中文冒号与多余空白", () => {
  assert.equal(parseVerdict("**结论**：PASS"), "PASS");
  assert.equal(parseVerdict("  **结论**:   PASS"), "PASS");
  assert.equal(parseVerdict("\n**结论**:PASS"), "PASS");
});

test("非首行（多行内容中）也能解析（/m 标志，锁定现状）", () => {
  assert.equal(parseVerdict("前言\n## 结论\n**结论**: PASS\n"), "PASS");
});

test("缺失/格式不符 → UNKNOWN", () => {
  assert.equal(parseVerdict("结论 PASS（无星号格式）"), "UNKNOWN");
  assert.equal(parseVerdict("**结论**: pass"), "PASS", "正则带 i 标志，小写也解析（锁定现状）");
  assert.equal(parseVerdict("**结论**: PASSED（\\b 边界不成立）"), "UNKNOWN");
  assert.equal(parseVerdict("**结论**: UNKNOWN"), "UNKNOWN");
  assert.equal(parseVerdict(""), "UNKNOWN");
  assert.equal(parseVerdict(null), "UNKNOWN");
  assert.equal(parseVerdict(undefined), "UNKNOWN");
});

test("hasStrictVerdictLine：严格行首格式（警告文案条件）", () => {
  assert.equal(hasStrictVerdictLine("**结论**: PASS"), true);
  assert.equal(hasStrictVerdictLine("**结论**：FAIL"), true);
  assert.equal(hasStrictVerdictLine("  **结论**: PASS"), false, "行首空格不满足严格格式（触发警告）");
  assert.equal(hasStrictVerdictLine("xx\n**结论**: PASS"), true, "/m 多行行首");
  assert.equal(hasStrictVerdictLine("结论: PASS"), false);
});
