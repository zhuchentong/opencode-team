// wf-workflow — 阶段指引（M16-r39 T08：自 lib.ts 拆分，文案逐字不变）。
// 依赖方向单向：guidance → lib（LIMITS/isDaily/budgetFor + 类型），lib 不反向 import 本文件
// （禁 lib re-export guidance 兜底，防 lib→guidance→lib 环）。
// entryValue/guidance 消费方：commands.ts inject/transition 与 tests（daily-mode/p3-hint/
// p2-limits/artifact-budget/diagnose/phase-discipline/m4-smoke）。
import { LIMITS, isDaily, budgetFor, type Limits, type WfState } from "./lib.ts";

// P1：写入 instructions entry 的值——机器可读头行 + 完整阶段 guidance。
// 依据（官方 docs/build/plugins/server §Sessions）：entries 渲染为系统提示中的
// <context key="..."> 块，每次模型调用从存储重新组装 ⇒ 天然抗 compaction（superpowers 的
// post-compaction 重注入目标由此免费获得）。done 为终态，只留一行提示，不长期占用系统提示。
export const DONE_ENTRY = "wf 工作流已完成（done）。新任务：/wf:intake <slug>；清除状态：/wf:reset。";
export function entryValue(st: WfState, limits: Limits = LIMITS, overrides: string[] = []): string {
  const head = `phase=${st.phase} slug=${st.slug} rounds=${JSON.stringify(st.rounds ?? {})}`;
  if (st.phase === "done") return `${head}\n${DONE_ENTRY}`;
  return `${head}\n${guidance(st.phase, st, limits, overrides)}`;
}

export function guidance(phase: string | null | undefined, st: WfState, limits: Limits = LIMITS, overrides: string[] = []): string {
  // M16-r34：daily 模式用日常习惯流指引（tier 分支）；full/存量用 guidanceBase
  const base = isDaily(st) ? guidanceDaily(phase, st, limits) : guidanceBase(phase, st, limits);
  if (Array.isArray(overrides) && overrides.length) {
    const list = overrides.map((f) => String(f).replace(/\.md$/, "")).join(", ");
    return `${base}\n📌 项目级角色定制（.workflow/overrides/）：${list}。委派同名 wf 角色时，把对应文件全文带入子任务提示词。`;
  }
  return base;
}

// M16-r33 P1b：写入者契约——子代理自写产物（leader 代写=双倍生成：回复一遍+tool 入参一遍），
// 修订用 patch 只输出变更段。真机取证：todolist leader 代写 3 产物；implant 子代理自写只付一次。
const WRITE_CONTRACT = "写入契约：产物由子代理自行调用 wf_write_artifact 落盘，leader 禁止代写（双倍生成成本）；回执只带摘要+路径+证据，勿回传全文。修订先读产物原文，用 patch 只输出变更段（old 逐字摘录）。plan 修订会清 review 结论与 test-plan 记账，修订后须重新 wf:review（full 模式另须 wf:test-design）。";
// M16-r33 P2：双通道预算注入——phase guidance 渲染当前级预算（leader 自看），委派 prompt 也须携带（子代理看）
function budgetLine(st: WfState, kinds: string[]): string {
  const tier = st.size === "S" ? "S" : "M";
  const parts = kinds.map((k) => `${k}≤${budgetFor(k, tier)}KB`).join("、");
  return `产物预算（${tier} 级，字节计）：${parts}。委派 prompt 必须携带本预算；超预算用 patch 删减，勿全量重写。`;
}
function leanLine(st: WfState): string | null {
  return st.size === "S" ? "S 级从简：产物按 S 预算，审核聚焦关键风险，勿过度设计（比例化投入，不跳阶段）。" : null;
}

