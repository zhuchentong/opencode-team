// wf-workflow TUI 公共格式化（自 index.tsx 原样搬移）：阶段定位/字符串化/时间截取/回退列表行。
import { PHASE_ORDER as STAGE_ORDER, FOLD } from "../shared/phases.js";

export const str = (v) => (v === null || v === undefined ? "" : String(v));

// ── M9 渲染规则 ───────────────────────────────────────────────────
// reconcile/retrospect 折进相邻主阶段；进度条固定 9 格（F0–F8）
// M10-d A1：阶段定义单一来源 shared/phases.js（与 server 共用）
export const stageOf = (phase) => {
  const p = FOLD[phase] ?? phase;
  const i = STAGE_ORDER.indexOf(p);
  return i < 0 ? 0 : i;
};

export const hhmm = (iso) => { const s = str(iso); return s.length >= 16 ? s.slice(11, 16) : ""; };

// M15①③：回退列表行（slug · 阶段 轮次三联）
export const listLine = (x) => {
  const r = x?.rounds ?? {};
  return `${str(x?.slug || "(未定)")} · ${str(x?.phase ?? "?")} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
};
