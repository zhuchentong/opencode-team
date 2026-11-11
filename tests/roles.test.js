// M16-r31：角色内容插件托管（B1 文件同步）——渲染器/标记/同步决策纯函数 + 临时目录文件同步
// 背景：宿主 wf/* 角色文件与插件版本漂移（r28 删 assign 后 leader.md 滞留 r27）。
// 机制：仓库 roles/ 单一来源 → setup 渲染全文 → 写宿主文件 body（保留 frontmatter）→ 宿主文件热载（P0 已实证）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ROLE_NAMES, renderRole, roleMarker, parseMarker, syncDecision, syncRoles, roleSyncStatus,
} from "../server/roles.ts";
import { PHASE_ORDER } from "../shared/phases.ts";
import { VERSION } from "../server/lib.ts";

test("ROLE_NAMES：8 角色齐全（leader + 7 subagent）", () => {
  assert.deepEqual([...ROLE_NAMES].toSorted(), [
    "builder", "builder-reviewer", "fixer", "leader", "learner",
    "planner", "planner-reviewer", "tester",
  ]);
});

test("renderRole：结构事实注入——阶段链来自 PHASE_ORDER，无 assign，无残留占位符", () => {
  const out = renderRole("leader");
  // 阶段链动态生成（含 folding 标注），与 PHASE_ORDER 同源
  for (const p of PHASE_ORDER) assert.ok(out.includes(p), `阶段链应含 ${p}`);
  assert.ok(!out.includes("{{"), "不应残留未替换占位符");
  assert.ok(!/→assign→/.test(out), "阶段链不应含已移除的 assign");
  // 版本标记在首行
  assert.ok(out.startsWith(roleMarker("leader")), "首行应为托管标记");
  // 冷启动铁律保留（r30 内容做种，防回归）
  assert.match(out, /冷启动铁律/);
});

test("renderRole：subagent 模板原样渲染 + 标记，无占位符残留", () => {
  for (const name of ROLE_NAMES) {
    const out = renderRole(name);
    assert.ok(out.startsWith(roleMarker(name)), `${name} 首行应为标记`);
    assert.ok(!out.includes("{{"), `${name} 不应残留占位符`);
    assert.ok(out.length > 50, `${name} 内容不应为空`);
  }
});

test("roleMarker/parseMarker：版本+hash 往返一致；hash 随内容变", () => {
  const m = roleMarker("leader");
  const parsed = parseMarker(m);
  assert.ok(parsed, "标记应可解析");
  assert.equal(parsed.version, VERSION);
  assert.match(parsed.hash, /^[0-9a-f]{12}$/);
  // 同内容 hash 稳定
  assert.equal(parseMarker(roleMarker("leader")).hash, parsed.hash);
  // 非标记行 → null
  assert.equal(parseMarker("你是 leader"), null);
  assert.equal(parseMarker(""), null);
});

test("syncDecision：hash 同→skip；hash 异→write；无标记→unmanaged（不覆盖）", () => {
  const rendered = renderRole("planner");
  // 已托管且实际内容 hash 一致 → skip（fixture 须用真实渲染内容，标记 hash 与 body 自洽）
  assert.equal(syncDecision(rendered, rendered).action, "skip");
  // 已托管但内容陈旧（hash 不同）→ write
  const stale = rendered.replace("你是计划者", "你是旧版计划者");
  assert.equal(syncDecision(stale, rendered).action, "write");
  // 无标记（用户自有）→ unmanaged，不覆盖
  assert.equal(syncDecision("用户自己写的内容", rendered).action, "unmanaged");
  // 空文件 → unmanaged
  assert.equal(syncDecision("", rendered).action, "unmanaged");
});

