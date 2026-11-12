// wf-workflow — 阶段定义单一来源（M10-d A1，消除 server/tui 两处漂移）
// server 用：BLOCKING（阶段闸门）；tui 用：PHASE_ORDER / STAGE_LABEL / FOLD / CANON（进度条、标签、折叠、canonical 产物）
// M16-r28：assign 阶段并入 test_design——PHASE_ORDER 收缩为 9 阶段；LEGACY_PHASES 保留历史阶段名
// （在途任务存量兼容 + FLOWS from 合法集守卫引用，不再作为可达阶段；reconcile 属 FOLD 折叠态不在此列）
export const PHASE_ORDER: string[] = ["intake", "planning", "review", "test_design", "building", "build_review", "testing", "fixing", "done"];
export const LEGACY_PHASES: string[] = ["assign"];

export const STAGE_LABEL: Record<string, string> = {
  intake: "intake", planning: "planning", review: "review ∥ 可行性", assign: "assign→test_design",
  test_design: "test_design（红）",
  building: "building", reconcile: "building+合并", build_review: "build_review",
  testing: "testing", fixing: "fixing", done: "done ∥ 复盘", retrospect: "done ∥ 复盘",
};
export const FOLD: Record<string, string> = { reconcile: "building", retrospect: "done" };
export const CANON: string[] = ["plan.md", "test-plan.md", "test-report.md"];
export const BLOCKING: string[] = ["planning", "review", "build_review"]; // M16-r44：+build_review（full 模式执行审核阶段业务写同受闸；worktree 默认在项目外不受影响）
// TUI 视图别名：进度条阶段顺序（与 PHASE_ORDER 同值）。独立导出而非依赖 import-as 重命名，
// 规避宿主二级模块加载器对 import { X as Y } 的导出名校验问题（ERR-20261110-002）
export const STAGE_ORDER = PHASE_ORDER;
// M16-r35：日常模式进度条阶段顺序（与 FLOWS_DAILY 可达 to 集一致，phases.test.js 守卫）。
// 同样独立导出（不用 import-as）；daily 任务按此 6 格连续渲染，不再按 9 格跳格。
export const DAILY_STAGE_ORDER: string[] = ["intake", "planning", "review", "building", "testing", "done"];
