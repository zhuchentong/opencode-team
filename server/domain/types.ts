// wf-workflow — domain/types：T02（arch-r1-host-split）lib.ts 按域拆分的零依赖叶子。
// 跨域共享类型与零依赖常量/小函数（自 lib.ts 逐字节平移；REJECT_PREFIX=纯位置移动，红线②不变量
// 由 tests/brief-level.test.js 锁死）。守卫：tests/domain-acyclic.test.js 规则②（零依赖）/④（无环）。

// P1-E：builder lane 并发默认上限（软准入——超限告警不阻断；v2 提速默认 4，本地网关挤占风险以
// 「异常时经 options.limits.lane_cap 显式调低」处置）。常量置顶：LIMITS.lane_cap 引用它（默认值单一来源）。
export const LANE_CAP = 4;

/** 毫秒/天换算单点（state GC STALE_MS、policy 告警分级共用）。 */
// 毫秒/天换算单点（state GC 的 STALE_MS、policy 告警分级共用；禁各端散落 24*3600*1000 字面量）
export const DAY_MS = 24 * 3600 * 1000;

/**
 * limits 可按实例覆盖的默认表（M16-r33 P2）：流转循环计数上限的单一来源，
 * evaluateTransition 的 limits 缺省值；partial 覆盖（options.limits）仅替换提供的键。
 */
// P2：limits 可按实例覆盖（partial 覆盖默认 LIMITS）；lane_cap=builder lane 并发软准入（v2 提速）
export const LIMITS = { plan_review: 3, build_review: 3, test_fix: 3, lane_cap: LANE_CAP };
/** LIMITS 各键的字面量联合（counter 字段取值域）。 */
export type LimitKey = keyof typeof LIMITS;
// P2：limits 可按实例覆盖（partial 覆盖默认 LIMITS）
/** limits 按实例覆盖的形状：任一键可缺省，缺省回 LIMITS 默认值。 */
export type Limits = Partial<Record<LimitKey, number>>;

// notification-brief-display（plan §4 冻结）：报告级别——TUI 仅 warn 触发 OS 通知。
// 定义在 lib（state.ts/commands.ts 单一来源 import；lib 不 import state/guidance，无环）
/** 报告级别：warn 触发 TUI OS 通知，info 仅面板显示。 */
export type ReportLevel = "info" | "warn";

/** 工作流拒绝/错误文案统一前缀标识（诊断拼接面用）。 */
export const GATE_ERR = "[wf-workflow]";

// ── R3 T3.2：零回显进类型系统（纯编译期，运行时零变化）────────────────────────
// 长 ID 死循环史（M16-r40/r41/r45）：LLM 凭记忆复述 ses_ 长 ID → 截断 → 纠正 → 再转录。
// branded 类型把「sid 只经登记/解析构造、渲染文本不出裸 ID」从注释纪律升格为编译期事实：
// 裸 string 不可赋给 SessionId；渲染文本若需引用 sid 只能经 sidRefText（永不产出裸 ID）。
declare const sidBrand: unique symbol;
declare const slugBrand: unique symbol;
/** branded 会话 ID：只经登记/解析正则校验构造，裸 string 不可赋值（零回显编译期保障）。 */
export type SessionId = string & { readonly [sidBrand]: true };
// Slug 同法轻处理：slugify 唯一构造点
/** branded 任务 slug：只经 slugify 唯一构造点产出。 */
export type Slug = string & { readonly [slugBrand]: true };
// SidRef 双形态（对齐 SID_ALIAS_USAGE 协议：auto ∥ lane 登记后 @Tnn）——v2 验证 S-4 修订
/** SidRef 双形态：auto=自动续用该角色登记会话；lane=已登记 lane 的 @Tnn 引用。 */
export type SidRef = { form: "auto" } | { form: "lane"; lane: string };
// 唯一渲染出口：产出可进模型可见文本的引用写法，永不产出裸 ses_ ID
/**
 * 把 SidRef 渲染为可进模型可见文本的引用写法（唯一出口，永不产出裸 ses_ ID）。
 * @param ref 会话引用（auto 或 lane 双形态）
 * @returns 可进模型可见文本的引用写法
 */
