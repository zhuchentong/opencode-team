// wf-workflow — 动态档位跟随（M16-r43）：会话所选模型（Session.Info.model = Model.Ref
// {id, providerID, variant?}）→ 按 TIER_MAP 为各流程角色派生同基座不同 variant 的模型引用，
// 写项目级 .opencode/agents/wf/<role>.md（frontmatter 仅 mode+model），宿主文件热载即效。
// P3 探针实证（2026-11-12，宿主 2.2.6）：项目级文件空 body 保留全局同名角色 system/description
// （per-key merge）；frontmatter model 含 #variant 端到端生效（子会话 Session.Info.model 实证）；
// /api/agent 序列化**不含 model 键**——档位展示读项目级文件，不走 agent.list。
// 探针另证（宿主 opencode.jsonc 配置面）：tu-coding（openai-compatible 包）的 settings.reasoningEffort
// **不转发**，variants 必须用 body 直注（{"reasoning_effort":...}）——写法陷阱记录于 README。
// 纯逻辑（resolveTierRef/tierFileContent/hasTierMarker）bun test 直测；IO（syncTierAgents）注入 io。
// fail-open 约定由调用方保证：任何异常不阻断流转（commands.ts tierCheck try/catch）。
// dispatch-tier-inject T01：effectiveTiers/extractVariantIds 自 middleware.ts 同源迁入（白名单过滤 +
// variants 提取单一来源，T02 注入判定/T04 ping 活算共用）；inherit 分支增 managed 清理（unlink）。

import { swallow } from "./observe.ts"; // T01：静默 catch → 环形审计记账

export type ModelRef = { id: string; providerID: string; variant?: string };

// 档位强度序（降级链：请求档缺失时向下取最近存在档；无更低 → null=不写文件，继承会话默认档）。
// 含非标准档名（qwen4 网关用 medium/xhigh）。
const ORDER = ["off", "low", "medium", "high", "xhigh", "max"];

// 默认档位映射（options.tiers 覆盖）。workflow 是 primary，天然跟随会话模型，不进表。
/** 默认角色档位映射（options.tiers 覆盖；workflow 是 primary 天然跟随基座，不进表；原子上线纪律见 P0-B 注）。 */
export const TIER_MAP: Record<string, string> = {
  "wf/planner": "high",
  "wf/planner-reviewer": "high",
  "wf/tester": "high",
  // P0-B（latency-v3.1 波次2 原子包）：执行角色 low——推理预算跟角色职责走（builder 368K reasoning
  // 中 78K 是重复 planner 已做的设计；该网关 variants=[off,low,high,max] 无 medium，写实测存在档）。
  // learner low：其 68K reasoning=lessons 质量本体（归零是事故），仅裁冗余不归零。
  // 原子纪律：本映射与 options.tierAgents=true 必须同一次上线（"off" 一旦开开关就真归零——v3 最大陷阱）。
  "wf/builder": "low",
  "wf/builder-reviewer": "high",
  "wf/fixer": "high",
  "wf/learner": "low",
};

/** 档位管辖角色清单（TIER_MAP 键；middleware 白名单与 ping 展示共用）。 */
export const TIER_ROLES = Object.keys(TIER_MAP);

// ── opt-agentic（tier-no-project-files）：tierAgents 三态模式（用户需求：档位配置零项目目录落地）──
// "inject"（新默认，含缺省/"inject-only"/"inject"）：仅派发时 args.model 注入，不写项目级派生文件；
//   档位视图走 st.reuse.tierBase 活算（rpc-bridge/ping），项目 .opencode/agents/wf/ 不再生成。
// "files"（或 true，旧默认显式保留）：双通路——syncTierAgents 写项目级派生文件（旧行为）。
// "off"（false）：关闭档位跟随（旧语义不变）。
// 默认翻转依据：wf/* 角色仅在 subagent 创建时实例化（leaderGate 硬拒子会话自委派），注入钩子
// 恰覆盖该时刻——文件通路对程序化派发冗余；诚实边界=注入依赖 hook 链存活（fail-open 静默失败
// 时该次委派退化会话默认档，ping verified 即时视图可见），且 args.model 生效性注释仍标「待真机
// 首验」——显式 tierAgents:true 可随时回退文件通路。
export type TierAgentsMode = "off" | "files" | "inject";
/**
 * 解析 tierAgents 三态模式（活读调用方传入的 options；缺省=inject，零项目目录落地）。
 * @param options 插件 options
 * @returns "off"（关闭）| "files"（双通路写派生文件）| "inject"（仅派发时注入）
 */
export function tierAgentsMode(options: { tierAgents?: boolean | string } | null | undefined): TierAgentsMode {
  const v = options?.tierAgents;
  if (v === false) return "off";
  if (v === true || v === "files") return "files";
  return "inject";
}

