// wf-workflow — domain/flow：流转表/阶段表/关卡与 evaluateTransition。
// R2（arch-r2-profile-statemachine）重构三合一（行为不变，形状收敛）：
//   T2.1 Strategy：flows/gates/phases 收进 WorkflowProfile，PROFILES 模块装载册（full/daily 自注册），
//        profileOf 为 isDaily 唯一消费点——flowFor/gateFor/nextFor/evaluateTransition 一律经 profile 取表；
//   T2.2 State Object：NEXT/NEXT_DAILY 五处阶段映射中的 next/blocking 并入 PhaseDef 单点注册，
//        NEXT/NEXT_DAILY 降为派生导出（值逐字节不变，tests/daily-mode/brief-level 锚零改动）；
//   T2.3 Specification：GATES 表值=Gate 对象（id/isSatisfiedBy/explain 判定与解释分离），
//        拒绝文案迁 shared/prompts/gates.ts（字节级），gate 判定快照写 st.verdicts.gateStatus（R3 T3.1 分组），
//        拒绝返回附 gate 字段（note 值逐字不变——commands.ts logAdd 据此细化审计面）。
// P2 limits 覆盖、M16-r34 daily 子表、M10-a「进入即计数」语义与旧 lib.ts 逐字一致。
import { LIMITS, REJECT_NOTES, promptText, slugify, tierOf, type FlowDef, type Gate, type Limits, type PhaseDef, type Slug, type TransitionResult, type WfState, type WorkflowProfile } from "./types.ts";
import { CONFIRM_GATE_MSG, DONE_LESSONS_GATE_MSG, GATE_DUAL_CHANNEL_MSG, INTAKE_CONFIRM_GATE_MSG, LANE_DEPS_GATE_MSG, LANE_TABLE_GATE_MSG, gateAcceptanceMsg, gateDailyVerifyMsg } from "../../shared/prompts/gates.ts";

// M16-r28（性能审计批次 1/2）：B1-1 shell 误伤翻案（=>/比较符/tee<）+ guard 项目 containment
//   （项目外写放行，对齐 shell 分支语义）；B1-2~B1-5 guidance 提速（reconcile 去全量、并发委派、
//   委派上下文契约、review 增量复审）；批次 2：assign 阶段并入 test_design（实测 assign 零实质工作，
//   双通道关卡随迁至 wf:test-design 入口；LEGACY_PHASES 兼容在途任务）。
/** 完整模式（full）流转表：命令→流转边（来源阶段白名单+循环计数键），阶段推进合法性唯一依据。 */
export const FLOWS: Record<string, FlowDef> = {
  "wf:intake":       { to: "intake",       from: ["*"],                                        counter: null },
  // M10-a：补返工边——review 不过回 planning；执行审核遗漏回 building；返工/修复后回 reconcile 重合并
  "wf:plan":         { to: "planning",     from: ["intake", "planning", "review", "test_design"], counter: null },
  "wf:review":       { to: "review",       from: ["planning", "review"],                       counter: "plan_review" },
  // M16-r28：assign 独立阶段移除（双通道关卡迁移至本命令入口）；from 保留 "assign" = 存量卡在该
  //   阶段的在途任务兼容边（LEGACY_PHASES 守卫见 shared/phases.ts）
  "wf:test-design":  { to: "test_design",  from: ["review", "assign"],                         counter: null },
  "wf:build":        { to: "building",     from: ["test_design", "build_review"],              counter: null },
  "wf:reconcile":    { to: "reconcile",    from: ["building", "build_review", "fixing"],       counter: null },
  "wf:review-build": { to: "build_review", from: ["reconcile", "build_review"],                counter: "build_review" },
  "wf:test":         { to: "testing",      from: ["build_review", "testing", "fixing", "reconcile"], counter: null },
  "wf:fix":          { to: "fixing",       from: ["testing"],                                  counter: "test_fix" },
  "wf:done":         { to: "done",         from: ["testing"],                                  counter: null },
};

