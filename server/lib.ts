// wf-workflow — 可测纯逻辑单一来源（P0-b：自 server/index.ts 提取）
// 原则：本文件只放无 ctx/storage 依赖的模块级常量与纯函数，供 bun test 直接覆盖；
//       index.ts 负责注册（工具/命令/hook/RPC）与持久化。改动本文件前先跑 bun test。
// M16-r26（T01-T06 修复批）：Unicode slug / 幽灵行不落盘 / active 收紧 / save 冲突显式化重试 /
//   wf_command 模型侧推进入口 / guidance 措辞统一指向 wf_command。
// M16-r27（T09-T14 修订批）：save 失败 entry 回滚（transition 克隆化）/ wf:ping 只读放行 /
//   artifact 行删文案分路 / slugify 码点截断 / 已知边界文档。
// M16-r39（T08）：guidance/entryValue/DONE_ENTRY 拆分至 server/guidance.ts（文案逐字不变）；
//   VERSION 归一 shared/version.ts（server/TUI 同源）。本文件不 re-export guidance（防环）。
import { BLOCKING } from "../shared/phases.ts"; // M10-d A1：阶段闸门单一来源

export { VERSION } from "../shared/version.ts"; // M16-r39 T08：版本单一来源（T13 升 r39）

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
  rounds: Record<LimitKey, number> & Record<string, number>;
  updatedAt?: string;
  prev?: { slug?: string; phase?: string | null; at?: string };
  lanes?: Record<string, { sessionID?: string; worktree?: string | null; at?: string }>; // M16-r39 T06：worktree 可 null（lane set 无 worktree 时写 null，形状同源）
  // M16-r40：角色→最新子会话自动登记（agent→{sessionID,at}）。子代理调 wf_write_artifact /
  //   edit 时插件自动捕获其 sessionID，guidance 重委派点渲染完整 ID 供 leader 逐字续用——
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
  entryErr?: string;
  [key: string]: unknown;
}

// from: 允许的来源阶段（"*" = 任意）；counter: 循环轮次计数（null = 非循环）
export interface FlowDef {
  to: string;
  from: string[];
  counter: LimitKey | null;
}
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

export const NEXT: Record<string, string> = {
  intake: "/wf:plan", planning: "/wf:review", review: "/wf:test-design",
  // M16-r28 兼容行：存量 assign 阶段任务（阶段已并入 test_design）的下一步指引
  assign: "/wf:test-design（assign 已并入 test_design，直接推进即可）",
  test_design: "/wf:build", building: "/wf:reconcile", reconcile: "/wf:review-build", build_review: "/wf:test",
  testing: "PASS→/wf:done，FAIL→/wf:fix", fixing: "/wf:test", done: "（终态，含并行复盘）",
};

// ── M5：命令级进阶关卡（返回 null=放行，字符串=拒绝理由）──────────
// M16-r28：双通道关卡原挂 wf:assign（assign 阶段已并入 test_design），迁移至 wf:test-design 入口，
//   语义不变：计划审核（流转合法性）之外，还须 tester 已产出 test-plan.md（M3 记账 testPlanWritten）
// wf:done 验收：test-report.md 的「**结论**」必须为 PASS（wf_write_artifact 解析记账 testReportVerdict）
export const GATES: Record<string, (st: WfState) => string | null> = {
  "wf:test-design": (st) =>
    st.testPlanWritten ? null :
      "❌ 双通道关卡未过：tester(feasibility) 尚未产出 test-plan.md。请回到 review 阶段委派 wf/tester(mode=feasibility)，用 wf_write_artifact(kind=test-plan) 写入后，再推进 /wf:test-design（leader 调用 wf_command(name=\"wf:test-design\")，用户手敲亦可）。",
  "wf:done": (st) =>
    st.testReportVerdict === "PASS" ? null :
      `❌ 验收关卡未过：test-report.md 结论为「${st.testReportVerdict ?? "未产出"}」（要求 PASS）。` +
      `FAIL → 推进 /wf:fix 修复后重跑 /wf:test（wf_command 或用户手敲）；由 wf/tester 用 wf_write_artifact(kind=test-report) 更新报告（首行 **结论**: PASS）。`,
};

