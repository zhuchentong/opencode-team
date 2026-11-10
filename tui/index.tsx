// wf-workflow TUI 部件（M8-a 侧边栏挂件 + M15 回退列表/范围切换）
// bundle rev: r29f（真机 r29e 崩溃死点定位：信号更新 → rc(()=>分支box) IIFE 子树换入 commit →
//   宿主 reconciler `e.length` 崩（与面板 ERR-20261110-005 同款，见 ERR-20261110-009）。
//   侧边栏此前"稳定"只因事件/轮询从未跑通、初始帧后零 update。本版废除 IIFE 分支渲染：
//   **恒定 20 行 <text> 节点树 + 单一 createMemo 数据视图**——update 只经 insert(()=>view().t[n])
//   换文本内容、经 setProp 换 fg，节点树永不重建。禁止 IIFE 函数子节点返回 JSX 的模式（P4 静态守卫锁死）。）
// - 数据源：server RPC state（含 lastReport 槽）+ 2.5s 轮询主通道 + updated/report 事件机会性补充
//   （真机实证 RPC 事件投递不通，ERR-20261110-008）
// - 命令输出呈现：toastReport（poll 主通道；60s 新鲜度门 + sessionID|at 去重；toast 是宿主
//   overlay，不经过 slot 子树，无换树风险）
// - 渲染纪律（M9 血泪）：slot 子树里只用 <text> + 字符串子节点；空槽单空格 " "（禁空字符串）。
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, createMemo, onCleanup } from "solid-js";
import { Wf } from "../shared/rpc.ts";

const REPO = "/home/zhuchentong/Projects/zhuchentong/opencode-team";

// M15.1 观测：不再一次性闩锁——每次挂件刷新/渲染都追加记录（崩溃时可回看死前数据形状）
const TUI_BUILD = "M16-r29f-flat";
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

