// M16-r36：工作流硬性限定 leader（服务端强制，非提示词约定）。M16-r38：leader 主名 workflow，wf/leader 过渡兼容。
// 单一强制点 = commands.add() guarded 包装（聊天命令/wf_command/TUI exec 三入口同调 byName）；
// agent 解析 = a?.agent ?? session.get().agent（Session.Info.agent 形状经 OpenAPI 实证）；
// 变更类 fail-closed、只读豁免（status/diagnose/ping/reset）、lane 整体收紧（含 ls）；
// 拒绝落审计 agent-rejected（有行才落盘，守 T02）；opt.leaderOnly=false 回退。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js"; // T04：装配收敛（rawCtx=setup(ctx) 消费者视图）
import { leaderOnlyReject, READONLY_CMDS, isLeader } from "../server/lib.ts";
import { HINT_KEY } from "../server/state.ts";

// 虚拟模块占位包自举已单点化到 tests/_preload.js（P0-A，latency-v3.1）——本文件不再自举（副本=漂移源）。

const DIR = "/tmp/opencode/wf-leader";
const DB = `${DIR}/.workflow/wf.db`;

// agents：sessionID → agent 映射（mock 与真机 Session.Info.agent 同源；缺省 wf/leader）
const mkCtx = (opts = {}, agents = {}) => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const entries = [];
  // T04：装配收敛 helpers/host-stub（agents[sessionID] 形=sessions.get 覆盖；setChat 经 rawCtx 活写，setup 前生效）
  const host = mkHostStub({
    options: { probe: false, ...opts },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async ({ sessionID } = {}) => ({ projectID: "pi1", agent: agents[sessionID] ?? "wf/leader", location: { directory: DIR } }) },
    instructions: { put: async (i) => { entries.push(i); }, list: async () => entries },
  });
  return { ctx: host.rawCtx, tools: host.toolDefs, cmds: host.cmdDefs, entries, setChat: (api) => { host.rawCtx.chat = api; } };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const wfTool = (m) => m.tools.find((t) => t.name === "wf_command");
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// ── 纯函数：leaderOnlyReject ────────────────────────────────────────
// M16-r38：leader 主名 workflow（显示 Workflow）；wf/leader 保留为过渡兼容别名（热载不断）。
test("r36 leaderOnlyReject：豁免集齐全；leader（workflow+兼容 wf/leader）放行；非 leader/空 agent 变更拒、只读放行", () => {
  // M16-r46 批2：+wf:open（产物查看只读——非 leader 可用）
  assert.deepEqual([...READONLY_CMDS].toSorted(), ["wf:diagnose", "wf:open", "wf:ping", "wf:reset", "wf:status"]);
  for (const c of ["wf:intake", "wf:plan", "wf:review", "wf:build", "wf:test", "wf:done", "wf:lane"]) {
    assert.equal(leaderOnlyReject("workflow", c), null, `workflow ${c} 放行`);
    assert.equal(leaderOnlyReject("wf/leader", c), null, `兼容别名 wf/leader ${c} 放行`);
    assert.match(leaderOnlyReject("build", c), /仅限 workflow/, `build ${c} 拒`);
    assert.match(leaderOnlyReject("", c), /无法确认/, `空 agent ${c} fail-closed`);
  }
  for (const c of READONLY_CMDS) {
    assert.equal(leaderOnlyReject("build", c), null, `只读 ${c} 非 leader 放行`);
    assert.equal(leaderOnlyReject("", c), null, `只读 ${c} 空 agent 放行`);
  }
});

// M16-r38：isLeader 双 ID 判定（workflow 主名 + wf/leader 兼容）
test("r38 isLeader：workflow 与 wf/leader 均为 leader；其余（含 wf/* 子代理/空）非 leader", () => {
  assert.equal(isLeader("workflow"), true);
  assert.equal(isLeader("wf/leader"), true);
  for (const a of ["build", "wf/planner", "wf/builder", "workflowx", "", "WF/LEADER"]) {
    assert.equal(isLeader(a), false, `${a} 非 leader`);
  }
});