// ── T2.2：PhaseDef 单点注册（next = 旧 NEXT 表值逐字；blocking ⇔ shared/phases BLOCKING——
//   装配一致性由 tests/phases.test.js 守卫双向锁死，此处字面即唯一注册面）──
/** full 模式 9+1 阶段注册表：next=下一步指引，blocking=业务写受闸（与 shared BLOCKING 双向守卫锁死）。 */
export const PHASES_FULL: Record<string, PhaseDef> = {
  intake: { next: "/wf:plan" },
  planning: { next: "/wf:review", blocking: true },
  review: { next: "/wf:test-design", blocking: true },
  // M16-r28 兼容行：存量 assign 阶段任务（阶段已并入 test_design）的下一步指引
  assign: { next: "/wf:test-design（assign 已并入 test_design，直接推进即可）" },
  test_design: { next: "/wf:build" },
  building: { next: "/wf:reconcile" },
  reconcile: { next: "/wf:review-build" },
  build_review: { next: "/wf:test", blocking: true },
  testing: { next: "PASS→/wf:done，FAIL→/wf:fix" },
  fixing: { next: "/wf:test" },
  done: { next: "（终态；git 项目按「总结→提交/不提交→完成」串行）" },
};
/** daily 模式 6 阶段注册表（习惯流：plan→review→build→test→done）。 */
export const PHASES_DAILY: Record<string, PhaseDef> = {
  intake: { next: "/wf:plan" },
  planning: { next: "/wf:review", blocking: true },
  review: { next: "/wf:build（M/L 须 plan-review 结论 PASS）", blocking: true },
  building: { next: "/wf:test" },
  testing: { next: "PASS→/wf:done，FAIL→/wf:fix（回 building 返工）" },
  done: { next: "（终态）" },
};

// 派生导出（R2 T2.2：NEXT/NEXT_DAILY 降为 PhaseDef 的只读视图；键值逐字节=旧字面表，
// tests/brief-level/daily-mode 消费零改动；新代码消费请走 nextFor/phases，勿新增对本表的直接依赖）。
const fromPhases = (p: Record<string, PhaseDef>): Record<string, string> =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.next]));
/** full 模式阶段→下一步指引只读视图（旧字面表逐字节等价；新代码请走 nextFor/phases）。 */
export const NEXT: Record<string, string> = fromPhases(PHASES_FULL);
/** daily 模式阶段→下一步指引只读视图。 */
export const NEXT_DAILY: Record<string, string> = fromPhases(PHASES_DAILY);

