// tests/wfstate-normalize.test.js — R3 T3.1（arch-r3-state-shape-migration）
// 出口判据 1：「旧扁平 JSON → normalizeState → 与 HEAD 行为等价」跨版本用例 + 幂等/混合形状收敛。
// normalizeState 是纯函数（domain/types.ts 叶子），直测无需宿主。
import { test } from "bun:test";
import assert from "node:assert/strict";
import { normalizeState } from "../server/domain/types.ts";

const TIMING_FLAT = ["startedAt", "phaseEnteredAt", "phaseDurations", "finishedAt"];

test("normalize 旧平铺 → timing 子对象：值逐字搬入、顶层 delete 不留双份", () => {
  const st = {
    sessionID: "ses_a", slug: "t", phase: "planning",
    startedAt: "2026-11-13T10:00:00.000Z",
    phaseEnteredAt: "2026-11-13T10:05:00.000Z",
    phaseDurations: { intake: 42 },
  };
  const out = normalizeState(st);
  assert.equal(out, st, "就地归一（同一对象）");
  assert.deepEqual(out.timing, {
    startedAt: "2026-11-13T10:00:00.000Z",
    phaseEnteredAt: "2026-11-13T10:05:00.000Z",
    phaseDurations: { intake: 42 },
  });
  for (const k of TIMING_FLAT) assert.ok(!(k in out), `顶层 ${k} 应已 delete`);
  assert.ok(!("finishedAt" in out.timing), "旧快照没有的字段不补缺省");
});

test("normalize 幂等：已是新形原样通过（二次调用零变化）", () => {
  const st = { sessionID: "ses_b", timing: { startedAt: "2026-11-13T10:00:00.000Z", phaseDurations: {} } };
  const snap1 = JSON.stringify(normalizeState(st));
  const snap2 = JSON.stringify(normalizeState(st));
  assert.equal(snap1, snap2, "幂等");
  assert.deepEqual(JSON.parse(snap2).timing, st.timing, "子对象不被重排/补字段");
});

test("normalize 混合形状（timing 子对象 + 残留平铺字段并存）正确收敛：平铺胜出搬入子对象", () => {
  // 混合来源：新形 save 后又被旧代码路径追加平铺字段（回滚窗口脏写）——收敛为单一子对象
  const st = {
    timing: { startedAt: "2026-11-13T10:00:00.000Z" },
    phaseDurations: { intake: 7 },
  };
  const out = normalizeState(st);
  assert.deepEqual(out.timing, { startedAt: "2026-11-13T10:00:00.000Z", phaseDurations: { intake: 7 } });
  assert.ok(!("phaseDurations" in out), "顶层残留已 delete");
});

test("normalize 新形无 timing / 纯净快照：不凭空造 timing 空对象", () => {
  const st = { sessionID: "ses_c", slug: "legacy", phase: "intake" };
  const out = normalizeState(st);
  assert.equal(out.timing, undefined, "无计时字段的存量快照保持无 timing（A6 存量语义前提）");
  assert.deepEqual(out, { sessionID: "ses_c", slug: "legacy", phase: "intake" }, "其余字段零触碰");
});

test("normalize 防御：null/非对象原样返回不抛", () => {
  assert.equal(normalizeState(null), null);
  assert.equal(normalizeState(undefined), undefined);
  assert.equal(normalizeState("x"), "x");
});
