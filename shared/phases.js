// ⚠️ 兼容 shim：真身为 phases.ts（TS-T1 改造）。内容与 phases.ts 逐字同步（运行时部分）。
// 存在原因：宿主 TUI 运行时对插件模块图有内容级缓存，旧 bundle 仍引用 phases.js；
// 保留本文件使新旧 import 路径都能解析。验证宿主已加载新 bundle 后可删除本文件。
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
// TUI 视图别名：进度条阶段顺序（与 PHASE_ORDER 同值）。独立导出而非依赖 import-as 重命名，
// 规避宿主二级模块加载器对 import { X as Y } 的导出名校验问题（ERR-20261110-002）
export const STAGE_ORDER = PHASE_ORDER;
