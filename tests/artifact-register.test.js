// M16-r47（A+B）：wf_write_artifact register 模式——产物由原生 write/edit 落盘后，
// 不带 content/patch 调用即注册记账（入参极小，慢模型流中断时重试不重生成内容）。
// 真机取证（tui-sidebar-elapsed r45）：planner-reviewer 8KB 报告单次 tool call 被
// ECONNRESET 截断→harness retry 全量重生成；分段原生写+微小注册切断该恶性循环。
// 关键语义：register 复用与 content 模式完全相同的记账链（verdict/gate 字段/plan 清账/
// roleSessions/告警/指路）；plan 幂等守卫（bytes 未变→no-op 不清账）；空文件拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js"; // T04：装配收敛（rawCtx=setup(ctx) 消费者视图）

// 虚拟模块占位包自举已单点化到 tests/_preload.js（P0-A，latency-v3.1）——本文件不再自举（副本=漂移源）。

const DIR = "/tmp/opencode/wf-register";
const DB = `${DIR}/.workflow/wf.db`;

const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const store = new Map();
  let hookFn = null;
  // T04：装配收敛 helpers/host-stub（store=旧 storage 迁移源形状保持；put/list 走 stub 缺省 inert）
  const host = mkHostStub({
    options: { probe: false, requireIntakeConfirm: false }, // intake-discuss-gate T05 opt-out（本套件与 intake 关卡无关；生产缺省 true 不动）
    location: { directory: DIR },
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
      scan: async () => ({ entries: [] }),
    },
    sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) },
    tools: { hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
  });
  return { ctx: host.rawCtx, tools: host.toolDefs, cmds: host.cmdDefs, hook: () => hookFn };
};
const confirm = (m, sid) => m.hook()({ tool: "question", sessionID: sid, agent: "workflow",
  input: { questions: [{ question: "方案确认", header: "方案确认", options: [{ label: "批准执行" }, { label: "修改方案" }, { label: "终止任务" }] }] } }, {});
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (sid) => {
  const d = new Database(DB);
  try {
    const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid);
    return row ? JSON.parse(row.state_json) : undefined;
  } finally { try { d.close(); } catch { } }
};
const fileOf = (slug, file) => `${DIR}/.workflow/${slug}/${file}`;
// 模拟子代理原生 write 落盘（probe 实证宿主放行 .workflow/）
const nativeWrite = (slug, file, content) => {
  fs.mkdirSync(`${DIR}/.workflow/${slug}`, { recursive: true });
  fs.writeFileSync(fileOf(slug, file), content);
};

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

// nonleader-decontam B2b：无任务拒绝补默认回退（第二行）——build 误调不被诱导去开任务；
// 条件排除 wf/* 子会话（它们是 wf 会话，原"回报 leader"语义保留）。
test("nonleader-decontam B2b：无任务拒绝含默认回退（第二行）；回报 leader 语义保留", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const w = await tool(m).execute({ kind: "plan", content: "x" }, { sessionID: "ses_none", agent: "build" });
  assert.match(w.content, /本会话无活动 wf 任务/);
  assert.match(w.content, /回报 leader/, "wf/* 子代理原语义保留");
  assert.match(w.content, /按默认方式完成任务/, "默认回退出口");
  assert.match(w.content, /非 wf 工作流会话/, "条件排除 wf/* 子会话");
  const lines = w.content.split("\n").filter((l) => l.trim() !== "");
  assert.ok(lines.length >= 2, "回退句在第二行（brief 只取首行）");
  dispose?.();
});

