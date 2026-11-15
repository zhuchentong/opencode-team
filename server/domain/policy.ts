// wf-workflow — domain/policy：hint 触发/leader-only 权限/ping 报告/引擎自改护栏（自 lib.ts 逐字节平移）。
import { isLeader, LEADER_AGENT, DAY_MS, type WfState } from "./types.ts";

// ── P3：superpowers 式自动激活提示（纯函数可测）────────────────────
// 宿主若提供消息观察 hook：用户消息命中「明确工作流意图」且该会话无 wf 状态时，
// 注入一次性 hint entry（不自动开任务，仅提示 /wf:intake）。误触率优先于召回率。
/** 「明确工作流意图」触发词表（误触率优先于召回率，仅提示不自动开任务）。 */
export const HINT_TRIGGERS = [
  "工作流", "流程开发", "按流程", "完整流程", "走流程", "planned development",
  "superpowers", "wf workflow", "formal workflow",
];
/**
 * 判定用户消息是否命中 hint 触发词（大小写不敏感）。
 * @param text 用户消息文本（容错）
 * @returns 命中任一触发词时为 true
 */
export function isHintWorthy(text: unknown): boolean {
  const t = String(text ?? "").toLowerCase();
  if (!t) return false;
  return HINT_TRIGGERS.some((k) => t.includes(k.toLowerCase()));
}
/** 一次性自动激活提示全文（注入 entry 通道，提示 /wf:intake 而不自动开任务）。 */
export const HINT_ENTRY = [
  "💡 检测到你在表达「流程化开发」意图。本项目装有 wf 工作流插件（规划→审核∥可行性→红测试→单树 TDD 执行→审核→验证→修复→复盘）。",
  "若想让本任务走工作流：执行 /wf:intake <任务slug>。若不需要，忽略本提示（不影响任何功能）。",
  "可用命令：/wf:intake /wf:plan /wf:review /wf:test-design /wf:build /wf:reconcile /wf:review-build /wf:test /wf:fix /wf:done；辅助：/wf:status /wf:diagnose /wf:ping /wf:reset。",
].join("\n");

// 只读/清理豁免集：任何 agent 可用（用户自助诊断/清理不受限）。
// M16-r46 批2：+wf:open（产物查看只读——TUI 键盘路径与非 TUI 客户端降级轨入口）。
/** 只读/清理豁免命令集（任何 agent 可用，用户自助诊断/清理不受限）。 */
export const READONLY_CMDS = new Set(["wf:status", "wf:diagnose", "wf:ping", "wf:reset", "wf:open"]);
// 判定：豁免集放行；其余仅 leader（workflow，兼容 wf/leader）；agent 不可确认 → 变更类 fail-closed。
// lane 整体 leader-only（含 ls，有意收紧：lane 属任务内部细节）。返回拒绝文案或 null（放行）。
// F1（implant×build 卡死 1.5 天实证）：可选第三参 st=本会话快照——会话持任务时说明「本会话即
// leader 会话，只是 agent 被切走」，旧文案「请切换到 workflow 会话」误导开新会话接管（新会话拿不到
// 任务行，done 永远推不动）。两出口并列：切回 workflow 重跑 / 直接 /wf:reset 清账（reset 在豁免集）。
// st 缺省或无任务 → 旧文案逐字（存量断言零改动）。
/**
 * leader-only 权限判定：豁免集与 leader 放行（null）；其余 agent 返回 ❌ 拒绝文案
 * （含「本会话即 leader 会话」的两出口改道文案，F1 修复）。
 * @param agent 当前 agent 名（空=身份不可确认，fail-closed）
 * @param cmd 待执行的 wf 命令名
 * @param st 本会话状态快照（可选；持任务时启用改道文案）
 * @returns 拒绝文案，null=放行
 */
export function leaderOnlyReject(agent: string, cmd: string, st?: WfState | null): string | null {
  if (READONLY_CMDS.has(cmd)) return null;
  if (isLeader(agent)) return null;
  if (!agent) return `❌ 无法确认 agent 身份，工作流变更仅限 ${LEADER_AGENT}：请在 ${LEADER_AGENT} 会话执行（查看状态可用 /wf:status）。`;
  if (st && st.slug && st.phase) {
    return `❌ 工作流变更仅限 ${LEADER_AGENT}（当前 agent=${agent}）。本会话即任务「${st.slug}」（phase=${st.phase}）的 leader 会话——` +
      `把本会话切回 ${LEADER_AGENT} 后重跑 ${cmd} 即可，勿新开会话接管（新会话拿不到该任务）；` +
      `确要放弃收尾可在本会话直接 /wf:reset 清账（丢 done 交付环节，进度已入 events 审计）。只读命令 /wf:status /wf:diagnose /wf:ping /wf:open 不受限。`;
  }
  return `❌ 工作流仅限 ${LEADER_AGENT}（当前 agent=${agent}）。请切换到 ${LEADER_AGENT} 会话执行；查看状态可用 /wf:status。`;
}

