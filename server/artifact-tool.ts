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
import { VERSION, KIND_FILES, parseVerdict, hasStrictVerdictLine, artifactPhaseWarning } from "./lib.ts";
import { logAdd } from "./state.ts";

export function registerArtifactTool(ctx: any, deps: any) {
  const { resolveState, resolveProjectDir, save, emitUpdated, probeOnce, logToolsOnce } = deps;
  return ctx.tool.transform((draft: any) => {
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
          const content = typeof args?.content === "string" ? args.content : String(args?.content ?? "");
          const mk = KIND_FILES[kind];
          if (!mk) return { content: `❌ 未知 kind=${kind}（可用：${Object.keys(KIND_FILES).join(" | ")}）` };
          let st = await resolveState(context?.sessionID, context?.agent); // M10-b：子会话经项目索引反查管辖状态
          if (!st?.slug) return { content: "❌ 本会话无活动 wf 任务：请回报 leader，由 leader 调用 wf_command(name=\"wf:intake\", prompt=\"<slug>\") 开任务（或用户手敲 /wf:intake <slug>）。子会话不得自行推进。" };
          // 落盘目录：三级回退（resolveProjectDir，与 wf:diagnose 同源）
          const dir = await resolveProjectDir(st, context?.sessionID);
          const file = mk(st); // 文件名按首快照轮次定型；并发重放不改名（文件已落盘，记账与磁盘必须同名）
          const target = `${dir}/.workflow/${st.slug}/${file}`;
          fs.mkdirSync(`${dir}/.workflow/${st.slug}`, { recursive: true });
          fs.writeFileSync(target, content.endsWith("\n") ? content : `${content}\n`);
          const bytes = fs.statSync(target).size;
          const verdict = kind === "test-report" ? parseVerdict(content) : undefined; // P0-b：解析提取至 lib
          // T04：记账写回带冲突重试——文件已落盘不重写，stale-rev 时仅对最新快照重放记账字段（≤3）
          const mark = (row: any) => {
            row.artifacts = row.artifacts ?? {};
            row.artifacts[file] = { at: new Date().toISOString(), bytes };
            if (kind === "test-plan") row.testPlanWritten = true;
            if (kind === "test-report") row.testReportVerdict = verdict;
            logAdd(row, { at: new Date().toISOString(), cmd: "tool:wf_write_artifact", from: row.phase, to: row.phase, ok: true, note: file });
          };
          mark(st);
          let saved = await save(st);
          let rowGone = false; // T12：区分「行被并发删除」与「持续 stale-rev」
          for (let attempt = 1; !saved.ok && saved.reason === "stale-rev" && attempt < 3; attempt++) {
            const fresh = await resolveState(context?.sessionID, context?.agent);
            if (!fresh?.slug) { rowGone = true; break; } // 行被并发清除：无从重放
            mark(fresh);
            st = fresh;
            saved = await save(fresh);
          }
          if (!saved.ok) {
            if (rowGone) {
              return { content: `✅ 已写入 ${target}（${bytes} bytes）；⚠️ 状态行已被并发清除（reset？），记账跳过——产物已落盘，重开任务后可用 /wf:diagnose 对账` };
            }
            return { content: `✅ 已写入 ${target}（${bytes} bytes）；❌ 状态记账保存失败（${saved.reason}），产物对账不一致（/wf:diagnose 可核对），请重试写入。` };
          }
          await emitUpdated(st);
          let note = `✅ [${VERSION}] 已写入 ${target}（${bytes} bytes）`;
          // M16-r29：阶段纪律——产物错位告警（不阻断，落盘/记账照常）
          const phaseWarn = artifactPhaseWarning(kind, st.phase);
          if (phaseWarn) note += `\n${phaseWarn}`;
          if (kind === "test-report" && !hasStrictVerdictLine(content)) {
            note += `\n⚠️ test-report 首行应含「**结论**: PASS|FAIL」（记为 UNKNOWN 后 /wf:done 会被关卡拦截）`;
          }
          // P4 公告：verdict 指路（与 GATES["wf:done"] 拒绝文案同语义，agent 在 tool output 直接看到）
          if (kind === "test-report") {
            note += st.testReportVerdict === "PASS"
              ? `\n→ 验收 PASS：请 leader 调用 wf_command(name="wf:done") 推进（验收关卡放行；用户手敲亦可）`
              : `\n→ 验收 ${st.testReportVerdict ?? "UNKNOWN"}：FAIL → 请 leader 推进 /wf:fix 修复后重跑 /wf:test（wf_command 或用户手敲；UNKNOWN 需先补首行「**结论**: PASS|FAIL」）`;
          }
          return { content: note };
        } catch (e) {
          return { content: `❌ wf_write_artifact 失败：${(e as Error)?.message ?? e}` };
        }
      },
    });
  });
}