/** 触发档位校验的命令集（10 个流转命令；status/diagnose/ping/lane/reset/debug 豁免）。 */
export const TIER_TRIGGERS = new Set([
  "wf:intake", "wf:plan", "wf:review", "wf:test-design", "wf:build",
  "wf:reconcile", "wf:review-build", "wf:test", "wf:fix", "wf:done",
]);

// dispatch-tier-inject T01：options.tiers 白名单过滤同源（语义逐字迁自 middleware.ts P1-B 段）。
// 未知角色若放行会被 syncTierAgents 真实落盘成派生 agent 文件（幽灵 subagent 注册，V5 实证）。
/** 合并默认映射与 options.tiers 覆盖（白名单过滤：未知角色拒入 tiers，收集进 unknown 供审计）。
 * @param options 插件 options（null/undefined 安全，缺省=TIER_MAP）
 * @returns tiers=生效映射；unknown=配置中的未知角色清单 */
export function effectiveTiers(options: { tiers?: Record<string, string> } | null | undefined): { tiers: Record<string, string>; unknown: string[] } {
  const userTiers: Record<string, string> = options?.tiers ?? {};
  const unknown = Object.keys(userTiers).filter((r) => !TIER_ROLES.includes(r));
  const tiers = { ...TIER_MAP, ...Object.fromEntries(Object.entries(userTiers).filter(([r]) => TIER_ROLES.includes(r))) };
  return { tiers, unknown };
}

// dispatch-tier-inject T01：variants 提取同源（计算体迁自 middleware.ts，list IO 留调用方）。
// R3：null/无效 ref 直接返回 []（不 swallow——无效 ref≠variants 空，防审计噪音）；
// 有效 ref 但结果空集 → 同源审计 model-tier:variants-empty（T04 ping 空集告警复用此审计不重复记账）。
/** 从 models.list 返回形状提取基座模型的 variant id 集合（array/data/models 三形状兼容）。
 * @param ml host.models.list() 原样返回（形状未实证 → 三形状兜底）
 * @param ref 基座模型引用；null/缺 id/providerID → 直接 []（不产生审计噪音）
 * @param opts 可选项
 * @param opts.auditEmpty false=空集静默（档位视图 5s 轮询消费面防灌环）；缺省 true=空集审计
 * @returns variant id 数组；空集时按 opts 记/不记 model-tier:variants-empty 审计 */
export function extractVariantIds(ml: unknown, ref: ModelRef | null | undefined, opts: { auditEmpty?: boolean } = {}): string[] {
  if (!ref?.id || !ref?.providerID) return []; // R3：无效 ref≠variants 空，静默返回不记账
  const m = ml as any;
  const arr: any[] = Array.isArray(m) ? m : (m?.data ?? m?.models ?? []);
  const hit = arr.find((x: any) => x?.id === ref.id && x?.providerID === ref.providerID)
    ?? arr.find((x: any) => x?.id === ref.id);
  const ids = (hit?.variants ?? []).map((v: any) => v?.id).filter(Boolean);
  if (!ids.length && opts.auditEmpty !== false) swallow(new Error("variants empty"), "model-tier:variants-empty");
  return ids;
}

// dispatch-tier-inject T02：派发时注入判定（纯函数零 IO；fileContent 由 hook 侧读文件作入参，
// 缺失/读失败=null）。判定链短路序=审计 reason 优先级：①门（enabled/slug/target）→none 静默；
// ②explicit-model ③unmanaged ④inherit ⑤no-variant ⑥inject。消费 T01 同源 effectiveTiers 产物 tiers。
/** 派发时档位注入判定结果：inject=就地改写 args.model；skip=让位（reason 供审计）；none=静默不记账。 */
export type TierInjectDecision =
  | { action: "inject"; model: string; ref: ModelRef }
  | { action: "skip"; reason: "unmanaged" | "no-variant" | "inherit" | "explicit-model" }
  | { action: "none" };

/** 派发时档位注入判定（纯函数零 IO，短路序=审计 reason 优先级）。
 * @param a 判定入参：enabled 开关/slug 活动任务/target 目标角色（须 ∈ TIER_ROLES）/explicitModel args.model 原值
 * （非空显式不覆盖）/fileContent 派生文件全文（缺失/读失败=null，无标记=unmanaged 让位）/ref leader 基座引用
 * （null→no-variant）/variantIds 基座可用 variant 集合/tiers 生效映射（effectiveTiers 产物）
 * @returns TierInjectDecision */
