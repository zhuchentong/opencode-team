// wf-workflow — domain/diagnose：wf:diagnose 报告生成（自 lib.ts 逐字节平移，含 T01 🔇 静默失败摘要节）。
// 白名单内部边（plan §0 实测最小集）：flow(nextFor)/artifact(KIND_FILES)/session(SID_ALIAS_USAGE)。
import { LIMITS, type Limits, type SwallowEntry, type WfState } from "./types.ts";
import { nextFor } from "./flow.ts";
import { KIND_FILES } from "./artifact.ts";
import { SID_ALIAS_USAGE } from "./session.ts";
import { redactIds } from "../../shared/redact.ts";

// ── P1：wf:diagnose 报告生成（纯函数，可测）────────────────────────
// facts = { version, artifactFiles: 磁盘上实际存在的产物名[], entryErr?, rpcErr?, limits? }
// 证据来源：st.log（每次流转/拒绝/阻断都记账）+ 关卡记账 + 磁盘对账。

export interface DiagnoseFacts {
  version?: string;
  artifactFiles?: string[];
  entryErr?: string;
  rpcErr?: string | null; // M16-r39 T06：bridge rpcErr 形状同源（string|null）
  limits?: Limits;
  swallows?: SwallowEntry[]; // T01：静默失败环形采样（缺省/空 → 摘要节零行，存量输出逐字不变）
}
export function diagnoseReport(st: WfState, facts: DiagnoseFacts = {}): string {
  const out: string[] = [];
  const r: Record<string, number> = st.rounds ?? {};
  out.push(`wf 诊断(${facts.version ?? "?"})｜slug=${st.slug || "(未定)"} phase=${st.phase ?? "无"}｜${st.updatedAt ?? "无更新时间"}`);

  // 1) 审计轨迹中的拒绝/阻断
  const log = Array.isArray(st.log) ? st.log : [];
  const rejects = log.filter((e) => e && e.ok === false);
  const blocks = rejects.filter((e) => e.note === "blocked");
  const refusals = rejects.filter((e) => e.note !== "blocked");
  out.push(`流转尝试=${log.length} 拒绝=${refusals.length} 越权阻断=${blocks.length}`);
  const byNote: Record<string, number> = {};
  // R2 T2.3：细化 note（"gate-rejected:<id>" / "agent-rejected:<agent>"）按冒号前 base 归组，
  // 细分维度入 └ 子行；无冒号 note 显示与旧逐字节一致（diagnose.test 锚不破坏）。
  const bySub: Record<string, Record<string, number>> = {};
  for (const e of refusals) {
    const raw = String(e.note);
    const ci = raw.indexOf(":");
    const base = ci === -1 ? raw : raw.slice(0, ci);
    const sub = ci === -1 ? "" : raw.slice(ci + 1);
    byNote[base] = (byNote[base] ?? 0) + 1;
    if (sub) (bySub[base] ??= {})[sub] = (bySub[base][sub] ?? 0) + 1;
  }
  for (const [note, n] of Object.entries(byNote)) {
    const hint = ({
      "illegal-transition": "命令顺序错误（请核对流转表/下一步提示）",
      "gate-rejected": "关卡前置产物未产出（test-plan / test-report）",
      "limit-exceeded": "循环已达上限——按流程应停下上报用户",
      "intake-guard": "已有活动任务被守卫拦截（用 /wf:reset 或 /wf:intake ! <slug>）",
    } as Record<string, string>)[note] || "见日志详情";
    out.push(`  ✗ ${note} ×${n}：${hint}`);
    if (bySub[note]) for (const [s, k] of Object.entries(bySub[note])) out.push(`      └ ${s} ×${k}`);
  }
  for (const e of blocks.slice(-5)) out.push(`  ⛔ 越权阻断：${e.tool ?? e.cmd ?? "?"} ${e.detail ?? ""}`);

  // M16-r45：续接自愈取证——session:correct 累计（leader 复述 ID 失真率可观测）
  const fixes = log.filter((e) => e?.cmd === "session:correct");
  const fuzzyN = fixes.filter((e) => e.note === "corrected-fuzzy").length;
  if (fixes.length) out.push(`  🔁 续接自愈（session:correct）×${fixes.length}${fuzzyN ? `（其中近似匹配 ${fuzzyN}）` : ""}——续接请改用 ${SID_ALIAS_USAGE}，勿逐字复述 ID`);

  // 2) 轮次余量（facts.limits 支持实例覆盖）
  for (const [k, limit] of Object.entries({ ...LIMITS, ...facts.limits })) {
    const used = r[k] ?? 0;
    if (used >= limit) out.push(`  🛑 ${k} 已 ${used}/${limit} 轮：禁止继续循环，需用户裁决`);
  }

  // 3) 关卡记账
  out.push(`  关卡：testPlan=${st.verdicts?.testPlanWritten ? "✅ 已产出" : "❌ 未产出"}  testReport=${st.verdicts?.testReport ?? "未产出"}`); // R3 T3.1 子步 B

  // 4) 产物对账（state 记账 vs 磁盘实际）
  const known = new Set(Object.values(KIND_FILES).map((fn) => fn(st)));
  const recorded = Object.keys(st.artifacts ?? {});
  const onDisk = (facts.artifactFiles ?? []).filter((f) => /\.(md)$/.test(f));
  const missing = recorded.filter((f) => !onDisk.includes(f));
  const untracked = onDisk.filter((f) => !recorded.includes(f) && known.has(f));
  if (missing.length) out.push(`  ⚠️ 记账但磁盘缺失：${missing.join(", ")}`);
  if (untracked.length) out.push(`  ⚠️ 磁盘有但未记账：${untracked.join(", ")}（产物若经原生 write/edit 落盘，用 wf_write_artifact(kind=…) 不带 content 注册补记账即可）`);
  if (!missing.length && !untracked.length) out.push(`  ✅ 产物对账一致（${recorded.length} 项）`);

  // 5) 注入/观测通道异常
  if (st.entryErr) out.push(`  ⚠️ 阶段注入失败（guidance 可能未进系统提示）：${st.entryErr}`);
  else if (facts.entryErr) out.push(`  ⚠️ entry API 异常：${facts.entryErr}`);
  if (facts.rpcErr) out.push(`  ⚠️ RPC 注册失败（TUI 面板不可用）：${facts.rpcErr}`);

  // T01（arch-r1-host-split）：5.5) 静默失败摘要节——空/缺省零新增行；非空=总数/类数+按 code 聚合+最近 5 条
  // 明细（msg 截 120 码点且过 redactIds，红线 6 零回显）。
  if (facts.swallows?.length) {
    const byCode: Record<string, number> = {};
    for (const s of facts.swallows) byCode[s.code] = (byCode[s.code] ?? 0) + 1;
    out.push(`  🔇 静默失败（环形采样≤200）：${facts.swallows.length} 条 ${Object.keys(byCode).length} 类`);
    for (const [code, n] of Object.entries(byCode)) out.push(`    ${code} ×${n}`);
    for (const s of facts.swallows.slice(-5)) {
      const cps = Array.from(s.msg);
      const msg = cps.length > 120 ? cps.slice(0, 120).join("") : s.msg;
      out.push(`    [${String(s.at ?? "").slice(11, 19)}] ${s.code} ${redactIds(msg)}`);
    }
  }

  // 6) 下一步
  out.push(`  下一步：${nextFor(st, st.phase)}`);
  return out.join("\n");
}
