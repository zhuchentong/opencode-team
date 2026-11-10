// wf-workflow — 插件组装层：接线 state（状态存取）→ observe（观测探针）→ rpc-bridge（TUI 数据源）
// → artifact-tool（wf_write_artifact）→ guard-hook（越权阻断）→ hint（自动激活）→ commands（/wf:*）。
// 各模块职责与实测 API 结论见各文件头；流转/关卡纯逻辑单一来源见 server/lib.js；历史变更详见 git。
import * as fs from "node:fs";
import {
  VERSION, LIMITS, FLOWS, NEXT, BLOCKING_PHASES, DEFAULT_ALLOW_MARKERS, DEFAULT_ALLOW_RES,
  makeAllowChecker, evaluateTransition, guidance, promptText,
  entryValue, diagnoseReport, pingReport,
} from "./lib.js"; // P0-b：纯逻辑单一来源（含 shared/phases.js 的 BLOCKING）
import { createStore, logAdd, ENTRY_KEY, HINT_KEY, KEY, IDX, STATE_PREFIX } from "./state.js";
import { createObserver } from "./observe.js";
import { createRpcBridge } from "./rpc-bridge.js";
import { registerArtifactTool } from "./artifact-tool.js";
import { registerGuardHook } from "./guard-hook.js";
import { registerHint } from "./hint.js";