// ── F1（implant×build 卡死 1.5 天实证）：拒绝文案按「会话是否持任务」分支 ──
test("F1 leaderOnlyReject st 分支：持任务=两出口并列（切回 workflow/重跑 + reset 清账）；无任务=旧文案逐字", () => {
  const st = { slug: "implant", phase: "testing", rounds: {} };
  const r = leaderOnlyReject("build", "wf:done", st);
  assert.match(r, /^❌/, "拒绝前缀不变量（levelFor=warn）");
  assert.match(r, /本会话即任务「implant」/, "精确指认=本会话自身");
  assert.match(r, /phase=testing/);
  assert.match(r, /切回 workflow 后重跑 wf:done/, "出口一：切回 agent 重跑");
  assert.match(r, /勿新开会话接管/, "堵住误导路径（开新会话拿不到任务行）");
  assert.match(r, /\/wf:reset 清账/, "出口二：直接清账（reset 本在豁免集）");
  assert.match(r, /只读命令/, "只读能力说明");
  assert.match(r, /仅限 workflow/, "『仅限 workflow』子串保留（存量断言兼容）");
  // 无任务/st 缺省 → 旧文案逐字（两参调用=三参缺省的等价锚）
  assert.equal(leaderOnlyReject("build", "wf:done", null), leaderOnlyReject("build", "wf:done"));
  assert.equal(leaderOnlyReject("build", "wf:done", undefined), leaderOnlyReject("build", "wf:done"));
  assert.equal(leaderOnlyReject("build", "wf:done", { slug: "", phase: null, rounds: {} }), leaderOnlyReject("build", "wf:done"), "幽灵快照走旧文案");
  // 优先级不变：只读豁免 / leader 放行 / 空 agent fail-closed 均在 st 分支之前
  assert.equal(leaderOnlyReject("build", "wf:status", st), null);
  assert.equal(leaderOnlyReject("workflow", "wf:done", st), null);
  assert.match(leaderOnlyReject("", "wf:done", st), /无法确认/, "空 agent 身份文案优先于任务分支");
});

// ── 全链路：聊天命令入口 ────────────────────────────────────────────
test("r36 聊天命令：build intake 拒（无幽灵行）；leader 放行；有行后 build 推进拒 + 审计 agent-rejected", async () => {
  const m = mkCtx({}, { ses_b: "build", ses_l: "wf/leader" });
  const dispose = await plugin.setup(m.ctx);
  // build 开任务 → 拒，且不落幽灵行（T02）
  const r1 = await cmd(m, "wf:intake").execute({ sessionID: "ses_b", prompt: { text: "x" } });
  assert.match(r1, /仅限 workflow/);
  assert.equal(stOf("ses_b"), undefined, "拒绝不落幽灵行");
  // leader 开任务 → 放行
  const r2 = await cmd(m, "wf:intake").execute({ sessionID: "ses_l", prompt: { text: "t" } });
  assert.match(r2, /intake/);
  assert.ok(stOf("ses_l")?.slug, "leader 建行");
  // leader 会话切到 build agent 推进 → 拒 + 审计落账
  m.ctx.session.get = async ({ sessionID } = {}) => ({ projectID: "pi1", agent: sessionID === "ses_l" ? "build" : "wf/leader", location: { directory: DIR } });
  const r3 = await cmd(m, "wf:plan").execute({ sessionID: "ses_l", prompt: {} });
  assert.match(r3, /仅限 workflow/);
  assert.match(r3, /本会话即任务/, "F1：guarded 带快照命中任务分支（load 上提至拒绝前）");
  const st = stOf("ses_l");
  assert.equal(st.phase, "intake", "推进被拒不生效");
  assert.ok(st.log.some((e) => e.cmd === "wf:plan" && !e.ok && /agent-rejected:build/.test(e.note ?? "")), "拒绝落审计");
  dispose?.();
});

// M16-r38：workflow 主名全链路——intake 建行 + 推进放行（与 wf/leader 同权）
test("r38 聊天命令：workflow agent intake 建行 + plan 推进放行（主名与 wf/leader 同权）", async () => {
  const m = mkCtx({}, { ses_w: "workflow" });
  const dispose = await plugin.setup(m.ctx);
  const r1 = await cmd(m, "wf:intake").execute({ sessionID: "ses_w", prompt: { text: "t" } });
  assert.match(r1, /intake/);
  assert.ok(stOf("ses_w")?.slug, "workflow 建行");
  const r2 = await cmd(m, "wf:plan").execute({ sessionID: "ses_w", prompt: {} });
  assert.ok(!/仅限 workflow/.test(r2), "workflow 推进不被拒");
  assert.equal(stOf("ses_w").phase, "planning", "workflow 推进生效");
  dispose?.();
});

