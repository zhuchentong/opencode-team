// tests/helpers/wiring.js — 规范接线 harness（T04，提炼自 flows.test.js mkTimingHarness/
// mkWiringHarness 与 done-git.test.js mkHarness 并集）：Host stub + Store stub（CAS 同源）+
// CommandDeps（捕获组）+ registerCommands 真实驱动。只换装配、不动断言。
// over: { sessionID, dir, store(Map), options, sessions, instructions, host, deps }
import { registerCommands } from "../../server/commands.ts";
import { mkHostStub } from "./host-stub.js";
import { mkStoreStub } from "./store-stub.js";
import { mkCommandDeps } from "./command-deps.js";

export async function mkWiringHarness(over = {}) {
  const sid = over.sessionID ?? "ses_w";
  const dir = over.dir ?? "/tmp/opencode/wf-wiring";
  const states = over.store ?? new Map();
  const store = mkStoreStub(states, { resolveProjectDir: async () => dir, ...over.storeOver });
  const host = mkHostStub({
    options: { leaderOnly: false, ...over.options },
    location: { directory: dir },
    sessions: {
      get: async () => ({ projectID: "p1", agent: "workflow", location: { directory: dir } }),
      ...over.sessions,
    },
    instructions: over.instructions,
    ...over.host,
  });
  const deps = mkCommandDeps({
    load: store.load,
    save: store.save,
    removeState: store.removeState,
    resolveProjectDir: async () => dir,
    debugDirFor: async () => dir,
    ...over.deps,
  });
  const { dispose } = await registerCommands(host, deps);
  return {
    run: (name, text = "") => host.cmdDefs.find((c) => c.name === name).execute({ sessionID: sid, prompt: { text } }),
    reports: deps.reportRows,
    events: deps.emitted,
    updated: deps.updated,
    host,
    deps,
    cmds: host.cmdDefs,
    states,
    st: (s = sid) => states.get(s),
    // R3 T3.1 子步 B：verdicts 家族平铺键翻译进子对象（与真实写点形状同源——mock 漂移=真机哑火）
    patch: (obj, s = sid) => {
      const st = states.get(s);
      const VD = { planReviewVerdict: "planReview", testReportVerdict: "testReport", testPlanWritten: "testPlanWritten", planConfirmedAt: "confirmedAt", laneTableWritten: "laneTableWritten", gateStatus: "gateStatus" };
      const rest = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k in VD) { st.verdicts = st.verdicts ?? {}; st.verdicts[VD[k]] = v; } else rest[k] = v;
      }
      Object.assign(st, rest);
    }, // 关卡记账 fixture
    dispose,
  };
}
