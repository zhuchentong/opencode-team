// wf-workflow — domain/types：T02（arch-r1-host-split）lib.ts 按域拆分的零依赖叶子。
// 跨域共享类型与零依赖常量/小函数（自 lib.ts 逐字节平移；REJECT_PREFIX=纯位置移动，红线②不变量
// 由 tests/brief-level.test.js 锁死）。守卫：tests/domain-acyclic.test.js 规则②（零依赖）/④（无环）。

export const LIMITS = { plan_review: 3, build_review: 3, test_fix: 3 };
export type LimitKey = keyof typeof LIMITS;
// P2：limits 可按实例覆盖（partial 覆盖默认 LIMITS）
export type Limits = Partial<Record<LimitKey, number>>;

// notification-brief-display（plan §4 冻结）：报告级别——TUI 仅 warn 触发 OS 通知。
// 定义在 lib（state.ts/commands.ts 单一来源 import；lib 不 import state/guidance，无环）
export type ReportLevel = "info" | "warn";

export const GATE_ERR = "[wf-workflow]";

// 状态对象（storage 持久化形状；历史版本含动态字段，索引签名容错）
export interface FlowLogEntry {
  ok?: boolean;
  note?: string;
  cmd?: string;
  tool?: string;
  detail?: string;
  at?: string;
  [key: string]: unknown;
}
export interface WfState {
  // M16-r39 T06：持久化/会话元数据字段类型化（原经索引签名 unknown 容错）
  sessionID?: string;
  rev?: number;
  projectID?: string | null;
  directory?: string | null;
  createdAt?: string;
  slug?: string;
  phase?: string | null;
  // M16-r33 P2：任务体量分级（intake 前缀 [S]/[M]/[L] 声明，缺省 M）——驱动产物预算与从简指引
  size?: string;
  // M16-r34：流程模式（daily=日常 5 步习惯流，新 intake 默认；full=完整 9 阶段，[FULL] 显式）。
  //   存量无 mode 字段 → full（兼容在途任务）。daily 内 size 决定委派与否（S=leader 串行零 sub-agent）。
  mode?: string;
  // M16-r34：日常模式 M/L 独立验证结论（plan-review 首行 **结论** 解析记账），wf:build 关卡校验
  planReviewVerdict?: string;
  // M16-r44：方案确认记账——leader 经 question 工具呈现含「批准执行」选项的确认卡片时由 guard-hook 记录；
  //   plan 修订（wf:plan 推进 / wf_write_artifact kind=plan）与新任务 intake 即作废，wf:build 关卡校验
  planConfirmedAt?: string;
  // done-git-delivery-confirm T01：wf:done 流转时检测项目 git 环境记账（commands.ts detectDoneGit，
  //   fail-open=异常不记账）；guidance/entry 据此条件渲染交付确认指令——leader 必须 question 询问
  //   用户「提交并推送/仅提交/跳过」（无 remote 隐藏推送），批准前不得 commit/push。新任务 intake 清除。
  doneGit?: { isGit: boolean; hasRemote: boolean };
  // selfmod-concurrency-guard T01（F2 v2）：引擎自改任务记账——intake 检测任务目录=插件仓库根
  //   （isSelfModDir，commands.ts 接线，fail-open）时置位；驱动 building guidance 纪律行（entry 通道
  //   抗 compaction）与跨库扫描并发告警（scanActiveTasks：内存∪持久项目清单，休眠任务亦现形）。
  //   新任务 intake 重算（重置块清除），非自改 intake 亦清除残留。
  selfMod?: boolean;
  rounds: Record<LimitKey, number> & Record<string, number>;
  updatedAt?: string;
  prev?: { slug?: string; phase?: string | null; at?: string };
  lanes?: Record<string, { sessionID?: string; worktree?: string | null; at?: string }>; // M16-r39 T06：worktree 可 null（lane set 无 worktree 时写 null，形状同源）
  // M16-r40：角色→最新子会话自动登记（agent→{sessionID,at}）。子代理调 wf_write_artifact /
  //   edit 时插件自动捕获其 sessionID；guidance 重委派点按登记存在性渲染续用指引（指路别名/省略新建，
  //   不回显 ID——回显即转录燃料，fix-sid-truncation-echo-loop T02），守卫对截断前缀就地自愈改写（T01）——
  //   修「leader 凭记忆复述长随机 ses_ ID 被截断→重试→冷启动」。仅服务默认单会话形态；多 builder 并行走 lanes。
  roleSessions?: Record<string, { sessionID: string; at: string }>;
  // M16-r43：档位跟随上次记录的会话基座（Session.Info.model 的 providerID/id）——切模型检测依据，
  //   变化时审计 tier-model-switch 并清空 roleSessions（旧子会话=旧模型，防混模型续用）。
  tierBase?: { providerID: string; id: string; variant?: string; at: string };
  artifacts?: Record<string, { at?: string; bytes?: number }>;
  log?: FlowLogEntry[];
  // M16-r39 T01：log 单调序号（logAdd 递增）——save 按序号差增量追 events，
  // 50 条截断不再使审计停追；存量快照无此字段 → length 回退
  logSeq?: number;
  testPlanWritten?: boolean;
  testReportVerdict?: string;
  // R2 T2.3（arch-r2-profile-statemachine）：最近一次关卡判定快照（Gate 对象化产物）——
  // evaluateTransition 每次执行 gate 判定时覆写；levelFor 结构化优先输入（不依赖文案前缀）。
  // intake 重置块清除（跨任务不残留）。形状纪律同 verdicts 家族：R3 分组迁移候选（gate→verdicts 域）。
  gateStatus?: { id: string; ok: boolean; at: string };
  entryErr?: string;
  // tui-sidebar-elapsed T01（plan §3.1）：墙钟计时记账——全部可选，存量快照自然缺省 → TUI 降级 ·
  // R3 T3.1 子步 A：4 字段分组进 timing 子对象（读兼容：normalizeState 在 load 出口搬平铺字段，内存恒新形）
  timing?: {
    startedAt?: string;                       // ISO：intake 建任务时刻（总耗时起点）
    phaseEnteredAt?: string;                  // ISO：当前阶段进入时刻
    phaseDurations?: Record<string, number>;  // 秒；key=FOLD 折叠后阶段名（多轮 revisit 累计）
    finishedAt?: string;                      // ISO：进入 done 时刻（总耗时冻结点）
  };
  [key: string]: unknown;
}

