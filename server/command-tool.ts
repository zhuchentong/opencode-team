// wf-workflow — T05：模型侧状态机入口（wf_command 工具）。
// 背景：/wf:* 原本只有用户入口（TUI 拦截 / 聊天命令），guidance 里「完成 → 执行 /wf:plan」
// 对 leader 是祈使句却无法执行 → 状态机停摆、硬关卡与循环上限被整体绕过（面板"不同步"根因）。
// 本工具让 leader 用同等语义推进：经 runner.run 复用双轨主轨编排（transition + inject + save +
// emitUpdated + publishOutput），用户侧照常看到 toast——双入口、单状态机、关卡服务端强制。
// 硬边界（以"会话是否自持状态行"判定属主）：
//  - 有行 → 全部命令放行（含 status/diagnose 等辅助命令）；
//  - 无行 → 仅 wf:intake 可开任务，且限主会话；
//  - 无行非 intake → 拒绝（子会话不得代 leader 推进）。
// 子会话判定（真机 sessProbe 实证 2026-11-10：2.2.6 session.get 返回无 parentID、有 agent）：
// agent 以 wf/ 开头且非 leader = 子代理会话（M16-r38：leader=workflow，兼容 wf/leader）。
import { FLOWS, isLeader } from "./lib.ts";

const FLOW_NAMES = Object.keys(FLOWS); // 10 个流转命令（wf:intake…wf:done；M16-r28 assign 并入 test-design）

export function registerCommandTool(ctx: any, deps: any) {
  const { load, runner, probeOnce } = deps;
  return ctx.tool.transform((draft: any) => {
    draft.add({
      name: "wf_command",
      description:
        "推进 wf 工作流状态机（等价用户手敲 /wf:*，**服务端强制仅 leader（workflow）**：非 leader agent 调用将被拒绝；wf/* 子会话调用会被拒绝）。" +
        "冷启动铁律（仅 leader 主会话）：本会话无活动任务且用户给出开发任务时，第一步立即调用 wf_command(name=\"wf:intake\", prompt=\"<slug>\") 开任务（slug 从需求提炼，kebab-case），勿等用户手敲 /wf:intake；需求不足以提炼 slug 时先澄清再 intake；普通问答/咨询不开任务。" +
        "name 形如 \"wf:plan\"；prompt = 命令参数（wf:intake 传 slug，wf:lane 传 \"set T01 ses_xxx\"，其余留空）。" +
        "返回该阶段 guidance / 命令输出文本。关卡与循环上限由服务端强制。",
      input: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "命令名（不含前导斜杠）：wf:intake|wf:plan|wf:review|wf:test-design|wf:build|wf:reconcile|wf:review-build|wf:test|wf:fix|wf:done|wf:status|wf:diagnose|wf:ping|wf:lane|wf:reset",
          },
          prompt: { type: "string", description: "命令参数文本（可空）" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: async (args: any, context: any) => {
        try {
          await probeOnce(context?.sessionID, "cmdtool-probe", {
            argsKeys: Object.keys(args ?? {}), contextKeys: Object.keys(context ?? {}),
          });
          const sid = String(context?.sessionID ?? "");
          if (!sid) return { content: "❌ wf_command：无法确定会话" };
          const name = String(args?.name ?? "").trim().replace(/^\//, "");
          if (!/^wf:[a-z][a-z-]*$/.test(name)) return { content: `❌ name 应形如 "wf:plan"（收到：${args?.name ?? ""}）` };
          const st = await load(sid);
          if (!st || (!st.slug && !st.phase)) { // T03 同语义：幽灵行视同无任务
            if (name === "wf:ping") {
              // T11：只读放行——wf:ping 不触碰状态，子会话可自查角色注册
            } else if (name !== "wf:intake") {
              return { content: `❌ 本会话无活动任务${FLOW_NAMES.includes(name) ? "且不得跨任务推进" : ""}：流转需先由 leader 在主会话调用 wf_command(name="wf:intake", prompt="<slug>") 开任务（或用户手敲 /wf:intake <slug>）。子会话请把结论回报 leader，不得代为推进；查看状态（status/diagnose）请在 leader 主会话执行。` };
            } else {
              const agent = String(context?.agent ?? "");
              if (agent.startsWith("wf/") && !isLeader(agent)) {
                return { content: `❌ 子会话（agent=${agent}）不得开新任务/推进状态机。请把结论回报 leader，由 leader 调用 wf_command。` };
              }
            }
          }
          const res: any = await runner?.run?.(name, { sessionID: sid, prompt: { text: String(args?.prompt ?? "") } });
          const text = typeof res?.text === "string" ? res.text : "";
          return { content: text || `❌ 未知命令：${name}` };
        } catch (e) {
          return { content: `❌ wf_command 失败：${(e as Error)?.message ?? e}` };
        }
      },
    });
  });
}
