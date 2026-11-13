// wf-workflow — 会话 ID 零回显脱敏单一来源（notification-brief-display T02，plan §4 冻结）。
// server（lib.ts briefFallback / guidance.ts briefForTransition）与 TUI（briefOf 降级）各自
// import 同源。G-1：替换 token「〔已隐去〕」必不含 "ses_" 子串——否则 brief 的
// !includes("ses_") 不变量断言必红（tests/brief-level.test.js 锁死）。
// 形状对齐 lib.ts trackRoleSession/completeSidPrefix 的 /ses_[A-Za-z0-9]+/ ID 约定。

export function redactIds(text: string): string {
  return String(text ?? "").replace(/ses_[A-Za-z0-9]+/g, "〔已隐去〕");
}
