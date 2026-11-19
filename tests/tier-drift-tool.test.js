// W15-a 工具级接线锚：wf_write_artifact plan 注册路径的体量漂移观察块——
// ①S 自报 + 双信号 plan（nodes≥5 ∧ ≥10KB）→ ⚠️ 体量漂移观察回显 + events size:drift-observe 记账；
// ②M 自报同规模合规 plan → 零回显零记账（tierOf!=='S' 恒不判）；
// ③S + 单信号 plan（多 T 小体量）→ 不判（双信号同向才触发）。
// 纯函数面见 tests/tier-audit.test.js；本文件只锁 artifact-tool 接线（mock 形状同源纪律）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js";

const DIR = "/tmp/opencode/wf-tier-drift";
const DB = `${DIR}/.workflow/wf.db`;
const F = "`".repeat(3); // 围栏（模板串内反引号转义规避）
const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const store = new Map();
  const host = mkHostStub({
    options: { probe: false, requireIntakeConfirm: false },
    location: { directory: DIR },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, remove: async (k) => { store.delete(k); }, scan: async () => ({ entries: [] }) },
    sessions: { get: async () => ({ projectID: "pi1", agent: "workflow", location: { directory: DIR } }) },
  });
  return { ctx: host.rawCtx, tools: host.toolDefs, cmds: host.cmdDefs };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const nodeRows = (n) => Array.from({ length: n }, (_, i) => `| T0${i + 1} | ${i + 1} | L0 |`).join("\n");
const probeRows = (n) => Array.from({ length: n }, (_, i) => `| T0${i + 1} | 2 | yes | strict+types=[] |`).join("\n");
const driftPlan = () => `# plan：漂移观察夹具\n\n## 环境契约（假设）\n- bun 在 PATH。\n\n${F}lane-deps\nnodes:\n| T | wave | lane |\n|---|---|---|\n${nodeRows(6)}\nedges:\n| 消费方 | 提供方 | 符号 | kind |\n|---|---|---|---|\n${F}\n\n${"x".repeat(12 * 1024)}`;
const mPlan = () => `# plan：M 合规夹具\n\n## 3. 总则\n- 下游 T 点可对共享声明文件（types/*.d.ts）做追加式扩展（只增不改不删），并在回执记录扩展行。\n\n${F}lane-deps\nnodes:\n| T | wave | lane |\n|---|---|---|\n${nodeRows(6)}\nedges:\n| 消费方 | 提供方 | 符号 | kind |\n|---|---|---|---|\n| T02 | T01 | cfg | value |\n${F}\n\n${F}probe-matrix\n| T | probe_files | cross_file_import | tsconfig_notes |\n|---|---|---|---|\n${probeRows(6)}\n${F}`;
const driftEventsOf = (sid) => {
  const d = new Database(DB);
  try {
    return d.query("SELECT entry_json FROM events WHERE session_id = ? AND json_extract(entry_json,'$.cmd')='size:drift-observe'").all(sid).length;
  } finally { try { d.close(); } catch { } }
};
const runCase = async (prefix, plan) => {
  const m = mkCtx();
  await plugin.setup(m.ctx);
  const sid = `ses_drift_${prefix || "M"}_${Math.random().toString(36).slice(2, 6)}`;
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: `${prefix} drift-observe` } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} }); // plan 注册须在 planning 相位
  const out = await tool(m).execute(
    { file: "plan.md", kind: "plan", content: plan },
    { sessionID: sid, agent: "workflow" },
  );
  return { out: String(out?.content ?? out), driftEvents: driftEventsOf(sid) };
};

test("W15-a① S 自报 + 双信号 plan → ⚠️ 回显 + size:drift-observe 记账，主路径不阻断", async () => {
  const { out, driftEvents } = await runCase("[S]", driftPlan());
  assert.match(out, /已写入 .*plan\.md/, "观察闸不阻断主路径（content 模式=已写入）");
  assert.match(out, /体量漂移观察（W15-a）/, "⚠️ 复判提示在场");
  assert.match(out, /请复判体量标记/, "复判指路在场");
  assert.equal(driftEvents, 1, "events 记账恰一条（size:drift-observe）");
});

test("W15-a② M 自报同规模合规 plan → 零漂移回显零记账（tierOf!=='S' 恒不判）", async () => {
  const { out, driftEvents } = await runCase("", mPlan());
  assert.match(out, /已写入 .*plan\.md/, "M 合规 plan 照常注册");
  assert.doesNotMatch(out, /体量漂移观察/);
  assert.equal(driftEvents, 0, "M 无豁免面可旁路，零记账");
});

test("W15-a③ S + 单信号 plan（多 T 小体量）→ 不判（双信号同向才触发）", async () => {
  const single = `# plan：单信号夹具\n\n${F}lane-deps\nnodes:\n| T | wave | lane |\n|---|---|---|\n${nodeRows(6)}\nedges:\n| 消费方 | 提供方 | 符号 | kind |\n|---|---|---|---|\n${F}\n\n小体量正文。`;
  const { out, driftEvents } = await runCase("[S]", single);
  assert.match(out, /已写入 .*plan\.md/);
  assert.doesNotMatch(out, /体量漂移观察/, "nodes 单信号不判");
  assert.equal(driftEvents, 0);
});
