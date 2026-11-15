// r54 批次 D2：空闲轮询跳拍判定锚（test_008 实证 done/空态仍 5s 全量 RPC；等效 30s 退避经
// 节拍跳过实现——守 harness R7 锚：单 setInterval、无新 timer）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pollSkip } from "../tui/util.ts";

test("D2 pollSkip：活跃态恒 false（每拍执行）；空闲态每 6 拍执行 1 次（等效 30s）", () => {
  for (let t = 1; t <= 12; t++) assert.equal(pollSkip(false, t), false, `活跃态第 ${t} 拍不得跳过`);
  const skipped = [1, 2, 3, 4, 5].filter((t) => pollSkip(true, t));
  assert.deepEqual(skipped, [1, 2, 3, 4, 5], "空闲态 1-5 拍全跳");
  assert.equal(pollSkip(true, 6), false, "空闲态第 6 拍执行（5s×6=30s 等效周期）");
  assert.equal(pollSkip(true, 12), false, "第 12 拍执行（周期性）");
});