export function sidRefText(ref: SidRef): string {
  return ref.form === "auto" ? 'sessionID="auto"' : `"@${ref.lane}"`;
}

// 状态对象（storage 持久化形状；历史版本含动态字段，索引签名容错）
/** 单条流转审计日志（storage 持久化形状；历史动态字段显式登记进 _ext 容错）。 */
export interface FlowLogEntry {
  ok?: boolean;
  note?: string;
  cmd?: string;
  tool?: string;
  detail?: string;
  at?: string;
  from?: string | null; // R3 T3.1 子步 D：原索引签名容忍的动态字段显式登记（承载 st.phase，可 null）
  to?: string | null;   // 同上
  rounds?: WfState["rounds"]; // 同上（轮次快照）
  // R3 T3.1 子步 D：索引签名收尾——未知字段收进 _ext（消隐式 any 逃逸口）
  _ext?: Record<string, unknown>;
}
/**
 * 工作流状态对象（storage 持久化形状，全仓领域数据中枢）。
 * 分组子对象（verdicts/delivery/reuse/timing）为 R3 T3.1 迁移目标形状；
 * 未知/历史动态字段统一收进 `_ext`，杜绝隐式 any 逃逸口。
 */
export interface WfState {
  // M16-r39 T06：持久化/会话元数据字段类型化（原经索引签名 unknown 容错）
  sessionID?: string;
  rev?: number;
  projectID?: string | null;
  directory?: string | null;
  createdAt?: string;
  slug?: Slug; // R3 T3.2：branded（slugify 唯一构造点）
  phase?: string | null;
  // M16-r33 P2：任务体量分级（intake 前缀 [S]/[M]/[L] 声明，缺省 M）——驱动产物预算与从简指引
  size?: string;
  // M16-r34：流程模式（daily=日常 5 步习惯流，新 intake 默认；full=完整 9 阶段，[FULL] 显式）。
  //   存量无 mode 字段 → full（兼容在途任务）。daily 内 size 决定委派与否（S=leader 串行零 sub-agent）。
  mode?: string;
  // M16-r34：日常模式 M/L 独立验证结论（plan-review 首行 **结论** 解析记账），wf:build 关卡校验
  //   R3 T3.1 子步 B：verdicts 家族 5 字段分组进子对象（读兼容：normalizeState 在 load 出口搬平铺字段）
  //   命名注意：子对象内字段去掉 Verdict/plan 前缀（planReview/testReport/confirmedAt）
  // M16-r44：方案确认记账——leader 经 question 工具呈现含「批准执行」选项的确认卡片时由 guard-hook 记录；
  //   plan 修订（wf:plan 推进 / wf_write_artifact kind=plan）与新任务 intake 即作废，wf:build 关卡校验
  verdicts?: {
    planReview?: string;        // ← planReviewVerdict
    testReport?: string;        // ← testReportVerdict
    testPlanWritten?: boolean;  // 同名迁入
    confirmedAt?: string;       // ← planConfirmedAt
    laneTableWritten?: boolean; // v2：plan.md 含「lane 分组表」（kind=plan 注册时解析记账；daily M/L 级 wf:build 关卡校验——并行优先，串行须以 lane 表书面举证）
    // R2 T2.3（arch-r2-profile-statemachine）：最近一次关卡判定快照（Gate 对象化产物）——
    // evaluateTransition 每次执行 gate 判定时覆写；levelFor 结构化优先输入（不依赖文案前缀）；
    // intake 重置块清除（跨任务不残留）。保持 R2 形状（id/ok/at）整体迁入。
    gateStatus?: { id: string; ok: boolean; at: string };
  };
  // R3 T3.1 子步 D：delivery 分组——doneGit/selfMod 迁入（读兼容：normalizeState 搬平铺字段）。
  // done-git-delivery-confirm T01：wf:done 流转时检测项目 git 环境记账（commands.ts detectDoneGit，
  //   fail-open=异常不记账）；guidance/entry 据此条件渲染交付确认指令——leader 必须 question 询问
  //   用户「提交并推送/仅提交/跳过」（无 remote 隐藏推送），批准前不得 commit/push。新任务 intake 清除。
  // selfmod-concurrency-guard T01（F2 v2）：selfMod 引擎自改任务记账——intake 检测任务目录=插件仓库根
  //   （isSelfModDir，commands.ts 接线，fail-open）时置位；驱动 building guidance 纪律行（entry 通道
  //   抗 compaction）与跨库扫描并发告警（scanActiveTasks：内存∪持久项目清单，休眠任务亦现形）。
  //   新任务 intake 重算（重置块清除），非自改 intake 亦清除残留。
  delivery?: {
    doneGit?: { isGit: boolean; hasRemote: boolean };
    selfMod?: boolean;
  };
  // 键集排除 lane_cap：它是并发准入上限，不是轮次计数器，永不写入 st.rounds（v2 提速）
  rounds: Record<Exclude<LimitKey, "lane_cap">, number> & Record<string, number>;
  updatedAt?: string;
  prev?: { slug?: string; phase?: string | null; at?: string };
  // P1-E（latency-v3.1 波次3）：lane 并行制度——值对象扩 areas/status/lastUsedAt（内部字段，
  // 不触发 wfstate-fields 顶层快照锁；勿把 lanes 迁组——会牵动锁与 normalize）。
  // areas=写集归属（leader 从 plan lane 分组表登记，经 wf:lane set --areas=T01,T02 单 token，勿走空格参数）；
  // status: active|done（done=已合并/收尾，留作空闲续用提示，不再计入并发数）；lastUsedAt=LRU 提示基准。
  lanes?: Record<string, { sessionID?: string; worktree?: string | null; at?: string; areas?: string[]; status?: "active" | "done"; lastUsedAt?: string }>;
  // R3 T3.1 子步 C：reuse 分组——roleSessions/tierBase 迁入（读兼容：normalizeState 搬平铺字段）
  // M16-r40：角色→最新子会话自动登记（agent→{sessionID,at}）。子代理调 wf_write_artifact /
  //   edit 时插件自动捕获其 sessionID；guidance 重委派点按登记存在性渲染续用指引（指路别名/省略新建，
  //   不回显 ID——回显即转录燃料，fix-sid-truncation-echo-loop T02），守卫对截断前缀就地自愈改写（T01）——
  //   修「leader 凭记忆复述长随机 ses_ ID 被截断→重试→冷启动」。仅服务默认单会话形态；多 builder 并行走 lanes。
  // M16-r43：tierBase 档位跟随上次记录的会话基座（Session.Info.model 的 providerID/id）——切模型检测依据，
  //   变化时审计 tier-model-switch 并清空 roleSessions（旧子会话=旧模型，防混模型续用）。
  reuse?: {
    roleSessions?: RoleSessions; // sessionID 为 branded SessionId（登记表构造点，R3 T3.2）
    tierBase?: { providerID: string; id: string; variant?: string; at: string };
  };
  artifacts?: Record<string, { at?: string; bytes?: number; hash?: string }>; // hash=sha256 前 12 位（r53 批次 1：register 幂等强比较；存量无 hash 退回 bytes 比较）
  log?: FlowLogEntry[];
  // M16-r39 T01：log 单调序号（logAdd 递增）——save 按序号差增量追 events，
  // 50 条截断不再使审计停追；存量快照无此字段 → length 回退
  logSeq?: number;
  entryErr?: string;
  // tui-sidebar-elapsed T01（plan §3.1）：墙钟计时记账——全部可选，存量快照自然缺省 → TUI 降级 ·
  // R3 T3.1 子步 A：4 字段分组进 timing 子对象（读兼容：normalizeState 在 load 出口搬平铺字段，内存恒新形）
  timing?: {
    startedAt?: string;                       // ISO：intake 建任务时刻（总耗时起点）
    phaseEnteredAt?: string;                  // ISO：当前阶段进入时刻
    phaseDurations?: Record<string, number>;  // 秒；key=FOLD 折叠后阶段名（多轮 revisit 累计）
    finishedAt?: string;                      // ISO：进入 done 时刻（总耗时冻结点）
  };
  // R3 T3.1 子步 D：索引签名收尾——未知/历史动态字段收进 _ext（消隐式 any 逃逸口）
  _ext?: Record<string, unknown>;
}

