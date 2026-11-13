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
import { join } from "node:path";
import {
  VERSION, BLOCKING_PHASES, flowFor, nextFor, leaderOnlyReject,
  evaluateTransition, promptText, diagnoseReport, pingReport,
  SID_ALIAS_AUTO, resolveSidAlias, completeSidPrefix,
  FLOW_CMD_NAMES, levelFor, briefFallback, isSelfModDir, selfModWarnLine, type ReportLevel,
  type WfState,
} from "./lib.ts";
import { guidance, entryValue, briefFor } from "./guidance.ts"; // M16-r39 T08：guidance 拆分（文案逐字不变）
import { FOLD } from "../shared/phases.ts"; // tui-sidebar-elapsed T01：闭账 key 折叠（reconcile→building、retrospect→done）
import { ENTRY_KEY, HINT_KEY, logAdd, withStateRetry, scanActiveTasks, type Store } from "./state.ts";
import { type Observer } from "./observe.ts";
import { resolveRolesDir, roleSyncStatus } from "./roles.ts"; // M16-r31：角色托管漂移守卫
import {
  TIER_MAP, TIER_TRIGGERS, TIER_ROLES, syncTierAgents, readTierAgents,
  type ModelRef,
} from "./model-tier.ts"; // M16-r43：动态档位跟随
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";

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
  runner?: { run: ((name: string, a: any) => Promise<unknown>) | null };
}

