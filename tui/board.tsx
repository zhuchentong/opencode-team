// wf-workflow TUI 面板看板（M8-b 全部任务 + M15 范围切换/双行布局，自 index.tsx 原样搬移）。
// 同样遵守渲染纪律（M9 血泪）：固定行数（每任务 3 行 × 最多 6 任务），全部是字符串子节点。
import { createSignal, onCleanup } from "solid-js";
import { Wf } from "../shared/rpc.ts";
import { PHASE_ORDER as STAGE_ORDER, STAGE_LABEL } from "../shared/phases.js";
import { stageOf, str, hhmm } from "./format.ts";

const PANEL_MAX = 6;

// ── M8-b/M15：面板看板（全部工作流任务）───────────────────────────
export function WfBoardPanel(props) {
  const ctx = props.context;
  const [rows, setRows] = createSignal([]);
  const [err, setErr] = createSignal(null);
  const [all, setAll] = createSignal(false); // M15②：a 键切换 当前项目/全部项目

  const refresh = async () => {
    try {
      // M10-d A6：看板默认只显示当前项目（M14：附带 directory 供无 projectID 旧态回退）
      let pid = null;
      let dir = null;
      try {
        const cs = ctx.data?.session?.get(String(props.panel?.sessionID ?? ""));
        pid = cs?.projectID ?? null;
        dir = cs?.location?.directory ?? null;
      } catch { }
      const r = await ctx.client.rpc(Wf).list(all() ? {} : (pid ? { projectID: String(pid), ...(dir ? { directory: String(dir) } : {}) } : {}));
      setRows(Array.isArray(r?.sessions) ? r.sessions : []);
      setErr(null);
    } catch (e) {
      setErr(str(e?.message ?? e));
    }
  };
  refresh();

  const off = ctx.client.rpc(Wf).events.on("updated", () => { refresh(); });
  onCleanup(() => { try { off?.(); } catch { } });

  // 面板内按键（仅在面板持有输入时生效）
  ctx.keymap.layer(() => ({
    commands: [
      { id: "wf.board.refresh", title: "刷新看板", group: "wf 看板", bind: "r", run: () => refresh() },
      { id: "wf.board.scope", title: "切换范围 项目↔全局", group: "wf 看板", bind: "a", run: () => { setAll(!all()); refresh(); } },
      { id: "wf.board.fullscreen", title: "切换全屏", group: "wf 看板", bind: "f", run: () => props.panel?.toggleFullscreen?.() },
      { id: "wf.board.close", title: "关闭看板", group: "wf 看板", bind: "q", run: () => props.panel?.close?.() },
    ],
  }));

  // M15：每任务两行——主行（slug+阶段+进度条）/ 副行（轮次/关卡/时间/会话尾6位）
  const nth = (n) => {
    const list = rows();
    return Array.isArray(list) ? list[n] : null;
  };
  const rowMain = (n) => {
    const s = nth(n);
    if (!s) return "";
    const i = stageOf(s.phase);
    const total = STAGE_ORDER.length;
    const isDone = s.phase === "done" || s.phase === "retrospect";
    const doneN = isDone ? total : i;
    const bar = "●".repeat(doneN) + "○".repeat(Math.max(0, total - doneN));
    const label = STAGE_LABEL[s.phase] ?? str(s.phase ?? "?");
    return `▸ ${str(s.slug || "(未定)")} · F${i} ${label} ${bar} ${doneN}/${total}`;
  };
  const rowSub = (n) => {
    const s = nth(n);
    if (!s) return "";
    const r = s.rounds ?? {};
    return `    轮次 plan ${r.plan_review ?? 0}/3 build ${r.build_review ?? 0}/3 fix ${r.test_fix ?? 0}/3`;
  };
  const rowSub2 = (n) => {
    const s = nth(n);
    if (!s) return "";
    const verdict = s.testReportVerdict ? str(s.testReportVerdict) : "—";
    return `    关卡 test-plan ${s.testPlanWritten ? "✓" : "✗"} report ${verdict} · 更新 ${hhmm(s.updatedAt)} · 会话…${str(s.sessionID).slice(-6)}`;
  };

  // M15 修复：外层 box 恢复"静态文本 + 单动态回调子节点"结构（双回调并排疑为本次崩溃根因，见 LRN-005）
  return (
    <box flexDirection="column">
      <text fg={ctx.theme.text.base}>{"WF 看板"}</text>
      <text fg={ctx.theme.text.muted}>{"r=刷新 a=范围 f=全屏 q=关闭"}</text>
      {() => {
        const scopeLine = <text fg={ctx.theme.text.muted}>{`范围: ${all() ? "全部项目" : "当前项目"}`}</text>;
        try {
          if (err()) return <box flexDirection="column">{scopeLine}<text fg={ctx.theme.text.feedback.error}>{`加载错误: ${str(err())}`}</text></box>;
          const list = rows();
          const count = Array.isArray(list) ? list.length : 0;
          if (count === 0) return <box flexDirection="column">{scopeLine}<text fg={ctx.theme.text.muted}>{"（暂无工作流任务）"}</text></box>;
          return (
            <box flexDirection="column">
              {scopeLine}
              <text fg={ctx.theme.text.muted}>{`共 ${count} 个任务（每任务 3 行），最多显示 ${PANEL_MAX}`}</text>
              <text fg={ctx.theme.text.action.primary}>{rowMain(0)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub(0)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub2(0)}</text>
              <text fg={ctx.theme.text.action.primary}>{rowMain(1)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub(1)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub2(1)}</text>
              <text fg={ctx.theme.text.action.primary}>{rowMain(2)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub(2)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub2(2)}</text>
              <text fg={ctx.theme.text.action.primary}>{rowMain(3)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub(3)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub2(3)}</text>
              <text fg={ctx.theme.text.action.primary}>{rowMain(4)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub(4)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub2(4)}</text>
              <text fg={ctx.theme.text.action.primary}>{rowMain(5)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub(5)}</text>
              <text fg={ctx.theme.text.muted}>{rowSub2(5)}</text>
            </box>
          );
        } catch (e) {
          return <box flexDirection="column">{scopeLine}<text fg={ctx.theme.text.feedback.error}>{`渲染异常: ${str(e?.message ?? e)}`}</text></box>;
        }
      }}
    </box>
  );
}
