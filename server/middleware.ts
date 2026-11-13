// wf-workflow — R2 T2.5（arch-r2-profile-statemachine）：命令中间件链。
// 旧 commands.ts add() 内联 guarded（leader 硬闸 → base → tierCheck 附加）拆为显式组合：
// 顺序唯一来源 CMD_MW_ORDER（数组声明 + tests/middleware.test.js 断言锁死，翻转=红）。
// 各段函数体逐字节迁移（F1 load 上提/agent-rejected 审计/T02 有前行才落盘/tier fail-open——
// 全部原语义）；swallow code 按守卫口径改文件基名前缀（middleware:*；swallow-coverage 锁）。
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { leaderOnlyReject, type WfState } from "./lib.ts";
import { logAdd, type Store } from "./state.ts";
import { type Observer, swallow } from "./observe.ts";
import { type Host } from "./host.ts";
import {
  TIER_MAP, TIER_TRIGGERS, syncTierAgents, type ModelRef,
} from "./model-tier.ts";

// tierCheck 派生文件 IO（自 commands.ts fsIo 逐字节迁移）
const fsIo = {
  mkdir: (p: string) => mkdir(p, { recursive: true }),
  readFile: (p: string) => fsReadFile(p, "utf8"),
  writeFile: (p: string, c: string) => fsWriteFile(p, c, "utf8"),
};

// M16-r36：agent 解析——快路径 a.agent（聊天命令若携带）→ session.get 兜底（Session.Info.agent 实证）。
// sessionGet 注入以便单测；解析失败返回 ""（变更类 fail-closed 由 leaderOnlyReject 裁决）。
const resolveAgent = async (a: any, sessionGet: (q: { sessionID: string }) => Promise<any>): Promise<string> => {
  const direct = String(a?.agent ?? "");
  if (direct) return direct;
  try { return String((await sessionGet({ sessionID: String(a?.sessionID ?? "") }))?.agent ?? ""); } catch { return ""; }
};

export type CommandHandler = (a: any) => Promise<unknown>;
export type CommandMiddleware = (next: CommandHandler) => CommandHandler;

// 组合顺序（数组头=最外层）。语义锚：leaderGate 外层=拒绝时 base/tierSync 均不执行
//（含审计落盘后短路 return rej）；tierSync 内层=base 成功后附加 note，fail-open 吞异常。
export const CMD_MW_ORDER = ["leaderGate", "tierSync"] as const;

export function composeMW(mws: CommandMiddleware[], base: CommandHandler): CommandHandler {
  return mws.reduceRight((next, mw) => mw(next), base);
}

export interface GuardDeps {
  host: Host;
  load: Store["load"];
  save: Store["save"];
  probeOnce: Observer["probeOnce"];
  resolveProjectDir: Store["resolveProjectDir"];
}

