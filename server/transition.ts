// wf-workflow — R2 T2.4（arch-r2-profile-statemachine）：状态机推进编排，自 commands.ts 逐字节提取。
// createTransition(deps) 返回旧 transition 闭包本体（load→校验→应用→inject→save 循环 ≤3 次、
// structuredClone T09 语义、拒绝审计、计时闭账、done-git 检测、selfmod 告警——全部原样）。
// deps 显式注入（host/load/save/resolveProjectDir/LIMS/emitUpdated），commands.ts 不再持本段实现。
// listOverrides/selfModRootFor/realDir/detectDoneGit/PLUGIN_REPO_ROOT 亦随迁（消费面仅此文件）。
import * as fs from "node:fs";
import { join } from "node:path";
import { evaluateTransition, flowFor, isSelfModDir, selfModWarnLine, makeInitialWfState, type WfState } from "./lib.ts";
import { guidance, entryValue } from "./guidance.ts";
import { FOLD } from "../shared/phases.ts"; // tui-sidebar-elapsed T01：闭账 key 折叠（reconcile→building、retrospect→done）
import { ENTRY_KEY, logAdd, withStateRetry, scanActiveTasks, type Store } from "./state.ts";
import { swallow } from "./observe.ts";
import { type Host } from "./host.ts";

// selfmod-guard T01：插件仓库根=本模块上级目录（bun 直跑 TS，import.meta.dirname 实证可用，roles.ts 同源）；
// 解析失败 → ""，isSelfModDir 恒 false（fail-open：判不出=不告警，宁缺勿滥）。
const PLUGIN_REPO_ROOT = (() => {
  try { return fs.realpathSync(join(import.meta.dirname, "..")); } catch { return ""; }
})();
// 生效探测根：options.selfModRoot 覆盖（测试/特殊安装布局）> 模块仓库根。运行时活读 options
// （T03：调用方传 host.options——与 leaderOnly 同模式，setup 期捕获会丢失测试与热载后的选项变更）。
const selfModRootFor = (opt: Record<string, any>): string => {
  const o = opt?.selfModRoot;
  if (typeof o === "string" && o) { try { return fs.realpathSync(o); } catch { return o; } }
  return PLUGIN_REPO_ROOT;
};
// 任务目录归一（realpath 失败回退原值——软链/inode 差异不得使自改漏判为假阴性的反例已由
// isSelfModDir 的 fail-open 语义兜住：判不出=不告警）
const realDir = (d: unknown): string => { try { return fs.realpathSync(String(d ?? "")); } catch { return String(d ?? ""); } };