// ── P2：/wf:ping 角色健康检查（纯函数可测）────────────────────────
// WF_ROLES = 工作流契约的 7 个 subagent 角色（leader 除外，leader 是当前会话）。
// agents 形状容错：数组、{agents} 或 {data}（2.2.6 真机 ctx.agent.list() 实际返回
// {location, data:[...]}——agent-probe.json 2026-11-10 实证），项取 name/id 与 model.providerID/model.id。
/** 工作流契约的 7 个 subagent 角色名（leader 除外；wf:ping 缺失/额外判定基准）。 */
export const WF_ROLES = ["wf/planner", "wf/planner-reviewer", "wf/tester", "wf/builder",
  "wf/builder-reviewer", "wf/fixer", "wf/learner"];
/** agent 注册项的宽松形状（ctx.agent.list() 边界容错投影）。 */
export interface AgentLike {
  name?: string;
  id?: string;
  model?: { providerID?: string; id?: string };
}
/**
 * wf:ping 角色健康检查报告：对宿主 agent 注册表（数组或 {agents}/{data} 包装）归一后
 * 与 WF_ROLES 交集计数，输出已注册清单、档位行、缺失/额外角色。
 * @param agents 宿主 agent 列表（形状容错：数组、{agents} 或 {data}）
 * @param tierLine 可选档位行（前置插入，折叠显示面也能看到档位实况）
 * @returns 多行报告文本
 */
export function pingReport(agents: AgentLike[] | { agents?: AgentLike[]; data?: AgentLike[] } | null | undefined, tierLine?: string | null): string {
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
    ...(tierLine ? [tierLine] : []), // P0-B 档位行前置：折叠/截断显示面（brief 只保首行+尾截）也能看到档位实况
    ...matched.map((f) => `  ${f.name} model=${f.model ?? "(继承会话模型)"}`),
    ...(missing.length ? [`  ⚠️ 缺失：${missing.join(", ")}`] : []),
    ...(extra.length ? [`  ℹ️ 额外：${extra.join(", ")}`] : []),
  ].join("\n");
}

// ── selfmod-concurrency-guard T01（F2 v2）：引擎自改并发护栏（纯逻辑；跨库扫描 IO 在 state.ts，接线在 commands.ts）──
// 背景（双任务日志实证）：notification-brief-display 修改插件自身仓库时，builder 对入口文件分步
//   连续 edit 的热载中间态被同进程 dso-app 在途会话真实执行（其 wf.db 被静默 ALTER 加列）。
// v1 进程内存注册表盲区（implant×build 卡死 1.5 天实证 + 多日 resume 习惯取证）：休眠未收尾任务
//   不在内存、热载即清零 → v2 改跨库扫描：PROJECT_DBS 内存表 ∪ 持久项目清单逐库查 is_active=1；
//   updatedAt 分级活跃/休眠（休眠=可能已废弃，同样先裁决再开工——唤醒后即干扰源）。
/** 其它项目活动任务的投影（跨库扫描结果，selfMod 告警分级输入）。 */
export interface ActiveOther { slug: string; phase: string | null; directory: string | null; updatedAt: string | null }

// ── r55 修复2（test_010 实证）：lane cap 计数排除波次残留 ─────────────────────
// 旧实现 active 数=全部 status!=="done" 行——多波构建中前波 lane 保持 active（收尾只在 wf:done，
// r53 F1）→ 每波 wf:lane set 误报「活跃 5 > cap 4」，leader 花往返解释。新口径：
// lastUsedAt 超 LANE_STALE_MS 的 active 行=疑似已完成波次残留，不进 cap 计数、降为 ℹ️ 信息行
// 给处置出口（wf:lane done <Tnn>）；不自动收尾（休眠 lane 误杀风险，宁提示不代裁）。
// 真活跃超线仍 ⚠️ 告警——软 cap 语义不放松。
/** 波次残留判定窗：单波 builder 实测 5-10 分钟，1 小时窗足够宽不误伤真实并行。 */
export const LANE_STALE_MS = 60 * 60 * 1000;
/** lane 行最小事实（commands 透传，避免 domain 依赖命令层形状）。 */
export interface LaneCapEntry { status?: string; lastUsedAt?: string; at?: string }
/** lane cap 告警行（纯函数，bun test 直测；now 注入）。
 * @param lanes lanes 记账（st.lanes）
 * @param cap 生效软上限（LIMS.lane_cap 覆盖后值）
 * @param nowMs 当前时钟（ms）
 * @param others 跨库活跃任务数（提示用）
 * @returns capNote 文本（无告警无残留=空串） */
