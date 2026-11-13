// tests/helpers/store-stub.js — Store 契约 stub（T04）。
// save CAS 语义与 server/state.ts 真实实现同源三态（stale-rev/write-error/ok + rev 单调递增），
// load/save 走 structuredClone 隔离（红字：CAS/withStateRetry 语义不动——这里只做等价复刻）。
// over 覆盖命名空间级同 mkHostStub（键=Store 方法名）。
// R3 T3.1：load 出口同源接 normalizeState（真实 store parse 出口同款）——旧平铺种子快照收敛为新形，
// 与真机行为一致（形状漂移=本地全绿真机哑火，故 stub 不许豁免 normalize）。
import { normalizeState } from "../../server/domain/types.ts";
export function mkStoreStub(states = new Map(), over = {}) {
  const reports = new Map(); // sid -> ReportRow 形状（sessionID/text/at/brief/level）
  const S = {
    load: async (sid) => {
      const v = states.get(String(sid ?? ""));
      return v ? normalizeState(structuredClone(v)) : null;
    },
    save: async (st) => {
      if (!st || st.sessionID == null) return { ok: false, reason: "no-session" };
      st.updatedAt = new Date().toISOString();
      const sid = String(st.sessionID);
      const prev = states.get(sid);
      if (prev && typeof st.rev === "number" && st.rev !== prev.rev) return { ok: false, reason: "stale-rev" };
      const rev = Number(prev?.rev ?? 0) + 1;
      st.rev = rev;
      states.set(sid, structuredClone(st));
      return { ok: true, rev };
    },
    removeState: async (sid) => { states.delete(String(sid ?? "")); reports.delete(String(sid ?? "")); },
    resolveState: async (sid) => S.load(sid),
    resolveProjectDir: async () => "/tmp/opencode",
    scanStates: async () =>
      [...states.values()].map((v) => ({
        sessionID: String(v.sessionID ?? ""), slug: v.slug ?? "", phase: v.phase ?? null,
        rounds: v.rounds ?? {}, testPlanWritten: !!v.testPlanWritten, testReportVerdict: v.testReportVerdict ?? null,
        updatedAt: v.updatedAt ?? null,
      })),
    putReport: async (r) => {
      reports.set(String(r.sessionID ?? ""), { sessionID: String(r.sessionID ?? ""), text: r.text, at: r.at ?? null, brief: r.brief ?? null, level: r.level ?? null });
    },
    getReport: async (sid) => reports.get(String(sid ?? "")) ?? null,
    dumpStates: async () => [...states.entries()].map(([k, v]) => ({ key: `wf-workflow/state/${k}`, value: structuredClone(v) })),
    ready: Promise.resolve(),
    close: () => {},
  };
  return Object.assign(S, over ?? {});
}
