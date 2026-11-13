// tui/exec-intercept.ts — R3 T3.4 自 index.tsx 拆出：return 键拦截 / 主轨 exec 调度。
// quota 式拦截（P0⑧；run 必须同步返回，Promise 即算已处理）；wf:open 带参且 route 可用
// → 本地产物预览，其余透传 execLocal（全文/清单 toast 降级轨）。
import { str } from "./util.ts";

export function installExecIntercept(
  context: any,
  deps: {
    execLocal: (name: string, promptText: string) => void | Promise<void>;
    openArtifact: (file: string) => void | Promise<void>;
    isRouterOk: () => boolean;
    probe: (d: Record<string, unknown>) => void;
  },
) {
  const { execLocal, openArtifact, isRouterOk, probe } = deps;
  context.keymap.layer(() => ({
    mode: "global",
    priority: 1,
    commands: [{
      id: "wf.exec",
      title: "wf: 本地执行 /wf:* 命令",
      bind: "return",
      run: () => {
        const editor = context.renderer?.currentFocusedEditor;
        const text = str(editor?.plainText).trim();
        if (!editor || !text.startsWith("/wf:")) return false;
        const body = text.slice(1);
        const sp = body.search(/\s/);
        const name = sp < 0 ? body : body.slice(0, sp);
        const promptText = sp < 0 ? "" : body.slice(sp + 1);
        try { editor.clear(); } catch { }
        // M16-r46 批2：wf:open 带文件名且 route 可用 → 本地产物预览（read+navigate）；
        // 其余情况（无参列清单 / router 不可用）透传 server exec（全文/清单 toast 降级轨）。
        if (name === "wf:open" && promptText.trim() && isRouterOk()) void openArtifact(promptText.trim());
        else void execLocal(name, promptText);
        probe({ evt: "intercept-hit", name });
        return true;
      },
    }],
  }));
}
