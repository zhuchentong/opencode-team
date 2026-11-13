// wf-workflow — domain/flow：流转表/阶段表/关卡与 evaluateTransition。
// R2（arch-r2-profile-statemachine）重构三合一（行为不变，形状收敛）：
//   T2.1 Strategy：flows/gates/phases 收进 WorkflowProfile，PROFILES 模块装载册（full/daily 自注册），
//        profileOf 为 isDaily 唯一消费点——flowFor/gateFor/nextFor/evaluateTransition 一律经 profile 取表；
//   T2.2 State Object：NEXT/NEXT_DAILY 五处阶段映射中的 next/blocking 并入 PhaseDef 单点注册，
//        NEXT/NEXT_DAILY 降为派生导出（值逐字节不变，tests/daily-mode/brief-level 锚零改动）；
//   T2.3 Specification：GATES 表值=Gate 对象（id/isSatisfiedBy/explain 判定与解释分离），
//        拒绝文案迁 shared/prompts/gates.ts（字节级），gate 判定快照写 st.gateStatus，
//        拒绝返回附 gate 字段（note 值逐字不变——commands.ts logAdd 据此细化审计面）。
// P2 limits 覆盖、M16-r34 daily 子表、M10-a「进入即计数」语义与旧 lib.ts 逐字一致。
import { LIMITS, REJECT_NOTES, promptText, slugify, tierOf, type FlowDef, type Gate, type Limits, type PhaseDef, type TransitionResult, type WfState, type WorkflowProfile } from "./types.ts";
import { CONFIRM_GATE_MSG, GATE_DUAL_CHANNEL_MSG, gateAcceptanceMsg, gateDailyVerifyMsg } from "../../shared/prompts/gates.ts";

// M16-r28（性能审计批次 1/2）：B1-1 shell 误伤翻案（=>/比较符/tee<）+ guard 项目 containment
//   （项目外写放行，对齐 shell 分支语义）；B1-2~B1-5 guidance 提速（reconcile 去全量、并发委派、
//   委派上下文契约、review 增量复审）；批次 2：assign 阶段并入 test_design（实测 assign 零实质工作，
//   双通道关卡随迁至 wf:test-design 入口；LEGACY_PHASES 兼容在途任务）。
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
export const NEXT: Record<string, string> = fromPhases(PHASES_FULL);
export const NEXT_DAILY: Record<string, string> = fromPhases(PHASES_DAILY);

// ── M5：命令级进阶关卡（Gate 对象化后语义不变：不满足=拒绝，explain=拒绝理由）──────────
// M16-r28：双通道关卡原挂 wf:assign（assign 阶段已并入 test_design），迁移至 wf:test-design 入口，
//   语义不变：计划审核（流转合法性）之外，还须 tester 已产出 test-plan.md（M3 记账 testPlanWritten）
// wf:done 验收：test-report.md 的「**结论**」必须为 PASS（wf_write_artifact 解析记账 testReportVerdict）
// R2 T2.3：判定（isSatisfiedBy 纯谓词）与解释（explain 文案模板）分离；id=审计/诊断细分维度。
export const GATES: Record<string, Gate> = {
  "wf:test-design": {
    id: "dual-channel",
    isSatisfiedBy: (st) => !!st.testPlanWritten,
    explain: () => GATE_DUAL_CHANNEL_MSG,
  },
  // M16-r44：方案确认关卡（full 模式；daily 用 GATES_DAILY["wf:build"] 同源校验）
  "wf:build": {
    id: "plan-confirm",
    isSatisfiedBy: (st) => !!st.planConfirmedAt,
    explain: () => CONFIRM_GATE_MSG,
  },
  "wf:done": {
    id: "acceptance",
    isSatisfiedBy: (st) => st.testReportVerdict === "PASS",
    explain: (st) => gateAcceptanceMsg(st.testReportVerdict),
  },
};

