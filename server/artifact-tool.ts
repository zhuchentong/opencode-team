// wf-workflow — wf_write_artifact 工具（M3，自 index.ts 原样搬移）：kind → .workflow/<slug>/ 文件名，
// 落盘并记入 state.artifacts；test-plan/test-report 同步关卡记账（testPlanWritten/testReportVerdict）；
// 子会话经 resolveState 反查管辖状态（M10-b）。
// 已验证 API（实测 2026-11-09）：工具注册 draft.add({name, description, input:<JSONSchema>,
// options:{codemode:false}, execute: async (args, context) => ({ content }) })；实测 context 仅
// {sessionID, agent, messageID, id, progress, signal}——**无 directory**！项目目录须经
// ctx.session.get(sessionID).location.directory 取（封装于 state.resolveProjectDir）。
// P4 公告（goopspec blocked-append）：test-report 落盘后按 verdict 在工具输出里指路
// （PASS→/wf:done、FAIL→/wf:fix 后重跑 /wf:test）——agent 在 tool output 即可看到下一步。
import * as fs from "node:fs";
import { VERSION, KIND_FILES, parseVerdict, hasStrictVerdictLine, artifactPhaseWarning, artifactSizeWarning, isDaily, trackRoleSession, type WfState } from "./lib.ts";
import { logAdd, withStateRetry, type Store } from "./state.ts";
import { type Observer } from "./observe.ts";

// M16-r39 T06：deps 类型化（ArtifactDeps 契约；宿主入参 ctx 保留 any）
export interface ArtifactDeps {
  resolveState: Store["resolveState"];
  resolveProjectDir: Store["resolveProjectDir"];
  save: Store["save"];
  emitUpdated: (st: WfState) => Promise<void>;
  probeOnce: Observer["probeOnce"];
  logToolsOnce: Observer["logToolsOnce"];
}

