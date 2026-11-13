// M16-r43：动态档位跟随——纯逻辑（resolveTierRef/tierFileContent/hasTierMarker）+ IO（syncTierAgents mock）。
// P3 探针实证背景：项目级 agent 文件空 body 保留全局 system；frontmatter model#variant 端到端生效。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIER_MAP, TIER_TRIGGERS, TIER_ROLES, resolveTierRef, tierFileContent, hasTierMarker, syncTierAgents, readTierAgents,
} from "../server/model-tier.ts";

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