// ── M16-r40：会话复用可靠化——重委派点渲染自动登记的完整子会话 ID ──────────────
// 根因：旧指引只说「续用上轮 sessionID」却不递 ID，leader 凭记忆复述长随机 ses_ 串→截断→
//   重试→冷启动。此处把插件自动登记的完整 ID 新鲜、权威地渲染进 guidance（entry 抗 compaction），
//   leader 逐字复制即可；无登记→不渲染（首次委派自然新建）。仅续用已完成的子会话（防静默分叉）；续用失败立即新建，勿反复重试。
function reuseLine(st: WfState, agent: string): string | null {
  const sid = st.roleSessions?.[agent]?.sessionID;
  if (!sid) return null;
  return `续用 ${agent} 子会话：sessionID=${sid}（仅续用已完成的子会话；把本 ID 逐字复制到 subagent 的 sessionID 参数，勿凭记忆复述或截断；续用失败立即新建，勿反复重试）。`;
}
function reuseLines(st: WfState, ...agents: string[]): string[] {
  return agents.map((a) => reuseLine(st, a)).filter((x): x is string => x !== null);
}

// ── M16-r34：日常模式指引——忠实用户 5 步习惯，tier 只改委派与否 ──────────────────
// S=leader 全程串行零 sub-agent（亲自实现+自写产物+自验，覆盖「不亲自实现」与 WRITE_CONTRACT 两条契约）；
// M/L=planner 拆 T<nn> 功能点 + reviewer 独立五维验证 + builder 逐点 TDD + tester 独立核对。
const SELF_CONTRACT = "S 级日常模式：leader 亲自实现+自写产物（wf_write_artifact 自行落盘），全程零 sub-agent 串行——本条覆盖默认「不亲自实现」与「leader 禁代写」契约。验证在对话里完成（不落 verify 文件），PASS 须附真实跑测证据（命令+输出）。";
function guidanceDaily(phase: string | null | undefined, st: WfState, limits: Limits = LIMITS): string {
  const L = { ...LIMITS, ...limits };
  const s = st.slug || "(未定)";
  const r: Record<string, number> = st.rounds ?? {};
  const S = st.size === "S";
  switch (phase) {
    case "intake": return [
      `【wf 工作流｜intake·日常模式】slug=${s}（体量 ${st.size ?? "M"}）`,
      `日常流：plan（讨论方案）→ review（/verify 独立验证）→ 按问题修订 → build（执行）→ test（核对）→ done。`,
      `1) 与用户澄清需求；2) 读项目 .learnings/ 相关经验；3) 确保 .gitignore 含 .workflow/ 与 .learnings/。`,
      S ? `S 级：全程 leader 主流程串行，零 sub-agent，产物从简。` : `M/L 级：planner 拆功能点、reviewer 独立验证、builder 执行、tester 独立核对。`,
      `⚠️ 阶段纪律：本阶段只做需求澄清，勿委派任何 wf 角色、勿产 plan/review 产物。`,
      `完成 → wf_command(name="wf:plan")`,
    ].join("\n");
    case "planning": return [
      `【wf 工作流｜planning·日常模式】slug=${s}`,
      `⚠️ 本阶段禁止修改业务代码（放行：.workflow/、.learnings/、测试目录）。`,
      S ? `S 级：leader 亲自拟定轻量 plan（需求+方案+验收标准），用 wf_write_artifact(kind=plan) 自写。${SELF_CONTRACT}`
        : `委派 wf/planner：把任务拆成 T<nn> 功能点分节（每点：范围+接口签名+验收标准+验证方式），wf_write_artifact(kind=plan) 自写。`,
      ...(S ? [] : [WRITE_CONTRACT, `委派契约：prompt 只带需求摘录+相关 .learnings/+产物路径+预算，声明子代理禁止全仓扫描。`, ...reuseLines(st, "wf/planner")]),
      budgetLine(st, ["plan"]),
      ...(leanLine(st) ? [leanLine(st)] : []),
      `完成 → wf_command(name="wf:review")`,
    ].join("\n");
    case "review": {
      const lines = [
        `【wf 工作流｜review·日常模式（第 ${r.plan_review}/${L.plan_review} 轮）】slug=${s}`,
        `⚠️ 本阶段禁止修改业务代码（放行：.workflow/、.learnings/、测试目录）。`,
        S ? `S 级：leader 按五维（可行性/完整性/正确性/风险/交叉验证）自验 plan，在对话里给出结论；发现问题→修订 plan 再验。`
          : `委派 wf/planner-reviewer 独立五维验证 plan.md（可行性/完整性/正确性/风险/交叉验证）→ wf_write_artifact(kind=plan-review)，首行 **结论**: PASS|FAIL。`,
        ...(S ? [] : [WRITE_CONTRACT, `委派契约：prompt 只带 plan.md 路径+任务行摘录+预算，禁止全仓扫描。`]),
        budgetLine(st, S ? ["plan"] : ["plan-review"]),
      ];
      if (!S && (r.plan_review ?? 0) >= 2) {
        lines.push(`增量复审（第 ${r.plan_review} 轮）：续用上轮 reviewer sessionID；范围=上轮 findings 销项 + plan.md 修订 diff + 一致性抽查，勿全文重审。`);
        lines.push(...reuseLines(st, "wf/planner-reviewer"));
      }
      lines.push(S
        ? `自验通过 → wf_command(name="wf:build")；不过 → 修订 plan 后再验；超限 → 停下问用户`
        : `FAIL → wf_command(name="wf:plan") 带意见修订再 wf:review；PASS → wf_command(name="wf:build")（关卡校验 plan-review 结论）；超限 → 停下问用户`);
      return lines.join("\n");
    }
    case "building": {
      const rework = (r.test_fix ?? 0) > 0 ? `（返工第 ${r.test_fix} 轮：按 test-report FAIL 项修复，复用原 builder sessionID）` : "";
      return [
        `【wf 工作流｜building·日常模式】slug=${s}${rework}`,
        S ? `S 级：leader 主树亲自 TDD（先写失败测试再实现），不委派、不开 worktree。${SELF_CONTRACT}`
          : `委派 wf/builder：按 T<nn> 功能点逐点 TDD（红测试从 plan 验收标准写，先红后绿），主树串行（多 builder 并行=例外，需用户同意+worktree）。`,
        ...(S ? [] : [WRITE_CONTRACT, `委派契约：prompt 给任务行摘录+接口签名+验收标准+预算，禁止全仓扫描、勿贴整份 plan。`, ...reuseLines(st, "wf/builder")]),
        `完成（含红→绿证据）→ wf_command(name="wf:test")`,
      ].join("\n");
    }
    case "testing": return [
      `【wf 工作流｜testing·日常模式】slug=${s}`,
      S ? `S 级：leader 跑全量测试自核对，wf_write_artifact(kind=test-report) 自写，首行 **结论**: PASS|FAIL，PASS 附真实证据（命令+输出）。`
        : `委派 wf/tester(mode=verify) 独立核对 → wf_write_artifact(kind=test-report)，首行 **结论**: PASS|FAIL。`,
      ...(S ? [] : [WRITE_CONTRACT]),
      budgetLine(st, ["test-report"]),
      `PASS → wf_command(name="wf:done")；FAIL → wf_command(name="wf:fix")（回 building 返工，test_fix≤${L.test_fix}）`,
    ].join("\n");
    case "done": return [
      `【wf 工作流｜done·日常模式】slug=${s}`,
      S ? `S 级：leader 简短汇报核对结果（不委派 learner）；如有可沉淀经验，自写 3 行 lessons。`
        : `审计并汇报；test-report=PASS 后并行委派 wf/learner 复盘沉淀（不阻塞交付）。`,
      ...(S ? [] : [WRITE_CONTRACT, `委派 wf/learner 须声明：learner 不推进状态机（不调 wf_command/不 /wf:*），仅写 .learnings/ 与 lessons.md。`]),
      budgetLine(st, ["lessons"]),
    ].join("\n");
    default: return `【wf 工作流·日常模式】阶段 ${phase}`;
  }
}