export default {
  id: "wf-workflow",
  async setup(ctx) {
    const S = ctx.storage;
    const E = ctx?.session?.instructions?.entry;
    const opt = ctx?.options ?? {};

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

    // P3：项目级角色定制——.workflow/overrides/<role>.md 存在则带入 guidance（leader 委派时全文附上）
    const listOverrides = (dir) => {
      try { return fs.readdirSync(`${dir}/.workflow/overrides`).filter((f) => f.endsWith(".md")); } catch { return []; }
    };
    const inject = async (st) => {
      try {
        // P1：值 = 头行 + 完整阶段 guidance。entry 每次组装系统提示从存储重新渲染，
        // 故消息历史被 compaction 压缩后阶段约束仍在线（等价 superpowers post-compaction 重注入）
        const ov = st.directory ? listOverrides(st.directory) : [];
        await E.put({ sessionID: st.sessionID, key: ENTRY_KEY, value: entryValue(st, LIMS, ov) });
        delete st.entryErr;
      } catch (e) {
        st.entryErr = String(e?.message ?? e);
      }
    };

    // ── M8-a：RPC 桥（TUI 侧边栏读状态 + 事件刷新，见 rpc-bridge.js）──
    const { rpcReg, rpcErr, WfDef, emitUpdated } = await createRpcBridge(ctx, { load, scanStates });

    const transition = async (sessionID, cmd, text) => {
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

    // ── M3：wf_write_artifact 工具（见 artifact-tool.js）──────────
    const tools = registerArtifactTool(ctx, { resolveState, resolveProjectDir, save, emitUpdated, probeOnce, logToolsOnce });

    // ── M4：阶段越权硬阻断（planning/review 拒业务代码写；shell 门控与实测结论见 guard-hook.js）──
    const hookReg = registerGuardHook(ctx, { resolveState, isAllowed, allowHint, probeOnce, save });

    // ── P3：superpowers 式自动激活提示（fail-soft，见 hint.js）────────
    const chatReg = registerHint(ctx, opt, { resolveState, probeOnce });

    const commands = ctx.command.transform((editor) => {
      const add = (def) => editor.add(def);

      add({
        name: "wf:intake",
        description: "工作流入口：澄清需求/读 .learnings/补 gitignore（参数=slug）",
        execute: async (a) => transition(a.sessionID, "wf:intake", a.prompt),
      });
      add({
        name: "wf:plan",
        description: "进入 planning：委派 wf/planner 产出 plan.md",
        execute: async (a) => transition(a.sessionID, "wf:plan", a.prompt),
      });
      add({
        name: "wf:review",
        description: "进入 review（并行：planner-reviewer ∥ tester feasibility），≤3 轮",
        execute: async (a) => transition(a.sessionID, "wf:review", a.prompt),
      });
      add({
        name: "wf:assign",
        description: "进入 assign：冻结接口、按 T<nn> 分配 lane",
        execute: async (a) => transition(a.sessionID, "wf:assign", a.prompt),
      });
      add({
        name: "wf:test-design",
        description: "进入 test_design：tester(mode=design) 按冻结接口写红验收测试（未经此阶段不可 build）",
        execute: async (a) => transition(a.sessionID, "wf:test-design", a.prompt),
      });
      add({
        name: "wf:build",
        description: "进入 building：每 lane 一 worktree + wf/builder（TDD）",
        execute: async (a) => transition(a.sessionID, "wf:build", a.prompt),
      });
      add({
        name: "wf:reconcile",
        description: "进入 reconcile：合并各 worktree 回主树，冲突上报用户",
        execute: async (a) => transition(a.sessionID, "wf:reconcile", a.prompt),
      });
      add({
        name: "wf:review-build",
        description: "进入 build_review：wf/builder-reviewer，≤3 轮",
        execute: async (a) => transition(a.sessionID, "wf:review-build", a.prompt),
      });
      add({
        name: "wf:test",
        description: "进入 testing：wf/tester verify → test-report.md（PASS|FAIL）",
        execute: async (a) => transition(a.sessionID, "wf:test", a.prompt),
      });
      add({
        name: "wf:fix",
        description: "进入 fixing：同 lane 回 builder / 跨 lane 用 fixer，≤3 轮",
        execute: async (a) => transition(a.sessionID, "wf:fix", a.prompt),
      });
      add({
        name: "wf:done",
        description: "进入 done：审计汇报 + 并行 learner 复盘",
        execute: async (a) => transition(a.sessionID, "wf:done", a.prompt),
      });
      add({
        name: "wf:status",
        description: `查看当前工作流状态与审计轨迹（只读，${VERSION}）`,
        execute: async (a) => {
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
            ...(st.log ?? []).slice(-8).map((e) =>
              `  ${e.at.slice(11, 19)} ${e.cmd} ${e.from ?? "∅"}→${e.to}${e.ok ? "" : `（${e.note}）`}`),
          ].join("\n");
        },
      });
      add({
        name: "wf:diagnose",
        description: "诊断本会话工作流：审计轨迹拒绝/阻断取证、关卡与轮次、产物磁盘对账、注入/RPC 异常与下一步",
        execute: async (a) => {
          const st = await load(a.sessionID);
          if (!st) return `wf 诊断(${VERSION})：本会话无活动任务。先执行 /wf:intake <slug>。`;
          // 产物对账：落盘目录三级回退（resolveProjectDir，与 wf_write_artifact 同源）
          const dir = await resolveProjectDir(st, a.sessionID);
          let artifactFiles = [];
          try { artifactFiles = fs.readdirSync(`${dir}/.workflow/${st.slug}`); } catch { /* 目录不存在按空处理 */ }
          return diagnoseReport(st, { version: VERSION, artifactFiles, rpcErr, limits: LIMS });
        },
      });
      add({
        name: "wf:ping",
        description: "健康检查：列出 wf/* 角色 agent 注册状态与模型（只读，fail-soft）",
        execute: async (a) => {
          try {
            if (!ctx.agent?.list) return `wf 角色：宿主未提供 ctx.agent API（v2.2.6 实测以 agent-probe 为准）；可用 @<角色> 手动验证`;
            const res = await ctx.agent.list();
            await probeOnce(a?.sessionID, "agent-probe", { shape: Array.isArray(res) ? "array" : Object.keys(res ?? {}) });
            return pingReport(res);
          } catch (e) {
            return `wf 角色查询失败：${e?.message ?? e}（host API 形状待 _debug/agent-probe.json 确认）`;
          }
        },
      });
      add({
        name: "wf:lane",
        description: `登记/查看 lane：set <Tnn> <子会话ID> [worktree] / rm <Tnn> / 默认 ls（${VERSION}）`,
        execute: async (a) => {
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
        execute: async (a) => {
          const old = await load(a.sessionID); // M10-b：项目索引若指向自己则一并清除
          if (old?.projectID) { try { await S.remove(IDX(old.projectID)); } catch { } }
          await S.remove(KEY(a.sessionID));
          try { await E.remove({ sessionID: a.sessionID, key: ENTRY_KEY }); } catch { }
          try { await E.remove({ sessionID: a.sessionID, key: HINT_KEY }); } catch { }
          await emitUpdated({ sessionID: a.sessionID, slug: "", phase: null, rounds: {} }); // M10-a：A3，TUI 实时反映清除
          return "wf 工作流：本会话状态已清除。可用 /wf:intake <slug> 重新开始。";
        },
      });
      add({
        name: "wf:debug",
        description: "观测通道：把当前状态与审计轨迹落盘到 <项目>/.workflow/_debug/state.json",
        execute: async (a) => {
          const st = await load(a.sessionID);
          let entries = null;
          if (!E?.list) entries = "no entry API";
          else {
            try { entries = await E.list({ sessionID: a.sessionID }); }
            catch (e1) {
              try { entries = await E.list({ sessionID: a.sessionID, key: ENTRY_KEY }); }
              catch (e2) { entries = `ERR1:${e1?.message ?? e1} | ERR2:${e2?.message ?? e2}`; }
            }
          }
          let sessProbe = null;
          {
            const tries = {};
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
                tries[label] = { ok: false, err: String(e?.message ?? e).slice(0, 140) };
              }
            }
            sessProbe = tries;
          }
          let rpcSelf = null;
          try { rpcSelf = WfDef ? await ctx.rpc(WfDef).state({ sessionID: a.sessionID }) : "no-rpc-def"; }
          catch (e) { rpcSelf = `ERR:${String(e?.message ?? e)}`; }
          let rpcList = null;
          try { rpcList = WfDef ? await ctx.rpc(WfDef).list({}) : "no-rpc-def"; }
          catch (e) { rpcList = `ERR:${String(e?.message ?? e)}`; }
          let rpcListMine = null;
          try { rpcListMine = WfDef ? await ctx.rpc(WfDef).list(st?.projectID ? { projectID: String(st.projectID), ...(st.directory ? { directory: String(st.directory) } : {}) } : {}) : "no-rpc-def"; }
          catch (e) { rpcListMine = `ERR:${String(e?.message ?? e)}`; }
          let scanRaw = null;
          try { scanRaw = await S.scan({ prefix: STATE_PREFIX }); }
          catch (e) { scanRaw = `ERR:${String(e?.message ?? e)}`; }
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

    return () => {
      for (const r of [commands, tools, hookReg, rpcReg, chatReg]) { try { r?.dispose?.(); } catch { } }
    };
  },
};
