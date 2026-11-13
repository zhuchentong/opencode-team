// T01（arch-r1-host-split）：静默 catch 清零守卫。
// 口径与全 plan audit 一致：括号配对后「空体或仅注释体」= 静默 catch；
// 残余 ≤3 且全部位于 observe.ts 探针路径（:21/:37/:53，探针失败本身属观测通道，排除防自我触发）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

// 括号配对扫描：返回静默 catch 的起始行号数组（口径=audit 脚本）
function silentCatches(src) {
  const hits = [];
  let i = 0;
  while ((i = src.indexOf("catch", i)) >= 0) {
    if (i > 0 && /[\w$.]/.test(src[i - 1])) { i += 5; continue; }
    let p = i + 5;
    while (p < src.length && /\s/.test(src[p])) p++;
    if (src[p] === "(") { p = src.indexOf(")", p) + 1; }
    while (p < src.length && /\s/.test(src[p])) p++;
    if (src[p] !== "{") { i += 5; continue; }
    let depth = 0, q = p;
    for (; q < src.length; q++) {
      if (src[q] === "{") depth++;
      else if (src[q] === "}") { depth--; if (depth === 0) break; }
    }
    const body = src.slice(p + 1, q);
    const stripped = body.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (stripped === "") hits.push(src.slice(0, i).split("\n").length);
    i = q;
  }
  return hits;
}

const serverDir = new URL("../server/", import.meta.url);

test("T01 静默 catch 清零：server/*.ts 空体/仅注释体 catch 总数 ≤3 且全在 observe.ts 探针路径", () => {
  const files = fs.readdirSync(serverDir).filter((f) => f.endsWith(".ts")).sort();
  const report = [];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, serverDir), "utf8");
    const hits = silentCatches(src);
    if (f === "observe.ts") {
      assert.equal(hits.length, 3, `observe.ts 探针路径应恰好保留 3 处静默 catch`);
      // 定位=探针路径（createObserver 内，基线 :21/:37/:53，实现加行后以区域锚判定）
      const anchor = src.split("\n").findIndex((l) => l.startsWith("export function createObserver"));
      assert.ok(anchor > 0 && hits.every((ln) => ln > anchor + 1), "残余 3 处须全部位于 createObserver 探针路径");
    } else {
      assert.equal(hits.length, 0, `${f} 静默 catch 必须清零，命中行：${hits.join(",")}`);
    }
    if (hits.length) report.push(`${f}:${hits.join(",")}`);
  }
  assert.ok(report.every((r) => r.startsWith("observe.ts")), "全部静默 catch 仅限 observe.ts");
});

test("T01 commands.ts 接线：diagnoseReport 调用携带 swallows: listSwallows()（import 同源 observe）", () => {
  const src = fs.readFileSync(new URL("commands.ts", serverDir), "utf8");
  assert.match(src, /swallows:\s*listSwallows\(\)/, "facts 对象须带 swallows");
  assert.match(src, /import\s*\{[^}]*\blistSwallows\b[^}]*\}\s*from\s*"\.\/observe\.ts"/s, "listSwallows 从 observe 导入");
  assert.match(src, /import\s*\{[^}]*\bswallow\b[^}]*\}\s*from\s*"\.\/observe\.ts"/s, "swallow 从 observe 导入");
});

test("T01 替换语义等价锚：swallow 调用 code 命名=<file基名>:<kebab语义>（抽查全文件形态）", () => {
  const files = fs.readdirSync(serverDir).filter((f) => f.endsWith(".ts"));
  const re = /swallow\(\s*[\w$]+\s*,\s*"([a-z0-9-]+:[a-z0-9-]+)"\s*\)/g;
  let n = 0;
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, serverDir), "utf8");
    for (const m of src.matchAll(re)) {
      const base = f.replace(/\.ts$/, "");
      assert.equal(m[1].split(":")[0], base, `${f} 的 code 前缀须=文件基名：${m[1]}`);
      n++;
    }
  }
  assert.ok(n >= 60, `swallow 调用点应覆盖替换规模（实测 ${n}，≥60；66 处替换允许后续任务合并减点）`);
});
