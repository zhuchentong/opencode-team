// notification-brief-display T02：brief/level 生成纯函数锚（plan §3.1/§3.2/§3.3、§4 冻结接口）。
// 直测 lib.ts（ReportLevel/REJECT_PREFIX/FLOW_CMD_NAMES/isRejectReport/levelFor/briefFallback）
// + guidance.ts（briefForTransition/briefFor）+ shared/redact.ts（redactIds）。
// FLOW_CMD_NAMES 与 commands.ts FLOW_COMMANDS 名单相等断言不在本轮（T03 落）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS, NEXT, NEXT_DAILY, REJECT_PREFIX, FLOW_CMD_NAMES,
  isRejectReport, levelFor, briefFallback,
} from "../server/lib.ts";
import { briefForTransition, briefFor, guidance } from "../server/guidance.ts";
import { redactIds } from "../shared/redact.ts";
import { withVerdicts } from "./helpers/state-fixture.js"; // R3 T3.1：verdicts 平铺键→子对象翻译

const mkSt = (over = {}) => withVerdicts({
  sessionID: "ses_01AbCdEfGhIjKlMnOp", slug: "demo-task", phase: "planning",
  mode: "daily", size: "M", rounds: { plan_review: 1, build_review: 0, test_fix: 0 }, ...over,
});
const FULL_PHASES = ["intake", "planning", "review", "test_design", "building", "reconcile", "build_review", "testing", "fixing", "done"];
const DAILY_PHASES = ["intake", "planning", "review", "building", "testing", "done"];

// ── redactIds（G-1：替换 token 必不含 ses_）─────────────────────────────
test("redactIds：多 ID（含相邻）全替为〔已隐去〕、无 ID 不变、输出不含 ses_", () => {
  const r = redactIds("session=ses_A1b2C3d4 lane ses_9Zx8Yw7v,ses_5K4J3I2H 结束");
  assert.ok(!r.includes("ses_"), `输出仍含 ses_: ${r}`);
  assert.equal(r, "session=〔已隐去〕 lane 〔已隐去〕,〔已隐去〕 结束");
  assert.equal(redactIds("本行没有会话 ID"), "本行没有会话 ID");
  assert.equal(redactIds(""), "");
});

// ── §3.1 transition brief：4 行结构化 ───────────────────────────────────
test("T02 transition brief：daily planning 4 行逐行（L1 头/L2 行动/L3 轮次/L4 指路）", () => {
  const b = briefForTransition(mkSt(), LIMITS);
  const lines = b.split("\n");
  assert.equal(lines.length, 4, `应恰 4 行：${JSON.stringify(lines)}`);
  assert.ok(lines[0].includes("【wf 工作流｜planning·日常模式·M】slug=demo-task"), lines[0]);
  assert.ok(lines[1].startsWith("行动："), lines[1]);
  assert.ok(lines[1].includes(NEXT_DAILY.planning), `L2 应含 NEXT_DAILY[planning]：${lines[1]}`);
  assert.ok(lines[2].startsWith("轮次 plan_review=1/3 build_review=0/3 test_fix=0/3"), lines[2]);
  assert.equal(lines[3], "/wf:status 查看完整指引");
  assert.ok(!b.includes("ses_"), "transition brief 绝不回显 sessionID");
});

test("T02 transition brief：full 模式取样（完整模式标签 + NEXT 表 + 轮次递增）", () => {
  const b = briefForTransition(mkSt({ mode: "full", phase: "build_review", rounds: { plan_review: 2, build_review: 1, test_fix: 0 } }), LIMITS);
  const lines = b.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes("【wf 工作流｜build_review·完整模式·M】"), lines[0]);
  assert.ok(lines[1].includes(NEXT.build_review), lines[1]);
  assert.ok(lines[2].includes("build_review=1/3"), lines[2]);
  assert.ok(!b.includes("ses_"));
});

