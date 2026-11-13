// wf-workflow — 阶段指引（M16-r39 T08：自 lib.ts 拆分，文案逐字不变）。
// 依赖方向单向：guidance → lib（LIMITS/profileOf/budgetFor + 类型），lib 不反向 import 本文件
// R2 T2.1：模式判定经 profileOf（isDaily 消费点收敛至 domain/flow.profileOf 一处）。
// （禁 lib re-export guidance 兜底，防 lib→guidance→lib 环）。
// entryValue/guidance 消费方：commands.ts inject/transition 与 tests（daily-mode/p3-hint/
// p2-limits/artifact-budget/diagnose/phase-discipline/m4-smoke）。
import { LANE_CAP, LIMITS, profileOf, budgetFor, tierOf, KIND_FILES, SID_ALIAS_USAGE, nextFor, clipBrief, FLOW_CMD_NAMES, isRejectReport, briefFallback, type Limits, type WfState } from "./lib.ts"; // P1-E：LANE_CAP 动态尾

// P1：写入 instructions entry 的值——机器可读头行 + 完整阶段 guidance。
// 依据（官方 docs/build/plugins/server §Sessions）：entries 渲染为系统提示中的
// <context key="..."> 块，每次模型调用从存储重新组装 ⇒ 天然抗 compaction（superpowers 的
// post-compaction 重注入目标由此免费获得）。done 为终态，只留一行提示，不长期占用系统提示。
export const DONE_ENTRY = "wf 工作流已完成（done）。新任务：/wf:intake <slug>；清除状态：/wf:reset。";
// done-git-delivery-confirm T01：done 交付确认指令——仅 st.doneGit.isGit 时渲染（无记账=输出字节级不变，
// 与 guidance/DONE_ENTRY 各消费方测试零回归）。IO 检测在 commands.ts transition，本函数纯渲染。
// F4（用户报告竞态实证：并行 learner 在提交后继续写 .learnings/ → 提交后工作区复脏）：git 项目流程
// 顺序固定「总结 → 提交/不提交 → 完成」——经验文件落盘（learner 回执/S 级自写）在交付确认之前，
// 提交范围含 .learnings/ 随总结入库；确认批准后不得再有新的经验写入。
function doneGitLine(st: WfState): string | null {
  if (!st.delivery?.doneGit?.isGit) return null; // R3 T3.1 子步 D
  const opts = st.delivery.doneGit.hasRemote
    ? "选项标签固定：提交并推送/仅提交/跳过"
    : "未配置 remote——选项标签固定：仅提交/跳过（隐藏推送）";
  return `📦 交付确认（git）：检测到 git 环境。流程顺序固定「总结 → 提交/不提交 → 完成」：审计汇报与经验沉淀全部落盘后` +
    `（非 S 级须等 wf/learner 完成回执，S 级须先自写 lessons），才用 question 工具询问用户是否提交代码（${opts}）；` +
    "未经用户批准不得 commit/push；批准后先跑项目门禁（如 bun run check）通过才提交，" +
    "提交范围=本任务代码+.learnings/ 经验文件（经验默认入库，确认前落盘，提交后不得再写），" +
    "只暂存本任务相关文件，提交信息用中文约定式提交+emoji。";
}
export function entryValue(st: WfState, limits: Limits = LIMITS, overrides: string[] = []): string {
  // 易变区纪律（借鉴 my-opencode-deepseek-config 字节稳定前缀）：静态指引在前，
  // 易变内容（轮次/续用 sessionID/head 行）殿后——返工同阶段 r+1、子会话登记只打穿尾部，静态段保 prompt cache。
  const head = `phase=${st.phase} slug=${st.slug} rounds=${JSON.stringify(st.rounds ?? {})}`;
  if (st.phase === "done") {
    const git = doneGitLine(st);
    return `${DONE_ENTRY}${git ? `\n${git}` : ""}\n${head}`;
  }
  return `${guidance(st.phase, st, limits, overrides)}\n${head}`;
}