// ── M16-r34：日常模式（daily）——自动化用户 5 步习惯 plan→verify→修订→执行→核对 ──────────
// 一条流全 tier（S/M/L），tier 只改委派与否（guidance 分支）；砍 test_design/reconcile/build_review/fixing。
// 完整 FLOWS 不动（full 模式/存量在途任务用），daily 用本子表。FAIL 返工复用 wf:fix（改指 building）+ test_fix 计数。
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
// R2 T2.3：daily wf:build 关卡=确认（全 tier 必经）+ M/L 独立验证结论双要素；
// S 只跳结论不跳确认；size 判定走 tierOf（T2.1 TierCtx 纪律：`st.size ===` 字面清零）。
export const GATES_DAILY: Record<string, Gate> = {
  "wf:build": {
    id: "daily-build",
    isSatisfiedBy: (st) => !!st.planConfirmedAt && (tierOf(st.size) === "S" || st.planReviewVerdict === "PASS"),
    explain: (st) => (!st.planConfirmedAt ? CONFIRM_GATE_MSG : gateDailyVerifyMsg(st.planReviewVerdict)),
  },
  "wf:done": GATES["wf:done"],
};

// ── T2.1：WorkflowProfile 注册表（Strategy 唯一消费面）──────────────────────
// 模式=数据三元组（flows/gates/phases）；guidance 文案派发留在编排层 guidance.ts
// （GUIDANCE_BY_ID 按 profile.id 查表，键集一致性由 tests/profile-shape.test.js 锁死）。
// 新增模式=registerProfile 一处 + GUIDANCE_BY_ID 一行（成对守卫，漏一处即测试红）。
export const PROFILES: Record<string, WorkflowProfile> = {};
export function registerProfile(p: WorkflowProfile): void { PROFILES[p.id] = p; }
// mode 选择：存量无 mode → full（兼容）；daily 用子表。所有流转/关卡/指引/下一步提示同源此判定
//（isDaily 判定点全仓唯一=本函数；其余消费方一律 profileOf(st).id）。
export function profileOf(st: WfState): WorkflowProfile { return PROFILES[isDaily(st) ? "daily" : "full"]; }
registerProfile({ id: "full", flows: FLOWS, gates: GATES, phases: PHASES_FULL });
registerProfile({ id: "daily", flows: FLOWS_DAILY, gates: GATES_DAILY, phases: PHASES_DAILY });

export function isDaily(st: WfState): boolean { return (st.mode ?? "full") === "daily"; }
export function flowFor(st: WfState, cmd: string): FlowDef | undefined { return profileOf(st).flows[cmd]; }
export function gateFor(st: WfState, cmd: string): Gate | undefined { return profileOf(st).gates[cmd]; }
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
  // R2 T2.3：Gate 判定+快照记账（gateStatus 覆写=最近一次判定；levelFor 结构化输入）
  const gate = p.gates[cmd];
  if (gate) {
    const ok = gate.isSatisfiedBy(st);
    st.gateStatus = { id: gate.id, ok, at };
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
      st.roleSessions = {}; // M16-r40：新任务不得复用旧任务的子会话
      delete st.testPlanWritten;
      delete st.testReportVerdict;
      delete st.planReviewVerdict; // M16-r34：新任务清验证结论
      delete st.planConfirmedAt; // M16-r44：新任务清方案确认记账
      delete st.gateStatus; // R2 T2.3：关卡快照跨任务不残留
      delete st.doneGit; // done-git T01：新任务不得残留旧交付提示
      delete st.selfMod; // selfmod-guard T01：自改记账按新任务目录重算
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
    st.slug = slugify(body) || st.slug || "untitled";
    st.size = size;
    st.mode = mode;
  }

  // M16-r44：方案确认关卡——重开规划（wf:plan）即作废旧确认，wf:build 关卡要求重新交互确认
  if (cmd === "wf:plan") delete st.planConfirmedAt;

  return { ok: true };
}
