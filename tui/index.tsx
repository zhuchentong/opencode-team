// wf-workflow TUI 部件（M8-a 侧边栏挂件 + M15 回退列表/范围切换）
// bundle rev: r28（移除 wf-board 看板：宿主 session.panel slot 管线在信号更新→子树换入路径崩溃
//   `e.length`（见 .learnings/ERRORS.md ERR-20261110-005）。已尝试 Show fallback、恒定行数、
//   平铺细粒度 memo 多轮修复，真机探针证实死点在宿主 reconciler 更新路径，本地无法复现。
//   用户决定放弃面板功能。侧边栏 sidebar.content 长期稳定，保留。）
// - 数据源：server 侧 RPC（shared/rpc.ts 的 Wf.state / Wf.list）+ "updated" 事件驱动刷新
// - 渲染纪律（M9 血泪）：slot 子树里只用 <text> + 字符串子节点。
//   禁止：数组/null 子节点、<box flexDirection="row">、在 JSX 中调用返回 JSX 的函数。
//   违反会整块 slot 抛错消失：
//   `wf-workflow-tui crashed in slot sidebar.content: undefined is not an object (evaluating 'e.length')`
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, onCleanup } from "solid-js";
import { Wf } from "../shared/rpc.ts";

const REPO = "/home/zhuchentong/Projects/zhuchentong/opencode-team";

// M15.1 观测：不再一次性闩锁——每次挂件刷新/渲染都追加记录（崩溃时可回看死前数据形状）
const TUI_BUILD = "M16-r29d-dualchan";
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

  // 诊断 r29c：宿主二进制证实 events.on 回调收信封 {type,location,data}（type 前缀 rpc.wf.<name>）；
  // 兼容信封/裸数据两种形状。subscribed/updated-recv/recv 三条探针定位事件是否到达 TUI。
  const unwrap = (e: any) => (e && typeof e === "object" && "data" in e ? (e as any).data : e);
  // M15：回退列表是全项目视角——任何会话的 updated 事件都触发刷新
  const off = props.context.client.rpc(Wf).events.on("updated", (e: any) => {
    probeOnce({ evt: "updated-recv", got: str(unwrap(e)?.sessionID), cur: String(props.sessionID ?? "") });
    refresh();
  });
  // 命令输出 → toast（2.2.6 宿主 execute 返回值对用户不显示；server/commands.ts 经 report 事件广播，
  // 见 .learnings/ERRORS.md ERR-20261110-007）。只呈现本会话的报告，避免跨会话噪音。
  // r29d 双通道：①RPC subclient events.on；②context.data 全事件流兜底（官方 TUI 文档——RPC 事件
  // 同时以 `rpc.<id>.<name>` 类型出现在事件流）。两通道都到则 800ms 内同内容去重只弹一次。
  let lastToast = { key: "", at: 0 };
  const handleReport = (d: any, chan: string) => {
    probeOnce({ reportEv: "recv", chan, got: str(d?.sessionID), cur: String(props.sessionID ?? ""), chars: String(d?.text ?? "").length });
    try {
      if (String(d?.sessionID ?? "") !== String(props.sessionID ?? "")) return;
      const key = str(d?.sessionID) + "|" + str(d?.text);
      const now = Date.now();
      if (key === lastToast.key && now - lastToast.at < 800) { probeOnce({ reportEv: "dup-skipped", chan }); return; }
      lastToast = { key, at: now };
      props.context.ui.toast.show({ message: str(d?.text), variant: "info" });
      probeOnce({ reportEv: "toast-shown", chan });
    } catch (er) { probeOnce({ reportEv: "toast-err", err: str((er as Error)?.message ?? er) }); }
  };
  const offReport = props.context.client.rpc(Wf).events.on("report", (e: any) => { handleReport(unwrap(e), "rpc"); });
  // 兜底通道 ②：data.listen 全事件流——rpc subclient 投递失效时仍能收到（shape 未定，data-raw 探针记录）
  let offData: any = null;
  try {
    offData = props.context.data?.listen?.((ev: any) => {
      const details = ev?.details ?? ev;
      const type = String(details?.type ?? "");
      if (!type.startsWith("rpc.wf.")) return;
      const payload = details?.data ?? details;
      probeOnce({ evt: "data-raw", type, keys: Object.keys(details ?? {}).join(","), pkeys: Object.keys(payload ?? {}).join(",") });
      if (type === "rpc.wf.report") handleReport(payload, "data");
      else if (type === "rpc.wf.updated") refresh();
    });
  } catch { /* data.listen 不可用则仅走 RPC 通道 */ }
  probeOnce({ evt: "subscribed", sid: String(props.sessionID ?? ""), hasDataListen: !!offData });
  onCleanup(() => { try { off?.(); } catch { } try { offReport?.(); } catch { } try { offData?.(); } catch { } });

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

export default Plugin.define({
  id: "wf-workflow-tui",
  setup(context: any) {
    // ① 侧边栏挂件
    context.ui.slot({
      append: "sidebar.content",
      render: (props: any) => <WfBoard context={context} sessionID={props?.sessionID} />,
    });
    // ② wf-board 面板已移除（r28）：宿主 session.panel slot 管线崩溃无法根治，见头部注释与 ERR-20261110-005
  },
});
