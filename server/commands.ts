// wf-workflow — 命令层：10 个流转命令表驱动（/wf:intake…/wf:done，全部经 transition 走状态机）
// + 6 个辅助命令（status/diagnose/ping/lane/reset/debug）。
// R2 T2.4/T2.5（arch-r2-profile-statemachine）：transition/inject/done-git/selfmod 编排迁
// transition.ts；leaderGate×tierSync 中间件链迁 middleware.ts；byName+runner 可变盒子退役，
// 三入口统一经 CommandBus（command-bus.ts）。本文件剩：命令注册表 + 双轨输出编排
//（reportProbe/publishOutput/injectReport）+ 辅助命令 + hook 剥离。
// 已验证 API（实测 2026-11-10，宿主 2.2.6）：命令 editor.add({name, description,
// execute(args={sessionID,prompt,delivery})})。**execute 契约 Promise<void>，返回值不显示
// 给用户**（实测：命令被接受但会话无输出）——故 add 处统一包装：字符串返回值经 RPC "report"
// 事件广播（TUI toast 呈现），同时保留返回值（tests 行为锚）。流转 guidance 另经 inject() 写
// instructions.entry 供 agent 消费——两条通道并行、互不干扰。
// deps 来源：load/save/resolveProjectDir（state）、debugDirFor/probeOnce（observe）、
// LIMS（index 组装：options.limits 覆盖后的生效上限）、emitUpdated/emitReport/WfDef/rpcErr（rpc-bridge）、
// bus（index 装配期创建，bridge/tool/commands 三方共享）。
import * as fs from "node:fs";
import {
  VERSION, BLOCKING_PHASES, nextFor, promptText, diagnoseReport, pingReport,
  SID_ALIAS_AUTO, resolveSidAlias, completeSidPrefix,
  FLOW_CMD_NAMES, levelFor, renderReport, type ReportLevel,
  type WfState,
} from "./lib.ts"; // R2 T2.4/T2.5：flowFor/evaluateTransition/leaderOnlyReject/isSelfModDir/selfModWarnLine/briefFallback 随体迁出；+renderReport 文本链单点
import { briefFor } from "./guidance.ts"; // M16-r39 T08：guidance 拆分（文案逐字不变）// R2：guidance/entryValue 消费随 transition 迁出
import { ENTRY_KEY, HINT_KEY, withStateRetry, type Store } from "./state.ts"; // R2：logAdd/scanActiveTasks/FOLD 随体迁出
import { type Observer, swallow, listSwallows } from "./observe.ts";
import { type Host } from "./host.ts"; // T03：registerCommands 收 Host（原 ctx:any；入口 setup(ctx) 签名不变） // T01：swallow 记账 + diagnose 摘要接线
// R2 T2.4/T2.5（arch-r2-profile-statemachine）：transition/inject 编排与命令中间件链、命令总线提取——
// commands.ts 自此只持命令注册表 + 双轨输出编排 + 辅助命令；bus 取代 runner 可变盒子。
import { createTransition } from "./transition.ts";
import { createCommandGuard } from "./middleware.ts";
import type { CommandBus } from "./command-bus.ts";
import { resolveRolesDir, roleSyncStatus } from "./roles.ts"; // M16-r31：角色托管漂移守卫
import { TIER_ROLES, readTierAgents } from "./model-tier.ts"; // M16-r43：档位视图（ping 只读面）；tierCheck 写面随迁 middleware.ts
import { readFile as fsReadFile } from "node:fs/promises"; // R2：fsIo（mkdir/writeFile）随 tierCheck 迁出

// 降级轨报告的消息标记（注入 metadata 与剥离 hook 同源；tests 断言依赖此 key）
export const REPORT_META = "wf.report";

