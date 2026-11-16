// M16-r43：动态档位跟随——纯逻辑（resolveTierRef/tierFileContent/hasTierMarker）+ IO（syncTierAgents mock）。
// P3 探针实证背景：项目级 agent 文件空 body 保留全局 system；frontmatter model#variant 端到端生效。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIER_MAP, TIER_TRIGGERS, TIER_ROLES, resolveTierRef, tierFileContent, hasTierMarker, syncTierAgents, readTierAgents,
  effectiveTiers, extractVariantIds, resolveTierInjection,
} from "../server/model-tier.ts";
import { listSwallows, clearSwallows } from "../server/observe.ts";

const REF = { providerID: "tu-coding", id: "glm-5.3-flash" };

test("resolveTierRef：请求档存在 → 直接引用", () => {
  assert.deepEqual(resolveTierRef(REF, ["off", "low", "high", "max"], "high"), { ...REF, variant: "high" });
  assert.deepEqual(resolveTierRef(REF, ["off", "low", "high", "max"], "off"), { ...REF, variant: "off" });
});

test("resolveTierRef：请求档缺失 → 强度序向下取最近（qwen4 非标准档）", () => {
  // qwen4 只有 low/medium/xhigh：请求 high → ≤high 的最大者 = medium
  assert.deepEqual(resolveTierRef(REF, ["low", "medium", "xhigh"], "high"), { ...REF, variant: "medium" });
  // 请求 off 但只有 low+ → 向下无更低 → null（继承会话默认档）
  assert.equal(resolveTierRef(REF, ["low", "high"], "off"), null);
});

test("resolveTierRef：variants 为空 → null（跳写，M16-r43 定稿分支）", () => {
  assert.equal(resolveTierRef(REF, [], "high"), null);
  assert.equal(resolveTierRef(REF, undefined, "high"), null);
});

test("resolveTierRef：ref 缺字段 / 未知档名 → null", () => {
  assert.equal(resolveTierRef(null, ["off"], "high"), null);
  assert.equal(resolveTierRef({ providerID: "p" }, ["off"], "high"), null);
  assert.equal(resolveTierRef(REF, ["off", "high"], "bogus"), null);
});

test("tierFileContent：frontmatter 含托管标记（YAML 注释）+ mode + model#variant；body 为空", () => {
  const c = tierFileContent({ ...REF, variant: "high" });
  assert.ok(c.startsWith("---\n"));
  assert.ok(c.includes("# wf-workflow:model-tier managed (M16-r43)"), "托管标记");
  assert.ok(c.includes("mode: subagent"));
  assert.ok(c.includes("model: tu-coding/glm-5.3-flash#high"));
  // body 必须为空：frontmatter 结束符后无内容（非空 body 会替换全局 system，P3 探针）
  assert.ok(c.endsWith("---\n"), "以 frontmatter 结束符收尾（body 空）");
  assert.ok(hasTierMarker(c));
  assert.equal(hasTierMarker("---\nmode: subagent\n---\n用户自有内容"), false, "无标记=用户自有");
});