// selfmod-guard T01：插件仓库根=本模块上级目录（bun 直跑 TS，import.meta.dirname 实证可用，roles.ts 同源）；
// 解析失败 → ""，isSelfModDir 恒 false（fail-open：判不出=不告警，宁缺勿滥）。
const PLUGIN_REPO_ROOT = (() => {
  try { return fs.realpathSync(join(import.meta.dirname, "..")); } catch { return ""; }
})();
// 生效探测根：options.selfModRoot 覆盖（测试/特殊安装布局）> 模块仓库根。运行时读 ctx.options
// （与 leaderOnly 同模式——setup 期捕获会丢失测试与热载后的选项变更）。
const selfModRootFor = (ctx: any): string => {
  const o = ctx?.options?.selfModRoot;
  if (typeof o === "string" && o) { try { return fs.realpathSync(o); } catch { return o; } }
  return PLUGIN_REPO_ROOT;
};
// 任务目录归一（realpath 失败回退原值——软链/inode 差异不得使自改漏判为假阴性的反例已由
// isSelfModDir 的 fail-open 语义兜住：判不出=不告警）
const realDir = (d: unknown): string => { try { return fs.realpathSync(String(d ?? "")); } catch { return String(d ?? ""); } };

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
// M16-r36：agent 解析——快路径 a.agent（聊天命令若携带）→ session.get 兜底（Session.Info.agent 实证）。
// sessionGet 注入以便单测；解析失败返回 ""（变更类 fail-closed 由 leaderOnlyReject 裁决）。
const resolveAgent = async (a: any, sessionGet: (q: { sessionID: string }) => Promise<any>): Promise<string> => {
  const direct = String(a?.agent ?? "");
  if (direct) return direct;
  try { return String((await sessionGet({ sessionID: String(a?.sessionID ?? "") }))?.agent ?? ""); } catch { return ""; }
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
// done-git-delivery-confirm T01：done 流转的 git 环境检测（模块级 IO 纯函数，fail-open 由调用方兜底）。
// isGit = <dir>/.git 存在（目录或 linked worktree 的 gitdir 指针文件均算）；
// hasRemote = git config 匹配 [remote "...]（.git 文件 → 解析 gitdir: 指针取 <gitdir>/config；读失败保守 false）。
export function detectDoneGit(dir: string): { isGit: boolean; hasRemote: boolean } {
  const gitPath = `${dir}/.git`;
  if (!fs.existsSync(gitPath)) return { isGit: false, hasRemote: false };
  let configPath = `${gitPath}/config`;
  try {
    if (fs.statSync(gitPath).isFile()) {
      const m = fs.readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
      if (m) configPath = `${m[1].startsWith("/") ? m[1] : `${dir}/${m[1]}`}/config`;
    }
    return { isGit: true, hasRemote: /\[remote\s+"/.test(fs.readFileSync(configPath, "utf8")) };
  } catch { return { isGit: true, hasRemote: false }; }
}

export async function registerCommands(ctx: any, deps: CommandDeps): Promise<{ dispose: () => void }> {
  const E = ctx?.session?.instructions?.entry;
  const { load, save, resolveProjectDir, debugDirFor, LIMS, probeOnce, emitUpdated, emitReport, WfDef, rpcErr,
    putReport, removeState, dumpStates, runner } = deps;

  const inject = async (st: WfState) => {
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
  // M16-r39 T07：归一 withStateRetry——load 回调返回克隆（无前行→新建态，绝不透传 null，
  // 否则新 intake 被误判 gone）；apply=evaluate+phase/log/inject（拒绝：有前行才审计 save，
  // best-effort，返回 msg=halt 不重试）；终败回滚 entry 到 DB 现势（lastLoaded=原始 loaded）。
  //  - inject 保持在 save 前（entryErr 需随本次 save 持久化）；emitUpdated/guidance 输出置于
  //    retry ok 之后（不向 TUI 广播未落库的状态）。
  const transition = async (sessionID: string, cmd: string, text?: string) => {
    let lastLoaded: WfState | null = null; // 原始 loaded（可 null）——终败 entry 回滚基准
    let from: string | null = null;
    let preArtifacts: string[] = [];
    let selfModNote: string | null = null; // selfmod-guard T01：告警行（save 成功后追加输出）
    const res = await withStateRetry({
      load: async () => {
        const loaded = await load(sessionID);
        lastLoaded = loaded;
        // T09：评估/改写只作用于克隆——loaded 恒为「DB 现势」快照，save 最终失败的 entry 回滚
        // 依赖它（原地改写会让回滚注入未落库的 phase/rounds，名存实亡）
        return loaded ? structuredClone(loaded) : {
          sessionID, slug: "", phase: null,
          rounds: { plan_review: 0, build_review: 0, test_fix: 0 },
          lanes: {}, artifacts: {}, log: [], createdAt: new Date().toISOString(),
        };
      },
      apply: async (st) => {
        from = st.phase ?? null;
        const at = new Date().toISOString();
        // M16-r29：强制重置前产物记账快照（供中途 !intake 重置后的账实不符告警）
        preArtifacts = cmd === "wf:intake" ? Object.keys(st.artifacts ?? {}) : [];

        // P0-b：来源合法性 / gate / 计数上限 / intake 守卫与重置 → lib.evaluateTransition（拒绝不消耗循环额度）
        const r = evaluateTransition(cmd, st, text, at, LIMS);
        if (!r.ok) {
          logAdd(st, { at, cmd, from, to: from, ok: false, note: r.note });
          if (lastLoaded) { try { await save(st); } catch { /* 审计 best-effort */ } } // T02：无前行不落盘
          return r.msg; // halt：不重试
        }

        // M16-r34：mode 选择流转表（daily 子表 vs full）；evaluateTransition 已放行 → flow 必存在
        const flow = flowFor(st, cmd)!;
        st.phase = flow.to;
        st.updatedAt = at;
        // tui-sidebar-elapsed T01（plan §3.2 冻结）：墙钟计时记账——离开阶段闭账（FOLD 折叠 key，
        // 多轮 revisit 累计）；重置块已置 phaseEnteredAt=at 时闭账跳过（d 恒 0，不污染空账）。
        // fromKey 置于 if 内：strict 下 from 经守卫收窄为 string（语义与冻结式逐字一致，仅作用域收窄）
        if (from && st.phaseEnteredAt && st.phaseEnteredAt !== at) {
          const fromKey = FOLD[from] ?? from;
          const d = Math.max(0, Math.round((Date.parse(at) - Date.parse(st.phaseEnteredAt)) / 1000));
          st.phaseDurations = { ...st.phaseDurations, [fromKey]: (st.phaseDurations?.[fromKey] ?? 0) + d };
        }
        st.phaseEnteredAt = at;
        if (flow.to === "done" && st.startedAt && !st.finishedAt) st.finishedAt = at;
        // 存量（无 startedAt）推 done 不置 finishedAt（总耗时保持 null 降级 ·）
        // M10-b：一次性补全 projectID/directory（供索引与子会话落盘定位）
        if (!st.projectID) {
          try {
            const s = await ctx.session.get({ sessionID });
            st.projectID = s?.projectID ?? null;
            st.directory = s?.location?.directory ?? null;
          } catch { }
        }
        // done-git-delivery-confirm T01：进 done 即检测 git 环境（置于 directory 补全后、inject 前，
        // 使 done entry 渲染即含交付确认指令）；fail-open：任何异常=不记账=零提示，绝不阻断流转。
        if (flow.to === "done") {
          try {
            const dir = st.directory ?? (await resolveProjectDir(st, sessionID));
            if (dir) {
              const g = detectDoneGit(String(dir));
              // 非 git 项目不记账且清旧账（重复推 done 幂等）：state 零污染，done 行为与旧版逐字节一致
              if (g.isGit) st.doneGit = g; else delete st.doneGit;
            }
          } catch { /* fail-open */ }
        }
        logAdd(st, { at, cmd, from, to: flow.to, ok: true, rounds: { ...st.rounds } });
        // selfmod-guard T01（F2 v2）：intake 引擎自改检测（fail-open=判不出按非自改）——任务目录=插件仓库根
        // → st.selfMod 记账（building guidance 纪律行走 entry 通道，抗 compaction）+ 跨库扫描其它活动任务
        // （scanActiveTasks：内存∪持久清单，休眠任务亦现形——v1 内存注册表盲区实证）。
        // 告警行在 transition 末尾 save 成功后追加，非拒绝=⚠️ 前缀。
        if (cmd === "wf:intake") {
          try {
            const dir = realDir(st.directory ?? (await resolveProjectDir(st, sessionID)));
            if (isSelfModDir(dir, selfModRootFor(ctx))) {
              st.selfMod = true;
              selfModNote = selfModWarnLine(scanActiveTasks(sessionID));
            } else delete st.selfMod;
          } catch { /* fail-open */ }
        }
        await inject(st);
        return null;
      },
      save,
    });
    if (!res.ok) {
      if (res.reason === "halt") return res.msg ?? "";
      // T09：entry 回滚到 DB 现势——消除「系统提示已进新阶段、DB 未动」的矛盾信号
      if (lastLoaded) await inject(lastLoaded);
      else { try { await E.remove({ sessionID, key: ENTRY_KEY }); } catch { } } // 新建会话建行失败：无行则清指引
      return `❌ 状态保存失败（${res.reason}），本次流转未生效（以 /wf:status 为准），请重试。`;
    }
    const st = res.st;
    await emitUpdated(st);
    let out = guidance(st.phase, st, LIMS);
    // M16-r29：中途强制重置（!intake）清空产物记账——账实不符告警（done 后正常换任务不告警）
    if (cmd === "wf:intake" && from && from !== "done" && preArtifacts.length > 0) {
      out += `\n⚠️ 强制重置已清空 ${preArtifacts.length} 项产物记账（${preArtifacts.join(", ")}）——磁盘文件仍在 .workflow/${st.prev?.slug ?? "旧slug"}/，新任务账实不符；如需沿用请先对账（/wf:diagnose）。`;
    }
    // selfmod-guard T01：并发告警（仅检测到其它活动任务时非 null；⚠️ 行不带 ❌=info 轨，裁决归用户）
    if (cmd === "wf:intake" && selfModNote) out += `\n${selfModNote}`;
    return out;
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
  // notification-brief-display T03（plan §4 冻结）：server 结构化判定 brief/level 随行/随事件
  // 传播（三通道之一）；text 全文通道一律不动（LLM 锚/降级轨 injectReport 仍喂全文）。
  // load fail-soft：无任务/读失败 → st=null → briefFor 分派自动落 briefFallback。
  const publishOutput = async (sid: string, text: string, at: string, cmdName: string): Promise<{ brief: string; level: ReportLevel }> => {
    const st = await load(sid).catch(() => null);
    const brief = briefFor(cmdName, text, st, LIMS);
    const level = levelFor(cmdName, text, st);
    let slotOk = false;
    try { await putReport({ sessionID: sid, text, at, brief, level }); slotOk = true; } catch { /* 写槽失败降级 */ }
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
  const fsIo = {
    mkdir: (p: string) => mkdir(p, { recursive: true }),
    readFile: (p: string) => fsReadFile(p, "utf8"),
    writeFile: (p: string, c: string) => fsWriteFile(p, c, "utf8"),
  };

  // ── M16-r43：动态档位跟随 ──────────────────────────────────────────────
  // 流转/intake 成功后：读会话所选模型（Session.Info.model = Model.Ref）+ 该模型可用 variants
  // （ctx.model.list，形状未实证 → fail-soft 空集），按 TIER_MAP（options.tiers 覆盖）派生各角色
  // 项目级 agent 文件（.opencode/agents/wf/<role>.md）。基座变化 → 审计 tier-model-switch +
  // 清空 roleSessions（旧子会话=旧模型，防混模型续用）+ 返回提示句（guarded 附加到返回文本）。
  // fail-open：任何异常由调用方吞掉，不阻断流转；options.tierAgents 默认关（opt-in）。
  const tierCheck = async (cmd: string, a: any): Promise<string> => {
    if (ctx?.options?.tierAgents !== true) return "";
    if (!TIER_TRIGGERS.has(cmd)) return "";
    const sid = String(a?.sessionID ?? "");
    const st = await load(sid);
    if (!st || !st.slug) return ""; // 无活动任务（含 reset 后）→ 整段跳过
    const sess = await ctx.session.get({ sessionID: sid }).catch(() => null);
    const ref = sess?.model as ModelRef | undefined;
    if (!ref?.id || !ref?.providerID) return "";
    let variantIds: string[] = [];
    try {
      const ml = await ctx.model?.list?.();
      const arr: any[] = Array.isArray(ml) ? ml : (ml?.data ?? ml?.models ?? []);
      const hit = arr.find((m: any) => m?.id === ref.id && m?.providerID === ref.providerID)
        ?? arr.find((m: any) => m?.id === ref.id);
      variantIds = (hit?.variants ?? []).map((v: any) => v?.id).filter(Boolean);
    } catch { /* 空集 → resolveTierRef 返回 null → 跳写 */ }
    const tiers = { ...TIER_MAP, ...ctx?.options?.tiers };
    const dir = await resolveProjectDir(st, sid);
    const rows = await syncTierAgents(dir, ref, variantIds, tiers, fsIo);
    const at = new Date().toISOString();
    const notes: string[] = [];
    // 切模型检测：基座变化 → 审计 + 清空 roleSessions（仅首次登记 tier-init，不清会话）
    const prev = st.tierBase;
    if (!prev || prev.providerID !== ref.providerID || prev.id !== ref.id) {
      st.tierBase = { providerID: ref.providerID, id: ref.id, variant: ref.variant, at };
      const baseKey = `${ref.providerID}/${ref.id}`;
      if (prev) {
        st.roleSessions = {};
        notes.push(`🧠 档位跟随：基座模型切换为 ${baseKey}，流程角色项目级档位已重写；旧子会话为旧模型（${prev.providerID}/${prev.id}），重委派一律新建——勿凭记忆续接旧 sessionID。`);
      }
      notes.push(`__AUDIT__tier-model-switch:${baseKey}${prev ? `（原 ${prev.providerID}/${prev.id}）` : ""}`);
    }
    const actions = rows.filter((r) => !r.startsWith("tier-keep"));
    if (actions.length) notes.push(`__AUDIT__${actions.join(" ")}`);
    if (notes.length) {
      for (const n of notes) {
        if (n.startsWith("__AUDIT__")) logAdd(st, { at, cmd, from: st.phase, to: st.phase, ok: true, note: n.slice(9) });
      }
      await save(st);
    }
    return notes.filter((n) => !n.startsWith("__AUDIT__")).join("\n");
  };

  if (runner) {
    runner.run = async (name: string, a: any) => {
      const base = byName[name];
      if (!base) {
        // 未知命令不发布（与旧行为一致），但返回体四字段齐备：❌ 前缀不变量 → levelFor=warn，
        // brief 走 fallback 纯函数（与 publishOutput 同源判定，TUI 无需特判）
        const t = `❌ 未知命令：${name}`;
        return { text: t, at: "", brief: briefFallback(name, t), level: levelFor(name, t, null) };
      }
      const out = await base(a);
      const text = typeof out === "string" ? out : "";
      const at = new Date().toISOString();
      // T03（plan §4）：publish 结果透传；无 text 不发布 → 缺省 brief="" level="info"
      const meta = text ? await publishOutput(String(a?.sessionID ?? ""), text, at, name) : { brief: "", level: "info" as ReportLevel };
      return { text, at, ...meta };
    };
  }

  const reg = ctx.command.transform((editor: any) => {
    // server 命令通道 = 降级轨：publish（reports 表，TUI 轮询兜底可见）+ inject（Web/Desktop 聊天可见）。
    // 返回值保留（tests 行为锚；宿主不消费）。
    const add = (def: any) => {
      const base = def.execute;
      // M16-r36：单一强制点——聊天命令/wf_command/TUI exec 三入口同调 byName，guarded 一处覆盖。
      // 变更类仅 leader（workflow，兼容 wf/leader；agent 经 a.agent ?? session.get 解析）；拒绝落审计 agent-rejected（有行才落盘，守 T02）。
      const guarded = async (a: any) => {
        if (ctx?.options?.leaderOnly !== false) {
          const agent = await resolveAgent(a, ctx.session.get);
          await probeOnce(a?.sessionID, "cmd-agent-probe", { cmd: def.name, aKeys: Object.keys(a ?? {}), agent });
          // F1（implant×build 卡死 1.5 天实证）：load 上提至拒绝判定前——会话持任务时拒绝文案给
          // 「切回 workflow 重跑 / reset 清账」两个准确出口（旧文案误导开新会话接管）。
          // load fail→null→旧文案分支（fail-open）；审计复用同一快照（best-effort 语义不变）。
          let rejSt: WfState | null = null;
          try { rejSt = await load(String(a?.sessionID ?? "")); } catch { rejSt = null; }
          const rej = leaderOnlyReject(agent, def.name, rejSt);
          if (rej) {
            try {
              if (rejSt && (rejSt.slug || rejSt.phase)) {
                logAdd(rejSt, { at: new Date().toISOString(), cmd: def.name, from: rejSt.phase, to: rejSt.phase, ok: false, note: `agent-rejected:${agent || "(unknown)"}` });
                await save(rejSt);
              }
            } catch { /* 审计 best-effort，不影响拒绝 */ }
            return rej;
          }
        }
        const out = await base(a);
        // M16-r43：动态档位跟随——流转/intake 成功后校验会话基座模型并同步项目级档位文件。
        // fail-open：任何异常不阻断流转（与 r29 告警不阻断同模式）；options.tierAgents 默认关。
        try {
          const note = await tierCheck(def.name, a);
          if (note && typeof out === "string") return `${out}\n${note}`;
        } catch { /* fail-open（审计在 tierCheck 内部 best-effort） */ }
        return out;
      };
      byName[def.name] = guarded;
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
          let tierLine = "";
          // M16-r43：档位跟随生效视图——读项目级派生文件（/api/agent 序列化不含 model，读文件为准）
          try {
            const sid = String(a?.sessionID ?? "");
            const st = await load(sid);
            const dir = await resolveProjectDir(st, sid);
            const rows = await readTierAgents(dir, TIER_ROLES, { readFile: (p: string) => fsReadFile(p, "utf8") });
            if (rows.length) tierLine = `\n档位跟随（tierAgents，Session 基座派生）：${rows.join(" ")}`;
          } catch { /* 无任务/无文件 → 不展示 */ }
          return pingReport(res) + roleGuardText(ctx?.options) + tierLine;
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
            if (typeof ctx?.session?.get === "function") {
              const sess = await ctx.session.get({ sessionID: sid }).catch(() => null);
              if (!sess) return `❌ 子会话不存在：「${sid}」（截断/已清库——经 session-lookup 管道重取，或 @别名续接）；lane 未变更。`;
            }
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
        try { await E.remove({ sessionID: a.sessionID, key: ENTRY_KEY }); } catch { }
        try { await E.remove({ sessionID: a.sessionID, key: HINT_KEY }); } catch { }
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
        if (!E?.list) entries = "no entry API";
        else {
          try { entries = await E.list({ sessionID: a.sessionID }); }
          catch (e1) {
            try { entries = await E.list({ sessionID: a.sessionID, key: ENTRY_KEY }); }
            catch (e2) { entries = `ERR1:${(e1 as Error)?.message ?? e1} | ERR2:${(e2 as Error)?.message ?? e2}`; }
          }
        }
        // M16-r39 T09：sessProbe 收敛——5 candidates 形状探测已完成历史使命（扁平形状真机实证），
        // 改单一扁平 ctx.session.get({sessionID})；state.json 键名 sessProbe 不变
        let sessProbe = null;
        try {
          const r = await ctx.session.get({ sessionID: a.sessionID });
          sessProbe = { ok: true, topKeys: Object.keys(r ?? {}), location: r?.data?.location ?? r?.location ?? null };
        } catch (e) {
          sessProbe = { ok: false, err: String((e as Error)?.message ?? e).slice(0, 140) };
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