// notification-brief-display T03（B 意见）：流转命令名唯一来源在 lib.FLOW_CMD_NAMES；
// 本表只持 name→description（注册时按名单遍历取值）。键集与 FLOW_CMD_NAMES 相等由
// tests/flows.test.js 断言锁死（新增/删除流转命令只改 lib 名单 + 此表补描述）。
export const FLOW_DESCRIPTIONS: Record<string, string> = {
  "wf:intake": "工作流入口：澄清需求/读 .learnings/补 gitignore（参数=slug）",
  "wf:plan": "进入 planning：委派 wf/planner 产出 plan.md",
  "wf:review": "进入 review（并发委派：planner-reviewer ∥ tester feasibility），≤3 轮",
  "wf:test-design": "进入 test_design：双通道关卡（须 test-plan.md）；冻结接口排 lane + tester(design) 写红验收测试（M16-r28：原 assign 并入）",
  "wf:build": "进入 building：每 lane 一 worktree + wf/builder（TDD）",
  "wf:reconcile": "进入 reconcile：合并各 worktree 回主树，冲突上报用户",
  "wf:review-build": "进入 build_review：wf/builder-reviewer，≤3 轮",
  "wf:test": "进入 testing：wf/tester verify → test-report.md（PASS|FAIL）",
  "wf:fix": "进入 fixing：同 lane 回 builder / 跨 lane 用 fixer，≤3 轮",
  "wf:done": "进入 done：审计汇报→经验沉淀回执→交付确认（git 项目串行：总结→提交/不提交→完成）",
};

// M16-r39 T06：deps 类型化（CommandDeps 契约；宿主入参 ctx 保留 any，内部数据流用领域类型）
export interface CommandDeps {
  load: Store["load"];
  save: Store["save"];
  resolveProjectDir: Store["resolveProjectDir"];
  removeState: Store["removeState"];
  putReport: Store["putReport"];
  dumpStates: Store["dumpStates"];
  debugDirFor: Observer["debugDirFor"];
  probeOnce: Observer["probeOnce"];
  LIMS: Record<string, number>;
  emitUpdated: (st: WfState) => Promise<void>;
  // notification-brief-display T03：meta 可选（index.ts 传 rpc-bridge.emitReport；旧调用三参兼容）
  emitReport?: (sessionID: string, text: string, at: string, meta?: { brief?: string; level?: ReportLevel }) => Promise<void>;
  WfDef?: unknown;
  rpcErr?: string | null;
  // R2 T2.4（arch-r2-profile-statemachine）：runner 可变盒子退役——CommandBus 实例装配期共享
  //（index 先建、bridge/tool 持引用、registerCommands 填充+attachPublish），无运行时替换面。
  bus: CommandBus;
}

// R2 T2.4/T2.5（arch-r2-profile-statemachine）迁移注记：PLUGIN_REPO_ROOT/selfModRootFor/realDir/
// listOverrides/detectDoneGit → transition.ts；resolveAgent/fsIo/tierCheck → middleware.ts；
// sanitizeText → domain/report.ts renderReport（文本链单点）。以下为本文件仍消费的模块级纯函数。
// 报告剥离（降级轨上下文保护）：带 wf.report 标记的消息不进模型请求/压缩/标题
const stripReports = (event: any) => {
  if (Array.isArray(event?.messages)) {
    event.messages = event.messages.filter((msg: any) => msg?.metadata?.[REPORT_META] === undefined);
  }
};
// M16-r31：角色托管漂移守卫文案（fail-soft，读宿主文件失败不阻塞 ping）
const roleGuardText = (opt: any) => {
  try {
    const st = roleSyncStatus(resolveRolesDir(opt));
    const bad = st.filter((r) => r.status !== "managed");
    if (!bad.length) return `\n角色托管：${st.length}/${st.length} 与仓库一致（${VERSION}）`;
    return `\n角色托管漂移：${bad.map((r) => `${r.name}=${r.status}`).join(" ")}（syncRoles 开启后 setup 自动修复；unmanaged 需手动加标记）`;
  } catch { return ""; }
};

