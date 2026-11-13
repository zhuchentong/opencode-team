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

// ── 子步 B：verdicts 家族（5 字段，Verdict/plan 前缀剥除）─────────────────────
test("normalize verdicts：旧平铺 5 字段搬入子对象并剥前缀（planReviewVerdict→planReview 等）", () => {
  const st = {
    sessionID: "ses_v", slug: "t", phase: "review",
    planReviewVerdict: "PASS",
    testReportVerdict: "FAIL",
    testPlanWritten: true,
    planConfirmedAt: "2026-11-13T00:00:00.000Z",
    gateStatus: { id: "daily-build", ok: false, at: "2026-11-13T00:01:00.000Z" },
  };
  const out = normalizeState(st);
  assert.deepEqual(out.verdicts, {
    planReview: "PASS",
    testReport: "FAIL",
    testPlanWritten: true,
    confirmedAt: "2026-11-13T00:00:00.000Z",
    gateStatus: { id: "daily-build", ok: false, at: "2026-11-13T00:01:00.000Z" },
  });
  for (const k of ["planReviewVerdict", "testReportVerdict", "testPlanWritten", "planConfirmedAt", "gateStatus"]) {
    assert.ok(!(k in out), `顶层 ${k} 应已 delete`);
  }
});

test("normalize verdicts 幂等 + 混合形状收敛", () => {
  const st = { verdicts: { planReview: "PASS" }, testReportVerdict: "PASS", planConfirmedAt: "x" };
  const out = normalizeState(st);
  assert.deepEqual(out.verdicts, { planReview: "PASS", testReport: "PASS", confirmedAt: "x" });
  const snap1 = JSON.stringify(out);
  assert.equal(snap1, JSON.stringify(normalizeState(out)), "幂等");
});

test("normalize A+B 混合：timing 与 verdicts 同时搬迁（旧最全平铺快照一次收敛）", () => {
  const legacy = JSON.parse(JSON.stringify({
    sessionID: "ses_full", slug: "r2-task", phase: "testing",
    startedAt: "2026-11-12T10:00:00.000Z", phaseEnteredAt: "2026-11-12T11:00:00.000Z",
    phaseDurations: { intake: 60 }, finishedAt: undefined,
    planReviewVerdict: "PASS", testReportVerdict: "PASS", testPlanWritten: true, planConfirmedAt: "2026-11-12T10:30:00.000Z",
    gateStatus: { id: "acceptance", ok: true, at: "2026-11-12T11:00:00.000Z" },
  }));
  const out = normalizeState(legacy);
  assert.deepEqual(out.timing, { startedAt: "2026-11-12T10:00:00.000Z", phaseEnteredAt: "2026-11-12T11:00:00.000Z", phaseDurations: { intake: 60 } });
  assert.deepEqual(out.verdicts, {
    planReview: "PASS", testReport: "PASS", testPlanWritten: true,
    confirmedAt: "2026-11-12T10:30:00.000Z",
    gateStatus: { id: "acceptance", ok: true, at: "2026-11-12T11:00:00.000Z" },
  });
  assert.equal(Object.keys(out).filter((k) => Object.keys({ planReviewVerdict: 1, testReportVerdict: 1, testPlanWritten: 1, planConfirmedAt: 1, gateStatus: 1, startedAt: 1, phaseEnteredAt: 1, phaseDurations: 1, finishedAt: 1 }).includes(k)).length, 0, "顶层无任何旧平铺键残留");
});
