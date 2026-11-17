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
import { join } from "node:path";
import { GATE_ERR, EDIT_TOOLS, BLOCKING_PHASES, extractPaths, shellWriteTargets, nextFor, profileOf, trackRoleSession, isLeader, SID_ALIAS_AUTO, SID_ALIAS_USAGE, resolveSidAlias, isNearTruncation } from "./lib.ts";
import { logAdd } from "./state.ts";
import { type Host } from "./host.ts"; // T03：收 Host（原 ctx:any）
import { swallow } from "./observe.ts"; // T01：静默 catch → 环形审计记账
import { TIER_ROLES, effectiveTiers, extractVariantIds, resolveTierInjection, tierAgentsMode, type ModelRef } from "./model-tier.ts"; // dispatch-tier-inject T03

// dispatch-tier-inject T03（R1）：一次性探针按 target 分键——tester 亦属 TIER_ROLES，全局单文件
// 会被五步窗口第 5 步 tester 派发提前消费，致 S1 builder 派发时无探针证据；分键后各角色各取证一次。
// 模块级 Set + existsSync 双自禁用（仿 subagent-probe 模式）。
const tierInjectProbed = new Set<string>();
// sid-transcribe-probe W3：一次性按 role 分键取证（existsSync 按文件自禁——与其它探针同款，
// 天然按项目隔离；进程级 Set 会在守护宿主不重启时令首个采样项目之外的其它项目永久失明）。
// correction 时点记录「别名当时是否可解析」：
// autoWouldResolve/atRoleWouldResolve 均 ok → 别名可用而未用=行为问题 → guidance 委派前置行；
// 均 fail → 注册时机/机制缺口 → 修登记链路。取证结论回写 docs（勿凭单样本下结论）。

// probe 4：session.get 返回形状摘要（模块级纯函数，避免每次调用重建；供一次性取证）
const sessionShape = (s: any) => s ? { keys: Object.keys(s), parentID: s.parentID ?? null, hasParentID: "parentID" in s, time: s.time ?? null } : null;

// P4：下一步提示（NEXT/NEXT_DAILY 表与流转指引同源，防文案漂移）；T06：模型侧经 wf_command 推进
// M16-r34：mode 感知（daily 用 NEXT_DAILY）；模块级纯函数，只捕获模块 import，不依赖闭包
const nextHint = (st: any, phase: string) => `当前阶段「${phase}」下一步：${nextFor(st, phase)}（leader 调用 wf_command(name=…) 推进，用户手敲亦可）。`;

/** 注册 execute.before 工具钩子：阶段越权硬阻断 + subagent sessionID 自愈/别名改写 + question 方案确认记账 + 委派观察灯。
 * 抛出含 GATE_ERR 标记的异常=拦截工具调用；其余内部异常 fail-open 不阻断。
 * @param host T03 防腐层（tools.hook("execute.before") 注册面）
 * @param deps 宿主注入依赖（显式 any 边界）：resolveState/isAllowed/allowHint/probeOnce/save/resolveProjectDir
 * @returns 钩子注册句柄（host.tools.hook 返回值透传） */
