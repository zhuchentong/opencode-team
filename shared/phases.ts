// wf-workflow — 阶段定义单一来源（M10-d A1，消除 server/tui 两处漂移）
// server 用：BLOCKING（阶段闸门）；tui 用：PHASE_ORDER / STAGE_LABEL / FOLD / CANON（进度条、标签、折叠、canonical 产物）
export const PHASE_ORDER: string[] = ["intake", "planning", "review", "assign", "test_design", "building", "build_review", "testing", "fixing", "done"];

export const STAGE_LABEL: Record<string, string> = {
  intake: "intake", planning: "planning", review: "review ∥ 可行性", assign: "assign",
  test_design: "test_design（红）",
  building: "building", reconcile: "building+合并", build_review: "build_review",
  testing: "testing", fixing: "fixing", done: "done ∥ 复盘", retrospect: "done ∥ 复盘",
};
export const FOLD: Record<string, string> = { reconcile: "building", retrospect: "done" };
export const CANON: string[] = ["plan.md", "test-plan.md", "test-report.md"];
export const BLOCKING: string[] = ["planning", "review"];
// TUI 视图别名：进度条阶段顺序（与 PHASE_ORDER 同值）。独立导出而非依赖 import-as 重命名，
// 规避宿主二级模块加载器对 import { X as Y } 的导出名校验问题（ERR-20261110-002）
export const STAGE_ORDER = PHASE_ORDER;