test("syncRoles：临时目录文件同步——保 frontmatter、写前备份、hash 跳过、无标记不覆盖", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-roles-"));
  try {
    const fm = '---\ndescription: 测试角色\nmode: subagent\npermissions:\n  - { action: edit, resource: "*", effect: deny }\n---\n';
    // planner：已托管但陈旧 → 应 write + 备份 + 保 frontmatter
    const staleBody = renderRole("planner").replace("你是计划者", "你是旧版计划者");
    fs.writeFileSync(path.join(dir, "planner.md"), fm + staleBody);
    // tester：无标记（用户自有）→ 不覆盖
    fs.writeFileSync(path.join(dir, "tester.md"), fm + "用户自定义 tester 内容");
    // builder：文件缺失 → missing（不自动创建）

    const report = syncRoles(dir, { backup: true });

    // planner 被更新：frontmatter 保留、body=渲染全文、标记在首行
    const planner = fs.readFileSync(path.join(dir, "planner.md"), "utf8");
    assert.ok(planner.startsWith(fm), "frontmatter 必须原样保留");
    assert.ok(planner.includes(roleMarker("planner")), "应含托管标记");
    assert.ok(planner.includes("你是计划者"), "body 应为最新渲染内容");
    assert.ok(!planner.includes("你是旧版计划者"), "陈旧内容应被替换");
    // 备份存在
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("planner.md.bak"));
    assert.ok(backups.length >= 1, "写前应备份");

    // tester 未被覆盖
    const tester = fs.readFileSync(path.join(dir, "tester.md"), "utf8");
    assert.ok(tester.includes("用户自定义 tester 内容"), "无标记文件不得覆盖");

    // 报告结构
    const byName = Object.fromEntries(report.map((r) => [r.name, r.action]));
    assert.equal(byName.planner, "write");
    assert.equal(byName.tester, "unmanaged");
    assert.equal(byName.builder, "missing");

    // 幂等：再跑一次 planner 应 skip（hash 已一致）
    const report2 = syncRoles(dir, { backup: true });
    const byName2 = Object.fromEntries(report2.map((r) => [r.name, r.action]));
    assert.equal(byName2.planner, "skip", "hash 一致应跳过，避免无谓热载");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("roleSyncStatus：managed/stale/unmanaged/missing 四态判定（漂移守卫）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-rolestatus-"));
  try {
    const fm = "---\ndescription: x\nmode: subagent\n---\n";
    // leader：最新托管 → managed
    fs.writeFileSync(path.join(dir, "leader.md"), fm + renderRole("leader"));
    // planner：托管但陈旧 → stale
    fs.writeFileSync(path.join(dir, "planner.md"), fm + renderRole("planner").replace("你是计划者", "旧版"));
    // tester：无标记 → unmanaged
    fs.writeFileSync(path.join(dir, "tester.md"), fm + "用户内容");
    // builder：缺失 → missing
    const st = Object.fromEntries(roleSyncStatus(dir).map((r) => [r.name, r.status]));
    assert.equal(st.leader, "managed");
    assert.equal(st.planner, "stale");
    assert.equal(st.tester, "unmanaged");
    assert.equal(st.builder, "missing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("M16-r32 瘦身预算：各产物的体积/结构约束写入对应角色模板（防回归）", () => {
  // planner：plan.md ≤15KB + 返工增量修订
  const planner = renderRole("planner");
  assert.match(planner, /≤15KB/, "planner 应含 plan.md 体积预算");
  assert.match(planner, /增量修订|只重产受影响/, "planner 应含返工增量修订指引");
  // planner-reviewer：plan-review ≤8KB + findings 表格化
  const pr = renderRole("planner-reviewer");
  assert.match(pr, /≤8KB/, "planner-reviewer 应含体积预算");
  assert.match(pr, /表格/, "planner-reviewer 应要求 findings 表格化");
  // tester：test-plan ≤10KB、test-report ≤10KB
  const tester = renderRole("tester");
  assert.match(tester, /test-plan[\s\S]*≤10KB|≤10KB[\s\S]*test-plan/, "tester 应含 test-plan 预算");
  assert.match(tester, /test-report[\s\S]*≤10KB|≤10KB[\s\S]*test-report/, "tester 应含 test-report 预算");
  // builder-reviewer：build-review ≤8KB
  assert.match(renderRole("builder-reviewer"), /≤8KB/, "builder-reviewer 应含体积预算");
  // learner：lessons ≤6KB
  assert.match(renderRole("learner"), /≤6KB/, "learner 应含 lessons 预算");
});

test("M16-r33 写入者契约：产出角色自写产物+patch 修订+回执禁全文（防回归）", () => {
  // 真机取证：todolist leader 代写 3 产物=双倍生成（planner 回复一遍+leader tool 入参一遍）；
  // 统一写入者=子代理自写，修订用 patch 只输出变更段。
  for (const name of ["planner", "planner-reviewer", "tester", "builder-reviewer", "learner"]) {
    const body = renderRole(name);
    assert.match(body, /wf_write_artifact/, `${name} 应指明经 wf_write_artifact 落盘`);
    assert.match(body, /自行|自写/, `${name} 应要求子代理自写产物`);
    assert.match(body, /patch/, `${name} 应含 patch 增量修订指引`);
    assert.match(body, /摘要|勿回传全文|禁回传全文|不回传全文/, `${name} 应要求回执只带摘要禁全文`);
  }
  // planner 修订契约：先读原文、old 逐字摘录
  const planner = renderRole("planner");
  assert.match(planner, /逐字|原文/, "planner patch 修订应先读原文逐字摘录 old");
  // leader 是代写行为发起方：必须含写入者契约（禁代写/禁要求全文回传）+ 体量前缀 + 委派带预算
  const leader = renderRole("leader");
  assert.match(leader, /禁止代写/, "leader 应禁止代写产物");
  assert.match(leader, /全文作为最终回复|由你写入/, "leader 应禁止要求子代理全文回传代写");
  assert.match(leader, /\[S\]\/\[M\]\/\[L\]/, "leader 冷启动应含体量前缀");
  assert.match(leader, /产物预算/, "leader 委派应要求携带产物预算");
});