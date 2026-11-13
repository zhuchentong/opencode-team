// tests/dedup.test.js — R3 T3.3（arch-r3-state-shape-migration）
// createDeduper 纯函数四态直测：首见/重复/过期/淘汰 + cap 边界（时钟注入，无真实等待）。
import { test } from "bun:test";
import assert from "node:assert/strict";
import { createDeduper, reportId } from "../shared/report.ts";

test("createDeduper：首见 true → 重复 false（幂等消费键）", () => {
  const now = 1_000_000;
  const d = createDeduper({ now: () => now });
  const key = reportId("ses_a", "2026-11-13T00:00:00.000Z");
  assert.equal(d.seen(key, now), true, "首见=应处理");
  assert.equal(d.seen(key, now), false, "重复=跳过");
  assert.equal(d.seen(reportId("ses_a", "2026-11-13T00:00:01.000Z"), now), true, "不同 at=新报告");
});

test("createDeduper：过期（now-atMs > ttl）false 且不登记（与原 stale-skipped 语义一致）", () => {
  let now = 1_000_000;
  const d = createDeduper({ now: () => now });
  const key = reportId("ses_b", "x");
  assert.equal(d.seen(key, now - 60_001), false, "恰超 60s 门 → 过期跳过");
  now += 1; // 时间推进：过期报告即使后来重复到达也不弹（未登记）
  assert.equal(d.seen(key, now - 60_001), false, "过期后再见仍 false");
  assert.equal(d.seen(key, now), true, "同键新时间戳=首次（旧时间戳未污染登记）");
});

test("createDeduper：cap 淘汰 FIFO 最旧（默认 50；超限逐出最早键）", () => {
  const now = 0;
  const d = createDeduper({ now: () => now, cap: 3 });
  for (const k of ["k1", "k2", "k3"]) assert.equal(d.seen(k, now), true);
  assert.equal(d.seen("k4", now), true, "超 cap 仍接受新键");
  assert.equal(d.seen("k2", now), false, "k2 未淘汰 → 重复");
  assert.equal(d.seen("k1", now), true, "k1 已被 FIFO 淘汰 → 再见=首见（原 shown Set 同语义）");
});

test("createDeduper：默认 ttl=60000/cap=50 与原 TUI 常量一致", () => {
  const d = createDeduper({ now: () => 1000 });
  assert.equal(d.seen("k", 1000 - 60_000), true, "恰 60s=门内");
  assert.equal(d.seen("k2", 1000 - 60_001), false, "60s+1ms=门外");

  const big = createDeduper({ now: () => 0 });
  for (let i = 0; i < 50; i++) big.seen(`k${i}`, 0);
  assert.equal(big.seen("k50", 0), true, "第 51 键接受");
  assert.equal(big.seen("k1", 0), false, "k1 仍在（仅 k0 被逐出）");
});

test("reportId：幂等消费键单一生成点（sessionID|at）", () => {
  assert.equal(reportId("ses_x", "2026-11-13T00:00:00.000Z"), "ses_x|2026-11-13T00:00:00.000Z");
});
