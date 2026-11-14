// shared/report.ts — R3 T3.3（arch-r3-state-shape-migration）Transactional Outbox 正名。
// r29e 事故后演化出的野生契约穿上模式外衣：reports 表=事实源（outbox），事件=机会性加速通道，
// TUI 轮询=对账投递，`sessionID|at`=幂等消费键（本文件 reportId 单一生成点）。
// shared 下层：server 与 TUI 均可 import（两进程各自打包，结构同一由 tests/rpc-drift.test.js 源码级守卫）。
// 详见 docs/HOST-CONTRACT.md「Transactional Outbox」节。

export type ReportLevel = "info" | "warn";

// RPC/回执报文截断上限（commands.ts publishOutput 与 rpc-bridge read 同源共用，禁各端散落 64*1024）
export const PAYLOAD_MAX = 64 * 1024;

// 报告对象（wire 投影不变；id 为幂等消费键，optional 兼容旧载荷）
export interface Report {
  id: string; // reportId(sessionID, at)
  at: string;
  text: string;
  brief: string | null;
  level: ReportLevel | null;
}

// 幂等消费键单一生成点（TUI 去重/对账一致性的锚）
export function reportId(sessionID: string, at: string): string {
  return `${sessionID}|${at}`;
}

// 去重纯函数（server/TUI 共用单实现）——取代 tui/index.tsx 手写 shown Set + 60s 新鲜度门 + cap50。
// 语义与原 TUI 行为逐字等价：
//   过期（now-atMs > ttlMs）→ false（跳过，且不登记——与原「stale-skipped 不入 Set」一致）；
//   重复（key 已登记）→ false；首见 → 登记（FIFO 淘汰最旧超 cap）并返回 true（应处理）。
export function createDeduper(opts?: {
  ttlMs?: number; // 默认 60000（60s ≫ 轮询 5s：存活窗口内报告最迟 5s 被 poll 捞到且仍在门内）
  cap?: number;   // 默认 50（FIFO 淘汰最旧）
  now?: () => number; // 时钟注入（测试用；默认 Date.now）
}): { seen(key: string, atMs?: number): boolean } {
  const ttlMs = opts?.ttlMs ?? 60000;
  const cap = opts?.cap ?? 50;
  const now = opts?.now ?? Date.now;
  const map = new Map<string, number>(); // key → atMs（Map 保序= FIFO 淘汰基准）
  return {
    seen(key: string, atMs: number = Date.now()): boolean {
      const t = now();
      if (Number.isFinite(atMs) && t - atMs > ttlMs) return false; // 过期：跳过（不登记）
      if (map.has(key)) return false; // 重复：跳过
      map.set(key, atMs);
      if (map.size > cap) {
        const first = map.keys().next().value;
        if (first !== undefined) map.delete(first);
      }
      return true; // 首见：应处理
    },
  };
}