// ── M5：命令级进阶关卡（Gate 对象化后语义不变：不满足=拒绝，explain=拒绝理由）──────────
// M16-r28：双通道关卡原挂 wf:assign（assign 阶段已并入 test_design），迁移至 wf:test-design 入口，
//   语义不变：计划审核（流转合法性）之外，还须 tester 已产出 test-plan.md（M3 记账 testPlanWritten）
// wf:done 验收：test-report.md 的「**结论**」必须为 PASS（wf_write_artifact 解析记账 testReportVerdict）
// R2 T2.3：判定（isSatisfiedBy 纯谓词）与解释（explain 文案模板）分离；id=审计/诊断细分维度。
/** full 模式命令级关卡表：需求确认（wf:plan）/双通道（test-design 入口）/方案确认（wf:build）/验收（wf:done）。 */
export const GATES: Record<string, Gate> = {
  // intake-discuss-gate T04：intake 讨论确认关卡（wf:plan 入口；daily 用 GATES_DAILY["wf:plan"] 同对象复用）。
  // 谓词冻结：仅 intake 相位受闸；S 豁免；intakeConfirmOff===true（T02 固化开关）放行；
  // 出卡记账 intakeConfirmedAt（T03 guard-hook 观测）放行。诚实边界：只保「出过卡」，不断言用户批准与否。
  "wf:plan": {
    id: "intake-confirm",
    isSatisfiedBy: (st) => st.phase !== "intake" || tierOf(st.size) === "S" || st.intakeConfirmOff === true || !!st.verdicts?.intakeConfirmedAt,
    explain: () => INTAKE_CONFIRM_GATE_MSG,
  },
  "wf:test-design": {
    id: "dual-channel",
    isSatisfiedBy: (st) => !!st.verdicts?.testPlanWritten, // R3 T3.1 子步 B：verdicts 子对象读点
    explain: () => GATE_DUAL_CHANNEL_MSG,
  },
  // M16-r44：方案确认关卡（full 模式；daily 用 GATES_DAILY["wf:build"] 同源校验）
  // 效率批 P1（评审 M1 修订）：full 模式 M/L 同加 lane 依赖边表要件——daily-only 执法会让
  // test_49/50 形态的 full 任务完全绕过边表（F1 类结构性返修在 full 模式同样发生且更贵）。
  "wf:build": {
    id: "plan-confirm",
    isSatisfiedBy: (st) => !!st.verdicts?.confirmedAt
      && (tierOf(st.size) === "S" || st.verdicts?.laneDepsOk === true),
    explain: (st) => (!st.verdicts?.confirmedAt ? CONFIRM_GATE_MSG
      : (tierOf(st.size) !== "S" && st.verdicts?.laneDepsOk !== true) ? LANE_DEPS_GATE_MSG
      : CONFIRM_GATE_MSG),
  },
  // 效率批 P2（learn 前置移交）：done 验收=测试 PASS + lessons 在案（learn 移交 leader 内联，
  // learner 改职 FAIL 取证/显式深审；F4 竞态随之根治——经验落盘先于交付确认）。
  "wf:done": {
    id: "acceptance",
    isSatisfiedBy: (st) => st.verdicts?.testReport === "PASS" && st.verdicts?.lessonsWritten === true,
    explain: (st) => (st.verdicts?.testReport !== "PASS"
      ? gateAcceptanceMsg(st.verdicts?.testReport)
      : DONE_LESSONS_GATE_MSG),
  },
};

// ── M16-r34：日常模式（daily）——自动化用户 5 步习惯 plan→verify→修订→执行→核对 ──────────
// 一条流全 tier（S/M/L），tier 只改委派与否（guidance 分支）；砍 test_design/reconcile/build_review/fixing。
// 完整 FLOWS 不动（full 模式/存量在途任务用），daily 用本子表。FAIL 返工复用 wf:fix（改指 building）+ test_fix 计数。
/** daily 模式流转子表：5 步习惯流；FAIL 修订唯一路径 wf:plan（review→review 直推边已移除）。 */
export const FLOWS_DAILY: Record<string, FlowDef> = {
  "wf:intake": { to: "intake",   from: ["*"],                          counter: null },
  "wf:plan":   { to: "planning", from: ["intake", "planning", "review"], counter: null },
  // selfmod-concurrency-guard A2：FAIL 修订收敛为唯一路径 wf:plan→wf:review——review→review 直推
  //   复审边移除（双任务同版本取证：走哪条纯模型裁量=漂移；修订必改 plan，改后恒在 planning）。
  //   full 模式 FLOWS 不动（在途兼容）。
  "wf:review": { to: "review",   from: ["planning"],                    counter: "plan_review" },
  "wf:build":  { to: "building", from: ["review"],                     counter: null },
  // 返工触发器：daily 无 fixing 阶段，wf:fix 改指 building（复用 test_fix≤3，零新计数逻辑）
  "wf:fix":    { to: "building", from: ["testing"],                    counter: "test_fix" },
  "wf:test":   { to: "testing",  from: ["building", "testing"],        counter: null },
  "wf:done":   { to: "done",     from: ["testing"],                    counter: null },
};
// R2 T2.3：daily wf:build 关卡=确认（全 tier 必经）+ M/L 独立验证结论双要素 + lane 依赖边表（效率批 P1）；
// S 只跳结论不跳确认；size 判定走 tierOf（T2.1 TierCtx 纪律：`st.size ===` 字面清零）。
/** daily 模式关卡表：wf:plan 需求确认（同对象复用）+ wf:build 四要素判定（确认→lane 表→边表→review 结论，S 级只跳后三者）。 */
export const GATES_DAILY: Record<string, Gate> = {
  // intake-discuss-gate T04：同 wf:done 模式——同对象复用（判定/文案单源，双表行为恒一致）
  "wf:plan": GATES["wf:plan"],
  "wf:build": {
    id: "daily-build",
    // v2：判定顺序=用户确认 → lane 分组表（M/L，并行优先硬卡——串行须以 lane 表书面举证）
    //   → lane 依赖边表（效率批 P1，M/L——结构正确性机械化：跨 lane 边须早波次/无环/声明≥层深）
    //   → review 结论（M/L）
    isSatisfiedBy: (st) => !!st.verdicts?.confirmedAt
      && (tierOf(st.size) === "S" || !!st.verdicts?.laneTableWritten)
      && (tierOf(st.size) === "S" || st.verdicts?.laneDepsOk === true)
      && (tierOf(st.size) === "S" || st.verdicts?.planReview === "PASS"),
    explain: (st) => (!st.verdicts?.confirmedAt ? CONFIRM_GATE_MSG
      : (tierOf(st.size) !== "S" && !st.verdicts?.laneTableWritten) ? LANE_TABLE_GATE_MSG
      : (tierOf(st.size) !== "S" && st.verdicts?.laneDepsOk !== true) ? LANE_DEPS_GATE_MSG
      : gateDailyVerifyMsg(st.verdicts?.planReview)),
  },
  "wf:done": GATES["wf:done"],
};

