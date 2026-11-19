// dispatch-tier-inject T04：wf:ping 档位活算视图 + 常态化核对（verified 即时视图）。
// opt-agentic 项②：verified 不落库（旧实现 save 使只读 ping 沾写路径，已移除）——
// 本文件断言改为输出文本形态 + state 不被写（只读回归锚）。
// 基座=st.reuse.tierBase（非 caller 会话模型——ping 只读任意会话可调）；活算消费 T01 同源
// extractVariantIds/resolveTierRef/effectiveTiers；无 tierBase 回退文件实况；tierAgents=false 回退分支逐字不动。
// stub 模式仿 session-guard（mkHostStub+plugin.setup；raw ctx 键名以 helpers/host-stub.js 现行约定为准）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js";

const DIR = "/tmp/opencode/wf-ping-tier";
const DB = `${DIR}/.workflow/wf.db`;
const BASE = { providerID: "tu-coding", id: "base-m" };
const VARIANTS = [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }];

const mkCtx = (over = {}) => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  fs.rmSync(`${DIR}/.opencode`, { recursive: true, force: true });
  const entries = [];
  const host = mkHostStub({
    options: { probe: false, requireIntakeConfirm: false, tierAgents: true, ...over.options },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: over.sessionGet ?? (async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR }, model: BASE })) },
    models: over.models ?? (async () => [{ id: BASE.id, providerID: BASE.providerID, variants: VARIANTS }]),
    agents: async () => [{ name: "wf/planner" }, { name: "wf/builder" }],
    instructions: { put: async (i) => { entries.push(i); }, list: async () => entries },
  });
  return { ctx: host.rawCtx, cmds: host.cmdDefs, tools: host.toolDefs, entries };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
   catch { return undefined; } // W15-b：无库/无表=无行（惰性语义）
  finally { try { d.close(); } catch { } }
};
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// 建 leader 任务（wf:intake 触发 tierCheck 登记 tierBase+写派生文件）
const setupTask = async (m, leader) => {
  await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[M] ping-tier" } });
};
const ping = (m, leader) => cmd(m, "wf:ping").execute({ sessionID: leader, prompt: {} });

test("T04 活算：有 tierBase → 逐角色 providerID/id#variant·派发时注入 + 文件实况降附注", async () => {
  const leader = "ses_pt1"; const m = mkCtx();
  await setupTask(m, leader);
  assert.ok(stOf(leader).reuse?.tierBase, "intake 流转应登记 tierBase");
  const out = await ping(m, leader);
  assert.ok(out.includes("wf/builder=tu-coding/base-m#low·派发时注入"), `builder 活算 cell：${out}`);
  assert.ok(out.includes("wf/planner=tu-coding/base-m#high·派发时注入"), "planner=high 活算");
  assert.ok(out.includes("派生文件实况（附注）"), "readTierAgents 降为附注行");
  assert.ok(!out.includes("ses_"), "零回显");
});

test("T04 无 tierBase：回退文件视图 + 待登记文案", async () => {
  const leader = "ses_pt2";
  const m = mkCtx({ sessionGet: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) }); // 无 model → tierCheck 早退
  await setupTask(m, leader);
  assert.ok(!stOf(leader).reuse?.tierBase, "无基座模型不登记 tierBase");
  const out = await ping(m, leader);
  assert.ok(out.includes("tierBase 待登记（首次流转后生效），当前为文件实况"), `待登记文案：${out}`);
  assert.ok(out.includes("wf/builder=(基座默认)"), "回退文件视图 cell");
  assert.ok(!out.includes("派发时注入"), "无活算标注");
});

test("T04 variants 空：⚠️ 告警行 + 活算退化 (基座默认)（审计 T01 同源不重复）", async () => {
  const leader = "ses_pt3";
  const m = mkCtx({ models: async () => [] });
  await setupTask(m, leader);
  const out = await ping(m, leader);
  assert.ok(out.includes("⚠️ variants 不可得，注入退化文件通路"), `告警行：${out}`);
  assert.ok(out.includes("wf/builder=(基座默认)·派发时注入"), "variants 空活算退化");
});

