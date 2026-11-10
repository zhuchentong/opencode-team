// P0-b：shared/phases.js 单一来源一致性守卫（防 server/tui/lib 三处漂移）
import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASE_ORDER, STAGE_LABEL, FOLD, CANON, BLOCKING } from "../shared/phases.ts";
import { FLOWS, KIND_FILES, LIMITS } from "../server/lib.ts";

test("PHASE_ORDER 无重复", () => {
  assert.equal(new Set(PHASE_ORDER).size, PHASE_ORDER.length);
});

test("BLOCKING ⊆ PHASE_ORDER", () => {
  for (const p of BLOCKING) assert.ok(PHASE_ORDER.includes(p), `BLOCKING 未知阶段 ${p}`);
});

test("FLOWS 所有 to ∈ PHASE_ORDER ∪ FOLD 键（折叠态合法）", () => {
  const legal = new Set([...PHASE_ORDER, ...Object.keys(FOLD)]);
  for (const [cmd, flow] of Object.entries(FLOWS)) {
    assert.ok(legal.has(flow.to), `${cmd} 的目标阶段 ${flow.to} 不在合法集`);
  }
});

test("FLOWS 所有 counter ∈ LIMITS 键", () => {
  for (const [cmd, flow] of Object.entries(FLOWS)) {
    if (flow.counter) assert.ok(flow.counter in LIMITS, `${cmd} 的计数器 ${flow.counter} 无上限定义`);
  }
});

test("FLOWS 所有 from 阶段 ∈ PHASE_ORDER ∪ FOLD ∪ null（from 用数组，null 不适用）", () => {
  const legal = new Set([...PHASE_ORDER, ...Object.keys(FOLD), "*"]);
  for (const [cmd, flow] of Object.entries(FLOWS)) {
    for (const f of flow.from) assert.ok(legal.has(f), `${cmd} 的来源阶段 ${f} 不在合法集`);
  }
});

test("CANON ⊆ KIND_FILES 值域（canonical 产物都有落盘途径）", () => {
  const names = new Set(Object.values(KIND_FILES).map((fn) => fn({ rounds: {} })));
  for (const c of CANON) assert.ok(names.has(c), `CANON 产物 ${c} 无对应 KIND_FILES`);
});

test("STAGE_LABEL 覆盖 PHASE_ORDER ∪ FOLD 键（TUI 标签不缺项）", () => {
  for (const p of [...PHASE_ORDER, ...Object.keys(FOLD)]) {
    assert.ok(typeof STAGE_LABEL[p] === "string" && STAGE_LABEL[p].length > 0, `STAGE_LABEL 缺 ${p}`);
  }
});

// 漂移防线：phases.js 为宿主旧模块图兼容 shim（见其头注释），真正单一来源是 phases.ts
// （lib/tui 实际消费）。两文件若漂移，上面守卫只测 .js 而消费用 .ts → 守卫失效。
// 此断言把两者焊死：内容必须逐字段全等。
import * as tsPhases from "../shared/phases.ts";
test("phases.js ↔ phases.ts 逐字段全等（防 shim 漂移）", () => {
  const js = { PHASE_ORDER, STAGE_LABEL, FOLD, CANON, BLOCKING };
  for (const [k, v] of Object.entries(js)) {
    assert.deepEqual(tsPhases[k], v, `phases.${k} 在 .js 与 .ts 间漂移`);
  }
});
