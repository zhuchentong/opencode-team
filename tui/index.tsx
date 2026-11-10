// wf-workflow TUI 部件（M8-a 侧边栏挂件 + M8-b 面板看板 + M15 回退列表/范围切换）
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

// M15.1 观测：不再一次性闩锁——每次挂件刷新/渲染都追加记录（崩溃时可回看死前数据形状）
const TUI_BUILD = "M15.1";
const LOADED_AT = new Date().toISOString();
const probeOnce = (data) => {
  (async () => {
    try {
      const fs = await import("node:fs");
      const dir = `${REPO}/.workflow/_debug`;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(`${dir}/tui-refresh.log`, JSON.stringify({ at: new Date().toISOString(), build: TUI_BUILD, loadedAt: LOADED_AT, ...data }) + "\n");
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
  // M15①③：当前会话无活动任务时，回退显示本项目→全局的活跃任务（≤3 行，全部字符串）
  const [oth, setOth] = createSignal([]);
  const [othScope, setOthScope] = createSignal("");

  const listLine = (x) => {
    const r = x?.rounds ?? {};
    return `${str(x?.slug || "(未定)")} · ${str(x?.phase ?? "?")} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
  };

  const refresh = async () => {
    try {
      const rpc = props.context.client.rpc(Wf);
      const s = await rpc.state({ sessionID: props.sessionID });
      probeOnce({ sessionID: props.sessionID, state: s });
      setSt(s ?? { active: false });
      setErr(null);
      if (s?.active) { setOth([]); setOthScope(""); return; }
      let pid = null;
      let dir = null;
      try {
        const cs = props.context.data?.session?.get(String(props.sessionID ?? ""));
        pid = cs?.projectID ?? null;
        dir = cs?.location?.directory ?? null;
      } catch { }
      try {
        const mine = await rpc.list(pid ? { projectID: String(pid), ...(dir ? { directory: String(dir) } : {}) } : {});
        const act = (Array.isArray(mine?.sessions) ? mine.sessions : []).filter((x) => x?.phase && x.phase !== "done").slice(0, 3);
        if (act.length) { setOth(act.map(listLine)); setOthScope("本项目"); return; }
        const allR = await rpc.list({});
        const cross = (Array.isArray(allR?.sessions) ? allR.sessions : []).filter((x) => x?.phase && x.phase !== "done").slice(0, 3);
        setOth(cross.map(listLine));
        setOthScope(cross.length ? "全局·其它项目" : "");
      } catch { setOth([]); setOthScope(""); }
    } catch (e) {
      const m = str(e?.message ?? e);
      probeOnce({ sessionID: props.sessionID, rpcErr: m });
      setErr(m);
    }
  };
  refresh();

  // M15：回退列表是全项目视角——任何会话的 updated 事件都触发刷新
  const off = props.context.client.rpc(Wf).events.on("updated", () => { refresh(); });
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
          probeOnce({ render: true, sid: String(props.sessionID ?? ""), active: !!(s && s.active), phase: s?.phase ?? null, othN: oth().length });
          if (!s) return <text fg={T.text.muted}>{"  wf: …"}</text>;
          if (!s.active) {
            const o = oth();
            if (o.length > 0) {
              const line = (n) => (o[n] ? `  ${o[n]}` : "");
              return (
                <box flexDirection="column">
                  <text fg={T.text.muted}>{"── wf ──────────────"}</text>
                  <text fg={T.text.base}>{`  活动任务·${othScope()}`}</text>
                  <text fg={T.text.action.primary}>{line(0)}</text>
                  <text fg={T.text.action.primary}>{line(1)}</text>
                  <text fg={T.text.action.primary}>{line(2)}</text>
                  <text fg={T.text.muted}>{"  /wf-board 看板"}</text>
                  <text fg={T.text.muted}>{"──────────────────────"}</text>
                </box>
              );
            }
            return (
              <box flexDirection="column">
                <text fg={T.text.muted}>{"── wf ──────────────"}</text>
                <text fg={T.text.muted}>{"  wf: 本会话无活动任务"}</text>
                <text fg={T.text.muted}>{"──────────────────────"}</text>
              </box>
            );
          }

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

// ── M8-b/M15：面板看板（全部工作流任务）───────────────────────────
// 同样遵守渲染纪律：固定行数（每任务 2 行 × 最多 6 任务），全部是字符串子节点。
const PANEL_MAX = 6;
const hhmm = (iso) => { const s = str(iso); return s.length >= 16 ? s.slice(11, 16) : ""; };

function WfBoardPanel(props) {
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
