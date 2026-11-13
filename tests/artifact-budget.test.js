// M16-r32：产物瘦身预算——体积/结构约束压生成与下游审核耗时
// 背景（auth-login 真机）：plan.md 40KB 生成 ~6.6min，耗时与体积成正比；wf_write_artifact 本身毫秒级。
// 机制：ARTIFACT_BUDGET_KB 软预算 + 超预算告警（不阻断，落盘/记账照常），与 r29 阶段告警同模式。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_BUDGET_KB, ARTIFACT_BUDGET_S_KB, budgetFor, artifactSizeWarning, KIND_FILES } from "../server/lib.ts";
import { guidance } from "../server/guidance.ts"; // M16-r39 T08：guidance 拆分

test("ARTIFACT_BUDGET_KB：六类产物预算齐全且为正数", () => {
  assert.deepEqual(Object.keys(ARTIFACT_BUDGET_KB).toSorted(), Object.keys(KIND_FILES).toSorted());
  for (const [k, v] of Object.entries(ARTIFACT_BUDGET_KB)) assert.ok(v > 0, `${k} 预算应为正`);
  // 真机数据锚：plan 40KB→15KB、build-review 16KB→8KB（防预算被无意放宽）
  assert.equal(ARTIFACT_BUDGET_KB.plan, 15);
  assert.equal(ARTIFACT_BUDGET_KB["build-review"], 8);
});

test("artifactSizeWarning：超预算告警；预算内/未知 kind 不告警", () => {
  // 超预算（plan 15KB）
  const w = artifactSizeWarning("plan", 16 * 1024);
  assert.ok(w, "超预算应告警");
  assert.match(w, /超瘦身预算/);
  assert.match(w, /plan/);
  // 恰好等于预算 → 不告警（边界）
  assert.equal(artifactSizeWarning("plan", 15 * 1024), null);
  // 预算内
  assert.equal(artifactSizeWarning("plan", 1024), null);
  // 未知 kind → 不告警
  assert.equal(artifactSizeWarning("unknown-kind", 999 * 1024), null);
});

// ── M16-r33 P2：体量分级预算（S 收紧 / M 基线 / L 用 M；单位=字节）────────────
test("M16-r33 分级预算：S 级六类齐全且严于 M；budgetFor 按级取值（L/缺省=M）", () => {
  assert.deepEqual(Object.keys(ARTIFACT_BUDGET_S_KB).toSorted(), Object.keys(KIND_FILES).toSorted());
  for (const k of Object.keys(KIND_FILES)) {
    assert.ok(ARTIFACT_BUDGET_S_KB[k] > 0, `${k} S 预算应为正`);
    assert.ok(ARTIFACT_BUDGET_S_KB[k] < ARTIFACT_BUDGET_KB[k], `${k} S 预算应严于 M`);
  }
  // 真机数据锚：todolist 简易任务 plan 26KB/test-plan 22KB 杀鸡用牛刀 → S 级收紧
  assert.equal(ARTIFACT_BUDGET_S_KB.plan, 10);
  assert.equal(ARTIFACT_BUDGET_S_KB["test-plan"], 3);
  assert.equal(budgetFor("plan", "S"), 10);
  assert.equal(budgetFor("plan", "M"), 15);
  assert.equal(budgetFor("plan", "L"), 15, "L 用 M 预算");
  assert.equal(budgetFor("plan", undefined), 15, "缺省=M（存量兼容）");
  assert.equal(budgetFor("unknown-kind", "S"), null);
});

test("M16-r33 分级告警：artifactSizeWarning 按 tier 判定；告警文案带 patch 删减指引", () => {
  // S 级 plan 预算 10KB：11KB 告警、10KB 边界不告警
  assert.ok(artifactSizeWarning("plan", 11 * 1024, "S"), "S 级 11KB 应告警");
  assert.equal(artifactSizeWarning("plan", 10 * 1024, "S"), null, "S 级边界不告警");
  // 同体积 M 级不告警（15KB 预算）
  assert.equal(artifactSizeWarning("plan", 11 * 1024, "M"), null);
  assert.equal(artifactSizeWarning("plan", 11 * 1024), null, "缺省 tier=M");
  // 告警文案：字节口径 + patch 删减指引（让瘦身也便宜）
  const w = artifactSizeWarning("plan", 20 * 1024, "M");
  assert.match(w, /超瘦身预算/);
  assert.match(w, /patch/, "超预算应指引用 patch 删减而非全量重写");
});

test("M16-r33 guidance：写入者契约（子代理自写/leader 禁代写）+ 双通道预算 + intake 体量指引", () => {
  const stM = { slug: "g", rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, size: "M" };
  const stS = { ...stM, size: "S" };
  // planning：写入者契约 + 预算数字（leader 自看通道）
  const plan = guidance("planning", stM);
  assert.match(plan, /子代理自行|自行调用 wf_write_artifact/, "planning 应要求子代理自写产物");
  assert.match(plan, /leader 禁止代写|勿代写|禁止代写/, "planning 应禁止 leader 代写（双倍生成）");
  assert.match(plan, /plan≤15KB|plan ≤15KB|15KB/, "planning 应渲染 M 级 plan 预算");
  // review：双通道预算（plan-review + test-plan）
  const rev = guidance("review", stM);
  assert.match(rev, /8KB/, "review 应含 plan-review 预算");
  assert.match(rev, /10KB/, "review 应含 test-plan 预算");
  // S 级：收紧预算 + 从简指引
  const planS = guidance("planning", stS);
  assert.match(planS, /10KB/, "S 级 planning 应渲染 plan≤10KB");
  assert.match(planS, /从简|聚焦关键风险/, "S 级应有从简指引");
  // intake：体量分级指引
  const intake = guidance("intake", stM);
  assert.match(intake, /\[S\]\/\[M\]\/\[L\]/, "intake 应含体量声明语法");
});