test("T02 transition brief：全阶段遍历（daily+full 各 phase 均 4 行、L4 恒定、无 ses_）", () => {
  for (const mode of ["daily", "full"]) {
    for (const phase of mode === "daily" ? DAILY_PHASES : FULL_PHASES) {
      const b = briefForTransition(mkSt({ mode, phase }), LIMITS);
      const lines = b.split("\n");
      assert.equal(lines.length, 4, `${mode}/${phase} 应 4 行`);
      assert.ok(lines[0].startsWith(`【wf 工作流｜${phase}·${mode === "daily" ? "日常模式" : "完整模式"}·M】slug=`), lines[0]);
      assert.ok(lines[1].startsWith("行动："), lines[1]);
      assert.ok(lines[2].startsWith("轮次 "), lines[2]);
      assert.equal(lines[3], "/wf:status 查看完整指引");
      assert.ok(!b.includes("ses_"), `${mode}/${phase} 回显了 ses_`);
      for (const l of lines) assert.ok(Array.from(l).length <= 101, `${phase} 行超 100 码点：${l}`);
    }
  }
});

test("T02 L3 后缀：仅非空字段追加（planReview/test/确认/testPlan）", () => {
  const bare = briefForTransition(mkSt(), LIMITS).split("\n")[2];
  assert.ok(!bare.includes("｜"), `空账时不得有后缀：${bare}`);
  const full = briefForTransition(mkSt({
    phase: "testing", planReviewVerdict: "PASS", testReportVerdict: "FAIL",
    planConfirmedAt: "2026-11-13T00:00:00.000Z", testPlanWritten: true,
  }), LIMITS).split("\n")[2];
  assert.ok(full.includes("｜planReview=PASS"), full);
  assert.ok(full.includes("｜test=FAIL"), full);
  assert.ok(full.includes("｜确认=✅"), full);
  assert.ok(full.includes("｜testPlan=✅"), full);
});

test("T02 limits 覆盖 + slug 缺省 (未定) + 每行 ≤100 码点截断", () => {
  const b = briefForTransition(mkSt({ slug: "" }), { plan_review: 5 });
  const lines = b.split("\n");
  assert.ok(lines[0].endsWith("slug=(未定)"), lines[0]);
  assert.ok(lines[2].includes("plan_review=1/5"), lines[2]);
  const long = briefForTransition(mkSt({ slug: "x字".repeat(80) }), LIMITS);
  const l1 = long.split("\n")[0];
  assert.ok(Array.from(l1).length <= 101, `L1 截断失败 len=${Array.from(l1).length}`);
  assert.ok(l1.endsWith("…"), "超长行须以 … 结尾");
});

test("T02 slug 含 ses_ 子串也不回显（G-2：transition 输出过 redactIds）", () => {
  const b = briefForTransition(mkSt({ slug: "evil-ses_A1B2c3d4-slug" }), LIMITS);
  assert.ok(!b.includes("ses_"), `slug 行泄漏 ses_：${b.split("\n")[0]}`);
});

