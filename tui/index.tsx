// wf-workflow TUI 部件（M8-a 侧边栏挂件 + M8-b 面板看板）
// - 数据源：server 侧 RPC（shared/rpc.ts 的 Wf.state / Wf.list）+ "updated" 事件驱动刷新
// - 面板：/wf-board（slash）或命令面板 → context.ui.panel.open("wf.board")
// - 渲染纪律（M9 血泪）：slot 子树里只用 <text> + 字符串子节点。
//   禁止：数组/null 子节点、<box flexDirection="row">、在 JSX 中调用返回 JSX 的函数。
//   违反会整块 slot 抛错消失：
//   `wf-workflow-tui crashed in slot sidebar.content: undefined is not an object (evaluating 'e.length')`
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, onCleanup, Show } from "solid-js";
import { Wf } from "../shared/rpc.ts";

const REPO = "/home/zhuchentong/Projects/zhuchentong/opencode-team";

// 探针：首次成功调用 RPC 后落盘一次（TUI 无法 headless 验证）
let probed = false;
const probeOnce = (data) => {
  if (probed) return;
  probed = true;
  (async () => {
    try {
      const fs = await import("node:fs");
      const dir = `${REPO}/.workflow/_debug`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/tui-probe.json`, JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2));
    } catch { /* 探针失败不影响 UI */ }
  })();
};

// ── M9 渲染规则 ───────────────────────────────────────────────────
// reconcile/retrospect 折进相邻主阶段；进度条固定 9 格（F0–F8）
// M10-d A1：阶段定义单一来源 shared/phases.js（与 server 共用）
import { PHASE_ORDER as STAGE_ORDER, STAGE_LABEL, FOLD, CANON } from "../shared/phases.js";

const stageOf = (phase) => {
  const p = FOLD[phase] ?? phase;
  const i = STAGE_ORDER.indexOf(p);
  return i < 0 ? 0 : i;
};

const str = (v) => (v === null || v === undefined ? "" : String(v));

// ── M8-a/M9：侧边栏挂件（当前会话状态）──────────────────────────────
function WfBoard(props) {
  const [st, setSt] = createSignal(null);
  const [err, setErr] = createSignal(null);

  const refresh = async () => {
    try {
      const s = await props.context.client.rpc(Wf).state({ sessionID: props.sessionID });
      probeOnce({ sessionID: props.sessionID, state: s });
      setSt(s ?? { active: false });
      setErr(null);
    } catch (e) {
      const m = str(e?.message ?? e);
      probeOnce({ sessionID: props.sessionID, rpcErr: m });
      setErr(m);
    }
  };
  refresh();

  const off = props.context.client.rpc(Wf).events.on("updated", (ev) => {
    if (!ev?.data?.sessionID || ev.data.sessionID === props.sessionID) refresh();
  });
  onCleanup(() => { try { off?.(); } catch { } });

  const T = props.context.theme;
  const compact = props.context.options?.compact === true;

  return (
    <box flexDirection="column">
      {() => {
        try {
          if (err()) return <text fg={T.text.feedback.error}>{`wf 错误: ${str(err())}`}</text>;
          if (!props.sessionID) return <text fg={T.text.muted}>{"  wf: 无会话"}</text>;
          const s = st();
          if (!s) return <text fg={T.text.muted}>{"  wf: …"}</text>;
          if (!s.active)
            return (
              <box flexDirection="column">
                <text fg={T.text.muted}>{"── wf ──────────────"}</text>
                <text fg={T.text.muted}>{"  wf: 本会话无活动任务"}</text>
                <text fg={T.text.muted}>{"──────────────────────"}</text>
              </box>
            );

          const r = s.rounds ?? {};
          const i = stageOf(s.phase);
          const total = STAGE_ORDER.length;
          const isDone = s.phase === "done" || s.phase === "retrospect";
          const label = STAGE_LABEL[s.phase] ?? str(s.phase ?? "?");
          const planV = r.plan_review ?? 0;
          const buildV = r.build_review ?? 0;
          const fixV = r.test_fix ?? 0;

          // 极简模式：cli.json 给插件设 options:{compact:true}
          if (compact) {
            return <text fg={T.text.action.primary}>{`▶ ${label} ${planV}/${buildV}/${fixV}`}</text>;
          }

          const done = isDone ? total : i;
          // 单条字符串进度条：避免多子节点/null 子节点
          const bar = "●".repeat(done) + "○".repeat(total - done);

          const arts = s.artifacts ?? {};
          const extraCount = Object.keys(arts).filter((n) => CANON.indexOf(n) < 0).length;
          const verdict = s.testReportVerdict;

          return (
            <box flexDirection="column">
              <text fg={T.text.muted}>{"── wf ──────────────"}</text>
              <text fg={T.text.base}>{`  ${str(s.slug || "(未定)")}`}</text>
              <text fg={T.text.action.primary}>{`  F${i} ${label}`}</text>
              <text fg={T.text.action.primary}>{`  ${bar} ${done}/${total}`}</text>
              <text fg={T.text.base}>{" "}</text>
              <text fg={T.text.muted}>{"── 轮次 ────────────"}</text>
              <text fg={planV >= 3 ? T.text.feedback.error : T.text.base}>{`      plan  ${planV}/3`}</text>
              <text fg={buildV >= 3 ? T.text.feedback.error : T.text.base}>{`      build ${buildV}/3`}</text>
              <text fg={fixV >= 3 ? T.text.feedback.error : T.text.base}>{`      fix   ${fixV}/3`}</text>
              <text fg={T.text.base}>{" "}</text>
              <text fg={T.text.muted}>{"── 关卡 ────────────"}</text>
              <text fg={s.testPlanWritten ? T.text.feedback.success : T.text.muted}>{`      test-plan ${s.testPlanWritten ? "✓" : "✗"}`}</text>
              <text fg={verdict === "PASS" ? T.text.feedback.success : verdict === "FAIL" ? T.text.feedback.error : T.text.muted}>{`      report    ${verdict ? str(verdict) : "—"}`}</text>
              <text fg={T.text.base}>{" "}</text>
              <text fg={T.text.muted}>{"── 产物 ────────────"}</text>
              <text fg={arts["plan.md"] ? T.text.feedback.success : T.text.muted}>{`      plan.md ${arts["plan.md"] ? "✓" : "✗"}`}</text>
              <text fg={arts["test-plan.md"] ? T.text.feedback.success : T.text.muted}>{`      test-plan.md ${arts["test-plan.md"] ? "✓" : "✗"}`}</text>
              <text fg={arts["test-report.md"] ? T.text.feedback.success : T.text.muted}>{`      test-report.md ${arts["test-report.md"] ? "✓" : "✗"}`}</text>
              <text fg={T.text.muted}>{`      其他产物 ${extraCount} 项`}</text>
              <text fg={T.text.muted}>{"──────────────────────"}</text>
            </box>
          );
        } catch (e) {
          return <text fg={T.text.feedback.error}>{`wf 渲染异常: ${str(e?.message ?? e)}`}</text>;
        }
      }}
    </box>
  );
}

// ── M8-b：面板看板（全部工作流任务）────────────────────────────────
// 同样遵守渲染纪律：固定行数（最多 10 行），全部是字符串子节点。
const PANEL_MAX = 10;

function WfBoardPanel(props) {
  const ctx = props.context;
  const [rows, setRows] = createSignal([]);
  const [err, setErr] = createSignal(null);

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
      const r = await ctx.client.rpc(Wf).list(pid ? { projectID: String(pid), ...(dir ? { directory: String(dir) } : {}) } : {});
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
      { id: "wf.board.fullscreen", title: "切换全屏", group: "wf 看板", bind: "f", run: () => props.panel?.toggleFullscreen?.() },
      { id: "wf.board.close", title: "关闭看板", group: "wf 看板", bind: "q", run: () => props.panel?.close?.() },
    ],
  }));

  const rowText = (n) => {
    const list = rows();
    const s = Array.isArray(list) ? list[n] : null;
    if (!s) return "";
    const r = s.rounds ?? {};
    const gate = `${s.testPlanWritten ? "✓" : "✗"}${s.testReportVerdict ? "/" + str(s.testReportVerdict) : ""}`;
    return `${str(s.sessionID).slice(0, 14)}  ${str(s.phase ?? "?")} · ${str(s.slug || "(未定)")}  ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}  ${gate}`;
  };

  return (
    <box flexDirection="column">
      <text fg={ctx.theme.text.base}>{"WF 看板"}</text>
      <text fg={ctx.theme.text.muted}>{"r=刷新  f=全屏  q=关闭"}</text>
      {() => {
        try {
          if (err()) return <text fg={ctx.theme.text.feedback.error}>{`加载错误: ${str(err())}`}</text>;
          const list = rows();
          const count = Array.isArray(list) ? list.length : 0;
          if (count === 0) return <text fg={ctx.theme.text.muted}>{"（暂无工作流任务）"}</text>;
          return (
            <box flexDirection="column">
              <text fg={ctx.theme.text.muted}>{`共 ${count} 条，最多显示 ${PANEL_MAX}`}</text>
              <text>{rowText(0)}</text>
              <text>{rowText(1)}</text>
              <text>{rowText(2)}</text>
              <text>{rowText(3)}</text>
              <text>{rowText(4)}</text>
              <text>{rowText(5)}</text>
              <text>{rowText(6)}</text>
              <text>{rowText(7)}</text>
              <text>{rowText(8)}</text>
              <text>{rowText(9)}</text>
            </box>
          );
        } catch (e) {
          return <text fg={ctx.theme.text.feedback.error}>{`渲染异常: ${str(e?.message ?? e)}`}</text>;
        }
      }}
    </box>
  );
}

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
