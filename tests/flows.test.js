// P0-b：流转状态机测试——来源合法性 / GATES / 计数器「进入即计数」/ intake 守卫与重置
import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOWS, LIMITS, evaluateTransition } from "../server/lib.ts";
import { mkWiringHarness as mkWiring } from "./helpers/wiring.js"; // T04：装配同源（harness 参数化包装）

const mkSt = (phase = null, extra = {}) => ({
  sessionID: "ses_test",
  slug: "",
  phase,
  rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
  lanes: {},
  artifacts: {},
  ...extra,
});

const advance = (st, cmd, text, at) => {
  const r = evaluateTransition(cmd, st, text, at);
  if (r.ok) st.phase = FLOWS[cmd].to;
  return r;
};

test("FLOWS 全表正向流转链（主路径，无返工；M16-r28：assign 并入 test-design）", () => {
  const st = mkSt();
  const steps = ["wf:intake", "wf:plan", "wf:review", "wf:test-design",
    "wf:build", "wf:reconcile", "wf:review-build", "wf:test", "wf:done"];
  for (const cmd of steps) {
    if (cmd === "wf:test-design") st.testPlanWritten = true; // gate 前置条件
    if (cmd === "wf:build") st.planConfirmedAt = "2026-01-01T00:00:00Z"; // M16-r44：方案确认关卡前置条件
    if (cmd === "wf:done") st.testReportVerdict = "PASS"; // gate 前置条件
    const r = advance(st, cmd, "[FULL] demo-task"); // M16-r34：本测试验证完整 9 阶段流，显式 [FULL]
    assert.equal(r.ok, true, `${cmd} 应通过：${JSON.stringify(r)}`);
  }
  assert.equal(st.phase, "done");
});

test("非法来源被拒（building 状态不可直接 wf:test）", () => {
  const st = mkSt("building");
  const r = advance(st, "wf:test");
  assert.equal(r.ok, false);
  assert.equal(r.note, "illegal-transition");
  assert.match(r.msg, /不能从阶段「building」进入「testing」/);
  assert.match(r.msg, /下一步.*\/wf:reconcile/s);
});

test("非法来源被拒（planning 状态不可直接 wf:build）", () => {
  const st = mkSt("planning");
  const r = advance(st, "wf:build");
  assert.equal(r.ok, false);
  assert.equal(r.note, "illegal-transition");
});

test("gate-rejected：review 未产出 test-plan 时 wf:test-design 被拒（不消耗额度；M16-r28 关卡随 assign 迁移）", () => {
  const st = mkSt("review");
  const before = { ...st.rounds };
  const r = advance(st, "wf:test-design");
  assert.equal(r.ok, false);
  assert.equal(r.note, "gate-rejected");
  assert.match(r.msg, /test-plan\.md/);
  assert.match(r.msg, /wf_command\(name="wf:test-design"\)/, "拒绝文案指路新命令名");
  assert.deepEqual(st.rounds, before, "拒绝不得改变计数器");
  assert.equal(st.phase, "review", "阶段不变");
});

test("M16-r28 存量兼容：卡在 assign 阶段的在途任务可直接 wf:test-design", () => {
  const st = mkSt("assign", { testPlanWritten: true });
  const r = advance(st, "wf:test-design");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(st.phase, "test_design");
});

test("gate-rejected：testReportVerdict=FAIL 时 wf:done 被拒", () => {
  const st = mkSt("testing", { testReportVerdict: "FAIL" });
  const r = advance(st, "wf:done");
  assert.equal(r.ok, false);
  assert.equal(r.note, "gate-rejected");
  assert.match(r.msg, /「FAIL」（要求 PASS）|「FAIL」\(要求 PASS\)/);
  assert.match(r.msg, /\/wf:fix/);
});

test("gate-rejected：testReportVerdict 缺失时 wf:done 被拒", () => {
  const st = mkSt("testing");
  const r = advance(st, "wf:done");
  assert.equal(r.ok, false);
  assert.match(r.msg, /未产出/);
});

