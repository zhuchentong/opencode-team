// M16-r41 B 层：subagent 续接自愈守卫（leader 专属）。
// fix-sid-truncation-echo-loop T01 行为反转：守卫**不再 throw 回显登记 ID**——「回显→再转录→
//   死循环」燃料在此拆除：真前缀（含非法形状 "ses"/"ses_"）→ 存活探针后就地改写放行（已完成/
//   探不到/异常）或 throw 警示不回显（运行中）；fuzzy/非法非前缀 → throw 指路别名/省略新建（不回显）。
// 关键约束（验证报告 S1/I2/I3/B1/B2 + T01 冻结）：
//   S1 拒绝消息必须含 GATE_ERR="[wf-workflow]"，否则被 fail-open 吞掉→静默 no-op；
//   S2 拒绝消息不得含登记完整 ID（防转录燃料）——审计 detail 含 ID 合规（wf.db 不进模型上下文）；
//   I2 分支置于 edit/shell 过滤之前；I3 仅「形状非法 OR 登记 ID 真前缀/近似」才干预，全形状非前缀不符→放行（多 lane 安全）；
//   B1 用 isLeader（workflow + wf/leader 双别名）；B2 审计 cmd=session:correct。
// 覆盖：截断前缀改写/非法拒绝无回显/正确放行/新建放行/多 lane 放行/无登记放行/非 leader 放行/别名/审计/存活探针/闭环。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";

const DIR = "/tmp/opencode/wf-session-guard";
const DB = `${DIR}/.workflow/wf.db`;
// mock 形状与 session-reuse.test.js / integration.test.js 同源（tool.hook 捕获守卫函数）
const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const tools = []; const cmds = []; const entries = [];
  let hookFn = null;
  const ctx = {
    options: { probe: false },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    session: {
      get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }),
      wait: async () => {}, prompt: async () => {}, hook: async () => ({ dispose() {} }),
      instructions: { entry: { put: async (i) => entries.push(i), list: async () => entries, remove: async () => {} } },
    },
    tool: {
      transform: (fn) => { fn({ add: (d) => tools.push(d), list: () => tools.map((t) => ({ name: t.name })) }); return { dispose() {} }; } ,
      hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; },
    },
    command: { transform: (fn) => { fn({ add: (d) => cmds.push(d) }); return { dispose() {} }; } },
  };
  return { ctx, tools, cmds, entries, hook: () => hookFn };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(`${DIR}/src`, { recursive: true });

// 建 leader 任务并经 A 层登记 wf/planner 子会话（登记 ID=ses_planFull123，仅供断言引用，不进拒绝文案）
const FULL = "ses_planFull123";
const setupLeader = async (leader) => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[M] guard" } });
  await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} }); // → planning
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: FULL, agent: "wf/planner" });
  return m;
};
// leader 调 subagent（callerAgent 默认 workflow；input 为 subagent 工具入参）
const callSub = (m, leader, input, callerAgent = "workflow") =>
  m.hook()({ tool: "subagent", sessionID: leader, agent: callerAgent, input }, {});
// T01 S2：拒绝必须含 GATE_ERR（穿透 fail-open）且**不含登记 ID**（防回显燃料）
const rejectsWithoutEcho = (e) => {
  const msg = String(e?.message ?? e);
  return msg.includes("[wf-workflow]") && !msg.includes(FULL);
};

// ── T01：截断前缀 → 就地改写放行（A1/A2：合法形状前缀 / "ses" / "ses_"）──
test("T01：形状合法的截断前缀 → 就地改写 args.sessionID 放行（不 throw）", async () => {
  const leader = "ses_leadG1"; const m = await setupLeader(leader);
  const input = { agent: "wf/planner", sessionID: "ses_planFull" };
  await callSub(m, leader, input);
  assert.equal(input.sessionID, FULL, "入参应被服务端改写为登记会话 ID（仿别名分支）");
});

test("T01：'ses' / 'ses_' 截断前缀（非法形状真前缀）→ 就地改写放行", async () => {
  const leader = "ses_leadG2"; const m = await setupLeader(leader);
  const i1 = { agent: "wf/planner", sessionID: "ses" };
  await callSub(m, leader, i1);
  assert.equal(i1.sessionID, FULL);
  const i2 = { agent: "wf/planner", sessionID: "ses_" };
  await callSub(m, leader, i2);
  assert.equal(i2.sessionID, FULL);
});

// ── T01：拒绝类仍拒但无回显（A5）────────────────────────────────────
test("T01：形状非法非前缀（幻觉 'bogus'）→ 拒绝，无登记 ID 回显 + auto 指路", async () => {
  const leader = "ses_leadG3"; const m = await setupLeader(leader);
  await assert.rejects(
    () => callSub(m, leader, { agent: "wf/planner", sessionID: "bogus" }),
    (e) => rejectsWithoutEcho(e) && String(e.message).includes("auto"),
  );
});

// ── 放行：正确 / 新建 / 多 lane / 无登记 / 非 leader（A4/A7/A8 回归保护）──
test("B层：正确完整 ID → 放行", async () => {
  const leader = "ses_leadG4"; const m = await setupLeader(leader);
  await callSub(m, leader, { agent: "wf/planner", sessionID: FULL }); // 不 throw 即通过
});

test("B层：省略 sessionID（新建子会话）→ 放行", async () => {
  const leader = "ses_leadG5"; const m = await setupLeader(leader);
  await callSub(m, leader, { agent: "wf/planner" }); // 无 sessionID 键
  await callSub(m, leader, { agent: "wf/planner", sessionID: "" }); // 空串视同新建
});