test("T04 tierAgents=false：回退分支逐字不动（文件实况行，无活算/待登记文案）", async () => {
  const leader = "ses_pt4";
  const m = mkCtx({ options: { tierAgents: false } });
  await setupTask(m, leader);
  fs.mkdirSync(`${DIR}/.opencode/agents/wf`, { recursive: true });
  fs.writeFileSync(`${DIR}/.opencode/agents/wf/planner.md`, "---\n# wf-workflow:model-tier managed (M16-r43)\nmode: subagent\nmodel: prov/x#high\n---\n");
  const out = await ping(m, leader);
  assert.ok(out.includes("档位跟随（tierAgents，Session 基座派生）：wf/planner=x#high"), `旧回退行逐字：${out}`);
  assert.ok(!out.includes("派发时注入") && !out.includes("tierBase 待登记"), "关闭态零活算面");
});

test("T04 verified 即时视图：verified=N/M 输出 + state 零写入（ping 只读回归锚）", async () => {
  const leader = "ses_pt5"; const m = mkCtx();
  await setupTask(m, leader);
  // 双通道登记两角色子会话（artifact-tool.mark；相位错位仅告警不阻断登记）
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: "ses_childOK", agent: "wf/planner" });
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: "ses_childBad", agent: "wf/builder" });
  m.ctx.session.get = async ({ sessionID }) => {
    if (sessionID === "ses_childOK") return { model: { providerID: "tu-coding", id: "base-m", variant: "high" } }; // planner 期望 high → true
    if (sessionID === "ses_childBad") return { model: { providerID: "other", id: "x", variant: "high" } }; // builder 期望 low → false
    return { projectID: "pi1", agent: "wf/leader", location: { directory: DIR }, model: BASE };
  };
  const out = await ping(m, leader);
  assert.ok(out.includes("verified=1/2"), `verified 汇总：${out}`);
  assert.ok(!out.includes("ses_"), "输出零回显");
  // opt-agentic 项②：ping 只读——登记形状（sessionID/at，artifact-tool.mark 写入）不被 verified 核对改写
  const rs = stOf(leader).reuse.roleSessions;
  assert.ok(rs["wf/planner"]?.sessionID, "登记本体保留");
  assert.ok(!("verified" in rs["wf/planner"]), "verified 不落库（即时视图）");
  assert.ok(!("model" in rs["wf/planner"]), "model 快照不落库");
  assert.ok(!("verified" in rs["wf/builder"]), "false 亦不落库");
});

test("T04 models.list 抛错：fail-soft 不 throw（variantIds=[] → 告警行 + 基座默认 cell）", async () => {
  const leader = "ses_pt6"; const m = mkCtx();
  await setupTask(m, leader);
  m.ctx.model = { list: async () => { throw new Error("models.list down"); } };
  const out = await ping(m, leader); // 不 throw 即 fail-soft
  assert.ok(out.includes("⚠️ variants 不可得，注入退化文件通路"));
  assert.ok(out.includes("wf/builder=(基座默认)·派发时注入"));
});

test("T04 inherit/不可读：不置 verified（expected null 与子会话读失败两路）", async () => {
  const leader = "ses_pt7";
  const m = mkCtx({ options: { tiers: { "wf/learner": "inherit" } } });
  await setupTask(m, leader);
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: "ses_childInh", agent: "wf/learner" });
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: "ses_childGone", agent: "wf/planner" });
  m.ctx.session.get = async ({ sessionID }) => {
    if (sessionID === "ses_childGone") throw new Error("session gone");
    if (sessionID === "ses_childInh") return { model: { providerID: "tu-coding", id: "base-m", variant: "low" } };
    return { projectID: "pi1", agent: "wf/leader", location: { directory: DIR }, model: BASE };
  };
  const out = await ping(m, leader);
  assert.ok(out.includes("verified=0/0"), `inherit/不可读均不计入 M：${out}`);
  const rs = stOf(leader).reuse.roleSessions;
  assert.ok(!("verified" in rs["wf/learner"]), "inherit → expected null 不置 verified");
  assert.ok(!("verified" in rs["wf/planner"]), "子会话不可读不置 verified");
});