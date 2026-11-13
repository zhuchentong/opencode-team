// tests/helpers/command-deps.js — CommandDeps 全键默认（T04）。
// 键集与 server/commands.ts CommandDeps 契约同名同位；缺省行为=inert（load→null、save→ok、
// IO 探针 no-op），emitUpdated/emitReport/putReport 缺省带捕获组（deps.updated/emitted/reportRows
// 附加键，不进契约字段），消费方按需用 over 替换或直读捕获数组。
import { LIMITS } from "../../server/lib.ts";

export function mkCommandDeps(over = {}) {
  const updated = [];
  const emitted = [];
  const reportRows = [];
  const deps = {
    load: async () => null,
    save: async () => ({ ok: true }),
    resolveProjectDir: async () => "/tmp/opencode",
    removeState: async () => {},
    putReport: async (r) => { reportRows.push(structuredClone(r)); },
    dumpStates: async () => [],
    debugDirFor: async () => "/tmp/opencode",
    probeOnce: async () => {},
    LIMS: { ...LIMITS },
    emitUpdated: async (st) => { updated.push(st); },
    emitReport: async (sid, text, at, meta) => { emitted.push({ sid, text, at, meta }); },
    WfDef: null,
    rpcErr: null,
    runner: { run: null },
    // 捕获组（附加面）
    updated, emitted, reportRows,
  };
  return Object.assign(deps, over ?? {});
}
