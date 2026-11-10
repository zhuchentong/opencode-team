// wf-workflow — 插件组装层：接线 state（状态存取）→ observe（观测探针）→ rpc-bridge（TUI 数据源）
// → artifact-tool（wf_write_artifact）→ guard-hook（越权阻断）→ hint（自动激活）→ commands（/wf:*）。
// 各模块职责与实测 API 结论见各文件头；流转/关卡纯逻辑单一来源见 server/lib.js；历史变更详见 git。
import {
  LIMITS, DEFAULT_ALLOW_MARKERS, DEFAULT_ALLOW_RES, makeAllowChecker,
} from "./lib.ts"; // P0-b：纯逻辑单一来源（含 shared/phases.js 的 BLOCKING）
import { createStore } from "./state.js";
import { createObserver } from "./observe.js";
import { createRpcBridge } from "./rpc-bridge.js";
import { registerArtifactTool } from "./artifact-tool.js";
import { registerGuardHook } from "./guard-hook.js";
import { registerHint } from "./hint.js";
import { registerCommands } from "./commands.js";

export default {
  id: "wf-workflow",
  async setup(ctx) {
    const opt = ctx?.options ?? {};

    // 状态存取与观测通道
    const { load, save, resolveState, resolveProjectDir, scanStates } = createStore(ctx);
    const { debugDirFor, probeOnce, logToolsOnce } = createObserver(ctx, opt);

    const allowMarkers = [...DEFAULT_ALLOW_MARKERS, ...(Array.isArray(opt.allowMarkers) ? opt.allowMarkers : [])];
    const allowRes = [...DEFAULT_ALLOW_RES, ...(Array.isArray(opt.allowRegexps) ? opt.allowRegexps.map((s) => new RegExp(s)) : [])];
    const isAllowed = makeAllowChecker(allowMarkers, allowRes);
    // P2：options.limits 实例覆盖循环上限（仅接受正整数，非法值忽略）
    const LIMS = { ...LIMITS };
    for (const k of Object.keys(LIMS)) {
      const v = Number(opt.limits?.[k]);
      if (Number.isInteger(v) && v >= 1) LIMS[k] = v;
    }
    // M10-a：闸门拒绝文案与 allowlist 同源生成（I2：旧硬写文案漏 .learnings/，与实际放行清单漂移）
    const allowHint = allowMarkers.map((m) => `${m.replace(/^\//, "").replace(/\/$/, "")}/**`).join("、");

    // ── M8-a：RPC 桥（TUI 侧边栏读状态 + 事件刷新，见 rpc-bridge.js）──
    const { rpcReg, rpcErr, WfDef, emitUpdated } = await createRpcBridge(ctx, { load, scanStates });

    // ── M3：wf_write_artifact 工具（见 artifact-tool.js）──────────
    const tools = registerArtifactTool(ctx, { resolveState, resolveProjectDir, save, emitUpdated, probeOnce, logToolsOnce });

    // ── M4：阶段越权硬阻断（planning/review 拒业务代码写；shell 门控与实测结论见 guard-hook.js）──
    const hookReg = registerGuardHook(ctx, { resolveState, isAllowed, allowHint, probeOnce, save });

    // ── P3：superpowers 式自动激活提示（fail-soft，见 hint.js）────────
    const chatReg = registerHint(ctx, opt, { resolveState, probeOnce });

    // ── /wf:* 命令与 transition/inject 编排（见 commands.js）────────
    const commands = registerCommands(ctx, { load, save, resolveProjectDir, debugDirFor, LIMS, probeOnce, emitUpdated, WfDef, rpcErr });

    return () => {
      for (const r of [commands, tools, hookReg, rpcReg, chatReg]) { try { r?.dispose?.(); } catch { } }
    };
  },
};
