// @ts-check
// tests/helpers/state-fixture.js — R3 T3.1（arch-r3-state-shape-migration）测试侧形状同源。
// verdicts 家族平铺键 → 子对象翻译（与 wiring.patch、server 真实写点同源；mock 漂移=本地绿真机哑火）。
// 供各测试文件的 mkSt/blank 工厂收口：工厂仍接受平铺 over 键，产出恒新形状态对象。
// 子步 C：reuse 家族（roleSessions/tierBase）；子步 D：delivery 家族（doneGit/selfMod）同样平铺键→子对象翻译。
// test-vd-single-source：三张改名映射的值域经 JSDoc 锁进 WfState 子对象键集——领域类型改名时
// tsc --noEmit 直接报错（@ts-check 逐文件生效，无需全局 checkJs）；VD 导出供 wiring.patch 单源复用。
/** @typedef {import("../../server/lib.ts").WfState} WfState */
/** @type {Record<string, keyof NonNullable<WfState["reuse"]>>} */
const REUSE = { roleSessions: "roleSessions", tierBase: "tierBase" };
/** @type {Record<string, keyof NonNullable<WfState["delivery"]>>} */
const DELIVERY = { doneGit: "doneGit", selfMod: "selfMod" };
/** @type {Record<string, keyof NonNullable<WfState["verdicts"]>>} */
export const VD = {
  planReviewVerdict: "planReview",
  testReportVerdict: "testReport",
  testPlanWritten: "testPlanWritten",
  planConfirmedAt: "confirmedAt",
  intakeConfirmedAt: "intakeConfirmedAt", // intake-discuss-gate T01：identity 映射（无 legacy 平铺别名；JSDoc 键域自动锁）
  laneTableWritten: "laneTableWritten",
  laneDepsOk: "laneDepsOk", // 效率批 P1：lane 依赖边表合法记账（identity 映射）
  probeMatrixOk: "probeMatrixOk", // W11-v2.1：probe-matrix 机器区合法记账（identity 映射）
  lessonsWritten: "lessonsWritten", // 效率批 P2：lessons 已产出记账（identity 映射）
  gateStatus: "gateStatus",
};
/** 平铺 over 键 → 新分组形状（原地修改并返回 st）。fixture 入参故意宽松（残缺/非法状态是测试本意），
 * 形状保证由上方三张映射的键域类型承担，不在函数体上较真。
 * @param {Record<string, any>} st
 * @returns {Record<string, any>} */
export function withVerdicts(st) {
  /** @type {Record<string, unknown>} */ const rest = {};
  for (const [k, v] of Object.entries(st)) {
    if (k in VD) { st.verdicts = st.verdicts ?? {}; /** @type {Record<string, unknown>} */ (st.verdicts)[VD[k]] = v; } else rest[k] = v;
  }
  /** @type {Record<string, unknown>} */ let rest2 = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k in REUSE) { st.reuse = st.reuse ?? {}; /** @type {Record<string, unknown>} */ (st.reuse)[REUSE[k]] = v; } else rest2[k] = v;
  }
  /** @type {Record<string, unknown>} */ const rest3 = {};
  for (const [k, v] of Object.entries(rest2)) {
    if (k in DELIVERY) { st.delivery = st.delivery ?? {}; /** @type {Record<string, unknown>} */ (st.delivery)[DELIVERY[k]] = v; } else rest3[k] = v;
  }
  return Object.assign(st, rest3);
}
