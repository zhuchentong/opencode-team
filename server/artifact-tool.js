// wf-workflow — wf_write_artifact 工具（M3，自 index.js 原样搬移）：kind → .workflow/<slug>/ 文件名，
// 落盘并记入 state.artifacts；test-plan/test-report 同步关卡记账（testPlanWritten/testReportVerdict）；
// 子会话经 resolveState 反查管辖状态（M10-b）。
// 已验证 API（实测 2026-11-09）：工具注册 draft.add({name, description, input:<JSONSchema>,
// options:{codemode:false}, execute: async (args, context) => ({ content }) })；实测 context 仅
// {sessionID, agent, messageID, id, progress, signal}——**无 directory**！项目目录须经
// ctx.session.get(sessionID).location.directory 取（封装于 state.resolveProjectDir）。
import * as fs from "node:fs";
import { VERSION, KIND_FILES, parseVerdict, hasStrictVerdictLine } from "./lib.js";
import { logAdd } from "./state.js";

export function registerArtifactTool(ctx, deps) {
  const { resolveState, resolveProjectDir, save, emitUpdated, probeOnce, logToolsOnce } = deps;
  return ctx.tool.transform((draft) => {
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
          // 落盘目录：三级回退（resolveProjectDir，与 wf:diagnose 同源）
          const dir = await resolveProjectDir(st, context?.sessionID);
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
}