test("syncTierAgents：首次写全部角色文件（mock io）", async () => {
  const files = {};
  const io = {
    mkdir: async () => {},
    readFile: async (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
    writeFile: async (p, c) => { files[p] = c; },
  };
  const rows = await syncTierAgents("/proj", REF, ["off", "low", "high", "max"], TIER_MAP, io);
  const writes = rows.filter((r) => r.startsWith("tier-write"));
  assert.equal(writes.length, TIER_ROLES.length, "7 角色全写");
  assert.ok(rows.includes("tier-write:wf/builder=low"), "builder=low（P0-B：off→low，防开开关真归零陷阱）");
  assert.ok(rows.includes("tier-write:wf/learner=low"), "learner=low（lessons 质量本体不归零）");
  assert.ok(rows.includes("tier-write:wf/fixer=high"), "fixer=high");
  assert.ok(files["/proj/.opencode/agents/wf/builder-reviewer.md"], "builder-reviewer.md 落盘（无 wf/ 前缀文件名）");
});

test("syncTierAgents：hash 一致跳过（幂等）+ 用户自有文件不覆盖", async () => {
  let wrote = 0;
  const io = {
    mkdir: async () => {},
    readFile: async (p) => {
      if (p.endsWith("/learner.md")) return "---\nmode: subagent\nmodel: 其他/模型\n---\n用户自定义"; // 无标记=unmanaged
      return tierFileContent({ ...REF, variant: "high" }); // planner（high）已同步
    },
    writeFile: async (p) => { wrote++; throw new Error(`不应写入：${p}`); },
  };
  const rows = await syncTierAgents("/proj", REF, ["off", "low", "high", "max"], { "wf/planner": "high", "wf/learner": "off" }, io);
  assert.equal(wrote, 0, "零写入");
  assert.ok(rows.includes("tier-keep:wf/planner"), "hash 一致 → keep");
  assert.ok(rows.includes("tier-skip:wf/learner:unmanaged"), "无标记 → unmanaged 不覆盖");
});

test("syncTierAgents：无 variants → 全部 skip:no-variant（不写文件）", async () => {
  let wrote = 0;
  const io = { mkdir: async () => {}, readFile: async () => { throw new Error("ENOENT"); }, writeFile: async () => { wrote++; } };
  const rows = await syncTierAgents("/proj", REF, [], TIER_MAP, io);
  assert.equal(wrote, 0, "零写入");
  assert.equal(rows.filter((r) => r.startsWith("tier-skip")).length, TIER_ROLES.length);
});

test("readTierAgents：提取 model 行档位（去 provider 前缀）", async () => {
  const io = {
    readFile: async (p) => {
      if (p.endsWith("/planner.md")) return tierFileContent({ providerID: "tu-coding", id: "qwen3.8-flash", variant: "high" });
      throw new Error("ENOENT");
    },
  };
  const rows = await readTierAgents("/proj", ["wf/planner", "wf/builder"], io);
  assert.deepEqual(rows, ["wf/planner=qwen3.8-flash#high"], "缺失角色不展示");
});

test("TIER_TRIGGERS：流转+入口全在，只读豁免集不在", () => {
  for (const c of ["wf:intake", "wf:plan", "wf:review", "wf:test-design", "wf:build", "wf:reconcile", "wf:review-build", "wf:test", "wf:fix", "wf:done"]) {
    assert.ok(TIER_TRIGGERS.has(c), c);
  }
  for (const c of ["wf:status", "wf:diagnose", "wf:ping", "wf:lane", "wf:reset", "wf:debug"]) {
    assert.ok(!TIER_TRIGGERS.has(c), `${c} 应豁免`);
  }
});

// ── P0-B（latency-v3.1 波次2 原子包）：inherit 哨兵 + 新默认映射 ──────────────
test("P0-B TIER_MAP 默认：builder/learner=low（推理预算跟角色职责走）", () => {
  assert.equal(TIER_MAP["wf/builder"], "low");
  assert.equal(TIER_MAP["wf/learner"], "low");
  assert.equal(TIER_MAP["wf/planner"], "high");
});

test("P0-B resolveTierRef：inherit 显式哨兵 → null（不派生=跟随基座默认，脱离 ORDER 依赖）", () => {
  assert.equal(resolveTierRef(REF, ["off", "low", "high", "max"], "inherit"), null);
  assert.equal(resolveTierRef(REF, [], "inherit"), null);
});

test("P0-B syncTierAgents：inherit 角色输出 tier-inherit 专用审计行且不写文件", async () => {
  const files = {};
  const io = { mkdir: async () => {}, readFile: async () => { throw new Error("none"); }, writeFile: async (p, c) => { files[p] = c; } };
  const rows = await syncTierAgents("/proj", REF, ["off", "low", "high", "max"], { "wf/planner": "inherit", "wf/builder": "low" }, io);
  assert.ok(rows.includes("tier-inherit:wf/planner"), "inherit 专用审计行（区别于 tier-skip:no-variant）");
  assert.ok(!("tier-write:wf/planner=off" in rows), "inherit 不派生文件");
  assert.ok(rows.some((r) => r.startsWith("tier-write:wf/builder=low")));
  assert.ok(!files["/proj/.opencode/agents/wf/planner.md"], "planner.md 不得落盘");
});

// ── dispatch-tier-inject T01：同源重构（effectiveTiers/extractVariantIds）+ inherit 清理 ──
test("T01 effectiveTiers：options.tiers 白名单过滤（未知角色不进 tiers）", () => {
  const { tiers } = effectiveTiers({ tiers: { "wf/builder": "high", "wf/ghost": "low" } });
  assert.equal(tiers["wf/builder"], "high", "白名单角色覆盖生效");
  assert.ok(!("wf/ghost" in tiers), "未知角色不得进 tiers（幽灵 subagent 防御）");
  assert.equal(tiers["wf/planner"], TIER_MAP["wf/planner"], "未覆盖角色保持默认映射");
});

test("T01 effectiveTiers：unknown 收集（配置面污染可观测）", () => {
  const { unknown } = effectiveTiers({ tiers: { "wf/ghost": "low", "wf/builder": "high" } });
  assert.deepEqual(unknown, ["wf/ghost"]);
});

test("T01 effectiveTiers：null/undefined options 安全（不 throw）", () => {
  assert.deepEqual(effectiveTiers(null), { tiers: { ...TIER_MAP }, unknown: [] });
  assert.deepEqual(effectiveTiers(undefined), { tiers: { ...TIER_MAP }, unknown: [] });
});

test("T01 effectiveTiers：缺省=TIER_MAP（空 options 等价默认映射）", () => {
  const { tiers, unknown } = effectiveTiers({});
  assert.deepEqual(tiers, TIER_MAP);
  assert.deepEqual(unknown, []);
});

test("T01 extractVariantIds：array/data/models 三形状同源", () => {
  const row = { id: REF.id, providerID: REF.providerID, variants: [{ id: "low" }, { id: "high" }] };
  assert.deepEqual(extractVariantIds([row], REF), ["low", "high"]);
  assert.deepEqual(extractVariantIds({ data: [row] }, REF), ["low", "high"]);
  assert.deepEqual(extractVariantIds({ models: [row] }, REF), ["low", "high"]);
});

test("T01 extractVariantIds：id+providerID 精确命中优先、仅 id 兜底", () => {
  const other = { id: REF.id, providerID: "other", variants: [{ id: "max" }] };
  const exact = { id: REF.id, providerID: REF.providerID, variants: [{ id: "low" }] };
  assert.deepEqual(extractVariantIds([other, exact], REF), ["low"], "精确命中优先于仅 id 命中");
  assert.deepEqual(extractVariantIds([other], REF), ["max"], "providerID 无命中 → 仅 id 兜底");
});

test("T01 extractVariantIds：空集返回 [] + 同源审计 model-tier:variants-empty", () => {
  clearSwallows();
  assert.deepEqual(extractVariantIds([], REF), []);
  assert.deepEqual(extractVariantIds([{ id: REF.id, providerID: REF.providerID, variants: [] }], REF), []);
  const codes = listSwallows().map((s) => s.code);
  assert.ok(codes.filter((c) => c === "model-tier:variants-empty").length >= 2, "空集审计同源记账");
});

test("T01 extractVariantIds：null/无效 ref → [] 且无审计噪音（R3：无效 ref≠variants 空）", () => {
  clearSwallows();
  const ml = [{ id: REF.id, providerID: REF.providerID, variants: [] }];
  assert.deepEqual(extractVariantIds(ml, null), []);
  assert.deepEqual(extractVariantIds(ml, undefined), []);
  assert.deepEqual(extractVariantIds(ml, { providerID: "p" }), []);
  assert.deepEqual(extractVariantIds(ml, { id: "x" }), []);
  assert.ok(!listSwallows().some((s) => s.code === "model-tier:variants-empty"), "无效 ref 不得产生 variants-empty 审计");
});

test("T01 syncTierAgents：inherit + managed 既有文件 → unlink 删除 + tier-inherit-clean 审计", async () => {
  const files = { "/proj/.opencode/agents/wf/planner.md": tierFileContent({ ...REF, variant: "high" }) };
  const io = {
    mkdir: async () => {},
    readFile: async (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; },
    writeFile: async (p, c) => { files[p] = c; },
    unlink: async (p) => { delete files[p]; },
  };
  const rows = await syncTierAgents("/proj", REF, ["off", "low", "high"], { "wf/planner": "inherit" }, io);
  assert.ok(rows.includes("tier-inherit-clean:wf/planner"), "managed 清理专用审计行");
  assert.ok(!("/proj/.opencode/agents/wf/planner.md" in files), "managed 派生文件应被删除");
});

test("T01 syncTierAgents：inherit + unmanaged 文件 → 绝不触碰（保持 tier-inherit）", async () => {
  let unlinked = 0;
  const io = {
    mkdir: async () => {},
    readFile: async () => "---\nmode: subagent\nmodel: 其他/模型\n---\n用户自有内容",
    writeFile: async () => { throw new Error("不应写入"); },
    unlink: async () => { unlinked++; },
  };
  const rows = await syncTierAgents("/proj", REF, ["off", "low"], { "wf/planner": "inherit" }, io);
  assert.ok(rows.includes("tier-inherit:wf/planner"), "unmanaged 保持 tier-inherit 行");
  assert.ok(!rows.some((r) => r.startsWith("tier-inherit-clean")), "unmanaged 不得出 clean 行");
  assert.equal(unlinked, 0, "unmanaged 文件绝不 unlink");
});

test("T01 syncTierAgents：inherit + 缺失文件 → 保持 tier-inherit（不 unlink）", async () => {
  let unlinked = 0;
  const io = {
    mkdir: async () => {},
    readFile: async () => { throw new Error("ENOENT"); },
    writeFile: async () => {},
    unlink: async () => { unlinked++; },
  };
  const rows = await syncTierAgents("/proj", REF, ["off", "low"], { "wf/planner": "inherit" }, io);
  assert.ok(rows.includes("tier-inherit:wf/planner"));
  assert.equal(unlinked, 0, "缺失文件无 unlink 调用");
});

// ── dispatch-tier-inject T02：resolveTierInjection 纯函数（判定链短路序=审计 reason 优先级）──
const INJ = {
  enabled: true, slug: "t", target: "wf/builder", explicitModel: undefined,
  fileContent: null, ref: { providerID: "tu-coding", id: "base-m" },
  variantIds: ["off", "low", "high", "max"], tiers: { ...TIER_MAP },
};

test("T02 inject 正路：builder=low + model 字符串格式 providerID/id#variant", () => {
  const d = resolveTierInjection(INJ);
  assert.equal(d.action, "inject");
  assert.equal(d.model, "tu-coding/base-m#low");
  assert.deepEqual(d.ref, { providerID: "tu-coding", id: "base-m", variant: "low" });
});

test("T02 降级链复用：请求 high 缺 → 强度序向下取 medium（resolveTierRef 同源）", () => {
  const d = resolveTierInjection({ ...INJ, target: "wf/planner", variantIds: ["low", "medium", "xhigh"] });
  assert.equal(d.action, "inject");
  assert.equal(d.model, "tu-coding/base-m#medium");
});

test("T02 enabled=false → none（静默不审计）", () => {
  assert.deepEqual(resolveTierInjection({ ...INJ, enabled: false }), { action: "none" });
});

test("T02 无 slug → none", () => {
  assert.deepEqual(resolveTierInjection({ ...INJ, slug: undefined }), { action: "none" });
  assert.deepEqual(resolveTierInjection({ ...INJ, slug: "" }), { action: "none" });
});

test("T02 非 tier 角色 → none（workflow primary 天然跟随基座）", () => {
  assert.deepEqual(resolveTierInjection({ ...INJ, target: "workflow" }), { action: "none" });
  assert.deepEqual(resolveTierInjection({ ...INJ, target: "wf/ghost" }), { action: "none" });
});

test("T02 explicit-model：显式模型不覆盖；空串不算显式（仍 inject）", () => {
  assert.deepEqual(resolveTierInjection({ ...INJ, explicitModel: "other/m#high" }), { action: "skip", reason: "explicit-model" });
  assert.equal(resolveTierInjection({ ...INJ, explicitModel: "" }).action, "inject", "空串视同未设置");
});

test("T02 unmanaged：无托管标记的派生文件让位（用户自有不覆盖）", () => {
  const d = resolveTierInjection({ ...INJ, fileContent: "---\nmode: subagent\nmodel: 其他/模型\n---\n用户自有" });
  assert.deepEqual(d, { action: "skip", reason: "unmanaged" });
});

test("T02 managed 文件在仍 inject（注入不依赖文件通路，文件仅作 unmanaged 判据）", () => {
  const d = resolveTierInjection({ ...INJ, fileContent: tierFileContent({ providerID: "tu-coding", id: "base-m", variant: "high" }) });
  assert.equal(d.action, "inject");
  assert.equal(d.model, "tu-coding/base-m#low");
});

test("T02 fileContent=null（缺失/读失败）→ inject（不因文件缺失放弃注入）", () => {
  assert.equal(resolveTierInjection({ ...INJ, fileContent: null }).action, "inject");
});

test("T02 inherit 哨兵 → skip:inherit（优先于 no-variant 判定）", () => {
  const tiers = { ...TIER_MAP, "wf/builder": "inherit" };
  assert.deepEqual(resolveTierInjection({ ...INJ, tiers }), { action: "skip", reason: "inherit" });
  assert.deepEqual(resolveTierInjection({ ...INJ, tiers, variantIds: [] }), { action: "skip", reason: "inherit" }, "inherit 短路先于 variants 空");
});

test("T02 variants 空 → skip:no-variant（注入退化，继承基座默认）", () => {
  assert.deepEqual(resolveTierInjection({ ...INJ, variantIds: [] }), { action: "skip", reason: "no-variant" });
});

test("T02 ref null → skip:no-variant（leader 会话无 model 不注入）", () => {
  assert.deepEqual(resolveTierInjection({ ...INJ, ref: null }), { action: "skip", reason: "no-variant" });
});

// ── opt-agentic（tier-no-project-files）：tierAgents 三态模式 + 档位视图活算 ──
// 用户需求：档位配置零项目目录落地——缺省翻转 inject-only（仅派发时 args.model 注入），
// "files"/true 保留旧双通路，false 关闭；TUI/ping 档位视图改 tierBase 活算（liveTierVariants）。
import { tierAgentsMode, liveTierVariants } from "../server/model-tier.ts";
// clearSwallows/listSwallows 已在文件头第 9 行 import（重复声明即红）

test("tier-no-files：tierAgentsMode 三态解析（缺省=inject 零落地 / true|files / false）", () => {
  assert.equal(tierAgentsMode(undefined), "inject", "缺省=新默认 inject-only（零项目目录落地）");
  assert.equal(tierAgentsMode({}), "inject");
  assert.equal(tierAgentsMode({ tierAgents: "inject-only" }), "inject");
  assert.equal(tierAgentsMode({ tierAgents: "inject" }), "inject");
  assert.equal(tierAgentsMode({ tierAgents: true }), "files", "true=旧双通路显式保留");
  assert.equal(tierAgentsMode({ tierAgents: "files" }), "files");
  assert.equal(tierAgentsMode({ tierAgents: false }), "off", "false=关闭（旧语义不变）");
  assert.equal(tierAgentsMode(null), "inject");
});

test("tier-no-files：liveTierVariants 活算（tierBase+models.list→role→variant；无效 base=null；静默空集）", () => {
  const base = { providerID: "prov", id: "m1" };
  const ml = [{ id: "m1", providerID: "prov", variants: [{ id: "low" }, { id: "high" }] }];
  const view = liveTierVariants(base, ml, { tiers: { "wf/planner": "high", "wf/builder": "low", "wf/learner": "low" } });
  assert.equal(view["wf/planner"], "high");
  assert.equal(view["wf/builder"], "low");
  assert.equal(liveTierVariants(null, ml, {}), null, "无效 base → null");
  // variants 空集：静默（不灌 swallow 环——TUI 5s 轮询消费面），返回空对象
  clearSwallows();
  const empty = liveTierVariants(base, [], {});
  assert.deepEqual(empty, {}, "空集→空对象");
  assert.equal(listSwallows().length, 0, "视图路径零审计（auditEmpty:false）");
});