// ── §3.3 level 规则表：逐条表驱动 ──────────────────────────────────────
test("T02 levelFor：§3.3 规则表全覆盖（按序命中）", () => {
  const G = "【wf 工作流｜planning·日常模式】slug=demo"; // 成功 guidance 样本（非 ❌ 开头）
  const cases = [
    // R1：拒绝前缀 → warn（优先于其余一切，含 st null）
    ["R1 ❌→warn", "wf:plan", "❌ 拒绝：非法流转", mkSt(), "warn"],
    ["R1 ❌ + st=null→warn", "wf:plan", "❌ x", null, "warn"],
    ["R1 优先级压过 R2", "wf:fix", "❌ test_fix 已达上限", mkSt(), "warn"],
    // R2：wf:fix（FAIL 返工进场）
    ["R2 wf:fix→warn", "wf:fix", G, mkSt({ mode: "full", phase: "fixing" }), "warn"],
    // R3：产物结论 FAIL 在场
    ["R3 wf:test+testFAIL→warn", "wf:test", G, mkSt({ testReportVerdict: "FAIL" }), "warn"],
    ["R3 wf:test+testPASS→info", "wf:test", G, mkSt({ testReportVerdict: "PASS" }), "info"],
    ["R3 wf:review+planFAIL→warn", "wf:review", G, mkSt({ phase: "review", planReviewVerdict: "FAIL" }), "warn"],
    ["R3 wf:review+planPASS→info", "wf:review", G, mkSt({ phase: "review", planReviewVerdict: "PASS" }), "info"],
    ["R3 结论错位不触发（review 带 testFAIL）", "wf:review", G, mkSt({ testReportVerdict: "FAIL" }), "info"],
    // R4：done + git 交付确认
    ["R4 wf:done+done+git→warn", "wf:done", G, mkSt({ phase: "done", doneGit: { isGit: true, hasRemote: false } }), "warn"],
    ["R4 done 非 git→info", "wf:done", G, mkSt({ phase: "done", doneGit: { isGit: false, hasRemote: false } }), "info"],
    ["R4 无 doneGit 记账→info", "wf:done", G, mkSt({ phase: "done" }), "info"],
    ["R4 相位未到 done→info", "wf:done", G, mkSt({ phase: "testing" }), "info"],
    // R5：其余
    ["R5 正常流转→info", "wf:plan", G, mkSt(), "info"],
    ["R5 非流转只读→info", "wf:status", "wf 工作流状态", mkSt(), "info"],
    ["R5 st=null 成功文本→info", "wf:test", G, null, "info"],
    ["R5 reset→info", "wf:reset", "✅ 已清除", mkSt(), "info"],
  ];
  for (const [name, cmd, text, st, want] of cases) assert.equal(levelFor(cmd, text, st), want, name);
});

test("T02 REJECT_PREFIX 常量与判定同源", () => {
  assert.equal(REJECT_PREFIX, "❌");
  assert.equal(isRejectReport("❌ 拒绝"), true);
  assert.equal(isRejectReport("【wf 工作流】"), false);
  assert.equal(isRejectReport(""), false);
  assert.equal(isRejectReport("先❌在后"), false); // 仅前缀判定
});

// ── FLOW_CMD_NAMES：10 流转命令名（与 FLOW_COMMANDS 相等断言在 T03）────
test("T02 FLOW_CMD_NAMES：10 个流转命令名在位", () => {
  assert.equal(FLOW_CMD_NAMES.size, 10);
  for (const c of ["wf:intake", "wf:plan", "wf:review", "wf:test-design", "wf:build",
    "wf:reconcile", "wf:review-build", "wf:test", "wf:fix", "wf:done"]) {
    assert.ok(FLOW_CMD_NAMES.has(c), `缺 ${c}`);
  }
  for (const c of ["wf:status", "wf:ping", "wf:diagnose", "wf:reset", "wf:lane"]) {
    assert.ok(!FLOW_CMD_NAMES.has(c), `${c} 不应在流转名单`);
  }
});

// ── 成功 guidance 与拒绝前缀互斥（作者位不变量，§3.3 R1 的前提）────────
test("T02 互斥守卫：guidance() 全阶段 !isRejectReport 且以【开头", () => {
  for (const mode of ["daily", "full"]) {
    for (const phase of mode === "daily" ? DAILY_PHASES : FULL_PHASES) {
      const g = guidance(phase, mkSt({ mode, phase }), LIMITS);
      assert.ok(!isRejectReport(g), `${mode}/${phase} 成功 guidance 以 ❌ 开头`);
      assert.ok(g.startsWith("【"), `${mode}/${phase} 成功 guidance 未以【开头`);
    }
  }
});

// ── §3.2 briefFallback：两行式 ─────────────────────────────────────────
test("T02 briefFallback：两行式 + status 首行 ses_ 脱敏（G-1/A 零回显）", () => {
  const text = "wf 工作流(0.1.0)状态｜session=ses_01AbCdEfGhIjKl\nslug=demo  phase=building";
  const b = briefFallback("wf:status", text);
  const lines = b.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "【wf｜status】");
  assert.ok(!b.includes("ses_"), `兜底行回显 ses_：${lines[1]}`);
  assert.ok(lines[1].includes("〔已隐去〕"), lines[1]);
});

