// wf-workflow — 可测纯逻辑单一来源（P0-b：自 server/index.js 提取，行为与 M16-r25 一致）
// 原则：本文件只放无 ctx/storage 依赖的模块级常量与纯函数，供 bun test 直接覆盖；
//       index.js 负责注册（工具/命令/hook/RPC）与持久化。改动本文件前先跑 bun test。

import { BLOCKING } from "../shared/phases.ts"; // M10-d A1：阶段闸门单一来源

export const VERSION = "M16-r25";

export const LIMITS = { plan_review: 3, build_review: 3, test_fix: 3 };
export type LimitKey = keyof typeof LIMITS;
// P2：limits 可按实例覆盖（partial 覆盖默认 LIMITS）
export type Limits = Partial<Record<LimitKey, number>>;

export const GATE_ERR = "[wf-workflow]";
export const EDIT_TOOLS: Set<string> = new Set(["edit", "write", "patch"]);
export const BLOCKING_PHASES: Set<string> = new Set<string>(BLOCKING); // M10-d A1：见 shared/phases.ts
export const DEFAULT_ALLOW_MARKERS = ["/.workflow/", "/.learnings/", "/tests/", "/test/", "/__tests__/"];
export const DEFAULT_ALLOW_RES = [/\.(test|spec)\.[cm]?[jt]sx?$/i, /(^|\/)test_[^/]*\.(py|go)$/i];

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
  slug?: string;
  phase?: string | null;
  rounds: Record<LimitKey, number> & Record<string, number>;
  updatedAt?: string;
  prev?: { slug?: string; phase?: string | null; at?: string };
  lanes?: Record<string, { sessionID?: string; worktree?: string | null; at?: string }>;
  artifacts?: Record<string, { at?: string; bytes?: number }>;
  log?: FlowLogEntry[];
  testPlanWritten?: boolean;
  testReportVerdict?: string;
  entryErr?: string;
  [key: string]: unknown;
}

// from: 允许的来源阶段（"*" = 任意）；counter: 循环轮次计数（null = 非循环）
export interface FlowDef {
  to: string;
  from: string[];
  counter: LimitKey | null;
}
export const FLOWS: Record<string, FlowDef> = {
  "wf:intake":       { to: "intake",       from: ["*"],                                        counter: null },
  // M10-a：补返工边——review 不过回 planning；执行审核遗漏回 building；返工/修复后回 reconcile 重合并
  "wf:plan":         { to: "planning",     from: ["intake", "planning", "review", "test_design"], counter: null },
  "wf:review":       { to: "review",       from: ["planning", "review"],                       counter: "plan_review" },
  "wf:assign":       { to: "assign",       from: ["review"],                                   counter: null },
  // M11：测试设计两拍制——test_design（assign 后、building 前，按冻结接口写红验收测试）
  "wf:test-design":  { to: "test_design",  from: ["assign"],                                   counter: null },
  "wf:build":        { to: "building",     from: ["test_design", "build_review"],              counter: null },
  "wf:reconcile":    { to: "reconcile",    from: ["building", "build_review", "fixing"],       counter: null },
  "wf:review-build": { to: "build_review", from: ["reconcile", "build_review"],                counter: "build_review" },
  "wf:test":         { to: "testing",      from: ["build_review", "testing", "fixing", "reconcile"], counter: null },
  "wf:fix":          { to: "fixing",       from: ["testing"],                                  counter: "test_fix" },
  "wf:done":         { to: "done",         from: ["testing"],                                  counter: null },
};

export const NEXT: Record<string, string> = {
  intake: "/wf:plan", planning: "/wf:review", review: "/wf:assign", assign: "/wf:test-design",
  test_design: "/wf:build", building: "/wf:reconcile", reconcile: "/wf:review-build", build_review: "/wf:test",
  testing: "PASS→/wf:done，FAIL→/wf:fix", fixing: "/wf:test", done: "（终态，含并行复盘）",
};