export function registerArtifactTool(ctx: any, deps: ArtifactDeps) {
  const { resolveState, resolveProjectDir, save, emitUpdated, probeOnce, logToolsOnce } = deps;
  return ctx.tool.transform((draft: any) => {
    const namesPromise = Promise.resolve(draft.list?.()).catch(() => null);
    draft.add({
      name: "wf_write_artifact",
      description:
        "把 wf 工作流产物写入 <项目>/.workflow/<slug>/。kind 决定文件名：" +
        Object.keys(KIND_FILES).join(" | ") +
        "。循环类产物（plan-review/build-review）自动按当前轮次编号。" +
        "首写用 content（完整内容）；修订已有产物用 patch=[{old,new}]（精确唯一匹配、顺序应用，只输出变更段，勿全量重写）——content 与 patch 二选一。",
      input: {
        type: "object",
        properties: {
          kind: { type: "string", enum: Object.keys(KIND_FILES), description: "产物类型" },
          content: { type: "string", description: "完整文件内容（首写用；与 patch 二选一）" },
          patch: {
            type: "array",
            description: "增量修订（修订已有产物用；与 content 二选一）：old 逐字摘录原文、唯一匹配，按序应用",
            items: {
              type: "object",
              properties: {
                old: { type: "string", description: "原文中待替换的片段（逐字摘录，须唯一）" },
                new: { type: "string", description: "替换后的内容" },
              },
              required: ["old", "new"],
            },
          },
        },
        required: ["kind"],
      },
      options: { codemode: false },
      execute: async (args: any, context: any) => {
        try {
          await probeOnce(context?.sessionID, "tool-probe", {
            argsKeys: Object.keys(args ?? {}),
            contextKeys: Object.keys(context ?? {}),
            sessionID: context?.sessionID,
            directory: context?.directory,
          });
          await logToolsOnce(namesPromise, context?.sessionID);
          const kind = String(args?.kind ?? "");
          const mk = KIND_FILES[kind];
          if (!mk) return { content: `❌ 未知 kind=${kind}（可用：${Object.keys(KIND_FILES).join(" | ")}）` };
          // M16-r33 P1a：content（首写）与 patch（增量修订）二选一
          const hasContent = typeof args?.content === "string";
          const patch = Array.isArray(args?.patch) ? args.patch : null;
          if (hasContent && patch) return { content: "❌ content 与 patch 互斥：首写用 content，修订已有产物用 patch。" };
          if (!hasContent && !patch) return { content: "❌ 须提供 content（首写完整内容）或 patch（增量修订 [{old,new}]）之一。" };
          const initial = await resolveState(context?.sessionID, context?.agent); // M10-b：子会话经项目索引反查管辖状态
          if (!initial?.slug) return { content: "❌ 本会话无活动 wf 任务：请回报 leader，由 leader 调用 wf_command(name=\"wf:intake\", prompt=\"<slug>\") 开任务（或用户手敲 /wf:intake <slug>）。子会话不得自行推进。" };
          // 落盘目录：三级回退（resolveProjectDir，与 wf:diagnose 同源）
          const dir = await resolveProjectDir(initial, context?.sessionID);
          const file = mk(initial); // 文件名按首快照轮次定型；并发重放不改名（文件已落盘，记账与磁盘必须同名）
          const target = `${dir}/.workflow/${initial.slug}/${file}`;
          fs.mkdirSync(`${dir}/.workflow/${initial.slug}`, { recursive: true });
          // M16-r33 P1a：patch 模式——读磁盘原文，顺序应用（每条 old 对当前内容唯一精确匹配）；
          // 未命中/歧义/目标不存在 → 报错不落盘。修订只输出变更段，省全量重写的生成耗时。
          let finalContent: string;
          let mode: "write" | "patch";
          if (patch) {
            if (!fs.existsSync(target)) return { content: `❌ patch 目标不存在：${target}（首写必须用 content）。` };
            let cur = fs.readFileSync(target, "utf8");
            for (let i = 0; i < patch.length; i++) {
              const old = String(patch[i]?.old ?? "");
              const nw = String(patch[i]?.new ?? "");
              if (old === nw) continue; // 幂等跳过
              if (!old) return { content: `❌ patch[${i}].old 为空（须逐字摘录原文片段）。` };
              const first = cur.indexOf(old);
              if (first < 0) return { content: `❌ patch[${i}] 未命中：old 须逐字摘录产物原文（修订前先 read 产物），本次未落盘。` };
              if (cur.indexOf(old, first + 1) >= 0) return { content: `❌ patch[${i}] 歧义：old 在产物中出现多次，请补充上下文使其唯一，本次未落盘。` };
              cur = cur.slice(0, first) + nw + cur.slice(first + old.length);
            }
            finalContent = cur;
            mode = "patch";
          } else {
            finalContent = args.content;
            mode = "write";
          }
          fs.writeFileSync(target, finalContent.endsWith("\n") ? finalContent : `${finalContent}\n`);
          const bytes = fs.statSync(target).size;
          // M16-r33：verdict 从**结果全文**解析（patch 模式入参无 content，必须读结果，否则 done 关卡误拦）
          // M16-r34：plan-review 也解析 verdict（日常模式 M/L 独立验证结论，wf:build 关卡校验）
          const verdict = (kind === "test-report" || kind === "plan-review") ? parseVerdict(finalContent) : undefined; // P0-b：解析提取至 lib
          // T04：记账写回带冲突重试——文件已落盘不重写，stale-rev 时仅对最新快照重放记账字段（≤3）
          const mark = (row: WfState) => {
            // M16-r40：角色→子会话自动登记（搭本次记账 save 便车，零额外写盘）——
            // 产物写入者（planner/reviewer/tester/builder-reviewer/learner）在此暴露子会话身份
            trackRoleSession(row, context?.agent, context?.sessionID);
            row.artifacts = row.artifacts ?? {};
            row.artifacts[file] = { at: new Date().toISOString(), bytes };
            if (kind === "test-plan") row.testPlanWritten = true;
            if (kind === "test-report") row.testReportVerdict = verdict;
            if (kind === "plan-review") row.planReviewVerdict = verdict; // M16-r34：日常 M/L 验证关卡记账
            // M16-r39 T02：plan 修订（content/patch、任何 mode）清双通道记账——
            // plan 已改，旧 review 结论与旧 test-plan 不得继续蒙混关卡
            if (kind === "plan") { delete row.planReviewVerdict; delete row.testPlanWritten; }
            logAdd(row, { at: new Date().toISOString(), cmd: "tool:wf_write_artifact", from: row.phase, to: row.phase, ok: true, note: mode === "patch" ? `${file} mode=patch` : file });
          };
          // M16-r39 T07：归一 withStateRetry——mark 移入 apply（每 attempt 恰一次，防审计翻倍）；
          // load(1)=初始 st、load(n)=resolveState 最新快照（无 slug→null=gone，行被并发清除）
          const res = await withStateRetry({
            load: async (attempt) => {
              if (attempt === 1) return initial;
              const fresh = await resolveState(context?.sessionID, context?.agent);
              return fresh?.slug ? fresh : null;
            },
            apply: (row) => { mark(row); return null; },
            save,
          });
          if (!res.ok) {
            if (res.reason === "gone") {
              return { content: `✅ 已写入 ${target}（${bytes} bytes）；⚠️ 状态行已被并发清除（reset？），记账跳过——产物已落盘，重开任务后可用 /wf:diagnose 对账` };
            }
            return { content: `✅ 已写入 ${target}（${bytes} bytes）；❌ 状态记账保存失败（${res.reason}），产物对账不一致（/wf:diagnose 可核对），请重试写入。` };
          }
          const st = res.st;
          await emitUpdated(st);
          let note = `✅ [${VERSION}] 已写入 ${target}（${bytes} bytes）`;
          // M16-r29：阶段纪律——产物错位告警（不阻断，落盘/记账照常）
          const phaseWarn = artifactPhaseWarning(kind, st.phase);
          if (phaseWarn) note += `\n${phaseWarn}`;
          // M16-r32：产物瘦身——超预算告警（不阻断，落盘/记账照常）；M16-r33：按任务体量分级
          const sizeWarn = artifactSizeWarning(kind, bytes, st.size);
          if (sizeWarn) note += `\n${sizeWarn}`;
          if ((kind === "test-report" || kind === "plan-review") && !hasStrictVerdictLine(finalContent)) {
            note += `\n⚠️ ${kind} 首行应含「**结论**: PASS|FAIL」（记为 UNKNOWN 后 ${kind === "test-report" ? "/wf:done" : "日常模式 /wf:build"} 会被关卡拦截）`;
          }
          // P4 公告：verdict 指路（与 GATES["wf:done"] 拒绝文案同语义，agent 在 tool output 直接看到）
          if (kind === "test-report") {
            note += st.testReportVerdict === "PASS"
              ? `\n→ 验收 PASS：请 leader 调用 wf_command(name="wf:done") 推进（验收关卡放行；用户手敲亦可）`
              : `\n→ 验收 ${st.testReportVerdict ?? "UNKNOWN"}：FAIL → 请 leader 推进 /wf:fix 修复后重跑 /wf:test（wf_command 或用户手敲；UNKNOWN 需先补首行「**结论**: PASS|FAIL」）`;
          }
          // M16-r34：plan-review verdict 指路（日常模式 M/L 独立验证 → wf:build 关卡）
          if (kind === "plan-review") {
            note += st.planReviewVerdict === "PASS"
              ? `\n→ 验证 PASS：请 leader 调用 wf_command(name="wf:build") 推进（日常模式验证关卡放行）`
              : `\n→ 验证 ${st.planReviewVerdict ?? "UNKNOWN"}：FAIL → 请 leader 推进 wf:plan 带意见修订后再验（UNKNOWN 需先补首行「**结论**: PASS|FAIL」）`;
          }
          // M16-r39 T02：plan 修订清双通道记账——模式感知的重新验证指路
          if (kind === "plan") {
            note += "\nplan 已修订：review 结论与 test-plan 记账已清，须重新 " + (isDaily(st) ? "wf:review" : "wf:review / wf:test-design");
          }
          return { content: note };
        } catch (e) {
          return { content: `❌ wf_write_artifact 失败：${(e as Error)?.message ?? e}` };
        }
      },
    });
  });
}