test("计数器「进入即计数」：review 首入=1，重复递增，达 LIMITS 拒绝", () => {
  const st = mkSt("planning");
  assert.equal(advance(st, "wf:review").ok, true);
  assert.equal(st.rounds.plan_review, 1, "首次进入=1");
  assert.equal(st.phase, "review");
  // 返工边 review→plan 不消耗额度
  assert.equal(advance(st, "wf:plan").ok, true);
  assert.equal(st.rounds.plan_review, 1, "wf:plan 无计数器");
  assert.equal(advance(st, "wf:review").ok, true);
  assert.equal(st.rounds.plan_review, 2);
  assert.equal(advance(st, "wf:plan").ok, true);
  assert.equal(advance(st, "wf:review").ok, true);
  assert.equal(st.rounds.plan_review, 3);
  assert.equal(st.rounds.plan_review, LIMITS.plan_review, "达上限");
  const r = advance(st, "wf:plan");
  assert.equal(r.ok, true);
  const r4 = advance(st, "wf:review");
  assert.equal(r4.ok, false);
  assert.equal(r4.note, "limit-exceeded");
  assert.equal(st.rounds.plan_review, 3, "拒绝不递增");
  assert.match(r4.msg, /plan_review 已 3\/3 轮/);
});

test("计数器独立：build_review 与 test_fix 各自计数", () => {
  const st = mkSt("test_design", { planConfirmedAt: "2026-01-01T00:00:00Z" }); // M16-r44：wf:build 关卡前置
  assert.equal(advance(st, "wf:build").ok, true);
  assert.equal(advance(st, "wf:reconcile").ok, true);
  assert.equal(advance(st, "wf:review-build").ok, true);
  assert.equal(st.rounds.build_review, 1);
  assert.equal(st.rounds.plan_review, 0, "plan_review 不受影响");
  // testing → fixing → testing → fixing：test_fix 递增
  assert.equal(advance(st, "wf:test").ok, true);
  st.testReportVerdict = "FAIL";
  assert.equal(advance(st, "wf:fix").ok, true);
  assert.equal(st.rounds.test_fix, 1);
  assert.equal(advance(st, "wf:test").ok, true);
  assert.equal(advance(st, "wf:fix").ok, true);
  assert.equal(st.rounds.test_fix, 2);
});

test("intake-guard：活动中（非 done）intake 无 ! 前缀被拒", () => {
  const st = mkSt("planning", { slug: "old-task" });
  const r = advance(st, "wf:intake", "new-task");
  assert.equal(r.ok, false);
  assert.equal(r.note, "intake-guard");
  assert.match(r.msg, /已有活动任务.*old-task/);
  assert.match(r.msg, /\/wf:reset/);
  assert.equal(st.slug, "old-task", "slug 不变");
});

test("intake 强制（! 前缀）：重置 rounds/artifacts/gate 记账并留 prev", () => {
  const st = mkSt("building", {
    slug: "old-task",
    artifacts: { "plan.md": { bytes: 10 } },
    testPlanWritten: true,
    testReportVerdict: "FAIL",
    updatedAt: "2026-11-09T00:00:00.000Z",
  });
  const r = advance(st, "wf:intake", "!New Task");
  assert.equal(r.ok, true);
  assert.equal(st.slug, "new-task", "slugify 后小写连字符");
  assert.deepEqual(st.rounds, { plan_review: 0, build_review: 0, test_fix: 0 }, "计数器重置");
  assert.deepEqual(st.artifacts, {}, "产物记账重置");
  assert.equal(st.testPlanWritten, undefined, "test-plan 记账清除");
  assert.equal(st.testReportVerdict, undefined, "verdict 记账清除");
  assert.deepEqual(st.prev, { slug: "old-task", phase: "building", at: "2026-11-09T00:00:00.000Z" });
});

test("intake 从 done 重开：允许且重置", () => {
  const st = mkSt("done", { slug: "finished", testReportVerdict: "PASS" });
  const r = advance(st, "wf:intake", "next-thing");
  assert.equal(r.ok, true);
  assert.equal(st.slug, "next-thing");
  assert.equal(st.testReportVerdict, undefined);
  assert.equal(st.prev.slug, "finished");
  assert.equal(st.prev.phase, "done");
  assert.ok(st.prev.at, "prev.at 记录时间");
});

test("intake 首次（无阶段）：设置 slug；空文本回退 untitled", () => {
  const st = mkSt();
  assert.equal(advance(st, "wf:intake", "My Cool Feature!").ok, true);
  assert.equal(st.slug, "my-cool-feature");
  const st2 = mkSt();
  assert.equal(advance(st2, "wf:intake", "").ok, true);
  assert.equal(st2.slug, "untitled");
  const st3 = mkSt();
  assert.equal(advance(st3, "wf:intake", { text: "对象形态 slug" }).ok, true, "prompt 对象形态");
  assert.equal(st3.slug, "对象形态-slug", "T01：Unicode slug 保留中文");
});

