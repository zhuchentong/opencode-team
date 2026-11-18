// W14：扩展逃生门条款写时预检（server/domain/plan-escape.ts）。
// 背景=test_57 F1 同族二现（test_54 ambient 死锁返修 8.2min → test_57 149s），planner.md L9 提示词层
// 带前案教训仍失效 = 措辞路线证伪，结构强制。评审 v1 F-1 取证：裸「写集」标记在真实 M 级语料假阳率
// 2/3（test_53/test_56 合法 plan 天然含写集列、零条款）——故信号源=tierOf!=="S" 统一门（与 R-P1 同款）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPlanEscape } from "../server/lib.ts";

const CLAUSE = "\n下游 T 点可对共享声明文件做追加式扩展（只增不改不删），并在回执记录扩展行。\n";

test("pe-M 缺条款 → violations 含修复例句", () => {
  const r = checkPlanEscape("# plan\n§3 冻结写集：T01 src/walker.ts + types/ambient.d.ts\n", "M");
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0], /追加式扩展/);
  assert.match(r.violations[0], /只增不改不删/);
});

test("pe-M 四种条款措辞变体均命中（在场即过；语义由评审 Q7 抽查兜底）", () => {
  for (const marker of ["追加式扩展", "逃生门", "合法修复路径", "扩展条款"]) {
    const r = checkPlanEscape(`# plan\n总则：本计划给出${marker}安排。\n`, "M");
    assert.equal(r.ok, true, `marker=${marker} 应命中`);
  }
});

test("pe-S 豁免：无条款直接 ok", () => {
  assert.equal(checkPlanEscape("# plan 从简\n", "S").ok, true);
});

test("pe-tier 缺省按 M（与 checkLaneDeps/checkProbeMatrix 语义一致）", () => {
  assert.equal(checkPlanEscape("# plan 无条款\n", null).ok, false);
  assert.equal(checkPlanEscape("# plan 无条款\n", undefined).ok, false);
});

test("pe-never throw：非字符串入参视为 miss，不抛出", () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    const r = checkPlanEscape(bad, "M");
    assert.equal(typeof r.ok, "boolean");
    assert.equal(r.ok, false, "非字符串=miss（宁可多拦教育，不可漏放）");
  }
});

test("pe-真实语料蒸馏回归案：lane 分组表含写集互斥表头+无条款→M violation；加条款→ok（锁裸标记假阳回潮）", () => {
  // 蒸馏自 test_53/test_56 合法 plan 形态（评审 v1 F-1 取证：写集 9/7 处、条款 0、均为合法 r1 PASS 面）
  const corpusLike = "# 计划\n\n## lane 分组表\n\n| T | 写集 | 验收 |\n|---|---|---|\n| T01 | src/a.ts | tsc 零错 |\n| T02 | src/b.ts（写集互斥） | e2e |\n\n```lane-deps\nnodes:\n| T | wave | lane |\n|---|---|---|\n| T01 | 0 | lane-0 |\nedges:\n| 消费方 | 提供方 | 符号 | kind |\n|---|---|---|\n```\n\n```probe-matrix\n| T | probe_files | cross_file_import | tsconfig_notes |\n|---|---|---|---|\n| T01 | 1 | no | - |\n```\n";
  // 条款缺失 → violation（tier 门执法，与「写集」词频无关）
  assert.equal(checkPlanEscape(corpusLike, "M").ok, false);
  // 补一句条款 → 过（证明探测器不是裸 /写集/ 拒绝循环：F-1 必改锁）
  assert.equal(checkPlanEscape(corpusLike + CLAUSE, "M").ok, true);
});

test("pe-test_57 修订后真实文本回放：r2 条款形态命中", () => {
  // 蒸馏自 test_57 plan r2 修订落盘句（F1 建议 A 采纳原文）
  const t57 = "§3 总则：下游 T 点可对 types/ambient.d.ts 做追加式扩展（只增不改不删），扩展行记入回执。";
  assert.equal(checkPlanEscape(t57, "M").ok, true);
});