// ── T2.1：WorkflowProfile 注册表（Strategy 唯一消费面）──────────────────────
// 模式=数据三元组（flows/gates/phases）；guidance 文案派发留在编排层 guidance.ts
// （GUIDANCE_BY_ID 按 profile.id 查表，键集一致性由 tests/profile-shape.test.js 锁死）。
// 新增模式=registerProfile 一处 + GUIDANCE_BY_ID 一行（成对守卫，漏一处即测试红）。
/** WorkflowProfile 注册表（Strategy 唯一消费面）：新增模式=registerProfile 一处注册。 */
export const PROFILES: Record<string, WorkflowProfile> = {};
/**
 * 注册一个模式 profile（id 为唯一键，重复注册即覆盖）。
 * @param p 待注册的模式 profile
 * @returns 无返回值（写入模块级 PROFILES 表）
 */
export function registerProfile(p: WorkflowProfile): void { PROFILES[p.id] = p; }
// mode 选择：存量无 mode → full（兼容）；daily 用子表。所有流转/关卡/指引/下一步提示同源此判定
//（isDaily 判定点全仓唯一=本函数；其余消费方一律 profileOf(st).id）。
/**
 * 按状态取所属模式 profile（isDaily 唯一判定点的下游出口；存量无 mode 视为 full）。
 * @param st 当前工作流状态
 * @returns 状态所属模式的 profile
 */
export function profileOf(st: WfState): WorkflowProfile { return PROFILES[isDaily(st) ? "daily" : "full"]; }
registerProfile({ id: "full", flows: FLOWS, gates: GATES, phases: PHASES_FULL });
registerProfile({ id: "daily", flows: FLOWS_DAILY, gates: GATES_DAILY, phases: PHASES_DAILY });

/**
 * 判定状态是否日常模式（mode 缺省视为 full，存量兼容）——isDaily 判定点全仓唯一。
 * @param st 当前工作流状态
 * @returns 日常模式为 true，否则 false
 */
export function isDaily(st: WfState): boolean { return (st.mode ?? "full") === "daily"; }
/**
 * 查状态所属模式的流转边定义。
 * @param st 当前工作流状态
 * @param cmd 命令名
 * @returns 对应流转边定义，未注册时 undefined
 */
export function flowFor(st: WfState, cmd: string): FlowDef | undefined { return profileOf(st).flows[cmd]; }
/**
 * 查状态所属模式的命令级关卡。
 * @param st 当前工作流状态
 * @param cmd 命令名
 * @returns 对应关卡定义，未注册时 undefined
 */
export function gateFor(st: WfState, cmd: string): Gate | undefined { return profileOf(st).gates[cmd]; }
/**
 * 查状态所属模式的下一步指引（未知阶段回退 /wf:intake）。
 * @param st 当前工作流状态
 * @param phase 当前阶段名
 * @returns 下一步指引文案
 */
