// M16-r32：产物瘦身预算——体积/结构约束压生成与下游审核耗时
// 背景（auth-login 真机）：plan.md 40KB 生成 ~6.6min，耗时与体积成正比；wf_write_artifact 本身毫秒级。
// 机制：ARTIFACT_BUDGET_KB 软预算 + 超预算告警（不阻断，落盘/记账照常），与 r29 阶段告警同模式。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTIFACT_BUDGET_KB, artifactSizeWarning, KIND_FILES } from "../server/lib.ts";

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