// M16-r38：wf_command 工具 workflow agent 放行（context.agent 直解析）
test("r38 wf_command 工具：workflow agent intake 放行；wf/* 子代理仍早拒", async () => {
  const m = mkCtx({}, {});
  const dispose = await plugin.setup(m.ctx);
  const tc = wfTool(m);
  const r1 = await tc.execute({ name: "wf:intake", prompt: "x" }, { sessionID: "ses_w", agent: "workflow" });
  assert.ok(!/仅限 workflow/.test(r1.content), "workflow 经 context.agent 放行");
  const r2 = await tc.execute({ name: "wf:intake", prompt: "x" }, { sessionID: "ses_sub", agent: "wf/planner" });
  assert.match(r2.content, /子会话/, "wf/* 子代理早拒保留");
  dispose?.();
});

test("r36 只读豁免：build 会话 status/diagnose/ping/reset 放行；lane ls 有意收紧拒", async () => {
  const m = mkCtx({}, { ses_b: "build" });
  const dispose = await plugin.setup(m.ctx);
  assert.match(await cmd(m, "wf:status").execute({ sessionID: "ses_b", prompt: {} }), /无活动任务/);
  assert.match(await cmd(m, "wf:diagnose").execute({ sessionID: "ses_b", prompt: {} }), /无活动任务/);
  assert.ok(typeof (await cmd(m, "wf:ping").execute({ sessionID: "ses_b", prompt: {} })) === "string");
  assert.ok(typeof (await cmd(m, "wf:reset").execute({ sessionID: "ses_b", prompt: {} })) === "string");
  assert.match(await cmd(m, "wf:lane").execute({ sessionID: "ses_b", prompt: { text: "ls" } }), /仅限 workflow/, "lane 含 ls 整体收紧");
  dispose?.();
});

test("r36 wf_command 工具：build agent 经 session.get 解析拒；wf/* 子代理早拒保留", async () => {
  const m = mkCtx({}, { ses_b: "build" });
  const dispose = await plugin.setup(m.ctx);
  const tc = wfTool(m);
  const r1 = await tc.execute({ name: "wf:intake", prompt: "x" }, { sessionID: "ses_b", agent: "build" });
  assert.match(r1.content, /仅限 workflow/);
  const r2 = await tc.execute({ name: "wf:intake", prompt: "x" }, { sessionID: "ses_sub", agent: "wf/planner" });
  assert.match(r2.content, /子会话/, "wf/* 子代理早拒保留");
  dispose?.();
});

test("r36 TUI exec 路径：runner.run 无 a.agent → session.get 解析拒非 leader", async () => {
  const m = mkCtx({}, { ses_b: "build" });
  const dispose = await plugin.setup(m.ctx);
  // exec 与 wf_command 同走 runner.run → byName guarded；用 wf_command 不带 context.agent 模拟
  const tc = wfTool(m);
  const r = await tc.execute({ name: "wf:intake", prompt: "x" }, { sessionID: "ses_b" });
  assert.match(r.content, /仅限 workflow/, "无 context.agent 时 session.get 兜底");
  dispose?.();
});

test("r36 opt.leaderOnly=false：回退旧行为（build 可 intake）", async () => {
  const m = mkCtx({ leaderOnly: false }, { ses_b: "build" });
  const dispose = await plugin.setup(m.ctx);
  const r = await cmd(m, "wf:intake").execute({ sessionID: "ses_b", prompt: { text: "x" } });
  assert.ok(!/仅限 workflow/.test(r), "开关关闭不拒");
  assert.ok(stOf("ses_b")?.slug, "旧行为建行");
  dispose?.();
});

// ── hint：非 leader 不注入 ─────────────────────────────────────────
test("r36 hint：build 会话不注入 HINT_ENTRY；leader 会话注入（hook 形状防御）", async () => {
  const m = mkCtx({}, { ses_b: "build", ses_l: "wf/leader" });
  let hookFn = null;
  m.setChat({ hook: (name, fn) => { hookFn = fn; return { dispose() {} }; } });
  const dispose = await plugin.setup(m.ctx);
  assert.ok(hookFn, "chat hook 注册");
  const worthy = { parts: [{ text: "我想走流程开发这个功能" }] };
  await hookFn({ sessionID: "ses_b", agent: "build" }, worthy);
  assert.ok(!m.entries.some((e) => e.key === HINT_KEY && e.sessionID === "ses_b"), "build 不注入");
  await hookFn({ sessionID: "ses_l", agent: "wf/leader" }, worthy);
  assert.ok(m.entries.some((e) => e.key === HINT_KEY && e.sessionID === "ses_l"), "leader 注入");
  dispose?.();
});