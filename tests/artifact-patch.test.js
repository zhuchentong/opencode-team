// M16-r33 P1a：wf_write_artifact patch 模式——增量修订替代全量重写
// 背景（真机取证）：implant plan.md 四写 22→16KB 迭代瘦身 ~10min 浪费；content 必须全文 →
// 修订一段也要重新生成整份。patch=[{old,new}] 精确唯一匹配、顺序应用，修订只输出变更段。
// 关键正确性：test-report patch 后 verdict 必须从**结果全文**重解析（否则 done 关卡误拦）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js"; // T04：装配收敛（_ctx=setup(ctx) 消费者视图）

// 虚拟模块占位包自举已单点化到 tests/_preload.js（P0-A，latency-v3.1）——本文件不再自举（副本=漂移源）。

const DIR = "/tmp/opencode/wf-patch";
const DB = `${DIR}/.workflow/wf.db`;

const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const store = new Map();
  let hookFn = null;
  // T04：装配收敛 helpers/host-stub（store=旧 storage 迁移源形状保持；put/list 走 stub 缺省 inert）
  const host = mkHostStub({
    options: { probe: false },
    location: { directory: DIR },
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
      scan: async () => ({ entries: [] }),
    },
    sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }) },
    tools: { hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
  });
  return { ctx: host._ctx, tools: host._toolDefs, cmds: host._cmdDefs, hook: () => hookFn };
};
// M16-r44：方案确认交互模拟（leader question，选项含锚定批准标签）
const confirm = (m, sid) => m.hook()({ tool: "question", sessionID: sid, agent: "workflow",
  input: { questions: [{ question: "方案确认", header: "方案确认", options: [{ label: "批准执行" }, { label: "修改方案" }, { label: "终止任务" }] }] } }, {});
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
  // 双缺=M16-r47 起为 register 模式：目标不存在 → ❌ 含期望路径（原「须提供 content 或 patch」报错分支已让位）
  const neither = await tool(m).execute({ kind: "plan" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(neither.content, /❌/);
  assert.match(neither.content, /register 目标不存在/);
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
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "[FULL] patch-verdict" } }); // M16-r34：完整流（test-design/reconcile/review-build）
  // 直推 testing（测试只关心 verdict 记账链路）
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  await tool(m).execute({ kind: "test-plan", content: "# 用例" }, { sessionID: sid, agent: "wf/tester" });
  await cmd(m, "wf:test-design").execute({ sessionID: sid, prompt: {} });
  await confirm(m, sid); // M16-r44：wf:build 关卡须方案确认（test_design 窗口）
  await cmd(m, "wf:build").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:reconcile").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:review-build").execute({ sessionID: sid, prompt: {} });
  await cmd(m, "wf:test").execute({ sessionID: sid, prompt: {} });
  // 首写 FAIL
  await tool(m).execute({ kind: "test-report", content: "**结论**: FAIL\n\n用例 X 失败\n" }, { sessionID: sid, agent: "wf/tester" });
  assert.equal(stOf(sid).verdicts?.testReport, "FAIL");
  const rej = await cmd(m, "wf:done").execute({ sessionID: sid, prompt: {} });
  assert.match(rej, /验收关卡未过/);
  // patch 只改结论行 → verdict 必须从结果重解析为 PASS
  const p = await tool(m).execute({ kind: "test-report", patch: [{ old: "**结论**: FAIL", new: "**结论**: PASS" }] }, { sessionID: sid, agent: "wf/tester" });
  assert.match(p.content, /已写入/);
  assert.equal(stOf(sid).verdicts?.testReport, "PASS", "patch 后 verdict 应从结果重解析");
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
  assert.equal(stOf(sid).verdicts?.testPlanWritten, true, "test-plan patch 后旗标保持");
  assert.match(read("patch-round", "test-plan.md"), /新用例/);
  // 轮次编号文件：review r1 写 plan-review-r1.md 后 patch
  await tool(m).execute({ kind: "plan-review", content: "# 审核\n\n问题A\n" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  const p = await tool(m).execute({ kind: "plan-review", patch: [{ old: "问题A", new: "问题A（已销项）" }] }, { sessionID: sid, agent: "wf/planner-reviewer" });
  assert.match(p.content, /已写入/);
  assert.match(read("patch-round", "plan-review-r1.md"), /问题A（已销项）/);
  dispose?.();
});

