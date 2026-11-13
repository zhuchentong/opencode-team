// wf-workflow — 阶段指引（M16-r39 T08：自 lib.ts 拆分，文案逐字不变）。
// 依赖方向单向：guidance → lib（LIMITS/isDaily/budgetFor + 类型），lib 不反向 import 本文件
// （禁 lib re-export guidance 兜底，防 lib→guidance→lib 环）。
// entryValue/guidance 消费方：commands.ts inject/transition 与 tests（daily-mode/p3-hint/
// p2-limits/artifact-budget/diagnose/phase-discipline/m4-smoke）。
import { LIMITS, isDaily, budgetFor, KIND_FILES, SID_ALIAS_USAGE, type Limits, type WfState } from "./lib.ts";

// P1：写入 instructions entry 的值——机器可读头行 + 完整阶段 guidance。
// 依据（官方 docs/build/plugins/server §Sessions）：entries 渲染为系统提示中的
// <context key="..."> 块，每次模型调用从存储重新组装 ⇒ 天然抗 compaction（superpowers 的
// post-compaction 重注入目标由此免费获得）。done 为终态，只留一行提示，不长期占用系统提示。
export const DONE_ENTRY = "wf 工作流已完成（done）。新任务：/wf:intake <slug>；清除状态：/wf:reset。";
export function entryValue(st: WfState, limits: Limits = LIMITS, overrides: string[] = []): string {
  // 易变区纪律（借鉴 my-opencode-deepseek-config 字节稳定前缀）：静态指引在前，
  // 易变内容（轮次/续用 sessionID/head 行）殿后——返工同阶段 r+1、子会话登记只打穿尾部，静态段保 prompt cache。
  const head = `phase=${st.phase} slug=${st.slug} rounds=${JSON.stringify(st.rounds ?? {})}`;
  if (st.phase === "done") return `${DONE_ENTRY}\n${head}`;
  return `${guidance(st.phase, st, limits, overrides)}\n${head}`;
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
// M16-r47（A+B）：真机取证 tui-sidebar-elapsed——慢模型×大 payload 单次 tool call 流式窗口过长，
// ECONNRESET 截断后 harness retry 全量重生成（恶性循环）。契约升级为「小产物单次 content；
// 大产物分段原生写 + 微小 register 记账」：每段流窗口短、断了只丢一段、续写不重生成。
const WRITE_CONTRACT = "写入契约：产物由子代理自行落盘（leader 禁止代写——双倍生成成本）；回执只带摘要+路径+证据，勿回传全文。小产物（≤2KB）直接 wf_write_artifact(kind=…, content) 单次写。大产物（>2KB）分段：首段原生 write 到委派指定的产物路径，后续段用 edit 追加（old=文末唯一锚点，每段≤2KB——缩短单次流式窗口防中断截断）；调用失败先 read 产物尾部从断点续写，禁全量重写；**全部段落落盘后**才 wf_write_artifact(kind=…)（不带 content=注册记账）——结论行在首段，提前注册会以截断内容过关卡。修订先读产物原文，优先原生 edit 或 wf_write_artifact patch 只输出变更段（old 逐字摘录，严格未命中自动模糊回退）。plan 修订会清 review 结论与 test-plan 记账，修订后须重新 wf:review（full 模式另须 wf:test-design）。";
// M16-r47：委派 prompt 渲染产物 canonical 目标路径——子代理写前即知确切文件名（含轮次编号产物），
// 消灭「写错路径→注册报错→重写」浪费（与 KIND_FILES 同源计算，register 以 state 解析为准）。
function artifactPathLine(st: WfState, kind: string): string {
  return `产物目标路径：.workflow/${st.slug || "<slug>"}/${KIND_FILES[kind](st)}`;
}
// M16-r33 P2：双通道预算注入——phase guidance 渲染当前级预算（leader 自看），委派 prompt 也须携带（子代理看）
function budgetLine(st: WfState, kinds: string[]): string {
  const tier = st.size === "S" ? "S" : "M";
  const parts = kinds.map((k) => `${k}≤${budgetFor(k, tier)}KB`).join("、");
  return `产物预算（${tier} 级，字节计）：${parts}。委派 prompt 必须携带本预算；超预算用 patch 删减，勿全量重写。`;
}
function leanLine(st: WfState): string | null {
  return st.size === "S" ? "S 级从简：产物按 S 预算，审核聚焦关键风险，勿过度设计（比例化投入，不跳阶段）。" : null;
}

// ── M16-r40：会话复用可靠化——重委派点渲染续用指引（T02：零回显）──────────
// 根因：旧渲染把登记 ID 新鲜递进上下文诱导转录——「转录→截断→守卫回显→再转录」死循环燃料。
//   现仅以登记做存在性判断：有登记即指路别名/省略新建（sid 不进渲染文本）；无登记→不渲染（首次委派自然新建）。
//   仅续用已完成的子会话（防静默分叉）；续用失败立即新建，勿反复重试。
function reuseLine(st: WfState, agent: string): string | null {
  const sid = st.roleSessions?.[agent]?.sessionID;
  if (!sid) return null; // 无登记→不渲染；sid 仅作存在性检查，不进渲染文本（防回显燃料）
  return `续用 ${agent} 子会话：优先 subagent 传 ${SID_ALIAS_USAGE}；不确定时省略 sessionID（新建，天然免疫截断）；绝不逐字粘贴长 ID（仅续用已完成的子会话；续用失败立即新建，勿反复重试）。`;
}
function reuseLines(st: WfState, ...agents: string[]): string[] {
  return agents.map((a) => reuseLine(st, a)).filter((x): x is string => x !== null);
}

// ── M16-r34：日常模式指引——忠实用户 5 步习惯，tier 只改委派与否 ──────────────────
// S=leader 全程串行零 sub-agent（亲自实现+自写产物+自验，覆盖「不亲自实现」与 WRITE_CONTRACT 两条契约）；
// M/L=planner 拆 T<nn> 功能点 + reviewer 独立五维验证 + builder 逐点 TDD + tester 独立核对。
const SELF_CONTRACT = "S 级日常模式：leader 亲自实现+自写产物（wf_write_artifact 自行落盘；S 级产物在预算内偏小，可直接 content 单次写，无需分段注册），全程零 sub-agent 串行——本条覆盖默认「不亲自实现」与「leader 禁代写」契约。验证在对话里完成（不落 verify 文件），PASS 须附真实跑测证据（命令+输出）。";
function guidanceDaily(phase: string | null | undefined, st: WfState, limits: Limits = LIMITS): string {
  const L = { ...LIMITS, ...limits };
  const s = st.slug || "(未定)";
  const r: Record<string, number> = st.rounds ?? {};
  const S = st.size === "S";
  switch (phase) {
    case "intake": return [
      `【wf 工作流｜intake·日常模式】slug=${s}（体量 ${st.size ?? "M"}）`,
      `日常流：plan（讨论方案）→ review（/verify 独立验证）→ 按问题修订 → build（执行）→ test（核对）→ done。`,
      `1) 与用户澄清需求（一次一问、多选优先，歧义收敛后再推进；完全没听懂→一句话重述确认）；2) 读项目 .learnings/ 相关经验；3) 确保 .gitignore 含 .workflow/ 与 .learnings/。`,
      S ? `S 级：全程 leader 主流程串行，零 sub-agent，产物从简。` : `M/L 级：planner 拆功能点、reviewer 独立验证、builder 执行、tester 独立核对。`,
      `⚠️ 阶段纪律：本阶段只做需求澄清，勿委派任何 wf 角色、勿产 plan/review 产物。`,
      `完成 → wf_command(name="wf:plan")`,
    ].join("\n");
    case "planning": return [
      `【wf 工作流｜planning·日常模式】slug=${s}`,
      `⚠️ 本阶段禁止修改业务代码（放行：.workflow/、.learnings/、测试目录）。`,
      S ? `S 级：leader 亲自拟定轻量 plan（需求+方案+验收标准），用 wf_write_artifact(kind=plan) 自写。${SELF_CONTRACT}`
        : `委派 wf/planner：把任务拆成 T<nn> 功能点分节（每点：范围+接口签名+验收标准+验证方式），wf_write_artifact(kind=plan) 自写。${artifactPathLine(st, "plan")}`,
      ...(S ? [] : [WRITE_CONTRACT, `委派契约：prompt 只带需求摘录+相关 .learnings/+产物路径+预算，声明子代理禁止全仓扫描。`]),
      budgetLine(st, ["plan"]),
      ...(leanLine(st) ? [leanLine(st)] : []),
      `完成 → wf_command(name="wf:review")`,
      ...(S ? [] : reuseLines(st, "wf/planner")),
    ].join("\n");
    case "review": {
      const lines = [
        `【wf 工作流｜review·日常模式】slug=${s}`,
        `⚠️ 本阶段禁止修改业务代码（放行：.workflow/、.learnings/、测试目录）。`,
        S ? `S 级：leader 按五维（可行性/完整性/正确性/风险/交叉验证）自验 plan，在对话里给出结论；发现问题→修订 plan 再验。`
          : `委派 wf/planner-reviewer 独立五维验证 plan.md（可行性/完整性/正确性/风险/交叉验证）→ wf_write_artifact(kind=plan-review)，首行 **结论**: PASS|FAIL。${artifactPathLine(st, "plan-review")}`,
        ...(S ? [] : [WRITE_CONTRACT, `委派契约：prompt 只带 plan.md 路径+任务行摘录+预算，禁止全仓扫描。`,
          `分级审查：初检聚焦验收标准覆盖+可行性硬伤，直接出完整结论；命中升级触发（架构级冲突/粒度不可执行/关键风险漏识别/用户要求）才 Full 全量，报告注明触发。`]),
        budgetLine(st, S ? ["plan"] : ["plan-review"]),
      ];
      if (!S && (r.plan_review ?? 0) >= 2) {
        lines.push(`增量复审（第 ${r.plan_review} 轮）：续用上轮 reviewer sessionID；范围=上轮 findings 当未验证线索逐条确认销项 + plan.md 修订 diff + 一致性抽查，勿全文重审、勿重新推导已确认项。`);
      }
      lines.push(S
        ? `自验通过 → 先用 question 做方案确认（选项标签固定：批准执行/修改方案/终止任务；wf:build 关卡校验确认记账）→ wf_command(name="wf:build")；不过 → 修订 plan 后再验；超限 → 停下问用户`
        : `FAIL → wf_command(name="wf:plan") 带意见修订再 wf:review（plan 修订即作废确认记账）；PASS → 先用 question 做方案确认（选项标签固定：批准执行/修改方案/终止任务）→ wf_command(name="wf:build")（关卡校验 plan-review 结论+确认记账）；超限 → 停下问用户`);
      lines.push(`轮次：第 ${r.plan_review}/${L.plan_review} 轮`);
      if (!S && (r.plan_review ?? 0) >= 2) lines.push(...reuseLines(st, "wf/planner-reviewer"));
      return lines.join("\n");
    }
    case "building": {
      const lines = [
        `【wf 工作流｜building·日常模式】slug=${s}`,
        S ? `S 级：leader 主树亲自 TDD（先写失败测试再实现），不委派、不开 worktree。${SELF_CONTRACT}`
          : `委派 wf/builder：按 T<nn> 功能点逐点 TDD（红测试从 plan 验收标准写，先红后绿），主树串行（多 builder 并行=例外，需用户同意+worktree）。`,
        ...(S ? [] : [WRITE_CONTRACT, `委派契约：prompt 给任务行摘录+接口签名+验收标准+预算，禁止全仓扫描、勿贴整份 plan。`]),
        `完成（含红→绿证据）→ wf_command(name="wf:test")`,
      ];
      if ((r.test_fix ?? 0) > 0) lines.push(`返工第 ${r.test_fix} 轮：按 test-report FAIL 项修复，复用原 builder sessionID。`);
      if (!S) lines.push(...reuseLines(st, "wf/builder"));
      return lines.join("\n");
    }
    case "testing": return [
      `【wf 工作流｜testing·日常模式】slug=${s}`,
      S ? `S 级：leader 跑全量测试自核对，wf_write_artifact(kind=test-report) 自写，首行 **结论**: PASS|FAIL，PASS 附真实证据（命令+输出）。`
        : `委派 wf/tester(mode=verify) 独立核对 → wf_write_artifact(kind=test-report)，首行 **结论**: PASS|FAIL。${artifactPathLine(st, "test-report")}`,
      ...(S ? [] : [WRITE_CONTRACT]),
      budgetLine(st, ["test-report"]),
      `PASS → wf_command(name="wf:done")；FAIL → wf_command(name="wf:fix")（回 building 返工，test_fix≤${L.test_fix}）`,
    ].join("\n");
    case "done": return [
      `【wf 工作流｜done·日常模式】slug=${s}`,
      S ? `S 级：leader 简短汇报核对结果（不委派 learner）；如有可沉淀经验，自写 3 行 lessons。`
        : `审计并汇报；test-report=PASS 后并行委派 wf/learner 复盘沉淀（不阻塞交付）。`,
      ...(S ? [] : [WRITE_CONTRACT, `委派 wf/learner 须声明：learner 不推进状态机（不调 wf_command/不 /wf:*），仅写 .learnings/ 与 lessons.md。${artifactPathLine(st, "lessons")}`]),
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
      `1) 与用户澄清需求（一次一问、多选优先，歧义收敛后再推进；完全没听懂→一句话重述确认）；2) 读项目 .learnings/ 相关经验带入后续阶段；3) 确保 .gitignore 含 .workflow/ 与 .learnings/。`,
      `体量分级：intake prompt 用前缀 [S]/[M]/[L] 声明任务体量（简易/演示=S，常规=M，跨模块/大型=L；缺省 M），如 wf_command(name="wf:intake", prompt="[S] my-task")。S 级产物预算收紧、全程从简。`,
      `⚠️ 阶段纪律：本阶段只做需求澄清，勿委派任何 wf 角色（planner/reviewer/tester 均属后续阶段）；更勿在此产出 plan/review 产物后再 !intake 重置（会清空记账、账实不符）。`,
      `完成 → 调用 wf_command 工具推进（name="wf:plan"；以下同此格式，用户手敲 /wf:plan 亦可）`,
    ].join("\n");
    case "planning": return [
      `【wf 工作流｜planning】slug=${s}`,
      `⚠️ 本阶段禁止修改业务代码（项目外路径不属业务代码；放行：.workflow/、.learnings/、测试目录）。`,
      `委派 subagent wf/planner → 产物用 wf_write_artifact(kind=plan) 写入（含 T01… 任务清单、接口签名、每条验收标准的验证方式）。${artifactPathLine(st, "plan")}`,
      `⚠️ 阶段纪律：本阶段只委派 wf/planner；reviewer/tester 属 review 阶段，禁止提前委派（产物错位会重复写、浪费工时，wf_write_artifact 将告警）。`,
      `委派契约：prompt 只带需求摘录+相关 .learnings/ 条目+产物路径，声明子代理禁止全仓扫描（只读点名文件），压冷启动耗时。`,
      WRITE_CONTRACT,
      budgetLine(st, ["plan"]),
      ...(leanLine(st) ? [leanLine(st)] : []),
      `完成 → wf_command(name="wf:review")`,
      ...reuseLines(st, "wf/planner"),
    ].join("\n");
    case "review": {
      const lines = [
        `【wf 工作流｜review】slug=${s}`,
        `⚠️ 本阶段禁止修改业务代码（项目外路径不属业务代码；放行：.workflow/、.learnings/、测试目录）。`,
        `并发委派（同一轮内各 subagent 用 background=true 同时发出，两路完成通知到齐后再裁决，勿逐个前台等待）：`,
        `  a) wf/planner-reviewer（五角度，审 plan.md → wf_write_artifact(kind=plan-review)，${artifactPathLine(st, "plan-review")}）；`,
        `  b) wf/tester(mode=feasibility，仅产出 test-plan.md：验收用例设计+可测性评审，用 wf_write_artifact(kind=test-plan)，${artifactPathLine(st, "test-plan")}，不写任何代码文件)。`,
        `分级审查：初检聚焦验收标准覆盖+可行性硬伤，直接出完整结论；命中升级触发（架构级冲突/粒度不可执行/关键风险漏识别/用户要求）才 Full 全量，报告注明触发。`,
        `委派契约：prompt 只带 plan.md 路径与任务行摘录，声明子代理禁止全仓扫描（只读产物点名文件）。`,
        WRITE_CONTRACT,
        budgetLine(st, ["plan-review", "test-plan"]),
        ...(leanLine(st) ? [leanLine(st)] : []),
      ];
      if ((r.plan_review ?? 0) >= 2) {
        lines.push(`增量复审（第 ${r.plan_review} 轮）：续用上轮 reviewer 的 sessionID 委派（省冷启动）；复核范围=上轮 plan-review-r${(r.plan_review ?? 1) - 1}.md 的 findings 当未验证线索逐条确认销项 + 本轮 plan.md 修订 diff 全文（防返工引入新缺陷）+ 交叉一致性抽查，勿全文重审、勿重新推导已确认项。`);
      }
      lines.push(
        `任一不通过 → wf_command(name="wf:plan") 回规划并带意见委派 wf/planner，再 wf_command(name="wf:review")（plan 修订即作废确认记账）；双通道通过 → 先用 question 做方案确认（选项标签固定：批准执行/修改方案/终止任务）→ wf_command(name="wf:test-design")（关卡随迁：须 test-plan.md 已产出）；超限 → 停下问用户`,
      );
      lines.push(`轮次：第 ${r.plan_review}/${L.plan_review} 轮`);
      if ((r.plan_review ?? 0) >= 2) lines.push(...reuseLines(st, "wf/planner-reviewer"));
      return lines.join("\n");
    }
    case "test_design": return [
      `【wf 工作流｜test_design】slug=${s}`,
      `硬关卡（M16-r28：原 assign 阶段并入本阶段）：计划审核已通过 且 test-plan.md（可行性拍）已产出，入口服务端校验。`,
      `先冻结接口，按 T<nn> 排串行执行顺序（默认一个 wf/builder 串行完成整场任务；多 builder 并行拆树=例外，需用户同意）。`,
      `委派 wf/tester(mode=design)：按已冻结接口在主树测试目录写会失败的验收/集成测试（红），作为执行 worktree 的 TDD 锚点。`,
      `委派契约：prompt 只带 test-plan.md/plan.md 接口签名段落，禁止全仓扫描；优先续用 feasibility 拍 wf/tester 的 sessionID（省冷启动）。`,
      `发现接口问题 → wf_command(name="wf:plan") 回规划修订（返工边，plan 修订即作废确认记账）；完成 → wf_command(name="wf:build")（确认关卡：此前未经 question 方案确认的先补做，选项标签固定：批准执行/修改方案/终止任务）`,
      ...reuseLines(st, "wf/tester"),
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
      `【wf 工作流｜build_review】slug=${s}`,
      `委派 wf/builder-reviewer（按 T<nn> 查完成度 + 代码质量 + 测试质量）→ wf_write_artifact(kind=build-review)。${artifactPathLine(st, "build-review")}`,
      `分级审查：初检聚焦完成度+关键风险，直接出完整报告；命中升级触发（改动跨 ≥3 模块/触及安全敏感路径/critical-major 无法就地确认/用户要求）才 Full 全量，报告注明触发；r≥2 把上轮 findings 当未验证线索逐条确认，勿重新推导。`,
      WRITE_CONTRACT,
      budgetLine(st, ["build-review"]),
      `有遗漏 → wf_command(name="wf:build") 返工（重派 wf/builder），修完 wf_command(name="wf:reconcile") → name="wf:review-build"；通过 → wf_command(name="wf:test")；超限 → 停下问用户`,
      `轮次：第 ${r.build_review}/${L.build_review} 轮`,
      ...reuseLines(st, "wf/builder", "wf/builder-reviewer"),
    ].join("\n");
    case "testing": return [
      `【wf 工作流｜testing】slug=${s}`,
      `委派 wf/tester(mode=verify) → wf_write_artifact(kind=test-report)，首行 **结论**: PASS|FAIL。${artifactPathLine(st, "test-report")}`,
      WRITE_CONTRACT,
      budgetLine(st, ["test-report"]),
      `PASS → wf_command(name="wf:done")；FAIL → wf_command(name="wf:fix")`,
    ].join("\n");
    case "fixing": return [
      `【wf 工作流｜fixing】slug=${s}`,
      `失败优先回原 builder（复用 sessionID，在其 worktree 内修，修完重新合并核验）；根因不明/跨模块 → wf/fixer。`,
      `修改过 worktree 则先 wf_command(name="wf:reconcile") 回主树合并，再 wf_command(name="wf:test")；超限 → 停下问用户`,
      `轮次：第 ${r.test_fix}/${L.test_fix} 轮`,
      ...reuseLines(st, "wf/builder", "wf/fixer"),
    ].join("\n");
    case "done": return [
      `【wf 工作流｜done】slug=${s}`,
      `审计并汇报；test-report=PASS 后并行委派 wf/learner 复盘沉淀（不阻塞交付）。`,
      WRITE_CONTRACT,
      budgetLine(st, ["lessons"]),
      `委派 wf/learner 时必须声明：learner **不推进状态机**——不调用 wf_command、不执行任何 /wf:* 命令、不 wf:intake 新任务、不 reset；仅写 .learnings/ 与（经工具）lessons.md。若 wf_write_artifact 报「无活动任务」，停止并向 leader 报告，不得绕道。${artifactPathLine(st, "lessons")}`,
    ].join("\n");
    default: return `【wf 工作流】阶段 ${phase}`;
  }
}