// R3 T3.1（arch-r3-state-shape-migration）：旧平铺快照 → 新分组形状的归一（load 出口调用）。
// 幂等：已是新形原样通过；平铺字段搬入子对象后从顶层 delete（避免双份）；混合形状正确收敛。
// 只搬形状不磨语义：不补缺省、不改值。零依赖叶子（domain-acyclic），供 state.ts 与测试 stub 同源复用。
// 子步 A：timing 4 字段；子步 B：verdicts 家族 5 字段（Verdict/plan 前缀在子对象内剥除）。
const VERDICT_RENAMES = {
  planReviewVerdict: "planReview",
  testReportVerdict: "testReport",
  testPlanWritten: "testPlanWritten",
  planConfirmedAt: "confirmedAt",
  gateStatus: "gateStatus",
} as const;

/**
 * 旧平铺快照 → 新分组形状的归一（load 出口调用，state.ts 与测试 stub 同源复用）。
 * 幂等：已是新形原样通过；平铺字段搬入子对象后从顶层删除；只搬形状不磨语义（不补缺省不改值）。
 * @param st 任意来源的状态快照（旧平铺/新分组/混合均可）
 * @returns 归一后的同一对象引用（原地迁移）
 */
export function normalizeState(st: WfState): WfState {
  const s = st as any;
  if (!s || typeof s !== "object") return st;
  // timing（子步 A）
  const hadTiming = s.timing != null;
  const timing = { ...s.timing };
  for (const k of ["startedAt", "phaseEnteredAt", "phaseDurations", "finishedAt"] as const) {
    if (s[k] !== undefined) { timing[k] = s[k]; delete s[k]; }
  }
  if (hadTiming || Object.keys(timing).length > 0) s.timing = timing;
  // reuse（子步 C）
  const hadReuse = s.reuse != null;
  const reuse = { ...s.reuse };
  for (const k of ["roleSessions", "tierBase"] as const) {
    if (s[k] !== undefined) { reuse[k] = s[k]; delete s[k]; }
  }
  if (hadReuse || Object.keys(reuse).length > 0) s.reuse = reuse;
  // delivery（子步 D）
  const hadDelivery = s.delivery != null;
  const delivery = { ...s.delivery };
  for (const k of ["doneGit", "selfMod"] as const) {
    if (s[k] !== undefined) { delivery[k] = s[k]; delete s[k]; }
  }
  if (hadDelivery || Object.keys(delivery).length > 0) s.delivery = delivery;
  // verdicts（子步 B）
  const hadVerdicts = s.verdicts != null;
  const verdicts = { ...s.verdicts };
  for (const [flat, inner] of Object.entries(VERDICT_RENAMES)) {
    if (s[flat] !== undefined) { verdicts[inner] = s[flat]; delete s[flat]; }
  }
  if (hadVerdicts || Object.keys(verdicts).length > 0) s.verdicts = verdicts;
  return st;
}

