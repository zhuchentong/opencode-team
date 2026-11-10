// wf-workflow TUI 侧边栏挂件（M8-a 当前会话状态 + M15 回退列表，自 index.tsx 原样搬移）。
// 渲染纪律（M9 血泪）：slot 子树里只用 <text> + 字符串子节点。
//   禁止：数组/null 子节点、<box flexDirection="row">、在 JSX 中调用返回 JSX 的函数。
//   违反会整块 slot 抛错消失：
//   `wf-workflow-tui crashed in slot sidebar.content: undefined is not an object (evaluating 'e.length')`
import { createSignal, onCleanup } from "solid-js";
import { Wf } from "../shared/rpc.ts";
import { STAGE_ORDER, STAGE_LABEL, CANON } from "../shared/phases.js";
import { stageOf, str, listLine } from "./format.ts";

// 已知硬编码：probe 落盘路径，遗留待修（勿在本次重构中变更）——TUI 无法 headless 验证，
// 探针在首次成功调用 RPC 后落盘一次供真机确认。
const REPO = "/home/zhuchentong/Projects/zhuchentong/opencode-team";

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

// ── M8-a/M9：侧边栏挂件（当前会话状态）──────────────────────────────
export function WfBoard(props) {
  const [st, setSt] = createSignal(null);
  const [err, setErr] = createSignal(null);
  // M15①③：当前会话无活动任务时，回退显示本项目→全局的活跃任务（≤3 行，全部字符串）
  const [oth, setOth] = createSignal([]);
  const [othScope, setOthScope] = createSignal("");

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
