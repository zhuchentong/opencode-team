// M16-r41：会话复用可靠化（B 层）——subagent 续接自愈守卫。
// 根因：A 层已自动登记 roleSessions + guidance 渲染完整 ID，但 leader 仍可能凭记忆复述→截断。
//   B 层在续接入口（execute.before 的 subagent 分支）对「截断/非法」sessionID 一次性纠正（附完整 ID），
//   把「3 次盲试→冷启动」压成「1 次纠正→暖续用」。
// 关键约束（验证报告 S1/I2/I3/B1/B2）：
//   S1 纠正 throw 必须含 GATE_ERR="[wf-workflow]"，否则被 fail-open 吞掉→静默 no-op；
//   I2 分支置于 edit/shell 过滤之前；I3 仅「形状非法 OR 登记 ID 真前缀」才纠正，全形状非前缀不符→放行（多 lane 安全）；
//   B1 用 isLeader（workflow + wf/leader 双别名）；B2 审计 cmd=session:correct。
// 覆盖：截断前缀/形状非法/正确放行/新建放行/多 lane 放行/无登记放行/非 leader 放行/别名/审计/不干扰 edit 闸门。
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
      transform: (fn) => { fn({ add: (d) => tools.push(d), list: () => tools.map((t) => ({ name: t.name })) }); return { dispose() {} }; },
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

// 建 leader 任务并经 A 层登记 wf/planner 子会话（完整 ID=ses_planFull123）
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
const isCorrect = (full) => (e) => {
  const msg = String(e?.message ?? e);
  return msg.includes("[wf-workflow]") && msg.includes(full); // S1：GATE_ERR 穿透 + 附完整 ID
};

// ── 拦截：截断/非法 → 一次性纠正附完整 ID ─────────────────────────────
test("B层：形状合法的截断前缀 → 拦截，附完整 ID + GATE_ERR", async () => {
  const leader = "ses_leadG1"; const m = await setupLeader(leader);
  await assert.rejects(() => callSub(m, leader, { agent: "wf/planner", sessionID: "ses_planFull" }), isCorrect(FULL));
});

test("B层：'ses' / 'ses_' 形状非法前缀 → 拦截附完整 ID", async () => {
  const leader = "ses_leadG2"; const m = await setupLeader(leader);
  await assert.rejects(() => callSub(m, leader, { agent: "wf/planner", sessionID: "ses" }), isCorrect(FULL));
  await assert.rejects(() => callSub(m, leader, { agent: "wf/planner", sessionID: "ses_" }), isCorrect(FULL));
});

test("B层：形状非法非前缀（幻觉 'bogus'）→ 拦截附完整 ID", async () => {
  const leader = "ses_leadG3"; const m = await setupLeader(leader);
  await assert.rejects(() => callSub(m, leader, { agent: "wf/planner", sessionID: "bogus" }), isCorrect(FULL));
});

// ── 放行：正确 / 新建 / 多 lane / 无登记 / 非 leader ──────────────────
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

test("B层：leader 别名 wf/leader 同样管辖", async () => {
  const leader = "ses_leadG9"; const m = await setupLeader(leader);
  await assert.rejects(() => callSub(m, leader, { agent: "wf/planner", sessionID: "ses_planFull" }, "wf/leader"), isCorrect(FULL));
});

// ── 审计 + 不干扰既有闸门 ────────────────────────────────────────────
test("B层：纠正落审计 session:correct（供 /wf:diagnose 取证）", async () => {
  const leader = "ses_leadG10"; const m = await setupLeader(leader);
  await assert.rejects(() => callSub(m, leader, { agent: "wf/planner", sessionID: "ses_planFull" }), isCorrect(FULL));
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

// ── probe 4 增强：纠正附子会话存活状态（time.busy/idle；防续用运行中会话→静默分叉）──
test("B层增强：运行中子会话（busy>idle）→ 纠正附「仍在运行」警示", async () => {
  const leader = "ses_leadG13"; const m = await setupLeader(leader);
  m.ctx.session.get = async ({ sessionID }) => sessionID === FULL
    ? { time: { busy: 200, idle: 100 } } // busy>idle → 运行中
    : { projectID: "pi1", location: { directory: DIR } };
  await assert.rejects(
    () => callSub(m, leader, { agent: "wf/planner", sessionID: "ses_planFull" }),
    (e) => isCorrect(FULL)(e) && /仍在运行/.test(String(e.message)),
  );
});

test("B层增强：已完成子会话（idle>=busy）→ 纠正附「可安全续用」", async () => {
  const leader = "ses_leadG14"; const m = await setupLeader(leader);
  m.ctx.session.get = async ({ sessionID }) => sessionID === FULL
    ? { time: { busy: 100, idle: 200 } } // idle>=busy → 已完成
    : { projectID: "pi1", location: { directory: DIR } };
  await assert.rejects(
    () => callSub(m, leader, { agent: "wf/planner", sessionID: "ses_planFull" }),
    (e) => isCorrect(FULL)(e) && /可安全续用/.test(String(e.message)),
  );
});

test("B层增强：session.get 无 time（取不到存活）→ 仍纠正、不附注、不报错", async () => {
  const leader = "ses_leadG15"; const m = await setupLeader(leader);
  m.ctx.session.get = async () => { throw new Error("session.get unavailable"); };
  await assert.rejects(() => callSub(m, leader, { agent: "wf/planner", sessionID: "ses_planFull" }), isCorrect(FULL));
});