test("M16-r47 register：原生落盘 plan-review → 注册记账 verdict/artifacts/审计/roleSessions 全链路与 content 模式等价", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_r1";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "register-review" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  // 子代理分段原生写（首段含结论行）→ 全部落盘后注册
  nativeWrite("register-review", "plan-review-r1.md", "**结论**: PASS\n\n## 发现\n\n无硬伤。\n");
  const w = await tool(m).execute({ kind: "plan-review" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  assert.match(w.content, /已注册/, "register 回执应为「已注册」");
  assert.match(w.content, /plan-review-r1\.md/);
  const st = stOf(sid);
  assert.equal(st.verdicts?.planReview, "PASS", "verdict 应从盘上全文解析");
  assert.equal(st.artifacts["plan-review-r1.md"].bytes, fs.statSync(fileOf("register-review", "plan-review-r1.md")).size);
  const last = st.log.filter((e) => e.cmd === "tool:wf_write_artifact").at(-1);
  assert.equal(String(last.note), "plan-review-r1.md mode=register", "审计打 mode=register");
  assert.equal(st.reuse?.roleSessions?.["wf/planner-reviewer"]?.sessionID, sid, "roleSessions 登记与 content 模式同链路"); // R3 T3.1 子步 C
  dispose?.();
});

test("M16-r47 register：目标不存在→报错含期望路径；空文件→拒绝注册", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_r2";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "register-miss" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  const miss = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(miss.content, /❌/);
  assert.match(miss.content, /register 目标不存在/);
  assert.match(miss.content, /\.workflow\/register-miss\/plan\.md/, "报错须含 canonical 期望路径");
  // 空文件（截断残留）拒绝
  nativeWrite("register-miss", "plan.md", "");
  const empty = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(empty.content, /❌/);
  assert.match(empty.content, /0 字节/);
  assert.ok(!stOf(sid).artifacts?.["plan.md"], "拒绝注册不落记账");
  dispose?.();
});

test("M16-r47 register：test-report 注册 PASS → wf:done 关卡放行（与 content 模式同语义）", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_r3";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[FULL][S] register-done" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  nativeWrite("register-done", "test-plan.md", "# 用例\n");
  await tool(m).execute({ kind: "test-plan" }, { sessionID: sid, agent: "wf/tester" });
  assert.equal(stOf(sid).verdicts?.testPlanWritten, true, "test-plan 注册置旗标");
  await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} });
  await confirm(m, sid);
  await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:reconcile").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review-build").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:test").execute({ sessionID: sid, prompt: {} });
  nativeWrite("register-done", "test-report.md", "**结论**: PASS\n\n全部用例绿。\n");
  const w = await tool(m).execute({ kind: "test-report" }, { sessionID: sid, agent: "wf/tester" });
  assert.equal(stOf(sid).verdicts?.testReport, "PASS");
  assert.match(w.content, /验收 PASS/, "verdict 指路基于盘上解析");
  nativeWrite("register-done", "lessons.md", "# lessons\n1 条（效率批 P2：done 关卡校验在案）\n");
  await tool(m).execute({ kind: "lessons" }, { sessionID: sid, agent: "wf/leader" });
  const ok = await cmd(m, "wf:done").execute({ sessionID: sid, prompt: {} });
  assert.match(ok, /【wf 工作流｜done】/);
  dispose?.();
});