test("M16-r33 tier：S 级预算收紧——11KB plan 在 S 级告警、M 级不告警（字节计）", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  // S 级任务：intake 前缀 [S]
  const sidS = "ses_ps";
  const rS = await cmd(m, "wf:intake").execute({ sessionID: sidS, prompt: { text: "[S] small-task" } });
  assert.match(rS, /slug=small-task/);
  assert.equal(stOf(sidS).size, "S");
  await cmd(m, "wf:plan").execute({ sessionID: sidS, prompt: {} });
  const elevenKb = "x".repeat(11 * 1024);
  const wS = await tool(m).execute({ kind: "plan", content: elevenKb }, { sessionID: sidS, agent: "wf/planner" });
  assert.match(wS.content, /超瘦身预算/, "S 级 plan 预算 10KB，11KB 应告警");
  // M 级对照：同体积不告警（M 预算 20KB）
  const sidM = "ses_pm";
  await cmd(m, "wf:intake").execute({ sessionID: sidM, prompt: { text: "mid-task" } });
  assert.equal(stOf(sidM).size, "M", "缺省体量=M");
  await cmd(m, "wf:plan").execute({ sessionID: sidM, prompt: {} });
  const wM = await tool(m).execute({ kind: "plan", content: elevenKb }, { sessionID: sidM, agent: "wf/planner" });
  assert.ok(!/超瘦身预算/.test(wM.content), "M 级 11KB 在预算内不告警");
  // S 级 guidance 渲染 S 预算 + 从简指引
  assert.match(rS, /\[S\]\/\[M\]\/\[L\]|体量/, "intake guidance 应含体量分级指引");
  dispose?.();
});

// ── M16-r47（A+B）：patch 模糊回退——转录微差从「失败→全量重写」降为「直接命中」──────
test("M16-r47 fuzzy：exact 命中仍 mode=patch；引号/破折号变体回退命中并打 mode=patch-fuzzy", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_f1";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "fuzzy-demo" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  // 盘上：弯引号 + 破折号（模型转录常写成直引号/连字符）
  await tool(m).execute({ kind: "plan", content: "他说\u201C保留\u201D——风险与\u2018未知\u2019项\n其余内容\n" }, { sessionID: sid, agent: "wf/planner" });
  const exact = await tool(m).execute({ kind: "plan", patch: [{ old: "其余内容", new: "其他内容" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(exact.content, /已写入/);
  const stX = stOf(sid);
  assert.equal(String(stX.log.filter((e) => e.cmd === "tool:wf_write_artifact").at(-1).note), "plan.md mode=patch", "exact 命中不打 fuzzy");
  // 转录微差：old 用直引号/连字符（严格未命中 → 1:1 归一回退命中）
  const typo = await tool(m).execute({ kind: "plan", patch: [{ old: '他说"保留"--风险', new: "他说「调整」-风险" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(typo.content, /已写入/, "typo 归一后应命中");
  assert.match(read("fuzzy-demo", "plan.md"), /他说「调整」-风险/, "命中区间应正确替换（含原文弯引号段）");
  const stF = stOf(sid);
  assert.match(String(stF.log.filter((e) => e.cmd === "tool:wf_write_artifact").at(-1).note), /mode=patch-fuzzy/, "fuzzy 命中审计打标");
  dispose?.();
});

test("M16-r47 fuzzy：行尾空白回退命中；归一后歧义报错不落盘；三阶段全 miss 仍报错", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_f2";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "fuzzy-ws" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} });
  // 盘上行尾有不可见空白，模型转录省略
  await tool(m).execute({ kind: "plan", content: "第一行   \n第二行\t\n尾部\n" }, { sessionID: sid, agent: "wf/planner" });
  const ws = await tool(m).execute({ kind: "plan", patch: [{ old: "第一行\n第二行", new: "首行改\n次行改" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(ws.content, /已写入/, "行尾空白剥离后应命中");
  const after = read("fuzzy-ws", "plan.md");
  assert.match(after, /首行改\n次行改/);
  assert.match(after, /尾部/, "替换不应吞掉后续内容");
  // 归一后歧义：盘上 em/en dash 各一，归一后同串
  await tool(m).execute({ kind: "plan", content: "a\u2014b 与 a\u2013b\n" }, { sessionID: sid, agent: "wf/planner" });
  const amb = await tool(m).execute({ kind: "plan", patch: [{ old: "a-b", new: "x" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(amb.content, /❌/);
  assert.match(amb.content, /歧义/);
  assert.equal(read("fuzzy-ws", "plan.md"), "a\u2014b 与 a\u2013b\n", "歧义不落盘");
  // 三阶段全 miss
  const miss = await tool(m).execute({ kind: "plan", patch: [{ old: "完全无关的段落内容", new: "x" }] }, { sessionID: sid, agent: "wf/planner" });
  assert.match(miss.content, /未命中/);
  dispose?.();
});