// tui/data.ts — R3 T3.4 自 index.tsx 拆出：对账拉取 refresh（5s 轮询/事件回调共享）。
// state 投影 → snap 信号（fingerprint 门禁：无真实变化且同一 5s tick 内绝不发信号——OpenTUI
// 不短路赋值，bump 即全树重建重绘）；inactive 回退列表（本项目→全局，M15 语义保留）；
// tick=floor(now/5000) 闲置期驱动耗时刷新（复用 5s 轮询，不加新 timer）。依赖显式注入。
import { errMsg } from "./util.ts";
import { listLine } from "./panel.tsx";

/**
 * 装配对账拉取：refresh 按 fingerprint 门禁把 state 投影写入 snap 信号（无真实变化且同一
 * 5s tick 内绝不发信号），inactive 时回退拉取本项目→全局活动任务列表；markStale 清空指纹强制重拉。
 * @param context 宿主注入的插件上下文（data.session.get 取 projectID/directory）。
 * @param deps 依赖注入对象（probe/getSid/rpc/rpcOpts/setSnap/toastReport）。
 * @param deps.probe 调试探针函数。
 * @param deps.getSid 当前会话 ID 读取器（空则 refresh 直接跳过）。
 * @param deps.rpc RPC 客户端工厂（state/list 调用）。
 * @param deps.rpcOpts RPC 调用选项工厂（location 必带）。
 * @param deps.setSnap snap 信号 setter（写入 { st, oth, othScope, err } 投影）。
 * @param deps.toastReport 轮询通道报告回调（s.lastReport 补偿达）。
 * @returns { refresh } 单次对账拉取函数；{ markStale } 清空 lastFp 指纹（会话切换/重连时用）。
 */
export function setupRefresh(
  context: any,
  deps: { probe: (d: Record<string, unknown>) => void; getSid: () => string; rpc: () => any; rpcOpts: () => any; setSnap: (v: any) => void; toastReport: (d: any, chan: string) => void },
) {
  const { probe, getSid, rpc, rpcOpts, setSnap, toastReport } = deps;
  let lastFp = "";
  /** 单次对账：拉 state → 补偿 lastReport → inactive 回退列表 → fingerprint 门禁后写 snap。 */
  const refresh = async () => {
    const sid = getSid();
    if (!sid) return;
    try {
      const s = await rpc().state({ sessionID: sid }, rpcOpts());
      if (s?.lastReport) toastReport(s.lastReport, "poll");
      let oth: string[] = [];
      let othScope = "";
      if (!s?.active) {
        // 回退列表：本项目活跃任务 → 全局（M15 语义保留）
        let pid = null;
        let dir = null;
        try {
          const cs = context.data?.session?.get(sid);
          pid = cs?.projectID ?? null;
          dir = cs?.location?.directory ?? null;
        } catch { }
        try {
          const mine = await rpc().list(pid ? { projectID: String(pid), ...(dir ? { directory: String(dir) } : {}) } : {}, rpcOpts());
          const act = (Array.isArray(mine?.sessions) ? mine.sessions : []).filter((x: any) => x?.phase && x.phase !== "done").slice(0, 3);
          if (act.length) {
            oth = act.map(listLine); othScope = "本项目";
          } else {
            const allR = await rpc().list({}, rpcOpts());
            const cross = (Array.isArray(allR?.sessions) ? allR.sessions : []).filter((x: any) => x?.phase && x.phase !== "done").slice(0, 3);
            if (cross.length) { oth = cross.map(listLine); othScope = "全局·其它项目"; }
          }
        } catch { /* 回退列表失败按无处理 */ }
      }
      // fingerprint 门禁：无真实变化且同一 5s tick 内绝不发信号（OpenTUI 不短路赋值，bump 即全树重建重绘）；
      // tui-sidebar-elapsed：tick=floor(now/5000) 闲置期驱动耗时刷新（复用 5s 轮询，不加新 timer）
      const fp = JSON.stringify([s ?? null, oth, othScope, Math.floor(Date.now() / 5000)]);
      if (fp !== lastFp) {
        lastFp = fp;
        probe({ evt: "refresh", sid, active: !!s?.active, othN: oth.length });
        setSnap({ st: s ?? { active: false }, oth, othScope, err: null });
      }
    } catch (e) {
      const msg = errMsg(e);
      probe({ evt: "refresh-err", err: msg });
      const fp = "ERR:" + msg;
      if (fp !== lastFp) { lastFp = fp; setSnap({ st: null, oth: [], othScope: "", err: msg }); }
    }
  };
  // markStale：清空指纹使下次 refresh 必发信号（server.connected / 会话切换的强制重拉出口）
  return { refresh, markStale: () => { lastFp = ""; } };
}
