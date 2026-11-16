// intake-discuss-gate T06：intake 两段式讨论指引 + 需求确认卡 + baseline 四段结构（≤2KB）。
// 方法论改编自 obra/superpowers brainstorming（MIT）：先侦察再问/开放题纯文本直问/playback/假设归属。
// mock 底座=tests/_preload.js（bunfig preload）+ helpers/state-fixture（禁散装自举）。
// 存量锚兼容：selfmod-guard D（批量优先/baseline.md/gitignore 口径）、phase-discipline（full intake 纪律行）、
// artifact-budget（full intake [S]/[M]/[L] 体量语法）——本文件只加新锚，不改存量测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { guidance } from "../server/guidance.ts";
import { withVerdicts } from "./helpers/state-fixture.js";

const blank = (over = {}) => withVerdicts({ slug: "t", phase: null, rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, artifacts: {}, lanes: {}, ...over });
const gi = (mode, size, over = {}) => guidance("intake", blank({ mode, size, ...over }));

// ── 两段式讨论 + 确认卡 + baseline 四段（M/L，daily+full 双模式）──────────────
for (const mode of ["daily", "full"]) {
  for (const size of ["M", "L"]) {
    test(`T06 ${mode}/${size} intake：两段式讨论（侦察→开放题纯文本直问；有界歧义 question 批量收敛）+ playback + 已清晰直落`, () => {
      const g = gi(mode, size);
      assert.match(g, /两段式讨论/, "方法论行标明两段式");
      assert.match(g, /意图未明/, "分诊①意图未明");
      assert.match(g, /先侦察/, "先侦察再问");
      assert.match(g, /不问项目.*能回答/, "项目能回答的不问用户");
      assert.match(g, /纯文本.*不用 question 工具/, "开放题纯文本直问（选项菜单会引导用户）");
      assert.match(g, /why/, "让用户描述 why");
      assert.match(g, /成功画面/, "成功画面");
      assert.match(g, /怎样算失败/, "怎样算失败");
      assert.match(g, /有界歧义/, "分诊②有界歧义");
      assert.match(g, /批量优先/, "question 批量收敛（selfmod-guard D 锚同源）");
      assert.match(g, /playback/, "每轮 playback 复述");
      assert.match(g, /用户原话.*leader.*假设|用户原话 vs leader 假设/, "区分用户原话/leader 假设");
      assert.match(g, /需求已清晰.*直接落 baseline.*勿强行多轮/, "已清晰→直落 baseline，勿强行多轮");
    });

    test(`T06 ${mode}/${size} intake：需求确认卡（先落 baseline 再出卡；选项固定；补充修正重出卡；诚实边界）`, () => {
      const g = gi(mode, size);
      assert.match(g, /需求确认卡/, "卡步骤在位");
      assert.match(g, /先落 baseline\.md 再.*question/, "先落 baseline 再出卡");
      // 选项逐字（与 guard-hook 观测锚「需求无误」前缀、intake-orch 标签同源）
      assert.ok(g.includes("「需求无误，开始规划」"), "选项1逐字");
      assert.ok(g.includes("「补充修正」"), "选项2逐字");
      assert.ok(g.includes("「终止任务」"), "选项3逐字");
      assert.match(g, /补充修正.*先更新 baseline\.md 再重新出卡/, "补充修正→更新 baseline 重出卡");
      assert.match(g, /wf:plan 关卡校验出卡记账/, "关卡校验出卡记账");
      assert.match(g, /只保「出过卡」.*不保「答的是批准」/, "诚实边界：不过度承诺");
    });

    test(`T06 ${mode}/${size} intake：baseline 四段结构 + ≤2KB（旧 ≤1KB 清零）`, () => {
      const g = gi(mode, size);
      assert.match(g, /baseline\.md/, "基线落盘");
      assert.match(g, /≤2KB/, "预算升 2KB");
      assert.ok(!/≤1KB/.test(g), "旧 1KB 口径不得残留");
      assert.match(g, /用户原话要点/, "段1");
      assert.match(g, /why·成功标准/, "段2");
      assert.match(g, /non-goals·anti-goals/, "段3");
      assert.match(g, /已声明假设/, "段4");
    });
  }
}

