// tests/mock-bootstrap.test.js — P0-A（agent-phase-latency-optimization-v3.1）守卫。
// 锁两件事：① tests/_preload.js 含虚拟模块 mock bootstrap（防回退到测试文件散装自举）；
// ② 四个曾自举的测试文件不再带副本（副本=漂移源，单点化纪律）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

const preload = fs.readFileSync(new URL("./_preload.js", import.meta.url), "utf8");

test("P0-A _preload.js 含 mock bootstrap（package.json + mock-tui/mock-rpc 幂等自举）", () => {
  assert.ok(preload.includes("node_modules/@opencode/plugin/"), "bootstrap 应指向 node_modules/@opencode/plugin/（尾斜杠形态）");
  assert.ok(/existsSync\(`\$\{mockDir\}package\.json`\)/.test(preload), "幂等判定应以 package.json 落盘为准（尾斜杠拼接形态）");
  assert.ok(preload.includes("mock-rpc.js") && preload.includes("mock-tui.js"), "应写两个 mock 入口");
  assert.ok(preload.includes("0.0.0-local-mock"), "包形状与 harness 自举同源");
});

test("P0-A 存量自举副本已清零（integration/artifact-patch/artifact-register/leader-only）", () => {
  for (const f of ["integration", "artifact-patch", "artifact-register", "leader-only"]) {
    const src = fs.readFileSync(new URL(`./${f}.test.js`, import.meta.url), "utf8");
    assert.ok(!src.includes("fs.mkdirSync(mockDir"), `${f}.test.js 不得保留自举副本`);
    assert.ok(src.includes("单点化到 tests/_preload.js"), `${f}.test.js 应带指路注释`);
  }
});

test("P0-A bunfig preload 钩子指向 _preload.js（根修生效前提）", () => {
  const bunfig = fs.readFileSync(new URL("../bunfig.toml", import.meta.url), "utf8");
  assert.ok(bunfig.includes('preload = ["./tests/_preload.js"]'), "bunfig [test].preload 必须挂 _preload.js");
});
