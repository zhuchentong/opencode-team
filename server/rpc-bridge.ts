// wf-workflow — RPC 桥（M8-a，自 index.ts 原样搬移）：ctx.rpc.register(Wf)（shared/rpc.ts）
// 暴露 state/list/read 方法供 TUI 侧边栏订阅；流转/产物落盘时 emit("updated") 驱动刷新。
// 注册失败 fail-soft（rpcErr 记录，供 /wf:diagnose 显示；此时尚不含 tui/ 部件，server 侧可独立验证）。
// P1：命令输出槽迁移至 SQLite reports 表（getReport 由 state.ts 注入，ctx.storage 不再参与）。
import * as fs from "node:fs";
import type { ReportLevel } from "./lib.ts";
import { swallow } from "./observe.ts"; // T01：静默 catch → 环形审计记账 // notification-brief-display T03：emitReport meta 类型（纯 type import，无环）
import { readTierAgents, TIER_ROLES } from "./model-tier.ts"; // M16-r49：侧边栏档位视图（派生文件实况单一来源）
import { PAYLOAD_MAX } from "../shared/report.ts"; // 报文截断上限单一来源

export async function createRpcBridge(host: import("./host.ts").Host, { load, scanStates, getReport, bus, resolveProjectDir }: {
  load: (sessionID: string) => Promise<any>;
  scanStates: (projectID?: string | null, directory?: string | null) => Promise<any>;
  getReport: (sessionID: string) => Promise<any>;
  // R2 T2.4：runner 可变盒子→CommandBus（index 装配期创建共享，exec 主轨按名调度；见 command-bus.ts）
  bus: import("./command-bus.ts").CommandBus;
  // M16-r46 批1：产物落盘目录三级回退（与 artifact-tool 同源，state.ts 提供）
  resolveProjectDir: (st: any, sessionID: string) => Promise<string>;
}) {
  let rpcReg = null;
  let rpcErr = null;
  let WfDef = null;
  try {
    // T03：经 host.rpc.register 透传；wrapper 缺失→null=旧 !ctx.rpc?.register 分支（rpcErr 记账逐字，
    // WfDef 仅在注册成功后置位=旧 if 块内赋值时序；impl 块零改动）
    const mod = await import("../shared/rpc.ts");
    const reg = await host.rpc.register(mod.Wf, {
        state: async (input: any) => {
          const st = await load(input?.sessionID);
          // P1 主通道：命令输出写 reports 表，state 输出附带 lastReport 供 TUI 轮询
          let lastReport = null;
          try {
            lastReport = (await getReport(String(input?.sessionID ?? ""))) ?? null;
          } catch (e) { swallow(e, "rpc-bridge:last-report-read-fail"); }
          // T03：active 收紧——幽灵行（无 slug 且无 phase，历史缺陷：拒绝分支对全新会话落盘）
          // 与已 reset 残留行一律报 inactive，让 TUI 走回退列表，不再锁死面板
          if (!st || (!st.slug && !st.phase)) return { sessionID: input?.sessionID ?? null, active: false, lastReport };
          // M16-r49：档位跟随视图——读项目级派生文件实况（role→variant；/api/agent 不含 model，文件为准）。
          // fail-soft：读失败/未派生 → null（TUI 静默不显示）；inactive 分支形状不扩张（rpc-drift 锁死）。
          let tiers: Record<string, string> | null = null;
          try {
            const dir = await resolveProjectDir(st, String(input?.sessionID ?? ""));
            const rows = await readTierAgents(dir, TIER_ROLES, { readFile: (p: string) => fs.promises.readFile(p, "utf8") });
            if (rows.length) {
              tiers = {};
              for (const row of rows) {
                const eq = row.indexOf("=");
                if (eq <= 0) continue;
                const hash = row.indexOf("#", eq);
                tiers[row.slice(0, eq)] = hash >= 0 ? row.slice(hash + 1) : row.slice(eq + 1);
              }
            }
          } catch (e) { swallow(e, "rpc-bridge:tier-read-fail"); }
          return {
            sessionID: st.sessionID,
            active: true,
            slug: st.slug ?? "",
            phase: st.phase ?? null,
            rounds: st.rounds ?? {},
            testPlanWritten: !!st.verdicts?.testPlanWritten, // R3 T3.1 子步 B：投影层吸收形状差，wire 形状不变
            testReportVerdict: st.verdicts?.testReport ?? null,
            // M16-r35：侧边栏模式感知三字段（存量任务为 null → TUI 按 full 旧视图渲染）
            mode: st.mode ?? null,
            size: st.size ?? null,
            planReviewVerdict: st.verdicts?.planReview ?? null,
            planConfirmedAt: st.verdicts?.confirmedAt ?? null, // M16-r44：方案确认记账
            // tui-sidebar-elapsed T02（plan §3.3）：墙钟计时 4 字段（存量任务 null → TUI 降级 ·）
            // R3 T3.1 子步 A：改读 st.timing.*（wire schema 字段名与形状零变化——投影层吸收形状差）
            startedAt: st.timing?.startedAt ?? null,
            phaseEnteredAt: st.timing?.phaseEnteredAt ?? null,
            phaseDurations: st.timing?.phaseDurations ?? null,
            finishedAt: st.timing?.finishedAt ?? null,
            artifacts: st.artifacts ?? {},
            tiers, // M16-r49：档位跟随视图（role→variant；未派生=null）
            updatedAt: st.updatedAt ?? null,
            lastReport,
          };
        },
        list: async (input: any) => ({ sessions: await scanStates(input?.projectID ?? null, input?.directory ?? null) }),
        // M16-r46 批1：产物预览数据通道（见 shared/rpc.ts read 契约注释）。
        // 白名单 = artifacts 记账 key（防路径穿越）；错误走 error 字段不抛错；超 64KB 截断。
        read: async (input: any) => {
          const file = String(input?.file ?? "");
          const sid = String(input?.sessionID ?? "");
          const deny = (error: string) => ({ text: "", bytes: 0, path: "", truncated: false, error });
          try {
            const st = await load(sid);
            if (!st || (!st.slug && !st.phase)) return deny("wf 无活动任务，无产物可读");
            const recorded = Object.keys(st.artifacts ?? {});
            if (!recorded.includes(file)) return deny(`产物未记账（不在产物清单内）：${file || "(空文件名)"}`);
            const dir = await resolveProjectDir(st, sid);
            const path = `${dir}/.workflow/${st.slug}/${file}`;
            let text: string;
            try {
              text = fs.readFileSync(path, "utf8");
            } catch {
              return { ...deny(`产物已记账但文件缺失：${path}`), path };
            }
            const bytes = Buffer.byteLength(text, "utf8");
            const MAX = PAYLOAD_MAX; // shared/report.ts 单一来源（commands wf:open 同源）
            const truncated = bytes > MAX;
            return { text: truncated ? text.slice(0, MAX) : text, bytes, path, truncated };
          } catch (e) {
            return deny(`wf read 失败：${String((e as Error)?.message ?? e)}`);
          }
        },
        // P2 主轨：TUI 本地命令经 exec 拿完整输出文本（methods 返回值通道，2.2.6 实证可用）。
        // 未知命令不抛错（抛错 client 只见 rpc.internal，原因被吞——quota 教训）；返回错误文案。
        exec: async (input: any) => {
          try {
            const res = await bus.call(String(input?.name ?? ""), {
              sessionID: String(input?.sessionID ?? ""),
              prompt: { text: String(input?.prompt ?? "") },
            });
            if (res && typeof res === "object" && typeof (res as any).text === "string") {
              // notification-brief-display T03：透传 bus.call 的 brief/level（字符串才带，缺省 null——
              // 旧 server 版本混跑时 TUI briefOf 走降级轨）
              const r = res as any;
              return {
                text: r.text, at: String(r.at ?? ""),
                brief: typeof r.brief === "string" ? r.brief : null,
                level: typeof r.level === "string" ? r.level : null,
              };
            }
            return { text: `❌ 未知命令：${String(input?.name ?? "")}`, at: "", brief: null, level: null };
          } catch (e) {
            return { text: `❌ 命令执行失败：${String((e as Error)?.message ?? e)}`, at: "", brief: null, level: null };
          }
        },
      });
    if (reg === null) rpcErr = "ctx.rpc 不可用";
    else { WfDef = mod.Wf; rpcReg = reg; }
  } catch (e) {
    rpcErr = String((e as Error)?.message ?? e);
  }

  const emitUpdated = async (st: any) => {
    try {
      await rpcReg?.events?.emit("updated", {
        sessionID: st.sessionID,
        slug: st.slug ?? "",
        phase: st.phase ?? null,
        rounds: st.rounds ?? {},
      });
    } catch (e) { swallow(e, "rpc-bridge:emit-updated-fail"); }
  };

  // 命令输出广播：宿主 execute 返回值不显示给用户（2.2.6 契约 Promise<void>）。
  // P1：主通道 = commands.ts 写 reports 表 + TUI 轮询 state.lastReport；report 事件为补充通道
  // （P0④ 五条件版真机打通投递，TUI 双通道 + sessionID|at 去重）。
  // at 与 reports 表同一时间戳，TUI 跨通道统一去重。fail-soft，同 emitUpdated。
  // 诊断期返回通道形状（供 commands.ts 探针记录）。
  // notification-brief-display T03：meta 可选（commands.publishOutput 携 brief/level）；
  // 载荷恒带两键（缺省 brief:null / level:"info"——required 不变，旧 TUI 按 text 降级）
  const emitReport = async (sessionID: string, text: string, at: string, meta?: { brief?: string; level?: ReportLevel }) => {
    const chan = { hasReg: !!rpcReg, hasEvents: !!rpcReg?.events, hasEmit: !!rpcReg?.events?.emit };
    try {
      await rpcReg?.events?.emit("report", {
        sessionID: String(sessionID ?? ""), text: String(text ?? ""), at,
        brief: meta?.brief ?? null, level: meta?.level ?? "info",
      });
      return { ...chan, emitted: true };
    } catch (e) {
      return { ...chan, emitted: false, err: String((e as Error)?.message ?? e) };
    }
  };

  return { rpcReg, rpcErr, WfDef, emitUpdated, emitReport };
}