export async function registerCommands(host: Host, deps: CommandDeps): Promise<{ dispose: () => void }> {
  const { load, save, resolveProjectDir, debugDirFor, LIMS, probeOnce, emitUpdated, emitReport, WfDef, rpcErr,
    putReport, removeState, dumpStates, bus } = deps;

  // R2 T2.4：transition/inject 编排提取至 transition.ts（createTransition 显式 deps 注入，
  // 行为逐字节=旧闭包）；R2 T2.5：命令中间件链工厂（leaderGate×tierSync，顺序单点 CMD_MW_ORDER）。
  const { transition } = createTransition({ host, load, save, resolveProjectDir, LIMS, emitUpdated });
  const cmdGuard = createCommandGuard({ host, load, save, probeOnce, resolveProjectDir });

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
    } catch (e) { swallow(e, "commands:report-probe-fail"); }
  };

  // ── P2 双轨输出编排 ────────────────────────────────────────────────
  // publishOutput：写 reports 表 + report 事件（机会性补充）+ 探针。两条入口共用。
  // notification-brief-display T03（plan §4 冻结）：server 结构化判定 brief/level 随行/随事件
  // 传播（三通道之一）；text 全文通道一律不动（LLM 锚/降级轨 injectReport 仍喂全文）。
  // load fail-soft：无任务/读失败 → st=null → briefFor 分派自动落 briefFallback。
  const publishOutput = async (sid: string, text: string, at: string, cmdName: string): Promise<{ brief: string; level: ReportLevel }> => {
    const st = await load(sid).catch(() => null);
    const brief = briefFor(cmdName, text, st, LIMS);
    const level = levelFor(cmdName, text, st);
    let slotOk = false;
    try { await putReport({ sessionID: sid, text, at, brief, level }); slotOk = true; } catch (e) { swallow(e, "commands:report-slot-write-fail"); }
    if (emitReport) await emitReport(sid, text, at, { brief, level });
    await reportProbe(sid, { ev: slotOk ? "slot+emit" : "slot-fail", cmd: cmdName, chars: text.length, hasChan: !!emitReport, level, hasBrief: !!brief });
    return { brief, level };
  };
  // 降级轨（Web/Desktop/无 TUI）：execute 返回值宿主不消费（契约 Promise<void>）——
  // 报告经 wait 排空后以 prompt(resume:false, steer, metadata 标记) 注入会话（2.2.6 源码
  // session.ts:187 保证不 wake），配合 context/compaction/generate hook 按标记剥离，
  // 报告不进模型上下文（quota 全套范式）。
  const injectReport = async (sid: string, text: string, cmdName: string, at: string) => {
    try {
      await host.sessions.wait({ sessionID: sid }); // T03：旧 wait?.() 缺失即跳过→wrapper 缺失→resolved undefined，时序等价
      // R2 T2.5：文本链单点 renderReport（domain/report.ts，旧 sanitizeText 逐字节平移；管线例锁不变量）
      await host.sessions.prompt({ sessionID: sid, text: renderReport(text), delivery: "steer", resume: false,
        metadata: { [REPORT_META]: { cmd: cmdName, at } } });
      await reportProbe(sid, { ev: "inject-ok", cmd: cmdName });
    } catch (e) {
      await reportProbe(sid, { ev: "inject-fail", cmd: cmdName, err: String((e as Error)?.message ?? e).slice(0, 140) });
    }
  };
  // R2 T2.4：exec 通道调度经 CommandBus——旧 byName Map 与 runner.run 包装体逐字节迁移到
  // command-bus.ts（未知命令 ❌/briefFallback/levelFor 同形）；双轨统一挂接 publish：
  // bus.attachPublish = 本文件 publishOutput（exec 主轨不注入聊天，editor execute 轨另行 injectReport）。
  bus.attachPublish(async (name, text, at, a) => publishOutput(String(a?.sessionID ?? ""), text, at, name));

  const reg = host.commands.transform((editor: any) => {
    // server 命令通道 = 降级轨：publish（reports 表，TUI 轮询兜底可见）+ inject（Web/Desktop 聊天可见）。
    // 返回值保留（tests 行为锚；宿主不消费）。
    const add = (def: any) => {
      const base = def.execute;
      // M16-r36：单一强制点——聊天命令/wf_command/TUI exec 三入口同调 bus，guarded 一处覆盖。
      // R2 T2.5：guarded=中间件链组合（leaderGate×tierSync，体逐字节迁移至 middleware.ts；
      // 顺序单点 CMD_MW_ORDER，tests/middleware.test.js 锁短路/附加语义）。
      // R2 T2.4：注册面 byName→bus（三入口 call 同一实例，runner 可变盒子退役）。
      const guarded = cmdGuard.guard(def.name)(base);
      bus.register(def.name, guarded);
      editor.add({
        ...def,
        execute: async (a: any) => {
          const out = await guarded(a);
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

    // ── 10 个流转命令（表驱动；M16-r28 assign 并入 test-design）──
    // notification-brief-display T03（B 意见）：命令名唯一来源 = lib.ts FLOW_CMD_NAMES，
    // 本处只留 name→description 映射（模块级 FLOW_DESCRIPTIONS）；防漂移键集相等断言
    // 见 tests/flows.test.js T03（含源码 grep：无第二份硬编码 [name,description] 名单）。
    for (const name of FLOW_CMD_NAMES) {
      add({ name, description: FLOW_DESCRIPTIONS[name] ?? "", execute: async (a: any) => transition(a.sessionID, name, a.prompt) });
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
          `slug=${st.slug || "(未定)"}  phase=${st.phase}  mode=${st.mode ?? "full"}  size=${st.size ?? "M"}`,
          `rounds: plan_review=${r.plan_review ?? 0}/${LIMS.plan_review}  build_review=${r.build_review ?? 0}/${LIMS.build_review}  test_fix=${r.test_fix ?? 0}/${LIMS.test_fix}`,
          `gates: testPlan=${st.testPlanWritten ? "✅" : "❌"}  testReport=${st.testReportVerdict ?? "-"}  planReview=${st.planReviewVerdict ?? "-"}  planConfirm=${st.planConfirmedAt ? "✅" : "❌"}`,
          `lanes: ${JSON.stringify(st.lanes ?? {})}`,
          `roleSessions: ${JSON.stringify(st.roleSessions ?? {})}`, // M16-r40：角色→子会话自动登记（续用取证）
          `artifacts: ${JSON.stringify(st.artifacts ?? {})}`,
          `下一步: ${nextFor(st, st.phase)}`,
          `最近流转:`,
          ...(st.log ?? []).slice(-8).map((e: any) =>
            `  ${String(e.at ?? "").slice(11, 19)} ${e.cmd} ${e.from ?? "∅"}→${e.to}${e.ok ? "" : `（${e.note}）`}`),
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
        try { artifactFiles = fs.readdirSync(`${dir}/.workflow/${st.slug}`); } catch (e) { swallow(e, "commands:diagnose-readdir-fail"); }
        return diagnoseReport(st, { version: VERSION, artifactFiles, rpcErr, limits: LIMS, swallows: listSwallows() });
      },
    });
    add({
      name: "wf:ping",
      description: "健康检查：列出 wf/* 角色 agent 注册状态与模型（只读，fail-soft）",
      execute: async (a: any) => {
        try {
          const res = await host.agents.list(); // T03：缺失判定=wrapper 返回 undefined（旧 !ctx.agent?.list 分支；降级文案逐字不动，M1 裁决）
          if (res === undefined) return `wf 角色：宿主未提供 ctx.agent API（v2.2.6 实测以 agent-probe 为准）；可用 @<角色> 手动验证`;
          await probeOnce(a?.sessionID, "agent-probe", { shape: Array.isArray(res) ? "array" : Object.keys(res ?? {}) });
          let tierLine = "";
          // M16-r43：档位跟随生效视图——读项目级派生文件（/api/agent 序列化不含 model，读文件为准）
          try {
            const sid = String(a?.sessionID ?? "");
            const st = await load(sid);
            const dir = await resolveProjectDir(st, sid);
            const rows = await readTierAgents(dir, TIER_ROLES, { readFile: (p: string) => fsReadFile(p, "utf8") });
            if (rows.length) tierLine = `\n档位跟随（tierAgents，Session 基座派生）：${rows.join(" ")}`;
          } catch (e) { swallow(e, "commands:ping-tier-read-fail"); }
          return pingReport(res) + roleGuardText(host.options) + tierLine;
        } catch (e) {
          return `wf 角色查询失败：${(e as Error)?.message ?? e}（host API 形状待 _debug/agent-probe.json 确认）`;
        }
      },
    });
    add({
      name: "wf:open",
      description: `查看产物内容（只读降级轨：无参列产物清单，带参输出该产物全文，${VERSION}）`,
      execute: async (a: any) => {
        const st = await load(a.sessionID);
        if (!st || (!st.slug && !st.phase)) return "wf:open：本会话无活动任务。";
        const arts = st.artifacts ?? {};
        const names = Object.keys(arts);
        const file = promptText(a.prompt).trim();
        if (!file) return `wf 产物清单（slug=${st.slug}）：${names.join("、") || "（无）"}\n用法：/wf:open <产物文件名> 查看全文（TUI 侧边栏可直接点击产物行）。`;
        // 白名单 = artifacts 记账 key（防路径穿越；与 RPC read 契约同源）
        if (!names.includes(file)) return `❌ 产物未记账：${file}（清单：${names.join("、") || "无"}）`;
        const dir = await resolveProjectDir(st, a.sessionID);
        const path = `${dir}/.workflow/${st.slug}/${file}`;
        let text: string;
        try { text = await fsReadFile(path, "utf8"); } catch { return `❌ 产物已记账但文件缺失：${path}`; }
        const bytes = Buffer.byteLength(text, "utf8");
        const MAX = 64 * 1024;
        const truncated = bytes > MAX;
        return [`📄 ${path}（${(bytes / 1024).toFixed(1)}k）`, "", truncated ? `${text.slice(0, MAX)}\n…（超 64KB 截断）` : text].join("\n");
      },
    });
    add({
      name: "wf:lane",
      description: `登记/查看 lane：set <Tnn> <子会话ID|@别名> [worktree] / rm <Tnn> / 默认 ls（${VERSION}）`,
      execute: async (a: any) => {
        const t = promptText(a.prompt).trim().split(/\s+/);
        const op = (t[0] ?? "ls").toLowerCase();
        const id = String(t[1] ?? "");
        const wt = String(t[3] ?? "");
        const st0 = await load(a.sessionID); // lane 挂在 leader 会话自持状态上
        if (!st0) return "❌ 本会话无活动任务。lane 登记需先 /wf:intake <slug>。";
        // M16-r45：set 的别名/前缀/存在性解析前置（applyOp 须同步可重放）——基于本次快照解析出最终 sid，
        // stale-rev 重放以解析结果为准；解析含宿主存在性校验，截断/失真 ID 在写入口即拒（防坏 ID 入库）。
        let sid = "";
        let setNote = "";
        if (op === "set") {
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(id)) return `❌ lane ID 非法：「${id}」（用 T01 这类：字母数字开头，≤32 字符，仅 A-Za-z0-9._-）`;
          const raw = String(t[2] ?? "");
          if (!raw) return "❌ 用法：/wf:lane set <Tnn> <子会话ID|@别名> [worktree路径]";
          if (raw === SID_ALIAS_AUTO || raw.startsWith("@")) {
            const res = resolveSidAlias(raw, { roleSessions: st0.roleSessions, lanes: st0.lanes });
            if (!res.ok) return `❌ 别名解析失败：${res.reason}${res.candidates?.length ? `（可用：${res.candidates.join(", ")}）` : ""}`;
            sid = res.sid;
            setNote = `｜别名 ${raw} → ${sid}`;
          } else {
            const known = [...new Set([
              ...Object.values(st0.roleSessions ?? {}).map((v) => v?.sessionID).filter(Boolean),
              ...Object.values(st0.lanes ?? {}).map((v) => v?.sessionID).filter(Boolean),
            ] as string[])];
            const comp = completeSidPrefix(raw, known);
            if (comp.kind === "ambiguous") return "❌ 前缀命中多个登记会话——改用 @Tnn 或 @wf/xx 别名区分；lane 未变更。";
            sid = comp.kind === "completed" ? (comp.sid as string) : raw;
            if (comp.kind === "completed") setNote = `｜前缀补全 ${raw} → ${sid}`;
            // 宿主存在性校验（fail-open：宿主 API 不可用时不拦截，交由续接时的归属校验兜底）
            // T03：旧 typeof 检查→wrapper 缺失=rejected 走外层 catch（fail-open 等价；记账入环）
            try {
              const sess = await host.sessions.get({ sessionID: sid }).catch(() => null);
              if (!sess) return `❌ 子会话不存在：「${sid}」（截断/已清库——经 session-lookup 管道重取，或 @别名续接）；lane 未变更。`;
            } catch (e) { swallow(e, "commands:lane-session-probe-fail"); }
          }
        }
        // T04：变更提取为可重放函数——stale-rev 冲突时以最新快照重放 set/rm（≤3 次），
        // 返回错误串=操作不成立，null=已写入 st.lanes
        const applyOp = (st: WfState): string | null => {
          st.lanes = st.lanes ?? {};
          if (op === "set") {
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(id)) return `❌ lane ID 非法：「${id}」（用 T01 这类：字母数字开头，≤32 字符，仅 A-Za-z0-9._-）`;
            if (!/^ses_[A-Za-z0-9]+$/.test(sid)) return `❌ 子会话 ID 非法：「${sid}」（应形如 ses_xxx，来自 subagent 返回值/@别名）`;
            st.lanes[id] = { sessionID: sid, worktree: wt || null, at: new Date().toISOString() };
            return null;
          }
          if (!(id in st.lanes)) return `❌ 没有 lane「${id}」。当前：${Object.keys(st.lanes).join(", ") || "(空)"}`;
          delete st.lanes[id];
          return null;
        };
        if (op !== "set" && op !== "rm") { // ls（默认）只读，不落盘
          const lanes = st0.lanes ?? {};
          const ks = Object.keys(lanes);
          if (!ks.length) return "lane 列表为空。用法：/wf:lane set <Tnn> <子会话ID|@别名> [worktree路径]";
          return ks.map((k: string) => {
            const v = lanes[k];
            return `  ${k} → ${v.sessionID}${v.worktree ? ` @ ${v.worktree}` : ""}（${String(v.at ?? "").slice(0, 19)}）`;
          }).join("\n");
        }
        // M16-r39 T07：归一 withStateRetry——load(1)=首快照 st0、load(n)=重载；apply=applyOp
        const res = await withStateRetry({
          load: async (attempt) => (attempt === 1 ? st0 : await load(a.sessionID)),
          apply: (st) => applyOp(st),
          save,
        });
        if (!res.ok) {
          if (res.reason === "halt") return res.msg ?? "";
          if (res.reason === "gone") return "❌ 状态行已不存在（并发 reset？），lane 变更未生效。";
          return `❌ 状态保存失败（${res.reason}），lane 变更未生效，请重试。`;
        }
        await emitUpdated(res.st);
        return `✅ lanes(${VERSION}) = ${JSON.stringify(res.st.lanes)}${setNote}`;
      },
    });
    add({
      name: "wf:reset",
      description: "开发/中止用：清除本会话的工作流状态与阶段注入",
      execute: async (a: any) => {
        await removeState(a.sessionID); // P1：清任务行与报告槽（防新挂载重放旧 toast；events 流水保留审计）
        try { await host.instructions.remove({ sessionID: a.sessionID, key: ENTRY_KEY }); } catch (e) { swallow(e, "commands:reset-entry-remove-fail"); }
        try { await host.instructions.remove({ sessionID: a.sessionID, key: HINT_KEY }); } catch (e) { swallow(e, "commands:reset-hint-remove-fail"); }
        await emitUpdated({ sessionID: a.sessionID, slug: "", phase: null, rounds: {} } as WfState); // M10-a：A3，TUI 实时反映清除
        return "wf 工作流：本会话状态已清除。可用 /wf:intake <slug> 重新开始。";
      },
    });
    add({
      name: "wf:debug",
      description: "观测通道：把当前状态与审计轨迹落盘到 <项目>/.workflow/_debug/state.json",
      execute: async (a: any) => {
        const st = await load(a.sessionID);
        let entries = null;
        // T03：capability 信号=instructions.list 缺失返回 undefined（旧 !E?.list → "no entry API" 文案逐字；
        // wrapper 缺失时不发底层调用）。两形态试探结构与旧一致：首形态 reject→key 形态→再 reject→ERR1|ERR2。
        try {
          const l1 = await host.instructions.list({ sessionID: a.sessionID });
          entries = l1 === undefined ? "no entry API" : l1;
        }
        catch (e1) {
          try { entries = await host.instructions.list({ sessionID: a.sessionID, key: ENTRY_KEY }); }
          catch (e2) { entries = `ERR1:${(e1 as Error)?.message ?? e1} | ERR2:${(e2 as Error)?.message ?? e2}`; }
        }
        // M16-r39 T09：sessProbe 收敛——5 candidates 形状探测已完成历史使命（扁平形状真机实证），
        // 改单一扁平 host.sessions.get({sessionID})（T03）；state.json 键名 sessProbe 不变
        let sessProbe = null;
        try {
          const r = await host.sessions.get({ sessionID: a.sessionID });
          sessProbe = { ok: true, topKeys: Object.keys(r ?? {}), location: r?.data?.location ?? r?.location ?? null };
        } catch (e) {
          sessProbe = { ok: false, err: String((e as Error)?.message ?? e).slice(0, 140) };
        }
        let rpcSelf = null;
        try { rpcSelf = WfDef ? await host.rpc.client(WfDef).state({ sessionID: a.sessionID }) : "no-rpc-def"; }
        catch (e) { rpcSelf = `ERR:${String((e as Error)?.message ?? e)}`; }
        let rpcList = null;
        try { rpcList = WfDef ? await host.rpc.client(WfDef).list({}) : "no-rpc-def"; }
        catch (e) { rpcList = `ERR:${String((e as Error)?.message ?? e)}`; }
        let rpcListMine = null;
        try { rpcListMine = WfDef ? await host.rpc.client(WfDef).list(st?.projectID ? { projectID: String(st.projectID), ...(st.directory ? { directory: String(st.directory) } : {}) } : {}) : "no-rpc-def"; }
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
        } catch (e) { swallow(e, "commands:state-dump-write-fail"); }
        return `wf 工作流状态已落盘：${dbg}/.workflow/_debug/state.json`;
      },
    });
  });

  const hookRegs: any[] = [];
  try {
    for (const h of ["context", "compaction", "generate"]) {
      const r = await host.sessions.hook(h, stripReports);
      if (r) hookRegs.push(r);
    }
    const rt = await host.sessions.hook("title", (event: any) => {
      stripReports(event);
      const hasText = (event?.messages ?? []).some((m: any) => {
        const c = m?.content;
        if (typeof c === "string") return c.trim() !== "";
        return Array.isArray(c) ? c.some((p: any) => p?.type === "text" && String(p?.text ?? "").trim() !== "") : false;
      });
      if (!hasText) event.result = ""; // 首条消息仅报告：跳过标题生成（quota 先例）
    });
    if (rt) hookRegs.push(rt);
  } catch (e) { swallow(e, "commands:title-hook-missing"); }

  return {
    dispose: () => {
      try { reg?.dispose?.(); } catch (e) { swallow(e, "commands:reg-dispose-fail"); }
      for (const r of hookRegs) { try { r?.dispose?.(); } catch (e) { swallow(e, "commands:hook-reg-dispose-fail"); } }
    },
  };
}