// P3：项目级角色定制——.workflow/overrides/<role>.md 存在则带入 guidance（leader 委派时全文附上）
const listOverrides = (dir: string) => {
  try { return fs.readdirSync(`${dir}/.workflow/overrides`).filter((f: string) => f.endsWith(".md")); } catch { return []; }
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

export interface TransitionDeps {
  host: Host;
  load: Store["load"];
  save: Store["save"];
  resolveProjectDir: Store["resolveProjectDir"];
  LIMS: Record<string, number>;
  emitUpdated: (st: WfState) => Promise<void>;
}

export function createTransition(deps: TransitionDeps) {
  const { host, load, save, resolveProjectDir, LIMS, emitUpdated } = deps;

  const inject = async (st: WfState) => {
    try {
      // P1：值 = 头行 + 完整阶段 guidance。entry 每次组装系统提示从存储重新渲染，
      // 故消息历史被 compaction 压缩后阶段约束仍在线（等价 superpowers post-compaction 重注入）
      const ov = st.directory ? listOverrides(st.directory) : [];
      await host.instructions.put({ sessionID: st.sessionID as string, key: ENTRY_KEY, value: entryValue(st, LIMS, ov) });
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
        // R2 T2.4：无前行默认行 → makeInitialWfState（字段形状与旧字面逐字节同源，types.ts 单一来源）
        return loaded ? structuredClone(loaded) : makeInitialWfState(sessionID);
      },
      apply: async (st) => {
        from = st.phase ?? null;
        const at = new Date().toISOString();
        // M16-r29：强制重置前产物记账快照（供中途 !intake 重置后的账实不符告警）
        preArtifacts = cmd === "wf:intake" ? Object.keys(st.artifacts ?? {}) : [];

        // P0-b：来源合法性 / gate / 计数上限 / intake 守卫与重置 → lib.evaluateTransition（拒绝不消耗循环额度）
        const r = evaluateTransition(cmd, st, text, at, LIMS);
        if (!r.ok) {
          // R2 T2.3：gate 拒绝时 log note 细化 `gate-rejected:<id>`（审计/诊断面；r.note 本体逐字不变）
          logAdd(st, { at, cmd, from, to: from, ok: false, note: r.gate ? `${r.note}:${r.gate}` : r.note });
          if (lastLoaded) { try { await save(st); } catch (e) { swallow(e, "transition:reject-audit-save-fail"); } } // T02：无前行不落盘
          return r.msg; // halt：不重试
        }

        // M16-r34：mode 选择流转表（daily 子表 vs full）；evaluateTransition 已放行 → flow 必存在
        const flow = flowFor(st, cmd)!;
        st.phase = flow.to;
        st.updatedAt = at;
        // tui-sidebar-elapsed T01（plan §3.2 冻结）：墙钟计时记账——离开阶段闭账（FOLD 折叠 key，
        // 多轮 revisit 累计）；重置块已置 phaseEnteredAt=at 时闭账跳过（d 恒 0，不污染空账）。
        // fromKey 置于 if 内：strict 下 from 经守卫收窄为 string（语义与冻结式逐字一致，仅作用域收窄）
        // R3 T3.1 子步 A：读写改走 st.timing.*（normalize 后内存恒新形；存量无 timing → 闭账/冻结全跳过，语义不变）
        if (from && st.timing?.phaseEnteredAt && st.timing.phaseEnteredAt !== at) {
          const fromKey = FOLD[from] ?? from;
          const d = Math.max(0, Math.round((Date.parse(at) - Date.parse(st.timing.phaseEnteredAt)) / 1000));
          st.timing.phaseDurations = { ...st.timing.phaseDurations, [fromKey]: (st.timing.phaseDurations?.[fromKey] ?? 0) + d };
        }
        (st.timing ??= {}).phaseEnteredAt = at;
        if (flow.to === "done" && st.timing?.startedAt && !st.timing.finishedAt) st.timing.finishedAt = at;
        // 存量（无 startedAt）推 done 不置 finishedAt（总耗时保持 null 降级 ·）
        // M10-b：一次性补全 projectID/directory（供索引与子会话落盘定位）
        if (!st.projectID) {
          try {
            const s = await host.sessions.get({ sessionID });
            st.projectID = s?.projectID ?? null;
            st.directory = s?.location?.directory ?? null;
          } catch (e) { swallow(e, "transition:session-project-fill-fail"); }
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
          } catch (e) { swallow(e, "transition:done-git-detect-fail"); }
        }
        logAdd(st, { at, cmd, from, to: flow.to, ok: true, rounds: { ...st.rounds } });
        // selfmod-guard T01（F2 v2）：intake 引擎自改检测（fail-open=判不出按非自改）——任务目录=插件仓库根
        // → st.selfMod 记账（building guidance 纪律行走 entry 通道，抗 compaction）+ 跨库扫描其它活动任务
        // （scanActiveTasks：内存∪持久清单，休眠任务亦现形——v1 内存注册表盲区实证）。
        // 告警行在 transition 末尾 save 成功后追加，非拒绝=⚠️ 前缀。
        if (cmd === "wf:intake") {
          try {
            const dir = realDir(st.directory ?? (await resolveProjectDir(st, sessionID)));
            if (isSelfModDir(dir, selfModRootFor(host.options))) {
              st.selfMod = true;
              selfModNote = selfModWarnLine(scanActiveTasks(sessionID));
            } else delete st.selfMod;
          } catch (e) { swallow(e, "transition:selfmod-detect-fail"); }
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
      else { try { await host.instructions.remove({ sessionID, key: ENTRY_KEY }); } catch (e) { swallow(e, "transition:entry-remove-fail"); } } // 新建会话建行失败：无行则清指引
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

  return { transition, inject };
}
