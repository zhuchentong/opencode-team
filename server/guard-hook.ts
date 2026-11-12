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
import * as fs from "node:fs";
import { GATE_ERR, EDIT_TOOLS, BLOCKING_PHASES, extractPaths, shellWriteTargets, nextFor, trackRoleSession, isLeader } from "./lib.ts";
import { logAdd } from "./state.ts";

// probe 4：session.get 返回形状摘要（模块级纯函数，避免每次调用重建；供一次性取证）
const sessionShape = (s: any) => s ? { keys: Object.keys(s), parentID: s.parentID ?? null, hasParentID: "parentID" in s, time: s.time ?? null } : null;

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

  // M16-r41 B 层：subagent 形状探针一次性开关（ERR-002 先探形状再使用；existsSync 自禁用，非 P6 常态探针）
  let subagentProbed = false;
  let sessionGetProbed = false;

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
      // ── M16-r41 B 层：subagent 续接自愈守卫（leader 专属；必须置于 edit/shell 过滤之前）──
      // 根因：leader 凭记忆复述长 ses_ ID→截断→宿主拒→反复重试→冷启动。A 层已自动登记 roleSessions
      //   并在 guidance 渲染完整 ID；此处在续接入口对「截断/非法」的 sessionID 一次性纠正（附完整 ID）。
      // 收窄（多 lane 安全）：仅「形状非法 OR 登记 ID 的真前缀」才纠正；全形状非前缀的不符→放行交宿主归属校验。
      if (toolName === "subagent" || toolName === "task") {
        // probe 1：subagent 首次接入 hook，一次性取证「触发 + 入参形状」（best-effort，不影响守卫）
        if (!subagentProbed) {
          subagentProbed = true;
          try {
            let dir = process.cwd();
            try { const s = await ctx.session.get({ sessionID: String(input?.sessionID ?? "") }); if (s?.location?.directory) dir = String(s.location.directory); } catch { }
            const dbg = `${dir}/.workflow/_debug`;
            if (!fs.existsSync(`${dbg}/subagent-probe.json`)) {
              fs.mkdirSync(dbg, { recursive: true });
              fs.writeFileSync(`${dbg}/subagent-probe.json`, JSON.stringify({
                at: new Date().toISOString(), tool: toolName,
                inputKeys: Object.keys(input ?? {}), argKeys: Object.keys(input?.input ?? {}),
                hookAgent: input?.agent, argAgent: input?.input?.agent,
                hasSessionID: input?.input ? "sessionID" in input.input : false,
              }, null, 2));
            }
          } catch { /* 探针 best-effort */ }
        }
        // probe 4：session.get 返回形状一次性取证（parentID/time.busy/idle → 归属+存活校验可行性）
        if (!sessionGetProbed) {
          sessionGetProbed = true;
          try {
            const callerSid = String(input?.sessionID ?? "");
            const caller = await ctx.session.get({ sessionID: callerSid });
            let dir4 = process.cwd();
            if (caller?.location?.directory) dir4 = String(caller.location.directory);
            const childSid = input?.input?.sessionID ? String(input.input.sessionID) : "";
            let child: any = null; let childErr: string | null = null;
            if (childSid) { try { child = await ctx.session.get({ sessionID: childSid }); } catch (e) { childErr = String((e as Error)?.message ?? e); } }
            const dbg4 = `${dir4}/.workflow/_debug`;
            if (!fs.existsSync(`${dbg4}/session-get-probe.json`)) {
              fs.mkdirSync(dbg4, { recursive: true });
              fs.writeFileSync(`${dbg4}/session-get-probe.json`, JSON.stringify({
                at: new Date().toISOString(),
                caller: { sessionID: callerSid, ...sessionShape(caller) },
                child: childSid ? { sessionID: childSid, ...sessionShape(child), err: childErr } : null,
              }, null, 2));
            }
          } catch { /* 探针 best-effort */ }
        }
        if (!isLeader(String(input?.agent ?? ""))) return; // 仅 leader 的续接受管辖
        const st = await resolveState(input?.sessionID, input?.agent);
        if (!st) return;
        const args = input?.input ?? {};
        const target = String(args.agent ?? "");
        const passedRaw = args.sessionID;
        if (passedRaw == null || String(passedRaw) === "") return; // 省略 sessionID=新建，不干预
        const tracked = st.roleSessions?.[target]?.sessionID;
        if (!tracked) return; // 该角色无登记，不干预
        const passed = String(passedRaw);
        if (passed === tracked) return; // ID 正确，放行
        const shapeOk = /^ses_[A-Za-z0-9]+$/.test(passed);
        const isPrefix = tracked.startsWith(passed); // passed≠tracked 且非空 → startsWith 即真前缀
        if (shapeOk && !isPrefix) return; // 全形状非前缀不符→宿主归属校验（多 lane/幻觉兜底）
        // 形状非法 OR 真前缀截断 → 一次性纠正：附完整 ID（GATE_ERR 标记确保穿透 fail-open，S1）
        logAdd(st, { at: new Date().toISOString(), cmd: "session:correct", tool: toolName, detail: `${target}: ${passed} → ${tracked}`, from: st.phase, to: st.phase, ok: false, note: "corrected" });
        try { await save(st); } catch { /* 取证 best-effort，不影响纠正 */ }
        // probe 4 增强：session.get 返回 time.busy/idle（无 parentID，归属由宿主原生校验）→ 纠正时附存活状态，
        //   防「续用运行中子会话→静默分叉」。best-effort：取不到 time 则不附注（不影响纠正本身）。
        let liveNote = "";
        try {
          const child = await ctx.session.get({ sessionID: tracked });
          const busy = Number(child?.time?.busy ?? 0); const idle = Number(child?.time?.idle ?? 0);
          if (busy > 0 && idle > 0) liveNote = busy > idle
            ? " ⚠ 该子会话仍在运行：请等其完成或直接新建，勿续用运行中会话（防静默分叉）。"
            : " 该子会话已完成，可安全续用。";
        } catch { /* 存活取证 best-effort */ }
        throw new Error(
          `${GATE_ERR} 续接自愈：传给 ${target} 的 sessionID「${passed}」截断/非法。请逐字改用完整 ID 重试一次：sessionID=${tracked}（勿凭记忆复述；仅续用已完成的子会话，续用失败立即新建）。${liveNote}`
        );
      }
      if (!EDIT_TOOLS.has(toolName) && toolName !== "shell") return;
      const st = await resolveState(input?.sessionID, input?.agent); // M10-b：wf/* 子会话同样受阶段闸门管辖
      if (!st) return;
      // M16-r40：角色→子会话自动登记——builder/fixer 只改码不写产物，在此捕获其 sessionID。
      // 仅 EDIT_TOOLS 且 sessionID 变化才落盘（每子会话一次，避免 save 抖动）；登记失败不阻断（fail-open）。
      if (EDIT_TOOLS.has(toolName) && trackRoleSession(st, input?.agent, input?.sessionID)) {
        try { await save(st); } catch { /* 登记 best-effort，不影响闸门 */ }
      }
      if (!BLOCKING_PHASES.has(st.phase)) return;
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
