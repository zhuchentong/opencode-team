// P1：wf:diagnose 报告纯函数 + entry 注入值测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseReport } from "../server/lib.ts";
import { entryValue, DONE_ENTRY } from "../server/guidance.ts"; // M16-r39 T08：guidance 拆分

test("entryValue：非 done 阶段 = 头行 + 完整 guidance（抗 compaction 的注入面）", () => {
  const st = {
    sessionID: "s", slug: "demo", phase: "planning",
    rounds: { plan_review: 1, build_review: 0, test_fix: 0 },
  };
  const v = entryValue(st);
  assert.match(v, /phase=planning slug=demo rounds=/, "head 行保留（易变区殿后）");
  assert.ok(v.indexOf("禁止修改业务代码") < v.lastIndexOf("phase=planning"), "易变区纪律：静态指引在前、易变 head 殿后");
  assert.ok(v.includes("禁止修改业务代码"), "guidance 正文进入 entry");
  assert.ok(v.includes(`wf_command(name="wf:review")`), "下一步指引进入 entry（T06：工具推进格式）");
});

test("entryValue：done 终态只留一行提示（不长期占用系统提示）", () => {
  const v = entryValue({ phase: "done", slug: "demo", rounds: {} });
  assert.ok(v.includes(DONE_ENTRY));
  assert.ok(!v.includes("禁止修改业务代码"));
});

test("entryValue：rounds 缺失不崩", () => {
  assert.doesNotThrow(() => entryValue({ phase: "review", slug: "x" }));
});

const mkLog = () => ([
  { at: "t1", cmd: "wf:intake", from: null, to: "intake", ok: true },
  { at: "t2", cmd: "wf:review", from: "building", to: "building", ok: false, note: "illegal-transition" },
  { at: "t3", cmd: "wf:review", from: "building", to: "building", ok: false, note: "illegal-transition" },
  { at: "t4", cmd: "wf:test-design", from: "review", to: "review", ok: false, note: "gate-rejected" },
  { at: "t5", cmd: "gate:block", tool: "edit", detail: "src/app.tsx", from: "planning", to: "planning", ok: false, note: "blocked" },
  { at: "t6", cmd: "gate:block", tool: "shell", detail: "out.txt", from: "planning", to: "planning", ok: false, note: "blocked" },
]);

test("diagnoseReport：拒绝分类计数 + 阻断取证 + 上限告警 + 关卡状态", () => {
  const st = {
    slug: "demo", phase: "review", updatedAt: "2026-11-10T00:00:00Z",
    rounds: { plan_review: 3, build_review: 0, test_fix: 0 },
    artifacts: { "plan.md": { at: "t", bytes: 100 }, "test-plan.md": { at: "t", bytes: 50 } },
    testPlanWritten: false, testReportVerdict: null,
    log: mkLog(),
  };
  const r = diagnoseReport(st, { version: "TEST", artifactFiles: ["plan.md"] });
  assert.match(r, /拒绝=3 越权阻断=2/);
  assert.match(r, /illegal-transition ×2.*命令顺序错误/);
  assert.match(r, /gate-rejected ×1.*关卡前置产物未产出/);
  assert.match(r, /⛔ 越权阻断：edit src\/app\.tsx/);
  assert.match(r, /⛔ 越权阻断：shell out\.txt/);
  assert.match(r, /plan_review 已 3\/3 轮/);
  assert.match(r, /testPlan=❌ 未产出/);
  assert.match(r, /记账但磁盘缺失：test-plan\.md/); // artifacts 记账但 readdir 只有 plan.md
  assert.match(r, /下一步：\/wf:test-design/);
});

test("diagnoseReport：产物对账一致 + 注入异常上报", () => {
  const st = {
    slug: "demo", phase: "testing", rounds: {},
    artifacts: { "test-report.md": { at: "t", bytes: 10 } },
    testReportVerdict: "UNKNOWN", entryErr: "entry API down",
    log: [],
  };
  const r = diagnoseReport(st, { version: "TEST", artifactFiles: ["test-report.md"] });
  assert.match(r, /✅ 产物对账一致/);
  assert.ok(!r.includes("⚠️ 记账但磁盘缺失"));
  assert.match(r, /阶段注入失败.*entry API down/);
  assert.match(r, /testReport=UNKNOWN/);
});

test("diagnoseReport：磁盘存在但未经工具记账的 kind 产物 → 提示未记账", () => {
  const st = { slug: "demo", phase: "review", rounds: { plan_review: 1 }, artifacts: {}, log: [] };
  const r = diagnoseReport(st, { version: "TEST", artifactFiles: ["plan-review-r1.md"] });
  assert.match(r, /磁盘有但未记账：plan-review-r1\.md/);
});

test("diagnoseReport：非 .md 文件与 kind 外产物不参与对账噪音", () => {
  const st = { slug: "d", phase: "done", rounds: {}, artifacts: {}, log: [] };
  const r = diagnoseReport(st, { version: "TEST", artifactFiles: ["notes.txt", "_debug"] });
  assert.match(r, /✅ 产物对账一致/);
});
