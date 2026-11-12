// wf-workflow — 插件组装层：接线 state（状态存取）→ observe（观测探针）→ rpc-bridge（TUI 数据源）
// → artifact-tool（wf_write_artifact）→ guard-hook（越权阻断）→ hint（自动激活）→ commands（/wf:*）。
// 各模块职责与实测 API 结论见各文件头；流转/关卡纯逻辑单一来源见 server/lib.ts；历史变更详见 git。
import {
  LIMITS, DEFAULT_ALLOW_MARKERS, DEFAULT_ALLOW_RES, makeAllowChecker,
} from "./lib.ts"; // P0-b：纯逻辑单一来源（含 shared/phases.ts 的 BLOCKING）
import { createStore } from "./state.ts";
import { createObserver } from "./observe.ts";
import { createRpcBridge } from "./rpc-bridge.ts";
import { registerArtifactTool } from "./artifact-tool.ts";
import { registerCommandTool } from "./command-tool.ts"; // T05：模型侧状态机入口
import { registerGuardHook } from "./guard-hook.ts";
import { registerHint } from "./hint.ts";
import { registerCommands } from "./commands.ts";
import { registerRoleSync } from "./roles.ts"; // M16-r31：角色内容插件托管（B1 文件同步）
import { registerSkillSync } from "./skills.ts"; // M16-r45：session-lookup skill 托管同步（默认开启）

export default {
  id: "wf-workflow",
  async setup(ctx: any) {
    const opt = ctx?.options ?? {};

    // 状态存取（P1：SQLite 单库 .workflow/wf.db，含一次性旧 storage 迁移）与观测通道
    const store = createStore(ctx);
    await store.ready; // 迁移完成前不接命令（防半迁移窗口读到空库）
    const { load, save, resolveState, resolveProjectDir, scanStates,
      putReport, getReport, dumpStates, removeState, close: closeStore } = store;
    const { debugDirFor, probeOnce, logToolsOnce } = createObserver(ctx, opt);

    const allowMarkers = [...DEFAULT_ALLOW_MARKERS, ...(Array.isArray(opt.allowMarkers) ? opt.allowMarkers : [])];
    // M16-r39 T10：allowRegexps 逐条 try/catch——非法正则跳过（旧实现一条非法即 setup 崩溃），合法并入 allowRes
    const extraRes: RegExp[] = [];
    for (const s of (Array.isArray(opt.allowRegexps) ? opt.allowRegexps : [])) {
      try { extraRes.push(new RegExp(String(s))); } catch { /* 非法正则跳过，不阻塞插件加载 */ }
    }
    const allowRes = [...DEFAULT_ALLOW_RES, ...extraRes];
    const isAllowed = makeAllowChecker(allowMarkers, allowRes);
    // P2：options.limits 实例覆盖循环上限（仅接受正整数，非法值忽略）
    const LIMS: Record<string, number> = { ...LIMITS };
    for (const k of Object.keys(LIMS)) {
      const v = Number(opt.limits?.[k]);
      if (Number.isInteger(v) && v >= 1) LIMS[k] = v;
    }
    // M10-a：闸门拒绝文案与 allowlist 同源生成（I2：旧硬写文案漏 .learnings/，与实际放行清单漂移）
    const allowHint = allowMarkers.map((m) => `${m.replace(/^\//, "").replace(/\/$/, "")}/**`).join("、");

    // ── M8-a/M16：RPC 桥（TUI 侧边栏读状态 + exec 通道，见 rpc-bridge.ts）──
    // runner：解 bridge↔commands 循环依赖的可变引用——commands 注册时填充 run，bridge exec 调用
    const runner: { run: ((name: string, a: any) => Promise<unknown>) | null } = { run: null };
    const { rpcReg, rpcErr, WfDef, emitUpdated, emitReport } = await createRpcBridge(ctx, { load, scanStates, getReport, runner });

    // ── M3：wf_write_artifact 工具（见 artifact-tool.ts）──────────
    const tools = registerArtifactTool(ctx, { resolveState, resolveProjectDir, save, emitUpdated, probeOnce, logToolsOnce });

    // ── T05：wf_command 工具——leader 侧状态机入口（见 command-tool.ts）──
    // runner 为可变引用：commands 注册时填充 run，工具 execute 惰性取用（顺序不敏感）
    const cmdTool = registerCommandTool(ctx, { load, runner, probeOnce });

    // ── M4：阶段越权硬阻断（planning/review 拒业务代码写；shell 门控与实测结论见 guard-hook.ts）──
    const hookReg = registerGuardHook(ctx, { resolveState, isAllowed, allowHint, probeOnce, save, resolveProjectDir });

    // ── P3：superpowers 式自动激活提示（fail-soft，见 hint.ts）────────
    const chatReg = registerHint(ctx, opt, { resolveState, probeOnce, sessionGet: (q: any) => ctx.session.get(q) });

    // ── M16-r31：角色内容插件托管（opt-in syncRoles，fail-soft，见 roles.ts）──
    const roleReg = registerRoleSync(ctx, opt);

    // ── M16-r45：session-lookup skill 托管同步（默认开启 syncSkills !== false，fail-soft，见 skills.ts）──
    const skillReg = registerSkillSync(ctx, opt);

    // ── /wf:* 命令与 transition/inject 编排、P2 双轨输出（见 commands.ts）──
    const commands = await registerCommands(ctx, { load, save, resolveProjectDir, debugDirFor, LIMS, probeOnce, emitUpdated,
      emitReport: async (sid: string, text: string, at: string) => { await emitReport(sid, text, at); }, // T06：bridge 返回通道形状，deps 契约 Promise<void>（组装层适配）
      WfDef, rpcErr,
      putReport, removeState, dumpStates, runner });

    return () => {
      for (const r of [commands, tools, cmdTool, hookReg, rpcReg, chatReg, roleReg, skillReg]) { try { r?.dispose?.(); } catch { } }
      closeStore();
    };
  },
};