// R3 T3.1（arch-r3-state-shape-migration）：旧平铺快照 → 新分组形状的归一（load 出口调用）。
// 幂等：已是新形原样通过；平铺字段搬入子对象后从顶层 delete（避免双份）；混合形状正确收敛。
// 只搬形状不磨语义：不补缺省、不改值。零依赖叶子（domain-acyclic），供 state.ts 与测试 stub 同源复用。
export function normalizeState(st: WfState): WfState {
  const s = st as any;
  if (!s || typeof s !== "object") return st;
  const hadSub = s.timing != null;
  const timing = { ...s.timing };
  for (const k of ["startedAt", "phaseEnteredAt", "phaseDurations", "finishedAt"] as const) {
    if (s[k] !== undefined) { timing[k] = s[k]; delete s[k]; }
  }
  if (hadSub || Object.keys(timing).length > 0) s.timing = timing;
  return st;
}

// from: 允许的来源阶段（"*" = 任意）；counter: 循环轮次计数（null = 非循环）
export interface FlowDef {
  to: string;
  from: string[];
  counter: LimitKey | null;
}

// T01：Unicode 字母/数字全保留（\p{L}\p{N}）——中文 slug 不再折叠为空回退 untitled；
// 其余字符（含空白/标点/下划线）折叠为连字符，语义与旧版 [^a-z0-9]+ 等价、仅扩字符集。
// T13：截断按码点（Array.from）——code unit 截断会切裂代理对（扩展区汉字）
export const slugify = (t: unknown): string =>
  Array.from(String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")).slice(0, 40).join("");

// 实测（M2-a）：命令 args.prompt 是对象（含 text 等字段），不是字符串
interface PromptLike { text?: unknown; content?: unknown }
export const promptText = (p: unknown): string => {
  if (typeof p === "string") return p;
  if (p && typeof p === "object") { const q = p as PromptLike; return String(q.text ?? q.content ?? ""); }
  return "";
};

// ── M16-r36：工作流硬性限定 leader（服务端强制，非提示词约定）────────
// M16-r38：leader 主名 workflow（宿主 TUI 显示 titlecase(id)=Workflow）；wf/leader 保留为过渡
// 兼容别名——本插件从仓库热载，改名瞬间在途 wf/leader 会话不得被自拒（双 ID 同权）。
export const LEADER_AGENT = "workflow";
export const LEADER_ALIASES = ["workflow", "wf/leader"];
export function isLeader(agent: string): boolean {
  return LEADER_ALIASES.includes(agent);
}

// R2 T2.3：gate 拒绝附 gate.id（audit 明细维度；note 值逐字不变=flows.test 锚不破坏，
// commands.ts logAdd 据此把 note 细化为 "gate-rejected:<id>" 仅作用于 log/诊断面）。
export type TransitionResult = { ok: true } | { ok: false; note: string; msg: string; gate?: string };

// T01（arch-r1-host-split）：静默失败条目（observe.ts 环形缓冲与 diagnose facts 共用；
// 运行时实现零依赖——T02 归 domain/types.ts，供 domain/diagnose 与 observe 同型引用）。
export interface SwallowEntry { code: string; msg: string; at: string }

// 拒绝文案统一 ❌ 字面量前缀（作者位不变量，与成功 guidance 【开头互斥，守卫锁死）。
export const REJECT_PREFIX = "❌";

// ── R2 T2.4（arch-r2-profile-statemachine）：拒绝码枚举与错误形状轻定义 ──────────
// evaluateTransition 的 note 值唯一来源（字符串逐字=旧值，log/diagnose 面兼容）；
// WfError = swallow code 命名与未来统一 Result 的最小形状。SaveResult/RetryResult
// 旧形状本批不动（retry.test 真机契约锚；完整收敛挂 R3 纪律）。
export const REJECT_NOTES = {
  UNKNOWN_COMMAND: "unknown-command",
  ILLEGAL_TRANSITION: "illegal-transition",
  GATE_REJECTED: "gate-rejected",
  LIMIT_EXCEEDED: "limit-exceeded",
  INTAKE_GUARD: "intake-guard",
} as const;
export interface WfError { code: string; msg: string }

// ── R2 T2.1/T2.3/T2.2（arch-r2-profile-statemachine）：Strategy/Specification/State Object 形状 ──
// Gate：判定与解释分离（Specification）——isSatisfiedBy 纯谓词，explain 拒绝文案模板。
export interface Gate {
  id: string;
  isSatisfiedBy: (st: WfState) => boolean;
  explain: (st: WfState) => string;
}
// PhaseDef：阶段单点注册表条目（State Object 化，T2.2）——next=NEXT 表值迁入，blocking 源=
// shared BLOCKING（装配期一致性守卫 tests/phases.test.js 锁「PhaseDef.blocking ⇔ BLOCKING」双向）。
export interface PhaseDef {
  next: string;
  blocking?: boolean;
}
// WorkflowProfile：模式数据容器（Strategy）——flows/gates/phases 三段齐全即一个完整模式；
// 注册与唯一消费点在 domain/flow.ts（profileOf），guidance 编排层按 profile.id 派发。
export interface WorkflowProfile {
  id: string;
  flows: Record<string, FlowDef>;
  gates: Record<string, Gate>;
  phases: Record<string, PhaseDef>;
}

// 体量归一：只认 S/L，其余（M/缺省/存量无 size）一律按 M（存量兼容）
// R2 T2.1：自 artifact.ts 逐字节平移至 types 叶子（flow/guidance 等域消费合法化；
// lib 导出名 tierOf 不变——artifact.ts 改 import 转发）。
export function tierOf(size?: string | null): "S" | "M" | "L" {
  return size === "S" || size === "L" ? size : "M";
}

// R2 T2.4：初始状态行工厂（transition load 缺行分支与 tests 双份默认值收敛；字段逐字节同旧）。
export function makeInitialWfState(sessionID: string, at = new Date().toISOString()): WfState {
  return {
    sessionID, slug: "", phase: null,
    rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
    lanes: {}, artifacts: {}, log: [], createdAt: at,
  };
}
