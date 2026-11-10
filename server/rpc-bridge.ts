// wf-workflow — RPC 桥（M8-a，自 index.ts 原样搬移）：ctx.rpc.register(Wf)（shared/rpc.ts）
// 暴露 state/list 方法供 TUI 侧边栏订阅；流转/产物落盘时 emit("updated") 驱动刷新。
// 注册失败 fail-soft（rpcErr 记录，供 /wf:diagnose 显示；此时尚不含 tui/ 部件，server 侧可独立验证）。
// P1：命令输出槽迁移至 SQLite reports 表（getReport 由 state.ts 注入，ctx.storage 不再参与）。

export async function createRpcBridge(ctx: any, { load, scanStates, getReport, runner }: {
  load: (sessionID: string) => Promise<any>;
  scanStates: (projectID?: string | null, directory?: string | null) => Promise<any>;
  getReport: (sessionID: string) => Promise<any>;
  runner: { run: ((name: string, a: any) => Promise<unknown>) | null };
}) {
  let rpcReg = null;
  let rpcErr = null;
  let WfDef = null;
  try {
    if (ctx.rpc?.register) {
      const mod = await import("../shared/rpc.ts");
      WfDef = mod.Wf;
      rpcReg = await ctx.rpc.register(WfDef, {
        state: async (input: any) => {
          const st = await load(input?.sessionID);
          // P1 主通道：命令输出写 reports 表，state 输出附带 lastReport 供 TUI 轮询
          let lastReport = null;
          try {
            lastReport = (await getReport(String(input?.sessionID ?? ""))) ?? null;
          } catch { /* 读槽失败按无报告处理 */ }
          if (!st) return { sessionID: input?.sessionID ?? null, active: false, lastReport };
          return {
            sessionID: st.sessionID,
            active: true,
            slug: st.slug ?? "",
            phase: st.phase ?? null,
            rounds: st.rounds ?? {},
            testPlanWritten: !!st.testPlanWritten,
            testReportVerdict: st.testReportVerdict ?? null,
            artifacts: st.artifacts ?? {},
            updatedAt: st.updatedAt ?? null,
            lastReport,
          };
        },
        list: async (input: any) => ({ sessions: await scanStates(input?.projectID ?? null, input?.directory ?? null) }),
        // P2 主轨：TUI 本地命令经 exec 拿完整输出文本（methods 返回值通道，2.2.6 实证可用）。
        // 未知命令不抛错（抛错 client 只见 rpc.internal，原因被吞——quota 教训）；返回错误文案。
        exec: async (input: any) => {
          try {
            const res = await runner?.run?.(String(input?.name ?? ""), {
              sessionID: String(input?.sessionID ?? ""),
              prompt: { text: String(input?.prompt ?? "") },
            });
            if (res && typeof res === "object" && typeof (res as any).text === "string") {
              return { text: (res as any).text, at: String((res as any).at ?? "") };
            }
            return { text: `❌ 未知命令：${String(input?.name ?? "")}`, at: "" };
          } catch (e) {
            return { text: `❌ 命令执行失败：${String((e as Error)?.message ?? e)}`, at: "" };
          }
        },
      });
    } else rpcErr = "ctx.rpc 不可用";
  } catch (e) {
    rpcErr = String((e as Error)?.message ?? e);
  }

  const emitUpdated = async (st: any) => {
    try {
      await rpcReg?.events?.emit("updated", {
        sessionID: st.sessionID,
        slug: st.slug ?? "",
        phase: st.phase ?? null,
        rounds: st.rounds ?? {},
      });
    } catch { /* 事件失败不影响主流程 */ }
  };

  // 命令输出广播：宿主 execute 返回值不显示给用户（2.2.6 契约 Promise<void>）。
  // P1：主通道 = commands.ts 写 reports 表 + TUI 轮询 state.lastReport；report 事件为补充通道
  // （P0④ 五条件版真机打通投递，TUI 双通道 + sessionID|at 去重）。
  // at 与 reports 表同一时间戳，TUI 跨通道统一去重。fail-soft，同 emitUpdated。
  // 诊断期返回通道形状（供 commands.ts 探针记录）。
  const emitReport = async (sessionID: string, text: string, at: string) => {
    const chan = { hasReg: !!rpcReg, hasEvents: !!rpcReg?.events, hasEmit: !!rpcReg?.events?.emit };
    try {
      await rpcReg?.events?.emit("report", { sessionID: String(sessionID ?? ""), text: String(text ?? ""), at });
      return { ...chan, emitted: true };
    } catch (e) {
      return { ...chan, emitted: false, err: String((e as Error)?.message ?? e) };
    }
  };

  return { rpcReg, rpcErr, WfDef, emitUpdated, emitReport };
}
