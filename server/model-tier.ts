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

export type ModelRef = { id: string; providerID: string; variant?: string };

// 档位强度序（降级链：请求档缺失时向下取最近存在档；无更低 → null=不写文件，继承会话默认档）。
// 含非标准档名（qwen4 网关用 medium/xhigh）。
const ORDER = ["off", "low", "medium", "high", "xhigh", "max"];

// 默认档位映射（options.tiers 覆盖）。workflow 是 primary，天然跟随会话模型，不进表。
export const TIER_MAP: Record<string, string> = {
  "wf/planner": "high",
  "wf/planner-reviewer": "high",
  "wf/tester": "high",
  "wf/builder": "off",
  "wf/builder-reviewer": "high",
  "wf/fixer": "high",
  "wf/learner": "off",
};

export const TIER_ROLES = Object.keys(TIER_MAP);

// 触发档位校验的命令（流转 + 入口；status/diagnose/ping/lane/reset/debug 豁免）。
export const TIER_TRIGGERS = new Set([
  "wf:intake", "wf:plan", "wf:review", "wf:test-design", "wf:build",
  "wf:reconcile", "wf:review-build", "wf:test", "wf:fix", "wf:done",
]);

// 解析某角色的档位引用。定稿分支（M16-r43 验证报告）：
// - variants 为空 → null（跳写文件：继承父会话模型 = 形态 B 效果，少 7 个派生文件少一次热载）
// - 请求档在集合 → #tier；不在 → 沿强度序向下取最近存在档；无更低（如 off 缺失）→ null（继承默认）
export function resolveTierRef(ref: ModelRef, variantIds: string[], tier: string): ModelRef | null {
  if (!ref?.id || !ref?.providerID) return null;
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
export function tierFileContent(ref: ModelRef): string {
  return `---\n# wf-workflow:model-tier managed (M16-r43)\nmode: subagent\nmodel: ${ref.providerID}/${ref.id}#${ref.variant}\n---\n`;
}

// 托管标记识别。无标记的用户自有文件不覆盖（skip-unmanaged，r31 安全规则同源）。
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
    const target = resolveTierRef(ref, variantIds, tier);
    if (!target) { out.push(`tier-skip:${role}:no-variant`); continue; }
    const path = `${dir}/${role.replace(/^wf\//, "")}.md`;
    let existing = "";
    try { existing = await io.readFile(path, "utf8"); } catch { /* 首次创建 */ }
    if (existing && !hasTierMarker(existing)) { out.push(`tier-skip:${role}:unmanaged`); continue; }
    const content = tierFileContent(target);
    if (existing === content) { out.push(`tier-keep:${role}`); continue; }
    await io.writeFile(path, content);
    out.push(`tier-write:${role}=${target.variant}`);
  }
  return out;
}

// 读项目级派生文件当前档位（wf:ping 展示用；/api/agent 不含 model，读文件为准）。
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
    } catch { /* 无派生文件 → 不展示 */ }
  }
  return out;
}
