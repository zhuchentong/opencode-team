// intake-discuss-gate T02/T03：intake 确认开关 plumbing + question 观测三分支。
// T02：wf:intake apply 步固化 st.intakeConfirmOff = host.options.requireIntakeConfirm === false
//（恒写布尔、re-intake 重算、options 活读；固化行在 selfmod try/catch 之外——评审 N1）。
// T03：guard-hook question 观测三分支——intake 锚「需求无误」记 verdicts.intakeConfirmedAt；
// review/test_design 旧锚「批准」/approve 逐字保留；其余相位 return。
// 诚实边界：用户卡片实际选择不可观测（只回模型）——本套件锁「出过卡」，不锁「答的是确认」。
// mock 底座=tests/_preload.js 自举 + helpers/host-stub（禁散装自举副本；仿 plan-confirm mkCtx/ask/stOf）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js";

const DIR = "/tmp/opencode/wf-intake-orch";
const DB = `${DIR}/.workflow/wf.db`;
const mkCtx = (options = {}) => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const entries = [];
  let hookFn = null;
  const host = mkHostStub({
    options: { probe: false, ...options },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) },
    instructions: { put: async (i) => { entries.push(i); }, list: async () => entries },
    tools: { hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
  });
  // options 活读验证入口：rawCtx.options 与 adaptHost getter 同源对象（就地改=热载/测试覆写同路径）
  return { ctx: host.rawCtx, tools: host.toolDefs, cmds: host.cmdDefs, entries, hook: () => hookFn, options: host.rawCtx.options };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
   catch { return undefined; } // W15-b：无库/无表=无行（惰性语义）
  finally { try { d.close(); } catch { } }
};
// leader question 调用模拟（labels 可定制；默认=intake 讨论确认卡三选项）
const ask = (m, sid, agent = "workflow", labels = ["需求无误，开始规划", "补充修正", "终止任务"]) =>
  m.hook()({ tool: "question", sessionID: sid, agent,
    input: { questions: [{ question: "需求确认", header: "需求确认", options: labels.map((label) => ({ label })) }] } }, {});
const intake = (m, sid, text = "[M] orch-t") => cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text } });
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// ── T02：开关 plumbing ───────────────────────────────────────────────
test("T02 plumbing：requireIntakeConfirm=false → intake 后 intakeConfirmOff===true", async () => {
  const sid = "ses_io1"; const m = mkCtx({ requireIntakeConfirm: false }); await plugin.setup(m.ctx);
  await intake(m, sid);
  assert.equal(stOf(sid).intakeConfirmOff, true, "显式 false → 固化 true（恒写布尔）");
});

test("T02 plumbing：缺省 / true → intakeConfirmOff===false", async () => {
  const sid = "ses_io2"; const m = mkCtx(); await plugin.setup(m.ctx);
  await intake(m, sid);
  assert.equal(stOf(sid).intakeConfirmOff, false, "缺省 → false（关卡生效）");
  const sid2 = "ses_io2b"; const m2 = mkCtx({ requireIntakeConfirm: true }); await plugin.setup(m2.ctx);
  await intake(m2, sid2);
  assert.equal(stOf(sid2).intakeConfirmOff, false, "显式 true → false");
});

test("T02 plumbing：re-intake 重算（options 活读，双向）", async () => {
  const sid = "ses_io3"; const m = mkCtx({ requireIntakeConfirm: false }); await plugin.setup(m.ctx);
  await intake(m, sid);
  assert.equal(stOf(sid).intakeConfirmOff, true);
  m.options.requireIntakeConfirm = true; // 活读：就地改 options（热载/测试覆写同路径）
  await intake(m, sid, "! orch-t2");
  assert.equal(stOf(sid).intakeConfirmOff, false, "re-intake 按现势 options 重算 true→false");
  m.options.requireIntakeConfirm = false;
  await intake(m, sid, "! orch-t3");
  assert.equal(stOf(sid).intakeConfirmOff, true, "re-intake 重算 false→true");
});

test("T02 plumbing：其它命令不写该字段（值保持 intake 固化结果）", async () => {
  const sid = "ses_io4"; const m = mkCtx({ requireIntakeConfirm: false }); await plugin.setup(m.ctx);
  await intake(m, sid);
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  assert.equal(stOf(sid).intakeConfirmOff, true, "wf:plan 不改写固化值");
  const sid2 = "ses_io4b"; const m2 = mkCtx(); await plugin.setup(m2.ctx);
  await intake(m2, sid2);
  await cmd(m2, "wf:plan").execute({ sessionID: sid2, prompt: {} });
  assert.equal(stOf(sid2).intakeConfirmOff, false, "缺省固化 false 亦不被其它命令抹除");
});