export function nextFor(st: WfState, phase: string | null | undefined): string {
  return profileOf(st).phases[phase ?? ""]?.next ?? "/wf:intake";
}

// ── 流转校验+应用（P0-b 提取自 transition 闭包，行为与 M16 一致）────
// 通过 → 原地完成 counter 递增（进入即计数）与 intake 重置/slug 设置，返回 { ok: true }；
//       调用方随后设 st.phase=FLOWS[cmd].to、st.updatedAt，并负责 log/save/inject/emit。
// 拒绝 → 返回 { ok: false, note, msg }（拒绝发生在计数之前，不消耗循环额度）；
//       gate 拒绝另附 gate=Gate.id（审计细分，logAdd 据此写 "gate-rejected:<id>"——note 本体逐字不变）。
// st 须带 rounds: { plan_review, build_review, test_fix }。
// P2：limits 可按实例覆盖（options.limits），默认取模块 LIMITS。

/**
 * 流转校验+应用核心：按序做命令存在性→来源阶段合法性→关卡判定（附 gateStatus 快照）→
 * 循环计数（进入即计数）→ intake 守卫与任务重置/slug/size/mode 解析。
 * 通过=原地完成计数与重置（调用方随后设 phase/updatedAt 并 log/save/inject/emit）；
 * 拒绝=不消耗循环额度（计数发生在拒绝之后）。
 * @param cmd 流转命令名（如 "wf:plan"）
 * @param st 当前状态（须带 rounds，允许被原地改写）
 * @param text 命令原始参数（intake 解析 [S]/[M]/[L]/[FULL] 前缀与 ! 强制符）
 * @param at 判定时刻（写 gateStatus 快照与 timing）
 * @param limits 循环上限覆盖（缺省模块 LIMITS）
 * @returns {ok:true} 或 {ok:false, note, msg, gate?}（gate 仅关卡拒绝时附 Gate.id）
 */
