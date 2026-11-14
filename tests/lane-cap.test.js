// v2 提速：lane_cap 并入 LIMITS 覆盖机制（options.limits.lane_cap 实例覆盖）——
// 锁四件事：① 默认值单点（LANE_CAP === LIMITS.lane_cap === 2）；
// ② commands 层 capNote/guidance 层 lanes 行均读覆盖后 LIMS.lane_cap；
// ③ 非法值经 index 同款正整数过滤回落默认；④ diagnose 不出 lane_cap 余量垃圾行（0 >= cap 恒假）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, LANE_CAP, diagnoseReport } from "../server/lib.ts";
import { guidance } from "../server/guidance.ts";

const mkSt = (lanes = {}) => ({
  sessionID: "s", slug: "d", phase: "building", mode: "daily",
  rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
  artifacts: {}, lanes, log: [],
});

// lanes 工厂：n 条 active（lanes 值形状对齐 types.ts WfState["lanes"]）
const activeLanes = (n) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [`T${String(i + 1).padStart(2, "0")}`,
    { sessionID: `ses_${i}`, worktree: null, at: "t", status: "active", lastUsedAt: "t", areas: ["src/a"] }]),
);

test("默认值单点：lane_cap=4 且与 LANE_CAP 常量同源", () => {
  assert.equal(LANE_CAP, 4);
  assert.equal(LIMITS.lane_cap, LANE_CAP);
});

test("guidance lanes 行读覆盖后的 cap：lane_cap=6 显示 N/6，缺省回落 LANE_CAP=4", () => {
  const st = mkSt(activeLanes(4));
  const g6 = guidance("building", st, { lane_cap: 6 });
  assert.match(g6, /lanes\(4\/6 活跃\)/);
  const gDefault = guidance("building", st);
  assert.match(gDefault, /lanes\(4\/4 活跃\)/); // 默认 cap=4（LANE_CAP）
});

test("diagnose 不因 lane_cap 键输出余量垃圾行（rounds.lane_cap 永不递增）", () => {
  const st = mkSt();
  const rep = diagnoseReport(st, { version: "t", artifactFiles: [], limits: { ...LIMITS, lane_cap: 4 }, swallows: [] });
  assert.ok(!rep.includes("lane_cap"), "诊断输出不得出现 lane_cap（0 >= cap 恒假不打印）");
});

test("index 同款过滤：仅正整数生效，非法值回落 LANE_CAP", () => {
  // 复刻 index.ts:43-47 的组装逻辑做纯函数断言（组装逻辑本身由 integration 链覆盖）
  const buildLims = (opt) => {
    const LIMS = { ...LIMITS };
    for (const k of Object.keys(LIMS)) {
      const v = Number(opt?.limits?.[k]);
      if (Number.isInteger(v) && v >= 1) LIMS[k] = v;
    }
    return LIMS;
  };
  assert.equal(buildLims({ limits: { lane_cap: 4 } }).lane_cap, 4);
  assert.equal(buildLims({ limits: { lane_cap: "4" } }).lane_cap, 4); // 数字字符串经 Number() 转换合法（index 既有语义）
  for (const bad of [0, -1, 1.5, null, "abc"]) {
    assert.equal(buildLims({ limits: { lane_cap: bad } }).lane_cap, LANE_CAP, `非法值 ${JSON.stringify(bad)} 回落默认`);
  }
});

test("full 模式 building guidance 也渲染 lanes 动态尾（盲区补齐）", () => {
  const st = { ...mkSt(activeLanes(2)), mode: "full" };
  const g = guidance("building", st, LIMITS);
  assert.match(g, /lanes\(2\/4 活跃\)/); // 2 条活跃 × 默认 cap=4
  // 无 lanes 时零渲染（与 daily 同源，字节面不增行）
  const gEmpty = guidance("building", { ...mkSt(), mode: "full" }, LIMITS);
  assert.ok(!gEmpty.includes("lanes("));
});

test("v2 多 lane 返工路由：building 返工行按活跃 lane 数条件渲染（≥2 走归属路由，否则原文）", () => {
  const fixSt = (lanes) => ({ ...mkSt(lanes), rounds: { plan_review: 0, build_review: 0, test_fix: 1 } });
  // ≥2 活跃 lane → 多 lane 路由版
  const g2 = guidance("building", fixSt(activeLanes(2)));
  assert.match(g2, /归属 lane/); assert.match(g2, /@Tnn/); assert.match(g2, /wf\/fixer/);
  // 无 lanes → 原文（复用原 builder），无多 lane 路由
  const g0 = guidance("building", fixSt());
  assert.match(g0, /复用原 builder sessionID/); assert.ok(!g0.includes("归属 lane"));
  // 1 条活跃 lane（其余 done 等价单 builder）→ 原文
  const one = { ...activeLanes(2), T02: { ...activeLanes(2).T02, status: "done" } };
  const g1 = guidance("building", fixSt(one));
  assert.match(g1, /复用原 builder sessionID/); assert.ok(!g1.includes("归属 lane"));
});
