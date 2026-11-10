// wf-workflow — P0-a/b：去除 REPO 硬编码（debug 目录按会话解析：options.debugDir → session 项目目录 → cwd）；
// 可测纯逻辑（FLOWS/GATES/KIND_FILES/放行判定/shell 目标/verdict/流转校验）提取至 server/lib.js，行为与 M14-r24 一致。
// 历史变更（M10-d / M14 等）详见 lib.js 注释与 git。
// M8-a: RPC 桥 —— ctx.rpc.register(Wf)（shared/rpc.ts）暴露 state 方法；流转/产物落盘时 emit("updated")，
//        供 TUI 侧边栏订阅（此时尚不含 tui/ 部件，server 侧可独立验证）
// 在 M2-b（状态机 + /wf:* 命令 + 阶段注入）之上新增：
//  M3: wf_write_artifact 工具（kind → .workflow/<slug>/ 文件名，落盘并记入 state.artifacts）
//  M4: ctx.tool.hook("execute.before") —— planning/review 阶段拒绝业务代码 edit/write/patch
//  M5: GATES —— wf:assign 双通道关卡（需 test-plan）；wf:done 验收关卡（需 test-report 结论 PASS）
// 已验证 API（实测 2026-11-09，参考 slim V2 适配器 + .workflow/_debug/*.json）：
//  - 工具注册：draft.add({name, description, input:<JSONSchema>, options:{codemode:false},
//      execute: async (args, context) => ({ content }) })；实测 context 仅 {sessionID, agent,
//      messageID, id, progress, signal}——**无 directory**！项目目录须经 ctx.session.get(sessionID).location.directory 取
//  - hook：ctx.tool.hook("execute.before", async (input, output) => …)
//      实测 input={tool, sessionID, agent, messageID, id, input}——工具入参在 input.input（output 为空，
//      slim 参考的 output.args 形状在 v2.2.6 不成立）；抛异常=拦截工具调用
//  - 命令：editor.add({name, description, execute(args={sessionID,prompt,delivery})})，返回值作为 prompt 送入会话
//  - storage：string key get/set/remove；entry.put key 正则 ^[a-z0-9][a-z0-9._-]*$
// 观测通道：.workflow/_debug/{tools,hook-probe,tool-probe,state}.json
import * as fs from "node:fs";
import {
  VERSION, LIMITS, FLOWS, NEXT, GATES, GATE_ERR,
  EDIT_TOOLS, BLOCKING_PHASES, DEFAULT_ALLOW_MARKERS, DEFAULT_ALLOW_RES,
  KIND_FILES, extractPaths, makeAllowChecker, shellWriteTargets,
  parseVerdict, hasStrictVerdictLine, evaluateTransition, guidance, promptText,
} from "./lib.js"; // P0-b：纯逻辑单一来源（含 shared/phases.js 的 BLOCKING）

const ENTRY_KEY = "wf.phase";
const KEY = (sessionID) => `wf-workflow/state/${sessionID}`;

const logAdd = (st, entry) => {
  st.log = Array.isArray(st.log) ? st.log : [];
  st.log.push(entry);
  if (st.log.length > 50) st.log = st.log.slice(-50);
};

