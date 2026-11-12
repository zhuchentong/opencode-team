// P2 RPC 契约漂移守卫：shared/rpc.ts 被 server 与 TUI 两个进程各自 import（结构同一而非同一实例），
// id/methods/events 与 report 事件的 sessionID|at 去重键是 wire 级字符串路由（rpc.<id>.<name>）的
// 前提——任何一端形状漂移都让事件/调用静默失联（ERR-20261110-008 教训）。此文件逐字段锁死契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wf } from "../shared/rpc.ts";
import { createRpcBridge } from "../server/rpc-bridge.ts";

test("RPC 契约快照：id/methods/events 逐字段锁定", () => {
  assert.equal(Wf.id, "wf"); // wire 前缀 rpc.wf.<name> 的字符串来源
  assert.deepEqual(Object.keys(Wf.methods).toSorted(), ["exec", "list", "read", "state"]);
  assert.deepEqual(Object.keys(Wf.events).toSorted(), ["report", "updated"]);

  // read（M16-r46 产物预览通道）：入参必填 sessionID+file；出参必含 text/path（错误走 error 字段不抛错——quota 教训）
  assert.deepEqual(Wf.methods.read.input.required.toSorted(), ["file", "sessionID"]);
  assert.equal(Wf.methods.read.input.additionalProperties, false);
  assert.deepEqual(Wf.methods.read.output.required.toSorted(), ["path", "text"]);

  // exec（P2 主轨通道）：入参必填 sessionID+name；出参必含 text 字符串
  assert.deepEqual(Wf.methods.exec.input.required.toSorted(), ["name", "sessionID"]);
  assert.equal(Wf.methods.exec.input.additionalProperties, false);
  assert.deepEqual(Wf.methods.exec.output.required, ["text"]);

  // report 事件：sessionID|at 去重键与新鲜度门依赖三字段全 required
  assert.deepEqual(Wf.events.report.schema.required.toSorted(), ["at", "sessionID", "text"]);

  // state 输出必须携带 lastReport（轮询主通道契约，r29e bug A 教训）
  assert.ok(Wf.methods.state.output.properties.rounds, "state 输出形状基本项在位");

  // M16-r35：侧边栏模式感知——state 输出携带 mode/size/planReviewVerdict（nullable，存量任务为 null）
  // M16-r44：+planConfirmedAt（方案确认记账，nullable string）
  for (const k of ["mode", "size", "planReviewVerdict", "planConfirmedAt"]) {
    const p = Wf.methods.state.output.properties[k];
    assert.ok(p, `state 输出缺 ${k}（TUI 模式感知前提）`);
    assert.deepEqual(p.type, ["string", "null"], `${k} 应为 nullable string`);
  }
});

// ── tui-sidebar-elapsed T02（plan §3.3）：state 白名单计时 4 字段 ──────────────
// stateSchema additionalProperties:true → 白名单在 rpc-bridge.ts；经 mock register 直测返回值形状
//（mock 形状与 rpc-read.test.js 同源）。存量任务 4 字段 null；inactive 分支形状不变。
const TIMING_KEYS = ["startedAt", "phaseEnteredAt", "phaseDurations", "finishedAt"];
const mkStateBridge = async (st) => {
  const impls = {};
  const ctx = { rpc: { register: async (_def, impl) => { Object.assign(impls, impl); return { events: { emit: async () => {} } }; } } };
  const deps = {
    load: async () => st,
    scanStates: async () => [],
    getReport: async () => null,
    runner: { run: null },
    resolveProjectDir: async () => "/tmp/opencode/wf-elapsed",
  };
  await createRpcBridge(ctx, deps);
  return impls;
};

test("T02 state 计时 4 字段：存量任务为 null（?? null 形态）", async () => {
  const legacy = { sessionID: "ses_legacy", slug: "old-task", phase: "building", rounds: { plan_review: 1, build_review: 0, test_fix: 0 } };
  const impls = await mkStateBridge(legacy);
  const res = await impls.state({ sessionID: "ses_legacy" });
  assert.equal(res.active, true);
  for (const k of TIMING_KEYS) {
    assert.ok(k in res, `state 返回缺 ${k}（TUI 耗时列前提）`);
    assert.equal(res[k], null, `存量任务 ${k} 应为 null`);
  }
});

test("T02 state 计时 4 字段：有账任务逐字透传", async () => {
  const timed = {
    sessionID: "ses_timed", slug: "timed-task", phase: "done", rounds: {},
    startedAt: "2026-11-12T10:00:00.000Z",
    phaseEnteredAt: "2026-11-12T10:12:34.000Z",
    phaseDurations: { intake: 42, planning: 130 },
    finishedAt: "2026-11-12T10:12:34.000Z",
  };
  const impls = await mkStateBridge(timed);
  const res = await impls.state({ sessionID: "ses_timed" });
  assert.equal(res.startedAt, timed.startedAt);
  assert.equal(res.phaseEnteredAt, timed.phaseEnteredAt);
  assert.deepEqual(res.phaseDurations, timed.phaseDurations);
  assert.equal(res.finishedAt, timed.finishedAt);
});

test("T02 inactive 分支形状不变：无行/幽灵行仅 sessionID/active/lastReport，不带计时字段", async () => {
  for (const st of [null, { sessionID: "ses_ghost", slug: "", phase: null, rounds: {} }]) {
    const impls = await mkStateBridge(st);
    const res = await impls.state({ sessionID: "ses_ghost" });
    assert.equal(res.active, false);
    assert.deepEqual(Object.keys(res).toSorted(), ["active", "lastReport", "sessionID"], "inactive 形状不得扩张");
    for (const k of TIMING_KEYS) assert.ok(!(k in res), `inactive 分支不得携带 ${k}`);
  }
});
