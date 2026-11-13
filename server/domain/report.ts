// wf-workflow — domain/report：brief/level 生成纯函数（自 lib.ts 逐字节平移）。
// 消费方：commands.ts publishOutput（T03 接线）；TUI 仅按 level==="warn" 触发 OS 通知。
import { REJECT_PREFIX, type ReportLevel, type WfState } from "./types.ts";
import { redactIds } from "../../shared/redact.ts"; // notification-brief-display T02：零回显脱敏单一来源

// ── notification-brief-display T02（plan §3.2/§3.3/§4 冻结）：brief/level 生成纯函数 ──
// 消费方：commands.ts publishOutput（T03 接线）；TUI 仅按 level==="warn" 弹 OS 通知。

// 10 个流转命令名唯一来源（B 意见：T03 把 commands.ts FLOW_COMMANDS 改为引用派生，防漂移断言在 T03）
export const FLOW_CMD_NAMES: Set<string> = new Set([
  "wf:intake", "wf:plan", "wf:review", "wf:test-design", "wf:build",
  "wf:reconcile", "wf:review-build", "wf:test", "wf:fix", "wf:done",
]);
export function isRejectReport(text: string): boolean {
  return String(text ?? "").startsWith(REJECT_PREFIX);
}

// §3.3 level 规则表（按序命中即返回）：❌ 拒绝 → wf:fix 返工 → 产物结论 FAIL 在场
// → done 交付确认需应答 → 其余 info。已知边界（plan §3.3）：full 模式 FAIL→wf:plan
// 修订轮为 info（wf:fix 才是 FAIL 处理命令，规则 2 覆盖；修订轮不重复弹属可接受降噪）。
export function levelFor(cmd: string, text: string, st: WfState | null): ReportLevel {
  if (isRejectReport(text)) return "warn"; // R1
  if (cmd === "wf:fix") return "warn"; // R2
  if ((cmd === "wf:test" && st?.testReportVerdict === "FAIL") ||
      (cmd === "wf:review" && st?.planReviewVerdict === "FAIL")) return "warn"; // R3
  if (cmd === "wf:done" && st?.phase === "done" && st?.doneGit?.isGit) return "warn"; // R4
  return "info"; // R5
}

// brief 行截断单一实现：≤max 码点截断加 …（省略号不计入正文预算）。
// 防泄漏细节：截断若落在 ID 中段（含恰停在 "ses_"），残段会躲过 redactIds 的
// [A-Za-z0-9]+ 必选尾巴 → 先剥掉尾部残段再脱敏，保证「无 ses_」不变量（G-1/A）。
export const BRIEF_LINE_MAX = 100;
export function clipBrief(line: string, max = BRIEF_LINE_MAX): string {
  const src = String(line ?? "");
  const cps = Array.from(src);
  if (cps.length <= max) return redactIds(src);
  let out = cps.slice(0, max).join("");
  // 剥掉尾部半截 ID（含恰停在 "ses_" 无后缀）；纯 "ses" 结尾不含 "ses_"，无需处理
  const m = out.match(/ses_[A-Za-z0-9]*$/);
  if (m && m.index !== undefined) out = out.slice(0, m.index);
  return `${redactIds(out)}…`;
}

// §3.2 非流转/拒绝报告兜底 brief（2 行）：命令标签 + text 首个非空行（截断 + redactIds）。
// 适用：非流转命令成功报告、一切拒绝(halt)文案、st 不可得。
export function briefFallback(cmd: string, text: string): string {
  const tag = `【wf｜${String(cmd ?? "").replace(/^wf:/, "")}】`;
  const first = String(text ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
  return `${tag}\n${clipBrief(first)}`;
}
