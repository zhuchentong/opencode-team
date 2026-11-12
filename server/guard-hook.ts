// wf-workflow — 阶段越权硬阻断（M4/M10-c，自 index.ts 原样搬移）：planning/review 拒项目内业务代码写
// （edit/write/patch + shell 重定向/写删命令；M16-r28 B1-1：两分支统一「项目内才管辖」containment，
//   项目外路径放行——真机实证 review 阶段 /tmp/opencode/ 临时脚本被误拦）；阻断记账 gate:block 进审计轨迹（P1，供 /wf:diagnose 取证）。
// 已验证 API（实测 2026-11-09）：hook ctx.tool.hook("execute.before", async (input, output) => …)，
// 实测 input={tool, sessionID, agent, messageID, id, input}——工具入参在 input.input（output 为空，
// slim 参考的 output.args 形状在 v2.2.6 不成立）；抛异常=拦截工具调用。
// M10-c 实测结论（shell-probe.json）：ctx.shell.hook("create.before") 的 input 仅
// {command,cwd,timeout,shell,env}，**无 sessionID/agent** → 无法按会话/agent 管辖；
// shell 门并入下方 tool hook 的 tool=="shell" 分支（tool hook 携带会话身份）。
// P4 公告（goopspec blocked-append）：拒绝消息自带当前阶段的下一步命令名（NEXT 同源），
// 被拦的 agent 无需再查 instructions.entry 就知道该怎么走。
import { GATE_ERR, EDIT_TOOLS, BLOCKING_PHASES, extractPaths, shellWriteTargets, nextFor } from "./lib.ts";
import { logAdd } from "./state.ts";

// P4：下一步提示（NEXT/NEXT_DAILY 表与流转指引同源，防文案漂移）；T06：模型侧经 wf_command 推进
// M16-r34：mode 感知（daily 用 NEXT_DAILY）；模块级纯函数，只捕获模块 import，不依赖闭包
const nextHint = (st: any, phase: string) => `当前阶段「${phase}」下一步：${nextFor(st, phase)}（leader 调用 wf_command(name=…) 推进，用户手敲亦可）。`;

export function registerGuardHook(ctx: any, deps: any) {
  const { resolveState, isAllowed, allowHint, probeOnce, save, resolveProjectDir } = deps;

  // P1：阶段越权阻断记账（gate:block 进审计轨迹，供 /wf:diagnose 取证；落盘失败不影响阻断）
  const logBlock = async (st: any, tool: string, detail: string) => {
    logAdd(st, { at: new Date().toISOString(), cmd: "gate:block", tool, detail, from: st.phase, to: st.phase, ok: false, note: "blocked" });
    try { await save(st); } catch { }
  };

  // ── M4：阶段越权硬阻断（planning/review 拒业务代码写）──────────
  return ctx.tool.hook("execute.before", async (input: any, output: any) => {
    try {
      await probeOnce(input?.sessionID, "hook-probe", {
        inputKeys: Object.keys(input ?? {}),
        outputKeys: Object.keys(output ?? {}),
        tool: input?.tool, sessionID: input?.sessionID, callID: input?.callID,
      });
      // M10-c v2：shell 也经 tool hook 门控（实测 ctx.shell.hook 的 input 仅 {command,cwd,timeout,shell,env}，
      // 无 sessionID/agent 无法按会话管辖；tool hook 对 tool=="shell" 携带 input.input.command + 会话身份）
      const toolName = String(input?.tool);
      if (!EDIT_TOOLS.has(toolName) && toolName !== "shell") return;
      const st = await resolveState(input?.sessionID, input?.agent); // M10-b：wf/* 子会话同样受阶段闸门管辖
      if (!st || !BLOCKING_PHASES.has(st.phase)) return;
      if (toolName === "shell") {
        const cmd = String(input?.input?.command ?? "");
        const base = String(input?.input?.cwd ?? st.directory ?? "");
        for (const tRaw of shellWriteTargets(cmd)) { // P0-b：解析提取至 lib
          if (tRaw.startsWith("~")) continue; // 家目录视为项目外
          const abs = (tRaw.startsWith("/") ? tRaw : `${base}/${tRaw}`).replace(/\/{2,}/g, "/");
          if (base && abs.startsWith(`${base}/`) && !isAllowed(abs)) {
            await logBlock(st, toolName, tRaw); // P1：阻断记账，供 /wf:diagnose 取证
            throw new Error(
              `${GATE_ERR} 硬关卡：阶段「${st.phase}」禁止经 shell 写入项目内业务文件「${tRaw}」（放行：${allowHint}）。计划/审核产物请写 .workflow/。${nextHint(st, st.phase)}`
            );
          }
        }
        return;
      }
      // 实测（hook-probe.json）：工具入参在 input.input，output.args 形状不存在
      const paths = extractPaths(String(input?.tool), input?.input ?? output?.args);
      if (!paths.length) return;
      // M16-r28 B1-1：项目 containment——闸门本意是护「项目内业务代码」，项目外写入
      //（/tmp/opencode/ 临时验证脚本等，真机实证 review 阶段被误拦）不构成越权 → 放行。
      // 对齐 shell 分支既有语义（abs.startsWith(base+"/")）；base 解析不到按项目内处理（fail-closed 同旧行为）
      const dirRaw = String(st.directory ?? (await resolveProjectDir?.(st, input?.sessionID)) ?? "");
      const base = dirRaw.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
      for (const p of paths) {
        const norm = String(p ?? "").replace(/\\/g, "/");
        if (norm.startsWith("~")) continue; // 家目录视为项目外（与 shell 分支同语义）
        const abs = (norm.startsWith("/") ? norm : `${base}/${norm}`).replace(/\/{2,}/g, "/");
        if (base && !abs.startsWith(`${base}/`)) continue; // 项目外 → 放行
        if (!isAllowed(abs)) {
          await logBlock(st, String(input?.tool), p); // P1：阻断记账
          throw new Error(
            `${GATE_ERR} 硬关卡：阶段「${st.phase}」禁止修改业务代码 ${p}（放行：${allowHint} 与 *.test/*.spec 文件）。` +
            `计划/审核产物请用 wf_write_artifact 工具写入 .workflow/。${nextHint(st, st.phase)}`
          );
        }
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes(GATE_ERR)) throw e; // 关卡异常向上抛 = 拦截工具调用
      // 其它内部异常不阻断（fail-open），已在 §11 声明
    }
  });
}
