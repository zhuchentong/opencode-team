// wf-workflow TUI 部件注册壳：侧边栏挂件见 widget.tsx、看板面板见 board.tsx、公共格式化见 format.ts。
// 数据源：server 侧 RPC（shared/rpc.ts 的 Wf.state / Wf.list）+ "updated" 事件驱动刷新。
// 面板：/wf-board（slash）或命令面板 → context.ui.panel.open("wf.board")。
// 渲染纪律（M9 血泪）见 widget.tsx / board.tsx 文件头——修改渲染代码前必读。
import { Plugin } from "@opencode/plugin/tui";
import { Show } from "solid-js";
import { WfBoard } from "./widget.tsx";
import { WfBoardPanel } from "./board.tsx";

export default Plugin.define({
  id: "wf-workflow-tui",
  setup(context) {
    // ① 侧边栏挂件
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <WfBoard context={context} sessionID={props?.sessionID} />,
    });

    // ② 会话面板（名字由 panel.name 判定）
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel?.name === "wf.board"}>
          <WfBoardPanel panel={panel} context={context} />
        </Show>
      ),
    });

    // ③ 打开入口：/wf-board 或命令面板（会话外打开返回 false）
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "wf.board.open",
          title: "打开 WF 看板",
          group: "wf",
          palette: true,
          slash: { name: "wf-board" },
          run: () => {
            const ok = context.ui.panel.open("wf.board");
            if (!ok) context.ui.toast.show({ message: "看板需在会话内打开", variant: "warning" });
          },
        },
      ],
    }));
  },
});
