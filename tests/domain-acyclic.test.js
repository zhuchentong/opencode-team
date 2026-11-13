// T02（arch-r1-host-split）：server/domain/ 拆分结构守卫——静态读源码扫 import（不加载模块），4 规则。
// 规则①'：domain 内部边 ⊆ {任意→types.ts} ∪ {diagnose→flow,artifact,session}（§0 实测白名单=diagnoseReport
//         消费 nextFor/KIND_FILES/SID_ALIAS_USAGE 的最小集，其余互不 import）。
// 规则②：types.ts 零依赖叶子——除 node 内置外零 import。
// 规则③：domain 禁 import 编排/接线层（state/commands/guidance/hint/observe/roles/skills/rpc-bridge/
//         model-tier/lib/index/managed-sync/tui）；允许 shared/* 平级。
// 规则④：实际边集拓扑排序成功=无环。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

const domainDir = new URL("../server/domain/", import.meta.url);
const FILES = ["types.ts", "flow.ts", "guard.ts", "artifact.ts", "session.ts", "report.ts", "policy.ts", "diagnose.ts"];

// 粗筛（允许误报=plan §T02 口径）：from "..." 与副作用 import "..."
function importsOf(src) {
  return [...src.matchAll(/(?:\bfrom|\bimport)\s*"([^"]+)"/g)].map((m) => m[1]);
}

test("T02 domain/ 八文件齐全", () => {
  const have = fs.readdirSync(domainDir).filter((f) => f.endsWith(".ts")).toSorted();
  assert.deepEqual(have, [...FILES].toSorted());
});

test("规则①'：domain 内部边 ⊆ {任意→types} ∪ {diagnose→flow,artifact,session}", () => {
  for (const f of FILES) {
    const src = fs.readFileSync(new URL(f, domainDir), "utf8");
    const dom = importsOf(src).filter((s) => s.startsWith("./"));
    for (const d of dom) {
      const target = d.replace(/^\.\//, "");
      const allowed = target === "types.ts" ||
        (f === "diagnose.ts" && ["flow.ts", "artifact.ts", "session.ts"].includes(target));
      assert.ok(allowed, `非法 domain 内部边：${f} → ${target}`);
      assert.ok(FILES.includes(target), `${f} import 了未知 domain 文件：${target}`);
    }
  }
});

test("规则②：types.ts 零依赖叶子（除 node 内置外零 import，且实际连 node 都不需要）", () => {
  const src = fs.readFileSync(new URL("types.ts", domainDir), "utf8");
  const bad = importsOf(src).filter((s) => !s.startsWith("node:"));
  assert.deepEqual(bad, [], "types.ts 不得 import 任何非 node 内置模块");
});

test("规则③：domain 禁 import 编排/接线层（shared/* 平级允许）", () => {
  for (const f of FILES) {
    const src = fs.readFileSync(new URL(f, domainDir), "utf8");
    const bad = importsOf(src).filter((s) => s.startsWith("../") && !/^\.\.(\/\.\.)*\/shared\//.test(s));
    assert.deepEqual(bad, [], `${f} 不得 import domain/shared 之外模块（编排层或 tui）`);
  }
});

test("规则④：实际边集拓扑排序成功（无环）", () => {
  const edges = {}; // f → 其依赖的 domain 文件
  for (const f of FILES) {
    const src = fs.readFileSync(new URL(f, domainDir), "utf8");
    edges[f] = importsOf(src).filter((s) => s.startsWith("./")).map((s) => s.replace(/^\.\//, ""));
  }
  // Kahn：剩余依赖数 indeg[f]=|edges[f]|；队列=依赖清零者（叶子 types 起步）
  const rem = Object.fromEntries(FILES.map((f) => [f, edges[f].length]));
  let queue = FILES.filter((f) => rem[f] === 0);
  let done = 0;
  while (queue.length) {
    const n = queue.shift();
    done++;
    for (const f of FILES) if (edges[f].includes(n) && --rem[f] === 0) queue.push(f);
  }
  assert.equal(done, FILES.length, "依赖图存在环");
});
