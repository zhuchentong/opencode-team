// W15-a 体量漂移观察闸纯函数锚（domain/tier-audit.ts）：
// ①S+双信号同向→drift；②S+单信号→不判（假阳率防线）；③非 S 恒不判（M/L 无豁免面可旁路）；
// ④畸形输入 never-throw；⑤阈值边界（nodes=5 入、4 出；bytes=10240 入、10239 出）；
// ⑥历史语料蒸馏：test_58 S 轮 plan（T4/3.8KB）双信号不同向→不判（观察闸不对存量轮翻案，
// 硬化留待 ≥3 例立项——评审裁定原样锁定，防后人「顺手收紧阈值」回潮）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTierDrift, TIER_DRIFT_MIN_T } from "../server/lib.ts";

const mkPlan = (tCount, fillKB = 0) => {
  const rows = Array.from({ length: tCount }, (_, i) => `| T0${i + 1} | ${i + 1} | L0 |`).join("\n");
  const filler = "x".repeat(fillKB * 1024);
  return `# plan\n\n\`\`\`lane-deps\nnodes:\n| T | wave | lane |\n|---|---|---|\n${rows}\nedges:\n\`\`\`\n\n${filler}`;
};

test("W15-a① S+双信号同向（nodes≥5 ∧ ≥10KB）→ drift 且 reasons 双条", () => {
  const r = auditTierDrift(mkPlan(6, 12), "S");
  assert.equal(r.drift, true);
  assert.equal(r.reasons.length, 2, "双信号同向才判（评审裁定）");
});

test("W15-a② S+单信号：多 T 小 plan / 少 T 大 plan 均不判（单信号假阳率防线）", () => {
  assert.equal(auditTierDrift(mkPlan(6, 2), "S").drift, false, "nodes 超标但 bytes 未超标");
  assert.equal(auditTierDrift(mkPlan(2, 14), "S").drift, false, "bytes 超标但 nodes 未超标");
});

test("W15-a③ 非 S 恒不判：M/L/缺省/未知体量零豁免面可旁路", () => {
  for (const size of ["M", "L", undefined, null, "X"]) {
    assert.equal(auditTierDrift(mkPlan(8, 20), size).drift, false, `size=${size}`);
  }
});

test("W15-a④ never-throw：非字符串/空串/畸形围栏零异常零漂移", () => {
  for (const c of [null, undefined, 42, "", "```lane-deps\ngarbage\n```"]) {
    const r = auditTierDrift(c, "S");
    assert.equal(r.drift, false);
    assert.deepEqual(r.reasons, []);
  }
});

test("W15-a⑤ 阈值边界：nodes/TIER_DRIFT_MIN_T 与 bytes/S 预算两端点", () => {
  assert.equal(TIER_DRIFT_MIN_T, 5, "域常量锁定（标定：历史 S 轮实测 T1~4）");
  assert.equal(auditTierDrift(mkPlan(TIER_DRIFT_MIN_T, 10), "S").drift, true, "双端点含边界=入");
  assert.equal(auditTierDrift(mkPlan(TIER_DRIFT_MIN_T - 1, 10), "S").drift, false, "nodes 差一=出");
  assert.equal(auditTierDrift(mkPlan(TIER_DRIFT_MIN_T, 10), "S").drift, true);
  const p9 = mkPlan(TIER_DRIFT_MIN_T, 0) + "y".repeat(10 * 1024 - 1 - mkPlan(TIER_DRIFT_MIN_T, 0).length);
  assert.equal(auditTierDrift(p9, "S").drift, false, "bytes 差一字节=出");
});

test("W15-a⑥ 历史语料蒸馏：test_58 S 轮形态（T4/3.8KB）不判——观察闸不翻存量案", () => {
  assert.equal(auditTierDrift(mkPlan(4, 3), "S").drift, false, "双信号不同向（评审 evidence 角度：T 计数对本轮零分辨力，观察闸不假装能拦）");
});