// ── M5：命令级进阶关卡（返回 null=放行，字符串=拒绝理由）──────────
// wf:assign 双通道：计划审核（流转合法性）之外，还须 tester 已产出 test-plan.md（M3 记账 testPlanWritten）
// wf:done 验收：test-report.md 的「**结论**」必须为 PASS（wf_write_artifact 解析记账 testReportVerdict）
export const GATES: Record<string, (st: WfState) => string | null> = {
  "wf:assign": (st) =>
    st.testPlanWritten ? null :
      "❌ 双通道关卡未过：tester(feasibility) 尚未产出 test-plan.md。请回到 review 阶段委派 wf/tester(mode=feasibility)，用 wf_write_artifact(kind=test-plan) 写入后，再执行 /wf:assign。",
  "wf:done": (st) =>
    st.testReportVerdict === "PASS" ? null :
      `❌ 验收关卡未过：test-report.md 结论为「${st.testReportVerdict ?? "未产出"}」（要求 PASS）。` +
      `FAIL → 执行 /wf:fix 修复后重跑 /wf:test；由 wf/tester 用 wf_write_artifact(kind=test-report) 更新报告（首行 **结论**: PASS）。`,
};

// ── M4：越权路径提取 ────────────────────────────────────────────────
export function extractPaths(tool: string, args: Record<string, unknown> | null | undefined): string[] {
  if (!args || typeof args !== "object") return [];
  if (tool === "patch") {
    const txt = String(args.patchText ?? "");
    const out: string[] = [];
    for (const m of txt.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
    return out;
  }
  const p = args.path ?? args.filePath ?? args.file;
  return typeof p === "string" && p !== "" ? [p] : [];
}

// 放行判定工厂（M10-a：闸门拒绝文案与 allowlist 同源生成，I2 防漂移）
export function makeAllowChecker(allowMarkers: string[], allowRes: RegExp[]): (p: unknown) => boolean {
  return (p) => {
    // 兼容绝对/相对路径：marker 形如 "/.workflow/"，相对路径没有前导斜杠，两种都比对
    const norm = String(p ?? "").replace(/\\/g, "/");
    return (
      allowMarkers.some((m) => norm.includes(m) || norm.includes(m.replace(/^\//, ""))) ||
      allowRes.some((re) => re.test(norm))
    );
  };
}

// ── M10-c：shell 写目标解析（重定向 + 写/删类命令尾参）──────────────
// 已知边界（P0 锁定现状）：`tee out.txt < input` 会把 "input" 误判为目标（< 不在分段符内）；
// 误伤仅在 BLOCKING 阶段（planning/review）发生，属 fail-closed 方向，暂不修。
const SHELL_DEST_CMDS: Set<string> = new Set(["touch", "mkdir", "rm", "mv", "cp", "tee", "rsync", "ln", "install"]);
export function shellWriteTargets(cmd: unknown): string[] {
  const found = new Set<string>();
  if (!cmd || typeof cmd !== "string") return [];
  // 重定向目标：> f / >> f / 2> f（引号或裸 token，含 * 的跳过）
  const re = /(?:\d*>>?|<>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const t = m[1] ?? m[2] ?? m[3];
    if (t && !t.includes("*")) found.add(t);
  }
  // 目的参数明确的写/删类命令：取每段最后一个非旗标参数（rm/mv/cp 目的在最后）
  for (const seg of cmd.split(/(?:&&|\|\||[;|\n])/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const head = (toks[0] ?? "").replace(/^.*\//, "");
    if (!SHELL_DEST_CMDS.has(head)) continue;
    const pos = toks.slice(1).filter((x) => !x.startsWith("-") && !/^\d+$/.test(x) && !x.includes("$") && !x.includes("`"));
    const last = pos[pos.length - 1];
    if (last && !last.includes("*")) found.add(last.replace(/^["']|["']$/g, ""));
  }
  return [...found];
}

// ── M3：产物 kind → 文件名（循环类产物按轮次编号）──────────────────
export const KIND_FILES: Record<string, (st: WfState) => string> = {
  "plan":         () => "plan.md",
  "plan-review":  (st) => `plan-review-r${Math.max(1, st.rounds?.plan_review ?? 1)}.md`, // M14：进入即计数语义下轮次即编号（旧 +1 会致首轮成 r2）
  "test-plan":    () => "test-plan.md",
  "build-review": (st) => `build-review-r${Math.max(1, st.rounds?.build_review ?? 1)}.md`, // M14：同上
  "test-report":  () => "test-report.md",
  "lessons":      () => "lessons.md",
};

// test-report 首行「**结论**: PASS|FAIL」解析（宽松值匹配 + 严格行首格式探测）
export function parseVerdict(content: unknown): "PASS" | "FAIL" | "UNKNOWN" {
  const m = String(content ?? "").match(/^\s*\*\*结论\*\*\s*[:：]\s*(PASS|FAIL)\b/im);
  return m ? (m[1].toUpperCase() as "PASS" | "FAIL") : "UNKNOWN";
}
export function hasStrictVerdictLine(content: unknown): boolean {
  return /^\*\*结论\*\*[:：]/m.test(String(content ?? ""));
}

export const slugify = (t: unknown): string =>
  String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

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

// ── P3：superpowers 式自动激活提示（纯函数可测）────────────────────
// 宿主若提供消息观察 hook：用户消息命中「明确工作流意图」且该会话无 wf 状态时，
// 注入一次性 hint entry（不自动开任务，仅提示 /wf:intake）。误触率优先于召回率。
export const HINT_TRIGGERS = [
  "工作流", "流程开发", "按流程", "完整流程", "走流程", "planned development",
  "superpowers", "wf workflow", "formal workflow",
];
export function isHintWorthy(text: unknown): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  return HINT_TRIGGERS.some((k) => t.includes(k.toLowerCase()));
}
export const HINT_ENTRY = [
  "💡 检测到你在表达「流程化开发」意图。本项目装有 wf 工作流插件（规划→审核∥可行性→分配→红测试→单树 TDD 执行→审核→验证→修复→复盘）。",
  "若想让本任务走工作流：执行 /wf:intake <任务slug>。若不需要，忽略本提示（不影响任何功能）。",
  "可用命令：/wf:intake /wf:plan /wf:review /wf:assign /wf:test-design /wf:build /wf:reconcile /wf:review-build /wf:test /wf:fix /wf:done；辅助：/wf:status /wf:diagnose /wf:ping /wf:reset。",
].join("\n");

// 实测（M2-a）：命令 args.prompt 是对象（含 text 等字段），不是字符串
interface PromptLike { text?: unknown; content?: unknown }
export const promptText = (p: unknown): string => {
  if (typeof p === "string") return p;
  if (p && typeof p === "object") { const q = p as PromptLike; return String(q.text ?? q.content ?? ""); }
  return "";
};

// ── 流转校验+应用（P0-b 提取自 transition 闭包，行为与 M16 一致）────
// 通过 → 原地完成 counter 递增（进入即计数）与 intake 重置/slug 设置，返回 { ok: true }；
//       调用方随后设 st.phase=FLOWS[cmd].to、st.updatedAt，并负责 log/save/inject/emit。
// 拒绝 → 返回 { ok: false, note, msg }（拒绝发生在计数之前，不消耗循环额度）。
// st 须带 rounds: { plan_review, build_review, test_fix }。
// P2：limits 可按实例覆盖（options.limits），默认取模块 LIMITS。
export type TransitionResult = { ok: true } | { ok: false; note: string; msg: string };
export function evaluateTransition(cmd: string, st: WfState, text: unknown, at = new Date().toISOString(), limits: Limits = LIMITS): TransitionResult {
  const flow = FLOWS[cmd];
  const from = st.phase ?? null;

  if (!(flow.from.includes("*") || flow.from.includes(from ?? ""))) {
    return {
      ok: false, note: "illegal-transition",
      msg: `❌ 拒绝：/wf:${cmd.slice(3)} 不能从阶段「${from ?? "无"}」进入「${flow.to}」（合法来源：${flow.from.join("/") || "无"}）。当前下一步：${NEXT[from ?? ""] ?? "/wf:intake"}`,
    };
  }

  // M5：进阶关卡（在轮次计数之前拒绝，不消耗循环额度）
  const gate = GATES[cmd];
  if (gate) {
    const reject = gate(st);
    if (reject) return { ok: false, note: "gate-rejected", msg: reject };
  }

  // M10-a：计数器改为「进入即计数、永不重置」（修 S2：旧规则 from===to 才 +1，
  // 而 wf:fix 恒为 testing→fixing 不相等 → test_fix 永远=1，上限形同虚设）。
  // 首次进入=1（首次审核 / 首次执行审核 / 首次修复），重复进入递增，达上限拒绝。
  if (flow.counter) {
    const cap = limits[flow.counter] ?? LIMITS[flow.counter];
    if ((st.rounds[flow.counter] ?? 0) >= cap) {
      return {
        ok: false, note: "limit-exceeded",
        msg: `🛑 硬关卡：${flow.counter} 已 ${st.rounds[flow.counter]}/${cap} 轮，禁止继续循环。请停止自动化流程并向用户上报，由用户裁决。`,
      };
    }
    st.rounds[flow.counter] += 1;
  }

  // M10-a：intake 守卫 + 任务级重置（S3+A8：旧版换任务不清 artifacts/testPlanWritten，
  // 新任务可凭旧状态蒙混过 assign/done 关卡；中途 intake 也会误丢进度）
  if (cmd === "wf:intake") {
    const raw = promptText(text).trim();
    const force = raw.startsWith("!");
    if (from && from !== "done" && !force) {
      return {
        ok: false, note: "intake-guard",
        msg: `❌ 已有活动任务：slug=${st.slug || "(未定)"} phase=${from}。若要中止请执行 /wf:reset；确要强制切换执行 /wf:intake ! <新slug>。`,
      };
    }
    if (from === "done" || force || !st.slug) {
      if (st.slug) st.prev = { slug: st.slug, phase: from, at: st.updatedAt ?? at };
      st.rounds = { plan_review: 0, build_review: 0, test_fix: 0 };
      st.artifacts = {};
      st.lanes = {};
      delete st.testPlanWritten;
      delete st.testReportVerdict;
    }
    st.slug = slugify(force ? raw.slice(1).trim() : raw) || st.slug || "untitled";
  }

  return { ok: true };
}

export function guidance(phase: string | null | undefined, st: WfState, limits: Limits = LIMITS, overrides: string[] = []): string {
  const base = guidanceBase(phase, st, limits);
  if (Array.isArray(overrides) && overrides.length) {
    const list = overrides.map((f) => String(f).replace(/\.md$/, "")).join(", ");
    return `${base}\n📌 项目级角色定制（.workflow/overrides/）：${list}。委派同名 wf 角色时，把对应文件全文带入子任务提示词。`;
  }
  return base;
}

function guidanceBase(phase: string | null | undefined, st: WfState, limits: Limits = LIMITS): string {
  const L = { ...LIMITS, ...(limits ?? {}) };
  const s = st.slug || "(未定)";
  const r: Record<string, number> = st.rounds ?? {};
  switch (phase) {
    case "intake": return [
      `【wf 工作流｜intake】slug=${s}`,
      `1) 与用户澄清需求；2) 读项目 .learnings/ 相关经验带入后续阶段；3) 确保 .gitignore 含 .workflow/ 与 .learnings/。`,
      `完成 → 执行 /wf:plan`,
    ].join("\n");
    case "planning": return [
      `【wf 工作流｜planning】slug=${s}`,
      `⚠️ 本阶段禁止修改业务代码（.workflow/、.learnings/ 与测试目录除外）。`,
      `委派 subagent wf/planner → 产物用 wf_write_artifact(kind=plan) 写入（含 T01… 任务清单、接口签名、每条验收标准的验证方式）。`,
      `完成 → 执行 /wf:review`,
    ].join("\n");
    case "review": return [
      `【wf 工作流｜review（第 ${r.plan_review}/${L.plan_review} 轮）】slug=${s}`,
      `⚠️ 本阶段禁止修改业务代码（.workflow/、.learnings/ 与测试目录除外）。`,
      `并行委派：wf/planner-reviewer（五角度，审 plan.md）∥ wf/tester(mode=feasibility，仅产出 test-plan.md：验收用例设计+可测性评审，用 wf_write_artifact(kind=test-plan)，不写任何代码文件)。`,
      `任一不通过 → 执行 /wf:plan 回规划并带意见委派 wf/planner，再 /wf:review；双通道通过 → 执行 /wf:assign；超限 → 停下问用户`,
    ].join("\n");
    case "assign": return [
      `【wf 工作流｜assign】slug=${s}`,
      `硬关卡：计划审核已通过 且 test-plan.md（可行性拍）已产出。`,
      `冻结接口，按 T<nn> 排串行执行顺序（默认一个 wf/builder 串行完成整场任务；多 builder 并行拆树=例外，需用户同意）。完成 → 执行 /wf:test-design`,
    ].join("\n");
    case "test_design": return [
      `【wf 工作流｜test_design】slug=${s}`,
      `委派 wf/tester(mode=design)：按已冻结接口在主树测试目录写会失败的验收/集成测试（红），作为执行 worktree 的 TDD 锚点。`,
      `发现接口问题 → 执行 /wf:plan 回规划修订（返工边）；完成 → 执行 /wf:build`,
    ].join("\n");
    case "building": return [
      `【wf 工作流｜building】slug=${s}`,
      `默认：开一个 worktree，一个 wf/builder 在树内按序串行完成全部 T<nn>（逐任务 TDD 先红后绿）；建树后把 test_design 产出的红测试复制进树并 md5 核对；prompt 给 worktree 绝对路径+按序任务清单。多树并行=例外（写集互斥+用户同意）。`,
      `全部回执齐备（含红→绿证据）→ 执行 /wf:reconcile`,
    ].join("\n");
    case "reconcile": return [
      `【wf 工作流｜reconcile】slug=${s}`,
      `合并 worktree 产物回主树（单树=一次合并；主树跑全量验证），清理前先 rm 树内已合并的 untracked 副本再非 force 移除；冲突/数字不符 → 停下问用户，不自动解决。`,
      `合并完成 → 执行 /wf:review-build`,
    ].join("\n");
    case "build_review": return [
      `【wf 工作流｜build_review（第 ${r.build_review}/${L.build_review} 轮）】slug=${s}`,
      `委派 wf/builder-reviewer（按 T<nn> 查完成度 + 代码质量 + 测试质量）。`,
      `有遗漏 → 执行 /wf:build 返工（重派 wf/builder），修完 /wf:reconcile → /wf:review-build；通过 → 执行 /wf:test；超限 → 停下问用户`,
    ].join("\n");
    case "testing": return [
      `【wf 工作流｜testing】slug=${s}`,
      `委派 wf/tester(mode=verify) → wf_write_artifact(kind=test-report)，首行 **结论**: PASS|FAIL。`,
      `PASS → 执行 /wf:done；FAIL → 执行 /wf:fix`,
    ].join("\n");
    case "fixing": return [
      `【wf 工作流｜fixing（第 ${r.test_fix}/${L.test_fix} 轮）】slug=${s}`,
      `失败优先回原 builder（复用 sessionID，在其 worktree 内修，修完重新合并核验）；根因不明/跨模块 → wf/fixer。`,
      `修改过 worktree 则先 /wf:reconcile 回主树合并，再执行 /wf:test；超限 → 停下问用户`,
    ].join("\n");
    case "done": return [
      `【wf 工作流｜done】slug=${s}`,
      `审计并汇报；test-report=PASS 后并行委派 wf/learner 复盘沉淀（不阻塞交付）。`,
      `委派 wf/learner 时必须声明：learner **不推进状态机**——不执行任何 /wf:* 命令、不 wf:intake 新任务、不 reset；仅写 .learnings/ 与（经工具）lessons.md。若 wf_write_artifact 报「无活动任务」，停止并向 leader 报告，不得绕道。`,
    ].join("\n");
    default: return `【wf 工作流】阶段 ${phase}`;
  }
}

// ── P2：/wf:ping 角色健康检查（纯函数可测）────────────────────────
// WF_ROLES = 工作流契约的 7 个 subagent 角色（leader 除外，leader 是当前会话）。
// agents 形状容错：数组或 {agents}，项取 name/id 与 model.providerID/model.id。
export const WF_ROLES = ["wf/planner", "wf/planner-reviewer", "wf/tester", "wf/builder",
  "wf/builder-reviewer", "wf/fixer", "wf/learner"];
export interface AgentLike {
  name?: string;
  id?: string;
  model?: { providerID?: string; id?: string };
}
export function pingReport(agents: AgentLike[] | { agents?: AgentLike[] } | null | undefined): string {
  const arr = Array.isArray(agents) ? agents : (agents?.agents ?? []);
  const norm = arr.map((a) => ({
    name: String(a?.name ?? a?.id ?? ""),
    model: a?.model?.providerID ? `${a.model.providerID}/${a.model.id ?? "?"}` : null,
  }));
  const found = norm.filter((n) => n.name.startsWith("wf/"));
  const missing = WF_ROLES.filter((r) => !found.some((f) => f.name === r));
  const extra = found.filter((f) => !WF_ROLES.includes(f.name)).map((f) => f.name);
  return [
    `wf 角色：${found.length}/${WF_ROLES.length} 已注册`,
    ...found.map((f) => `  ${f.name} model=${f.model ?? "(继承会话模型)"}`),
    ...(missing.length ? [`  ⚠️ 缺失：${missing.join(", ")}`] : []),
    ...(extra.length ? [`  ℹ️ 额外：${extra.join(", ")}`] : []),
  ].join("\n");
}

// ── P1：wf:diagnose 报告生成（纯函数，可测）────────────────────────
// facts = { version, artifactFiles: 磁盘上实际存在的产物名[], entryErr?, rpcErr?, limits? }
// 证据来源：st.log（每次流转/拒绝/阻断都记账）+ 关卡记账 + 磁盘对账。
export interface DiagnoseFacts {
  version?: string;
  artifactFiles?: string[];
  entryErr?: string;
  rpcErr?: string;
  limits?: Limits;
}
export function diagnoseReport(st: WfState, facts: DiagnoseFacts = {}): string {
  const out: string[] = [];
  const r: Record<string, number> = st.rounds ?? {};
  out.push(`wf 诊断(${facts.version ?? "?"})｜slug=${st.slug || "(未定)"} phase=${st.phase ?? "无"}｜${st.updatedAt ?? "无更新时间"}`);

  // 1) 审计轨迹中的拒绝/阻断
  const log = Array.isArray(st.log) ? st.log : [];
  const rejects = log.filter((e) => e && e.ok === false);
  const blocks = rejects.filter((e) => e.note === "blocked");
  const refusals = rejects.filter((e) => e.note !== "blocked");
  out.push(`流转尝试=${log.length} 拒绝=${refusals.length} 越权阻断=${blocks.length}`);
  const byNote: Record<string, number> = {};
  for (const e of refusals) byNote[String(e.note)] = (byNote[String(e.note)] ?? 0) + 1;
  for (const [note, n] of Object.entries(byNote)) {
    const hint = ({
      "illegal-transition": "命令顺序错误（请核对流转表/下一步提示）",
      "gate-rejected": "关卡前置产物未产出（test-plan / test-report）",
      "limit-exceeded": "循环已达上限——按流程应停下上报用户",
      "intake-guard": "已有活动任务被守卫拦截（用 /wf:reset 或 /wf:intake ! <slug>）",
    } as Record<string, string>)[note] || "见日志详情";
    out.push(`  ✗ ${note} ×${n}：${hint}`);
  }
  for (const e of blocks.slice(-5)) out.push(`  ⛔ 越权阻断：${e.tool ?? e.cmd ?? "?"} ${e.detail ?? ""}`);

  // 2) 轮次余量（facts.limits 支持实例覆盖）
  for (const [k, limit] of Object.entries({ ...LIMITS, ...(facts.limits ?? {}) })) {
    const used = r[k] ?? 0;
    if (used >= limit) out.push(`  🛑 ${k} 已 ${used}/${limit} 轮：禁止继续循环，需用户裁决`);
  }

  // 3) 关卡记账
  out.push(`  关卡：testPlan=${st.testPlanWritten ? "✅ 已产出" : "❌ 未产出"}  testReport=${st.testReportVerdict ?? "未产出"}`);

  // 4) 产物对账（state 记账 vs 磁盘实际）
  const known = new Set(Object.values(KIND_FILES).map((fn) => fn(st)));
  const recorded = Object.keys(st.artifacts ?? {});
  const onDisk = (facts.artifactFiles ?? []).filter((f) => /\.(md)$/.test(f));
  const missing = recorded.filter((f) => !onDisk.includes(f));
  const untracked = onDisk.filter((f) => !recorded.includes(f) && known.has(f));
  if (missing.length) out.push(`  ⚠️ 记账但磁盘缺失：${missing.join(", ")}`);
  if (untracked.length) out.push(`  ⚠️ 磁盘有但未记账：${untracked.join(", ")}`);
  if (!missing.length && !untracked.length) out.push(`  ✅ 产物对账一致（${recorded.length} 项）`);

  // 5) 注入/观测通道异常
  if (st.entryErr) out.push(`  ⚠️ 阶段注入失败（guidance 可能未进系统提示）：${st.entryErr}`);
  else if (facts.entryErr) out.push(`  ⚠️ entry API 异常：${facts.entryErr}`);
  if (facts.rpcErr) out.push(`  ⚠️ RPC 注册失败（TUI 面板不可用）：${facts.rpcErr}`);

  // 6) 下一步
  out.push(`  下一步：${NEXT[st.phase ?? ""] ?? "/wf:intake"}`);
  return out.join("\n");
}
