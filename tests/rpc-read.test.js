// M16-r46 批1：RPC read 方法（产物预览数据通道）服务端单测。
// 契约：file 白名单 = state.artifacts 记账 key（防路径穿越）；错误走 error 字段不抛错
// （quota 教训：抛错 client 只见 rpc.internal，原因被吞）；超 64KB 截断置 truncated。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRpcBridge } from "../server/rpc-bridge.ts";
// T04：装配收敛 helpers/host-stub
import { mkHostStub } from "./helpers/host-stub.js";

function makeBridgeDeps(tmp, st) {
  const impls = {};
  const host = mkHostStub({
    rpc: {
      register: async (_def, impl) => {
        Object.assign(impls, impl);
        return { events: { emit: async () => {} } };
      },
    },
  });
  const deps = {
    load: async () => st,
    scanStates: async () => [],
    getReport: async () => null,
    bus: { call: async () => undefined }, // R2 T2.4：runner→bus（read 桥不触 exec，inert mock）
    resolveProjectDir: async () => tmp,
  };
  return { host, deps, impls };
}

test("rpc read：记账产物命中返回 text/bytes/path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-read-"));
  fs.mkdirSync(`${tmp}/.workflow/todo`, { recursive: true });
  fs.writeFileSync(`${tmp}/.workflow/todo/plan.md`, "# 计划\n\n内容若干\n");
  const st = { slug: "todo", phase: "planning", artifacts: { "plan.md": { at: "x", bytes: 1 } } };
  const { host, deps, impls } = makeBridgeDeps(tmp, st);
  await createRpcBridge(host, deps);
  const r = await impls.read({ sessionID: "ses_1", file: "plan.md" });
  assert.equal(r.error, undefined, `命中不应带 error：${JSON.stringify(r)}`);
  assert.match(r.text, /# 计划/);
  assert.equal(r.bytes, Buffer.byteLength("# 计划\n\n内容若干\n"));
  assert.equal(r.truncated, false);
  assert.equal(r.path, `${tmp}/.workflow/todo/plan.md`);
});

test("rpc read：未记账文件拒绝（路径穿越防护）", async () => {
  const st = { slug: "todo", phase: "planning", artifacts: { "plan.md": { at: "x", bytes: 1 } } };
  const { host, deps, impls } = makeBridgeDeps("/tmp", st);
  await createRpcBridge(host, deps);
  for (const bad of ["../secret.txt", "a/../../etc/passwd", "not-recorded.md", ""]) {
    const r = await impls.read({ sessionID: "ses_1", file: bad });
    assert.ok(r.error, `未记账 ${JSON.stringify(bad)} 应拒绝`);
    assert.equal(r.text, "");
    assert.equal(r.path, "", "拒绝时不得泄露路径");
  }
});

test("rpc read：已记账但文件缺失 → 友好 error 不抛错", async () => {
  const st = { slug: "todo", phase: "planning", artifacts: { "plan.md": { at: "x", bytes: 1 } } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-read-"));
  const { host, deps, impls } = makeBridgeDeps(tmp, st);
  await createRpcBridge(host, deps);
  const r = await impls.read({ sessionID: "ses_1", file: "plan.md" });
  assert.ok(r.error && r.error.includes("缺失"), JSON.stringify(r));
  assert.equal(r.text, "");
});

test("rpc read：超 64KB 截断置 truncated", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-read-"));
  fs.mkdirSync(`${tmp}/.workflow/big`, { recursive: true });
  const big = "x".repeat(80 * 1024);
  fs.writeFileSync(`${tmp}/.workflow/big/test-report.md`, big);
  const st = { slug: "big", phase: "testing", artifacts: { "test-report.md": { at: "x", bytes: big.length } } };
  const { host, deps, impls } = makeBridgeDeps(tmp, st);
  await createRpcBridge(host, deps);
  const r = await impls.read({ sessionID: "ses_2", file: "test-report.md" });
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 64 * 1024);
  assert.equal(r.bytes, 80 * 1024, "bytes 报真实大小而非截断后大小");
});

test("rpc read：无活动任务 / load 抛错 → error 字段不抛错", async () => {
  const { host, deps, impls } = makeBridgeDeps("/tmp", null);
  await createRpcBridge(host, deps);
  const r0 = await impls.read({ sessionID: "ses_3", file: "plan.md" });
  assert.ok(r0.error, "无状态应返回 error");
  const impls2 = {};
  const host2 = mkHostStub({ rpc: { register: async (_d, impl) => { Object.assign(impls2, impl); return { events: { emit: async () => {} } }; } } });
  const deps2 = { ...deps, load: async () => { throw new Error("boom"); } };
  await createRpcBridge(host2, deps2);
  const r1 = await impls2.read({ sessionID: "ses_4", file: "plan.md" });
  assert.ok(r1.error && r1.error.includes("boom"), JSON.stringify(r1));
});