// ── M16-r34：日常模式（daily）——自动化用户 5 步习惯 plan→verify→修订→执行→核对 ──────────
// 一条流全 tier（S/M/L），tier 只改委派与否（guidance 分支）；砍 test_design/reconcile/build_review/fixing。
// 完整 FLOWS 不动（full 模式/存量在途任务用），daily 用本子表。FAIL 返工复用 wf:fix（改指 building）+ test_fix 计数。
export const FLOWS_DAILY: Record<string, FlowDef> = {
  "wf:intake": { to: "intake",   from: ["*"],                          counter: null },
  "wf:plan":   { to: "planning", from: ["intake", "planning", "review"], counter: null },
  "wf:review": { to: "review",   from: ["planning", "review"],         counter: "plan_review" },
  "wf:build":  { to: "building", from: ["review"],                     counter: null },
  // 返工触发器：daily 无 fixing 阶段，wf:fix 改指 building（复用 test_fix≤3，零新计数逻辑）
  "wf:fix":    { to: "building", from: ["testing"],                    counter: "test_fix" },
  "wf:test":   { to: "testing",  from: ["building", "testing"],        counter: null },
  "wf:done":   { to: "done",     from: ["testing"],                    counter: null },
};
export const NEXT_DAILY: Record<string, string> = {
  intake: "/wf:plan", planning: "/wf:review", review: "/wf:build（M/L 须 plan-review 结论 PASS）",
  building: "/wf:test", testing: "PASS→/wf:done，FAIL→/wf:fix（回 building 返工）", done: "（终态）",
};
export const GATES_DAILY: Record<string, (st: WfState) => string | null> = {
  // M/L 独立验证硬关卡：plan-review 结论须 PASS（S 自验自律，跳过）
  "wf:build": (st) =>
    st.size === "S" ? null :
      st.planReviewVerdict === "PASS" ? null :
        `❌ 验证关卡未过：plan-review 结论为「${st.planReviewVerdict ?? "未产出"}」（要求 PASS）。` +
        `请委派 wf/planner-reviewer 独立五维验证 plan.md，用 wf_write_artifact(kind=plan-review) 写入（首行 **结论**: PASS|FAIL）；FAIL → wf:plan 带意见修订后再验。`,
  "wf:done": GATES["wf:done"],
};
// mode 选择：存量无 mode → full（兼容）；daily 用子表。所有流转/关卡/指引/下一步提示同源此判定。
export function isDaily(st: WfState): boolean { return (st.mode ?? "full") === "daily"; }
export function flowFor(st: WfState, cmd: string): FlowDef | undefined { return (isDaily(st) ? FLOWS_DAILY : FLOWS)[cmd]; }
export function gateFor(st: WfState, cmd: string): ((st: WfState) => string | null) | undefined { return (isDaily(st) ? GATES_DAILY : GATES)[cmd]; }
export function nextFor(st: WfState, phase: string | null | undefined): string { return (isDaily(st) ? NEXT_DAILY : NEXT)[phase ?? ""] ?? "/wf:intake"; }

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
// M16-r28 翻案（性能审计批次 1 B1-1）：真机实证 review 阶段 4 次误伤（node -e 代码里的
//   `=>` 被解析成重定向、`tee out.txt < input` 把 input 当目标），每次误伤=一轮拦截+重试。
//   修正：①重定向符前为 <>= 时不匹配（箭头函数/比较符）；②目标含 $ 或反引号跳过
//   （变量拼接无法判定具体文件，与尾参分支既有过滤同语义）；③尾参过滤 <>&| 起始 token。
// 仍保留 fail-closed：纯数字目标（`> 2`）视为代码比较跳过；无法解析的形态宁可漏判不误伤。
const SHELL_DEST_CMDS: Set<string> = new Set(["touch", "mkdir", "rm", "mv", "cp", "tee", "rsync", "ln", "install"]);
export function shellWriteTargets(cmd: unknown): string[] {
  const found = new Set<string>();
  if (!cmd || typeof cmd !== "string") return [];
  // 重定向目标：> f / >> f / 2> f（引号或裸 token，含 * 的跳过）
  // (?<![运算符]) 排除 `=>`/`->`/`<=` 等代码比较符（真机实证 node -e 内被误拦）
  const re = /(?<![<>=+*/%&|^~-])(?:\d*>>?|<>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const bare = m[3];
    const t = m[1] ?? m[2] ?? bare;
    if (!t || t.includes("*") || t.includes("$") || t.includes("`") || /^\d+$/.test(t)) continue;
    // 裸 token 须像路径（含 / 或 .）——比较符后的代码词（`a > b` 的 b、`> {`）不再误伤；
    // 无扩展名裸重定向（`> build`）漏判可接受（fail-open 方向，见 README 已知边界）
    if (bare && !bare.includes("/") && !bare.includes(".")) continue;
    found.add(t);
  }
  // 目的参数明确的写/删类命令：取每段最后一个非旗标参数（rm/mv/cp 目的在最后）
  for (const seg of cmd.split(/(?:&&|\|\||[;|\n])/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const head = (toks[0] ?? "").replace(/^.*\//, "");
    if (!SHELL_DEST_CMDS.has(head)) continue;
    const pos: string[] = [];
    for (const x of toks.slice(1)) {
      if (/^[<>&|]/.test(x)) break; // M16-r28：遇重定向符即停——`tee out.txt < input` 不得把 input 当目标
      if (x.startsWith("-") || /^\d+$/.test(x) || x.includes("$") || x.includes("`")) continue;
      pos.push(x);
    }
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

// T01：Unicode 字母/数字全保留（\p{L}\p{N}）——中文 slug 不再折叠为空回退 untitled；
// 其余字符（含空白/标点/下划线）折叠为连字符，语义与旧版 [^a-z0-9]+ 等价、仅扩字符集。
// T13：截断按码点（Array.from）——code unit 截断会切裂代理对（扩展区汉字）
export const slugify = (t: unknown): string =>
  Array.from(String(t ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")).slice(0, 40).join("");

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
  "💡 检测到你在表达「流程化开发」意图。本项目装有 wf 工作流插件（规划→审核∥可行性→红测试→单树 TDD 执行→审核→验证→修复→复盘）。",
  "若想让本任务走工作流：执行 /wf:intake <任务slug>。若不需要，忽略本提示（不影响任何功能）。",
  "可用命令：/wf:intake /wf:plan /wf:review /wf:test-design /wf:build /wf:reconcile /wf:review-build /wf:test /wf:fix /wf:done；辅助：/wf:status /wf:diagnose /wf:ping /wf:reset。",
].join("\n");

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
// 只读/清理豁免集：任何 agent 可用（用户自助诊断/清理不受限）。
export const READONLY_CMDS = new Set(["wf:status", "wf:diagnose", "wf:ping", "wf:reset"]);
// 判定：豁免集放行；其余仅 leader（workflow，兼容 wf/leader）；agent 不可确认 → 变更类 fail-closed。
// lane 整体 leader-only（含 ls，有意收紧：lane 属任务内部细节）。返回拒绝文案或 null（放行）。
export function leaderOnlyReject(agent: string, cmd: string): string | null {
  if (READONLY_CMDS.has(cmd)) return null;
  if (isLeader(agent)) return null;
  if (!agent) return `❌ 无法确认 agent 身份，工作流变更仅限 ${LEADER_AGENT}：请在 ${LEADER_AGENT} 会话执行（查看状态可用 /wf:status）。`;
  return `❌ 工作流仅限 ${LEADER_AGENT}（当前 agent=${agent}）。请切换到 ${LEADER_AGENT} 会话执行；查看状态可用 /wf:status。`;
}

// ── M16-r40：角色→子会话自动登记（纯函数可测）────────────────────────
// 仅 wf/* 非 leader 子会话、ses_ 合法形状才登记；同角色 sessionID 未变化返回 false
// （调用方据此决定是否落盘，避免每次工具调用都 save）。返回 true=已改写 st.roleSessions。
// leader 自身（workflow / wf/leader）与普通 agent（build 等）不登记。
export function trackRoleSession(st: WfState, agent: unknown, sessionID: unknown): boolean {
  const a = String(agent ?? "");
  const sid = String(sessionID ?? "");
  if (!a.startsWith("wf/") || isLeader(a)) return false;
  if (!/^ses_[A-Za-z0-9]+$/.test(sid)) return false;
  if (st.roleSessions?.[a]?.sessionID === sid) return false;
  (st.roleSessions ??= {})[a] = { sessionID: sid, at: new Date().toISOString() };
  return true;
}

// ── 流转校验+应用（P0-b 提取自 transition 闭包，行为与 M16 一致）────
// 通过 → 原地完成 counter 递增（进入即计数）与 intake 重置/slug 设置，返回 { ok: true }；
//       调用方随后设 st.phase=FLOWS[cmd].to、st.updatedAt，并负责 log/save/inject/emit。
// 拒绝 → 返回 { ok: false, note, msg }（拒绝发生在计数之前，不消耗循环额度）。
// st 须带 rounds: { plan_review, build_review, test_fix }。
// P2：limits 可按实例覆盖（options.limits），默认取模块 LIMITS。
export type TransitionResult = { ok: true } | { ok: false; note: string; msg: string };
export function evaluateTransition(cmd: string, st: WfState, text: unknown, at = new Date().toISOString(), limits: Limits = LIMITS): TransitionResult {
  // M16-r34：mode 选择流转表/关卡/下一步（daily 子表 vs full；存量无 mode → full 兼容）
  const daily = isDaily(st);
  const flow = flowFor(st, cmd);
  const from = st.phase ?? null;

  // daily 子表无 test-design/reconcile/review-build → 显式拒绝（防 flow undefined 崩溃）
  if (!flow) {
    return {
      ok: false, note: "unknown-command",
      msg: `❌ ${daily ? "日常模式" : "完整模式"}无 /wf:${cmd.slice(3)} 命令。${daily ? "日常流：plan→review→build→test→done（FAIL→fix 返工）。" : ""}当前下一步：${nextFor(st, from)}`,
    };
  }

  if (!(flow.from.includes("*") || flow.from.includes(from ?? ""))) {
    return {
      ok: false, note: "illegal-transition",
      msg: `❌ 拒绝：/wf:${cmd.slice(3)} 不能从阶段「${from ?? "无"}」进入「${flow.to}」（合法来源：${flow.from.join("/") || "无"}）。当前下一步：${nextFor(st, from)}`,
    };
  }

  // M5：进阶关卡（在轮次计数之前拒绝，不消耗循环额度）
  const gate = gateFor(st, cmd);
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
  // 新任务可凭旧状态蒙混过双通道/验收关卡；中途 intake 也会误丢进度）
  if (cmd === "wf:intake") {
    const raw = promptText(text).trim();
    const force = raw.startsWith("!");
    if (from && from !== "done" && !force) {
      return {
        ok: false, note: "intake-guard",
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

  return { ok: true };
}

// ── M16-r29：阶段纪律——产物期望阶段映射 + 错位告警（纯函数可测）────────────
// 真机实证（auth-login r28）：leader 把 reviewer/tester 提前塞进 planning，产物重复写
// 浪费 ~15-20m。此处只做「告警不阻断」：让错位在 tool output 可见，引导 leader 归位。
export const ARTIFACT_PHASE: Record<string, string> = {
  plan: "planning",
  "plan-review": "review",
  "test-plan": "review",
  "build-review": "build_review",
  "test-report": "testing",
  lessons: "done",
};
export function artifactPhaseWarning(kind: string, phase: string | null | undefined): string | null {
  const expected = ARTIFACT_PHASE[kind];
  if (!expected || !phase || phase === expected) return null;
  return `⚠️ 产物阶段错位：${kind} 应在「${expected}」阶段产出，当前「${phase}」——疑似提前委派（会重复写、浪费工时）。请归位：各 wf 角色只在对应阶段委派（planner→planning、reviewer/tester→review）。`;
}

// ── M16-r32：产物瘦身预算——体积/结构约束（纯函数可测）────────────
// 真机实证（auth-login r28）：plan.md 40KB 生成 ~6.6min，耗时与体积成正比；工具本身毫秒级。
// 软预算 + 超预算告警（不阻断）：压生成耗时，同时减下游 reviewer 阅读量（双重收益）。
export const ARTIFACT_BUDGET_KB: Record<string, number> = {
  plan: 15,
  "plan-review": 8,
  "test-plan": 10,
  "build-review": 8,
  "test-report": 10,
  lessons: 6,
};
// M16-r33 P2：S 级（简易/演示任务）收紧预算——真机取证 todolist 简易任务 plan 26KB/test-plan 22KB
// 杀鸡用牛刀。L 级用 M 预算（体量标记只驱动从简指引，不放宽体积）。单位=KB（字节计，中文×~1.5）。
export const ARTIFACT_BUDGET_S_KB: Record<string, number> = {
  plan: 5,
  "plan-review": 3,
  "test-plan": 3,
  "build-review": 3,
  "test-report": 4,
  lessons: 3,
};
export function budgetFor(kind: string, size?: string | null): number | null {
  const table = size === "S" ? ARTIFACT_BUDGET_S_KB : ARTIFACT_BUDGET_KB;
  return table[kind] ?? null;
}
export function artifactSizeWarning(kind: string, bytes: number, size?: string | null): string | null {
  const budget = budgetFor(kind, size);
  if (!budget || bytes <= budget * 1024) return null;
  const tier = size === "S" ? "S" : "M";
  return `⚠️ 产物超瘦身预算：${kind} ${(bytes / 1024).toFixed(1)}KB > ${budget}KB（${tier} 级，字节计）——请精简（表格化/只留要点/删冗长散文）；修订用 wf_write_artifact 的 patch 模式删减冗余章节，勿全量重写。`;
}

// ── P2：/wf:ping 角色健康检查（纯函数可测）────────────────────────
// WF_ROLES = 工作流契约的 7 个 subagent 角色（leader 除外，leader 是当前会话）。
// agents 形状容错：数组、{agents} 或 {data}（2.2.6 真机 ctx.agent.list() 实际返回
// {location, data:[...]}——agent-probe.json 2026-11-10 实证），项取 name/id 与 model.providerID/model.id。
export const WF_ROLES = ["wf/planner", "wf/planner-reviewer", "wf/tester", "wf/builder",
  "wf/builder-reviewer", "wf/fixer", "wf/learner"];
export interface AgentLike {
  name?: string;
  id?: string;
  model?: { providerID?: string; id?: string };
}
export function pingReport(agents: AgentLike[] | { agents?: AgentLike[]; data?: AgentLike[] } | null | undefined): string {
  const arr = Array.isArray(agents) ? agents : (agents?.agents ?? agents?.data ?? []);
  const norm = arr.map((a) => ({
    name: String(a?.name ?? a?.id ?? ""),
    model: a?.model?.providerID ? `${a.model.providerID}/${a.model.id ?? "?"}` : null,
  }));
  const found = norm.filter((n) => n.name.startsWith("wf/"));
  // 计数只算 WF_ROLES 交集：leader 主名 workflow 不在 wf/ 前缀内天然不计；兼容别名 wf/leader
  // 若仍注册则归"额外"（真机实证：registry 含 7 subagent + leader primary → 原实现曾计成 8/7）
  const matched = found.filter((f) => WF_ROLES.includes(f.name));
  const missing = WF_ROLES.filter((r) => !matched.some((f) => f.name === r));
  const extra = found.filter((f) => !WF_ROLES.includes(f.name)).map((f) => f.name);
  return [
    `wf 角色：${matched.length}/${WF_ROLES.length} 已注册`,
    ...matched.map((f) => `  ${f.name} model=${f.model ?? "(继承会话模型)"}`),
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
  rpcErr?: string | null; // M16-r39 T06：bridge rpcErr 形状同源（string|null）
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
  for (const [k, limit] of Object.entries({ ...LIMITS, ...facts.limits })) {
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
  out.push(`  下一步：${nextFor(st, st.phase)}`);
  return out.join("\n");
}