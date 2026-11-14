// selfmod-concurrency-guard：引擎自改并发护栏 + daily 修订路径收敛（A2）+ 派发策略绑 size（A3）。
// 背景（双任务日志实证）：notification-brief-display 在插件仓库分步 edit 入口文件时，热载的中间态
// 被同进程 dso-app 在途会话真实执行（其 wf.db 被静默 ALTER）。v1 进程内存注册表有两处盲区
// （implant×build 卡死 1.5 天 + 多日 resume 习惯取证）：①休眠任务不可见；②热载清零=静默失明（I-1）。
// v2 = PROJECT_DBS 内存 ∪ 持久项目清单跨库扫描 + updatedAt 活跃/休眠分级。
// 隔离钩子：WF_PROJECTS_FILE 显式设置 → 扫描只读该文件、注册不落文件（测试确定性）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { isSelfModDir, selfModWarnLine, evaluateTransition, FLOWS, FLOWS_DAILY } from "../server/lib.ts";
import { guidance } from "../server/guidance.ts";
import { createStore, scanActiveTasks, projectsListFile } from "../server/state.ts";
// T04：装配收敛 helpers/host-stub
import { mkHostStub } from "./helpers/host-stub.js";

const DIR = "/tmp/opencode/wf-selfmod";
const DB = `${DIR}/.workflow/wf.db`;
const PROJ2 = "/tmp/opencode/wf-selfmod-proj2";
process.env.WF_PROJECTS_FILE = `${DIR}/projects.jsonl`;
const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`, projectsListFile()]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const entries = [];
  let hookFn = null;
  // T04：装配收敛 helpers/host-stub（tools/cmds=stub 注册捕获数组；探测根=selfModRoot 注入）
  const host = mkHostStub({
    options: { probe: false, selfModRoot: DIR }, // 注入探测根=任务目录 → 恒判自改
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) },
    instructions: { put: async (i) => { entries.push(i); }, list: async () => entries },
    tools: { hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
  });
  return { ctx: host._ctx, tools: host._toolDefs, cmds: host._cmdDefs, entries, hook: () => hookFn };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
import { withVerdicts } from "./helpers/state-fixture.js";
const blank = (over = {}) => withVerdicts({ slug: "t", phase: null, rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, artifacts: {}, lanes: {}, ...over }); // R3 T3.1：平铺键→子对象
// 第二项目库（模拟休眠/活跃的其它任务）：直接 createStore 建真库，清单行手工 append（env 模式=只读清单）
const mkProj = async (dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
  const s = createStore(mkHostStub({
    location: { directory: dir },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async () => ({ projectID: "pi2", agent: "wf/leader", location: { directory: dir } }) },
  }));
  await s.ready;
  return s;
};
const listProj = (dir) => fs.appendFileSync(projectsListFile(), JSON.stringify({ dir, dbFile: `${dir}/.workflow/wf.db` }) + "\n");

// ── A1 纯函数 ─────────────────────────────────────────────────────────
test("A1 isSelfModDir：尾斜杠归一相等判自改；任一侧空=false（fail-open 不误报）", () => {
  assert.equal(isSelfModDir("/a/b", "/a/b"), true);
  assert.equal(isSelfModDir("/a/b/", "/a/b"), true);
  assert.equal(isSelfModDir("/a/b", "/a/b/"), true);
  assert.equal(isSelfModDir("/a/b", "/a/c"), false);
  assert.equal(isSelfModDir("", "/a/b"), false);
  assert.equal(isSelfModDir("/a/b", ""), false);
  assert.equal(isSelfModDir(null, "/a/b"), false);
});

test("A1 v2 selfModWarnLine：空=null；⚠️ 前缀非 ❌；活跃/休眠分级+处置出口；无日期保守休眠；>5 折叠", () => {
  assert.equal(selfModWarnLine([]), null);
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  const iso = (ms) => new Date(ms).toISOString();
  const one = selfModWarnLine([{ slug: "live-task", phase: "building", directory: "/x", updatedAt: iso(now - 3600e3) }], now);
  assert.ok(one.startsWith("⚠️"), "⚠️ 前缀=成功轨告警");
  assert.ok(!one.includes("❌"), "不含 ❌（REJECT_PREFIX 不变量互斥）");
  assert.match(one, /live-task·building（活跃）/);
  assert.match(one, /引擎自改护栏/);
  const dorm = selfModWarnLine([{ slug: "dormant-task", phase: "testing", directory: "/y", updatedAt: iso(now - 3 * 86400e3) }], now);
  assert.match(dorm, /dormant-task·testing（休眠≥3天未更新，最后 11-10/);
  assert.match(dorm, /可能已废弃/);
  assert.match(dorm, /\/wf:reset 清账/, "休眠处置出口并列给出");
  const undated = selfModWarnLine([{ slug: "u", phase: "review", directory: "/z", updatedAt: "x" }], now);
  assert.match(undated, /u·review（休眠，日期未知）/, "updatedAt 解析失败保守归休眠");
  const six = selfModWarnLine(Array.from({ length: 6 }, (_, i) => ({ slug: `t${i}`, phase: "review", directory: "/x", updatedAt: iso(now - i * 3600e3) })), now);
  assert.match(six, /6 个/); assert.match(six, / 等/);
  assert.ok(!/t5/.test(six), "第 6 项折叠不进清单");
});

test("A1 v2 scanActiveTasks：跨库 is_active=1；自身排除；done/无 slug/幽灵防御过滤；坏库与缺失条目跳过；updatedAt 带出+降序", async () => {
  const s2 = await mkProj(PROJ2);
  await s2.save({ sessionID: "s_d", slug: "dormant-task", phase: "testing", rounds: {}, log: [] });
  await s2.save({ sessionID: "s_l", slug: "live-task", phase: "building", rounds: {}, log: [] });
  await s2.save({ sessionID: "s_x", slug: "finished", phase: "done", rounds: {}, log: [] });
  await s2.save({ sessionID: "s_n", slug: "", phase: "intake", rounds: {}, log: [] });
  {
    const d = new Database(`${PROJ2}/.workflow/wf.db`);
    d.run("UPDATE tasks SET updated_at = ? WHERE session_id = 's_d'", new Date(Date.now() - 3 * 86400e3).toISOString());
    d.run("INSERT INTO tasks (session_id, slug, phase, is_active, rev, state_json) VALUES ('s_g', '', NULL, 1, 1, ?)", "{}");
    d.close();
  }
  listProj(PROJ2);
  fs.appendFileSync(projectsListFile(), JSON.stringify({ dir: "/nope", dbFile: "/nope/.workflow/wf.db" }) + "\n"); // 条目对应库不存在 → 跳过
  fs.writeFileSync(`${PROJ2}/junk.db`, "not a database at all");
  fs.appendFileSync(projectsListFile(), JSON.stringify({ dir: `${PROJ2}/junk`, dbFile: `${PROJ2}/junk.db` }) + "\n"); // 坏库 → 跳过不抛
  const rows = scanActiveTasks("s_self");
  const slugs = rows.map((r) => r.slug);
  assert.ok(slugs.includes("dormant-task"), "休眠任务现形（v1 内存注册表盲区）");
  assert.ok(slugs.includes("live-task"));
  assert.ok(!slugs.includes("finished"), "done 行不出现");
  assert.ok(!slugs.includes(""), "无 slug 行防御过滤");
  assert.equal(rows[0].slug, "live-task", "updatedAt 降序（活跃在前）");
  const dorm = rows.find((r) => r.slug === "dormant-task");
  assert.equal(dorm.updatedAt.slice(0, 10), new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10), "updatedAt 原样带出");
  const rows2 = scanActiveTasks("s_l");
  assert.ok(!rows2.some((r) => r.slug === "live-task"), "自身会话行排除");
  s2.close();
});

test("A1 v2 intake 接线：自改命中 → st.selfMod 记账 + ⚠️ 分级告警（休眠任务现形）", async () => {
  const s2 = await mkProj(PROJ2);
  await s2.save({ sessionID: "s_d", slug: "dormant-task", phase: "testing", rounds: {}, log: [] });
  {
    const d = new Database(`${PROJ2}/.workflow/wf.db`);
    d.run("UPDATE tasks SET updated_at = ? WHERE session_id = 's_d'", new Date(Date.now() - 2 * 86400e3).toISOString());
    d.close();
  }
  s2.close();
  const m = mkCtx(); // mkCtx 清空清单 → setup 后再登记 PROJ2（env 模式=扫描只读清单，内存表不参与）
  await plugin.setup(m.ctx);
  listProj(PROJ2);
  const out = await cmd(m, "wf:intake").execute({ sessionID: "ses_sm", prompt: { text: "[M] self-mod-task" } });
  assert.match(out, /⚠️ 引擎自改护栏/, "intake 输出追加告警");
  assert.match(out, /dormant-task·testing/, "清单含休眠任务");
  assert.match(out, /休眠/, "分级措辞=休眠非活跃（时间账来自 updated_at 列）");
  assert.equal(stOf("ses_sm").delivery?.selfMod, true, "st.selfMod 持久化记账"); // R3 T3.1 子步 D
});

test("A1 v2 intake 负例：清单空=零打扰仍记自改账；探测根不匹配=无告警无记账且清残留", async () => {
  const m = mkCtx();
  await plugin.setup(m.ctx);
  const out = await cmd(m, "wf:intake").execute({ sessionID: "ses_e", prompt: { text: "[M] empty" } });
  assert.ok(!out.includes("引擎自改护栏"), "无其它任务=零告警打扰");
  assert.equal(stOf("ses_e").delivery?.selfMod, true, "自改命中仍记账");
  m.ctx.options.selfModRoot = "/tmp/not-matching-root";
  await cmd(m, "wf:intake").execute({ sessionID: "ses_e", prompt: { text: "! [M] normal" } });
  assert.equal(stOf("ses_e").delivery?.selfMod, undefined, "非自改 intake 清除残留记账");
});

test("A1 intake 重置块清 selfMod（done→新任务重算）", () => {
  const st = blank({ phase: "done", slug: "old", selfMod: true });
  assert.ok(evaluateTransition("wf:intake", st, "new-task").ok);
  assert.equal(st.delivery?.selfMod, undefined, "新任务不得继承旧自改记账");
});

test("A1 building guidance 自改纪律行（st.selfMod 门控，非自改字节级不变；休眠处置指路）", () => {
  const g = guidance("building", blank({ mode: "daily", size: "M", selfMod: true })); // 平铺键经 withVerdicts→delivery 翻译
  assert.match(g, /引擎自改模式/);
  assert.match(g, /禁.*连续 edit|禁分步连续 edit/, "入口文件编辑纪律进 entry 通道（抗 compaction）");
  assert.match(g, /休眠任务先核实/, "v2：休眠任务处置指路在纪律行");
  const plain = guidance("building", blank({ mode: "daily", size: "M" }));
  assert.ok(!plain.includes("引擎自改模式"), "无记账=零渲染");
});

// ── A2 daily 修订路径收敛 ─────────────────────────────────────────────
test("A2 FLOWS_DAILY wf:review 唯一来源 planning（review→review 复审边移除）", () => {
  assert.deepEqual(FLOWS_DAILY["wf:review"].from, ["planning"]);
  const st = blank({ mode: "daily", phase: "review", rounds: { plan_review: 1, build_review: 0, test_fix: 0 } });
  const r = evaluateTransition("wf:review", st, "");
  assert.equal(r.ok, false); assert.equal(r.note, "illegal-transition", "daily 直推复审被机制拒绝");
  assert.equal(st.rounds.plan_review, 1, "拒绝不消耗额度");
  // full 模式不受影响（在途兼容）
  assert.ok(FLOWS["wf:review"].from.includes("review"));
});

test("A2 daily review FAIL 指引=唯一返修路径（wf:plan→wf:review）", () => {
  assert.match(guidance("review", blank({ mode: "daily", size: "M" })), /唯一返修路径/);
  assert.match(guidance("review", blank({ mode: "daily", size: "S" })), /唯一返修路径/);
});

// ── A3 派发策略绑 size（v2 并行优先：M/L 均先判并行，串行=例外须举证）──
test("A3 daily building 派发策略绑 size：M/L 并行优先（lane 表驱动），串行=例外须举证", () => {
  const l = guidance("building", blank({ mode: "daily", size: "L" }));
  assert.match(l, /并行优先/, "L 并行优先"); assert.match(l, /每批 ≤4/, "L 批次粒度写死"); assert.match(l, /worktree/, "L worktree 隔离");
  assert.match(l, /串行.*例外|互斥证据不足/, "L 串行=例外路径");
  const m2 = guidance("building", blank({ mode: "daily", size: "M" }));
  assert.match(m2, /并行优先/, "M 并行优先（反转旧「M 串行到底」默认）");
  assert.match(m2, /lane 分组表.*判并行|lane≥2/, "M 走 lane 表并行授权");
  assert.match(m2, /一次委派串行到底/, "M 收益线未达/单 lane 时仍串行到底");
  assert.match(m2, /串行判定=plan 须举证/, "M 串行须举证非默认");
  assert.ok(!m2.match(/每批 ≤4/), "M 不分批（分批仍 L 专属）");
});

test("D daily intake 指引：question 批量优先 + 需求基线 baseline.md + gitignore 口径（.learnings 默认 ignore，M16-r52 F4 翻转）", () => {
  const g = guidance("intake", blank({ mode: "daily", size: "M" }));
  assert.match(g, /批量优先/, "澄清批量化");
  assert.match(g, /baseline\.md/, "需求基线落盘");
  assert.match(g, /\.gitignore 含 \.workflow\/ 与 \.learnings\//, "M16-r52：gitignore 同时要求两目录");
  assert.match(g, /agent 生成目录默认不入库/, "F4 翻转口径：默认 ignore");
  assert.match(g, /显式删 \.learnings\/ 的 ignore 行/, "入库=显式开启路径在位");
  assert.ok(!/默认入库随交付提交/.test(g), "不得残留旧「默认入库」口径");
});
