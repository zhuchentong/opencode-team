// tui/notify.ts — R3 T3.4 自 index.tsx 拆出：toast + attention.notify 通知层。
// notifyImportant：仅 server 结构化 level==="warn" 弹 OS 通知（notification-brief-display T04）；
// makeToastReport：sessionID|at 幂等键去重（createDeduper 单实现，R3 T3.3）+ 60s 新鲜度门 +
//   brief 呈现（briefOf 旧行降级）。依赖显式注入（context/probe/getSid/dedupe），无模块级状态。
import { str, errMsg } from "./util.ts";
import { reportId } from "./dedup.ts";
import { briefOf } from "./panel.tsx";

/**
 * 装配通知层：返回 OS 通知函数与 toastReport 工厂——报告按 sessionID|at 幂等键去重（60s 新鲜度门），
 * toast 呈现 brief（旧行本地降级），仅 level==="warn" 追加 attention.notify。
 * @param context 宿主注入的插件上下文（ui.toast / attention.notify）。
 * @param probe 调试探针函数（recv/stale-skipped/dup-skipped/toast-shown 等事件分型）。
 * @returns { notifyImportant } 系统级通知（非 warn 直接忽略）；{ makeToastReport } 闭包工厂，
 *   入参 getSid=当前会话 ID 读取器、dedupe=共享去重实例，返回 (data, chan) 形状的 toastReport。
 */
export function setupNotify(context: any, probe: (d: Record<string, unknown>) => void) {
  // P4②：系统级通知（终端焦点感知由宿主决定投递）——仅 level==="warn" 弹（废除全文正则），message 取 brief 前 160
  /**
   * 弹 OS 通知（仅 level==="warn"；message 截前 160 码点）。
   * @param msg 通知正文（通常为 brief）。
   * @param level server 判定的结构化级别（非 "warn" 静默跳过）。
   * @returns 无返回值（attention 不可用时静默降级为纯 toast）。
   */
  const notifyImportant = (msg: string, level: string) => {
    if (level !== "warn") return;
    try {
      context.attention?.notify?.({ title: "wf", message: msg.slice(0, 160), sound: false });
      probe({ evt: "notify" });
    } catch { /* attention 不可用则纯 toast 降级 */ }
  };

  /**
   * 构造 toastReport：对当前会话的报告做 60s 新鲜度门 + 幂等键去重，toast 展示 brief 并按需弹 OS 通知。
   * @param getSid 当前会话 ID 读取器（不匹配的报告直接丢弃）。
   * @param dedupe 三通道共享的去重实例（seen 判定过期/重复/淘汰）。
   * @returns toastReport 函数 (data, chan)：data 为报告负载（sessionID/text/at/brief/level），chan 为通道标记（local/rpc/data/poll，仅进探针）。
   */
  const makeToastReport = (getSid: () => string, dedupe: { seen(key: string, atMs?: number): boolean }) => {
    const toastReport = (d: any, chan: string) => {
      const sid = String(d?.sessionID ?? "");
      const text = str(d?.text);
      const at = str(d?.at);
      probe({ reportEv: "recv", chan, got: sid, cur: getSid(), chars: text.length });
      try {
        if (sid !== getSid() || !text) return;
        if (at) {
          // R3 T3.3：过期/重复/淘汰判定收敛进 createDeduper（probe 事件保持分型）
          const age = Date.now() - Date.parse(at);
          if (Number.isFinite(age) && age > 60000) { probe({ reportEv: "stale-skipped", chan }); return; }
          const key = reportId(sid, at);
          if (!dedupe.seen(key, Date.parse(at))) { probe({ reportEv: "dup-skipped", chan }); return; }
        }
        // T04：toast 呈现 brief（3-4 行结构化，server 生成；旧行本地降级）——全文墙终结；
        // 全文回看通道不变（entry/inject、wf_command 返回值、reports 槽 text 照旧）
        const brief = briefOf(d);
        context.ui.toast.show({ message: brief, variant: "info" });
        probe({ reportEv: "toast-shown", chan });
        notifyImportant(brief, str(d?.level));
      } catch (er) { probe({ reportEv: "toast-err", err: errMsg(er) }); }
    };
    return toastReport;
  };
  return { notifyImportant, makeToastReport };
}
