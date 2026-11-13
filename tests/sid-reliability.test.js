// M16-r45：会话 ID 零转录续接 + skill 托管同步——
// 覆盖：resolveSidAlias 全分支 / isNearTruncation 边界 / completeSidPrefix / diagnose 续接自愈取证 /
//       guard-hook 别名改写（含 loud-fail）/ 近似截断纠正（含不误纠放行）/ lane set 补全+存在性拒绝+别名 /
//       skills.ts 同步（create/skip/write/unmanaged/backup）/ registerSkillSync 默认开与显式关 / 内容锚。
// mock 形状与 session-guard.test.js / roles.test.js 同源；全部副作用限 /tmp/opencode/wf-sid-r45。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
// T04：装配收敛 helpers/host-stub
import { mkHostStub } from "./helpers/host-stub.js";
import {
  SID_ALIAS_AUTO, SID_ALIAS_USAGE, resolveSidAlias, completeSidPrefix, isNearTruncation, diagnoseReport,
} from "../server/lib.ts";
import {
  renderSkill, parseSkillMarker, skillSyncDecision, syncSkills, registerSkillSync,
} from "../server/skills.ts";
import { renderRole } from "../server/roles.ts";

const ROOT = "/tmp/opencode/wf-sid-r45";

// ── 纯函数：resolveSidAlias（零转录别名协议）────────────────────────
const RS = { "wf/planner": { sessionID: "ses_planFull123", at: "t" }, "wf/tester": { sessionID: "ses_test456xyz", at: "t" } };
const LANES = { T01: { sessionID: "ses_lane001abc", worktree: null, at: "t" } };

test("alias：auto → 该角色唯一登记解析", () => {
  const r = resolveSidAlias("auto", { role: "wf/planner", roleSessions: RS, lanes: {} });
  assert.deepEqual(r, { ok: true, sid: "ses_planFull123", via: "role:wf/planner" });
});

test("alias：auto + lanes 非空 → 拒绝并强制 @Tnn（多 lane 防静默分叉）", () => {
  const r = resolveSidAlias(SID_ALIAS_AUTO, { role: "wf/planner", roleSessions: RS, lanes: LANES });
  assert.equal(r.ok, false);
  assert.match(r.reason, /@Tnn/);
  assert.deepEqual(r.candidates, ["T01"]);
});

test("alias：auto + 目标角色无登记 → loud-fail（含新建指路；其他角色登记不顶替）", () => {
  const r = resolveSidAlias("auto", { role: "wf/builder", roleSessions: RS, lanes: {} });
  assert.equal(r.ok, false);
  assert.match(r.reason, /新建/);
});

test("alias：@Tnn → lanes 反查；@role 与 @短名 → roleSessions 反查（wf/ 前缀容错）", () => {
  assert.equal(resolveSidAlias("@T01", { roleSessions: RS, lanes: LANES }).sid, "ses_lane001abc");
  assert.equal(resolveSidAlias("@wf/planner", { roleSessions: RS, lanes: {} }).sid, "ses_planFull123");
  assert.equal(resolveSidAlias("@planner", { roleSessions: RS, lanes: {} }).sid, "ses_planFull123");
});

test("alias：未命中 → 失败并列可用键；非别名/空串 → 失败", () => {
  const r = resolveSidAlias("@nope", { roleSessions: RS, lanes: LANES });
  assert.equal(r.ok, false);
  assert.deepEqual(r.candidates, ["T01", "wf/planner", "wf/tester"]);
  assert.equal(resolveSidAlias("ses_x", { roleSessions: RS, lanes: {} }).ok, false);
  assert.equal(resolveSidAlias("", { roleSessions: RS, lanes: {} }).ok, false);
});

// ── 纯函数：isNearTruncation / completeSidPrefix ────────────────────
const FULLID = "ses_abcdefghijklmnopqrst"; // 24 字符；60% 阈值=15
test("near：尾部单字符错位 → true；中间偏早错位/大段截断/全然不同/equal → false", () => {
  assert.equal(isNearTruncation("ses_abcdefghijklmnopqrsX", FULLID), true, "公共前缀 23≥15、距离 1");
  assert.equal(isNearTruncation("ses_abcdefghijklmno", FULLID), false, "纯截断 5 位（pqrst）：距离 5 > 4（阈值锚）");
  assert.equal(isNearTruncation("ses_Xbcdefghijklmnopqrst", FULLID), false, "公共前缀 4 < 60%（不误纠）");
  assert.equal(isNearTruncation("ses_zzzzzzzzzzzzzzzzzzzz", FULLID), false);
  assert.equal(isNearTruncation(FULLID, FULLID), false);
  assert.equal(isNearTruncation("", FULLID), false);
});

