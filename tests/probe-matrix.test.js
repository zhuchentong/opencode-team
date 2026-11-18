// tests/probe-matrix.test.js — W11-v2.1：probe-matrix 机器区解析/校验纯函数直测（checkProbeMatrix/parseProbeMatrix）。
// fixture 主锚=test_56 真实案例：F1（probe.ts 单文件双绿不支撑跨文件 .ts import 契约，冻结 tsconfig 漏
// allowImportingTsExtensions → wave2 起必红 TS5097）。评审 M7 同款不变量：解析永不 throw——畸形=parseErrors。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProbeMatrix, parseProbeMatrix } from "../server/lib.ts";

const PLAN_TAIL = (rows) => `# 计划

\`\`\`lane-deps
nodes:
| T | wave | lane |
|---|---|---|
| T01 | 0 | lane-0 |
| T02 | 1 | lane-0 |
edges:
| 消费方 | 提供方 | 符号 | kind |
|---|---|---|---|
| T02 | T01 | Types | type |
\`\`\`

\`\`\`probe-matrix
| T | probe_files | cross_file_import | tsconfig_notes |
|---|---|---|---|
${rows}
\`\`\`
`;

test("W11 解析永不 throw：非字符串/畸形围栏=parseErrors 不抛", () => {
  for (const bad of [null, 42, {}, undefined]) assert.deepEqual(parseProbeMatrix(bad), { present: false, rows: [], parseErrors: [] });
  const unclosed = parseProbeMatrix("```probe-matrix\n| T01 | 1 | no | x |\n");
  assert.equal(unclosed.present, true);
  assert.ok(unclosed.parseErrors.some((s) => s.includes("未闭合")));
  const dup = parseProbeMatrix("```probe-matrix\n| T01 | 1 | no | x |\n```\n```probe-matrix\n| T02 | 1 | no | y |\n```");
  assert.ok(dup.parseErrors.some((s) => s.includes("只允许保留一个")));
});

test("W11 行解析：列数/整数/枚举畸形入 parseErrors；表头与分隔行跳过", () => {
  const p = parseProbeMatrix("```probe-matrix\n| T | probe_files | cross_file_import | tsconfig_notes |\n|---|---|---|---|\n| T01 | 1 | no | x |\n| T02 | 1 | maybe | y |\n| T03 | abc | no | z |\n| T04 | 1 |\n```");
  assert.equal(p.rows.length, 1, "仅 T01 合法入行");
  assert.ok(p.parseErrors.length >= 3, "T02 枚举/T03 非整数/T04 列数不足=3 条 parseErrors");
});

test("W11 R-P1：M/L 缺区硬拒（含修正示例），S 级豁免", () => {
  const m = checkProbeMatrix("# 无机器区", "M");
  assert.equal(m.ok, false);
  assert.ok(m.violations.some((s) => s.includes("probe-matrix 机器区")));
  assert.equal(checkProbeMatrix("# 无机器区", "S").ok, true, "S 级豁免");
  assert.equal(checkProbeMatrix("# 无机器区", undefined).ok, false, "缺省按 M（tierOf 语义一致）");
});

test("W11 R-P2 双射：缺行/多行均 violations 且附双方清单", () => {
  const onlyT01 = checkProbeMatrix(PLAN_TAIL("| T01 | 1 | no | - |"), "M");
  assert.ok(onlyT01.violations.some((s) => s.includes("矩阵缺行") && s.includes("T02")), "lane-deps 有 T01/T02、矩阵只有 T01=缺行");
  const extra = checkProbeMatrix(PLAN_TAIL("| T01 | 1 | no | - |\n| T02 | 1 | no | - |\n| T09 | 1 | no | - |"), "M");
  assert.ok(extra.violations.some((s) => s.includes("矩阵多行") && s.includes("T09")), "矩阵多 T09=多行");
  assert.ok(extra.violations.some((s) => s.includes("lane-deps 侧=T01、T02")), "消息附双方清单（planner 可自纠）");
});

test("W11 R-P3 行级：cross_file_import=yes ⇒ probe_files≥2 ∧ tsconfig_notes 非空", () => {
  const thin = checkProbeMatrix(PLAN_TAIL("| T01 | 1 | no | - |\n| T02 | 1 | yes | - |"), "M");
  assert.ok(thin.violations.some((s) => s.includes("probe_files=1<2")));
  const bare = checkProbeMatrix(PLAN_TAIL("| T01 | 1 | no | - |\n| T02 | 2 | yes | |"), "M");
  assert.ok(bare.violations.some((s) => s.includes("tsconfig_notes 为空")));
});

test("W11 R-P3 集合级：type 边 ⇒ 至少一行 yes∧≥2（test_56 TS5097 主锚）", () => {
  // PLAN_TAIL 的 edges 已含 T02|T01|Types|type——全 no 矩阵必违规（模拟 test_56 单文件探针形态）
  const allNo = checkProbeMatrix(PLAN_TAIL("| T01 | 1 | no | - |\n| T02 | 1 | no | - |"), "M");
  assert.ok(allNo.violations.some((s) => s.includes("type 边") && s.includes("probe_files≥2")), "单文件探针不支撑跨文件 type 消费");
  const ok = checkProbeMatrix(PLAN_TAIL("| T01 | 1 | no | - |\n| T02 | 2 | yes | allowImportingTsExtensions |"), "M");
  assert.equal(ok.ok, true, "yes∧≥2 行满足集合级+行级+双射");
});

test("W11 无 type 边：全 no 矩阵合法（单 lane 纯值消费任务不误伤）", () => {
  const plan = `# 计划

\`\`\`lane-deps
nodes:
| T | wave | lane |
|---|---|---|
| T01 | 0 | lane-0 |
| T02 | 1 | lane-0 |
edges:
| 消费方 | 提供方 | 符号 | kind |
|---|---|---|---|
| T02 | T01 | countRows | value |
\`\`\`

\`\`\`probe-matrix
| T | probe_files | cross_file_import | tsconfig_notes |
|---|---|---|---|
| T01 | 1 | no | - |
| T02 | 1 | no | - |
\`\`\`
`;
  assert.equal(checkProbeMatrix(plan, "M").ok, true);
});

test("W11 R-P3 集合级豁免口径：S 级带矩阵仅行级校验（lane-deps 可缺省）", () => {
  const sPlan = "```probe-matrix\n| T01 | 1 | no | - |\n```";
  assert.equal(checkProbeMatrix(sPlan, "S").ok, true, "S 级单行矩阵无跨表规则=合法");
  const sThin = checkProbeMatrix("```probe-matrix\n| T01 | 1 | yes | - |\n```", "S");
  assert.equal(sThin.ok, false, "S 级行级规则仍生效");
});

test("W11 重复 T 行=violations", () => {
  const dup = checkProbeMatrix(PLAN_TAIL("| T01 | 1 | no | - |\n| T01 | 2 | no | - |\n| T02 | 1 | no | - |"), "M");
  assert.ok(dup.violations.some((s) => s.includes("重复声明")));
});