export function resolveTierInjection(a: {
  enabled: boolean; slug?: string; target: string; explicitModel?: unknown;
  fileContent: string | null; ref: ModelRef | null; variantIds: string[];
  tiers: Record<string, string>;
}): TierInjectDecision {
  if (!a.enabled || !a.slug || !TIER_ROLES.includes(a.target)) return { action: "none" }; // ① 静默门
  if (a.explicitModel != null && String(a.explicitModel) !== "") return { action: "skip", reason: "explicit-model" }; // ②
  if (a.fileContent != null && !hasTierMarker(a.fileContent)) return { action: "skip", reason: "unmanaged" }; // ③
  const tier = a.tiers?.[a.target];
  if (tier === "inherit") return { action: "skip", reason: "inherit" }; // ④
  const ref = a.ref ? resolveTierRef(a.ref, a.variantIds, tier) : null; // ⑤ ref null/variants 空/无更低档
  if (!ref) return { action: "skip", reason: "no-variant" };
  return { action: "inject", model: `${ref.providerID}/${ref.id}#${ref.variant}`, ref }; // ⑥
}

// 解析某角色的档位引用。定稿分支（M16-r43 验证报告）：
// - variants 为空 → null（跳写文件：继承父会话模型 = 形态 B 效果，少 7 个派生文件少一次热载）
// - 请求档在集合 → #tier；不在 → 沿强度序向下取最近存在档；无更低（如 off 缺失）→ null（继承默认）
/** 解析某角色的档位引用：variants 空→null（跳写继承基座）；请求档存在→#tier；否则沿强度序降级取最近存在档；
 * inherit 哨兵/未知档名/无更低档→null（不派生文件）。
 * @param ref 会话基座模型引用（Model.Ref 形状）
 * @param variantIds 该模型可用 variant id 集合（fail-soft 空集亦合法）
 * @param tier 目标档名（TIER_MAP 值或 options.tiers 覆盖值）
 * @returns 带 variant 的 ModelRef，或 null=不写派生文件 */
export function resolveTierRef(ref: ModelRef, variantIds: string[], tier: string): ModelRef | null {
  if (!ref?.id || !ref?.providerID) return null;
  // P0-B：inherit 显式哨兵——消除 "off" 多义词（off=真归零 vs 不跟随），语义=不派生文件、跟随基座默认。
  // （行为与未知档名 null 通路一致，显式化是为了审计行可区分 + 不依赖 ORDER 实现。）
  if (tier === "inherit") return null;
  const ids = Array.isArray(variantIds) ? variantIds.filter(Boolean) : [];
  if (!ids.length) return null;
  const base = { providerID: ref.providerID, id: ref.id };
  if (ids.includes(tier)) return { ...base, variant: tier };
  const ti = ORDER.indexOf(tier);
  if (ti < 0) return null; // 未知档名 → 不冒险，继承默认
  const below = ids.filter((v) => { const vi = ORDER.indexOf(v); return vi >= 0 && vi < ti; });
  if (!below.length) return null;
  const best = below.reduce((a, b) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b));
  return { ...base, variant: best };
}

// 派生文件内容：frontmatter 仅 mode+model，托管标记用 YAML 注释行。**body 必须为空**——
// 非空 body 会替换全局同名角色的 system 提示词（agents guide：非空值即替换；P3 探针确认空 body 保留全局）。
/** 生成派生 agent 文件内容：frontmatter 仅 mode+model + YAML 注释托管标记；body 必须为空（空 body 保留全局角色 system）。
 * @param ref 已解析的目标模型引用（含 variant）
 * @returns 完整文件文本 */
export function tierFileContent(ref: ModelRef): string {
  return `---\n# wf-workflow:model-tier managed (M16-r43)\nmode: subagent\nmodel: ${ref.providerID}/${ref.id}#${ref.variant}\n---\n`;
}

// 托管标记识别。无标记的用户自有文件不覆盖（skip-unmanaged，r31 安全规则同源）。
/** 识别本域托管标记（含 "wf-workflow:model-tier managed" 即 true）；无标记的用户自有文件不覆盖。
 * @param content 派生文件全文。
 * @returns 是否含本域托管标记。 */
export function hasTierMarker(content: string): boolean {
  return typeof content === "string" && content.includes("wf-workflow:model-tier managed");
}

export interface TierIO {
  mkdir: (p: string, opts?: unknown) => Promise<unknown>;
  readFile: (p: string, enc?: string) => Promise<string>;
  writeFile: (p: string, c: string) => Promise<unknown>;
  unlink: (p: string) => Promise<unknown>; // dispatch-tier-inject T01：inherit 清理 managed 文件
}

// 写各角色项目级文件（<projectDir>/.opencode/agents/wf/<role>.md）。返回审计行：
// tier-write:<role>=<variant> / tier-keep:<role> / tier-skip:<role>:no-variant|unmanaged。
/** 写各角色项目级派生文件（<projectDir>/.opencode/agents/wf/<role>.md）。
 * @param projectDir 项目根目录
 * @param ref 会话基座模型引用
 * @param variantIds 基座可用 variant 集合
 * @param tiers 角色→档名映射（缺省 TIER_MAP）
 * @param io 注入的文件 IO（mkdir/readFile/writeFile/unlink，bun test 直测用）
 * @returns 审计行数组：tier-write:<role>=<variant> / tier-keep / tier-inherit / tier-inherit-clean / tier-skip:<role>:no-variant|unmanaged */
