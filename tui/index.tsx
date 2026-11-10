// wf-workflow TUI（P3 重设计：流派 A 稳定容器 + quota 式输入拦截主轨）
// 渲染（ERR-20261110-005/009 的正解，P0② 真机验证不崩）：
//   slot render 只建一次恒定 container box；容器内唯一一条 insert(container, () => buildTree())
//   ——信号变化在 Solid 自管的 render effect 内换树（宿主 claim.render 永不被重新执行）。
//   render 顶层零响应式读取（theme/sessionID/snap 全部只进 accessor / createEffect）。
//   usage-monitor/agents-sidebar 双家真机背书 + containers===1/inserts===1 测试锚。
// 命令主轨（P0⑧ 真机验证）：return 键 priority-1 拦截层——输入以 /wf: 开头则清空编辑器并
//   经 RPC exec 本地执行（返回值渲染 toast）；否则同步返回 false 透传（返回 Promise 即算已处理）。
//   server 同名命令注册保留作降级轨（Web/Desktop：wait→prompt(resume:false) 注入）。
// 数据通道：RPC methods（state/list/exec，location 必带）主 + updated/report 事件（P0④ 五条件
//   版已通）+ data.listen 兜底 + 5s 轮询对账；事件按 location.directory 过滤（P0 多实例发现）。
// toast：sessionID|at 去重（exec 返回同一 at，本地渲染先行登记，防事件/轮询二次弹）+ 60s 新鲜度门。
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, createEffect, untrack } from "solid-js";
import * as ot from "@opentui/solid";
const { createElement, insert, setProp } = ot as any; // 低层原语（@opentui/solid 导出，宿主注入运行时实例）
import { Wf } from "../shared/rpc.ts";
import { STAGE_ORDER, STAGE_LABEL, FOLD, CANON } from "../shared/phases.ts";

const TUI_BUILD = "M16-p3-schoolA";
const ROWS = 20;

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const sanitize = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[\r\n]+/g, " ");

// 元素工厂（usage-monitor element() 范式）：props 跳 undefined；children 过滤 null/undefined/false；
// 文本永远是字符串且非空（空槽单空格 " "——opentui orphan text 教训）
function el(tag: string, props: Record<string, any>, children: any[] = []): any {
  const node = createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined) setProp(node, k, v);
  }
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) insert(node, c);
  }
  return node;
}
const txt = (value: string, fg: any): any => el("text", { fg }, [sanitize(value || " ")]);

const stageOf = (phase: any) => {
  const p = FOLD[phase] ?? phase;
  const i = STAGE_ORDER.indexOf(p);
  return i < 0 ? 0 : i;
};

