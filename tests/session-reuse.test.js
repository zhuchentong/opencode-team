// M16-r40：会话复用可靠化（A 层）——角色→子会话自动登记 + guidance 重委派点渲染完整 ID。
// 根因：旧指引只说「续用上轮 sessionID」却不递 ID，leader 凭记忆复述长随机 ses_ 串→截断→
//   3 次重试→冷启动新建（真机实证）。修复：插件在子代理调 wf_write_artifact / edit 时自动捕获
//   其 sessionID（已验证 API：context.sessionID/agent、hook input.sessionID/agent），记入
//   st.roleSessions；guidance 在重委派点渲染完整 ID 供 leader 逐字复制。
// 覆盖：trackRoleSession 纯函数 / intake 重置清空 / guidance 渲染 / 产物写入登记 /
//   guard-hook builder 登记（非阻断阶段也登记、不干扰闸门、非 wf 不登记）/ wf:status 取证。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { trackRoleSession, evaluateTransition } from "../server/lib.ts";
import { guidance } from "../server/guidance.ts";

const DIR = "/tmp/opencode/wf-session-reuse";
const DB = `${DIR}/.workflow/wf.db`;
// mock 形状与 integration.test.js 同源（含 tool.hook 捕获，供 guard-hook 登记测试）
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

// ── guidance：重委派点渲染完整 ID ────────────────────────────────────
const rs = (agent, sid) => ({ [agent]: { sessionID: sid, at: "t" } });

test("guidance daily planning：有 planner 登记 → 渲染完整 ID+逐字复制；无登记 → 不渲染", () => {
  const withSess = guidance("planning", blank({ mode: "daily", size: "M", roleSessions: rs("wf/planner", "ses_plan123") }));
  assert.match(withSess, /ses_plan123/, "完整 sessionID 必须出现在指引");
  assert.match(withSess, /逐字复制/, "要求逐字复制");
  assert.match(withSess, /续用失败立即新建/, "失败立即新建，勿反复重试");
  const noSess = guidance("planning", blank({ mode: "daily", size: "M" }));
  assert.ok(!/sessionID=ses_/.test(noSess), "首次委派无登记 → 不渲染 ID");
  // S 级零 sub-agent：不渲染委派续用
  const s = guidance("planning", blank({ mode: "daily", size: "S", roleSessions: rs("wf/planner", "ses_plan123") }));
  assert.ok(!/ses_plan123/.test(s), "S 级不委派，不渲染 planner 续用");
});

test("guidance daily review r≥2：渲染 reviewer 完整 ID；r1 不渲染", () => {
  const r2 = guidance("review", blank({ mode: "daily", size: "M", rounds: { plan_review: 2, build_review: 0, test_fix: 0 }, roleSessions: rs("wf/planner-reviewer", "ses_rev456") }));
  assert.match(r2, /ses_rev456/);
  const r1 = guidance("review", blank({ mode: "daily", size: "M", rounds: { plan_review: 1, build_review: 0, test_fix: 0 }, roleSessions: rs("wf/planner-reviewer", "ses_rev456") }));
  assert.ok(!/ses_rev456/.test(r1), "r1 非增量复审，不渲染续用");
});

test("guidance daily building：builder 登记 → 渲染完整 ID（返工续用）", () => {
  const b = guidance("building", blank({ mode: "daily", size: "M", rounds: { plan_review: 1, build_review: 0, test_fix: 1 }, roleSessions: rs("wf/builder", "ses_build789") }));
  assert.match(b, /ses_build789/);
});

test("guidance full：planning/review r2/test_design/build_review/fixing 各重委派点渲染对应 ID", () => {
  const p = guidance("planning", blank({ mode: "full", roleSessions: rs("wf/planner", "ses_fp1") }));
  assert.match(p, /ses_fp1/);
  const rv = guidance("review", blank({ mode: "full", rounds: { plan_review: 2, build_review: 0, test_fix: 0 }, roleSessions: rs("wf/planner-reviewer", "ses_fr2") }));
  assert.match(rv, /ses_fr2/);
  const td = guidance("test_design", blank({ mode: "full", roleSessions: rs("wf/tester", "ses_ft3") }));
  assert.match(td, /ses_ft3/);
  const br = guidance("build_review", blank({ mode: "full", roleSessions: { ...rs("wf/builder", "ses_fb4"), ...rs("wf/builder-reviewer", "ses_fbr5") } }));
  assert.match(br, /ses_fb4/);
  assert.match(br, /ses_fbr5/);
  const fx = guidance("fixing", blank({ mode: "full", rounds: { plan_review: 1, build_review: 1, test_fix: 1 }, roleSessions: rs("wf/builder", "ses_fx6") }));
  assert.match(fx, /ses_fx6/);
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
  // 重委派点（回 planning 修订）guidance 渲染该完整 ID
  await cmd(m, "wf:review").execute({ sessionID: leader, prompt: {} });
  await tool(m).execute({ kind: "plan-review", content: "**结论**: FAIL\n问题" }, { sessionID: "ses_reviewerChild", agent: "wf/planner-reviewer" });
  const back = await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} });
  assert.match(back, /ses_plannerChild/, "回 planning 的 guidance 渲染 planner 完整 ID");
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
  // 返工指引渲染 builder 完整 ID
  await cmd(m, "wf:test").execute({ sessionID: leader, prompt: {} });
  await tool(m).execute({ kind: "test-report", content: "**结论**: FAIL\n缺陷" }, { sessionID: "ses_testerChild", agent: "wf/tester" });
  const rework = await cmd(m, "wf:fix").execute({ sessionID: leader, prompt: {} });
  assert.match(rework, /ses_builderChild/, "daily 返工 building guidance 渲染 builder 完整 ID");
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
test("wf:status：输出含 roleSessions 行（真机续用取证）", async () => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  const leader = "ses_lead5";
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[M] status" } });
  await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "# plan" }, { sessionID: "ses_pStatus", agent: "wf/planner" });
  const out = await cmd(m, "wf:status").execute({ sessionID: leader, prompt: {} });
  assert.match(out, /roleSessions:/);
  assert.match(out, /ses_pStatus/);
});