export async function syncTierAgents(
  projectDir: string,
  ref: ModelRef,
  variantIds: string[],
  tiers: Record<string, string> = TIER_MAP,
  io: TierIO,
): Promise<string[]> {
  const out: string[] = [];
  const dir = `${projectDir}/.opencode/agents/wf`;
  await io.mkdir(dir, { recursive: true });
  for (const [role, tier] of Object.entries(tiers ?? {})) {
    if (tier === "inherit") {
      // P0-B：不派生文件=跟随基座默认。dispatch-tier-inject T01：既有 managed 文件须清理
      // （否则旧档位文件残留继续生效，inherit 语义失真）；unmanaged/缺失绝不触碰文件。
      const path = `${dir}/${role.replace(/^wf\//, "")}.md`;
      let existing = "";
      try { existing = await io.readFile(path, "utf8"); } catch (e) { swallow(e, "model-tier:agent-file-read-fail"); }
      if (existing && hasTierMarker(existing)) {
        await io.unlink(path); // unlink 异常上抛由调用方 tierCheck fail-open 吞（与 writeFile 同风险面）
        out.push(`tier-inherit-clean:${role}`);
      } else {
        out.push(`tier-inherit:${role}`);
      }
      continue;
    }
    const target = resolveTierRef(ref, variantIds, tier);
    if (!target) { out.push(`tier-skip:${role}:no-variant`); continue; }
    const path = `${dir}/${role.replace(/^wf\//, "")}.md`;
    let existing = "";
    try { existing = await io.readFile(path, "utf8"); } catch (e) { swallow(e, "model-tier:agent-file-read-fail"); }
    if (existing && !hasTierMarker(existing)) { out.push(`tier-skip:${role}:unmanaged`); continue; }
    const content = tierFileContent(target);
    if (existing === content) { out.push(`tier-keep:${role}`); continue; }
    await io.writeFile(path, content);
    out.push(`tier-write:${role}=${target.variant}`);
  }
  return out;
}

// 读项目级派生文件当前档位（wf:ping 展示用；/api/agent 不含 model，读文件为准）。
/** 读项目级派生文件当前档位（wf:ping 展示用；/api/agent 不含 model，读文件为准）。
 * @param projectDir 项目根目录
 * @param roles 要读的角色清单（缺省 TIER_ROLES）
 * @param io 注入的 readFile IO
 * @returns "<role>=<variant>" 行数组（读失败/未派生的角色静默跳过） */
export async function readTierAgents(
  projectDir: string,
  roles: string[] = Object.keys(TIER_MAP),
  io: Pick<TierIO, "readFile">,
): Promise<string[]> {
  const out: string[] = [];
  for (const role of roles) {
    try {
      const c = await io.readFile(`${projectDir}/.opencode/agents/wf/${role.replace(/^wf\//, "")}.md`, "utf8");
      const mm = c.match(/^model: (.+)$/m);
      if (mm) out.push(`${role}=${mm[1].split("/").pop()}`);
    } catch (e) { swallow(e, "model-tier:derived-file-read-fail"); }
  }
  return out;
}
// opt-agentic（tier-no-project-files）：档位视图活算（inject 模式无派生文件，TUI/ping 展示改走
// st.reuse.tierBase + models.list 同款口径——与 ping「活算」分支同源，替代 readTierAgents 文件实况）。
// 静默 variants 提取（auditEmpty:false）：视图每 5s 被 TUI 轮询消费，空集审计会灌爆 swallow 环。
/**
 * 档位视图活算：由基座引用 + models.list + 生效映射算 role→variant 视图（无文件 IO）。
 * @param base 已登记基座引用（st.reuse.tierBase）
 * @param ml host.models.list() 原样返回
 * @param options 插件 options（tiers 覆盖）
 * @returns role→variant 映射（全部角色无可用档 → 空对象）；base 无效 → null
 */
export function liveTierVariants(base: ModelRef | null | undefined, ml: unknown, options: { tiers?: Record<string, string> } | null | undefined): Record<string, string> | null {
  if (!base?.id || !base?.providerID) return null;
  const variantIds = extractVariantIds(ml, base, { auditEmpty: false });
  const { tiers } = effectiveTiers(options);
  const out: Record<string, string> = {};
  for (const role of TIER_ROLES) {
    const ref = resolveTierRef(base, variantIds, tiers[role]);
    if (ref?.variant) out[role] = ref.variant;
  }
  return out;
}
