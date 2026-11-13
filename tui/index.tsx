// wf-workflow TUI 插件（P5 产物入口：vite 打包 dist/tui.js 单文件入库）
// ── P3b 结论（真机实证）：slot render 顶层零响应式 + 唯一 accessor 换树 = 不崩（containers:1，
//    崩溃形态 e.length 见 HOST-CONTRACT.md / LRN-20261111-006）。本文件=装配+slot render 顶层
//    （R3 T3.4 拆分：渲染纯函数 panel.tsx / 通知层 notify.ts / 键拦截 exec-intercept.ts /
//    去重薄封装 dedup.ts / 共用小工具 util.ts——约束本体不动，P4 静态守卫范围随拆分扩展）。
// ── P4 新增（方案 §2.4 通知层）：
// ① server.connected 重拉：官方 goal.tsx 三件套第三件——SSE 断线窗口内丢失的 rpc.* 事件不重放，
//   重连信号到达即 lastFp 重置 + refresh()，配合 60s 新鲜度门保证窗口期报告由 poll 通道必达；
// ② attention.notify：level==="warn" 才弹（结构化 level 由 server 判定，notification-brief-display T04）
// ③ 事件订阅统一 AbortSignal（dispose 一处收口）
// 数据通道：RPC methods（state/list/exec，location 必带）主 + updated/report 事件 + data.listen
//   兜底 + server.connected 重拉 + 5s 轮询对账；事件按 location.directory 过滤（P0 多实例发现）。
// toast：sessionID|at 去重（exec 返回同一 at，本地渲染先行登记，防事件/轮询二次弹）+ 60s 新鲜度门
//   （门 60s ≫ 轮询 5s：任何存活窗口内的报告最迟 5s 被 poll 捞到且仍在门内——轮询必达成对设计）。
// 探针：无条件写 .workflow/_debug/tui-refresh.log（低量：loaded/slot-render/build 抽样/
//   refresh 变化时/recv 每次到达/notify/server-connected）。
import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { Wf } from "../shared/rpc.ts";
import { VERSION } from "../shared/version.ts"; // M16-r39 T08：版本归一（server/TUI 同源）
import { createDeduper } from "./dedup.ts"; // R3 T3.3：去重单实现（server/TUI 共用；薄封装）
import { setupNotify } from "./notify.ts"; // R3 T3.4：toast+OS 通知层
import { boxEl, textEl, buildRows, zhOf, insert, setProp, setupArtifactPreview } from "./panel.tsx"; // R3 T3.4：渲染层
import { installExecIntercept } from "./exec-intercept.ts"; // R3 T3.4：return 键拦截
import { str, errMsg, setupProbe } from "./util.ts";
import { setupRefresh } from "./data.ts"; // R3 T3.4：对账拉取

