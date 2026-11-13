// wf-workflow — R2 T2.3（arch-r2-profile-statemachine）：关卡拒绝文案单一来源（自 domain/flow.ts 逐字节迁出）。
// 零依赖纯文案/模板函数：shared 下层，domain 与编排层均可 import（domain-acyclic 合法）。
// 纪律：文案字节级不变=行为锚（tests/flows.test.js /tmp「拒绝文案指路」、daily-mode/plan-confirm 断言、
// brief-level REJECT_PREFIX ❌/【互斥不变量依赖首字符 ❌）。

// M16-r44：方案确认关卡拒绝文案（full/daily 共用；blocked-append 指路契约）
export const CONFIRM_GATE_MSG =
  "❌ 方案确认关卡未过：尚未观测到方案确认交互。请先用宿主 question 工具向用户呈现方案摘要" +
  "（选项标签固定：批准执行/修改方案/终止任务），待用户批准后再推进 /wf:build（wf_command 或用户手敲；" +
  "确认以 question 交互为准，手敲 /wf:build 同样须先经确认）。";

// M16-r28：双通道关卡（wf:test-design 入口；原 assign 阶段并入，语义不变）
export const GATE_DUAL_CHANNEL_MSG =
  "❌ 双通道关卡未过：tester(feasibility) 尚未产出 test-plan.md。请回到 review 阶段委派 wf/tester(mode=feasibility)，" +
  "用 wf_write_artifact(kind=test-plan) 写入后，再推进 /wf:test-design（leader 调用 wf_command(name=\"wf:test-design\")，" +
  "用户手敲亦可）。若 test-plan.md 已由子代理原生 write/edit 落盘未记账，直接 wf_write_artifact(kind=test-plan)（不带 content=注册）补记账即可。";

// wf:done 验收关卡文案模板（testReportVerdict 非 PASS；daily 复用）
export const gateAcceptanceMsg = (verdict?: string): string =>
  `❌ 验收关卡未过：test-report.md 结论为「${verdict ?? "未产出"}」（要求 PASS）。` +
  `FAIL → 推进 /wf:fix 修复后重跑 /wf:test（wf_command 或用户手敲）；由 wf/tester 用 wf_write_artifact(kind=test-report) 更新报告（首行 **结论**: PASS）；报告若已原生落盘未记账，wf_write_artifact(kind=test-report)（不带 content=注册）补记账。`;

// daily M/L 独立验证关卡文案模板（planReviewVerdict 非 PASS）
export const gateDailyVerifyMsg = (verdict?: string): string =>
  `❌ 验证关卡未过：plan-review 结论为「${verdict ?? "未产出"}」（要求 PASS）。` +
  `请委派 wf/planner-reviewer 独立五维验证 plan.md，用 wf_write_artifact(kind=plan-review) 写入（首行 **结论**: PASS|FAIL）；报告若已原生落盘未记账，wf_write_artifact(kind=plan-review)（不带 content=注册）补记账；FAIL → wf:plan 带意见修订后再验。`;
