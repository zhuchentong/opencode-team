// P2 RPC 契约漂移守卫：shared/rpc.ts 被 server 与 TUI 两个进程各自 import（结构同一而非同一实例），
// id/methods/events 与 report 事件的 sessionID|at 去重键是 wire 级字符串路由（rpc.<id>.<name>）的
// 前提——任何一端形状漂移都让事件/调用静默失联（ERR-20261110-008 教训）。此文件逐字段锁死契约。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wf } from "../shared/rpc.ts";

test("RPC 契约快照：id/methods/events 逐字段锁定", () => {
  assert.equal(Wf.id, "wf"); // wire 前缀 rpc.wf.<name> 的字符串来源
  assert.deepEqual(Object.keys(Wf.methods).toSorted(), ["exec", "list", "state"]);
  assert.deepEqual(Object.keys(Wf.events).toSorted(), ["report", "updated"]);

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