test("intake 非重置分支下 slug 仍被新 text 覆盖（锁定现状：slugify 非空即覆盖），rounds 保留", () => {
  // from=null 且 st.slug 非空：重置分支不走，但末行 slug 赋值无条件执行
  const st = mkSt(null, { slug: "kept", rounds: { plan_review: 2, build_review: 1, test_fix: 0 } });
  const r = advance(st, "wf:intake", "ignored");
  assert.equal(r.ok, true);
  assert.equal(st.slug, "ignored", "现状：slug 无条件覆盖");
  assert.equal(st.rounds.plan_review, 2, "计数器保留");
  assert.equal(st.testPlanWritten, undefined, "记账字段未被动过");
});

test("返工边完整覆盖：fixing→reconcile 合法（M10-a 返工边）", () => {
  const st = mkSt("fixing");
  assert.equal(advance(st, "wf:reconcile").ok, true);
  assert.equal(st.phase, "reconcile");
});

// ── tui-sidebar-elapsed T01：墙钟计时记账 A1-A6（plan §4 验收逐字）──────────────
// 经 registerCommands + 内存 store mock 驱动 commands.ts 真实 apply 记账块（§3.2）；
// mock 形状与 integration.test.js 胶水层同源，load/save 语义对齐 withStateRetry 契约。
const TIMING_SID = "ses_timing";
const isISO = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) && Number.isFinite(Date.parse(v));

const mkTimingHarness = async () => {
  // T04：装配收敛 helpers/wiring（options/sessions/deps 缺省=旧内联 mock 等价；seed 为计时用例专属附加面）
  const store = new Map();
  const h = await mkWiring({ store, sessionID: TIMING_SID, dir: "/tmp/opencode/wf-elapsed" });
  return { ...h, seed: (st) => store.set(TIMING_SID, structuredClone(st)) };
};

// daily 链推进至 done（关卡前置经 patch 置账；M 级须 planReviewVerdict PASS + 方案确认）
const runDailyToDone = async (h, slug) => {
  await h.run("wf:intake", slug);
  await h.run("wf:plan");
  await h.run("wf:review");
  h.patch({ planConfirmedAt: new Date().toISOString(), planReviewVerdict: "PASS" });
  await h.run("wf:build");
  await h.run("wf:test");
  h.patch({ testReportVerdict: "PASS" });
  await h.run("wf:done");
};

test("A1 计时：intake 后 startedAt/phaseEnteredAt 为 ISO 且相等，phaseDurations 深等 {}", async () => {
  const h = await mkTimingHarness();
  await h.run("wf:intake", "elapsed-a1");
  const st = h.st();
  assert.ok(isISO(st.startedAt), `startedAt 应为 ISO：${st.startedAt}`);
  assert.ok(isISO(st.phaseEnteredAt), `phaseEnteredAt 应为 ISO：${st.phaseEnteredAt}`);
  assert.equal(st.phaseEnteredAt, st.startedAt, "intake 时刻两字段相等");
  assert.deepEqual(st.phaseDurations, {}, "空账不得污染");
  h.dispose();
});

test("A2 计时：两次流转间隔 ≥1.05s → phaseDurations.intake>=1（number）；A3 每次流转后 phaseEnteredAt>=startedAt", async () => {
  const h = await mkTimingHarness();
  await h.run("wf:intake", "elapsed-a2");
  const t0 = h.st();
  assert.ok(Date.parse(t0.phaseEnteredAt) >= Date.parse(t0.startedAt), "A3：intake 后");
  await new Promise((r) => setTimeout(r, 1050)); // 造秒级差（plan §4 T01 验证方式）
  await h.run("wf:plan");
  const st = h.st();
  assert.equal(typeof st.phaseDurations?.intake, "number", `intake 闭账应为 number：${JSON.stringify(st.phaseDurations)}`);
  assert.ok(st.phaseDurations.intake >= 1, `intake 耗时应 ≥1s：${JSON.stringify(st.phaseDurations)}`);
  assert.ok(Date.parse(st.phaseEnteredAt) >= Date.parse(st.startedAt), "A3：plan 后");
  h.dispose();
});

test("A4 计时：推进 done 后 finishedAt 为 ISO 且 >=startedAt；重复推进不覆写 finishedAt", async () => {
  const h = await mkTimingHarness();
  await runDailyToDone(h, "elapsed-a4");
  const st = h.st();
  assert.equal(st.phase, "done");
  assert.ok(isISO(st.finishedAt), `finishedAt 应为 ISO：${st.finishedAt}`);
  assert.ok(Date.parse(st.finishedAt) >= Date.parse(st.startedAt), "finishedAt >= startedAt");
  const f1 = st.finishedAt;
  // 重复推进：fixture 回拨 phase=testing 模拟再验收，再次 done → finishedAt 冻结不覆写
  h.patch({ phase: "testing" });
  await new Promise((r) => setTimeout(r, 20));
  await h.run("wf:done");
  assert.equal(h.st().phase, "done");
  assert.equal(h.st().finishedAt, f1, "重复 done 不得覆写 finishedAt");
  h.dispose();
});

