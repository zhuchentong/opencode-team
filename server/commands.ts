// wf-workflow — 命令层（自 index.ts 原样搬移）：11 个流转命令表驱动（/wf:intake…/wf:done，全部经
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
import { ENTRY_KEY, HINT_KEY, KEY, IDX, STATE_PREFIX, logAdd } from "./state.ts";

export function registerCommands(ctx: any, deps: any) {
  const S = ctx.storage;
  const E = ctx?.session?.instructions?.entry;
  const { load, save, resolveProjectDir, debugDirFor, LIMS, probeOnce, emitUpdated, emitReport, WfDef, rpcErr } = deps;

  // P3：项目级角色定制——.workflow/overrides/<role>.md 存在则带入 guidance（leader 委派时全文附上）
  const listOverrides = (dir: string) => {
    try { return fs.readdirSync(`${dir}/.workflow/overrides`).filter((f: string) => f.endsWith(".md")); } catch { return []; }
  };
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

  const transition = async (sessionID: string, cmd: string, text?: string) => {
    const flow = FLOWS[cmd];
    const st = (await load(sessionID)) ?? {
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
      await save(st);
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
    await emitUpdated(st);
    await inject(st);
    await save(st);
    return guidance(flow.to, st, LIMS);
  };

  // 诊断探针（ERR-20261110-007 真机定位）：每次命令输出广播追加 .workflow/_debug/cmd-report.jsonl
  // 记录：命令名/文本长度/RPC 通道形状/emit 结果——与 TUI 侧 tui-refresh.log reportEv 联看定死点
  const reportProbe = async (sessionID: unknown, data: Record<string, unknown>) => {
    try {
      const dir = `${await debugDirFor(String(sessionID ?? ""))}/.workflow/_debug`;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(`${dir}/cmd-report.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...data }) + "\n");
    } catch { /* 探针失败不影响主流程 */ }
  };

  return ctx.command.transform((editor: any) => {
    // 统一输出通道：execute 返回值宿主不显示（2.2.6 契约 Promise<void>），广播 report 事件
    // 由 TUI toast 呈现；原样 return 保持 tests 行为锚与宿主兼容（未来若显示返回值亦无害）。
    // 统一输出通道（r29e 定案）：2.2.6 宿主 execute 返回值对用户不显示（契约 Promise<void>）。
    // 主通道 = storage 槽 wf-workflow/report/<sessionID>，TUI 轮询 state.lastReport 呈现 toast
    // （methods 通道真机实证可用）；report 事件仅作机会性补充（真机实证事件投递不通，
    // 见 ERR-20261110-007 与 r29d 探针数据）。返回值保留（tests 行为锚）。
    const add = (def: any) => editor.add({
      ...def,
      execute: async (a: any) => {
        const out = await def.execute(a);
        const text = typeof out === "string" ? out : "";
        const sid = String(a?.sessionID ?? "");
        const at = new Date().toISOString();
        if (text) {
          let slotOk = false;
          try { await S.set(`wf-workflow/report/${sid}`, { sessionID: sid, text, at }); slotOk = true; } catch { /* 写槽失败降级 */ }
          if (emitReport) await emitReport(sid, text, at);
          await reportProbe(a?.sessionID, { ev: slotOk ? "slot+emit" : "slot-fail", cmd: def.name, chars: text.length, hasChan: !!emitReport });
        } else {
          await reportProbe(a?.sessionID, { ev: "no-text", cmd: def.name, type: typeof out });
        }
        return out;
      },
    });

    // ── 11 个流转命令（表驱动：description 与原逐一注册逐字一致）────────
    const FLOW_COMMANDS = [
      ["wf:intake", "工作流入口：澄清需求/读 .learnings/补 gitignore（参数=slug）"],
      ["wf:plan", "进入 planning：委派 wf/planner 产出 plan.md"],
      ["wf:review", "进入 review（并行：planner-reviewer ∥ tester feasibility），≤3 轮"],
      ["wf:assign", "进入 assign：冻结接口、按 T<nn> 分配 lane"],
      ["wf:test-design", "进入 test_design：tester(mode=design) 按冻结接口写红验收测试（未经此阶段不可 build）"],
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
        if (!st) return `wf 工作流(${VERSION})：本会话无活动任务。先执行 /wf:intake <slug>。`;
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
        if (!st) return `wf 诊断(${VERSION})：本会话无活动任务。先执行 /wf:intake <slug>。`;
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
        const st = await load(a.sessionID); // lane 挂在 leader 会话自持状态上
        if (!st) return "❌ 本会话无活动任务。lane 登记需先 /wf:intake <slug>。";
        st.lanes = st.lanes ?? {};
        const t = promptText(a.prompt).trim().split(/\s+/);
        const op = (t[0] ?? "ls").toLowerCase();
        if (op === "set") {
          const id = String(t[1] ?? "");
          const sid = String(t[2] ?? "");
          const wt = String(t[3] ?? "");
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(id)) return `❌ lane ID 非法：「${id}」（用 T01 这类：字母数字开头，≤32 字符，仅 A-Za-z0-9._-）`;
          if (!/^ses_[A-Za-z0-9]+/.test(sid)) return `❌ 子会话 ID 非法：「${sid}」（应形如 ses_xxx，来自 subagent 返回值）`;
          st.lanes[id] = { sessionID: sid, worktree: wt || null, at: new Date().toISOString() };
        } else if (op === "rm") {
          const id = String(t[1] ?? "");
          if (!(id in st.lanes)) return `❌ 没有 lane「${id}」。当前：${Object.keys(st.lanes).join(", ") || "(空)"}`;
          delete st.lanes[id];
        } else {
          const ks = Object.keys(st.lanes);
          if (!ks.length) return "lane 列表为空。用法：/wf:lane set <Tnn> <子会话ID> [worktree路径]";
          return ks.map((k) => {
            const v = st.lanes[k];
            return `  ${k} → ${v.sessionID}${v.worktree ? ` @ ${v.worktree}` : ""}（${String(v.at ?? "").slice(0, 19)}）`;
          }).join("\n");
        }
        await save(st);
        await emitUpdated(st);
        return `✅ lanes(${VERSION}) = ${JSON.stringify(st.lanes)}`;
      },
    });
    add({
      name: "wf:reset",
      description: "开发/中止用：清除本会话的工作流状态与阶段注入",
      execute: async (a: any) => {
        const old = await load(a.sessionID); // M10-b：项目索引若指向自己则一并清除
        if (old?.projectID) { try { await S.remove(IDX(old.projectID)); } catch { } }
        await S.remove(KEY(a.sessionID));
        try { await S.remove(`wf-workflow/report/${a.sessionID}`); } catch { } // r29e：清报告槽，防新挂载重放旧 toast
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
        try { scanRaw = await S.scan({ prefix: STATE_PREFIX }); }
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
}