const TUI_BUILD = VERSION;
// harness/外部消费兼容面（拆分后仍可经 index 命名导入——实现体在 panel.tsx）
export { briefOf, buildRows, listLine, dispW, fmtElapsed } from "./panel.tsx";
export default Plugin.define({
  id: "wf-workflow-tui",
  setup(context: any) {
    const compact = context?.options?.compact === true || process.env.WF_COMPACT === "1"; // M16-r39 T11：env 开关（options 不传达 TUI 的主路径）
    const { REPO, probe } = setupProbe(context, { build: TUI_BUILD }); // R3 T3.4：探针工厂拆 util.ts
    // loaded 探针带 options 形状（真机已证：{package,options} 的 options 未传达 TUI → context.options={}；
    //  因此 debug 探针无条件写，compact 选项当前实际不可用——P6 文档注明）
    probe({ evt: "loaded", repo: REPO, options: JSON.stringify(context?.options ?? null), loc: str(context?.location?.directory), hasSlot: typeof context?.ui?.slot === "function", hasKeymap: typeof context?.keymap?.layer === "function", hasDataListen: typeof context?.data?.listen === "function", hasDataOn: typeof context?.data?.on === "function", hasAttention: typeof context?.attention?.notify === "function", hasRendererEditor: !!context?.renderer });

    // ── 数据层（全部拉取只发生在 timer/microtask/事件回调——追踪上下文之外）──
    const [snap, setSnap] = createSignal<any>(null); // { st, oth, othScope, err }
    let latestSid = "";
    // R3 T3.3：三通道（exec/事件/轮询）共用同一 deduper 实例（语义与原 shown Set+60s 门+cap50 逐字等价）
    const ac = new AbortController(); // P4③：事件订阅统一经 AbortSignal
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

    // ── R3 T3.4：通知层 + 去重单实例（三通道共用；原 setup 内联段拆 notify.ts/dedup.ts）──
    const dedupe = createDeduper();
    const { makeToastReport } = setupNotify(context, probe); // notifyImportant 由 toastReport 内部消费
    const toastReport = makeToastReport(() => latestSid, dedupe);

    // ── R3 T3.4：产物预览 route 装配（拆 panel.tsx；routerOk 供 exec 拦截/渲染点击分派）──
    const { openArtifact, routerOk } = setupArtifactPreview(context, { probe, getSid: () => latestSid, rpc, rpcOpts });
    // ── R3 T3.4：对账拉取（拆 data.ts；toastReportRef 由 toastReport 建立后回填）──
    const { refresh, markStale } = setupRefresh(context, { probe, getSid: () => latestSid, rpc, rpcOpts, setSnap, toastReport });


    // 主轨命令：RPC exec 本地执行（返回值渲染；同 at 登记去重键，压掉事件/轮询二次弹）
    const execLocal = async (name: string, promptText: string) => {
      try {
        const r = await rpc().exec({ sessionID: latestSid, name, prompt: promptText }, rpcOpts());
        // notification-brief-display T04（C 意见）：透传 brief/level——否则本地通道丢新字段，
        // toast 永远走 text 降级（exec 通道 toast=brief 的断言在 harness P9 锁死）
        if (r?.text) toastReport({ sessionID: latestSid, text: r.text, at: r.at, brief: r.brief, level: r.level }, "local");
        await refresh();
      } catch (e) {
        context.ui.toast.show({ message: `wf 执行失败：${errMsg(e)}`, variant: "error" });
      }
    };

    // 事件通道（P0④ 五条件版真机已通）+ data.listen 兜底 + P4③ AbortSignal
    const offUpdated = rpc().events.on("updated", (e: any) => { if (locOk(e)) void refresh(); }, { signal: ac.signal });
    const offReport = rpc().events.on("report", (e: any) => {
      if (!locOk(e)) return;
      toastReport(e && typeof e === "object" && "data" in e ? (e as any).data : e, "rpc");
    }, { signal: ac.signal });
    let offData: any = null;
    try {
      offData = context.data?.listen?.((ev: any) => {
        const details = ev?.details ?? ev;
        const type = String(details?.type ?? "");
        if (!type.startsWith("rpc.wf.")) return;
        if (!locOk(details)) return;
        const payload = details?.data ?? details;
        if (type === "rpc.wf.report") toastReport(payload, "data");
        else if (type === "rpc.wf.updated") void refresh();
      });
    } catch { /* data.listen 不可用则走其余通道 */ }
    // P4① server.connected 重拉（goal.tsx 三件套：断线窗口丢失的 rpc.* 不重放，重连即全量补偿）
    let offConn: any = null;
    try {
      offConn = context.data?.on?.("server.connected", () => {
        probe({ evt: "server-connected" });
        markStale(); // 强制重拉（服务端可能已换/事件窗口有损）
        void refresh();
      });
    } catch { /* data.on 不可用则轮询兜底 */ }
    probe({ evt: "subscribed", hasDataListen: !!offData, hasConn: !!offConn });

    const timer = setInterval(() => { void refresh(); }, 5000);

    // ── 渲染：P0 探针逐字形态（真机 build 30+ 次容器内换树零崩溃）——P4 禁改（harness 守卫）──
    let containers = 0;
    let builds = 0;

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: any) => {
        // render 顶层：只建容器 + 一条 insert + 返回——零响应式读取、零调用外部函数
        containers += 1;
        const container = boxEl([]);
        insert(container, () => {
          // 一切响应式读取（input.sessionID/snap/theme）只在本 accessor 内——
          // 变化只重跑本函数、容器内换树（Solid 自管 render effect，宿主 claim.render 永不重跑）
          builds += 1;
          if (builds === 1 || builds === 2 || builds === 5 || builds % 20 === 0) {
            probe({ evt: "build", n: builds, containers, sid: str(input?.sessionID), hasSnap: !!snap() });
          }
          try {
            const sid = String(input?.sessionID ?? "");
            if (sid && sid !== latestSid) {
              latestSid = sid;
              markStale();
              queueMicrotask(() => { void refresh(); }); // 拉取推迟出追踪上下文（P3a 根因②的修复）
            }
            const T = context.theme ?? { text: { muted: "gray", base: "white", feedback: { error: "red", success: "green" }, action: { primary: "cyan" } } };
            const data = snap();
            if (compact) {
              const s = data?.st;
              if (!s?.active) return textEl(str(data?.err ? `wf 错误: ${data.err}` : "  wf: 无活动任务"), T.text.muted);
              const rr = s.rounds ?? {};
              const label = zhOf(s.phase);
              const badge = s.mode === "daily" ? `[daily·${str(s.size || "M")}] ` : "";
              return textEl(`▶ ${badge}${label} ${rr.plan_review ?? 0}/${rr.build_review ?? 0}/${rr.test_fix ?? 0}`, T.text.action.primary);
            }
            // tui-sidebar-elapsed：now=Date.now() 驱动进行中/总耗时；W=pane 宽（fail-soft 取不到/非正数回退 80，下限 24）
            const W = Math.max(24, Math.floor(Number(context?.renderer?.width)) || 80);
            const { t, c, af } = buildRows(data?.st ?? null, data?.err ?? null, data?.oth ?? [], data?.othScope ?? "", T, Date.now(), W);
            return boxEl(t.map((line: string, i: number) => {
              const el = textEl(line, c[i]);
              // M16-r46 批2：可点击产物行绑 onMouseDown（探针③本地实证：setProp 转发到
              // Renderable，mockMouse 命中触发；宿主默认 mouse:true）。setProp 失败静默
              // （非 TUI 环境/测试 renderer 不支持时不崩——同 fg 形态 try/catch）。
              const f = af?.[i];
              if (f) { try { setProp(el, "onMouseDown", () => { void openArtifact(f); }); } catch { /* ignore */ } }
              return el;
            }));
          } catch (e) {
            probe({ evt: "render-ERR", err: errMsg(e) });
            return boxEl([textEl(`wf 渲染异常: ${errMsg(e)}`, "red")]);
          }
        });
        probe({ evt: "slot-render", containers }); // containers>1 = 宿主重跑 render 的实证（应避免）
        return container;
      },
    });


    // ── 命令主轨：return 键拦截（R3 T3.4 拆 exec-intercept.ts；quota 式 P0⑧ 语义不变）──
    installExecIntercept(context, { execLocal, openArtifact, isRouterOk: () => routerOk, probe });


    return () => {
      try { clearInterval(timer); } catch { }
      try { ac.abort(); } catch { }
      try { offUpdated?.(); } catch { }
      try { offReport?.(); } catch { }
      try { offData?.(); } catch { }
      try { offConn?.(); } catch { }
      try { unregister?.(); } catch { }
    };
  },
});