test("A5 计时：强制重 intake（!slug）4 字段重置（phaseDurations 回 {}、startedAt 更新、finishedAt 清除）", async () => {
  const h = await mkTimingHarness();
  await h.run("wf:intake", "elapsed-a5");
  await new Promise((r) => setTimeout(r, 1050));
  await h.run("wf:plan"); // 累计 intake 耗时 ≥1s
  const old = h.st();
  assert.ok(old.phaseDurations.intake >= 1, "前置：旧账已有耗时");
  // 非 done 阶段强制重 intake（force 路径）
  await h.run("wf:intake", "!elapsed-a5-new");
  const st = h.st();
  assert.deepEqual(st.phaseDurations, {}, "强制重置后空账");
  assert.ok(isISO(st.startedAt) && st.startedAt !== old.startedAt, "startedAt 更新为新 intake 时刻");
  assert.equal(st.phaseEnteredAt, st.startedAt, "重置块置账相等（闭账跳过不污染）");
  assert.equal(st.finishedAt, undefined);
  // 新任务推进 done 置 finishedAt，再次强制重 intake → finishedAt 清除
  await runDailyToDoneNoIntake(h);
  assert.ok(isISO(h.st().finishedAt), "前置：新任务已置 finishedAt");
  await h.run("wf:intake", "!elapsed-a5-third");
  assert.equal(h.st().finishedAt, undefined, "重 intake 清除 finishedAt");
  assert.deepEqual(h.st().phaseDurations, {});
  h.dispose();
});

// A5 续段：intake 已在上方完成，仅推进 plan→done
const runDailyToDoneNoIntake = async (h) => {
  await h.run("wf:plan");
  await h.run("wf:review");
  h.patch({ planConfirmedAt: new Date().toISOString(), planReviewVerdict: "PASS" });
  await h.run("wf:build");
  await h.run("wf:test");
  h.patch({ testReportVerdict: "PASS" });
  await h.run("wf:done");
};

test("A6 计时：存量形状（无 4 字段）流转一次不崩——phaseEnteredAt 置上、startedAt/finishedAt 仍缺、闭账与置账跳过、phaseDurations 不新增", async () => {
  const h = await mkTimingHarness();
  h.seed({
    sessionID: TIMING_SID, slug: "legacy", phase: "intake", mode: "daily",
    rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, lanes: {}, artifacts: {}, log: [],
  });
  await h.run("wf:plan");
  const st = h.st();
  assert.equal(st.phase, "planning", "存量流转不崩");
  assert.ok(isISO(st.phaseEnteredAt), `phaseEnteredAt 应被置上：${st.phaseEnteredAt}`);
  assert.equal(st.startedAt, undefined, "存量不兜底 startedAt");
  assert.equal(st.finishedAt, undefined, "存量推 done 不置 finishedAt（本步未 done，亦不得置）");
  assert.equal(st.phaseDurations, undefined, "闭账跳过：phaseDurations 不新增");
  h.dispose();
});

// ── notification-brief-display T03：publishOutput/runner 接线 + FLOW_COMMANDS 单一来源 ──
// 捕获 mock（putReport/emitReport 记录载荷）驱动 commands.ts 真实 publishOutput；
// 断言 plan §5-T03 验收表 1-4 + B 意见名单同源（L129）。
const mkWiringHarness = async () =>
  // T04：装配收敛 helpers/wiring——reports=putReport 捕获（state.ts 行形状）、events=emitReport 捕获（meta 第 4 参）
  mkWiring({ dir: "/tmp/opencode/wf-brief-w", sessionID: "ses_w" });
const lastRow = (h) => h.reports[h.reports.length - 1];

test("T03 成功流转：reports 行 = text 全文 + brief(【wf 开头) + level=info（LLM 全文锚不动）", async () => {
  const h = await mkWiringHarness();
  await h.run("wf:intake", "brief-w-plan");
  h.reports.length = 0;
  const r = await h.run("wf:plan");
  const row = lastRow(h);
  assert.equal(row.text, r, "text 仍为 guidance 全文（LLM/审计通道不动）");
  assert.ok(row.text.startsWith("【wf 工作流"), "全文锚");
  assert.ok(row.brief.startsWith("【wf 工作流"), `brief 应为 transition 4 行：${JSON.stringify(row.brief)}`);
  assert.equal(row.brief.split("\n").length, 4);
  assert.equal(row.level, "info");
  h.dispose();
});