// ── T03：question 观测三分支 ─────────────────────────────────────────
const setupAtIntake = async (sid, options = {}) => {
  const m = mkCtx(options); await plugin.setup(m.ctx);
  await intake(m, sid); // → intake（讨论确认窗口）
  return m;
};
const setupAtReview = async (sid) => {
  const m = await setupAtIntake(sid, { requireIntakeConfirm: false }); // T05 opt-out：本例验 review 旧锚，与 intake 关卡无关
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} }); // → review（方案确认窗口）
  return m;
};

test("T03 观测：intake+「需求无误，开始规划」→ 记账 intakeConfirmedAt + 审计恰一条", async () => {
  const sid = "ses_io5"; const m = await setupAtIntake(sid);
  await ask(m, sid);
  const st = stOf(sid);
  assert.ok(st.verdicts?.intakeConfirmedAt, "intakeConfirmedAt 已记账");
  const evs = st.log.filter((l) => l.cmd === "intake:confirm");
  assert.equal(evs.length, 1, "审计恰一条 intake:confirm");
  assert.equal(evs[0].note, "question-observed");
});

test("T03 防串：intake+「批准执行」不记任何确认；intake 出卡不写 confirmedAt", async () => {
  const sid = "ses_io6"; const m = await setupAtIntake(sid);
  await ask(m, sid, "workflow", ["批准执行", "修改方案", "终止任务"]);
  const st = stOf(sid);
  assert.equal(st.verdicts?.intakeConfirmedAt, undefined, "intake 相位不锚「批准」（防串方案确认）");
  assert.equal(st.verdicts?.confirmedAt, undefined, "intake 相位不写方案确认");
  assert.equal(st.log.filter((l) => l.cmd === "intake:confirm" || l.cmd === "plan:confirm").length, 0);
  await ask(m, sid); // 正常 intake 确认卡
  assert.ok(stOf(sid).verdicts?.intakeConfirmedAt);
  assert.equal(stOf(sid).verdicts?.confirmedAt, undefined, "intake 出卡记账不写 confirmedAt（两账隔离）");
});

test("T03 回归：review+「批准执行」→ confirmedAt 旧行为不变", async () => {
  const sid = "ses_io7"; const m = await setupAtReview(sid);
  await ask(m, sid, "workflow", ["批准执行", "修改方案", "终止任务"]);
  const st = stOf(sid);
  assert.ok(st.verdicts?.confirmedAt, "review 窗口旧锚记账");
  assert.equal(st.verdicts?.intakeConfirmedAt, undefined, "review 相位不写 intake 账");
  assert.ok(st.log.find((l) => l.cmd === "plan:confirm" && l.note === "question-observed"));
});

test("T03 窗口外：planning 澄清问不记账（含「需求无误」标签亦不计）", async () => {
  const sid = "ses_io8"; const m = await setupAtIntake(sid, { requireIntakeConfirm: false }); // T05 opt-out：本例验 planning 窗口外，与 intake 关卡无关
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} }); // → planning
  await ask(m, sid);
  const st = stOf(sid);
  assert.equal(st.verdicts?.intakeConfirmedAt, undefined, "planning 非确认窗口");
  assert.equal(st.verdicts?.confirmedAt, undefined);
});

test("T03 守卫：非 leader / 无活动任务不记账", async () => {
  const sid = "ses_io9"; const m = await setupAtIntake(sid);
  await ask(m, sid, "wf/planner"); // 子会话 question 不记账
  assert.equal(stOf(sid).verdicts?.intakeConfirmedAt, undefined, "非 leader 不记账");
  await ask(m, sid, "build"); // 普通主会话 agent 不记账
  assert.equal(stOf(sid).verdicts?.intakeConfirmedAt, undefined, "普通 agent 不记账");
  const m2 = mkCtx(); await plugin.setup(m2.ctx);
  await ask(m2, "ses_io_ghost"); // 无任务会话：不崩、不落盘
  assert.equal(stOf("ses_io_ghost"), undefined, "无任务不落状态行");
});

test("T03 幂等：重复 question 不重复记账（审计恰一条）", async () => {
  const sid = "ses_io10"; const m = await setupAtIntake(sid);
  await ask(m, sid);
  const first = stOf(sid).verdicts?.intakeConfirmedAt;
  await ask(m, sid);
  const st = stOf(sid);
  assert.equal(st.log.filter((l) => l.cmd === "intake:confirm").length, 1, "重复 question 不重复审计");
  assert.equal(st.verdicts?.intakeConfirmedAt, first, "已记账跳过 save（时间戳不抖动）");
});

test("T03 无锚：「补充修正/终止任务」不记账（勿锚终止类标签）", async () => {
  const sid = "ses_io11"; const m = await setupAtIntake(sid);
  await ask(m, sid, "workflow", ["补充修正", "终止任务"]);
  const st = stOf(sid);
  assert.equal(st.verdicts?.intakeConfirmedAt, undefined, "无「需求无误」锚不记账");
  assert.equal(st.log.filter((l) => l.cmd === "intake:confirm").length, 0);
});