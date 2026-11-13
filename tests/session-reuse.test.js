// M16-r40：会话复用可靠化（A 层）——角色→子会话自动登记 + guidance 重委派点渲染续用指引。
// fix-sid-truncation-echo-loop T02 行为反转：渲染文本不再回显登记 sid 字面量（「完整 ID=」燃料已拆）——
//   有登记仅指路别名（SID_ALIAS_USAGE）/省略新建；无登记→不渲染。
// 根因：旧渲染把登记 ID 新鲜递到上下文诱导转录→截断→守卫回显→再转录死循环。
// 覆盖：trackRoleSession 纯函数 / intake 重置清空 / guidance 渲染（无回显）/ 产物写入登记 /
//   guard-hook builder 登记（非阻断阶段也登记、不干扰闸门、非 wf 不登记）/ wf:status 取证。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js"; // T04：装配收敛（_ctx=setup(ctx) 消费者视图）
import { trackRoleSession, evaluateTransition } from "../server/lib.ts";
import { guidance } from "../server/guidance.ts";

const DIR = "/tmp/opencode/wf-session-reuse";
const DB = `${DIR}/.workflow/wf.db`;
// mock 形状与 integration.test.js 同源（含 tool.hook 捕获，供 guard-hook 登记测试）
const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const entries = [];
  let hookFn = null;
  // T04：装配收敛 helpers/host-stub（tools/cmds=stub 注册捕获数组；question 取证=tools.hook 覆盖）
  const host = mkHostStub({
    options: { probe: false },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) },
    instructions: { put: async (i) => { entries.push(i); }, list: async () => entries },
    tools: { hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
  });
  return { ctx: host._ctx, tools: host._toolDefs, cmds: host._cmdDefs, entries, hook: () => hookFn };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
const blank = (over = {}) => ({ slug: "t", phase: null, rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, artifacts: {}, lanes: {}, ...over });
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(`${DIR}/src`, { recursive: true });

// ── 纯函数：trackRoleSession ─────────────────────────────────────────
test("trackRoleSession：wf/* 子会话登记；同 ID 去重；换 ID 更新", () => {
  const st = blank();
  assert.equal(trackRoleSession(st, "wf/planner", "ses_aaa111"), true);
  assert.equal(st.roleSessions["wf/planner"].sessionID, "ses_aaa111");
  assert.ok(typeof st.roleSessions["wf/planner"].at === "string");
  assert.equal(trackRoleSession(st, "wf/planner", "ses_aaa111"), false, "同 sessionID 不重复登记（免 save 抖动）");
  assert.equal(trackRoleSession(st, "wf/planner", "ses_bbb222"), true, "同角色新会话 → 更新");
  assert.equal(st.roleSessions["wf/planner"].sessionID, "ses_bbb222");
  // 多角色并存
  assert.equal(trackRoleSession(st, "wf/builder", "ses_ccc333"), true);
  assert.equal(st.roleSessions["wf/builder"].sessionID, "ses_ccc333");
  assert.equal(st.roleSessions["wf/planner"].sessionID, "ses_bbb222", "角色互不覆盖");
});

test("trackRoleSession：leader/普通 agent/非法形状拒绝", () => {
  const st = blank();
  assert.equal(trackRoleSession(st, "workflow", "ses_x1"), false, "leader 主名不登记");
  assert.equal(trackRoleSession(st, "wf/leader", "ses_x2"), false, "leader 别名不登记");
  assert.equal(trackRoleSession(st, "build", "ses_x3"), false, "普通 agent 不登记");
  assert.equal(trackRoleSession(st, "", "ses_x4"), false);
  assert.equal(trackRoleSession(st, "wf/planner", "ses"), false, "截断 ID 不登记");
  assert.equal(trackRoleSession(st, "wf/planner", "ses_"), false, "空尾 ID 不登记");
  assert.equal(trackRoleSession(st, "wf/planner", "bogus_id"), false, "非 ses_ 前缀不登记");
  assert.equal(trackRoleSession(st, "wf/planner", ""), false);
  assert.equal(trackRoleSession(st, "wf/planner", null), false);
  assert.equal(st.roleSessions, undefined, "全部拒绝 → 不建字段");
});

test("intake 重置清 roleSessions（新任务不得复用旧任务子会话）", () => {
  const st = blank({ phase: "done", slug: "old", roleSessions: { "wf/planner": { sessionID: "ses_old1", at: "t" } } });
  assert.ok(evaluateTransition("wf:intake", st, "new-task").ok);
  assert.deepEqual(st.roleSessions, {}, "intake 重置清空角色会话登记");
});

// ── guidance：重委派点渲染续用指引（T02：零回显）─────────────────────
const rs = (agent, sid) => ({ [agent]: { sessionID: sid, at: "t" } });

