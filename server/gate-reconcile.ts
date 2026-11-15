// wf-workflow — gate-reconcile：gate 拒绝路径磁盘对账自动补注册（r53 批次 2，test_007 教训延伸）。
// 语义：「原生 edit 落盘后忘 register」的产物会缺 verdicts 记账而卡 gate——拒绝分支内对账补记
// （复用 register 语义子集：artifacts+verdicts+lane 表解析+审计），后重放评估一次。
// 边界：只补「已落盘未记账」；0 字节/缺失不造；重放仅一次（调用侧保证）；拒绝文案零改动。
// 勿在 gate 评估前对账：transition apply 位于 withStateRetry CAS 周期内，前置 save 会引发
// rev 冲突与重放重复执行——本函数只改内存 st（随外层 apply 一次 save 落盘，天然幂等）。
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { KIND_FILES, parseVerdict, type WfState } from "./lib.ts";
import { logAdd } from "./state.ts";
import { swallow } from "./observe.ts";

/** hash：sha256 前 12 位（与 artifact-tool/managed-sync 同源口径）。 */
const hashOf = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex").slice(0, 12);

/** 命令 → gate 依赖产物 kind（关卡的文件面；确认类记账 confirmedAt 经 question 观测，不在文件面内）。 */
const GATE_KINDS: Record<string, string[]> = {
  "wf:build": ["plan-review", "plan"], // daily-build（M/L 须 planReview=PASS+lane 表；plan 兼带 laneTableWritten 解析）
  "wf:test-design": ["test-plan"],     // dual-channel（full 双通道）
  "wf:done": ["test-report"],          // acceptance（结论 PASS）
};

/**
 * gate 拒绝路径对账：cmd 关卡依赖的产物若「盘上已落盘且未记账」则补 register 记账（内存 st 就地改，
 * 随调用侧 apply 的 save 落盘）。返回是否发生补记（true=调用侧可重放评估一次）。
 * fail-soft：任何 IO 异常按单 kind 跳过，不影响拒绝主路径。
 */
export function reconcileGateArtifacts(st: WfState, cmd: string, dir: string, at: string): boolean {
  const kinds = GATE_KINDS[cmd];
  if (!kinds || !st.slug) return false;
  let fixed = false;
  for (const kind of kinds) {
    try {
      const file = KIND_FILES[kind](st);
      if (st.artifacts?.[file]) continue; // 已记账不重复（含遗留 bytes-only 形状）
      const target = `${dir}/.workflow/${st.slug}/${file}`;
      if (!fs.existsSync(target)) continue; // 未落盘不造
      const content = fs.readFileSync(target, "utf8");
      if (!content.length) continue; // 空文件=疑似截断残留，不补（与 register 拒绝语义一致）
      st.artifacts = st.artifacts ?? {};
      st.artifacts[file] = { at, bytes: fs.statSync(target).size, hash: hashOf(fs.readFileSync(target)) };
      st.verdicts = st.verdicts ?? {};
      if (kind === "test-report") st.verdicts.testReport = parseVerdict(content);
      if (kind === "plan-review") st.verdicts.planReview = parseVerdict(content);
      if (kind === "test-plan") st.verdicts.testPlanWritten = true;
      if (kind === "plan") st.verdicts.laneTableWritten = /lane 分组表/.test(content); // 与 artifact-tool 同款解析
      logAdd(st, { at, cmd, from: st.phase ?? null, to: st.phase ?? null, ok: true, note: `${file} mode=register-gate-reconcile`, detail: `hash=${hashOf(fs.readFileSync(target))}` });
      fixed = true;
    } catch (e) { swallow(e, "gate-reconcile:kind-skip"); } // fail-soft：单 kind 异常跳过，不阻断拒绝主路径
  }
  return fixed;
}