test("T02 briefFallback：超长首行 ≤100 码点截断加 …；跳空行取首个非空行", () => {
  const lines = briefFallback("wf:ping", "字".repeat(150)).split("\n");
  assert.equal(Array.from(lines[1]).length, 101, "截断后 100 码点 + …");
  assert.ok(lines[1].endsWith("…"));
  assert.equal(briefFallback("wf:x", "\n\n  \n第一行\n第二行"), "【wf｜x】\n第一行");
  assert.equal(briefFallback("wf:x", ""), "【wf｜x】\n");
});

// ── briefFor 分派 ──────────────────────────────────────────────────────
test("T02 briefFor：流转命令+成功文本+st.phase → transition；否则 fallback", () => {
  const st = mkSt({ phase: "planning" });
  const g = guidance("planning", st, LIMITS);
  assert.equal(briefFor("wf:plan", g, st, LIMITS), briefForTransition(st, LIMITS));
  // 拒绝文本 → fallback（即便流转命令+st 在场）
  const rej = briefFor("wf:build", "❌ 方案确认关卡未过：尚未观测到", st, LIMITS);
  assert.ok(rej.startsWith("【wf｜build】\n❌ 方案确认关卡未过"), rej);
  // 非流转命令 → fallback
  assert.ok(briefFor("wf:status", "wf 工作流状态｜session=ses_A1", st, LIMITS).startsWith("【wf｜status】\n"));
  // st null / 无 phase → fallback
  assert.ok(briefFor("wf:plan", g, null, LIMITS).startsWith("【wf｜plan】\n"));
  assert.ok(briefFor("wf:plan", g, mkSt({ phase: null }), LIMITS).startsWith("【wf｜plan】\n"));
});

test("T02 briefFor 全形态无 ses_ 不变量（含 fallback 输入带 ID）", () => {
  const st = mkSt({ roleSessions: { "wf/builder": { sessionID: "ses_LEAKME01", at: "t" } } });
  const samples = [
    briefFor("wf:plan", guidance("planning", st, LIMITS), st, LIMITS),
    briefFor("wf:status", `状态行 session=ses_LEAKME02\nslug=x`, st, LIMITS),
    briefFor("wf:build", "❌ 关卡未过 ses_LEAKME03 详情", st, LIMITS),
    briefFor("wf:plan", "任意文本", null, LIMITS),
  ];
  for (const s of samples) assert.ok(!s.includes("ses_"), `泄漏：${s}`);
});

// ── R2 T2.3：levelFor R0 结构化关卡判定（gateStatus 快照优先；R1 ❌ 兜底保留）──
test("R2 T2.3：levelFor R0——gateStatus fail + 关卡命令 → warn（不依赖文案前缀）", () => {
  const st = mkSt({ phase: "building", gateStatus: { id: "daily-build", ok: false, at: "t" } });
  // 合成无 ❌ 前缀文本：R0 结构化命中（真实路径 gate.explain 恒 ❌，R0/R1 双保险同命中）
  assert.equal(levelFor("wf:build", "【合成】非拒绝形状文本", st), "warn");
  assert.equal(levelFor("wf:test-design", "x", { ...st, verdicts: { ...st.verdicts, gateStatus: { id: "dual-channel", ok: false, at: "t" } } }), "warn");
  assert.equal(levelFor("wf:done", "x", { ...st, verdicts: { ...st.verdicts, gateStatus: { id: "acceptance", ok: false, at: "t" } } }), "warn");
});

test("R2 T2.3：levelFor R0 不误伤——gateStatus ok / 非关卡命令 / 无快照 → 走原规则", () => {
  const ok = mkSt({ gateStatus: { id: "daily-build", ok: true, at: "t" } });
  assert.equal(levelFor("wf:build", "【wf 工作流｜building】正常", ok), "info");
  const fail = mkSt({ gateStatus: { id: "daily-build", ok: false, at: "t" } });
  assert.equal(levelFor("wf:status", "【wf｜status】x", fail), "info", "非关卡命令不受 R0 影响");
  assert.equal(levelFor("wf:build", "【wf】x", mkSt()), "info", "无 gateStatus 走原规则");
  // R1 兜底仍在：❌ 文本恒 warn（互斥不变量不放宽）
  assert.equal(levelFor("wf:build", `${REJECT_PREFIX} 拒`, mkSt()), "warn");
});