test("prefix：exact / completed / ambiguous / unknown 四态", () => {
  assert.deepEqual(completeSidPrefix("ses_planFull123", ["ses_planFull123"]), { kind: "exact", sid: "ses_planFull123" });
  assert.deepEqual(completeSidPrefix("ses_planFull", ["ses_planFull123", "ses_test456xyz"]), { kind: "completed", sid: "ses_planFull123" });
  const amb = completeSidPrefix("ses_plan", ["ses_planFull123", "ses_planFull456"]);
  assert.equal(amb.kind, "ambiguous");
  assert.deepEqual(amb.candidates, ["ses_planFull123", "ses_planFull456"]);
  assert.equal(completeSidPrefix("ses_ghost", ["ses_planFull123"]).kind, "unknown");
  assert.equal(completeSidPrefix("garbage", ["ses_planFull123"]).kind, "unknown");
  assert.equal(completeSidPrefix("ses_", ["ses_planFull123"]).kind, "unknown", "形状不全不补全");
});

// ── diagnoseReport：续接自愈取证（M16-r45 可观测性）─────────────────
test("diagnose：session:correct 累计与 fuzzy 细分；无记录不渲染", () => {
  const st1 = { sessionID: "s", slug: "t", phase: "building", rounds: {}, log: [
    { at: "", cmd: "session:correct", note: "corrected", ok: false },
    { at: "", cmd: "session:correct", note: "corrected-fuzzy", ok: false },
    { at: "", cmd: "wf:plan", ok: true },
  ] };
  const out1 = diagnoseReport(st1);
  assert.match(out1, /session:correct）×2/);
  assert.match(out1, /近似匹配 1/);
  const out2 = diagnoseReport({ sessionID: "s", slug: "t", phase: "building", rounds: {}, log: [{ cmd: "wf:plan", ok: true }] });
  assert.ok(!out2.includes("session:correct"));
});

// ── guard-hook：别名改写 + 近似截断（mock 同源 session-guard.test.js）──
const DIR = `${ROOT}/guard`;
const DB = `${DIR}/.workflow/wf.db`;
const FULL = "ses_planFull123"; // 15 字符；60% 阈值=9
const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const entries = [];
  let hookFn = null;
  // T04：装配收敛 helpers/host-stub（ses_ghost 不存在形态=sessions.get 覆盖；skill 同步隔离 skillsDir）
  const host = mkHostStub({
    options: { probe: false, skillsDir: `${ROOT}/skills-guard` }, // skill 同步隔离到临时目录
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async (q = {}) => (String(q?.sessionID ?? "") === "ses_ghost" ? null : { projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) },
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
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(`${DIR}/src`, { recursive: true });

// 建 leader 任务并经 A 层登记 wf/planner 子会话（完整 ID=ses_planFull123）
const setupLeader = async (leader) => {
  const m = mkCtx(); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: leader, prompt: { text: "[M] sid-r45" } });
  await cmd(m, "wf:plan").execute({ sessionID: leader, prompt: {} }); // → planning
  await tool(m).execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: FULL, agent: "wf/planner" });
  return m;
};
const callSub = (m, leader, input, callerAgent = "workflow") =>
  m.hook()({ tool: "subagent", sessionID: leader, agent: callerAgent, input }, {});

test("r45-A：auto → 服务端解析就地改写 input.input.sessionID（零转录）+ 审计 session:alias", async () => {
  const leader = "ses_r45a1"; const m = await setupLeader(leader);
  const input = { agent: "wf/planner", sessionID: "auto" };
  await callSub(m, leader, input);
  assert.equal(input.sessionID, FULL, "入参应被改写为登记完整 ID");
  const st = stOf(leader);
  assert.ok((st.log ?? []).some((e) => e.cmd === "session:alias" && e.note === "aliased"), "审计应记 session:alias");
});

test("r45-A：@wf/planner → roleSessions 反查改写", async () => {
  const leader = "ses_r45a2"; const m = await setupLeader(leader);
  const input = { agent: "wf/planner", sessionID: "@wf/planner" };
  await callSub(m, leader, input);
  assert.equal(input.sessionID, FULL);
});