test("T02/B1：guidance daily planning 有登记 → 指路别名+省略新建，零回显；无登记 → 不渲染", () => {
  const withSess = guidance("planning", blank({ mode: "daily", size: "M", roleSessions: rs("wf/planner", "ses_plan123") }));
  assert.ok(!withSess.includes("ses_plan123"), "登记 sid 字面量不得进渲染文本（防回显燃料）");
  assert.ok(!withSess.includes("完整 ID="), "「完整 ID=」字面量已删");
  assert.ok(!withSess.includes("逐字复制"), "「逐字复制」引导已删");
  assert.match(withSess, /sessionID="auto"/, "指路别名（经 SID_ALIAS_USAGE 插值，B3）");
  assert.match(withSess, /省略 sessionID/, "指路省略新建（天然免疫截断）");
  assert.match(withSess, /勿反复重试/, "既有纪律子串保留（B3）");
  const noSess = guidance("planning", blank({ mode: "daily", size: "M" }));
  assert.ok(!/续用 wf\/planner 子会话/.test(noSess), "无登记 → reuseLine 返回 null 不渲染（B2）");
  // S 级零 sub-agent：不渲染委派续用
  const s = guidance("planning", blank({ mode: "daily", size: "S", roleSessions: rs("wf/planner", "ses_plan123") }));
  assert.ok(!/续用 wf\/planner 子会话/.test(s), "S 级不委派，不渲染 planner 续用");
});

test("T02：guidance daily review r≥2 → 渲染 reviewer 续用指引（零回显）；r1 不渲染", () => {
  const r2 = guidance("review", blank({ mode: "daily", size: "M", rounds: { plan_review: 2, build_review: 0, test_fix: 0 }, roleSessions: rs("wf/planner-reviewer", "ses_rev456") }));
  assert.match(r2, /续用 wf\/planner-reviewer 子会话/);
  assert.ok(!r2.includes("ses_rev456"), "零回显");
  const r1 = guidance("review", blank({ mode: "daily", size: "M", rounds: { plan_review: 1, build_review: 0, test_fix: 0 }, roleSessions: rs("wf/planner-reviewer", "ses_rev456") }));
  assert.ok(!/续用 wf\/planner-reviewer 子会话/.test(r1), "r1 非增量复审，不渲染续用");
});

test("T02：guidance daily building 返工 → 渲染 builder 续用指引（零回显）", () => {
  const b = guidance("building", blank({ mode: "daily", size: "M", rounds: { plan_review: 1, build_review: 0, test_fix: 1 }, roleSessions: rs("wf/builder", "ses_build789") }));
  assert.match(b, /续用 wf\/builder 子会话/);
  assert.ok(!b.includes("ses_build789"), "零回显");
});

test("T02：guidance full 各重委派点渲染续用指引（零回显）", () => {
  const p = guidance("planning", blank({ mode: "full", roleSessions: rs("wf/planner", "ses_fp1") }));
  assert.match(p, /续用 wf\/planner 子会话/); assert.ok(!p.includes("ses_fp1"), "零回显");
  const rv = guidance("review", blank({ mode: "full", rounds: { plan_review: 2, build_review: 0, test_fix: 0 }, roleSessions: rs("wf/planner-reviewer", "ses_fr2") }));
  assert.match(rv, /续用 wf\/planner-reviewer 子会话/); assert.ok(!rv.includes("ses_fr2"), "零回显");
  const td = guidance("test_design", blank({ mode: "full", roleSessions: rs("wf/tester", "ses_ft3") }));
  assert.match(td, /续用 wf\/tester 子会话/); assert.ok(!td.includes("ses_ft3"), "零回显");
  const br = guidance("build_review", blank({ mode: "full", roleSessions: { ...rs("wf/builder", "ses_fb4"), ...rs("wf/builder-reviewer", "ses_fbr5") } }));
  assert.match(br, /续用 wf\/builder 子会话/); assert.match(br, /续用 wf\/builder-reviewer 子会话/);
  assert.ok(!br.includes("ses_fb4") && !br.includes("ses_fbr5"), "零回显");
  const fx = guidance("fixing", blank({ mode: "full", rounds: { plan_review: 1, build_review: 1, test_fix: 1 }, roleSessions: rs("wf/builder", "ses_fx6") }));
  assert.match(fx, /续用 wf\/builder 子会话/); assert.ok(!fx.includes("ses_fx6"), "零回显");
});

// ── 集成：产物写入自动登记（planner/reviewer/tester 等）────────────────
test("wf_write_artifact：wf/planner 子会话写 plan → 管辖状态自动登记 roleSessions", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const leader = "ses_lead";
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[M] reuse" } });
  await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} });
  // 子会话（独立 sessionID）写 plan → 登记到 leader 管辖状态
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: "ses_plannerChild", agent: "wf/planner" });
  const st = stOf(leader);
  assert.equal(st.roleSessions["wf/planner"].sessionID, "ses_plannerChild", "产物写入自动登记子会话");
  // 重委派点（回 planning 修订）guidance 渲染续用指引——零回显（T02）
  await cmd(m, "wf:review").execute({ sessionID: leader, prompt: {} });
  await tool(m).execute({ kind: "plan-review", content: "**结论**: FAIL\n问题" }, { sessionID: "ses_reviewerChild", agent: "wf/planner-reviewer" });
  const back = await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} });
  assert.ok(!String(back).includes("ses_plannerChild"), "回 planning 的 guidance 不得回显登记 sid");
  assert.match(String(back), /sessionID="auto"/, "指路别名续用");
  assert.equal(stOf(leader).roleSessions["wf/planner-reviewer"].sessionID, "ses_reviewerChild");
});

