// T04（arch-r1-host-split）：tests/helpers/ 装配同源守卫。
// 判据：①helpers 四文件与冻结 API 在位；②默认语义逐条（plan 冻结注释=缺省表）；③mkStoreStub CAS
// 语义与 state.ts 契约同源（stale-rev/rev 递增/structuredClone 隔离）；④mkWiringHarness 端到端可驱动
// 状态机；⑤装配收敛：引用 helpers 的测试文件 ≥16（旧 16 内联 mock 全数收敛）；⑥断言不动纪律的
// 反向锚：helpers 不得触碰 WF_PROJECTS_FILE（红线 7）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { LIMITS } from "../server/lib.ts";
import { mkHostStub } from "./helpers/host-stub.js";
import { mkStoreStub } from "./helpers/store-stub.js";
import { mkCommandDeps } from "./helpers/command-deps.js";
import { mkWiringHarness } from "./helpers/wiring.js";

test("T04 mkHostStub 缺省表：降级轨/记录面/注册面（plan 冻结语义）", () => {
  const host = mkHostStub();
  assert.deepEqual(host.options, {}, "options 缺省 {}");
  assert.equal(typeof host.location.directory, "string", "location 缺省有目录（临时根，不落真实仓库）");
  const h = host;
  assert.doesNotThrow(() => { void h; });
  // 同步面
  assert.equal(host.chatMessages(async () => {}), null, "chatMessages 缺省→null（无真注册器形态）");
  assert.deepEqual(host.notifications, [], "notifications 记录面在位");
  host.notify("info", "m1"); host.notify("warn", "m2");
  assert.deepEqual(host.notifications, [{ level: "info", msg: "m1" }, { level: "warn", msg: "m2" }], "notify 记录");
  const reg = host.tools.hook("execute.before", () => {});
  assert.equal(typeof reg.dispose, "function", "tools.hook 缺省→{dispose}");
  const ct = host.commands.transform(() => {});
  assert.equal(typeof ct.dispose, "function", "commands.transform 注册即回调+{dispose}");
  assert.equal(host.tools.transform(() => {}) && "ok", "ok");
  assert.throws(() => host.rpc.client({}), "rpc.client 缺省=throwing stub");
  // 异步面
  return (async () => {
    assert.equal(await host.sessions.get({ sessionID: "s" }), null, "sessions.get 缺省→null");
    assert.equal(await host.sessions.wait({ sessionID: "s" }), undefined, "wait→resolved");
    assert.notEqual(await host.sessions.prompt({}), undefined, "prompt→resolved");
    assert.equal(await host.sessions.hook("context", () => {}), null, "hook 缺省→null");
    assert.deepEqual(await host.instructions.put({ key: "k", value: "v" }), {}, "instructions.*→{}");
    assert.deepEqual(await host.instructions.list({}), {}, "list→{}");
    assert.deepEqual(await host.instructions.remove({ key: "k" }), {}, "remove→{}");
    assert.equal(await host.agents.list(), undefined, "agents 缺省→undefined 降级轨");
    assert.equal(await host.models.list(), undefined, "models 缺省→undefined");
    assert.equal(await host.storage.scan({ prefix: "p" }), undefined, "storage 缺省→undefined");
    assert.equal(await host.rpc.register({}, {}), null, "rpc.register 缺省→null");
  })();
});

test("T04 mkHostStub over 深合并：命名空间级浅合并+注册捕获面", async () => {
  let sawDraft = null;
  const host = mkHostStub({
    options: { leaderOnly: false },
    sessions: { get: async () => ({ agent: "workflow", projectID: "p" }) },
    agents: { list: async () => [{ name: "wf/builder" }] },
    tools: { transform: (fn) => { sawDraft = fn; return { dispose() {} }; } },
  });
  assert.equal(host.options.leaderOnly, false, "options 覆盖");
  assert.equal((await host.sessions.get({ sessionID: "s" })).agent, "workflow", "sessions.get 覆盖");
  assert.deepEqual(await host.agents.list(), [{ name: "wf/builder" }], "agents 覆盖");
  assert.equal(typeof host.sessions.wait, "function", "未覆盖命名空间键保留缺省（浅合并非整体替换）");
  host.tools.transform(() => {});
  assert.equal(typeof sawDraft, "function", "tools.transform 覆盖生效");
  // _ctx 逃生门（setup(ctx) 消费者装配同源）
  assert.equal(host._ctx.session.instructions.entry && "ok", "ok", "_ctx 暴露底层 ctx 视图");
  assert.equal(host._ctx.options.leaderOnly, false);
});