test("B层：全形状非前缀不符（多 lane 另一会话）→ 放行交宿主归属校验", async () => {
  const leader = "ses_leadG6"; const m = await setupLeader(leader);
  await callSub(m, leader, { agent: "wf/planner", sessionID: "ses_otherLane999" }); // 合法形状、非前缀 → 不干预
});

test("B层：目标角色无登记 → 放行", async () => {
  const leader = "ses_leadG7"; const m = await setupLeader(leader);
  await callSub(m, leader, { agent: "wf/builder", sessionID: "ses_planFull" }); // builder 未登记，即便是前缀也不干预
});

test("B层：非 leader 调用（build / wf/builder）→ 放行", async () => {
  const leader = "ses_leadG8"; const m = await setupLeader(leader);
  await callSub(m, leader, { agent: "wf/planner", sessionID: "ses_planFull" }, "build");
  await callSub(m, leader, { agent: "wf/planner", sessionID: "ses_planFull" }, "wf/builder");
});

test("B层：leader 别名 wf/leader 同样管辖（前缀 → 改写放行）", async () => {
  const leader = "ses_leadG9"; const m = await setupLeader(leader);
  const input = { agent: "wf/planner", sessionID: "ses_planFull" };
  await callSub(m, leader, input, "wf/leader");
  assert.equal(input.sessionID, FULL, "wf/leader 别名的续用同样受管辖并改写");
});

// ── 审计 + 不干扰既有闸门 ────────────────────────────────────────────
test("T01：截断前缀改写落审计 session:correct（detail 含 ID 合规——wf.db 不进模型上下文）", async () => {
  const leader = "ses_leadG10"; const m = await setupLeader(leader);
  const input = { agent: "wf/planner", sessionID: "ses_planFull" };
  await callSub(m, leader, input);
  assert.equal(input.sessionID, FULL);
  const st = stOf(leader);
  assert.ok(st.log.some((l) => l.cmd === "session:correct"), "审计含 session:correct");
  const ev = st.log.find((l) => l.cmd === "session:correct");
  assert.match(ev.detail, /ses_planFull → ses_planFull123/);
});

test("B层：planning（阻断阶段）正确续用 subagent 不被 edit 闸门误拦", async () => {
  const leader = "ses_leadG11"; const m = await setupLeader(leader); // phase=planning（BLOCKING）
  await callSub(m, leader, { agent: "wf/planner", sessionID: FULL }); // subagent 非 edit，不得被阶段闸门拦
});

test("B层：不吞 edit 闸门——planning 阶段 wf/builder 越权 edit 仍被阻断", async () => {
  const leader = "ses_leadG12"; const m = await setupLeader(leader);
  await assert.rejects(
    () => m.hook()({ tool: "edit", sessionID: "ses_builderX", agent: "wf/builder", input: { path: `${DIR}/src/x.ts` } }, {}),
    (e) => /硬关卡：阶段「planning」/.test(String(e.message)),
  );
});

// ── 存活探针（time.busy/idle；防续用运行中会话→静默分叉）──────────────
test("T01：前缀 + 运行中（busy>idle）→ 拒绝警示「仍在运行」，无登记 ID 回显（A3）", async () => {
  const leader = "ses_leadG13"; const m = await setupLeader(leader);
  m.ctx.session.get = async ({ sessionID }) => sessionID === FULL
    ? { time: { busy: 200, idle: 100 } } // busy>idle → 运行中
    : { projectID: "pi1", location: { directory: DIR } };
  const input = { agent: "wf/planner", sessionID: "ses_planFull" };
  await assert.rejects(
    () => callSub(m, leader, input),
    (e) => rejectsWithoutEcho(e) && /仍在运行/.test(String(e.message)) && /勿续用运行中会话/.test(String(e.message)),
  );
  assert.equal(input.sessionID, "ses_planFull", "运行中拒绝：入参未被改写（防静默分叉，仅警示）");
});

test("T01：前缀 + 已完成（idle>=busy）→ 就地改写放行（A4，liveNote 路径弃用）", async () => {
  const leader = "ses_leadG14"; const m = await setupLeader(leader);
  m.ctx.session.get = async ({ sessionID }) => sessionID === FULL
    ? { time: { busy: 100, idle: 200 } } // idle>=busy → 已完成
    : { projectID: "pi1", location: { directory: DIR } };
  const input = { agent: "wf/planner", sessionID: "ses_planFull" };
  await callSub(m, leader, input);
  assert.equal(input.sessionID, FULL);
});

test("T01：前缀 + session.get 异常（探不到存活）→ 改写放行不 throw（A4）", async () => {
  const leader = "ses_leadG15"; const m = await setupLeader(leader);
  m.ctx.session.get = async () => { throw new Error("session.get unavailable"); };
  const input = { agent: "wf/planner", sessionID: "ses_planFull" };
  await callSub(m, leader, input);
  assert.equal(input.sessionID, FULL);
});

// ── T04 端到端死循环锚：截断转录不再产生回显燃料即闭环 ────────────────
test("T01 闭环：'ses' 连续两次转录截断 → 均就地改写放行（零回显，无死循环）", async () => {
  const leader = "ses_leadG16"; const m = await setupLeader(leader);
  const i1 = { agent: "wf/planner", sessionID: "ses" };
  await callSub(m, leader, i1);
  assert.equal(i1.sessionID, FULL);
  const i2 = { agent: "wf/planner", sessionID: "ses" };
  await callSub(m, leader, i2);
  assert.equal(i2.sessionID, FULL);
  const st = stOf(leader);
  assert.ok(st.log.filter((l) => l.cmd === "session:correct").length >= 2, "两次改写均落审计");
});