// R3 T3.1 子步 C：登记表形状单点（session.ts SidAliasInput 等派生用）
/** 角色→最新子会话登记表形状（agent → {sessionID, at}；sessionID 为 branded SessionId）。 */
export type RoleSessions = Record<string, { sessionID: SessionId; at: string }>;
// （LANE_CAP 定义置顶于 LIMITS 之前——本文件原 172 行处，因 LIMITS.lane_cap 引用前移，勿在此重复定义）

// from: 允许的来源阶段（"*" = 任意）；counter: 循环轮次计数（null = 非循环）
/** 单条流转边定义：to=目标阶段；from=允许的来源阶段（"*"=任意）；counter=循环轮次计数键（null=非循环）。 */
export interface FlowDef {
  to: string;
  from: string[];
  counter: LimitKey | null;
}

// T01：Unicode 字母/数字全保留（\p{L}\p{N}）——中文 slug 不再折叠为空回退 untitled；
// 其余字符（含空白/标点/下划线）折叠为连字符，语义与旧版 [^a-z0-9]+ 等价、仅扩字符集。
// T13：截断按码点（Array.from）——code unit 截断会切裂代理对（扩展区汉字）
/**
 * 任务名 → slug 小工具：非字母数字折叠为连字符、按码点截 40、空结果回退由调用方处理。
 * @param t 任意输入（容错转字符串）
 * @returns 归一化后的 slug（可能为空串）
 */