test("wf_write_artifact：leader 自写（wf/leader）不登记；同子会话重复写不改变登记", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const leader = "ses_lead2";
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[S] self" } });
  await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan" }, { sessionID: leader, agent: "wf/leader" });
  assert.equal(stOf(leader).roleSessions?.["wf/leader"], undefined, "leader 自写不登记");
  // 同一 planner 子会话重复写 → sessionID 不变
  await tool(m).execute({ kind: "plan", content: "# plan v2" }, { sessionID: "ses_p1", agent: "wf/planner" });
  await tool(m).execute({ kind: "plan", patch: [{ old: "v2", new: "v3" }] }, { sessionID: "ses_p1", agent: "wf/planner" });
  assert.equal(stOf(leader).roleSessions["wf/planner"].sessionID, "ses_p1");
});

// ── 集成：guard-hook 登记 builder/fixer（只改码不写产物）──────────────
test("guard-hook：wf/builder 子会话 edit（building 非阻断阶段）→ 登记；非 wf agent 不登记", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const leader = "ses_lead3";
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[M] build" } });
  await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: leader, prompt: {} });
  await tool(m).execute({ kind: "plan-review", content: "**结论**: PASS\n通过" }, { sessionID: "ses_reviewerB", agent: "wf/planner-reviewer" });
  // M16-r44：wf:build 关卡须方案确认（leader question 观察记账）
  await m.hook()({ tool: "question", sessionID: leader, agent: "workflow",
    input: { questions: [{ question: "方案确认", header: "方案确认", options: [{ label: "批准执行" }, { label: "修改方案" }, { label: "终止任务" }] }] } }, {});
  await cmd(m, "wf:build").execute({ sessionID: leader, prompt: {} }); // → building（非阻断；M 级过验证关卡+确认关卡）
  // builder 子会话改业务代码：building 放行，且登记其 sessionID
  await m.hook()({ tool: "edit", sessionID: "ses_builderChild", agent: "wf/builder", input: { path: `${DIR}/src/a.ts` } }, {});
  assert.equal(stOf(leader).roleSessions["wf/builder"].sessionID, "ses_builderChild", "builder edit 自动登记");
  // 非 wf agent（build）edit → 不登记
  await m.hook()({ tool: "edit", sessionID: "ses_buildAgent", agent: "build", input: { path: `${DIR}/src/b.ts` } }, {});
  assert.equal(stOf(leader).roleSessions?.["build"], undefined, "普通 agent 不登记");
  // 返工指引渲染续用指引（零回显，T02）
  await cmd(m, "wf:test").execute({ sessionID: leader, prompt: {} });
  await tool(m).execute({ kind: "test-report", content: "**结论**: FAIL\n缺陷" }, { sessionID: "ses_testerChild", agent: "wf/tester" });
  const rework = await cmd(m, "wf:fix").execute({ sessionID: leader, prompt: {} });
  assert.ok(!String(rework).includes("ses_builderChild"), "daily 返工 guidance 不得回显登记 sid");
  assert.match(String(rework), /sessionID="auto"/, "返工指路别名续用");
});

test("guard-hook：登记不干扰闸门——planning 阶段 wf/builder 越权 edit 仍被阻断，且登记照常", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const leader = "ses_lead4";
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[M] gate" } });
  await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} }); // → planning（阻断阶段）
  await assert.rejects(
    () => m.hook()({ tool: "edit", sessionID: "ses_builderChild", agent: "wf/builder", input: { path: `${DIR}/src/x.ts` } }, {}),
    (e) => /硬关卡：阶段「planning」/.test(String(e.message)),
    "越权 edit 仍被闸门阻断（登记不得吞掉关卡异常）",
  );
  assert.equal(stOf(leader).roleSessions["wf/builder"].sessionID, "ses_builderChild", "阻断前登记已落盘");
});

// ── wf:status 取证 ──────────────────────────────────────────────────
test("wf:status：输出含 roleSessions 行（真机续用取证；诊断命令非 guidance 渲染，登记 ID 显示保留）", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const leader = "ses_lead5";
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[M] status" } });
  await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan" }, { sessionID: "ses_pStatus", agent: "wf/planner" });
  const out = await cmd(m, "wf:status").execute({ sessionID: leader, prompt: {} });
  assert.match(out, /roleSessions:/);
  assert.match(out, /ses_pStatus/);
});
