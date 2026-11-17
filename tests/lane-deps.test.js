// tests/lane-deps.test.js — 效率批 P1：lane 依赖边表机器区解析/校验（parseLaneDeps/checkLaneDeps 纯函数直测）。
// fixture 主锚=test_51 真实案例：F1（T03 消费 matchesDay@T02 同波次跨 lane → 10m52s 返修链）与
// F6（声明波次 vs 拓扑层深漂移）。评审 M7：解析永不 throw——畸形输入=violations，本文件锁死该不变量。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLaneDeps, parseLaneDeps } from "../server/lib.ts";

const FENCE_OPEN = "```lane-deps";
const FENCE_CLOSE = "```";

const VALID = `# plan
## 5. lane 分组表
| lane-A | T02 | src/parse.ts | ~5KB |
| lane-B | T03 | src/tz.ts | ~8KB |

${FENCE_OPEN}
nodes:
| T | wave | lane |
|---|---|---|
| T01 | 0 | lane-0 |
| T02 | 1 | lane-A |
| T03 | 1 | lane-B |
| T04 | 2 | lane-B |
edges:
| 消费方 | 提供方 | 符号 | kind |
|---|---|---|---|
| T02 | T01 | CronFields | type |
| T03 | T01 | matchesDay | value |
| T04 | T03 | nextRuns | value |
${FENCE_CLOSE}
`;

test("合法边表：M 级全过 + 合并序派生（同 wave 多 lane ∥）", () => {
  const r = checkLaneDeps(VALID, "M");
  assert.equal(r.ok, true, `violations=${JSON.stringify(r.violations)}`);
  assert.equal(r.order, "wave0{T01} → wave1{T02∥T03} → wave2{T04}");
});

test("F1 fixture：跨 lane 同波次 value 边 → R3 违规（test_51 真实返修链锚）", () => {
  const f1 = VALID.replace("| T03 | T01 | matchesDay | value |", "| T03 | T02 | matchesDay | value |");
  const r = checkLaneDeps(f1, "M");
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /跨 lane 边 T03\(wave1\) ← T02\(wave1\)/.test(v)), r.violations.join("\n"));
  assert.ok(r.violations.some((v) => /下沉.*更早 wave/.test(v)), "违规须带修正方向");
});

test("F1 变体：type 边同规（worktree 类型 import 同样编译失败）", () => {
  const t = VALID.replace("| T02 | T01 | CronFields | type |", "| T02 | T03 | CronFields | type |");
  const r = checkLaneDeps(t, "M");
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /跨 lane/.test(v)));
});

test("R2 依赖环：环=任何波次调度都不可行", () => {
  const cyc = VALID.replace("| T04 | T03 | nextRuns | value |", "| T01 | T03 | base | value |");
  const r = checkLaneDeps(cyc, "M");
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /依赖环/.test(v)), r.violations.join("\n"));
});

test("R0：M 级缺机器区 → 违规带格式示例；S 级豁免", () => {
  const bare = "# plan\n## lane 分组表\n| lane-A | T02 | src | 1KB |";
  const m = checkLaneDeps(bare, "M");
  assert.equal(m.ok, false);
  assert.ok(m.violations.some((v) => /lane-deps 机器区/.test(v)));
  assert.ok(m.violations.some((v) => /nodes:/.test(v)), "违规须带格式修正示例");
  const s = checkLaneDeps(bare, "S");
  assert.equal(s.ok, true, "S 豁免（与 lane 分组表交付口径一致）");
  // 缺省 tier 按 M（tierOf 语义，存量兼容）
  assert.equal(checkLaneDeps(bare, undefined).ok, false);
});

test("F6 危险方向：声明 wave < 拓扑层深 → 违规；声明更深=安全不拒", () => {
  const shallow = VALID.replace("| T04 | 2 | lane-B |", "| T04 | 1 | lane-B |");
  const r = checkLaneDeps(shallow, "M");
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /T04 声明 wave1 早于其依赖层深 wave2/.test(v)), r.violations.join("\n"));
  const deep = VALID.replace("| T02 | 1 | lane-A |", "| T02 | 2 | lane-A |");
  assert.equal(checkLaneDeps(deep, "M").ok, true, "声明比层深深=浪费并行但安全，不拒");
});

test("R1：边端点未声明 / kind 非法 / 符号空 → 逐条违规", () => {
  const bad = VALID
    .replace("| T02 | T01 | CronFields | type |", "| T09 | T01 | CronFields | type |")
    .replace("| T03 | T01 | matchesDay | value |", "| T03 | T01 | matchesDay | pointer |")
    .replace("| T04 | T03 | nextRuns | value |", "| T04 | T03 |  | value |");
  const r = checkLaneDeps(bad, "M");
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /消费方 T09 未在 nodes 声明/.test(v)));
  assert.ok(r.violations.some((v) => /kind 须为 value\|type/.test(v)));
  assert.ok(r.violations.some((v) => /符号列为空/.test(v)));
});

test("M7 不变量：畸形输入永不 throw（未闭合/多块/列数不足/wave 非整数）", () => {
  const cases = [
    "```lane-deps\nnodes:\n| T01 | 0 | lane-0 |\n", // 未闭合
    "```lane-deps\nnodes:\n| T01 |\n```\n```lane-deps\n```\n", // 多块+列数不足
    "```lane-deps\nnodes:\n| T01 | abc | lane-0 |\nedges:\n```\n", // wave 非整数
    "```lane-deps\nedges:\n| T02 | T01 | s | value |\n```\n", // 无 nodes 表
    42, // 非字符串
    null,
  ];
  for (const c of cases) {
    const r = checkLaneDeps(c, "M");
    assert.equal(typeof r.ok, "boolean", `case=${JSON.stringify(c).slice(0, 40)}`);
    if (!r.ok) assert.ok(Array.isArray(r.violations) && r.violations.length > 0);
  }
});

test("解析面：分隔行/空行/注释行跳过；edges 行带块内行号定位", () => {
  const p = parseLaneDeps(VALID);
  assert.equal(p.present, true);
  assert.equal(p.nodes.length, 4);
  assert.equal(p.edges.length, 3);
  assert.equal(p.edges[0].line > p.edges[0].line * 0, true, "行号为正数（回显定位）");
  assert.deepEqual(p.parseErrors, []);
});

test("R4+R0 组合：单 lane M 任务 edges 空表=合法（评审 M7 修订）", () => {
  const single = `# plan\n${FENCE_OPEN}\nnodes:\n| T | wave | lane |\n|---|---|---|\n| T01 | 0 | lane-0 |\n| T02 | 1 | lane-0 |\nedges:\n| 消费方 | 提供方 | 符号 | kind |\n|---|---|---|\n${FENCE_CLOSE}`;
  const r = checkLaneDeps(single, "M");
  assert.equal(r.ok, true, r.violations.join("\n"));
});