export function evaluateTransition(cmd: string, st: WfState, text: unknown, at = new Date().toISOString(), limits: Limits = LIMITS): TransitionResult {
  // M16-r34：mode 选择流转表/关卡/下一步（daily 子表 vs full；存量无 mode → full 兼容）
  // R2 T2.1：经 profileOf 单点判定（p.id 取代 daily 布尔消费）
  const p = profileOf(st);
  const flow = p.flows[cmd];
  const from = st.phase ?? null;

  // daily 子表无 test-design/reconcile/review-build → 显式拒绝（防 flow undefined 崩溃）
  if (!flow) {
    const daily = p.id === "daily";
    return {
      ok: false, note: REJECT_NOTES.UNKNOWN_COMMAND,
      msg: `❌ ${daily ? "日常模式" : "完整模式"}无 /wf:${cmd.slice(3)} 命令。${daily ? "日常流：plan→review→build→test→done（FAIL→fix 返工）。" : ""}当前下一步：${nextFor(st, from)}`,
    };
  }

  if (!(flow.from.includes("*") || flow.from.includes(from ?? ""))) {
    return {
      ok: false, note: REJECT_NOTES.ILLEGAL_TRANSITION,
      msg: `❌ 拒绝：/wf:${cmd.slice(3)} 不能从阶段「${from ?? "无"}」进入「${flow.to}」（合法来源：${flow.from.join("/") || "无"}）。当前下一步：${nextFor(st, from)}`,
    };
  }

  // M5：进阶关卡（在轮次计数之前拒绝，不消耗循环额度）
  // R2 T2.3：Gate 判定+快照记账（verdicts.gateStatus 覆写=最近一次判定；levelFor 结构化输入）
  const gate = p.gates[cmd];
  if (gate) {
    const ok = gate.isSatisfiedBy(st);
    st.verdicts = { ...st.verdicts, gateStatus: { id: gate.id, ok, at } }; // R3 T3.1 子步 B：快照写点入 verdicts
    if (!ok) return { ok: false, note: REJECT_NOTES.GATE_REJECTED, msg: gate.explain(st), gate: gate.id };
  }

  // M10-a：计数器改为「进入即计数、永不重置」（修 S2：旧规则 from===to 才 +1，
  // 而 wf:fix 恒为 testing→fixing 不相等 → test_fix 永远=1，上限形同虚设）。
  // 首次进入=1（首次审核 / 首次执行审核 / 首次修复），重复进入递增，达上限拒绝。
  if (flow.counter) {
    const cap = limits[flow.counter] ?? LIMITS[flow.counter];
    if ((st.rounds[flow.counter] ?? 0) >= cap) {
      return {
        ok: false, note: REJECT_NOTES.LIMIT_EXCEEDED,
        msg: `🛑 硬关卡：${flow.counter} 已 ${st.rounds[flow.counter]}/${cap} 轮，禁止继续循环。请停止自动化流程并向用户上报，由用户裁决。`,
      };
    }
    st.rounds[flow.counter] += 1;
  }

  // M10-a：intake 守卫 + 任务级重置（S3+A8：旧版换任务不清 artifacts/testPlanWritten，
  // 新任务可凭旧状态蒙混过双通道/验收关卡；中途 intake 也会误丢进度）
  if (cmd === "wf:intake") {
    const raw = promptText(text).trim();
    const force = raw.startsWith("!");
    if (from && from !== "done" && !force) {
      return {
        ok: false, note: REJECT_NOTES.INTAKE_GUARD,
        msg: `❌ 已有活动任务：slug=${st.slug || "(未定)"} phase=${from}。若要中止请推进 /wf:reset；确要强制切换推进 /wf:intake ! <新slug>（leader 用 wf_command，用户手敲亦可）。`,
      };
    }
    if (from === "done" || force || !st.slug) {
      if (st.slug) st.prev = { slug: st.slug, phase: from, at: st.updatedAt ?? at };
      st.rounds = { plan_review: 0, build_review: 0, test_fix: 0 };
      st.artifacts = {};
      st.lanes = {};
      st.reuse = { ...st.reuse, roleSessions: {} }; // M16-r40：新任务不得复用旧任务的子会话（R3 T3.1 子步 C）
      // R3 T3.1 子步 B：verdicts 家族整组重置（子对象内字段=组全集，覆写空组即逐字等价旧 5 行 delete）
      st.verdicts = {};
      st.delivery = {}; // R3 T3.1 子步 D：delivery 整组重置（doneGit+selfMod=组全集，等价旧两行 delete）
      // tui-sidebar-elapsed T01（plan §3.2）：新任务重置计时账（强制重 intake !slug 同块覆盖）
      // R3 T3.1 子步 A：timing 整组重置（子对象内字段=组全集，整组覆写即逐字等价旧 4 行）
      st.timing = { startedAt: at, phaseEnteredAt: at, phaseDurations: {} };
    }
    // M16-r33 P2 体量前缀 [S]/[M]/[L] + M16-r34 模式前缀 [FULL]（可跟在 ! 强制符后，任意序）。
    // 新 intake 默认 daily（日常习惯流）；[FULL] 显式完整 9 阶段流。size 缺省 M。
    let body = force ? raw.slice(1).trim() : raw;
    let size = "M";
    let mode = "daily";
    let pm;
    while ((pm = body.match(/^\[(FULL|S|M|L)\]\s*/i))) {
      const tok = pm[1].toUpperCase();
      if (tok === "FULL") mode = "full"; else size = tok;
      body = body.slice(pm[0].length);
    }
    // R3 T3.2：slug 唯一构造点（|| 链拓宽为 string，收窄回 Slug——三分支皆经 slugify/既有 Slug）
    st.slug = (slugify(body) || st.slug || slugify("untitled")) as Slug;
    st.size = size;
    st.mode = mode;
  }

  // M16-r44：方案确认关卡——重开规划（wf:plan）即作废旧确认，wf:build 关卡要求重新交互确认
  if (cmd === "wf:plan") delete st.verdicts?.confirmedAt; // R3 T3.1 子步 B：确认作废改子对象字段

  return { ok: true };
}
