// tests/wfstate-fields.test.js — R3 T3.1 子步 D（arch-r3-state-shape-migration）
// 出口判据 2：WfState/FlowLogEntry 字段名集快照锁——新字段须在此显式登记否则红。
// 机制：源码级解析 server/domain/types.ts 的 interface 声明属性名（类型层无运行时枚举），
// 对比快照全集。索引签名已收尾为 _ext（分组成员含 _ext 亦须登记）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

const SRC = fs.readFileSync(new URL("../server/domain/types.ts", import.meta.url), "utf8");

// 提取 interface 体（花括号平衡；不解析嵌套类型文本的属性名误报——子对象单独提取）
function ifaceBody(name) {
  const start = SRC.indexOf(`export interface ${name} {`);
  assert.ok(start >= 0, `types.ts 缺 interface ${name}`);
  let depth = 0, i = SRC.indexOf("{", start);
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) break; }
  }
  return SRC.slice(SRC.indexOf("{", start) + 1, i);
}

// 顶层属性名（行首标识符 + 可选 ?）；排除嵌套块的行（缩进 2 空格才算顶层成员）
function topProps(body) {
  const names = [];
  for (const line of body.split("\n")) {
    const m = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*)\??:/);
    if (m) names.push(m[1]);
  }
  return names;
}
// 嵌套子对象属性名（4 空格缩进成员，直到该块结束）
function subProps(body, group) {
  const m = body.match(new RegExp(`  ${group}\\?: \\{\\n([\\s\\S]*?)\\n  \\};`));
  assert.ok(m, `缺 ${group} 子对象`);
  const names = [];
  for (const line of m[1].split("\n")) {
    const p = line.match(/^    ([A-Za-z_][A-Za-z0-9_]*)\??:/);
    if (p) names.push(p[1]);
  }
  return names;
}

test("T3.1 WfState 顶层字段名集快照锁（新字段须显式登记）", () => {
  const expected = [
    // 元数据/查询投影列（扁平保留：热路径/高频读）
    "sessionID", "rev", "projectID", "directory", "createdAt", "slug", "phase",
    "size", "mode", "rounds", "updatedAt", "prev", "lanes", "artifacts", "log", "logSeq", "entryErr",
    // R3 T3.1 分组子对象（A timing / B verdicts / C reuse / D delivery / 索引签名收尾 _ext）
    "timing", "verdicts", "reuse", "delivery", "_ext",
  ];
  assert.deepEqual(topProps(ifaceBody("WfState")).toSorted(), [...expected].toSorted());
});

test("T3.1 WfState 各子对象字段名集快照锁", () => {
  const body = ifaceBody("WfState");
  assert.deepEqual(subProps(body, "timing").toSorted(), ["finishedAt", "phaseDurations", "phaseEnteredAt", "startedAt"].toSorted());
  assert.deepEqual(subProps(body, "verdicts").toSorted(), ["confirmedAt", "gateStatus", "planReview", "testPlanWritten", "testReport"].toSorted());
  assert.deepEqual(subProps(body, "reuse").toSorted(), ["roleSessions", "tierBase"].toSorted());
  assert.deepEqual(subProps(body, "delivery").toSorted(), ["doneGit", "selfMod"].toSorted());
});

test("T3.1 FlowLogEntry 字段名集快照锁（from/to/rounds 显式登记；_ext 收尾）", () => {
  const expected = ["ok", "note", "cmd", "tool", "detail", "at", "from", "to", "rounds", "_ext"];
  assert.deepEqual(topProps(ifaceBody("FlowLogEntry")).toSorted(), [...expected].toSorted());
});

test("T3.1 索引签名收尾断言：types.ts 无 [key: string]: unknown", () => {
  assert.ok(!SRC.includes("[key: string]: unknown"), "索引签名必须已删除（_ext 兜底取代）");
});
