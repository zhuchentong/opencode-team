// wf-workflow — RPC 桥（M8-a，自 index.js 原样搬移）：ctx.rpc.register(Wf)（shared/rpc.ts）
// 暴露 state/list 方法供 TUI 侧边栏订阅；流转/产物落盘时 emit("updated") 驱动刷新。
// 注册失败 fail-soft（rpcErr 记录，供 /wf:diagnose 显示；此时尚不含 tui/ 部件，server 侧可独立验证）。

export async function createRpcBridge(ctx: any, { load, scanStates }: {
  load: (sessionID: string) => Promise<any>;
  scanStates: (projectID?: string | null, directory?: string | null) => Promise<any>;
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
          if (!st) return { sessionID: input?.sessionID ?? null, active: false };
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
          };
        },
        list: async (input: any) => ({ sessions: await scanStates(input?.projectID ?? null, input?.directory ?? null) }),
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

  return { rpcReg, rpcErr, WfDef, emitUpdated };
}