test("r45-A：auto 无登记 → loud-fail（GATE_ERR + 新建指路，不静默新建）", async () => {
  const leader = "ses_r45a3"; const m = await setupLeader(leader);
  await assert.rejects(
    () => callSub(m, leader, { agent: "wf/builder", sessionID: "auto" }),
    (e) => { const msg = String(e?.message ?? e); return msg.includes("[wf-workflow]") && /别名续接失败/.test(msg) && /新建/.test(msg); },
  );
});

test("r45-A：auto + lanes 非空 → loud-fail 指路 @Tnn", async () => {
  const leader = "ses_r45a4"; const m = await setupLeader(leader);
  await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: `set T01 ${FULL}` } });
  await assert.rejects(
    () => callSub(m, leader, { agent: "wf/planner", sessionID: SID_ALIAS_AUTO }),
    (e) => { const msg = String(e?.message ?? e); return msg.includes("[wf-workflow]") && /T01/.test(msg); },
  );
});

test("T03/r45-B：尾部单字符错位（形状合法非前缀）→ 拒绝但零回显，审计 corrected-fuzzy 保留", async () => {
  const leader = "ses_r45b1"; const m = await setupLeader(leader);
  const bad = `${FULL.slice(0, -1)}X`; // 尾字符替换：公共前缀 14/15≥9、距离 1
  await assert.rejects(
    () => callSub(m, leader, { agent: "wf/planner", sessionID: bad }),
    (e) => { const msg = String(e?.message ?? e); return msg.includes("[wf-workflow]") && !msg.includes(FULL) && /近似/.test(msg); },
  );
  const st = stOf(leader);
  assert.ok((st.log ?? []).some((e) => e.cmd === "session:correct" && e.note === "corrected-fuzzy"));
});

test("r45-B：早期错位（公共前缀 <60%）→ 放行宿主归属校验（不误纠）", async () => {
  const leader = "ses_r45b2"; const m = await setupLeader(leader);
  const earlyBad = "ses_XlanFull123"; // 公共前缀 4 < 9
  await callSub(m, leader, { agent: "wf/planner", sessionID: earlyBad }); // 不抛 = 放行
});

// ── wf:lane set：前缀补全 / 存在性拒绝 / @别名 ──────────────────────
test("r45-C：lane set 前缀唯一 → 自动补全入库", async () => {
  const leader = "ses_r45c1"; const m = await setupLeader(leader);
  const out = await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: "set T01 ses_planFull" } });
  assert.match(String(out), /前缀补全 ses_planFull → ses_planFull123/);
  assert.equal(stOf(leader).lanes.T01.sessionID, FULL);
});

test("r45-C：lane set 未知 ID（宿主查无）→ 拒绝入库，lane 未变更", async () => {
  const leader = "ses_r45c2"; const m = await setupLeader(leader);
  const out = await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: "set T01 ses_ghost" } });
  assert.match(String(out), /子会话不存在/);
  assert.equal((stOf(leader).lanes ?? {}).T01, undefined);
});

test("r45-C：lane set @别名（role 键与 lane 键）→ 解析入库", async () => {
  const leader = "ses_r45c3"; const m = await setupLeader(leader);
  await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: `set T00 ${FULL}` } });
  const out = await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: "set T01 @wf/planner" } });
  assert.match(String(out), /别名 @wf\/planner → ses_planFull123/);
  const out2 = await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: "set T02 @T00" } });
  assert.match(String(out2), /别名 @T00 → ses_planFull123/);
});

test("r45-C：lane set auto（无目标角色语义）→ 解析失败拒绝", async () => {
  const leader = "ses_r45c4"; const m = await setupLeader(leader);
  const out = await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: "set T01 auto" } });
  assert.match(String(out), /别名解析失败/);
});

test("T03/r45-C：lane set 前缀命中多个登记会话 → 拒绝且零回显（指路 @别名）", async () => {
  const leader = "ses_r45c5"; const m = await setupLeader(leader);
  await tool(m).execute({ kind: "plan", content: "# plan T02" }, { sessionID: "ses_planFull456", agent: "wf/tester" }); // 第二登记，与 FULL 共享 "ses_plan" 前缀
  const out = String(await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: "set T01 ses_plan" } }));
  assert.match(out, /前缀命中多个登记会话/);
  assert.match(out, /别名区分/);
  assert.ok(!out.includes(FULL) && !out.includes("ses_planFull456"), "不回显 candidates 登记 ID（wf:lane 返回值直进模型上下文）");
});

