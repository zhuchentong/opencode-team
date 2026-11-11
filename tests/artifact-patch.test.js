// M16-r33 P1a：wf_write_artifact patch 模式——增量修订替代全量重写
// 背景（真机取证）：implant plan.md 四写 22→16KB 迭代瘦身 ~10min 浪费；content 必须全文 →
// 修订一段也要重新生成整份。patch=[{old,new}] 精确唯一匹配、顺序应用，修订只输出变更段。
// 关键正确性：test-report patch 后 verdict 必须从**结果全文**重解析（否则 done 关卡误拦）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";

// 虚拟模块占位包自举（与 integration.test.js 同源）
const mockDir = `${import.meta.dirname}/../node_modules/@opencode/plugin`;
if (!fs.existsSync(mockDir)) {
  fs.mkdirSync(mockDir, { recursive: true });
  fs.writeFileSync(`${mockDir}package.json`, JSON.stringify({
    name: "@opencode/plugin", version: "0.0.0-local-mock", private: true, type: "module",
    exports: { "./tui": "./mock-tui.js", "./rpc": "./mock-rpc.js" },
  }));
  fs.writeFileSync(`${mockDir}mock-tui.js`, "export const Plugin = { define: (def) => def };\n");
  fs.writeFileSync(`${mockDir}mock-rpc.js`, "export const Rpc = { define: (def) => def };\n");
}

const DIR = "/tmp/opencode/wf-patch";
const DB = `${DIR}/.workflow/wf.db`;

const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const store = new Map();
  const tools = [];
  const cmds = [];
  const ctx = {
    options: { probe: false },
    location: { directory: DIR },
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
      scan: async () => ({ entries: [] }),
    },
    session: {
      get: async () => ({ projectID: "pi1", location: { directory: DIR } }),
      wait: async () => {},
      prompt: async () => {},
      hook: async () => ({ dispose() {} }),
      instructions: { entry: { put: async () => {}, list: async () => [], remove: async () => {} } },
    },
    tool: {
      transform: (fn) => { fn({ add: (d) => tools.push(d), list: () => tools.map((t) => ({ name: t.name })) }); return { dispose() {} }; },
      hook: () => ({ dispose() {} }),
    },
    command: { transform: (fn) => { fn({ add: (d) => cmds.push(d) }); return { dispose() {} }; } },
  };
  return { ctx, tools, cmds };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (sid) => {
  const d = new Database(DB);
  try {
    const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid);
    return row ? JSON.parse(row.state_json) : undefined;
  } finally { try { d.close(); } catch { } }
};
const fileOf = (slug, file) => `${DIR}/.workflow/${slug}/${file}`;
const read = (slug, file) => fs.readFileSync(fileOf(slug, file), "utf8");

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

