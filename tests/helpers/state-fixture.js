// tests/helpers/state-fixture.js — R3 T3.1（arch-r3-state-shape-migration）测试侧形状同源。
// verdicts 家族平铺键 → 子对象翻译（与 wiring.patch、server 真实写点同源；mock 漂移=本地绿真机哑火）。
// 供各测试文件的 mkSt/blank 工厂收口：工厂仍接受平铺 over 键，产出恒新形状态对象。
const VD = {
  planReviewVerdict: "planReview",
  testReportVerdict: "testReport",
  testPlanWritten: "testPlanWritten",
  planConfirmedAt: "confirmedAt",
  gateStatus: "gateStatus",
};
export function withVerdicts(st) {
  const rest = {};
  for (const [k, v] of Object.entries(st)) {
    if (k in VD) { st.verdicts = st.verdicts ?? {}; st.verdicts[VD[k]] = v; } else rest[k] = v;
  }
  return Object.assign(st, rest);
}