test("T04 mkStoreStub：CAS 与 state.ts 契约同源", async () => {
  const states = new Map();
  const s = mkStoreStub(states);
  const st = { sessionID: "s1", rounds: { plan_review: 0 }, log: [] };
  const r1 = await s.save(st);
  assert.equal(r1.ok, true, "新建→ok");
  assert.equal(typeof r1.rev, "number", "SaveResult {ok,rev}");
  // 陈旧快照拒写
  const stale = { sessionID: "s1", rev: 99, rounds: {}, log: [] };
  const r2 = await s.save(stale);
  assert.equal(r2.ok, false, "stale→拒");
  assert.equal(r2.reason, "stale-rev", "reason 与 writeTaskRow 三态同源");
  // structuredClone 隔离：改返回体不影响库存
  const loaded = await s.load("s1");
  loaded.phase = "MUT";
  assert.notEqual((await s.load("s1")).phase, "MUT", "load 克隆隔离");
  // removeState 清行
  await s.removeState("s1");
  assert.equal(await s.load("s1"), null);
  // 全键在位（Store 契约）
  for (const k of ["load", "save", "removeState", "resolveState", "resolveProjectDir", "scanStates",
    "putReport", "getReport", "dumpStates", "ready", "close"]) {
    assert.ok(k in s, `Store 缺键 ${k}`);
  }
  // report 槽形状含 sessionID（bug A 锚：TUI toastReport 过滤依赖）
  await s.putReport({ sessionID: "s9", text: "t", at: "a", brief: "b", level: "info" });
  const row = await s.getReport("s9");
  assert.equal(row.sessionID, "s9");
  assert.equal(row.brief, "b");
  assert.equal((await s.getReport("nope")), null, "无槽→null");
  const dump = await s.dumpStates();
  assert.ok(Array.isArray(dump) && dump.every((d) => typeof d.key === "string" && "value" in d), "dumpStates 形状");
});

test("T04 mkCommandDeps：CommandDeps 全键默认+捕获组", () => {
  const d = mkCommandDeps();
  for (const k of ["load", "save", "resolveProjectDir", "removeState", "putReport", "dumpStates",
    "debugDirFor", "probeOnce", "LIMS", "emitUpdated", "emitReport", "WfDef", "rpcErr", "bus"]) {
    assert.ok(k in d, `deps 缺键 ${k}`);
  }
  assert.deepEqual(d.LIMS, { ...LIMITS }, "LIMS 默认={...LIMITS}");
  assert.equal(d.WfDef, null);
  assert.equal(d.rpcErr, null);
  // R2 T2.4：runner 盒退役→bus 实例（inert：空注册表，call 未知命令走 ❌ 分支）
  assert.equal(typeof d.bus.call, "function");
  assert.equal(typeof d.bus.register, "function");
  assert.equal(d.bus.has("wf:plan"), false);
  const d2 = mkCommandDeps({ LIMS: { plan_review: 9 } });
  assert.deepEqual(d2.LIMS, { plan_review: 9 }, "over 覆盖");
});

test("T04 mkWiringHarness 端到端：intake→plan 真实流转 + 返回面冻结 + 红线7 不碰 WF_PROJECTS_FILE", async () => {
  const before = process.env.WF_PROJECTS_FILE;
  const h = await mkWiringHarness();
  await h.run("wf:intake", "helpers-e2e");
  const st = h.st();
  assert.equal(st.phase, "intake", "真实 commands.ts 流转驱动");
  assert.equal(st.slug, "helpers-e2e");
  await h.run("wf:plan");
  assert.equal(h.st().phase, "planning");
  assert.ok(h.reports.length > 0, "reports 捕获面在位");
  assert.ok(Array.isArray(h.events) && Array.isArray(h.cmds) && h.cmds.length >= 10, "events/cmds 面");
  assert.ok(h.host && h.deps, "host/deps 暴露");
  await h.run("wf:review");
  assert.equal(h.st().phase, "review");
  h.patch({ planConfirmedAt: "x", planReviewVerdict: "PASS", laneTableWritten: true }); // 关卡记账 fixture（daily M 级三条件 v2）
  assert.equal(h.st().verdicts?.confirmedAt, "x", "patch(obj) 记账 fixture（verdicts 子对象翻译）"); // R3 T3.1 子步 B
  await h.run("wf:build");
  assert.equal(h.st().phase, "building", "harness 装配可过真实关卡（e2e 有效性）");
  assert.equal(typeof h.dispose, "function");
  h.dispose();
  assert.equal(process.env.WF_PROJECTS_FILE, before, "红线7：helpers 不得改 env 隔离");
});

test("T04 装配收敛：≥16 个 tests 文件引用 helpers", () => {
  const dir = new URL("../tests/", import.meta.url);
  const users = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".test.js"))
    .filter((f) => /mkWiringHarness|mkHostStub|mkStoreStub|mkCommandDeps/.test(fs.readFileSync(new URL(f, dir), "utf8")));
  assert.ok(users.length >= 16, `引用 helpers 的文件数 ${users.length} <16：${users.join(",")}`);
});
