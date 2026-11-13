// wf-workflow — domain/session：角色→子会话自动登记与 ID 零转录续接纯函数（自 lib.ts 逐字节平移）。
// 长 ID 编排纪律：任何模型可见文本绝不回显完整 ID（回显=转录燃料）。
import { isLeader, type RoleSessions, type WfState } from "./types.ts";

// ── M16-r40：角色→子会话自动登记（纯函数可测）────────────────────────
// 仅 wf/* 非 leader 子会话、ses_ 合法形状才登记；同角色 sessionID 未变化返回 false
// （调用方据此决定是否落盘，避免每次工具调用都 save）。返回 true=已改写 st.roleSessions。
// leader 自身（workflow / wf/leader）与普通 agent（build 等）不登记。
export function trackRoleSession(st: WfState, agent: unknown, sessionID: unknown): boolean {
  const a = String(agent ?? "");
  const sid = String(sessionID ?? "");
  if (!a.startsWith("wf/") || isLeader(a)) return false;
  if (!/^ses_[A-Za-z0-9]+$/.test(sid)) return false;
  if (st.reuse?.roleSessions?.[a]?.sessionID === sid) return false; // R3 T3.1 子步 C：reuse 子对象
  ((st.reuse ??= {}).roleSessions ??= {})[a] = { sessionID: sid, at: new Date().toISOString() };
  return true;
}

// ── M16-r45：会话 ID 零转录续接（别名协议 + 近似截断判定 + lane 前缀补全，纯函数可测）──
// 根因：leader/guard 纠正后仍要模型逐字复述完整 ID——复述本身就是失真源。别名把「续用」
//   语义收敛到服务端解析：sessionID="auto"=该角色已登记会话；"@Tnn"=lanes 反查；"@wf/xx"=roleSessions 反查。
// 多 lane 安全：lanes 非空即多 lane 语境 → auto 一律拒绝，强制 @Tnn 显式指定（防续错 lane 静默分叉）。
export const SID_ALIAS_AUTO = "auto";
// 别名用法提示（guidance/错误文案同源；leader.md 与 SKILL.md 为静态托管文件，靠测试内容锚对齐）
export const SID_ALIAS_USAGE = `sessionID="auto"（无 lane 登记时即续用该角色唯一登记会话；"@Tnn" 仅限 wf:lane 已登记的 lane 使用）`;

export interface SidAliasInput {
  role?: string; // 目标角色（auto 只解析该角色自身登记，杜绝跨角色误续）
  roleSessions?: RoleSessions; // R3 T3.1 子步 C：登记表形状单点派生
  lanes?: WfState["lanes"];
}
export type SidAliasResult =
  | { ok: true; sid: string; via: string }
  | { ok: false; reason: string; candidates?: string[] };

export function resolveSidAlias(raw: unknown, input: SidAliasInput = {}): SidAliasResult {
  const t = String(raw ?? "").trim();
  const rs = input.roleSessions ?? {};
  const lanes = input.lanes ?? {};
  const laneKeys = Object.keys(lanes);
  const roleKeys = Object.keys(rs);
  if (t === SID_ALIAS_AUTO) {
    if (laneKeys.length) {
      return { ok: false, reason: `存在已登记 lane（${laneKeys.join(", ")}）——多 lane 语境下 auto 不生效，请用 "@Tnn" 显式指定`, candidates: laneKeys };
    }
    const own = input.role ? rs[input.role]?.sessionID : undefined;
    if (own) return { ok: true, sid: own, via: `role:${input.role}` };
    return { ok: false, reason: "该角色无已登记子会话——首次委派请省略 sessionID 新建（登记后即可用 auto 续用）" };
  }
  if (t.startsWith("@")) {
    const key = t.slice(1).trim();
    if (!key) return { ok: false, reason: "空别名（用法：@T01 或 @wf/builder）" };
    if (lanes[key]?.sessionID) return { ok: true, sid: lanes[key].sessionID as string, via: `lane:${key}` };
    const roleHit = rs[key]?.sessionID ?? rs[`wf/${key}`]?.sessionID; // @builder 容错等价 @wf/builder
    if (roleHit) return { ok: true, sid: roleHit, via: `role:${key}` };
    return { ok: false, reason: `别名「${t}」未命中 lane 或角色登记`, candidates: [...laneKeys, ...roleKeys] };
  }
  return { ok: false, reason: `非别名「${t}」（别名应以 ${SID_ALIAS_AUTO} 或 @ 开头）` };
}

// lane set 前缀补全：raw 为已知 ID 的唯一真前缀 → 补全；多候选/零候选由调用方处置。
export function completeSidPrefix(
  raw: unknown,
  known: string[],
): { kind: "exact" | "completed" | "ambiguous" | "unknown"; sid?: string; candidates?: string[] } {
  const s = String(raw ?? "");
  if (!/^ses_[A-Za-z0-9]+$/.test(s)) return { kind: "unknown" };
  const hits = [...new Set(known)].filter((k) => k.startsWith(s));
  if (hits.length === 1) return hits[0] === s ? { kind: "exact", sid: s } : { kind: "completed", sid: hits[0] };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  return { kind: "unknown" };
}

// 近似截断判定：公共前缀 ≥ tracked 长度 60% 且编辑距离 ≤4（供 guard-hook 对「中间位错」复述纠错）。
export function isNearTruncation(passed: string, tracked: string): boolean {
  if (!passed || !tracked || passed === tracked) return false;
  let common = 0;
  const n = Math.min(passed.length, tracked.length);
  while (common < n && passed[common] === tracked[common]) common++;
  if (common < Math.ceil(tracked.length * 0.6)) return false;
  return editDistanceAtMost(passed, tracked, 4);
}

// 编辑距离 ≤k 判定（带整行下界剪枝；ID 长 ~30，全量 DP 足够）
function editDistanceAtMost(a: string, b: string, k: number): boolean {
  if (Math.abs(a.length - b.length) > k) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > k) return false;
    prev = cur;
  }
  return prev[b.length] <= k;
}