test("T03 halt（关卡拒绝）：level=warn 且 brief=2 行拒绝句", async () => {
  const h = await mkWiringHarness();
  await h.run("wf:intake", "brief-w-halt");
  await h.run("wf:plan");
  await h.run("wf:review"); // review→build 合法来源；不设 planConfirmedAt → 确认关卡 halt
  h.reports.length = 0;
  const msg = await h.run("wf:build"); // 无 planConfirmedAt → 确认关卡拒绝
  assert.ok(msg.startsWith("❌"), msg.slice(0, 40));
  const row = lastRow(h);
  assert.equal(row.text, msg, "拒绝全文照旧落行");
  assert.equal(row.level, "warn");
  const bl = row.brief.split("\n");
  assert.equal(bl.length, 2, `拒绝 brief 应 2 行：${row.brief}`);
  assert.equal(bl[0], "【wf｜build】");
  assert.ok(bl[1].startsWith("❌ 方案确认关卡未过"), bl[1]);
  h.dispose();
});

test("T03 非流转命令（status）：briefFallback 2 行 info，兜底行无 ses_（text 全文仍含）", async () => {
  const h = await mkWiringHarness();
  await h.run("wf:intake", "brief-w-status");
  h.reports.length = 0;
  await h.run("wf:status");
  const row = lastRow(h);
  assert.equal(row.level, "info");
  const bl = row.brief.split("\n");
  assert.equal(bl[0], "【wf｜status】");
  assert.ok(!row.brief.includes("ses_"), `brief 泄漏 ses_：${row.brief}`);
  assert.ok(row.text.includes("ses_w"), "text 全文保留（含 session 行——LLM/审计通道）");
  h.dispose();
});

test("T03 runner.run 返回 {text,at,brief,level}；无 text 分支缺省不炸", async () => {
  const h = await mkWiringHarness();
  const res = await h.deps.runner.run("wf:ping", { sessionID: "ses_w", prompt: { text: "" } });
  assert.equal(typeof res.text, "string");
  assert.ok(res.text.length > 0, "ping 有输出");
  assert.ok(typeof res.at === "string" && res.at.length >= 20);
  assert.ok(res.brief.startsWith("【wf｜ping】\n"), `exec 返回 brief：${JSON.stringify(res.brief)}`);
  assert.equal(res.level, "info");
  // 未知命令：不发布（无 reports 行），但返回体四字段齐备（❌ → warn，R1 前缀不变量同源判定）
  const n = h.reports.length;
  const bad = await h.deps.runner.run("wf:nope", { sessionID: "ses_w" });
  assert.equal(h.reports.length, n, "未知命令不得发布报告行");
  assert.match(bad.text, /未知命令/);
  assert.equal(bad.level, "warn");
  assert.ok(String(bad.brief).includes("未知命令"), bad.brief);
  h.dispose();
});

test("T03 emitReport 调用携 meta（第 4 参 brief/level）", async () => {
  const h = await mkWiringHarness();
  await h.run("wf:intake", "brief-w-emit");
  const ev = h.events[h.events.length - 1];
  assert.equal(ev.sid, "ses_w");
  assert.ok(ev.meta && typeof ev.meta.brief === "string" && ev.meta.brief.startsWith("【wf 工作流"), JSON.stringify(ev.meta));
  assert.equal(ev.meta.level, "info");
  h.dispose();
});

test("T03 FLOW_COMMANDS 单一来源：描述表键集 = FLOW_CMD_NAMES（无第二份硬编码名单）", async () => {
  const fs = await import("node:fs");
  const { FLOW_CMD_NAMES } = await import("../server/lib.ts");
  const { FLOW_DESCRIPTIONS } = await import("../server/commands.ts");
  assert.deepEqual(Object.keys(FLOW_DESCRIPTIONS).toSorted(), [...FLOW_CMD_NAMES].toSorted(), "描述表与名单键集相等");
  const src = fs.readFileSync(new URL("../server/commands.ts", import.meta.url), "utf8");
  assert.match(src, /for \(const name of FLOW_CMD_NAMES\)/, "构造须遍历 FLOW_CMD_NAMES");
  assert.ok(!/\[\s*"wf:intake",\s*"工作流入口/.test(src), "不得残留第二份 [name,description] 硬编码名单");
  const h = await mkWiringHarness();
  for (const name of FLOW_CMD_NAMES) {
    const c = h.cmds.find((x) => x.name === name);
    assert.ok(c && c.description.length > 0, `${name} 注册且描述非空`);
  }
  h.dispose();
});