export function createCommandGuard(deps: GuardDeps) {
  const { host, load, save, probeOnce, resolveProjectDir } = deps;

  // ── M16-r43：动态档位跟随 ──────────────────────────────────────────────
  // 流转/intake 成功后：读会话所选模型（Session.Info.model = Model.Ref）+ 该模型可用 variants
  // （host.models.list，形状未实证 → fail-soft 空集），按 TIER_MAP（options.tiers 覆盖）派生各角色
  // 项目级 agent 文件（.opencode/agents/wf/<role>.md）。基座变化 → 审计 tier-model-switch +
  // 清空 roleSessions（旧子会话=旧模型，防混模型续用）+ 返回提示句（guarded 附加到返回文本）。
  // fail-open：任何异常由调用方吞掉，不阻断流转；options.tierAgents 默认关（opt-in）。
  const tierCheck = async (cmd: string, a: any): Promise<string> => {
    if (host.options.tierAgents !== true) return "";
    if (!TIER_TRIGGERS.has(cmd)) return "";
    const sid = String(a?.sessionID ?? "");
    const st = await load(sid);
    if (!st || !st.slug) return ""; // 无活动任务（含 reset 后）→ 整段跳过
    const sess = await host.sessions.get({ sessionID: sid }).catch(() => null);
    const ref = sess?.model as ModelRef | undefined;
    if (!ref?.id || !ref?.providerID) return "";
    let variantIds: string[] = [];
    try {
      const ml = await host.models.list();
      const arr: any[] = Array.isArray(ml) ? ml : (ml?.data ?? ml?.models ?? []);
      const hit = arr.find((m: any) => m?.id === ref.id && m?.providerID === ref.providerID)
        ?? arr.find((m: any) => m?.id === ref.id);
      variantIds = (hit?.variants ?? []).map((v: any) => v?.id).filter(Boolean);
    } catch (e) { swallow(e, "middleware:model-list-variants-fail"); }
    const tiers = { ...TIER_MAP, ...host.options.tiers };
    const dir = await resolveProjectDir(st, sid);
    const rows = await syncTierAgents(dir, ref, variantIds, tiers, fsIo);
    const at = new Date().toISOString();
    const notes: string[] = [];
    // 切模型检测：基座变化 → 审计 + 清空 roleSessions（仅首次登记 tier-init，不清会话）
    const prev = st.reuse?.tierBase; // R3 T3.1 子步 C
    if (!prev || prev.providerID !== ref.providerID || prev.id !== ref.id) {
      st.reuse = { ...st.reuse, tierBase: { providerID: ref.providerID, id: ref.id, variant: ref.variant, at } };
      const baseKey = `${ref.providerID}/${ref.id}`;
      if (prev) {
        st.reuse = { ...st.reuse, roleSessions: {} };
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

  // M16-r36：单一强制点——聊天命令/wf_command/TUI exec 三入口同调 bus，guarded 一处覆盖。
  // 变更类仅 leader（workflow，兼容 wf/leader；agent 经 a.agent ?? session.get 解析）；
  // 拒绝落审计 agent-rejected（有行才落盘，守 T02）。
  const leaderGate = (name: string): CommandMiddleware => (next) => async (a: any) => {
    if (host.options.leaderOnly !== false) {
      const agent = await resolveAgent(a, (q: { sessionID: string }) => host.sessions.get(q));
      await probeOnce(a?.sessionID, "cmd-agent-probe", { cmd: name, aKeys: Object.keys(a ?? {}), agent });
      // F1（implant×build 卡死 1.5 天实证）：load 上提至拒绝判定前——会话持任务时拒绝文案给
      // 「切回 workflow 重跑 / reset 清账」两个准确出口（旧文案误导开新会话接管）。
      // load fail→null→旧文案分支（fail-open）；审计复用同一快照（best-effort 语义不变）。
      let rejSt: WfState | null = null;
      try { rejSt = await load(String(a?.sessionID ?? "")); } catch { rejSt = null; }
      const rej = leaderOnlyReject(agent, name, rejSt);
      if (rej) {
        try {
          if (rejSt && (rejSt.slug || rejSt.phase)) {
            logAdd(rejSt, { at: new Date().toISOString(), cmd: name, from: rejSt.phase, to: rejSt.phase, ok: false, note: `agent-rejected:${agent || "(unknown)"}` });
            await save(rejSt);
          }
        } catch (e) { swallow(e, "middleware:agent-reject-audit-fail"); }
        return rej;
      }
    }
    return next(a);
  };

  const tierSync = (name: string): CommandMiddleware => (next) => async (a: any) => {
    const out = await next(a);
    // M16-r43：动态档位跟随——流转/intake 成功后校验会话基座模型并同步项目级档位文件。
    // fail-open：任何异常不阻断流转（与 r29 告警不阻断同模式）；options.tierAgents 默认关。
    try {
      const note = await tierCheck(name, a);
      if (note && typeof out === "string") return `${out}\n${note}`;
    } catch (e) { swallow(e, "middleware:tier-check-fail"); }
    return out;
  };

  const MW_IMPL: Record<(typeof CMD_MW_ORDER)[number], (name: string) => CommandMiddleware> = { leaderGate, tierSync };

  // 组合：guard(name)(base) —— 按 CMD_MW_ORDER 顺序，头=最外层
  const guard = (name: string) => (base: CommandHandler): CommandHandler =>
    composeMW(CMD_MW_ORDER.map((k) => MW_IMPL[k](name)), base);

  return { guard, tierCheck };
}
