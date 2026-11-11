// wf-workflow — 命令层（自 index.ts 原样搬移）：10 个流转命令表驱动（/wf:intake…/wf:done，全部经
// transition 走状态机）+ 6 个辅助命令（status/diagnose/ping/lane/reset/debug）；transition 与
// inject/listOverrides 编排亦在此（原 setup 闭包，行为不变）。
// 已验证 API（实测 2026-11-10，宿主 2.2.6）：命令 editor.add({name, description,
// execute(args={sessionID,prompt,delivery})})。**execute 契约 Promise<void>，返回值不显示
// 给用户**（实测：命令被接受但会话无输出）——故 add 处统一包装：字符串返回值经 RPC "report"
// 事件广播（TUI toast 呈现），同时保留返回值（tests 行为锚）。流转 guidance 另经 inject() 写
// instructions.entry 供 agent 消费——两条通道并行、互不干扰。
// deps 来源：load/save/resolveProjectDir（state）、debugDirFor/probeOnce（observe）、
// LIMS（index 组装：options.limits 覆盖后的生效上限）、emitUpdated/emitReport/WfDef/rpcErr（rpc-bridge）。
import * as fs from "node:fs";
import {
  VERSION, FLOWS, NEXT, BLOCKING_PHASES,
  evaluateTransition, guidance, promptText, entryValue, diagnoseReport, pingReport,
} from "./lib.ts";
import { ENTRY_KEY, HINT_KEY, logAdd } from "./state.ts";

// 降级轨报告的消息标记（注入 metadata 与剥离 hook 同源；tests 断言依赖此 key）
export const REPORT_META = "wf.report";

// M16-r28 lint 清理：以下三个纯函数不捕获 registerCommands 闭包变量，上提模块级（function-scoping）
// P3：项目级角色定制——.workflow/overrides/<role>.md 存在则带入 guidance（leader 委派时全文附上）
const listOverrides = (dir: string) => {
  try { return fs.readdirSync(`${dir}/.workflow/overrides`).filter((f: string) => f.endsWith(".md")); } catch { return []; }
};
// eslint-disable-next-line no-control-regex -- 有意：剥终端控制字符（sanitizeDisplayText 同源，quota 教训）
const sanitizeText = (t: string) => t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
// 报告剥离（降级轨上下文保护）：带 wf.report 标记的消息不进模型请求/压缩/标题
const stripReports = (event: any) => {
  if (Array.isArray(event?.messages)) {
    event.messages = event.messages.filter((msg: any) => msg?.metadata?.[REPORT_META] === undefined);
  }
};

