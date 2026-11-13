// wf-workflow — P3：superpowers 式自动激活提示（fail-soft，自 index.ts 原样搬移）。
// 消息观察 API 形状未实证 → 三形态防御式探测收敛于 host.chatMessages（T03 防腐层，host.ts），
// 首次回调落 _debug/chat-probe.json 供真机确认。注册失败/从未触发 = 没有自动激活，不影响任何其他功能。opt.hint === false 整体禁用。
import { isHintWorthy, HINT_ENTRY, promptText, isLeader } from "./lib.ts";
import { HINT_KEY } from "./state.ts";
import { swallow } from "./observe.ts"; // T01：静默 catch → 环形审计记账
import { type Host } from "./host.ts";

// host 为 T03 防腐层（adaptHost(ctx)）；opt 插件 options；deps 由 index.ts 注入。
export function registerHint(host: Host, opt: any, deps: any) {
  const { resolveState, probeOnce, sessionGet } = deps;

  const hinted = new Set(); // 进程内幂等（entry.get 形状未验证，不去重读回）
  const onChatMessage = async (input: any, output: any) => {
    try {
      const sid = input?.sessionID ?? output?.message?.sessionID ?? output?.sessionID;
      if (!sid || hinted.has(sid)) return;
      await probeOnce(sid, "chat-probe", {
        inputKeys: Object.keys(input ?? {}), outputKeys: Object.keys(output ?? {}),
      });
      const parts = output?.parts ?? output?.message?.parts ?? input?.parts;
      const text = (Array.isArray(parts) ? parts.map((p) => p?.text ?? "").join(" ") : "")
        || promptText(output?.text ?? input?.text ?? "");
      if (!isHintWorthy(text)) return;
      if (await resolveState(sid)) return; // 已有工作流状态 → 不打扰
      // M16-r36：工作流仅限 leader——非 leader/不可解析 → 不注入（hint 为可选装饰，fail-closed 不沾染）
      let agent = String(input?.agent ?? output?.agent ?? "");
      if (!agent) { try { agent = String((await sessionGet?.({ sessionID: sid }))?.agent ?? ""); } catch (e) { swallow(e, "hint:agent-resolve-fail"); } }
      if (!isLeader(agent)) return; // M16-r38：workflow 主名 + wf/leader 兼容
      hinted.add(sid);
      await host.instructions.put({ sessionID: sid, key: HINT_KEY, value: HINT_ENTRY });
    } catch (e) { swallow(e, "hint:chat-message-fail"); } // 绝不阻断消息流
  };

  let chatReg = null;
  if (opt.hint !== false) {
    chatReg = host.chatMessages(onChatMessage); // T03：形态探测/失败记账在 adaptHost 内收敛
  }
  return chatReg;
}
