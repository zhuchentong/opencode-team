// R2 T2.5（arch-r2-profile-statemachine）：命令中间件链守卫。
// composeMW 顺序语义（数组头=最外层）+ createCommandGuard 真实链行为：
// leader 拒绝短路（base/tierSync 不执行）；成功链 tier note 附加；tierAgents 关=零附加。
// 行为锚与 leader-only.test.js（集成面）互补：本文件直测 middleware.ts 纯组合面。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { composeMW, CMD_MW_ORDER, createCommandGuard } from "../server/middleware.ts";

test("R2 T2.5：composeMW 顺序=数组头最外层（执行轨迹断言）", async () => {
  const trace = [];
  const mk = (tag) => (next) => async (a) => { trace.push(`${tag}:in`); const r = await next(a); trace.push(`${tag}:out`); return r; };
  const base = async (a) => { trace.push("base"); return `out:${a.x}`; };
  const fn = composeMW([mk("A"), mk("B")], base);
  const r = await fn({ x: 1 });
  assert.equal(r, "out:1");
  assert.deepEqual(trace, ["A:in", "B:in", "base", "B:out", "A:out"], "头=最外层，reduceRight 组合");
});

test("R2 T2.5：CMD_MW_ORDER 声明=leaderGate 外层 × tierSync 内层（翻转即红）", () => {
  assert.deepEqual([...CMD_MW_ORDER], ["leaderGate", "tierSync"]);
});

// 最小 deps mock（host.options 活读；load/save/probeOnce 捕获）
const mkDeps = (over = {}) => {
  const saved = [];
  const probes = [];
  const host = {
    options: { leaderOnly: true, tierAgents: false, ...over.options },
    sessions: { get: async () => ({ agent: over.agent ?? "workflow", model: over.model ?? null }) },
    models: { list: async () => [] },
  };
  return {
    deps: {
      host,
      load: async () => over.st ?? null,
      save: async (st) => { saved.push(st); return { ok: true }; },
      probeOnce: async (sid, tag, data) => { probes.push({ sid, tag, data }); },
      resolveProjectDir: async () => "/tmp/opencode/wf-mw",
    },
    saved, probes,
  };
};

test("R2 T2.5：leader 拒绝短路——base 不执行、审计落盘（有前行）、tierSync 不执行", async () => {
  const { deps, saved } = mkDeps({ agent: "wf/builder", st: { slug: "t", phase: "building", rounds: {} } });
  const guard = createCommandGuard(deps);
  let baseRan = false;
  const fn = guard.guard("wf:plan")(async () => { baseRan = true; return "不应到达"; });
  const out = await fn({ sessionID: "ses_m" });
  assert.equal(baseRan, false, "leader 拒绝须短路 base");
  assert.ok(String(out).startsWith("❌"), `拒绝文案 ❌ 前缀：${String(out).slice(0, 30)}`);
  assert.equal(saved.length, 1, "有前行→审计落盘（T02）");
  assert.match(saved[0].log.at(-1).note, /^agent-rejected:wf\/builder$/);
});

test("R2 T2.5：leaderOnly=false 回退——非 leader 也执行 base（opt-out 语义不变）", async () => {
  const { deps } = mkDeps({ agent: "wf/builder", options: { leaderOnly: false } });
  const guard = createCommandGuard(deps);
  const fn = guard.guard("wf:plan")(async () => "base-ok");
  assert.equal(await fn({ sessionID: "ses_m" }), "base-ok");
});

test("R2 T2.5：成功链——leader 放行 → base → tierSync（tierAgents 关=零附加，fail-open）", async () => {
  const { deps } = mkDeps({ agent: "workflow" });
  const guard = createCommandGuard(deps);
  const fn = guard.guard("wf:plan")(async () => "【wf】guidance 全文");
  assert.equal(await fn({ sessionID: "ses_m" }), "【wf】guidance 全文", "tierAgents 默认关→原文透传");
});

test("R2 T2.5：无前行拒绝不落盘（T02 幽灵行防护）；load 失败 fail-open 走旧文案", async () => {
  const { deps, saved } = mkDeps({ agent: "wf/builder", st: null });
  const guard = createCommandGuard(deps);
  const fn = guard.guard("wf:plan")(async () => "x");
  const out = await fn({ sessionID: "ses_m" });
  assert.ok(String(out).startsWith("❌"));
  assert.equal(saved.length, 0, "无前行（幽灵行）不得落盘");
});

// ── P1-B（arch-maintenance-p1）：options.tiers 白名单——未知角色拒落盘（幽灵 agent 防御，V5）──
test("P1-B options.tiers 未知角色：白名单拒落盘 + tiers-invalid 审计行", async () => {
  fs.rmSync("/tmp/opencode/wf-mw/.opencode", { recursive: true, force: true });
  const { deps, saved } = mkDeps({
    agent: "workflow",
    options: { tierAgents: true, tiers: { "wf/ghost": "low", "wf/planner": "high" } },
    st: { slug: "t", phase: "planning", rounds: {} },
    model: { providerID: "prov", id: "m1" },
  });
  const guard = createCommandGuard(deps);
  const fn = guard.guard("wf:plan")(async () => "ok");
  await fn({ sessionID: "ses_m" });
  assert.ok(!fs.existsSync("/tmp/opencode/wf-mw/.opencode/agents/wf/ghost.md"), "未知角色不得落盘派生文件（幽灵 subagent 防御）");
  const notes = saved.flatMap((st) => st.log.map((l) => l.note)).join("|");
  assert.match(notes, /tiers-invalid:wf\/ghost/, "未知角色应有 tiers-invalid 审计行");
  assert.ok(!notes.includes("wf/ghost.md"), "审计只记角色名，不得出现文件路径误引");
});
