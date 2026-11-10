// wf-workflow — P3：superpowers 式自动激活提示（fail-soft，自 index.js 原样搬移）。
// 本宿主实测确认的仅 ctx.tool.hook；消息观察 API 形状未验证 → 多形态防御式
// 尝试注册，首次回调落 _debug/chat-probe.json 供真机确认。注册失败/从未触发
// = 没有自动激活，不影响任何其他功能。opt.hint === false 整体禁用。
import { isHintWorthy, HINT_ENTRY, promptText } from "./lib.ts";
import { HINT_KEY } from "./state.ts";

// ctx 为宿主注入 API（形状防御式探测，无官方类型）；opt 为插件 options；deps 由 index.js 注入。
export function registerHint(ctx: any, opt: any, deps: any) {
  const { resolveState, probeOnce } = deps;
  const E = ctx?.session?.instructions?.entry;

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
      hinted.add(sid);
      await E.put({ sessionID: sid, key: HINT_KEY, value: HINT_ENTRY });
    } catch { /* 绝不阻断消息流 */ }
  };

  let chatReg = null;
  if (opt.hint !== false) {
    for (const [api, name] of [[ctx.chat, "message"], [ctx.chat, "chat.message"], [ctx.session, "chat.message"]]) {
      if (typeof api?.hook !== "function") continue;
      try { chatReg = api.hook(name, onChatMessage); if (chatReg) break; } catch { }
    }
  }
  return chatReg;
}