test("T03/r45-C：lane set 未知 ID 拒绝文案指路 session-lookup 管道（旧「重取完整 ID」措辞已拆）", async () => {
  const leader = "ses_r45c6"; const m = await setupLeader(leader);
  const out = String(await cmd(m, "wf:lane").execute({ sessionID: leader, prompt: { text: "set T01 ses_ghost" } }));
  assert.match(out, /session-lookup 管道/);
  assert.ok(!out.includes("重取完整"), "转录诱导措辞已拆");
});

// ── skills.ts：托管同步（临时目录）──────────────────────────────────
const HOST = `${ROOT}/skills-host`;
test("r45-D：syncSkills create → frontmatter 居首 + 末行标记；二次 skip", () => {
  fs.rmSync(HOST, { recursive: true, force: true });
  const r1 = syncSkills(HOST);
  assert.deepEqual(r1, [{ id: "session-lookup", action: "create" }, { id: "wf-worktrees", action: "create" }]); // P0-E：+wf-worktrees
  const file = `${HOST}/session-lookup/SKILL.md`;
  const c1 = fs.readFileSync(file, "utf8");
  assert.equal(c1.startsWith("---"), true, "frontmatter 必须居首（托管标记在末行）");
  const mk = parseSkillMarker(c1);
  assert.ok(mk, "末行应为托管标记");
  assert.equal(mk.id, "session-lookup");
  assert.equal(skillSyncDecision(c1, renderSkill("session-lookup")), "skip");
  assert.equal(syncSkills(HOST)[0].action, "skip", "hash 同跳过");
});

test("r45-D：内容漂移 → write + 备份 + 还原；无标记 → unmanaged 不覆盖", () => {
  const file = `${HOST}/session-lookup/SKILL.md`;
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  const drifted = `${lines.slice(0, -1).join("\n").replace("## 铁律", "## 铁律X")}\n${lines[lines.length - 1]}\n`;
  fs.writeFileSync(file, drifted);
  assert.equal(syncSkills(HOST)[0].action, "write");
  assert.ok(fs.readdirSync(`${HOST}/session-lookup`).some((f) => f.startsWith("SKILL.md.bak-")), "写前应有备份");
  assert.equal(fs.readFileSync(file, "utf8"), renderSkill("session-lookup"), "漂移内容应被还原");
  fs.writeFileSync(file, "---\nname: x\n---\n自定义内容\n");
  assert.equal(syncSkills(HOST)[0].action, "unmanaged");
  assert.match(fs.readFileSync(file, "utf8"), /自定义内容/);
});

test("r45-D：registerSkillSync 默认开启；syncSkills:false 显式关闭", () => {
  const d1 = `${ROOT}/skills-on`;
  registerSkillSync(mkHostStub(), { skillsDir: d1 });
  assert.ok(fs.existsSync(`${d1}/session-lookup/SKILL.md`), "默认应同步落盘");
  const d2 = `${ROOT}/skills-off`;
  registerSkillSync(mkHostStub(), { syncSkills: false, skillsDir: d2 });
  assert.ok(!fs.existsSync(`${d2}/session-lookup/SKILL.md`), "显式关闭不得写盘");
});

// ── 内容锚：别名语法/路由行/唯一性纪律（防文案漂移丢行）+ T03 燃料清除 ────
test("r45-E：内容锚——skill 管道纪律；leader 别名契约与 Session 查询路由行；托管文案零回显燃料", () => {
  const skill = renderSkill("session-lookup");
  assert.match(skill, /不唯一，请加长/);
  assert.match(skill, /xargs -r/);
  assert.match(skill, /与 wf 插件的边界/);
  assert.match(skill, /sessionID="auto"/);
  assert.ok(!skill.includes("仍兼容逐字复制"), "SKILL.md 渲染 guidance 完整 ID 的引导已拆（:51 管道纪律除外）");
  const leader = renderRole("leader");
  assert.match(leader, /Session 查询路由/);
  assert.match(leader, /session-lookup/);
  assert.match(leader, /sessionID="auto"/);
  assert.match(leader, /@Tnn/);
  assert.ok(!leader.includes("逐字复制"), "leader.md 逐字复制引导已拆");
  assert.ok(!leader.includes("完整 sessionID") && !leader.includes("完整 ID"), "leader.md 完整 ID 回显引导已拆");
  assert.ok(SID_ALIAS_USAGE.includes("auto"), "别名用法常量同源");
  assert.ok(SID_ALIAS_USAGE.includes(`sessionID="auto"`) && SID_ALIAS_USAGE.includes("@Tnn"), "常量保留三锚子串（C1）");
  assert.ok(SID_ALIAS_USAGE.includes("无 lane 登记"), "常量新语义：auto 默认单会话形态即生效");
});