export function registerGuardHook(host: Host, deps: any) { // T03：ctx→Host
  const { resolveState, isAllowed, allowHint, probeOnce, save, resolveProjectDir } = deps;

  // P1：阶段越权阻断记账（gate:block 进审计轨迹，供 /wf:diagnose 取证；落盘失败不影响阻断）
  const logBlock = async (st: any, tool: string, detail: string) => {
    logAdd(st, { at: new Date().toISOString(), cmd: "gate:block", tool, detail, from: st.phase, to: st.phase, ok: false, note: "blocked" });
    try { await save(st); } catch (e) { swallow(e, "guard-hook:block-log-save-fail"); }
  };

  // M16-r41 B 层：subagent 形状探针一次性开关（ERR-002 先探形状再使用；existsSync 自禁用，非 P6 常态探针）
  let subagentProbed = false;
  let sessionGetProbed = false;
  let rewriteProbed = false; // M16-r45：别名改写生效性取证一次性开关（真机核对 exec-rewrite-probe.json）
  // M16-r44：question 入参形状一次性探针（方案确认记账的形状取证；同 subagent-probe 模式）
  let questionProbed = false;
  let agentKeyProbed = false; // W6-1：子会话工具调用 agent 来源取证一次性开关
  let stripProbed = false; // W6-2：删键≈省略 宿主尊重性取证一次性开关
  // confirm-sentinel M3 v2：确认卡审计环境信号——守护宿主（opencode serve --service）不继承
  // wrapper env，WF_HEADLESS 对插件不可达（test_45 实证，v2 env 路径已删）。改判项目哨兵文件
  // <st.directory>/.workflow/.wf-headless：存在 + mtime 24h 内（防 kill -9 残留）+ 内容 sid 全等
  // 或 "pending:" 前缀（首启未定稿窗口——intake 卡恰出在此阶段，评审 BLOCKER b，照标）→ 追加
  // auto=non-interactive，区分「用户确认」与「宿主自动裁定」；GUI（无哨兵文件）note 逐字不变，
  // 存量锚按未标记路径原样保留。任何读取异常均向 GUI 语义保守失败（不标记）。
  const HEADLESS_WINDOW_MS = 24 * 60 * 60 * 1000;
  const confirmNote = (st: any, sessionID?: unknown): string => {
    try {
      const dir = st?.directory != null ? String(st.directory).trim() : "";
      if (!dir) return "question-observed";
      const sentinel = join(dir, ".workflow", ".wf-headless");
      if (!fs.existsSync(sentinel)) return "question-observed";
      if (Date.now() - fs.statSync(sentinel).mtimeMs > HEADLESS_WINDOW_MS) return "question-observed";
      const content = fs.readFileSync(sentinel, "utf8").trim();
      if (content.startsWith("pending:")) return "question-observed:auto=non-interactive";
      if (String(sessionID ?? "") && content === String(sessionID)) return "question-observed:auto=non-interactive";
      return "question-observed"; // sid 不匹配=同项目 GUI 并发会话（哨兵归属别的无头会话）
    } catch { return "question-observed"; }
  };

  // ── M4：阶段越权硬阻断（planning/review 拒业务代码写）──────────
  return host.tools.hook("execute.before", async (input: any, output: any) => {
    try {
      await probeOnce(input?.sessionID, "hook-probe", {
        inputKeys: Object.keys(input ?? {}),
        outputKeys: Object.keys(output ?? {}),
        tool: input?.tool, sessionID: input?.sessionID, callID: input?.callID,
      });
      // M10-c v2：shell 也经 tool hook 门控（实测 ctx.shell.hook 的 input 仅 {command,cwd,timeout,shell,env}，
      // 无 sessionID/agent 无法按会话管辖；tool hook 对 tool=="shell" 携带 input.input.command + 会话身份）
      const toolName = String(input?.tool);
      // ── W6-1（test_49 复盘）：子会话身份通用登记——生产端固化 ──
      // 登记必须是「子会话出现」的机械后果，不得依赖其工具选择：本轮 planner/tester/builder 全部
      //   绕过 wf_write_artifact 与 EDIT_TOOLS（直接落盘/工作树内写码）→ roleSessions 全程空 →
      //   前缀自愈/别名解析/纠错记账全部哑火，"ses" 残渣直通宿主报错 ×6。
      // 任意工具调用：ses_ 形状 + resolveState 命中（W6-0 parentID 回退免疫 projectID 身份漂移）
      //   + wf/* 非 leader → trackRoleSession，变化才 save（无抖动）。input.agent 缺失时经
      //   sessions.get 回读兜底（session_v2 自带 agent 列）——哑火双保险的最后一环。
      // 原 EDIT_TOOLS 登记分支保留为冗余防线；整段 fail-open 绝不阻断。
      if (/^ses_[A-Za-z0-9]+$/.test(String(input?.sessionID ?? ""))) {
        try {
          const childSid = String(input?.sessionID ?? "");
          let regAgent: unknown = input?.agent;
          if (regAgent == null || String(regAgent) === "") {
            try { regAgent = (await host.sessions.get({ sessionID: childSid }))?.agent ?? null; } catch (e) { swallow(e, "guard-hook:agent-key-fallback-fail"); }
          }
          const regSt = await resolveState(childSid, regAgent);
          if (regSt && trackRoleSession(regSt, regAgent, childSid)) {
            try { await save(regSt); } catch (e) { swallow(e, "guard-hook:universal-reg-save-fail"); }
          }
          // 一次性形状取证：子会话工具调用 input.agent 的到达性/兜底路径（评审项#1 唯一未证形态）
          if (!agentKeyProbed) {
            agentKeyProbed = true;
            try {
              let dir = process.cwd();
              try { const s0 = await host.sessions.get({ sessionID: childSid }); if (s0?.location?.directory) dir = String(s0.location.directory); } catch (e) { swallow(e, "guard-hook:agent-key-dir-probe-fail"); }
              const dbg = `${dir}/.workflow/_debug`;
              if (!fs.existsSync(`${dbg}/agent-key-probe.json`)) {
                fs.mkdirSync(dbg, { recursive: true });
                fs.writeFileSync(`${dbg}/agent-key-probe.json`, JSON.stringify({
                  at: new Date().toISOString(), tool: toolName,
                  hadInputAgent: input?.agent != null, resolvedAgent: regAgent != null ? String(regAgent) : null,
                  note: "子会话工具调用 agent 来源取证（零回显：不落 sessionID）",
                }, null, 2));
              }
            } catch (e) { swallow(e, "guard-hook:agent-key-probe-fail"); }
          }
        } catch (e) { swallow(e, "guard-hook:universal-reg-fail"); }
      }
      // ── M16-r41 B 层：subagent 续接自愈守卫（leader 专属；必须置于 edit/shell 过滤之前）──
      // 根因：转录/复述长 ses_ ID 本身即失真源，回显登记 ID 又会诱导再转录→死循环。A 层已自动登记
      //   roleSessions；此处（fix-sid-truncation-echo-loop T01）对截断前缀**就地改写自愈**（零回显），
      //   对非法形状/近似错位拒绝并指路别名或省略新建（同样零回显）。
      // 收窄（多 lane 安全）：全形状合法且非前缀非近似→不干预，放行交宿主归属校验。
      if (toolName === "subagent" || toolName === "task") {
        // probe 1：subagent 首次接入 hook，一次性取证「触发 + 入参形状」（best-effort，不影响守卫）
        if (!subagentProbed) {
          subagentProbed = true;
          try {
            let dir = process.cwd();
            try { const s = await host.sessions.get({ sessionID: String(input?.sessionID ?? "") }); if (s?.location?.directory) dir = String(s.location.directory); } catch (e) { swallow(e, "guard-hook:session-dir-probe-fail"); }
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
          } catch (e) { swallow(e, "guard-hook:subagent-probe-fail"); }
        }
        // probe 4：session.get 返回形状一次性取证（parentID/time.busy/idle → 归属+存活校验可行性）
        if (!sessionGetProbed) {
          sessionGetProbed = true;
          try {
            const callerSid = String(input?.sessionID ?? "");
            const caller = await host.sessions.get({ sessionID: callerSid });
            let dir4 = process.cwd();
            if (caller?.location?.directory) dir4 = String(caller.location.directory);
            const childSid = input?.input?.sessionID ? String(input.input.sessionID) : "";
            let child: any = null; let childErr: string | null = null;
            if (childSid) { try { child = await host.sessions.get({ sessionID: childSid }); } catch (e) { childErr = String((e as Error)?.message ?? e); } }
            const dbg4 = `${dir4}/.workflow/_debug`;
            if (!fs.existsSync(`${dbg4}/session-get-probe.json`)) {
              fs.mkdirSync(dbg4, { recursive: true });
              fs.writeFileSync(`${dbg4}/session-get-probe.json`, JSON.stringify({
                at: new Date().toISOString(),
                caller: { sessionID: callerSid, ...sessionShape(caller) },
                child: childSid ? { sessionID: childSid, ...sessionShape(child), err: childErr } : null,
              }, null, 2));
            }
          } catch (e) { swallow(e, "guard-hook:session-get-probe-fail"); }
        }
        if (!isLeader(String(input?.agent ?? ""))) return; // 仅 leader 的续接受管辖
        const st = await resolveState(input?.sessionID, input?.agent);
        if (!st) return;
        const args = input?.input ?? {};
        const target = String(args.agent ?? "");
        // ── dispatch-tier-inject T03：派发时档位注入（方案 A v2）──────────────────
        // 接线点=target 之后、观察灯块之前：覆盖新建/别名/前缀自愈/合法续接全形态（下游各分支
        // 均在注入后才 return）。整块独立 try/catch fail-open：绝不 throw、不新增拒绝文案
        // （REJECT_PREFIX/brief-level 守卫不受影响）。args.model 就地改写=既有别名/前缀自愈同款
        // （r45 exec-rewrite-probe 实证宿主尊重 execute.before 就地改写；model 键生效性待真机首验）。
        // 审计置灯块前搭一次 save；灯 save 失败 → 灯块后独立兜底 save（保注入审计不丢）。
        let tierLogPending = false;
        try {
          if (tierAgentsMode(host.options) !== "off" && st.slug && TIER_ROLES.includes(target)
            && (args.model == null || String(args.model) === "")) {
            const dir = st.directory ?? await resolveProjectDir(st, input?.sessionID);
            let fileContent: string | null = null;
            try { fileContent = await fs.promises.readFile(`${dir}/.opencode/agents/wf/${target.replace(/^wf\//, "")}.md`, "utf8"); } catch { fileContent = null; } // 缺失/读失败=null（纯函数入参）
            let ref: ModelRef | null = null;
            try { ref = (await host.sessions.get({ sessionID: String(input?.sessionID ?? "") }))?.model ?? null; } catch (e) { swallow(e, "guard-hook:tier-ref-read-fail"); }
            let variantIds: string[] = [];
            if (ref?.id && ref?.providerID) { // R3：无效 ref 短路不调 models.list（防白调+审计噪音）
              try { variantIds = extractVariantIds(await host.models.list(), ref); } catch (e) { swallow(e, "guard-hook:model-list-variants-fail"); }
            }
            const decision = resolveTierInjection({ enabled: true, slug: st.slug, target, explicitModel: args.model, fileContent, ref, variantIds, tiers: effectiveTiers(host.options).tiers });
            if (decision.action === "inject") {
              args.model = decision.model; // 就地改写（宿主将执行的对象）
              logAdd(st, { at: new Date().toISOString(), cmd: "tier:inject", from: st.phase, to: st.phase, ok: true, note: `injected ${target}=${decision.model}` });
              tierLogPending = true;
              // 一次性探针按 target 分键（R1）：只保「记录了注入尝试」，宿主生效性以子会话 model 回读为准
              const probePath = `${dir}/.workflow/_debug/model-inject-probe-${target.replace(/^wf\//, "")}.json`;
              if (!tierInjectProbed.has(target) && !fs.existsSync(probePath)) {
                tierInjectProbed.add(target);
                try {
                  fs.mkdirSync(`${dir}/.workflow/_debug`, { recursive: true });
                  fs.writeFileSync(probePath, JSON.stringify({
                    at: new Date().toISOString(), target, injected: decision.model,
                    callerBase: ref ? { providerID: ref.providerID, id: ref.id, variant: ref.variant ?? null } : null,
                    argKeys: Object.keys(args),
                  }, null, 2)); // 无 sid（零回显）
                } catch (e) { swallow(e, "guard-hook:tier-inject-probe-fail"); }
              }
            } else if (decision.action === "skip") {
              logAdd(st, { at: new Date().toISOString(), cmd: "tier-inject-skip", from: st.phase, to: st.phase, ok: true, note: `tier-inject-skip:${target}:${decision.reason}` });
              tierLogPending = true;
            } // none → 不记账（静默门）
          }
        } catch (e) { swallow(e, "guard-hook:tier-inject-fail"); }
        const passedRaw = args.sessionID;
        // ── P2-G（latency-v3.1）：background 观察灯——leader 委派的显式性记入 events ──
        // 口径：input.background===true→explicit / ===false→explicit-false / 其余→unset（宿主默认
        // 行为形状未实证，三态保守；数据只用于「前台干等占比」量化供硬准入决策，绝不用于拦截）。
        // 每委派恰一条（logAdd→save，与 question 记账同款 fail-open）；零回显（只记 lane 键，无 sid）。
        let lampSaveFailed = false; // dispatch-tier-inject T03：灯 save 失败标志 → 注入审计独立兜底
        try {
          const bgRaw = args.background;
          const bg = bgRaw === true ? "explicit" : bgRaw === false ? "explicit-false" : "unset";
          const passedS = String(passedRaw ?? "");
          const laneKey = Object.entries(st.lanes ?? {}).find(([k, v]) => (v as any).sessionID === passedS || k === passedS.replace(/^@/, ""))?.[0];
          // opt-agentic（serial-dispatch-fix 观测面）：target=wf/builder 且省略 sessionID 新建，
          // 但该角色已有登记子会话 → 记 builder-recreate（info 级证据非告警，绝不用于拦截）。
          // 诚实边界：多波并行次波新建亦命中（合法形态）；lane 表不记 role，故以 roleSessions
          // 已登记为信号——证据消费=/wf:diagnose 审计 grep builder-recreate（串行一派到底任务
          // 频发且无多波场景=逐 T 新建委派存量行为取证）。
          const builderRecreate = target === "wf/builder" && passedS === "" && !!st.reuse?.roleSessions?.["wf/builder"]?.sessionID;
          logAdd(st, { at: new Date().toISOString(), cmd: "deleg:observe", tool: toolName, from: st.phase, to: st.phase, ok: true, note: `background-lamp bg=${bg}${laneKey ? ` lane=${laneKey}` : ""}${builderRecreate ? " builder-recreate" : ""}` });
          try { await save(st); } catch (e) { lampSaveFailed = true; swallow(e, "guard-hook:lamp-save-fail"); }
        } catch (e) { swallow(e, "guard-hook:lamp-fail"); }
        // dispatch-tier-inject T03：注入/跳过审计已 logAdd 但灯 save 失败 → 独立兜底 save（保审计不丢）
        if (tierLogPending && lampSaveFailed) {
          try { await save(st); } catch (e) { swallow(e, "guard-hook:tier-log-save-fail"); }
        }
        if (passedRaw == null || String(passedRaw) === "") return; // 省略 sessionID=新建，不干预
        const passed = String(passedRaw);

        // ── M16-r45 A：别名续接——"auto"/"@Tnn"/"@wf/xx" 服务端解析改写，零转录（消灭复述失真源）──
        // 解析失败 loud-fail（勿静默新建：leader 的续用意图会丢）；改写入参 args 引用宿主将执行的对象。
        if (passed === SID_ALIAS_AUTO || passed.startsWith("@")) {
          const res = resolveSidAlias(passed, { role: target, roleSessions: st.reuse?.roleSessions, lanes: st.lanes }); // R3 T3.1 子步 C
          if (!res.ok) {
            logAdd(st, { at: new Date().toISOString(), cmd: "session:alias", tool: toolName, detail: `${target}: ${passed} ✗ ${res.reason}`, from: st.phase, to: st.phase, ok: false, note: "alias-rejected" });
            try { await save(st); } catch (e) { swallow(e, "guard-hook:alias-reject-save-fail"); }
            throw new Error(`${GATE_ERR} 别名续接失败：${res.reason}${res.candidates?.length ? `（可用：${res.candidates.join(", ")}）` : ""}`);
          }
          // 一次性取证：记录改写尝试与形状——真机核对该文件 + 后续 subagent 是否命中改写后 sessionID
          if (!rewriteProbed) {
            rewriteProbed = true;
            try {
              let dir = process.cwd();
              try { const s = await host.sessions.get({ sessionID: String(input?.sessionID ?? "") }); if (s?.location?.directory) dir = String(s.location.directory); } catch (e) { swallow(e, "guard-hook:session-dir-probe-fail"); }
              const dbg = `${dir}/.workflow/_debug`;
              if (!fs.existsSync(`${dbg}/exec-rewrite-probe.json`)) {
                fs.mkdirSync(dbg, { recursive: true });
                fs.writeFileSync(`${dbg}/exec-rewrite-probe.json`, JSON.stringify({
                  at: new Date().toISOString(), tool: toolName, target, passed,
                  resolved: res.sid, via: res.via, argKeys: Object.keys(args),
                  note: "验证宿主是否尊重 execute.before 的 input.input 就地改写（若不尊重→别名降级为 throw 纠正）",
                }, null, 2));
              }
            } catch (e) { swallow(e, "guard-hook:rewrite-probe-fail"); }
          }
          logAdd(st, { at: new Date().toISOString(), cmd: "session:alias", tool: toolName, detail: `${target}: ${passed} → ${res.sid}（${res.via}）`, from: st.phase, to: st.phase, ok: true, note: "aliased" });
          try { await save(st); } catch (e) { swallow(e, "guard-hook:alias-save-fail"); }
          args.sessionID = res.sid; // 就地改写
          return;
        }

        const tracked = st.reuse?.roleSessions?.[target]?.sessionID;
        const shapeOk = /^ses_[A-Za-z0-9]+$/.test(passed);
        if (!tracked) {
          // W6-3（test_49 复盘）：原 `if (!tracked) return;` 是审计盲区——静默放行致 session:correct=0
          //   假象，登记缺口被 6 次宿主报错掩盖。任何经过此处的委派都必须留痕。
          const inLane = Object.values(st.lanes ?? {}).some((v) => (v as any)?.sessionID === passed);
          if (inLane) return; // lane 登记会话续接：合法路径免记账（lanes 表自证归属）
          if (!shapeOk) {
            // W6-2 值盲归一：残渣（转录产物）无表可续。lanes 空 → 剥离按新建（无表可续时新建是唯一
            //   可满足续用语义的出口，且已记账非静默——收窄的是 L211 loud-fail 的适用前提，非原则）；
            //   lanes 非空 → loud-fail 指路 @Tnn（防在 lane 纪律外造会话，评审 R2）。
            const lanesActive = Object.keys(st.lanes ?? {}).length > 0;
            if (lanesActive) {
              logAdd(st, { at: new Date().toISOString(), cmd: "session:normalize", tool: toolName, detail: `${target}: 残渣无法续接（lane 语境）`, from: st.phase, to: st.phase, ok: false, note: "lane-context-reject" });
              try { await save(st); } catch (e) { swallow(e, "guard-hook:normalize-save-fail"); }
              throw new Error(`${GATE_ERR} 委派 sessionID「${passed}」在 lane 语境无法解析：请改用 @Tnn 显式指定 lane，或省略 sessionID 新建（勿凭记忆复述长 ID）。`);
            }
            logAdd(st, { at: new Date().toISOString(), cmd: "session:normalize", tool: toolName, detail: `${target}: 残渣无登记可续 → 剥离新建`, from: st.phase, to: st.phase, ok: false, note: "no-registry-stripped" });
            try { await save(st); } catch (e) { swallow(e, "guard-hook:normalize-save-fail"); }
            // exec-strip-probe：一次性取证宿主对「删键≈省略」的尊重（零真机证据前不宣称此路径已修复；
            //   失败方向=仍报 not found，不劣于现状）
            if (!stripProbed) {
              stripProbed = true;
              try {
                const dirS = st.directory ?? await resolveProjectDir?.(st, input?.sessionID);
                if (dirS && !fs.existsSync(`${dirS}/.workflow/_debug/exec-strip-probe.json`)) {
                  fs.mkdirSync(`${dirS}/.workflow/_debug`, { recursive: true });
                  fs.writeFileSync(`${dirS}/.workflow/_debug/exec-strip-probe.json`, JSON.stringify({ at: new Date().toISOString(), tool: toolName, target, passedLen: passed.length, note: "剥离 args.sessionID 后宿主行为取证（期望=按省略新建处理）" }, null, 2));
                }
              } catch (e) { swallow(e, "guard-hook:strip-probe-fail"); }
            }
            delete args.sessionID; // 值盲归一：残渣对模型失去信息意义，正确性由服务端机械保证
            return;
          }
          // 合法形状但非登记非 lane（幻觉/他任务会话）→ 放行宿主归属校验（多 lane 既有决策，非缺陷）
          logAdd(st, { at: new Date().toISOString(), cmd: "session:untracked", tool: toolName, detail: `${target}: 合法形状非登记 → 放行宿主归属校验`, from: st.phase, to: st.phase, ok: false, note: "untracked-passthrough" });
          try { await save(st); } catch (e) { swallow(e, "guard-hook:untracked-save-fail"); }
          return;
        }
        if (passed === tracked) return; // ID 正确，放行
        const isPrefix = tracked.startsWith(passed); // passed≠tracked 且非空 → startsWith 即真前缀
        const fuzzy = shapeOk && !isPrefix && isNearTruncation(passed, tracked); // M16-r45：中间/尾部错位复述
        if (shapeOk && !isPrefix && !fuzzy) return; // 全形状非前缀非近似→宿主归属校验（多 lane/幻觉兜底）
        // 形状非法 OR 真前缀截断 OR 近似截断 → 前缀自愈改写分支（GATE_ERR 标记确保穿透 fail-open，S1）。
        // T01：拒绝文案不回显登记 ID（拆「回显→再转录→死循环」燃料）；审计 detail 含 ID 合规（wf.db 不进上下文）。
        logAdd(st, { at: new Date().toISOString(), cmd: "session:correct", tool: toolName, detail: `${target}: ${passed} → ${tracked}`, from: st.phase, to: st.phase, ok: false, note: fuzzy ? "corrected-fuzzy" : "corrected" });
        // sid-transcribe-probe W3：correction 时点别名可解析性一次性取证（按 role 分键，fail-open）
        try {
          const dirP = st.directory ?? await resolveProjectDir?.(st, input?.sessionID);
          const dbgP = dirP ? `${dirP}/.workflow/_debug` : null;
          const probeFile = dbgP ? `${dbgP}/sid-alias-probe-${target.replace(/^wf\//, "")}.json` : null;
          if (dbgP && probeFile && !fs.existsSync(probeFile)) {
            fs.mkdirSync(dbgP, { recursive: true });
            const tables = { role: target, roleSessions: st.reuse?.roleSessions, lanes: st.lanes };
            fs.writeFileSync(probeFile, JSON.stringify({
              at: new Date().toISOString(),
              target, passed, fuzzy,
              passedLen: String(passed ?? "").length, trackedLen: String(tracked ?? "").length,
              autoWouldResolve: resolveSidAlias(SID_ALIAS_AUTO, tables), // auto 通道：该角色登记反查
              atRoleWouldResolve: resolveSidAlias(`@${target.replace(/^wf\//, "")}`, { roleSessions: st.reuse?.roleSessions, lanes: st.lanes }), // @role 容错通道
            }, null, 2));
          }
        } catch (e) { swallow(e, "guard-hook:sid-alias-probe-fail"); }
        try { await save(st); } catch (e) { swallow(e, "guard-hook:correct-save-fail"); }
        if (isPrefix) {
          // 存活探针（session.get time.busy/idle）：明确运行中→throw 警示（防静默分叉，不静默改写）；
          //   已完成/探不到 time/异常→改写放行（best-effort 同旧 liveNote 判据）。
          let running = false;
          try {
            const child = await host.sessions.get({ sessionID: tracked });
            const busy = Number(child?.time?.busy ?? 0); const idle = Number(child?.time?.idle ?? 0);
            if (busy > 0 && idle > 0) running = busy > idle;
          } catch (e) { swallow(e, "guard-hook:child-live-probe-fail"); }
          if (running) throw new Error(`${GATE_ERR} 续接自愈：传给 ${target} 的 sessionID「${passed}」命中登记会话前缀，但该子会话仍在运行：勿续用运行中会话（防静默分叉）。请待其完成后再续用，或省略 sessionID 新建（勿凭记忆复述长 ID）。`);
          args.sessionID = tracked; // 前缀自愈：就地改写（仿别名分支），零回显放行
          return;
        }
        // fuzzy（形状合法非前缀近似）→ 仍拒绝（防指错会话，基线批准仅 isPrefix 改写）；非法形状非前缀→拒绝。均不回显登记 ID。
        if (fuzzy) throw new Error(`${GATE_ERR} 续接自愈：传给 ${target} 的 sessionID「${passed}」近似匹配登记会话但非前缀（疑似转录失真，防指错会话不自动改写）。请改用别名续接：${SID_ALIAS_USAGE}，或省略 sessionID 新建（勿凭记忆复述；仅续用已完成的子会话，续用失败立即新建）。`);
        throw new Error(`${GATE_ERR} 续接自愈：传给 ${target} 的 sessionID「${passed}」形状非法且非登记会话前缀。请改用别名续接：${SID_ALIAS_USAGE}，或省略 sessionID 新建（勿凭记忆复述长 ID）。`);
      }
      // ── M16-r44：方案确认交互观察（L2 硬关卡记账）────────────────────
      // leader 在确认窗口（review/test_design）调用宿主 question 工具、且选项含锚定批准标签
      //（「批准执行」/approve）→ 记账 st.planConfirmedAt，wf:build 关卡据此放行。
      // 触发依据：question-cr-fix 插件生产实证 execute.before 对 question 触发且入参在 input.input
      //（core/src/tool.ts:271/:280）。诚实边界：用户在卡片中的实际选择只回给模型，插件观测不到——
      // 本记账保证「问过了」，不保证「答的是批准」；审计留痕供 /wf:diagnose / /wf:status 取证。
      if (toolName === "question") {
        // 一次性形状取证（best-effort，先于 leader 过滤——任意会话首个 question 都取证一次）
        if (!questionProbed) {
          questionProbed = true;
          try {
            let dir = process.cwd();
            try { const s = await host.sessions.get({ sessionID: String(input?.sessionID ?? "") }); if (s?.location?.directory) dir = String(s.location.directory); } catch (e) { swallow(e, "guard-hook:session-dir-probe-fail"); }
            const dbg = `${dir}/.workflow/_debug`;
            if (!fs.existsSync(`${dbg}/question-probe.json`)) {
              fs.mkdirSync(dbg, { recursive: true });
              fs.writeFileSync(`${dbg}/question-probe.json`, JSON.stringify({
                at: new Date().toISOString(),
                inputKeys: Object.keys(input ?? {}), argKeys: Object.keys(input?.input ?? {}),
                hookAgent: input?.agent, args: input?.input ?? null,
              }, null, 2));
            }
          } catch (e) { swallow(e, "guard-hook:question-probe-fail"); }
        }
        if (!isLeader(String(input?.agent ?? ""))) return; // 仅 leader 的确认受记账
        const stC = await resolveState(input?.sessionID, input?.agent);
        if (!stC || !stC.slug) return; // 无活动任务不记账
        const phC = String(stC.phase ?? "");
        const qsC = Array.isArray(input?.input?.questions) ? input.input.questions : [];
        // intake-discuss-gate T03：intake 讨论确认窗口——锚「需求无误」（勿锚「批准」/「终止任务」，防串方案确认）。
        // 诚实边界（沿上方 M16-r44 口径）：用户在卡片中的实际选择只回给模型，插件观测不到——
        // 本记账保证「出过卡」，不保证「答的是确认」；出卡记账≠用户已批准，审计留痕供 diagnose/status 取证。
        if (phC === "intake") {
          const confirmedI = qsC.some((q: any) => Array.isArray(q?.options) && q.options.some((o: any) => String(o?.label ?? o ?? "").trim().startsWith("需求无误")));
          if (!confirmedI) return; // 无锚定标签的澄清问不记账
          if (stC.verdicts?.intakeConfirmedAt) return; // 已记账不重复 save（防抖动，幂等）
          stC.verdicts = { ...stC.verdicts, intakeConfirmedAt: new Date().toISOString() };
          logAdd(stC, { at: stC.verdicts.intakeConfirmedAt, cmd: "intake:confirm", tool: toolName, from: stC.phase, to: stC.phase, ok: true, note: confirmNote(stC, input?.sessionID) });
          try { await save(stC); } catch (e) { swallow(e, "guard-hook:intake-confirm-save-fail"); }
          return; // 评审 N4：记账后 return（与 review 分支结构对称）
        }
        if (phC !== "review" && phC !== "test_design") return; // 确认窗口（planning 澄清问不计）
        const approvedC = qsC.some((q: any) => Array.isArray(q?.options) && q.options.some((o: any) => {
          const label = String(o?.label ?? o ?? "").trim();
          return label.startsWith("批准") || /^approve$/i.test(label); // 锚定：排除「不批准」
        }));
        if (!approvedC) return; // 无批准类选项的澄清问不记账
        if (stC.verdicts?.confirmedAt) return; // 已记账不重复 save（防抖动）
        stC.verdicts = { ...stC.verdicts, confirmedAt: new Date().toISOString() }; // R3 T3.1 子步 B
        logAdd(stC, { at: stC.verdicts.confirmedAt, cmd: "plan:confirm", tool: toolName, from: stC.phase, to: stC.phase, ok: true, note: confirmNote(stC, input?.sessionID) });
        try { await save(stC); } catch (e) { swallow(e, "guard-hook:confirm-save-fail"); }
        return;
      }
      if (!EDIT_TOOLS.has(toolName) && toolName !== "shell") return;
      const st = await resolveState(input?.sessionID, input?.agent); // M10-b：wf/* 子会话同样受阶段闸门管辖
      if (!st) return;
      // M16-r40：角色→子会话自动登记——builder/fixer 只改码不写产物，在此捕获其 sessionID。
      // 仅 EDIT_TOOLS 且 sessionID 变化才落盘（每子会话一次，避免 save 抖动）；登记失败不阻断（fail-open）。
      if (EDIT_TOOLS.has(toolName) && trackRoleSession(st, input?.agent, input?.sessionID)) {
        try { await save(st); } catch (e) { swallow(e, "guard-hook:role-reg-save-fail"); }
      }
      // R2 T2.2（arch-r2-profile-statemachine）：blocking 判定=profileOf 的 PhaseDef.blocking
      // （tests/phases.test.js 守卫锁「PhaseDef.blocking ⇔ shared BLOCKING」双向一致，行为等价）；
      // phases 查表 miss（legacy assign 之外的折叠态/存量脏 phase）→ 回退全局 BLOCKING Set=旧语义。
      const phaseDef = profileOf(st).phases[st.phase ?? ""];
      if (!(phaseDef ? phaseDef.blocking === true : BLOCKING_PHASES.has(st.phase))) return;
      if (toolName === "shell") {
        const cmd = String(input?.input?.command ?? "");
        const base = String(input?.input?.cwd ?? st.directory ?? "");
        for (const tRaw of shellWriteTargets(cmd)) { // P0-b：解析提取至 lib
          if (tRaw.startsWith("~")) continue; // 家目录视为项目外
          const abs = (tRaw.startsWith("/") ? tRaw : `${base}/${tRaw}`).replace(/\/{2,}/g, "/");
          if (base && abs.startsWith(`${base}/`) && !isAllowed(abs)) {
            await logBlock(st, toolName, tRaw); // P1：阻断记账，供 /wf:diagnose 取证
            throw new Error(
              `${GATE_ERR} 硬关卡：阶段「${st.phase}」禁止经 shell 写入项目内业务文件「${tRaw}」（放行：${allowHint}）。计划/审核产物请写 .workflow/。临时验证脚本与输出请写项目外绝对路径（如 /tmp/xxx），不受本关卡管辖。${nextHint(st, st.phase)}`
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
            `计划/审核产物请用 wf_write_artifact 工具写入 .workflow/（产物已原生落盘则不带 content=注册补记账）。临时验证脚本与输出请写项目外绝对路径（如 /tmp/xxx），不受本关卡管辖。${nextHint(st, st.phase)}`
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