export async function registerCommands(ctx: any, deps: any) {
  const E = ctx?.session?.instructions?.entry;
  const { load, save, resolveProjectDir, debugDirFor, LIMS, probeOnce, emitUpdated, emitReport, WfDef, rpcErr,
    putReport, removeState, dumpStates, runner } = deps;

  const inject = async (st: any) => {
    try {
      // P1：值 = 头行 + 完整阶段 guidance。entry 每次组装系统提示从存储重新渲染，
      // 故消息历史被 compaction 压缩后阶段约束仍在线（等价 superpowers post-compaction 重注入）
      const ov = st.directory ? listOverrides(st.directory) : [];
      await E.put({ sessionID: st.sessionID, key: ENTRY_KEY, value: entryValue(st, LIMS, ov) });
      delete st.entryErr;
    } catch (e) {
      st.entryErr = String((e as Error)?.message ?? e);
    }
  };

  // T02+T04：状态机推进 = load→校验→应用→inject→save 循环（≤3 次）。
  //  - 拒绝分支：仅当已有前置行才落审计（T02——旧版对全新会话也 save，凭空造出
  //    {slug:"",phase:null} 幽灵行占住面板）；审计为 best-effort，写失败不影响拒绝返回。
  //  - 成功分支：save 返回 stale-rev（并发写入使快照过期）→ 重载最新快照重跑整条评估
  //    （关卡/计数以最新状态为准）；最终写不进 → 显式报错，绝不静默丢推进（旧版忽略
  //    save 返回值，冲突时用户收到成功 guidance 而 DB 未动）。
  //  - inject 保持在 save 前（entryErr 需随本次 save 持久化）；emitUpdated 移到 save 成功
  //    之后（不向 TUI 广播未落库的状态）。
  const transition = async (sessionID: string, cmd: string, text?: string) => {
    const flow = FLOWS[cmd];
    for (let attempt = 1; ; attempt++) {
      const loaded = await load(sessionID);
      // T09：评估/改写只作用于克隆——loaded 恒为「DB 现势」快照，save 最终失败的 entry 回滚
      // 依赖它（原地改写会让回滚注入未落库的 phase/rounds，名存实亡）
      const st = loaded ? structuredClone(loaded) : {
        sessionID, slug: "", phase: null,
        rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
        lanes: {}, artifacts: {}, log: [], createdAt: new Date().toISOString(),
      };
      const from = st.phase ?? null;
      const at = new Date().toISOString();

      // P0-b：来源合法性 / gate / 计数上限 / intake 守卫与重置 → lib.evaluateTransition（拒绝不消耗循环额度）
      const r = evaluateTransition(cmd, st, text, at, LIMS);
      if (!r.ok) {
        logAdd(st, { at, cmd, from, to: from, ok: false, note: r.note });
        if (loaded) { try { await save(st); } catch { /* 审计 best-effort */ } } // T02：无前行不落盘
        return r.msg;
      }

      st.phase = flow.to;
      st.updatedAt = at;
      // M10-b：一次性补全 projectID/directory（供索引与子会话落盘定位）
      if (!st.projectID) {
        try {
          const s = await ctx.session.get({ sessionID });
          st.projectID = s?.projectID ?? null;
          st.directory = s?.location?.directory ?? null;
        } catch { }
      }
      logAdd(st, { at, cmd, from, to: flow.to, ok: true, rounds: { ...st.rounds } });
      await inject(st);
      const saved = await save(st);
      if (!saved.ok) {
        if (saved.reason === "stale-rev" && attempt < 3) continue; // T04：并发冲突→以最新快照重评估
        // T09：entry 回滚到 DB 现势——消除「系统提示已进新阶段、DB 未动」的矛盾信号
        if (loaded) await inject(loaded);
        else { try { await E.remove({ sessionID, key: ENTRY_KEY }); } catch { } } // 新建会话建行失败：无行则清指引
        return `❌ 状态保存失败（${saved.reason}），本次流转未生效（以 /wf:status 为准），请重试。`;
      }
      await emitUpdated(st);
      return guidance(flow.to, st, LIMS);
    }
  };

  // 诊断探针（ERR-20261110-007 真机定位）：每次命令输出广播追加 .workflow/_debug/cmd-report.jsonl
  // 记录：命令名/文本长度/RPC 通道形状/emit 结果——与 TUI 侧 tui-refresh.log reportEv 联看定死点
  // P6 收敛：默认关闭（真机调试期结束）；WF_DEBUG=1 开启
  const PROBE_ON = process.env.WF_DEBUG === "1";
  const reportProbe = async (sessionID: unknown, data: Record<string, unknown>) => {
    if (!PROBE_ON) return;
    try {
      const dir = `${await debugDirFor(String(sessionID ?? ""))}/.workflow/_debug`;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(`${dir}/cmd-report.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...data }) + "\n");
    } catch { /* 探针失败不影响主流程 */ }
  };

  // ── P2 双轨输出编排 ────────────────────────────────────────────────
  // publishOutput：写 reports 表 + report 事件（机会性补充）+ 探针。两条入口共用。
  const publishOutput = async (sid: string, text: string, at: string, cmdName: string) => {
    let slotOk = false;
    try { await putReport({ sessionID: sid, text, at }); slotOk = true; } catch { /* 写槽失败降级 */ }
    if (emitReport) await emitReport(sid, text, at);
    await reportProbe(sid, { ev: slotOk ? "slot+emit" : "slot-fail", cmd: cmdName, chars: text.length, hasChan: !!emitReport });
  };
  // 降级轨（Web/Desktop/无 TUI）：execute 返回值宿主不消费（契约 Promise<void>）——
  // 报告经 wait 排空后以 prompt(resume:false, steer, metadata 标记) 注入会话（2.2.6 源码
  // session.ts:187 保证不 wake），配合 context/compaction/generate hook 按标记剥离，
  // 报告不进模型上下文（quota 全套范式）。
  const injectReport = async (sid: string, text: string, cmdName: string, at: string) => {
    try {
      await ctx.session.wait?.({ sessionID: sid });
      await ctx.session.prompt({ sessionID: sid, text: sanitizeText(text), delivery: "steer", resume: false,
        metadata: { [REPORT_META]: { cmd: cmdName, at } } });
      await reportProbe(sid, { ev: "inject-ok", cmd: cmdName });
    } catch (e) {
      await reportProbe(sid, { ev: "inject-fail", cmd: cmdName, err: String((e as Error)?.message ?? e).slice(0, 140) });
    }
  };
  // exec 通道（TUI 主轨经 RPC）：按名调度原编排 + publish，不注入聊天（本地渲染返回值）。
  const byName: Record<string, (a: any) => Promise<unknown>> = {};
  if (runner) {
    runner.run = async (name: string, a: any) => {
      const base = byName[name];
      if (!base) return { text: `❌ 未知命令：${name}`, at: "" };
      const out = await base(a);
      const text = typeof out === "string" ? out : "";
      const at = new Date().toISOString();
      if (text) await publishOutput(String(a?.sessionID ?? ""), text, at, name);
      return { text, at };
    };
  }

  const reg = ctx.command.transform((editor: any) => {
    // server 命令通道 = 降级轨：publish（reports 表，TUI 轮询兜底可见）+ inject（Web/Desktop 聊天可见）。
    // 返回值保留（tests 行为锚；宿主不消费）。
    const add = (def: any) => {
      const base = def.execute;
      byName[def.name] = base;
      editor.add({
        ...def,
        execute: async (a: any) => {
          const out = await base(a);
          const text = typeof out === "string" ? out : "";
          const sid = String(a?.sessionID ?? "");
          const at = new Date().toISOString();
          if (text) {
            await publishOutput(sid, text, at, def.name);
            await injectReport(sid, text, def.name, at);
          } else {
            await reportProbe(a?.sessionID, { ev: "no-text", cmd: def.name, type: typeof out });
          }
          return out;
        },
      });
    };

    // ── 10 个流转命令（表驱动：description 与原逐一注册逐字一致；M16-r28 assign 并入 test-design）──
    const FLOW_COMMANDS = [
      ["wf:intake", "工作流入口：澄清需求/读 .learnings/补 gitignore（参数=slug）"],
      ["wf:plan", "进入 planning：委派 wf/planner 产出 plan.md"],
      ["wf:review", "进入 review（并发委派：planner-reviewer ∥ tester feasibility），≤3 轮"],
      ["wf:test-design", "进入 test_design：双通道关卡（须 test-plan.md）；冻结接口排 lane + tester(design) 写红验收测试（M16-r28：原 assign 并入）"],
      ["wf:build", "进入 building：每 lane 一 worktree + wf/builder（TDD）"],
      ["wf:reconcile", "进入 reconcile：合并各 worktree 回主树，冲突上报用户"],
      ["wf:review-build", "进入 build_review：wf/builder-reviewer，≤3 轮"],
      ["wf:test", "进入 testing：wf/tester verify → test-report.md（PASS|FAIL）"],
      ["wf:fix", "进入 fixing：同 lane 回 builder / 跨 lane 用 fixer，≤3 轮"],
      ["wf:done", "进入 done：审计汇报 + 并行 learner 复盘"],
    ];
    for (const [name, description] of FLOW_COMMANDS as [string, string][]) {
      add({ name, description, execute: async (a: any) => transition(a.sessionID, name, a.prompt) });
    }

    add({
      name: "wf:status",
      description: `查看当前工作流状态与审计轨迹（只读，${VERSION}）`,
      execute: async (a: any) => {
        const st = await load(a.sessionID);
        // T03：幽灵行（无 slug 且无 phase，历史缺陷产物）等同无任务
        if (!st || (!st.slug && !st.phase)) return `wf 工作流(${VERSION})：本会话无活动任务。先执行 /wf:intake <slug>。`;
        const r = st.rounds ?? {};
        return [
          `wf 工作流(${VERSION})状态｜session=${st.sessionID}`,
          `slug=${st.slug || "(未定)"}  phase=${st.phase}`,
          `rounds: plan_review=${r.plan_review ?? 0}/${LIMS.plan_review}  build_review=${r.build_review ?? 0}/${LIMS.build_review}  test_fix=${r.test_fix ?? 0}/${LIMS.test_fix}`,
          `gates: testPlan=${st.testPlanWritten ? "✅" : "❌"}  testReport=${st.testReportVerdict ?? "-"}`,
          `lanes: ${JSON.stringify(st.lanes ?? {})}`,
          `artifacts: ${JSON.stringify(st.artifacts ?? {})}`,
          `下一步: ${NEXT[st.phase] ?? "/wf:intake"}`,
          `最近流转:`,
          ...(st.log ?? []).slice(-8).map((e: any) =>
            `  ${e.at.slice(11, 19)} ${e.cmd} ${e.from ?? "∅"}→${e.to}${e.ok ? "" : `（${e.note}）`}`),
        ].join("\n");
      },
    });
    add({
      name: "wf:diagnose",
      description: "诊断本会话工作流：审计轨迹拒绝/阻断取证、关卡与轮次、产物磁盘对账、注入/RPC 异常与下一步",
      execute: async (a: any) => {
        const st = await load(a.sessionID);
        if (!st || (!st.slug && !st.phase)) return `wf 诊断(${VERSION})：本会话无活动任务。先执行 /wf:intake <slug>。`; // T03
        // 产物对账：落盘目录三级回退（resolveProjectDir，与 wf_write_artifact 同源）
        const dir = await resolveProjectDir(st, a.sessionID);
        let artifactFiles: string[] = [];
        try { artifactFiles = fs.readdirSync(`${dir}/.workflow/${st.slug}`); } catch { /* 目录不存在按空处理 */ }
        return diagnoseReport(st, { version: VERSION, artifactFiles, rpcErr, limits: LIMS });
      },
    });
    add({
      name: "wf:ping",
      description: "健康检查：列出 wf/* 角色 agent 注册状态与模型（只读，fail-soft）",
      execute: async (a: any) => {
        try {
          if (!ctx.agent?.list) return `wf 角色：宿主未提供 ctx.agent API（v2.2.6 实测以 agent-probe 为准）；可用 @<角色> 手动验证`;
          const res = await ctx.agent.list();
          await probeOnce(a?.sessionID, "agent-probe", { shape: Array.isArray(res) ? "array" : Object.keys(res ?? {}) });
          return pingReport(res);
        } catch (e) {
          return `wf 角色查询失败：${(e as Error)?.message ?? e}（host API 形状待 _debug/agent-probe.json 确认）`;
        }
      },
    });
    add({
      name: "wf:lane",
      description: `登记/查看 lane：set <Tnn> <子会话ID> [worktree] / rm <Tnn> / 默认 ls（${VERSION}）`,
      execute: async (a: any) => {
        const t = promptText(a.prompt).trim().split(/\s+/);
        const op = (t[0] ?? "ls").toLowerCase();
        // T04：变更提取为可重放函数——stale-rev 冲突时以最新快照重放 set/rm（≤3 次），
        // 返回错误串=操作不成立，null=已写入 st.lanes
        const applyOp = (st: any): string | null => {
          st.lanes = st.lanes ?? {};
          if (op === "set") {
            const id = String(t[1] ?? "");
            const sid = String(t[2] ?? "");
            const wt = String(t[3] ?? "");
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(id)) return `❌ lane ID 非法：「${id}」（用 T01 这类：字母数字开头，≤32 字符，仅 A-Za-z0-9._-）`;
            if (!/^ses_[A-Za-z0-9]+/.test(sid)) return `❌ 子会话 ID 非法：「${sid}」（应形如 ses_xxx，来自 subagent 返回值）`;
            st.lanes[id] = { sessionID: sid, worktree: wt || null, at: new Date().toISOString() };
            return null;
          }
          const id = String(t[1] ?? "");
          if (!(id in st.lanes)) return `❌ 没有 lane「${id}」。当前：${Object.keys(st.lanes).join(", ") || "(空)"}`;
          delete st.lanes[id];
          return null;
        };
        const st0 = await load(a.sessionID); // lane 挂在 leader 会话自持状态上
        if (!st0) return "❌ 本会话无活动任务。lane 登记需先 /wf:intake <slug>。";
        if (op !== "set" && op !== "rm") { // ls（默认）只读，不落盘
          const ks = Object.keys(st0.lanes ?? {});
          if (!ks.length) return "lane 列表为空。用法：/wf:lane set <Tnn> <子会话ID> [worktree路径]";
          return ks.map((k: string) => {
            const v = st0.lanes[k];
            return `  ${k} → ${v.sessionID}${v.worktree ? ` @ ${v.worktree}` : ""}（${String(v.at ?? "").slice(0, 19)}）`;
          }).join("\n");
        }
        for (let attempt = 1; ; attempt++) {
          const st = attempt === 1 ? st0 : await load(a.sessionID);
          if (!st) return "❌ 状态行已不存在（并发 reset？），lane 变更未生效。";
          const err = applyOp(st);
          if (err) return err;
          const saved = await save(st);
          if (saved.ok) {
            await emitUpdated(st);
            return `✅ lanes(${VERSION}) = ${JSON.stringify(st.lanes)}`;
          }
          if (saved.reason === "stale-rev" && attempt < 3) continue;
          return `❌ 状态保存失败（${saved.reason}），lane 变更未生效，请重试。`;
        }
      },
    });
    add({
      name: "wf:reset",
      description: "开发/中止用：清除本会话的工作流状态与阶段注入",
      execute: async (a: any) => {
        await removeState(a.sessionID); // P1：清任务行与报告槽（防新挂载重放旧 toast；events 流水保留审计）
        try { await E.remove({ sessionID: a.sessionID, key: ENTRY_KEY }); } catch { }
        try { await E.remove({ sessionID: a.sessionID, key: HINT_KEY }); } catch { }
        await emitUpdated({ sessionID: a.sessionID, slug: "", phase: null, rounds: {} }); // M10-a：A3，TUI 实时反映清除
        return "wf 工作流：本会话状态已清除。可用 /wf:intake <slug> 重新开始。";
      },
    });
    add({
      name: "wf:debug",
      description: "观测通道：把当前状态与审计轨迹落盘到 <项目>/.workflow/_debug/state.json",
      execute: async (a: any) => {
        const st = await load(a.sessionID);
        let entries = null;
        if (!E?.list) entries = "no entry API";
        else {
          try { entries = await E.list({ sessionID: a.sessionID }); }
          catch (e1) {
            try { entries = await E.list({ sessionID: a.sessionID, key: ENTRY_KEY }); }
            catch (e2) { entries = `ERR1:${(e1 as Error)?.message ?? e1} | ERR2:${(e2 as Error)?.message ?? e2}`; }
          }
        }
        let sessProbe = null;
        {
          const tries: Record<string, any> = {};
          const candidates = [
            ["flat-sessionID", { sessionID: a.sessionID }],
            ["path-sessionID", { path: { sessionID: a.sessionID } }],
            ["path-id", { path: { id: a.sessionID } }],
            ["query-sessionID", { query: { sessionID: a.sessionID } }],
            ["string", a.sessionID],
          ];
          for (const [label, arg] of candidates) {
            try {
              const r = await ctx.session.get(arg);
              tries[label] = { ok: true, topKeys: Object.keys(r ?? {}), dataKeys: Object.keys(r?.data ?? {}), location: r?.data?.location ?? r?.location ?? null };
            } catch (e) {
              tries[label] = { ok: false, err: String((e as Error)?.message ?? e).slice(0, 140) };
            }
          }
          sessProbe = tries;
        }
        let rpcSelf = null;
        try { rpcSelf = WfDef ? await ctx.rpc(WfDef).state({ sessionID: a.sessionID }) : "no-rpc-def"; }
        catch (e) { rpcSelf = `ERR:${String((e as Error)?.message ?? e)}`; }
        let rpcList = null;
        try { rpcList = WfDef ? await ctx.rpc(WfDef).list({}) : "no-rpc-def"; }
        catch (e) { rpcList = `ERR:${String((e as Error)?.message ?? e)}`; }
        let rpcListMine = null;
        try { rpcListMine = WfDef ? await ctx.rpc(WfDef).list(st?.projectID ? { projectID: String(st.projectID), ...(st.directory ? { directory: String(st.directory) } : {}) } : {}) : "no-rpc-def"; }
        catch (e) { rpcListMine = `ERR:${String((e as Error)?.message ?? e)}`; }
        let scanRaw = null;
        try { scanRaw = await dumpStates(); } // P1：DB 转储（近似旧 storage scan 的 [{key,value}] 形状）
        catch (e) { scanRaw = `ERR:${String((e as Error)?.message ?? e)}`; }
        const out = { dumpedAt: new Date().toISOString(), version: VERSION, state: st, entries, entryKey: ENTRY_KEY, limits: LIMS, blockingPhases: [...BLOCKING_PHASES], sessProbe, rpcErr, rpcSelf, rpcList, rpcListMine, scanRaw };
        const dbg = await debugDirFor(a.sessionID); // P0-a：按会话解析
        try {
          const p = `${dbg}/.workflow/_debug`;
          fs.mkdirSync(p, { recursive: true });
          fs.writeFileSync(`${p}/state.json`, JSON.stringify(out, null, 2));
        } catch { /* ignore */ }
        return `wf 工作流状态已落盘：${dbg}/.workflow/_debug/state.json`;
      },
    });
  });

  const hookRegs: any[] = [];
  try {
    for (const h of ["context", "compaction", "generate"]) {
      const r = await ctx.session?.hook?.(h, stripReports);
      if (r) hookRegs.push(r);
    }
    const rt = await ctx.session?.hook?.("title", (event: any) => {
      stripReports(event);
      const hasText = (event?.messages ?? []).some((m: any) => {
        const c = m?.content;
        if (typeof c === "string") return c.trim() !== "";
        return Array.isArray(c) ? c.some((p: any) => p?.type === "text" && String(p?.text ?? "").trim() !== "") : false;
      });
      if (!hasText) event.result = ""; // 首条消息仅报告：跳过标题生成（quota 先例）
    });
    if (rt) hookRegs.push(rt);
  } catch { /* 宿主缺 hook API：降级为报告入上下文 */ }

  return {
    dispose: () => {
      try { reg?.dispose?.(); } catch { }
      for (const r of hookRegs) { try { r?.dispose?.(); } catch { } }
    },
  };
}