test("M16-r47 register：plan 幂等守卫——bytes 未变重放 no-op 不清账；变化则清；再重放又 no-op", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_r4";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[S] register-plan" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# 计划 v1\n" }, { sessionID: sid, agent: "wf/planner" });
  await tool(m).execute({ kind: "plan-review", content: "**结论**: PASS\n\n干净。\n" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  nativeWrite("register-plan", "test-plan.md", "# 用例\n");
  await tool(m).execute({ kind: "test-plan" }, { sessionID: sid, agent: "wf/tester" });
  await confirm(m, sid);
  assert.equal(stOf(sid).verdicts?.planReview, "PASS");
  assert.equal(stOf(sid).verdicts?.confirmedAt !== undefined, true);
  // 误重放 register(kind=plan)：盘上 bytes 与记账一致 → no-op，review 账不清
  const before = stOf(sid);
  const noop = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(noop.content, /已注册且内容未变化/);
  const after = stOf(sid);
  assert.equal(after.verdicts?.planReview, "PASS", "no-op 不得清 review 结论");
  assert.equal(after.verdicts?.testPlanWritten, true, "no-op 不得清 test-plan 旗标");
  assert.equal(after.verdicts?.confirmedAt, before.verdicts?.confirmedAt, "no-op 不得清方案确认");
  assert.equal(after.log.filter((e) => e.cmd === "tool:wf_write_artifact").length,
    before.log.filter((e) => e.cmd === "tool:wf_write_artifact").length, "no-op 不追加审计");
  // 原生 edit 修订（bytes 变化）→ 注册清账（镜像 plan-invalidate 语义）
  nativeWrite("register-plan", "plan.md", "# 计划 v2\n\n新增风险节。\n");
  const rev = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(rev.content, /已注册/);
  const st2 = stOf(sid);
  assert.equal(st2.verdicts?.planReview, undefined, "修订注册须清 review 结论");
  assert.equal(st2.verdicts?.testPlanWritten, undefined, "修订注册须清 test-plan 旗标");
  assert.equal(st2.verdicts?.confirmedAt, undefined, "修订注册须清方案确认");
  assert.match(rev.content, /plan 已修订/, "清账指路保留");
  // 再重放 → 又 no-op（记账 bytes 已同步为 v2）
  const noop2 = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(noop2.content, /已注册且内容未变化/);
  assert.equal(stOf(sid).artifacts["plan.md"].bytes, fs.statSync(fileOf("register-plan", "plan.md")).size);
  dispose?.();
});

test("M16-r47 register：超预算产物注册仍告警（字节计，不阻断）", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_r5";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[S] register-budget" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  nativeWrite("register-budget", "plan.md", "x".repeat(11 * 1024));
  const w = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(w.content, /已注册/);
  assert.match(w.content, /超瘦身预算/, "S 级 plan 预算 10KB，盘上 11KB 注册应告警不阻断");
  assert.ok(stOf(sid).artifacts["plan.md"], "告警不阻断记账");
  dispose?.();
});

// ── r53 批次 1：register 幂等守卫 hash 复核（bytes 弱比较升级 sha256 前 12 位）─────────
const setupPlan = async (m, sid, slug) => {
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: `[S] ${slug}` } }); // 效率批 P1：S 豁免边表预检（机制测试与体量无关）
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# 计划 v1\n" }, { sessionID: sid, agent: "wf/planner" });
  await tool(m).execute({ kind: "plan-review", content: "**结论**: PASS\n\n干净。\n" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  await confirm(m, sid);
};

test("r53 hash 复核：bytes 同 hash 异（等长改写）→ 不 no-op，走修订即清；hash 入记账与审计", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_r53h";
  await setupPlan(m, sid, "r53-collision");
  assert.ok(stOf(sid).artifacts["plan.md"].hash, "记账含 hash 字段");
  // 等长异内容改写（12 bytes → 12 bytes）：bytes 弱比较判不变，hash 复判=变更
  nativeWrite("r53-collision", "plan.md", "# 计划 v2\n");
  const rev = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(rev.content, /plan 已修订/, "hash 判变 → 修订即清（不再误 no-op）");
  assert.equal(stOf(sid).verdicts?.planReview, undefined, "review 结论被清");
  const log = stOf(sid).log.filter((e) => e.cmd === "tool:wf_write_artifact");
  assert.match(String(log.at(-1).detail), /hash=[0-9a-f]{12}/, "审计 detail 含 hash");
  dispose?.();
});

test("r53 hash 复核：同内容重放 → hash 一致 no-op（既有语义保持）", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_r53n";
  await setupPlan(m, sid, "r53-noop");
  const noop = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(noop.content, /已注册且内容未变化/);
  assert.equal(stOf(sid).verdicts?.planReview, "PASS", "no-op 不清账");
  dispose?.();
});

test("r53 hash 复核：存量记账无 hash → 退回 bytes 弱比较（向后兼容 no-op）", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_r53l";
  await setupPlan(m, sid, "r53-legacy");
  // 手工摘除 hash 模拟存量形状（直改 state_json）
  const d = new Database(DB);
  const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid);
  const st = JSON.parse(row.state_json);
  delete st.artifacts["plan.md"].hash;
  d.query("UPDATE tasks SET state_json = ? WHERE session_id = ?").run(JSON.stringify(st), sid);
  d.close();
  const noop = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(noop.content, /已注册且内容未变化/, "无 hash → bytes 比较维持 no-op 不放大锐边");
  assert.equal(stOf(sid).verdicts?.planReview, "PASS");
  dispose?.();
});