// ── S 零注入（方法论行与卡指引均不渲染；基础步骤仍在）────────────────────────
for (const mode of ["daily", "full"]) {
  test(`T06 ${mode}/S intake：零方法论行零卡指引（tierOf 门控同 leanLine）`, () => {
    const g = gi(mode, "S");
    assert.ok(!g.includes("需求澄清方法论"), "S 无方法论行");
    assert.ok(!g.includes("需求确认卡"), "S 无卡指引");
    assert.ok(!g.includes("需求无误"), "S 无卡选项");
    assert.match(g, /baseline\.md/, "S 仍落 baseline");
    assert.match(g, /≤2KB/, "S baseline 预算同口径");
    assert.match(g, /\.gitignore 含 \.workflow\/ 与 \.learnings\//, "gitignore 步骤全 tier 保留");
  });
}

// ── intakeConfirmOff 固化开关（options.requireIntakeConfirm=false，波1 T02）──
for (const mode of ["daily", "full"]) {
  test(`T06 ${mode}/M intakeConfirmOff:true：无卡指引，方法论行仍按 tier 渲染`, () => {
    const g = gi(mode, "M", { intakeConfirmOff: true });
    assert.ok(!g.includes("需求确认卡"), "关卡关闭=卡指引不渲染");
    assert.ok(!g.includes("需求无误"), "卡选项不渲染");
    assert.match(g, /需求澄清方法论/, "方法论行不受开关影响（M 仍渲染）");
    assert.match(g, /批量优先/, "D 锚不受开关影响");
    const s = gi(mode, "S", { intakeConfirmOff: true });
    assert.ok(!s.includes("需求澄清方法论"), "S+off 仍零方法论");
    assert.ok(!s.includes("需求确认卡"), "S+off 仍零卡");
  });
  test(`T06 ${mode}/M intakeConfirmOff:false/缺省：卡指引照常渲染`, () => {
    assert.match(gi(mode, "M", { intakeConfirmOff: false }), /需求确认卡/);
    assert.match(gi(mode, "M"), /需求确认卡/, "缺省 undefined=关卡生效");
  });
}

// ── planning 委派契约：需求摘录 → baseline.md 全文（daily M/L + full）────────
test("T06 planning 委派契约：daily M/L 与 full 均带 baseline.md 全文，「需求摘录」清零", () => {
  for (const st of [blank({ mode: "daily", size: "M" }), blank({ mode: "daily", size: "L" }), blank({ mode: "full", size: "M" })]) {
    const p = guidance("planning", st);
    assert.ok(p.includes("baseline.md 全文"), "委派带 baseline 全文");
    assert.ok(!p.includes("需求摘录"), "旧摘录口径清零");
  }
});

// ── testing 意图核对（daily + full，全 tier）─────────────────────────────────
for (const mode of ["daily", "full"]) {
  for (const size of ["S", "M"]) {
    test(`T06 ${mode}/${size} testing：对照 baseline 核对意图达成（违背意图=FAIL）`, () => {
      const t = guidance("testing", blank({ mode, size }));
      assert.match(t, /baseline\.md/, "testing 引用 baseline");
      assert.match(t, /why\/成功标准.*anti-goals|why\/成功标准与 anti-goals/, "核对 why/成功标准与 anti-goals");
      assert.match(t, /违背意图=FAIL/, "技术能跑但违背意图=FAIL");
    });
  }
}

// ── 存量 D 锚本地复核（与 selfmod-guard.test.js D 同口径，防本文件改动漂移）──
test("T06 D 锚复核：daily M intake 批量优先/baseline.md/gitignore 口径逐字在位", () => {
  const g = gi("daily", "M");
  assert.match(g, /批量优先/);
  assert.match(g, /baseline\.md/);
  assert.match(g, /\.gitignore 含 \.workflow\/ 与 \.learnings\//);
  assert.match(g, /agent 生成目录默认不入库/);
  assert.match(g, /显式删 \.learnings\/ 的 ignore 行/);
  assert.ok(!/默认入库随交付提交/.test(g));
});

// ── 存量锚兼容：full intake 纪律行/体量语法、daily 头行（phase-discipline/artifact-budget/integration）──
test("T06 存量锚兼容：full intake 纪律行+体量语法；daily 头行不变", () => {
  const f = gi("full", "M");
  assert.match(f, /【wf 工作流｜intake】slug=t/);
  assert.match(f, /阶段纪律/);
  assert.match(f, /勿委派任何 wf 角色/);
  assert.match(f, /!intake 重置/);
  assert.match(f, /\[S\]\/\[M\]\/\[L\]/);
  assert.match(gi("daily", "M"), /【wf 工作流｜intake·日常模式】slug=t/);
});