// R2 T2.1：模式派发注册表（Strategy 消费面，键=profile.id；完整性守卫=tests/profile-shape.test.js
// 断言 PROFILES 键集与本表键集一致——新增模式两处成对注册，漏一处即红）。
const GUIDANCE_BY_ID: Record<string, (phase: string | null | undefined, st: WfState, limits: Limits) => string> = {
  full: guidanceBase,
  daily: guidanceDaily,
};

export function guidance(phase: string | null | undefined, st: WfState, limits: Limits = LIMITS, overrides: string[] = []): string {
  // M16-r34：daily 模式用日常习惯流指引（tier 分支）；full/存量用 guidanceBase
  // R2 T2.1：isDaily 三元 → profileOf(st).id 注册表派发（模式判定单点在 profileOf）
  const G = GUIDANCE_BY_ID[profileOf(st).id] ?? guidanceBase;
  const base = G(phase, st, limits);
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
// M16-r50：档位用 tierOf 归一（S/M/L 三档，plan 预算分级 10/20/30KB）
function budgetLine(st: WfState, kinds: string[]): string {
  const tier = tierOf(st.size);
  const parts = kinds.map((k) => `${k}≤${budgetFor(k, tier)}KB`).join("、");
  return `产物预算（${tier} 级，字节计）：${parts}。委派 prompt 必须携带本预算；超预算用 patch 删减，勿全量重写。`;
}
function leanLine(st: WfState): string | null {
  // R2 T2.1 TierCtx：size 判定一律 tierOf 归一（`st.size ===` 字面清零纪律）
  return tierOf(st.size) === "S" ? "S 级从简：产物按 S 预算，审核聚焦关键风险，勿过度设计（比例化投入，不跳阶段）。" : null;
}

// ── M16-r40：会话复用可靠化——重委派点渲染续用指引（T02：零回显）──────────
// 根因：旧渲染把登记 ID 新鲜递进上下文诱导转录——「转录→截断→守卫回显→再转录」死循环燃料。
//   现仅以登记做存在性判断：有登记即指路别名/省略新建（sid 不进渲染文本）；无登记→不渲染（首次委派自然新建）。
//   仅续用已完成的子会话（防静默分叉）；续用失败立即新建，勿反复重试。
function reuseLine(st: WfState, agent: string): string | null {
  const sid = st.reuse?.roleSessions?.[agent]?.sessionID; // R3 T3.1 子步 C
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
// ── selfmod-concurrency-guard A3：daily building 派发策略绑 size（双任务同版本取证：
// M 分 2 派 vs L 一派到底=纯裁量漂移；收敛为 size 决定策略，例外须理由）──────────────
const DISPATCH_L = `L 级：按 plan lane 分组表分批委派 wf/builder（每批 ≤4 个 T<nn>，续用同 session）：lane≥2 且写集互斥证据充分（plan 有 lane 表+areas）→ 多 builder 并行（subagent background=true、独立 worktree=wf/<slug>/lane-<Tnn>、@Tnn 别名续接、回执 build-receipt-<Tnn>.md；并行授权=plan:confirm 卡已展示 lane 划分+预计耗时，批准即生效，不再重复问）；互斥证据不足 → 单树串行（不为并行而并行）。worktree 隔离执行、全部批次完成后合并回主树统一核验（wf-worktrees skill）。一派到底=例外须在回执说明理由。`;
const DISPATCH_M = `M 级：单 wf/builder 一次委派串行到底（主树），按 T<nn> 逐点 TDD（红测试从 plan 验收标准写，先红后绿），返工续用同 session。按批多派=例外须理由；lane 并行授权=plan:confirm 卡展示 lane 划分+预计耗时且批准（写集互斥前提）。`;
// R2 T2.1 DispatchStrategy：M/L 派发策略表（tier 判定唯一形态=DISPATCH_BY_TIER[tier]）
const DISPATCH_BY_TIER: Record<string, string> = { M: DISPATCH_M, L: DISPATCH_L };
// selfmod-guard T01：引擎自改纪律行（st.selfMod 门控渲染——entry 通道抗 compaction；
// 无记账=零渲染，存量 guidance 字节级不变）
const SELFMOD_LINE = `引擎自改模式：server/ 下文件正被宿主按内容指纹热载——builder 禁分步连续 edit（中间态会被同进程其它项目的在途会话真实执行，双任务日志实证），全部编辑完成、自检通过后一次性核验；intake 告警出现的并发任务未经用户裁决不得开工——休眠任务先核实再处置（/wf:status 查归属，done 收尾或 /wf:reset 清账），唤醒后同样是干扰源。`;
function guidanceDaily(phase: string | null | undefined, st: WfState, limits: Limits = LIMITS): string {
  const L = { ...LIMITS, ...limits };
  const s = st.slug || "(未定)";
  const r: Record<string, number> = st.rounds ?? {};
  const tier = tierOf(st.size); // R2 T2.1 TierCtx：S/M/L 判定归一
  const S = tier === "S";
  switch (phase) {
    case "intake": return [
      `【wf 工作流｜intake·日常模式】slug=${s}（体量 ${st.size ?? "M"}）`,
      `日常流：plan（讨论方案）→ review（/verify 独立验证）→ 按问题修订 → build（执行）→ test（核对）→ done。`,
      `1) 与用户澄清需求（批量优先：可合并的歧义用一次 question 多问项问完，防多轮往返；完全没听懂→一句话重述确认）；2) 读项目 .learnings/ 相关经验；3) 确保 .gitignore 含 .workflow/（.learnings/ 默认入库随交付提交，仅项目选择不入库时才加它的 ignore）；4) 需求基线：用户原话要点落 .workflow/${s}/baseline.md（≤1KB，leader 自写，后续"是否满足需求"争议回此基准核对）。`,
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
        ? `自验通过 → 先用 question 做方案确认（选项标签固定：批准执行/修改方案/终止任务；卡片展示 lane 划分与预计耗时——「批准执行」=批准该并行授权；wf:build 关卡校验确认记账）→ wf_command(name="wf:build")；不过 → 唯一返修路径：wf_command(name="wf:plan") 亲自修订再 wf:review；超限 → 停下问用户`
        : `FAIL → 唯一返修路径：wf_command(name="wf:plan") 带意见修订再 wf:review（review 直推复审边已移除；plan 修订即作废确认记账）；PASS → 先用 question 做方案确认（选项标签固定：批准执行/修改方案/终止任务；卡片展示 lane 划分与预计耗时——「批准执行」=批准该并行授权）→ wf_command(name="wf:build")（关卡校验 plan-review 结论+确认记账）；超限 → 停下问用户`);
      lines.push(`轮次：第 ${r.plan_review}/${L.plan_review} 轮`);
      if (!S && (r.plan_review ?? 0) >= 2) lines.push(...reuseLines(st, "wf/planner-reviewer"));
      return lines.join("\n");
    }
    case "building": {
      const lines = [
        `【wf 工作流｜building·日常模式】slug=${s}`,
        S ? `S 级：leader 主树亲自 TDD（先写失败测试再实现），不委派、不开 worktree。${SELF_CONTRACT}`
          : DISPATCH_BY_TIER[tier] ?? DISPATCH_M,
        // P1-E 动态尾：lane 并发数+空闲续用提示（有 lanes 登记才渲染；静态前缀+动态小尾纪律）
        ...(() => { const lanes = st.lanes ?? {}; return Object.keys(lanes).length
          ? [`lanes(${Object.values(lanes).filter((v) => v.status !== "done").length}/${LANE_CAP} 活跃)：${Object.entries(lanes).map(([k, v]) => `${k}${v.areas?.length ? `[${v.areas.join("+")}]` : ""}${v.status === "done" ? "(空闲可续用)" : ""}`).join(" ")}——续用 @Tnn；写前核对 areas，越界停下回报`]
          : []; })(),
        ...(S ? [] : [WRITE_CONTRACT, `委派契约：prompt 给任务行摘录+接口签名+验收标准+预算，禁止全仓扫描、勿贴整份 plan。`,
          `执行回执：委派 prompt 须要求 builder 完成后写 .workflow/${s}/build-receipt.md（单 builder）或 build-receipt-<Tnn>.md（每 lane 一份，≤2KB：测试命令+红→绿输出摘要+变更文件+未验证项+areas 越界声明）——testing 裁决与 learner 复盘的一审证据以此为准（daily 无 build_review 阶段，回执=证据链补位；读侧逐 lane 汇总勿遗漏）。`]),
        `完成（含红→绿证据）→ wf_command(name="wf:test")`,
        ...(st.delivery?.selfMod ? [SELFMOD_LINE] : []), // R3 T3.1 子步 D
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
    case "done": {
      const git = doneGitLine(st);
      const serial = !!git; // F4：git 项目=总结→提交/不提交→完成 串行；无记账=旧文案字节级不变（残窗=检测 fail-open 的并行，接受）
      return [
        `【wf 工作流｜done·日常模式】slug=${s}`,
        S
          ? (serial
            ? `S 级：leader 简短汇报核对结果（不委派 learner）；如有可沉淀经验，先自写 lessons 与 .learnings/ 落盘，再发起交付确认——顺序固定「总结→提交/不提交→完成」。`
            : `S 级：leader 简短汇报核对结果（不委派 learner）；如有可沉淀经验，自写 3 行 lessons。`)
          : (serial
            ? `审计并汇报；委派 wf/learner 复盘沉淀并等其完成回执（回执必含「已写 .learnings/ 文件清单+完成时刻」+ lessons 含流程效率观察节：各阶段墙钟自 events 表取）——learner 回执到齐前不得发起交付确认，确认后不得再写经验（顺序固定：总结→提交/不提交→完成）。`
            : `审计并汇报；test-report=PASS 后并行委派 wf/learner 复盘沉淀（不阻塞交付）。`),
        ...(S ? [] : [WRITE_CONTRACT, `委派 wf/learner 须声明：learner 不推进状态机（不调 wf_command/不 /wf:*），仅写 .learnings/ 与 lessons.md。${artifactPathLine(st, "lessons")}`]),
        budgetLine(st, ["lessons"]),
        ...(git ? [git] : []),
      ].join("\n");
    }
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
      `1) 与用户澄清需求（批量优先：可合并的歧义用一次 question 多问项问完，防多轮往返；完全没听懂→一句话重述确认）；2) 读项目 .learnings/ 相关经验带入后续阶段；3) 确保 .gitignore 含 .workflow/（.learnings/ 默认入库随交付提交，仅项目选择不入库时才加它的 ignore）；4) 需求基线：用户原话要点落 .workflow/${s}/baseline.md（≤1KB，leader 自写，后续"是否满足需求"争议回此基准核对）。`,
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
      `默认：开一个 worktree，一个 wf/builder 在树内按序串行完成全部 T<nn>（逐任务 TDD 先红后绿）；建树后把 test_design 产出的红测试复制进树并 md5 核对；prompt 给 worktree 绝对路径+按序任务清单（勿贴整份 plan——只给任务行摘录+接口签名，省子代理冷启动）。多树并行=plan lane 分组表+确认卡批准（写集互斥前提），lane 分支 wf/<slug>/lane-<Tnn>。`,
      `全部回执齐备（含红→绿证据）→ wf_command(name="wf:reconcile")`,
    ].join("\n");
    case "reconcile": return [
      `【wf 工作流｜reconcile】slug=${s}`,
      `合并 worktree 产物回主树（多 lane=逐 lane 展示 diff 摘要再合，勿静默整树覆盖；单树=一次合并；主树跑构建+冒烟即可，全量验证留给 testing 阶段，勿重复跑全量）。合并后 wf:lane done <Tnn> 收尾（留 lane 作空闲续用提示）。`,
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
    case "done": {
      const git = doneGitLine(st);
      return [
        `【wf 工作流｜done】slug=${s}`,
        git
          ? `审计并汇报；委派 wf/learner 复盘沉淀并等其完成回执（回执必含「已写 .learnings/ 文件清单+完成时刻」）——learner 回执到齐前不得发起交付确认，确认后不得再写经验（顺序固定：总结→提交/不提交→完成）。`
          : `审计并汇报；test-report=PASS 后并行委派 wf/learner 复盘沉淀（不阻塞交付）。`,
        WRITE_CONTRACT,
        budgetLine(st, ["lessons"]),
        `委派 wf/learner 时必须声明：learner **不推进状态机**——不调用 wf_command、不执行任何 /wf:* 命令、不 wf:intake 新任务、不 reset；仅写 .learnings/ 与（经工具）lessons.md。若 wf_write_artifact 报「无活动任务」，停止并向 leader 报告，不得绕道。${artifactPathLine(st, "lessons")}`,
        ...(git ? [git] : []),
      ].join("\n");
    }
    default: return `【wf 工作流】阶段 ${phase}`;
  }
}

// ── notification-brief-display T02（plan §3.1/§4 冻结）：流转成功报告的 4 行结构化 brief ──
// 纯结构化生成（从 WfState 字段取值，禁 guidance 全文正则——plan §1 目标①）。
// 消费方：commands.ts publishOutput（T03 接线）→ reports 行/report 事件/exec 返回三通道。
// 零回显（A/G-2）：每行过 clipBrief（≤100 码点截断加 … + redactIds）——slug 理论上可含
// 任意串，脱敏兜底保证「无 ses_」不变量（tests/brief-level.test.js 逐例断言不放宽）。
export function briefForTransition(st: WfState, limits: Limits = LIMITS): string {
  const L = { ...LIMITS, ...limits };
  const modeLabel = profileOf(st).id === "daily" ? "日常模式" : "完整模式"; // R2 T2.1：isDaily 消费改 profile 单点
  const r: Record<string, number> = st.rounds ?? {};
  // L3 后缀仅在对应字段非空时追加（plan §3.1）
  const suffix = [
    st.verdicts?.planReview ? `｜planReview=${st.verdicts.planReview}` : "", // R3 T3.1 子步 B
    st.verdicts?.testReport ? `｜test=${st.verdicts.testReport}` : "",
    st.verdicts?.confirmedAt ? "｜确认=✅" : "",
    st.verdicts?.testPlanWritten ? "｜testPlan=✅" : "",
  ].join("");
  return [
    `【wf 工作流｜${st.phase}·${modeLabel}·${st.size ?? "M"}】slug=${st.slug || "(未定)"}`,
    `行动：${nextFor(st, st.phase)}`,
    `轮次 plan_review=${r.plan_review ?? 0}/${L.plan_review} build_review=${r.build_review ?? 0}/${L.build_review} test_fix=${r.test_fix ?? 0}/${L.test_fix}${suffix}`,
    "/wf:status 查看完整指引",
  ].map((line) => clipBrief(line)).join("\n");
}

// 分派（§4 冻结）：流转命令 + 非拒绝文本 + st 有相位 → 结构化 transition brief；
// 其余（非流转命令成功报告/一切拒绝(halt)文案/st 不可得）→ briefFallback 2 行。
export function briefFor(cmd: string, text: string, st: WfState | null, limits: Limits = LIMITS): string {
  if (FLOW_CMD_NAMES.has(cmd) && !isRejectReport(text) && st?.phase) return briefForTransition(st, limits);
  return briefFallback(cmd, text);
}