function guidanceBase(phase: string | null | undefined, st: WfState, limits: Limits = LIMITS): string {
  const L = { ...LIMITS, ...limits };
  const s = st.slug || "(未定)";
  const r: Record<string, number> = st.rounds ?? {};
  switch (phase) {
    case "intake": return [
      `【wf 工作流｜intake】slug=${s}`,
      `1) 与用户澄清需求；2) 读项目 .learnings/ 相关经验带入后续阶段；3) 确保 .gitignore 含 .workflow/ 与 .learnings/。`,
      `体量分级：intake prompt 用前缀 [S]/[M]/[L] 声明任务体量（简易/演示=S，常规=M，跨模块/大型=L；缺省 M），如 wf_command(name="wf:intake", prompt="[S] my-task")。S 级产物预算收紧、全程从简。`,
      `⚠️ 阶段纪律：本阶段只做需求澄清，勿委派任何 wf 角色（planner/reviewer/tester 均属后续阶段）；更勿在此产出 plan/review 产物后再 !intake 重置（会清空记账、账实不符）。`,
      `完成 → 调用 wf_command 工具推进（name="wf:plan"；以下同此格式，用户手敲 /wf:plan 亦可）`,
    ].join("\n");
    case "planning": return [
      `【wf 工作流｜planning】slug=${s}`,
      `⚠️ 本阶段禁止修改业务代码（项目外路径不属业务代码；放行：.workflow/、.learnings/、测试目录）。`,
      `委派 subagent wf/planner → 产物用 wf_write_artifact(kind=plan) 写入（含 T01… 任务清单、接口签名、每条验收标准的验证方式）。`,
      `⚠️ 阶段纪律：本阶段只委派 wf/planner；reviewer/tester 属 review 阶段，禁止提前委派（产物错位会重复写、浪费工时，wf_write_artifact 将告警）。`,
      `委派契约：prompt 只带需求摘录+相关 .learnings/ 条目+产物路径，声明子代理禁止全仓扫描（只读点名文件），压冷启动耗时。`,
      WRITE_CONTRACT,
      ...reuseLines(st, "wf/planner"),
      budgetLine(st, ["plan"]),
      ...(leanLine(st) ? [leanLine(st)] : []),
      `完成 → wf_command(name="wf:review")`,
    ].join("\n");
    case "review": {
      const lines = [
        `【wf 工作流｜review（第 ${r.plan_review}/${L.plan_review} 轮）】slug=${s}`,
        `⚠️ 本阶段禁止修改业务代码（项目外路径不属业务代码；放行：.workflow/、.learnings/、测试目录）。`,
        `并发委派（同一轮内各 subagent 用 background=true 同时发出，两路完成通知到齐后再裁决，勿逐个前台等待）：`,
        `  a) wf/planner-reviewer（五角度，审 plan.md → wf_write_artifact(kind=plan-review)）；`,
        `  b) wf/tester(mode=feasibility，仅产出 test-plan.md：验收用例设计+可测性评审，用 wf_write_artifact(kind=test-plan)，不写任何代码文件)。`,
        `委派契约：prompt 只带 plan.md 路径与任务行摘录，声明子代理禁止全仓扫描（只读产物点名文件）。`,
        WRITE_CONTRACT,
        budgetLine(st, ["plan-review", "test-plan"]),
        ...(leanLine(st) ? [leanLine(st)] : []),
      ];
      if ((r.plan_review ?? 0) >= 2) {
        lines.push(`增量复审（第 ${r.plan_review} 轮）：续用上轮 reviewer 的 sessionID 委派（省冷启动）；复核范围=上轮 plan-review-r${(r.plan_review ?? 1) - 1}.md 的 findings 逐条销项 + 本轮 plan.md 修订 diff 全文（防返工引入新缺陷）+ 交叉一致性抽查，勿全文重审。`);
        lines.push(...reuseLines(st, "wf/planner-reviewer"));
      }
      lines.push(
        `任一不通过 → wf_command(name="wf:plan") 回规划并带意见委派 wf/planner，再 wf_command(name="wf:review")；双通道通过 → wf_command(name="wf:test-design")（关卡随迁：须 test-plan.md 已产出）；超限 → 停下问用户`,
      );
      return lines.join("\n");
    }
    case "test_design": return [
      `【wf 工作流｜test_design】slug=${s}`,
      `硬关卡（M16-r28：原 assign 阶段并入本阶段）：计划审核已通过 且 test-plan.md（可行性拍）已产出，入口服务端校验。`,
      `先冻结接口，按 T<nn> 排串行执行顺序（默认一个 wf/builder 串行完成整场任务；多 builder 并行拆树=例外，需用户同意）。`,
      `委派 wf/tester(mode=design)：按已冻结接口在主树测试目录写会失败的验收/集成测试（红），作为执行 worktree 的 TDD 锚点。`,
      `委派契约：prompt 只带 test-plan.md/plan.md 接口签名段落，禁止全仓扫描；优先续用 feasibility 拍 wf/tester 的 sessionID（省冷启动）。`,
      ...reuseLines(st, "wf/tester"),
      `发现接口问题 → wf_command(name="wf:plan") 回规划修订（返工边）；完成 → wf_command(name="wf:build")`,
    ].join("\n");
    case "building": return [
      `【wf 工作流｜building】slug=${s}`,
      `默认：开一个 worktree，一个 wf/builder 在树内按序串行完成全部 T<nn>（逐任务 TDD 先红后绿）；建树后把 test_design 产出的红测试复制进树并 md5 核对；prompt 给 worktree 绝对路径+按序任务清单（勿贴整份 plan——只给任务行摘录+接口签名，省子代理冷启动）。多树并行=例外（写集互斥+用户同意）。`,
      `全部回执齐备（含红→绿证据）→ wf_command(name="wf:reconcile")`,
    ].join("\n");
    case "reconcile": return [
      `【wf 工作流｜reconcile】slug=${s}`,
      `合并 worktree 产物回主树（单树=一次合并；主树跑构建+冒烟即可，全量验证留给 testing 阶段，勿重复跑全量）。`,
      `清理前先 rm 树内已合并的 untracked 副本再非 force 移除；冲突/数字不符 → 停下问用户，不自动解决。`,
      `合并完成 → wf_command(name="wf:review-build")`,
    ].join("\n");
    case "build_review": return [
      `【wf 工作流｜build_review（第 ${r.build_review}/${L.build_review} 轮）】slug=${s}`,
      `委派 wf/builder-reviewer（按 T<nn> 查完成度 + 代码质量 + 测试质量）。`,
      WRITE_CONTRACT,
      ...reuseLines(st, "wf/builder", "wf/builder-reviewer"),
      budgetLine(st, ["build-review"]),
      `有遗漏 → wf_command(name="wf:build") 返工（重派 wf/builder），修完 wf_command(name="wf:reconcile") → name="wf:review-build"；通过 → wf_command(name="wf:test")；超限 → 停下问用户`,
    ].join("\n");
    case "testing": return [
      `【wf 工作流｜testing】slug=${s}`,
      `委派 wf/tester(mode=verify) → wf_write_artifact(kind=test-report)，首行 **结论**: PASS|FAIL。`,
      WRITE_CONTRACT,
      budgetLine(st, ["test-report"]),
      `PASS → wf_command(name="wf:done")；FAIL → wf_command(name="wf:fix")`,
    ].join("\n");
    case "fixing": return [
      `【wf 工作流｜fixing（第 ${r.test_fix}/${L.test_fix} 轮）】slug=${s}`,
      `失败优先回原 builder（复用 sessionID，在其 worktree 内修，修完重新合并核验）；根因不明/跨模块 → wf/fixer。`,
      ...reuseLines(st, "wf/builder", "wf/fixer"),
      `修改过 worktree 则先 wf_command(name="wf:reconcile") 回主树合并，再 wf_command(name="wf:test")；超限 → 停下问用户`,
    ].join("\n");
    case "done": return [
      `【wf 工作流｜done】slug=${s}`,
      `审计并汇报；test-report=PASS 后并行委派 wf/learner 复盘沉淀（不阻塞交付）。`,
      WRITE_CONTRACT,
      budgetLine(st, ["lessons"]),
      `委派 wf/learner 时必须声明：learner **不推进状态机**——不调用 wf_command、不执行任何 /wf:* 命令、不 wf:intake 新任务、不 reset；仅写 .learnings/ 与（经工具）lessons.md。若 wf_write_artifact 报「无活动任务」，停止并向 leader 报告，不得绕道。`,
    ].join("\n");
    default: return `【wf 工作流】阶段 ${phase}`;
  }
}