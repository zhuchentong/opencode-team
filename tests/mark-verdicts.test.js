// opt-agentic 项①：markVerdicts 记账单点——artifact-tool mark 与 gate-reconcile 补记共用
// domain/artifact.markVerdicts 后，两路径对同一产物内容的记账必须相等（消除旧 gate-reconcile
// 本地 /lane 分组表/ 区分大小写正则的口径分叉：大写「Lane 分组表」经对账补记曾被误记 false，
// daily-build 关卡在补记后仍拒绝——对账功能在该输入下失效）。
// 锚四件事：
// ① 单元：markVerdicts 按 kind 写 verdicts（testPlanWritten/testReport/planReview/laneTableWritten）；
// ② clearOnPlan 语义：true 清 planReview/testPlanWritten/confirmedAt 后写 lane 表；false（gate 补记）不清；
// ③ 路径等价：大写「Lane 分组表」经 artifact-tool register 与经 reconcileGateArtifacts 补记
//    两条真实路径产出 laneTableWritten === true 相等；
// ④ gate-reconcile 对已记账产物仍 continue（首记语义不漂移；漂移重记属项④范围，本文件不锚）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { markVerdicts, parseVerdict } from "../server/lib.ts";
import { reconcileGateArtifacts } from "../server/gate-reconcile.ts";
import { mkWiringHarness } from "./helpers/wiring.js";

const mkSt = () => ({
  sessionID: "ses_mv1", slug: "mv", phase: "review", mode: "daily",
  rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
  artifacts: {}, verdicts: {}, log: [],
});

const AT = "2026-01-01T00:00:00.000Z";

test("项① markVerdicts 单元：按 kind 写 verdicts，lane 表大小写归一", () => {
  const st = mkSt();
  markVerdicts(st, "plan.md", "plan", "# 计划\n\n## Lane 分组表\n\n| lane | areas |\n", 42, "h1", AT);
  assert.equal(st.artifacts["plan.md"].bytes, 42);
  assert.equal(st.artifacts["plan.md"].hash, "h1");
  assert.equal(st.verdicts.laneTableWritten, true, "大写 Lane 分组表 → true（r55 修复 1 口径）");
  assert.equal("planReview" in st.verdicts, false, "非清账模式不动 review 记账");

  const st2 = mkSt();
  markVerdicts(st2, "test-report.md", "test-report", "**结论**: PASS\n", 10, "h2", AT);
  assert.equal(st2.verdicts.testReport, "PASS");
  const st3 = mkSt();
  markVerdicts(st3, "test-plan.md", "test-plan", "红测试清单\n", 10, "h3", AT);
  assert.equal(st3.verdicts.testPlanWritten, true);
  const st4 = mkSt();
  markVerdicts(st4, "plan-review-r1.md", "plan-review", "**结论**: FAIL\n", 10, "h4", AT);
  assert.equal(st4.verdicts.planReview, parseVerdict("**结论**: FAIL\n"));
});

test("项① markVerdicts clearOnPlan：true 清双通道+确认，false（gate 补记）保留", () => {
  const st = mkSt();
  st.verdicts = { planReview: "PASS", testPlanWritten: true, confirmedAt: AT };
  markVerdicts(st, "plan.md", "plan", "# 修订版\n", 10, "h5", AT, { clearOnPlan: true });
  assert.equal(st.verdicts.planReview, undefined, "修订清 review 结论");
  assert.equal(st.verdicts.testPlanWritten, undefined, "修订清双通道");
  assert.equal(st.verdicts.confirmedAt, undefined, "修订清方案确认（M16-r44）");
  assert.equal(st.verdicts.laneTableWritten, false, "无 lane 表节 → false（覆写非残留）");

  const st2 = mkSt();
  st2.verdicts = { planReview: "PASS" };
  markVerdicts(st2, "plan.md", "plan", "# 首记\n", 10, "h6", AT);
  assert.equal(st2.verdicts.planReview, "PASS", "gate 补记不清账（clearOnPlan 缺省 false）");
});

test("项① 路径等价：大写「Lane 分组表」经 gate 对账补记 → laneTableWritten=true（旧分叉复现锚）", async () => {
  // 旧口径 /lane 分组表/ 对大写标题误记 false → wf:build 补记后仍拒绝；现经 markVerdicts 单点应放行
  const dir = fs.mkdtempSync("/tmp/opencode/wf-mv-");
  fs.mkdirSync(`${dir}/.workflow/mv-lane`, { recursive: true });
  fs.writeFileSync(`${dir}/.workflow/mv-lane/plan.md`, "# 计划\n\n## Lane 分组表\n\n| lane | areas |\n|---|---|\n| T01 | src/a |\n\n```lane-deps\nnodes:\n| T | wave | lane |\n|---|---|---|\n| T01 | 0 | lane-0 |\nedges:\n| 消费方 | 提供方 | 符号 | kind |\n|---|---|---|\n```\n\n```probe-matrix\n| T | probe_files | cross_file_import | tsconfig_notes |\n|---|---|---|---|\n| T01 | 1 | no | - |\n```\n"); // 效率批 P1：盘上 plan 须含合法机器区（对账补记自 derive laneDepsOk） // W11-v2.1：+矩阵区（自 derive probeMatrixOk）
  fs.writeFileSync(`${dir}/.workflow/mv-lane/plan-review-r1.md`, "**结论**: PASS\n\n五维过。\n");
  const h = await mkWiringHarness({ sessionID: "ses_mv2", dir });
  await h.run("wf:intake", "mv-lane");
  await h.run("wf:plan");
  await h.run("wf:review");
  h.patch({ planConfirmedAt: new Date().toISOString() }); // 确认记账测试直 patch（文件面交给 reconcile）
  const out = await h.run("wf:build");
  assert.ok(!out.startsWith("❌"), `大写 Lane 表应经对账放行：${out.slice(0, 120)}`);
  const st = h.st();
  assert.equal(st.phase, "building");
  assert.equal(st.verdicts?.laneTableWritten, true, "补记口径与 artifact-tool register 等价");
});

test("项① gate-reconcile 对已记账产物 continue（首记语义，不重复补记）", () => {
  const dir = fs.mkdtempSync("/tmp/opencode/wf-mv2-");
  fs.mkdirSync(`${dir}/.workflow/mv-rec`, { recursive: true });
  fs.writeFileSync(`${dir}/.workflow/mv-rec/test-report.md`, "**结论**: PASS\n");
  const st = mkSt();
  st.slug = "mv-rec";
  st.artifacts["test-report.md"] = { at: AT, bytes: 999, hash: "stale" }; // 已记账（含陈旧 hash）
  const fixed = reconcileGateArtifacts(st, "wf:done", dir, AT);
  assert.equal(fixed, false, "已记账不补（漂移重记属项④范围）");
  assert.equal(st.artifacts["test-report.md"].bytes, 999, "原记账未被覆写");
});
