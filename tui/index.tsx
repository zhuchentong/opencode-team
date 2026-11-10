// wf-workflow TUI 部件（M8-a 侧边栏挂件 + M8-b 面板看板 + M15 回退列表/范围切换）
// bundle rev: r26-t2（回滚单文件形态：宿主 slot 管线对跨模块组件崩溃 e.length；模块缓存模型见 .learnings/ERRORS.md）
// - 数据源：server 侧 RPC（shared/rpc.ts 的 Wf.state / Wf.list）+ "updated" 事件驱动刷新
// - 面板：/wf-board（slash）或命令面板 → context.ui.panel.open("wf.board")
// - 渲染纪律（M9 血泪）：slot 子树里只用 <text> + 字符串子节点。
//   禁止：数组/null 子节点、<box flexDirection="row">、在 JSX 中调用返回 JSX 的函数。
//   违反会整块 slot 抛错消失：
//   `wf-workflow-tui crashed in slot sidebar.content: undefined is not an object (evaluating 'e.length')`
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, createMemo, onCleanup, Show } from "solid-js";
import { Wf } from "../shared/rpc.ts";

const REPO = "/home/zhuchentong/Projects/zhuchentong/opencode-team";

// M15.1 观测：不再一次性闩锁——每次挂件刷新/渲染都追加记录（崩溃时可回看死前数据形状）
const TUI_BUILD = "M16-r27-flat";
const LOADED_AT = new Date().toISOString();
const probeOnce = (data: Record<string, unknown>) => {
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
import { STAGE_ORDER, STAGE_LABEL, FOLD, CANON } from "../shared/phases.ts";

const stageOf = (phase: any) => {
  const p = FOLD[phase] ?? phase;
  const i = STAGE_ORDER.indexOf(p);
  return i < 0 ? 0 : i;
};

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// opentui JSX 类型不覆盖函数子节点（Solid 响应式 getter 合法，运行时实证 M15.1）——仅类型断言，运行时子节点仍是同一函数引用
const rc = (f: () => any): any => f;

// ── M8-a/M9：侧边栏挂件（当前会话状态）──────────────────────────────
function WfBoard(props: any) {
  const [st, setSt] = createSignal<any>(null);
  const [err, setErr] = createSignal<string | null>(null);
  // M15①③：当前会话无活动任务时，回退显示本项目→全局的活跃任务（≤3 行，全部字符串）
  const [oth, setOth] = createSignal<string[]>([]);
  const [othScope, setOthScope] = createSignal("");

  const listLine = (x: any) => {
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
        const act = (Array.isArray(mine?.sessions) ? mine.sessions : []).filter((x: any) => x?.phase && x.phase !== "done").slice(0, 3);
        if (act.length) { setOth(act.map(listLine)); setOthScope("本项目"); return; }
        const allR = await rpc.list({});
        const cross = (Array.isArray(allR?.sessions) ? allR.sessions : []).filter((x: any) => x?.phase && x.phase !== "done").slice(0, 3);
        setOth(cross.map(listLine));
        setOthScope(cross.length ? "全局·其它项目" : "");
      } catch { setOth([]); setOthScope(""); }
    } catch (e) {
      const m = str((e as Error)?.message ?? e);
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
      {rc(() => {
        try {
          if (err()) return <text fg={T.text.feedback.error}>{`wf 错误: ${str(err())}`}</text>;
          if (!props.sessionID) return <text fg={T.text.muted}>{"  wf: 无会话"}</text>;
          const s = st();
          probeOnce({ render: true, sid: String(props.sessionID ?? ""), active: !!(s && s.active), phase: s?.phase ?? null, othN: oth().length });
          if (!s) return <text fg={T.text.muted}>{"  wf: …"}</text>;
          if (!s.active) {
            const o = oth();
            if (o.length > 0) {
              const line = (n: number) => (o[n] ? `  ${o[n]}` : "");
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
          const extraCount = Object.keys(arts).filter((n: string) => CANON.indexOf(n) < 0).length;
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
          return <text fg={T.text.feedback.error}>{`wf 渲染异常: ${str((e as Error)?.message ?? e)}`}</text>;
        }
      })}
    </box>
  );
}

// ── M8-b/M15：面板看板（全部工作流任务）───────────────────────────
// 同样遵守渲染纪律：固定行数（每任务 2 行 × 最多 6 任务），全部是字符串子节点。
const PANEL_MAX = 6;
const hhmm = (iso: unknown) => { const s = str(iso); return s.length >= 16 ? s.slice(11, 16) : ""; };

function WfBoardPanel(props: any) {
  const ctx = props.context;
  // M15.1 同款观测：面板死亡前最后证据（崩溃无 toast 落日志，靠此记录定位死点）
  probeOnce({ panelEv: "mount", sid: String(props.panel?.sessionID ?? ""), pname: String(props.panel?.name ?? "") });
  const [rows, setRows] = createSignal<any[]>([]);
  const [err, setErr] = createSignal<string | null>(null);
  const [all, setAll] = createSignal(false); // M15②：a 键切换 当前项目/全部项目

  const refresh = async () => {
    probeOnce({ panelEv: "refresh-start", sid: String(props.panel?.sessionID ?? "") });
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
      probeOnce({ panelEv: "rpc-list-ok", n: Array.isArray(r?.sessions) ? r.sessions.length : -1 });
      setRows(Array.isArray(r?.sessions) ? r.sessions : []);
      setErr(null);
      probeOnce({ panelEv: "rows-set" });
    } catch (e) {
      probeOnce({ panelEv: "refresh-err", err: str((e as Error)?.message ?? e) });
      setErr(str((e as Error)?.message ?? e));
    }
  };
  refresh();

  const off = ctx.client.rpc(Wf).events.on("updated", () => { refresh(); });
  onCleanup(() => { try { off?.(); } catch { } });
  probeOnce({ panelEv: "subscribed" });

  // 面板内按键（仅在面板持有输入时生效）
  ctx.keymap.layer(() => ({
    commands: [
      { id: "wf.board.refresh", title: "刷新看板", group: "wf 看板", bind: "r", run: () => refresh() },
      { id: "wf.board.scope", title: "切换范围 项目↔全局", group: "wf 看板", bind: "a", run: () => { setAll(!all()); refresh(); } },
      { id: "wf.board.fullscreen", title: "切换全屏", group: "wf 看板", bind: "f", run: () => props.panel?.toggleFullscreen?.() },
      { id: "wf.board.close", title: "关闭看板", group: "wf 看板", bind: "q", run: () => props.panel?.close?.() },
    ],
  }));
  probeOnce({ panelEv: "layer-ok" });

  // M15：每任务两行——主行（slug+阶段+进度条）/ 副行（轮次/关卡/时间/会话尾6位）
  const nth = (n: number) => {
    const list = rows();
    return Array.isArray(list) ? list[n] : null;
  };
  const rowMain = (n: number) => {
    const s = nth(n);
    if (!s) return " ";
    const i = stageOf(s.phase);
    const total = STAGE_ORDER.length;
    const isDone = s.phase === "done" || s.phase === "retrospect";
    const doneN = isDone ? total : i;
    const bar = "●".repeat(doneN) + "○".repeat(Math.max(0, total - doneN));
    const label = STAGE_LABEL[s.phase] ?? str(s.phase ?? "?");
    return `▸ ${str(s.slug || "(未定)")} · F${i} ${label} ${bar} ${doneN}/${total}`;
  };
  const rowSub = (n: number) => {
    const s = nth(n);
    if (!s) return " ";
    const r = s.rounds ?? {};
    return `    轮次 plan ${r.plan_review ?? 0}/3 build ${r.build_review ?? 0}/3 fix ${r.test_fix ?? 0}/3`;
  };
  const rowSub2 = (n: number) => {
    const s = nth(n);
    if (!s) return " ";
    const verdict = s.testReportVerdict ? str(s.testReportVerdict) : "—";
    return `    关卡 test-plan ${s.testPlanWritten ? "✓" : "✗"} report ${verdict} · 更新 ${hhmm(s.updatedAt)} · 会话…${str(s.sessionID).slice(-6)}`;
  };

  // r26-t3：恒定行数渲染（M9 纪律落实）——a 键范围切换改变 rows()/all()/err() 状态时，
  // 旧实现「错误/暂无/有数据」三分支子节点数量不同（2/2/20 个 text），宿主 slot 管线
  // 对子树形态变化崩溃（e.length）。统一为固定 19 个 <text>：1 状态行 + 6 任务 × 3 行，
  // 空槽位渲染单空格；结构恒定、仅文本内容变化。
  // r27：去掉 rc 包装的 IIFE 整树重建（返回 <box> 子树的函数子节点）——真机探针实证（panelEv 序列）：
  // 首渲染完整（mount→…→render→rows-set 全齐），rows-set 后无第二次 render 记录，崩在
  // setRows 信号更新后 renderEffect 重新创建整棵子树并换入的路径（宿主 e.length，
  // ERR-20261110-005 的最终死点）。改为平铺恒定 21 个 <text>（2 标题行 + 19 内容行）：
  // 每个子节点是返回字符串的表达式 → solid 编译器生成 insert(() => expr) 细粒度
  // content 更新，同一节点只换文本，节点树恒定不重建（与头部 M9 渲染纪律一致）。
  const statusText = createMemo(() => {
    const list = rows();
    const count = Array.isArray(list) ? list.length : 0;
    const scope = all() ? "全部项目" : "当前项目";
    probeOnce({ panelEv: "render", count, scope, hasErr: !!err() });
    return err()
      ? `范围: ${scope} · ⚠️ 加载错误: ${str(err())}`
      : `范围: ${scope} · ${count === 0 ? "（暂无工作流任务）" : `共 ${count} 个任务（每任务 3 行），最多显示 ${PANEL_MAX}`}`;
  });
  probeOnce({ panelEv: "pre-return" });
  return (
    <box flexDirection="column">
      <text fg={ctx.theme.text.base}>{"WF 看板"}</text>
      <text fg={ctx.theme.text.muted}>{"r=刷新 a=范围 f=全屏 q=关闭"}</text>
      <text fg={ctx.theme.text.muted}>{statusText()}</text>
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
}

export default Plugin.define({
  id: "wf-workflow-tui",
  setup(context: any) {
    // ① 侧边栏挂件
    context.ui.slot({
      append: "sidebar.content",
      render: (props: any) => <WfBoard context={context} sessionID={props?.sessionID} />,
    });

    // ② 会话面板（名字由 panel.name 判定）。fallback 必须提供：Show 为 false 且无 fallback
    //    时返回 undefined → 宿主 slot 子节点规范化产生 orphan 节点 → 渲染器取 length 崩溃
    //    （wf-board 打开即崩 e.length 的根因，见 .learnings/ERRORS.md ERR-20261110-005）
    context.ui.slot({
      append: "session.panel",
      render: (panel: any) => (
        <Show when={panel?.name === "wf.board"} fallback={<box flexDirection="column" />}>
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
