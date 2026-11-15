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

/** 触发档位校验的命令集（10 个流转命令；status/diagnose/ping/lane/reset/debug 豁免）。 */
export const TIER_TRIGGERS = new Set([
  "wf:intake", "wf:plan", "wf:review", "wf:test-design", "wf:build",
  "wf:reconcile", "wf:review-build", "wf:test", "wf:fix", "wf:done",
]);

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
}

// 写各角色项目级文件（<projectDir>/.opencode/agents/wf/<role>.md）。返回审计行：
// tier-write:<role>=<variant> / tier-keep:<role> / tier-skip:<role>:no-variant|unmanaged。
/** 写各角色项目级派生文件（<projectDir>/.opencode/agents/wf/<role>.md）。
 * @param projectDir 项目根目录
 * @param ref 会话基座模型引用
 * @param variantIds 基座可用 variant 集合
 * @param tiers 角色→档名映射（缺省 TIER_MAP）
 * @param io 注入的文件 IO（mkdir/readFile/writeFile，bun test 直测用）
 * @returns 审计行数组：tier-write:<role>=<variant> / tier-keep / tier-inherit / tier-skip:<role>:no-variant|unmanaged */
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
    if (tier === "inherit") { out.push(`tier-inherit:${role}`); continue; } // P0-B：不派生文件=跟随基座默认
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