export default {
  id: "wf-workflow",
  async setup(ctx) {
    const S = ctx.storage;
    const E = ctx?.session?.instructions?.entry;
    const opt = ctx?.options ?? {};

    // P0-a：debug 目录惰性按会话解析（修 REPO 硬编码）——显式 options.debugDir 优先，
    // 回退会话项目目录（实测工具回调无 directory，须 session.get），再回退进程 cwd。
    const debugDirFor = async (sessionID) => {
      if (opt.debugDir) return String(opt.debugDir);
      try {
        const s = await ctx.session.get({ sessionID });
        if (s?.location?.directory) return String(s.location.directory);
      } catch { }
      return process.cwd();
    };

    const allowMarkers = [...DEFAULT_ALLOW_MARKERS, ...(Array.isArray(opt.allowMarkers) ? opt.allowMarkers : [])];
    const allowRes = [...DEFAULT_ALLOW_RES, ...(Array.isArray(opt.allowRegexps) ? opt.allowRegexps.map((s) => new RegExp(s)) : [])];
    const isAllowed = makeAllowChecker(allowMarkers, allowRes);
    // M10-a：闸门拒绝文案与 allowlist 同源生成（I2：旧硬写文案漏 .learnings/，与实际放行清单漂移）
    const allowHint = allowMarkers.map((m) => `${m.replace(/^\//, "").replace(/\/$/, "")}/**`).join("、");

    // 首次触发探针（只写一次，验证插件所见入参形状；ERR-002 教训：先探形状再使用）
    // P0-a：目录改为按会话解析（原为模块级 DBG 常量，硬编码仓库路径）
    const PROBE = opt.probe !== false;
    const probeOnce = async (sessionID, name, data) => {
      try {
        if (!PROBE) return;
        const dir = `${await debugDirFor(sessionID)}/.workflow/_debug`;
        const p = `${dir}/${name}.json`;
        if (fs.existsSync(p)) return;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2));
      } catch { }
    };

    const load = async (sessionID) => {
      try { return (await S.get(KEY(sessionID))) ?? null; } catch { return null; }
    };
    // M10-b：项目索引——子会话（agent 匹配 wf/*）经 projectID 反查管辖状态（实测 session 记录无 parentID）
    const IDX = (projectID) => `wf-workflow/project/${projectID}`;
    const save = async (st) => {
      st.updatedAt = new Date().toISOString();
      await S.set(KEY(st.sessionID), st);
      try {
        if (st.projectID) await S.set(IDX(st.projectID), { sessionID: st.sessionID, updatedAt: st.updatedAt });
      } catch { }
    };
    const resolveState = async (sessionID, agent) => {
      const own = await load(sessionID);
      if (own) return own;
      if (!/^wf\//.test(String(agent ?? ""))) return null; // 仅 wf/* agent 受项目索引管辖；普通 build/plan 会话不受影响
      try {
        const s = await ctx.session.get({ sessionID });
        const pid = s?.projectID;
        if (!pid) return null;
        const idx = await S.get(IDX(pid));
        if (idx?.sessionID && idx.sessionID !== sessionID) {
          const owner = await load(idx.sessionID);
          if (owner) return owner;
        }
      } catch { }
      return null;
    };
    const inject = async (st) => {
      try {
        await E.put({
          sessionID: st.sessionID,
          key: ENTRY_KEY,
          value: `phase=${st.phase} slug=${st.slug} rounds=${JSON.stringify(st.rounds)}`,
        });
        delete st.entryErr;
      } catch (e) {
        st.entryErr = String(e?.message ?? e);
      }
    };

    // ── M8-b：状态枚举（面板看板）；M10-d A6 项目过滤 + A7 done 状态 GC ────
    const STALE_MS = 14 * 24 * 3600 * 1000;
    const scanStates = async (projectID, directory) => {
      const out = [];
      try {
        const res = await S.scan({ prefix: STATE_PREFIX });
        const entries = Array.isArray(res) ? res : (res?.entries ?? []);
        for (const e of entries) {
          const k = e?.key ?? e?.[0];
          let v = e?.value ?? e?.[1];
          if (k == null) continue;
          const ks = Array.isArray(k) ? k.join("/") : String(k);
          if (!ks.startsWith(STATE_PREFIX)) continue;
          if (typeof v === "string") { try { v = JSON.parse(v); } catch { } }
          if (!v || typeof v !== "object") continue;
          // A7 GC：done 且 >14 天 → 删状态并清指向自己的项目索引
          try {
            const age = v.updatedAt ? Date.now() - Date.parse(String(v.updatedAt)) : 0;
            if (v.phase === "done" && v.updatedAt && age > STALE_MS) {
              await S.remove(ks);
              if (v.projectID) {
                const idx = await S.get(IDX(v.projectID));
                if (idx && idx.sessionID === v.sessionID) await S.remove(IDX(v.projectID));
              }
              continue;
            }
          } catch { /* GC 失败按保留处理 */ }
          // A6：按项目过滤（M14：无 projectID 的旧状态回退 directory 比较，匹配则显示）
          if (projectID) {
            if (v.projectID) { if (String(v.projectID) !== String(projectID)) continue; }
            else if (!(directory && v.directory && String(v.directory) === String(directory))) continue;
          }
          out.push({
            sessionID: v.sessionID ?? ks.slice(STATE_PREFIX.length),
            slug: v.slug ?? "",
            phase: v.phase ?? null,
            rounds: v.rounds ?? {},
            testPlanWritten: !!v.testPlanWritten,
            testReportVerdict: v.testReportVerdict ?? null,
            updatedAt: v.updatedAt ?? null,
          });
        }
      } catch { /* 扫描失败按空处理 */ }
      out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
      return out.slice(0, 20);
    };

    const STATE_PREFIX = KEY("");
    // ── M8-a：RPC 桥（TUI 侧边栏读状态 + 事件刷新）──────────────────
    let rpcReg = null;
    let rpcErr = null;
    let WfDef = null;
    try {
      if (ctx.rpc?.register) {
        const mod = await import("../shared/rpc.ts");
        WfDef = mod.Wf;
        rpcReg = await ctx.rpc.register(WfDef, {
          state: async (input) => {
            const st = await load(input?.sessionID);
            if (!st) return { sessionID: input?.sessionID ?? null, active: false };
            return {
              sessionID: st.sessionID,
              active: true,
              slug: st.slug ?? "",
              phase: st.phase ?? null,
              rounds: st.rounds ?? {},
              testPlanWritten: !!st.testPlanWritten,
              testReportVerdict: st.testReportVerdict ?? null,
              artifacts: st.artifacts ?? {},
              updatedAt: st.updatedAt ?? null,
            };
          },
          list: async (input) => ({ sessions: await scanStates(input?.projectID ?? null, input?.directory ?? null) }),
        });
      } else rpcErr = "ctx.rpc 不可用";
    } catch (e) {
      rpcErr = String(e?.message ?? e);
    }

    const emitUpdated = async (st) => {
      try {
        await rpcReg?.events?.emit("updated", {
          sessionID: st.sessionID,
          slug: st.slug ?? "",
          phase: st.phase ?? null,
          rounds: st.rounds ?? {},
        });
      } catch { /* 事件失败不影响主流程 */ }
    };

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
      const r = evaluateTransition(cmd, st, text, at);
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
      return guidance(flow.to, st);
    };

    // P0-a：工具注册证据延迟到首次工具执行时落盘（原在注册回调内写死 DBG 路径；
    // 注册回调无 sessionID，无法解析项目目录）
    let toolsLogged = false;
    const logToolsOnce = async (namesPromise, sessionID) => {
      if (toolsLogged) return;
      toolsLogged = true;
      try {
        const listed = await namesPromise;
        const names = Array.isArray(listed) ? listed.map((t) => t?.name ?? String(t)) : listed;
        const dir = `${await debugDirFor(sessionID)}/.workflow/_debug`;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${dir}/tools.json`, JSON.stringify({ at: new Date().toISOString(), version: VERSION, tools: names }, null, 2));
      } catch { }
    };

    // ── M3：wf_write_artifact 工具 ────────────────────────────────
    const tools = ctx.tool.transform((draft) => {
      const namesPromise = Promise.resolve(draft.list?.()).catch(() => null);
      draft.add({
        name: "wf_write_artifact",
        description:
          "把 wf 工作流产物写入 <项目>/.workflow/<slug>/。kind 决定文件名：" +
          Object.keys(KIND_FILES).join(" | ") +
          "。循环类产物（plan-review/build-review）自动按当前轮次编号。",
        input: {
          type: "object",
          properties: {
            kind: { type: "string", enum: Object.keys(KIND_FILES), description: "产物类型" },
            content: { type: "string", description: "完整文件内容" },
          },
          required: ["kind", "content"],
        },
        options: { codemode: false },
        execute: async (args, context) => {
          try {
            await probeOnce(context?.sessionID, "tool-probe", {
              argsKeys: Object.keys(args ?? {}),
              contextKeys: Object.keys(context ?? {}),
              sessionID: context?.sessionID,
              directory: context?.directory,
            });
            await logToolsOnce(namesPromise, context?.sessionID);
            const kind = String(args?.kind ?? "");
            const content = typeof args?.content === "string" ? args.content : String(args?.content ?? "");
            const mk = KIND_FILES[kind];
            if (!mk) return { content: `❌ 未知 kind=${kind}（可用：${Object.keys(KIND_FILES).join(" | ")}）` };
            const st = await resolveState(context?.sessionID, context?.agent); // M10-b：子会话经项目索引反查管辖状态
            if (!st?.slug) return { content: "❌ 本会话无活动 wf 任务：请先由用户执行 /wf:intake <slug>。" };
            // 落盘目录：优先管辖状态的 directory，回退本会话 session.get，再回退 cwd
            let dir = st.directory ?? null;
            if (!dir) {
              const sess = await ctx.session.get({ sessionID: context?.sessionID }).catch(() => null);
              dir = sess?.location?.directory ?? null;
            }
            dir = dir ?? process.cwd();
            const file = mk(st);
            const target = `${dir}/.workflow/${st.slug}/${file}`;
            fs.mkdirSync(`${dir}/.workflow/${st.slug}`, { recursive: true });
            fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`);
            st.artifacts = st.artifacts ?? {};
            st.artifacts[file] = { at: new Date().toISOString(), bytes: fs.statSync(target).size };
            if (kind === "test-plan") st.testPlanWritten = true;
            if (kind === "test-report") {
              st.testReportVerdict = parseVerdict(content); // P0-b：解析提取至 lib
            }
            logAdd(st, { at: new Date().toISOString(), cmd: "tool:wf_write_artifact", from: st.phase, to: st.phase, ok: true, note: file });
            await save(st);
            await emitUpdated(st);
            let note = `✅ [${VERSION}] 已写入 ${target}（${st.artifacts[file].bytes} bytes）`;
            if (kind === "test-report" && !hasStrictVerdictLine(content)) {
              note += `\n⚠️ test-report 首行应含「**结论**: PASS|FAIL」（记为 UNKNOWN 后 /wf:done 会被关卡拦截）`;
            }
            return { content: note };
          } catch (e) {
            return { content: `❌ wf_write_artifact 失败：${e?.message ?? e}` };
          }
        },
      });
    });

    // ── M4：阶段越权硬阻断（planning/review 拒业务代码写）──────────
    const hookReg = ctx.tool.hook("execute.before", async (input, output) => {
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
              throw new Error(
                `${GATE_ERR} 硬关卡：阶段「${st.phase}」禁止经 shell 写入项目内业务文件「${tRaw}」（放行：${allowHint}）。计划/审核产物请写 .workflow/。`
              );
            }
          }
          return;
        }
        // 实测（hook-probe.json）：工具入参在 input.input，output.args 形状不存在
        const paths = extractPaths(String(input?.tool), input?.input ?? output?.args);
        for (const p of paths) {
          if (!isAllowed(p)) {
            throw new Error(
              `${GATE_ERR} 硬关卡：阶段「${st.phase}」禁止修改业务代码 ${p}（放行：${allowHint} 与 *.test/*.spec 文件）。` +
              `计划/审核产物请用 wf_write_artifact 工具写入 .workflow/。`
            );
          }
        }
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (msg.includes(GATE_ERR)) throw e; // 关卡异常向上抛 = 拦截工具调用
        // 其它内部异常不阻断（fail-open），已在 §11 声明
      }
    });
    // M10-c 实测结论（shell-probe.json）：ctx.shell.hook("create.before") 的 input 仅
    // {command,cwd,timeout,shell,env}，**无 sessionID/agent** → 无法按会话/agent 管辖；
    // shell 门已并入上方 tool hook 的 tool=="shell" 分支（tool hook 携带会话身份）。

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
            `rounds: plan_review=${r.plan_review ?? 0}/${LIMITS.plan_review}  build_review=${r.build_review ?? 0}/${LIMITS.build_review}  test_fix=${r.test_fix ?? 0}/${LIMITS.test_fix}`,
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
          const out = { dumpedAt: new Date().toISOString(), version: VERSION, state: st, entries, entryKey: ENTRY_KEY, limits: LIMITS, blockingPhases: [...BLOCKING_PHASES], sessProbe, rpcErr, rpcSelf, rpcList, rpcListMine, scanRaw };
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
      for (const r of [commands, tools, hookReg, rpcReg]) { try { r?.dispose?.(); } catch { } }
    };
  },
};