// r29e 主通道：真机实证 RPC 事件投递不通（server emit 成功但 TUI 双通道零接收，
// 见 ERR-20261110-008）→ 轮询 state（含 lastReport）。methods 通道真机实证可用。
// 恒定行数：active 态满配 20 行，其余态行内容折叠/占位，结构永不变
const ROWS = 20;

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

  // 轮询防抖：数据快照未变 → 不 setSt（避免每 2.5s 无谓重渲染 + 探针刷屏）
  let lastSnap = "";
  let lastOthJoined = "";

  const refresh = async () => {
    try {
      const rpc = props.context.client.rpc(Wf);
      const s = await rpc.state({ sessionID: props.sessionID });
      if (s?.lastReport) toastReport(s.lastReport, "poll");
      const snap = JSON.stringify(s ?? null);
      if (snap !== lastSnap) {
        lastSnap = snap;
        probeOnce({ sessionID: props.sessionID, state: s });
        setSt(s ?? { active: false });
        setErr(null);
      }
      if (s?.active) { if (lastOthJoined !== "") { lastOthJoined = ""; setOth([]); setOthScope(""); } return; }
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
        if (act.length) {
          const j = act.map(listLine).join("|");
          if (j !== lastOthJoined) { lastOthJoined = j; setOth(act.map(listLine)); setOthScope("本项目"); }
          return;
        }
        const allR = await rpc.list({});
        const cross = (Array.isArray(allR?.sessions) ? allR.sessions : []).filter((x: any) => x?.phase && x.phase !== "done").slice(0, 3);
        const j = cross.map(listLine).join("|");
        if (j !== lastOthJoined) { lastOthJoined = j; setOth(cross.map(listLine)); setOthScope(cross.length ? "全局·其它项目" : ""); }
      } catch { if (lastOthJoined !== "") { lastOthJoined = ""; setOth([]); setOthScope(""); } }
    } catch (e) {
      const m = str((e as Error)?.message ?? e);
      probeOnce({ sessionID: props.sessionID, rpcErr: m });
      setErr(m);
    }
  };
  refresh();
  const timer = setInterval(() => { refresh(); }, 2500);

  // 诊断：宿主二进制证实 events.on 回调收信封 {type,location,data}（type 前缀 rpc.wf.<name>）；
  // 兼容信封/裸数据两种形状。subscribed/updated-recv/recv 探针定位事件是否到达 TUI。
  const unwrap = (e: any) => (e && typeof e === "object" && "data" in e ? (e as any).data : e);
  // M15：回退列表是全项目视角——任何会话的 updated 事件都触发刷新
  const off = props.context.client.rpc(Wf).events.on("updated", (e: any) => {
    probeOnce({ evt: "updated-recv", got: str(unwrap(e)?.sessionID), cur: String(props.sessionID ?? "") });
    refresh();
  });
  // ── r29e 命令输出呈现：三通道（poll/rpc/data）统一去重 + 新鲜度门 ──────────
  // 主通道 = 轮询 state.lastReport（storage 槽）；report 事件 + data.listen 为机会性补充
  // （真机实证事件投递不通，ERR-20261110-008；只呈现本会话，60s 内新鲜，sessionID|at 去重——
  // server 对槽与事件用同一 at）。
  const shown = new Set<string>();
  const toastReport = (d: any, chan: string) => {
    const sid = String(d?.sessionID ?? "");
    const text = str(d?.text);
    const at = str(d?.at);
    probeOnce({ reportEv: "recv", chan, got: sid, cur: String(props.sessionID ?? ""), chars: text.length });
    try {
      if (sid !== String(props.sessionID ?? "") || !text) return;
      if (at) {
        const age = Date.now() - Date.parse(at);
        if (Number.isFinite(age) && age > 60000) { probeOnce({ reportEv: "stale-skipped", chan }); return; }
        const key = sid + "|" + at;
        if (shown.has(key)) { probeOnce({ reportEv: "dup-skipped", chan }); return; }
        shown.add(key);
        if (shown.size > 50) { const first = shown.values().next().value; if (first !== undefined) shown.delete(first); }
      }
      props.context.ui.toast.show({ message: text, variant: "info" });
      probeOnce({ reportEv: "toast-shown", chan });
    } catch (er) { probeOnce({ reportEv: "toast-err", err: str((er as Error)?.message ?? er) }); }
  };
  const offReport = props.context.client.rpc(Wf).events.on("report", (e: any) => { toastReport(unwrap(e), "rpc"); });
  // 补充通道 ②：data.listen 全事件流——rpc subclient 投递失效时仍能收到（shape 未定，data-raw 探针记录）
  let offData: any = null;
  try {
    offData = props.context.data?.listen?.((ev: any) => {
      const details = ev?.details ?? ev;
      const type = String(details?.type ?? "");
      if (!type.startsWith("rpc.wf.")) return;
      const payload = details?.data ?? details;
      probeOnce({ evt: "data-raw", type, keys: Object.keys(details ?? {}).join(","), pkeys: Object.keys(payload ?? {}).join(",") });
      if (type === "rpc.wf.report") toastReport(payload, "data");
      else if (type === "rpc.wf.updated") refresh();
    });
  } catch { /* data.listen 不可用则仅走其余通道 */ }
  probeOnce({ evt: "subscribed", sid: String(props.sessionID ?? ""), hasDataListen: !!offData });
  onCleanup(() => { try { clearInterval(timer); } catch { } try { off?.(); } catch { } try { offReport?.(); } catch { } try { offData?.(); } catch { } });

  const T = props.context.theme;
  const compact = props.context.options?.compact === true;

  // ── r29f 核心：单一 view memo → 恒定结构细粒度更新 ─────────────────
  // update 路径 = insert(()=>view().t[n]) 只换文本 + setProp 换 fg；20 个 <text> 节点树永不重建。
  // 崩溃死点（ERR-20261110-009）在「返回 JSX 的函数子节点换入整棵子树」，本结构不产生任何子树换入。
  const view = createMemo<{ t: string[]; c: string[] }>(() => {
    const t: string[] = new Array(ROWS).fill(" ");
    const c: string[] = new Array(ROWS).fill(T.text.muted);
    t[0] = "── wf ──────────────";
    t[ROWS - 1] = "──────────────────────";
    try {
      if (err()) {
        t[1] = `wf 错误: ${str(err())}`; c[1] = T.text.feedback.error;
      } else if (!props.sessionID) {
        t[1] = "  wf: 无会话";
      } else {
        const s = st();
        probeOnce({ render: true, sid: String(props.sessionID ?? ""), active: !!(s && s.active), phase: s?.phase ?? null, othN: oth().length });
        if (!s) {
          t[1] = "  wf: …";
        } else if (!s.active) {
          const o = oth();
          if (o.length > 0) {
            t[1] = `  活动任务·${othScope()}`; c[1] = T.text.base;
            for (let n = 0; n < 3; n++) { if (o[n]) { t[2 + n] = `  ${o[n]}`; c[2 + n] = T.text.action.primary; } }
          } else {
            t[1] = "  wf: 本会话无活动任务";
          }
        } else {
          const r = s.rounds ?? {};
          const i = stageOf(s.phase);
          const total = STAGE_ORDER.length;
          const isDone = s.phase === "done" || s.phase === "retrospect";
          const label = STAGE_LABEL[s.phase] ?? str(s.phase ?? "?");
          const planV = r.plan_review ?? 0;
          const buildV = r.build_review ?? 0;
          const fixV = r.test_fix ?? 0;
          const done = isDone ? total : i;
          const bar = "●".repeat(done) + "○".repeat(total - done);
          const arts = s.artifacts ?? {};
          const extraCount = Object.keys(arts).filter((n: string) => CANON.indexOf(n) < 0).length;
          const verdict = s.testReportVerdict;
          t[1] = `  ${str(s.slug || "(未定)")}`; c[1] = T.text.base;
          t[2] = `  F${i} ${label}`; c[2] = T.text.action.primary;
          t[3] = `  ${bar} ${done}/${total}`; c[3] = T.text.action.primary;
          t[4] = " "; c[4] = T.text.base;
          t[5] = "── 轮次 ────────────";
          t[6] = `      plan  ${planV}/3`; c[6] = planV >= 3 ? T.text.feedback.error : T.text.base;
          t[7] = `      build ${buildV}/3`; c[7] = buildV >= 3 ? T.text.feedback.error : T.text.base;
          t[8] = `      fix   ${fixV}/3`; c[8] = fixV >= 3 ? T.text.feedback.error : T.text.base;
          t[9] = " "; c[9] = T.text.base;
          t[10] = "── 关卡 ────────────";
          t[11] = `      test-plan ${s.testPlanWritten ? "✓" : "✗"}`; c[11] = s.testPlanWritten ? T.text.feedback.success : T.text.muted;
          t[12] = `      report    ${verdict ? str(verdict) : "—"}`; c[12] = verdict === "PASS" ? T.text.feedback.success : verdict === "FAIL" ? T.text.feedback.error : T.text.muted;
          t[13] = " "; c[13] = T.text.base;
          t[14] = "── 产物 ────────────";
          t[15] = `      plan.md ${arts["plan.md"] ? "✓" : "✗"}`; c[15] = arts["plan.md"] ? T.text.feedback.success : T.text.muted;
          t[16] = `      test-plan.md ${arts["test-plan.md"] ? "✓" : "✗"}`; c[16] = arts["test-plan.md"] ? T.text.feedback.success : T.text.muted;
          t[17] = `      test-report.md ${arts["test-report.md"] ? "✓" : "✗"}`; c[17] = arts["test-report.md"] ? T.text.feedback.success : T.text.muted;
          t[18] = `      其他产物 ${extraCount} 项`;
        }
      }
    } catch (e) {
      t[1] = `wf 渲染异常: ${str((e as Error)?.message ?? e)}`; c[1] = T.text.feedback.error;
    }
    return { t, c };
  });

  // compact 分支在组件 return 顶层：options.compact 是挂载期常量，return 只执行一次（非 update 路径）
  // 极简模式：cli.json 给插件设 options:{compact:true}
  if (compact) {
    const line = createMemo(() => {
      const s = st();
      if (!s?.active) return view().t[1];
      const r = s.rounds ?? {};
      const label = STAGE_LABEL[s.phase] ?? str(s.phase ?? "?");
      return `▶ ${label} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
    });
    return <text fg={T.text.action.primary}>{line()}</text>;
  }

  // 恒定 20 行结构——view() 的 insert 只换每行文本内容，节点树从 mount 起永不改变
  return (
    <box flexDirection="column">
      <text fg={view().c[0]}>{view().t[0]}</text>
      <text fg={view().c[1]}>{view().t[1]}</text>
      <text fg={view().c[2]}>{view().t[2]}</text>
      <text fg={view().c[3]}>{view().t[3]}</text>
      <text fg={view().c[4]}>{view().t[4]}</text>
      <text fg={view().c[5]}>{view().t[5]}</text>
      <text fg={view().c[6]}>{view().t[6]}</text>
      <text fg={view().c[7]}>{view().t[7]}</text>
      <text fg={view().c[8]}>{view().t[8]}</text>
      <text fg={view().c[9]}>{view().t[9]}</text>
      <text fg={view().c[10]}>{view().t[10]}</text>
      <text fg={view().c[11]}>{view().t[11]}</text>
      <text fg={view().c[12]}>{view().t[12]}</text>
      <text fg={view().c[13]}>{view().t[13]}</text>
      <text fg={view().c[14]}>{view().t[14]}</text>
      <text fg={view().c[15]}>{view().t[15]}</text>
      <text fg={view().c[16]}>{view().t[16]}</text>
      <text fg={view().c[17]}>{view().t[17]}</text>
      <text fg={view().c[18]}>{view().t[18]}</text>
      <text fg={view().c[19]}>{view().t[19]}</text>
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