const listLine = (x: any) => {
  const r = x?.rounds ?? {};
  return `${str(x?.slug || "(未定)")} · ${str(x?.phase ?? "?")} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
};

// 文案模板与 r29f 逐字一致：恒定 20 行（分隔线/slug/阶段/进度/轮次/关卡/产物），空槽 " "
const buildRows = (s: any, err: string | null, oth: string[], othScope: string, T: any) => {
  const t: string[] = new Array(ROWS).fill(" ");
  const c: string[] = new Array(ROWS).fill(T.text.muted);
  t[0] = "── wf ──────────────";
  t[ROWS - 1] = "──────────────────────";
  if (err) {
    t[1] = `wf 错误: ${err}`; c[1] = T.text.feedback.error;
    return { t, c };
  }
  if (!s) {
    t[1] = "  wf: …";
    return { t, c };
  }
  if (!s.active) {
    if (oth.length > 0) {
      t[1] = `  活动任务·${othScope}`; c[1] = T.text.base;
      for (let n = 0; n < 3; n++) { if (oth[n]) { t[2 + n] = `  ${oth[n]}`; c[2 + n] = T.text.action.primary; } }
    } else {
      t[1] = "  wf: 本会话无活动任务";
    }
    return { t, c };
  }
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
  return { t, c };
};

export default Plugin.define({
  id: "wf-workflow-tui",
  setup(context: any) {
    const debug = context?.options?.debug === true;
    const compact = context?.options?.compact === true;
    const REPO = String(context?.location?.directory ?? "");
    const LOADED_AT = new Date().toISOString();
    // 探针收敛（方案 2.5）：默认关，options.debug=true 时写 .workflow/_debug/tui-refresh.log
    const probe = (data: Record<string, unknown>) => {
      if (!debug) return;
      (async () => {
        try {
          const fs = await import("node:fs");
          const dir = `${REPO}/.workflow/_debug`;
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(`${dir}/tui-refresh.log`, JSON.stringify({ at: new Date().toISOString(), build: TUI_BUILD, loadedAt: LOADED_AT, ...data }) + "\n");
        } catch { /* 探针失败不影响 UI */ }
      })();
    };
    probe({ evt: "loaded" });

    // ── 数据层 ─────────────────────────────────────────────────────
    const [snap, setSnap] = createSignal<any>(null); // { st, oth, othScope, err }
    let latestSid = "";
    const shown = new Set<string>();
    const myDir = () => String(context?.location?.directory ?? "");
    const rpc = () => context.client.rpc(Wf);
    const rpcOpts = () => {
      const d = myDir();
      return d ? { location: { directory: d } } : {};
    };
    // 事件按 location 过滤（P0 发现①：多 location 实例并存，事件全 folder 广播）
    const locOk = (e: any) => {
      const d = String(e?.location?.directory ?? "");
      return !d || !myDir() || d === myDir();
    };

    const toastReport = (d: any, chan: string) => {
      const sid = String(d?.sessionID ?? "");
      const text = str(d?.text);
      const at = str(d?.at);
      probe({ reportEv: "recv", chan, got: sid, cur: latestSid, chars: text.length });
      try {
        if (sid !== latestSid || !text) return;
        if (at) {
          const age = Date.now() - Date.parse(at);
          if (Number.isFinite(age) && age > 60000) { probe({ reportEv: "stale-skipped", chan }); return; }
          const key = sid + "|" + at;
          if (shown.has(key)) { probe({ reportEv: "dup-skipped", chan }); return; }
          shown.add(key);
          if (shown.size > 50) { const first = shown.values().next().value; if (first !== undefined) shown.delete(first); }
        }
        context.ui.toast.show({ message: text, variant: "info" });
        probe({ reportEv: "toast-shown", chan });
      } catch (er) { probe({ reportEv: "toast-err", err: str((er as Error)?.message ?? er) }); }
    };

    let lastFp = "";
    const refresh = async () => {
      const sid = latestSid;
      if (!sid) return;
      try {
        const s = await rpc().state({ sessionID: sid }, rpcOpts());
        if (s?.lastReport) toastReport(s.lastReport, "poll");
        let oth: string[] = [];
        let othScope = "";
        if (!s?.active) {
          // 回退列表：本项目活跃任务 → 全局（M15 语义保留）
          let pid = null;
          let dir = null;
          try {
            const cs = context.data?.session?.get(sid);
            pid = cs?.projectID ?? null;
            dir = cs?.location?.directory ?? null;
          } catch { }
          try {
            const mine = await rpc().list(pid ? { projectID: String(pid), ...(dir ? { directory: String(dir) } : {}) } : {}, rpcOpts());
            const act = (Array.isArray(mine?.sessions) ? mine.sessions : []).filter((x: any) => x?.phase && x.phase !== "done").slice(0, 3);
            if (act.length) {
              oth = act.map(listLine); othScope = "本项目";
            } else {
              const allR = await rpc().list({}, rpcOpts());
              const cross = (Array.isArray(allR?.sessions) ? allR.sessions : []).filter((x: any) => x?.phase && x.phase !== "done").slice(0, 3);
              if (cross.length) { oth = cross.map(listLine); othScope = "全局·其它项目"; }
            }
          } catch { /* 回退列表失败按无处理 */ }
        }
        // fingerprint 门禁：无真实变化绝不发信号（OpenTUI 不短路赋值，bump 即全树重建重绘）
        const fp = JSON.stringify([s ?? null, oth, othScope]);
        if (fp !== lastFp) {
          lastFp = fp;
          probe({ evt: "refresh", sid, active: !!s?.active, othN: oth.length });
          setSnap({ st: s ?? { active: false }, oth, othScope, err: null });
        }
      } catch (e) {
        const msg = str((e as Error)?.message ?? e);
        probe({ evt: "refresh-err", err: msg });
        const fp = "ERR:" + msg;
        if (fp !== lastFp) { lastFp = fp; setSnap({ st: null, oth: [], othScope: "", err: msg }); }
      }
    };

    // 主轨命令：RPC exec 本地执行（返回值渲染；同 at 登记去重键，压掉事件/轮询二次弹）
    const execLocal = async (name: string, promptText: string) => {
      try {
        const r = await rpc().exec({ sessionID: latestSid, name, prompt: promptText }, rpcOpts());
        if (r?.text) toastReport({ sessionID: latestSid, text: r.text, at: r.at }, "local");
        await refresh();
      } catch (e) {
        context.ui.toast.show({ message: `wf 执行失败：${str((e as Error)?.message ?? e)}`, variant: "error" });
      }
    };

    // 事件通道（P0④ 五条件版真机已通）+ data.listen 兜底
    const offUpdated = rpc().events.on("updated", (e: any) => { if (locOk(e)) refresh(); });
    const offReport = rpc().events.on("report", (e: any) => {
      if (!locOk(e)) return;
      toastReport(e && typeof e === "object" && "data" in e ? (e as any).data : e, "rpc");
    });
    let offData: any = null;
    try {
      offData = context.data?.listen?.((ev: any) => {
        const details = ev?.details ?? ev;
        const type = String(details?.type ?? "");
        if (!type.startsWith("rpc.wf.")) return;
        if (!locOk(details)) return;
        const payload = details?.data ?? details;
        if (type === "rpc.wf.report") toastReport(payload, "data");
        else if (type === "rpc.wf.updated") refresh();
      });
    } catch { /* data.listen 不可用则走其余通道 */ }
    probe({ evt: "subscribed", hasDataListen: !!offData });

    const timer = setInterval(() => { refresh(); }, 5000);

    // ── 渲染：流派 A 稳定容器 ──────────────────────────────────────
    const renderError = (msg: string): any =>
      el("box", { width: "100%" }, [txt(`wf 渲染异常: ${msg}`, context.theme?.text?.feedback?.error ?? "red")]);

    const buildTree = (): any => {
      // accessor 内才读响应式（snap/sessionID/theme）——换树只发生在容器内部，
      // 由 Solid render effect 自管（宿主 nodes() memo 永不重跑 claim.render）
      const T = context.theme ?? { text: { muted: "gray", base: "white", feedback: { error: "red", success: "green" }, action: { primary: "cyan" } } };
      try {
        const data = snap();
        if (compact) {
          const s = data?.st;
          if (!s?.active) return txt(str(data?.err ? `wf 错误: ${data.err}` : "  wf: 无活动任务"), T.text.muted);
          const r = s.rounds ?? {};
          const label = STAGE_LABEL[s.phase] ?? str(s.phase ?? "?");
          return txt(`▶ ${label} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`, T.text.action.primary);
        }
        const { t, c } = buildRows(data?.st ?? null, data?.err ?? null, data?.oth ?? [], data?.othScope ?? "", T);
        return el("box", { flexDirection: "column" }, t.map((line: string, i: number) => txt(line, c[i])));
      } catch (e) {
        return renderError(str((e as Error)?.message ?? e));
      }
    };

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: any) => {
        // render 顶层：只建容器 + 一条 insert——零响应式读取（sessionID 经 untrack 同步取一次
        // + createEffect 跟随后续会话切换，读取不进宿主 nodes() memo）
        const container = el("box", { width: "100%", flexDirection: "column" });
        const syncSid = () => {
          const sid = String(input.sessionID ?? "");
          if (sid !== latestSid) {
            latestSid = sid;
            lastFp = "";
            refresh();
          }
        };
        untrack(syncSid);
        createEffect(syncSid);
        insert(container, () => buildTree());
        return container;
      },
    });

    // ── 命令主轨：quota 式 return 键拦截（P0⑧；run 必须同步返回，Promise 即算已处理）──
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
          void execLocal(name, promptText);
          probe({ evt: "intercept-hit", name });
          return true;
        },
      }],
    }));

    return () => {
      try { clearInterval(timer); } catch { }
      try { offUpdated?.(); } catch { }
      try { offReport?.(); } catch { }
      try { offData?.(); } catch { }
      try { unregister?.(); } catch { }
    };
  },
});
