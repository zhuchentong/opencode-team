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
  `请委派 wf/planner-reviewer 独立六维验证 plan.md，用 wf_write_artifact(kind=plan-review) 写入（首行 **结论**: PASS|FAIL）；报告若已原生落盘未记账，wf_write_artifact(kind=plan-review)（不带 content=注册）补记账；FAIL → wf:plan 带意见修订后再验。`;

// v2：lane 分组表关卡拒绝文案（daily M/L；并行优先——串行须以 lane 表书面举证）
export const LANE_TABLE_GATE_MSG =
  "❌ lane 分组表关卡未过：M/L 级 plan.md 须含「lane 分组表」节（并行优先裁决：≥2 条互斥 lane 即并行；" +
  "判单 lane 串行须附交叠证据）。请 wf_command(name=\"wf:plan\") 修订补表后再推进 /wf:build（若 plan.md 已原生补写落盘，" +
  "wf_write_artifact(kind=plan)（不带 content=注册）补记账即可）。";

// 效率批 P1（test_51 F1/F6 复盘）：lane 依赖边表关卡拒绝文案（daily+full 共用，M/L 级）
export const LANE_DEPS_GATE_MSG =
  "❌ lane 依赖边表关卡未过：M/L 级 plan.md 须含合法 ```lane-deps 机器区（nodes 表 | T | wave | lane | +" +
  " edges 表 | 消费方 | 提供方 | 符号 | kind |）。硬规则：跨 lane 边的提供方 wave 必须小于消费方 wave" +
  "（kind=value|type 同规——worktree 里类型 import 同样编译失败）、无环、声明 wave ≥ 拓扑层深；" +
  "被并行 lane 消费的符号必须下沉更早 wave。请 wf_command(name=\"wf:plan\") 修订（机器区仅许边级改写）后再推进 /wf:build" +
  "（violations 逐条清单见 wf_write_artifact 回显；已原生补写落盘则 wf_write_artifact(kind=plan)（不带 content=注册）补记账）。";

// W11-v2.1（test_54/56 探针盲区家族复盘）：probe-matrix 机器区关卡拒绝文案（daily+full 共用，M/L 级）
export const PROBE_MATRIX_GATE_MSG =
  "❌ probe-matrix 关卡未过：M/L 级 plan.md 须含合法 ```probe-matrix 机器区（每 T 一行" +
  " | T | probe_files | cross_file_import | tsconfig_notes |，与 lane-deps nodes 双射）。硬规则：" +
  "lane-deps 存在 type 边 ⇒ 至少一行 cross_file_import=yes ∧ probe_files≥2（多文件探针按冻结 tsconfig 实跑，" +
  "配置不兼容在规划期自曝，如 TS5097）；cross_file_import=yes ⇒ probe_files≥2 ∧ tsconfig_notes 非空。" +
  "请 wf_command(name=\"wf:plan\") 修订机器区后重新注册（violations 逐条清单见 wf_write_artifact 回显；" +
  "已原生补写落盘则 wf_write_artifact(kind=plan)（不带 content=注册）补记账）。";

// 效率批 P2（learn 前置移交）：done 验收关卡——lessons 缺失分支文案（learn 已移交 leader 内联）
export const DONE_LESSONS_GATE_MSG =
  "❌ 经验沉淀关卡未过：lessons.md 未产出。learn 已移交 leader 内联自写（无需委派 wf/learner）：" +
  "请 leader 用 wf_write_artifact(kind=lessons) 落盘四节模板（新增/更新/退役/晋升候选）+ 流程效率观察节" +
  "（r1 首过率/并行有效度/流程墙∥进程墙/返修根因，自 events 表取数、反事实必须实测口径）后再推进 /wf:done。";

// intake-discuss-gate T04：intake 讨论确认关卡拒绝文案（full/daily 共用；wf:plan 入口）。
// 诚实边界（沿 M16-r44 口径）：出卡记账≠用户已批准——宿主观测不到卡片中的实际选择（只回模型），
// 文案只保「出过卡」，不得断言「用户已批准/未批准」。
export const INTAKE_CONFIRM_GATE_MSG =
  "❌ 需求确认关卡未过：尚未观测到需求确认交互。请先落盘 baseline.md（需求基线），再用宿主 question 工具向用户呈现需求摘要" +
  "（选项标签固定：需求无误，开始规划/补充修正/终止任务），之后再推进 /wf:plan（wf_command 或用户手敲；" +
  "确认以 question 出卡为准——插件只保证「出过卡」，观测不到卡片中的实际选择，不得据此断言批准结果）。";
