// M16-r32：产物瘦身预算——体积/结构约束压生成与下游审核耗时
// 背景（auth-login 真机）：plan.md 40KB 生成 ~6.6min，耗时与体积成正比；wf_write_artifact 本身毫秒级。
// 机制：ARTIFACT_BUDGET_KB 软预算 + 超预算告警（不阻断，落盘/记账照常），与 r29 阶段告警同模式。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_BUDGET_KB, ARTIFACT_BUDGET_S_KB, ARTIFACT_BUDGET_L_KB, tierOf, budgetFor, artifactSizeWarning, KIND_FILES } from "../server/lib.ts";
import { guidance } from "../server/guidance.ts"; // M16-r39 T08：guidance 拆分

test("ARTIFACT_BUDGET_KB：六类产物预算齐全且为正数", () => {
  assert.deepEqual(Object.keys(ARTIFACT_BUDGET_KB).toSorted(), Object.keys(KIND_FILES).toSorted());
  for (const [k, v] of Object.entries(ARTIFACT_BUDGET_KB)) assert.ok(v > 0, `${k} 预算应为正`);
  // 真机数据锚：build-review 16KB→8KB（防预算被无意放宽）；plan 15→20（M16-r50 分级放宽）
  assert.equal(ARTIFACT_BUDGET_KB.plan, 20);
  assert.equal(ARTIFACT_BUDGET_KB["build-review"], 8);
});

test("artifactSizeWarning：超预算告警；预算内/未知 kind 不告警", () => {
  // 超预算（M 级 plan 20KB）
  const w = artifactSizeWarning("plan", 21 * 1024);
  assert.ok(w, "超预算应告警");
  assert.match(w, /超瘦身预算/);
  assert.match(w, /plan/);
  // 恰好等于预算 → 不告警（边界）
  assert.equal(artifactSizeWarning("plan", 20 * 1024), null);
  // 预算内
  assert.equal(artifactSizeWarning("plan", 1024), null);
  // 未知 kind → 不告警
  assert.equal(artifactSizeWarning("unknown-kind", 999 * 1024), null);
});

// ── M16-r33 P2：体量分级预算（S 收紧 / M 基线 / L 放宽 plan；单位=字节）────────────
// M16-r50：plan 分级 S10/M20/L30KB，L 独立预算表（其余产物沿用 M 值）
test("M16-r33/r50 分级预算：三表六类齐全；S 严于 M、M 严于 L(plan)；budgetFor 按级取值", () => {
  for (const table of [ARTIFACT_BUDGET_S_KB, ARTIFACT_BUDGET_L_KB]) {
    assert.deepEqual(Object.keys(table).toSorted(), Object.keys(KIND_FILES).toSorted());
  }
  for (const k of Object.keys(KIND_FILES)) {
    assert.ok(ARTIFACT_BUDGET_S_KB[k] > 0, `${k} S 预算应为正`);
    assert.ok(ARTIFACT_BUDGET_S_KB[k] < ARTIFACT_BUDGET_KB[k], `${k} S 预算应严于 M`);
    assert.ok(ARTIFACT_BUDGET_L_KB[k] >= ARTIFACT_BUDGET_KB[k], `${k} L 预算应不低于 M`);
  }
  // 真机数据锚：todolist 简易任务 plan 26KB/test-plan 22KB 杀鸡用牛刀 → S 级收紧
  assert.equal(ARTIFACT_BUDGET_S_KB.plan, 10);
  assert.equal(ARTIFACT_BUDGET_S_KB["test-plan"], 3);
  // M16-r50 锚点：plan S10 / M20 / L30
  assert.equal(ARTIFACT_BUDGET_KB.plan, 20);
  assert.equal(ARTIFACT_BUDGET_L_KB.plan, 30);
  assert.equal(budgetFor("plan", "S"), 10);
  assert.equal(budgetFor("plan", "M"), 20);
  assert.equal(budgetFor("plan", "L"), 30, "L 级 plan 独立预算");
  assert.equal(budgetFor("test-plan", "L"), 10, "L 级其余产物沿用 M 值");
  assert.equal(budgetFor("plan", undefined), 20, "缺省=M（存量兼容）");
  assert.equal(budgetFor("unknown-kind", "S"), null);
  // tierOf 归一：只认 S/L，其余按 M
  assert.equal(tierOf("S"), "S");
  assert.equal(tierOf("L"), "L");
  assert.equal(tierOf("M"), "M");
  assert.equal(tierOf(undefined), "M", "存量无 size → M");
});

test("M16-r33 分级告警：artifactSizeWarning 按 tier 判定；告警文案带 patch 删减指引", () => {
  // S 级 plan 预算 10KB：11KB 告警、10KB 边界不告警
  assert.ok(artifactSizeWarning("plan", 11 * 1024, "S"), "S 级 11KB 应告警");
  assert.equal(artifactSizeWarning("plan", 10 * 1024, "S"), null, "S 级边界不告警");
  // 同体积 M 级不告警（20KB 预算）
  assert.equal(artifactSizeWarning("plan", 11 * 1024, "M"), null);
  assert.equal(artifactSizeWarning("plan", 11 * 1024), null, "缺省 tier=M");
  // M16-r50：L 级 plan 预算 30KB——21KB 不告警、31KB 告警且文案带 L 级、30KB 边界不告警
  assert.equal(artifactSizeWarning("plan", 21 * 1024, "L"), null, "L 级 21KB 在 30KB 预算内");
  assert.equal(artifactSizeWarning("plan", 30 * 1024, "L"), null, "L 级边界不告警");
  const wl = artifactSizeWarning("plan", 31 * 1024, "L");
  assert.ok(wl, "L 级 31KB 应告警");
  assert.match(wl, /L 级/, "告警文案应标 L 级");
  // 告警文案：字节口径 + patch 删减指引（让瘦身也便宜）
  const w = artifactSizeWarning("plan", 21 * 1024, "M");
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
  assert.match(plan, /plan≤20KB|plan ≤20KB|20KB/, "planning 应渲染 M 级 plan 预算");
  // review：双通道预算（plan-review + test-plan）
  const rev = guidance("review", stM);
  assert.match(rev, /8KB/, "review 应含 plan-review 预算");
  assert.match(rev, /10KB/, "review 应含 test-plan 预算");
  // S 级：收紧预算 + 从简指引
  const planS = guidance("planning", stS);
  assert.match(planS, /10KB/, "S 级 planning 应渲染 plan≤10KB");
  assert.match(planS, /从简|聚焦关键风险/, "S 级应有从简指引");
  // M16-r50 L 级：plan≤30KB 且档位标注为 L
  const planL = guidance("planning", { ...stM, size: "L" });
  assert.match(planL, /plan≤30KB|30KB/, "L 级 planning 应渲染 plan≤30KB");
  assert.match(planL, /产物预算（L 级/, "L 级预算行应标 L 级");
  // intake：体量分级指引
  const intake = guidance("intake", stM);
  assert.match(intake, /\[S\]\/\[M\]\/\[L\]/, "intake 应含体量声明语法");
});