test("M16-r33 patch：首写 content→patch 命中更新文件与记账；审计打 mode=patch", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_p1";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "patch-demo" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  const w = await tool(m).execute({ kind: "plan", content: "# 计划\n\n## 风险\n\n旧风险描述\n" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(w.content, /已写入/);
  // patch 命中：只输出变更段
  const p = await tool(m).execute({ kind: "plan", patch: [{ old: "旧风险描述", new: "新风险描述（已缓解）" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(p.content, /已写入/);
  assert.match(read("patch-demo", "plan.md"), /新风险描述（已缓解）/);
  assert.ok(!/旧风险描述/.test(read("patch-demo", "plan.md")), "old 段应被替换");
  // 记账 bytes 按结果重算
  const st = stOf(sid);
  assert.equal(st.artifacts["plan.md"].bytes, fs.statSync(fileOf("patch-demo", "plan.md")).size);
  // 审计打标 mode=patch（可诊断增量修订）
  const last = st.log.filter((e) => e.cmd === "tool:wf_write_artifact").at(-1);
  assert.match(String(last.note), /mode=patch/);
  dispose?.();
});

test("M16-r33 patch：未命中/歧义/目标不存在/双缺/双给 → 报错且不落盘", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_p2";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "patch-err" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  // 目标不存在（首写必须 content）
  const noFile = await tool(m).execute({ kind: "plan", patch: [{ old: "a", new: "b" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(noFile.content, /❌/);
  assert.match(noFile.content, /不存在/);
  assert.ok(!fs.existsSync(fileOf("patch-err", "plan.md")));
  // 双缺
  const neither = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(neither.content, /❌/);
  // 双给
  const both = await tool(m).execute({ kind: "plan", content: "x", patch: [{ old: "a", new: "b" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(both.content, /❌/);
  // 首写后：未命中
  await tool(m).execute({ kind: "plan", content: "alpha\nbeta\n" }, { sessionID: sid, agent: "wf/planner" });
  const before = read("patch-err", "plan.md");
  const miss = await tool(m).execute({ kind: "plan", patch: [{ old: "不存在的段落", new: "x" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(miss.content, /❌/);
  assert.match(miss.content, /未命中/);
  assert.equal(read("patch-err", "plan.md"), before, "未命中不落盘");
  // 歧义（old 出现两次）
  await tool(m).execute({ kind: "plan", content: "dup\ndup\n" }, { sessionID: sid, agent: "wf/planner" });
  const amb = await tool(m).execute({ kind: "plan", patch: [{ old: "dup", new: "x" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(amb.content, /❌/);
  assert.match(amb.content, /歧义/);
  assert.equal(read("patch-err", "plan.md"), "dup\ndup\n", "歧义不落盘");
  dispose?.();
});

test("M16-r33 patch：多补丁顺序应用（后条匹配前条结果）；old==new 幂等", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_p3";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "patch-seq" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "plan", content: "A1\nB1\n" }, { sessionID: sid, agent: "wf/planner" });
  const p = await tool(m).execute({
    kind: "plan",
    patch: [
      { old: "A1", new: "A2" },
      { old: "A2", new: "A3" }, // 依赖前条结果
      { old: "B1", new: "B1" }, // 幂等跳过
    ],
  }, { sessionID: sid, agent: "wf/planner" });
  assert.match(p.content, /已写入/);
  assert.equal(read("patch-seq", "plan.md"), "A3\nB1\n");
  dispose?.();
});

test("M16-r33 patch：test-report verdict 从结果重解析——FAIL→patch 改 PASS 后 done 关卡放行", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_p4";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "patch-verdict" } });
  // 直推 testing（测试只关心 verdict 记账链路）
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "test-plan", content: "# 用例" }, { sessionID: sid, agent: "wf/tester" });
  await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:reconcile").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review-build").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:test").execute({ sessionID: sid, prompt: {} });
  // 首写 FAIL
  await tool(m).execute({ kind: "test-report", content: "**结论**: FAIL\n\n用例 X 失败\n" }, { sessionID: sid, agent: "wf/tester" });
  assert.equal(stOf(sid).testReportVerdict, "FAIL");
  const rej = await cmd(m, "wf:done").execute({ sessionID: sid, prompt: {} });
  assert.match(rej, /验收关卡未过/);
  // patch 只改结论行 → verdict 必须从结果重解析为 PASS
  const p = await tool(m).execute({ kind: "test-report", patch: [{ old: "**结论**: FAIL", new: "**结论**: PASS" }] }, { sessionID: sid, agent: "wf/tester" });
  assert.match(p.content, /已写入/);
  assert.equal(stOf(sid).testReportVerdict, "PASS", "patch 后 verdict 应从结果重解析");
  assert.match(p.content, /验收 PASS/, "verdict 指路应基于重解析结果");
  const ok = await cmd(m, "wf:done").execute({ sessionID: sid, prompt: {} });
  assert.match(ok, /【wf 工作流｜done】/);
  dispose?.();
});

test("M16-r33 patch：test-plan patch 保持 testPlanWritten；轮次编号文件 plan-review-r1 可 patch", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_p5";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "patch-round" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "test-plan", content: "# 用例\n\n旧用例\n" }, { sessionID: sid, agent: "wf/tester" });
  await tool(m).execute({ kind: "test-plan", patch: [{ old: "旧用例", new: "新用例" }] }, { sessionID: sid, agent: "wf/tester" });
  assert.equal(stOf(sid).testPlanWritten, true, "test-plan patch 后旗标保持");
  assert.match(read("patch-round", "test-plan.md"), /新用例/);
  // 轮次编号文件：review r1 写 plan-review-r1.md 后 patch
  await tool(m).execute({ kind: "plan-review", content: "# 审核\n\n问题A\n" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  const p = await tool(m).execute({ kind: "plan-review", patch: [{ old: "问题A", new: "问题A（已销项）" }] }, { sessionID: sid, agent: "wf/planner-reviewer" });
  assert.match(p.content, /已写入/);
  assert.match(read("patch-round", "plan-review-r1.md"), /问题A（已销项）/);
  dispose?.();
});

test("M16-r33 tier：S 级预算收紧——6KB plan 在 S 级告警、M 级不告警（字节计）", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  // S 级任务：intake 前缀 [S]
  const sidS = "ses_ps";
  const rS = await cmd(m, "wf:intake").execute({ sessionID: sidS, prompt: { text: "[S] small-task" } });
  assert.match(rS, /slug=small-task/);
  assert.equal(stOf(sidS).size, "S");
  await cmd(m, "wf:plan").execute({ sessionID: sidS, prompt: {} });
  const sixKb = "x".repeat(6 * 1024);
  const wS = await tool(m).execute({ kind: "plan", content: sixKb }, { sessionID: sidS, agent: "wf/planner" });
  assert.match(wS.content, /超瘦身预算/, "S 级 plan 预算 5KB，6KB 应告警");
  // M 级对照：同体积不告警（M 预算 15KB）
  const sidM = "ses_pm";
  await cmd(m, "wf:intake").execute({ sessionID: sidM, prompt: { text: "mid-task" } });
  assert.equal(stOf(sidM).size, "M", "缺省体量=M");
  await cmd(m, "wf:plan").execute({ sessionID: sidM, prompt: {} });
  const wM = await tool(m).execute({ kind: "plan", content: sixKb }, { sessionID: sidM, agent: "wf/planner" });
  assert.ok(!/超瘦身预算/.test(wM.content), "M 级 6KB 在预算内不告警");
  // S 级 guidance 渲染 S 预算 + 从简指引
  assert.match(rS, /\[S\]\/\[M\]\/\[L\]|体量/, "intake guidance 应含体量分级指引");
  dispose?.();
});