export function laneCapNote(lanes: Record<string, LaneCapEntry> | undefined, cap: number, nowMs: number, others: number): string {
  const live: string[] = [], stale: string[] = [];
  for (const [k, v] of Object.entries(lanes ?? {})) {
    if (v?.status === "done") continue;
    const t = Date.parse(v?.lastUsedAt ?? v?.at ?? "");
    const age = nowMs - (Number.isFinite(t) ? t : 0);
    (Number.isFinite(t) && age >= 0 && age < LANE_STALE_MS ? live : stale).push(k);
  }
  let note = "";
  if (live.length > cap) note += `\n⚠️ 活跃 builder lane ${live.length} > cap ${cap}——本地网关可能互相挤占；其余活跃任务 ${others} 个。超线并行=例外，须说明理由。`;
  if (stale.length) note += `\nℹ️ 另有 ${stale.length} 行疑似已完成波次残留（lastUsedAt 超 60 分钟）：${stale.join(",")}——用 wf:lane done <Tnn> 收尾。`;
  return note;
}
// 目录比较（尾斜杠归一；任一侧空=false=判不出不算自改，fail-open 宁缺勿滥告警）
const normDir = (d: unknown) => String(d ?? "").replace(/[\\/]+$/, "");
/**
 * 引擎自改判定：任务目录与插件仓库根相同（尾斜杠归一；任一侧为空判不出即 false，fail-open）。
 * @param taskDir 任务目录
 * @param pluginRoot 插件仓库根目录
 * @returns 两者归一后相同为 true
 */
export function isSelfModDir(taskDir: unknown, pluginRoot: unknown): boolean {
  const a = normDir(taskDir), b = normDir(pluginRoot);
  return !!a && !!b && a === b;
}
// ⚠️ 前缀（成功轨告警，非拒绝——❌ REJECT_PREFIX 互斥不变量由 tests/brief-level.test.js 守卫；
// 本行为=advisory，裁决权在用户）。>5 项折叠防长单行；directory 不入文案（噪音），slug·phase 足够定位。
// F2 v2 分级：updated_at 距 now <24h=活跃；否则=休眠（≥N 天未更新+最后时刻 MM-DD，可能已废弃）——
// 休眠任务被唤醒后同样是热载干扰源（implant 实证），文案给出各自处置出口（活跃=暂停/同意并发；
// 休眠=先核实后 done 收尾或 reset 清账）。updatedAt 解析失败按休眠·日期未知（宁保守多提示）。
/**
 * 引擎自改并发告警行：跨项目活动任务按 updatedAt 分级（<24h 活跃 / 其余休眠含天数与日期），
 * 输出 ⚠️ 处置出口文案（advisory 不阻断，❌ 前缀互斥不变量守卫）。
 * @param others 其它活动任务列表（>5 折叠防长单行）
 * @param now 当前毫秒（注入便于测试）
 * @returns 告警文案，无其它任务时 null
 */
export function selfModWarnLine(others: ActiveOther[], now: number = Date.now()): string | null {
  if (!others.length) return null;
  const DAY = DAY_MS; // 天毫秒单点（domain/types）
  const tag = (o: ActiveOther): string => {
    const label = `${o.slug || "(未定)"}·${o.phase ?? "?"}`;
    const t = Date.parse(String(o.updatedAt ?? ""));
    if (!Number.isFinite(t)) return `${label}（休眠，日期未知）`;
    if (now - t < DAY) return `${label}（活跃）`;
    const days = Math.max(1, Math.floor((now - t) / DAY));
    return `${label}（休眠≥${days}天未更新，最后 ${String(o.updatedAt).slice(5, 10)}，可能已废弃）`;
  };
  const shown = others.slice(0, 5).map(tag).join("、");
  return `⚠️ 引擎自改护栏：本任务修改插件自身仓库，跨项目扫描发现 ${others.length} 个其它活动任务（${shown}${others.length > 5 ? " 等" : ""}）。` +
    "热载新代码会作用于全部在途会话，休眠任务被唤醒后同样受影响——请先 question 呈用户裁决后再委派 builder：" +
    "活跃任务=暂停或明确同意并发；休眠任务=先 /wf:status 核实，done 收尾或 /wf:reset 清账；" +
    "builder 对 server/ 入口文件禁分步连续 edit，全部编辑完成后一次性核验。";
}
