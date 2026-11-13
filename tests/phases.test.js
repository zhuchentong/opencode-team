// P0-b：shared/phases.ts 单一来源一致性守卫（防 server/tui/lib 三处漂移）
import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASE_ORDER, STAGE_LABEL, FOLD, CANON, BLOCKING, LEGACY_PHASES, DAILY_STAGE_ORDER } from "../shared/phases.ts";
import { FLOWS, FLOWS_DAILY, KIND_FILES, LIMITS } from "../server/lib.ts";

test("PHASE_ORDER 无重复", () => {
  assert.equal(new Set(PHASE_ORDER).size, PHASE_ORDER.length);
});

test("BLOCKING ⊆ PHASE_ORDER", () => {
  for (const p of BLOCKING) assert.ok(PHASE_ORDER.includes(p), `BLOCKING 未知阶段 ${p}`);
});

test("M16-r44：BLOCKING 含 build_review（执行审核阶段业务写同受闸；daily 无此阶段不受影响）", () => {
  assert.ok(BLOCKING.includes("build_review"), "build_review 应在 BLOCKING");
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

test("FLOWS 所有 from 阶段 ∈ PHASE_ORDER ∪ FOLD ∪ LEGACY ∪ null（from 用数组，null 不适用；M16-r28：LEGACY=存量在途任务兼容边）", () => {
  const legal = new Set([...PHASE_ORDER, ...Object.keys(FOLD), ...LEGACY_PHASES, "*"]);
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

// P6：phases.js 兼容 shim 已删除（宿主模块图全面切换 dist/tui.js 与 .ts 入口，真机验证后无旧引用）

// M16-r35：DAILY_STAGE_ORDER 守卫——TUI 日常进度条单一来源，必须与 FLOWS_DAILY 可达集一致
test("DAILY_STAGE_ORDER ⊆ PHASE_ORDER 且无重复", () => {
  assert.equal(new Set(DAILY_STAGE_ORDER).size, DAILY_STAGE_ORDER.length);
  for (const p of DAILY_STAGE_ORDER) assert.ok(PHASE_ORDER.includes(p), `DAILY_STAGE_ORDER 未知阶段 ${p}`);
});

test("DAILY_STAGE_ORDER = FLOWS_DAILY 可达 to 集（防视图/流转漂移）", () => {
  const reachable = new Set(Object.values(FLOWS_DAILY).map((f) => f.to));
  assert.deepEqual([...reachable].toSorted(), [...DAILY_STAGE_ORDER].toSorted());
});

// ── R2 T2.2（arch-r2-profile-statemachine）：PhaseDef ⇔ shared 常量双向一致性守卫 ──
import { PHASES_FULL, PHASES_DAILY } from "../server/lib.ts";

test("R2 T2.2：PHASES_FULL.blocking ⇔ BLOCKING 双向一致（注册面=唯一 blocking 源）", () => {
  const blockingFull = Object.entries(PHASES_FULL).filter(([, d]) => d.blocking).map(([p]) => p).toSorted();
  assert.deepEqual(blockingFull, [...BLOCKING].toSorted(), "full phases blocking 集须与 shared BLOCKING 逐字相等");
});

test("R2 T2.2：PHASES_DAILY.blocking ⊆ BLOCKING；键集=DAILY_STAGE_ORDER", () => {
  for (const [p, d] of Object.entries(PHASES_DAILY)) if (d.blocking) assert.ok(BLOCKING.includes(p), `daily blocking 越界 ${p}`);
  assert.deepEqual(Object.keys(PHASES_DAILY).toSorted(), [...DAILY_STAGE_ORDER].toSorted());
});

test("R2 T2.2：PHASE_ORDER ⊆ PHASES_FULL 键集；assign legacy 兼容行在位", () => {
  for (const p of PHASE_ORDER) assert.ok(p in PHASES_FULL, `full phases 缺阶段 ${p}`);
  assert.ok("assign" in PHASES_FULL, "assign 兼容行须在 PHASES_FULL");
  assert.match(PHASES_FULL.assign.next, /test_design/, "assign 下一步指 test_design");
});
