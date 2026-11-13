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

// ── T01（arch-r1-host-split）：静默失败摘要节（facts.swallows 条件输出）──
const mkSt = () => ({ slug: "demo", phase: "review", rounds: {}, artifacts: {}, log: [] });

test("T01 摘要节：swallows 缺省与空数组 → 输出逐字相等（存量输出不变）", () => {
  const st = mkSt();
  const base = diagnoseReport(st, { version: "TEST" });
  assert.equal(diagnoseReport(st, { version: "TEST", swallows: [] }), base);
  assert.ok(!base.includes("🔇"), "空/缺省不得新增任何行");
});

test("T01 摘要节：非空 → 🔇 头行+按 code 聚合+明细，零回显（无裸 ses_）且 msg 截 120 码点", () => {
  const st = mkSt();
  const swallows = [
    { code: "state:save-prev-read-fail", msg: "boom ses_Ab3x9QzKfT8pLm2wNv5rJd7h", at: "2026-11-13T01:02:03.000Z" },
    { code: "hint:chat-message-fail", msg: "乙".repeat(150), at: "2026-11-13T04:05:06.000Z" },
    { code: "state:save-prev-read-fail", msg: "again", at: "2026-11-13T07:08:09.000Z" },
  ];
  const r = diagnoseReport(st, { version: "TEST", swallows });
  assert.match(r, /^  🔇 静默失败（环形采样≤200）：3 条 2 类$/m);
  assert.match(r, /^    state:save-prev-read-fail ×2$/m, "按 code 计数（首现序）");
  assert.match(r, /^    hint:chat-message-fail ×1$/m);
  assert.match(r, /^    \[01:02:03\] state:save-prev-read-fail boom 〔已隐去〕$/m, "明细行：时间+code+脱敏 msg");
  assert.match(r, /^    \[07:08:09\] state:save-prev-read-fail again$/m);
  assert.ok(r.includes("乙".repeat(120)) && !r.includes("乙".repeat(121)), "msg 截 120 码点");
  assert.ok(!r.includes("ses_"), "红线6：ses_ 不进模型可见文本");
});

test("T01 摘要节：>5 条 → 明细仅最近 5 条（时序末尾）", () => {
  const st = mkSt();
  const swallows = Array.from({ length: 7 }, (_, i) => ({
    code: `t:c${i}`, msg: `m${i}x`.repeat(1), at: `2026-11-13T00:00:0${i}.000Z`,
  }));
  const r = diagnoseReport(st, { version: "TEST", swallows });
  assert.match(r, /：7 条 7 类/);
  const details = r.split("\n").filter((l) => /^    \[\d\d:\d\d:\d\d\] /.test(l));
  assert.equal(details.length, 5, "明细行 ≤5");
  assert.ok(details[0].includes("m2"), "明细=最近 5 条（丢弃最旧 m0/m1）");
  assert.ok(details[4].includes("m6"), "末条=最新");
});

test("R2 T2.3：细化 note（gate-rejected:<id>）按 base 归组 + └ 明细行；无冒号显示逐字不变", () => {
  const st = {
    sessionID: "ses_d", slug: "demo", phase: "review",
    rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, artifacts: {},
    log: [
      { at: "t1", cmd: "wf:test-design", from: "review", to: "review", ok: false, note: "gate-rejected:dual-channel" },
      { at: "t2", cmd: "wf:done", from: "testing", to: "testing", ok: false, note: "gate-rejected:acceptance" },
      { at: "t3", cmd: "wf:done", from: "testing", to: "testing", ok: false, note: "gate-rejected:acceptance" },
      { at: "t4", cmd: "wf:build", from: "review", to: "review", ok: false, note: "agent-rejected:wf/builder" },
    ],
  };
  const r = diagnoseReport(st, { version: "TEST", artifactFiles: [] });
  assert.match(r, /gate-rejected ×3：关卡前置产物未产出/, "base 归组计数（细化 note 不裂键）");
  assert.match(r, /└ dual-channel ×1/);
  assert.match(r, /└ acceptance ×2/);
  assert.match(r, /agent-rejected ×1/);
  assert.match(r, /└ wf\/builder ×1/);
});
