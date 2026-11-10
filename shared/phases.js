// wf-workflow — 阶段定义单一来源（M10-d A1，消除 server/tui 两处漂移）
// server 用：BLOCKING（阶段闸门）；tui 用：PHASE_ORDER / STAGE_LABEL / FOLD / CANON（进度条、标签、折叠、canonical 产物）
export const PHASE_ORDER = ["intake", "planning", "review", "assign", "test_design", "building", "build_review", "testing", "fixing", "done"];
export const STAGE_LABEL = {
  intake: "intake", planning: "planning", review: "review ∥ 可行性", assign: "assign",
  test_design: "test_design（红）",
  building: "building", reconcile: "building+合并", build_review: "build_review",
  testing: "testing", fixing: "fixing", done: "done ∥ 复盘", retrospect: "done ∥ 复盘",
};
export const FOLD = { reconcile: "building", retrospect: "done" };
export const CANON = ["plan.md", "test-plan.md", "test-report.md"];
export const BLOCKING = ["planning", "review"];