export const slugify = (t: unknown): string =>
  Array.from(String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")).slice(0, 40).join("");

// 实测（M2-a）：命令 args.prompt 是对象（含 text 等字段），不是字符串
interface PromptLike { text?: unknown; content?: unknown }
/**
 * 从宿主命令 args.prompt（实测是对象）提取提示词文本：兼容 string / {text|content} 两种形状。
 * @param p 宿主命令 args.prompt（string 或对象，其余容错）
 * @returns 提取出的提示词文本（无则空串）
 */
export const promptText = (p: unknown): string => {
  if (typeof p === "string") return p;
  if (p && typeof p === "object") { const q = p as PromptLike; return String(q.text ?? q.content ?? ""); }
  return "";
};

// ── M16-r36：工作流硬性限定 leader（服务端强制，非提示词约定）────────
// M16-r38：leader 主名 workflow（宿主 TUI 显示 titlecase(id)=Workflow）；wf/leader 保留为过渡
// 兼容别名——本插件从仓库热载，改名瞬间在途 wf/leader 会话不得被自拒（双 ID 同权）。
/** leader 主名 agent ID（宿主 TUI 显示 titlecase）。 */
export const LEADER_AGENT = "workflow";
/** leader 全部合法 agent 名（含过渡兼容别名，双 ID 同权防在途会话被自拒）。 */
export const LEADER_ALIASES = ["workflow", "wf/leader"];
/**
 * 判定 agent 名是否 leader（主名或任一别名）。
 * @param agent agent 名
 * @returns leader 主名或别名时为 true
 */
export function isLeader(agent: string): boolean {
  return LEADER_ALIASES.includes(agent);
}

// R2 T2.3：gate 拒绝附 gate.id（audit 明细维度；note 值逐字不变=flows.test 锚不破坏，
// commands.ts logAdd 据此把 note 细化为 "gate-rejected:<id>" 仅作用于 log/诊断面）。
/** 流转判定结果：通过或拒绝（note=REJECT_NOTES 拒绝码；gate=关卡 id 审计细分，仅 gate 拒绝时在场）。 */
export type TransitionResult = { ok: true } | { ok: false; note: string; msg: string; gate?: string };

// T01（arch-r1-host-split）：静默失败条目（observe.ts 环形缓冲与 diagnose facts 共用；
// 运行时实现零依赖——T02 归 domain/types.ts，供 domain/diagnose 与 observe 同型引用）。
/** 静默失败条目（observe 环形缓冲与 diagnose facts 共用形状）。 */
export interface SwallowEntry { code: string; msg: string; at: string }

/** 拒绝文案统一 ❌ 字面量前缀（作者位不变量，OS 通知/ brief 分派依赖，与成功 guidance 【开头互斥）。 */
// 拒绝文案统一 ❌ 字面量前缀（作者位不变量，与成功 guidance 【开头互斥，守卫锁死）。
export const REJECT_PREFIX = "❌";

// ── R2 T2.4（arch-r2-profile-statemachine）：拒绝码枚举与错误形状轻定义 ──────────
// evaluateTransition 的 note 值唯一来源（字符串逐字=旧值，log/diagnose 面兼容）；
// WfError = swallow code 命名与未来统一 Result 的最小形状。SaveResult/RetryResult
// 旧形状本批不动（retry.test 真机契约锚；完整收敛挂 R3 纪律）。
/** 拒绝码枚举：evaluateTransition 的 note 值唯一来源（字符串逐字=旧值，log/diagnose 面兼容）。 */
export const REJECT_NOTES = {
  UNKNOWN_COMMAND: "unknown-command",
  ILLEGAL_TRANSITION: "illegal-transition",
  GATE_REJECTED: "gate-rejected",
  LIMIT_EXCEEDED: "limit-exceeded",
  INTAKE_GUARD: "intake-guard",
} as const;
/** 统一错误最小形状：code=swallow 命名空间，msg=人读信息。 */
export interface WfError { code: string; msg: string }

// ── R2 T2.1/T2.3/T2.2（arch-r2-profile-statemachine）：Strategy/Specification/State Object 形状 ──
// Gate：判定与解释分离（Specification）——isSatisfiedBy 纯谓词，explain 拒绝文案模板。
/** 关卡（Specification）：判定与解释分离——isSatisfiedBy 纯谓词，explain 产出拒绝文案。 */
export interface Gate {
  id: string;
  isSatisfiedBy: (st: WfState) => boolean;
  explain: (st: WfState) => string;
}
// PhaseDef：阶段单点注册表条目（State Object 化，T2.2）——next=NEXT 表值迁入，blocking 源=
// shared BLOCKING（装配期一致性守卫 tests/phases.test.js 锁「PhaseDef.blocking ⇔ BLOCKING」双向）。
/** 阶段单点注册表条目（State Object 化）：next=下一步指引；blocking=阶段业务写受闸。 */
export interface PhaseDef {
  next: string;
  blocking?: boolean;
}
// WorkflowProfile：模式数据容器（Strategy）——flows/gates/phases 三段齐全即一个完整模式；
// 注册与唯一消费点在 domain/flow.ts（profileOf），guidance 编排层按 profile.id 派发。
/** 模式数据容器（Strategy）：flows/gates/phases 三段齐全即一个完整模式，注册/消费点在 flow.ts。 */
export interface WorkflowProfile {
  id: string;
  flows: Record<string, FlowDef>;
  gates: Record<string, Gate>;
  phases: Record<string, PhaseDef>;
}

// 体量归一：只认 S/L，其余（M/缺省/存量无 size）一律按 M（存量兼容）
// R2 T2.1：自 artifact.ts 逐字节平移至 types 叶子（flow/guidance 等域消费合法化；
// lib 导出名 tierOf 不变——artifact.ts 改 import 转发）。
/**
 * 体量归一：只认 S/L，其余（M/缺省/存量无 size）一律按 M（存量兼容）。
 * @param size 原始体量标记（可空）
 * @returns 归一后的 "S" | "M" | "L"
 */
export function tierOf(size?: string | null): "S" | "M" | "L" {
  return size === "S" || size === "L" ? size : "M";
}

// R2 T2.4：初始状态行工厂（transition load 缺行分支与 tests 双份默认值收敛；字段逐字节同旧）。
/**
 * 初始状态行工厂：transition load 缺行分支与 tests 双份默认值收敛点。
 * @param sessionID 所属会话 ID
 * @param at 创建时刻（ISO；缺省当前时间）
 * @returns 字段与历史默认值逐字节一致的空白 WfState
 */
export function makeInitialWfState(sessionID: string, at = new Date().toISOString()): WfState {
  return {
    sessionID, slug: slugify("") as Slug, // R3 T3.2：slug 经唯一构造点（运行时仍 ""）
    rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
    lanes: {}, artifacts: {}, log: [], createdAt: at,
  };
}
