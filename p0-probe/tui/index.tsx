// P0 契约探针 — TUI 部件（P0 完成即整体删除）。
// 覆盖探测项：①本地 slash 命令→toast/dialog/②流派 A 容器（恒定 container + 唯一 insert accessor，
// 信号更新→容器内整树重建——真机帧循环下验证「不崩」）/③RPC methods（带/不带 location 对照）/
// ④RPC events（5 条件全满足版：同 id 定义、声明齐全、object payload、await+catch、按 location 过滤）/
// ⑥bun:sqlite TUI 只读直连 + sessionID→directory 解析链路/⑦冒号 slash 名/⑧return 拦截与 server 同名共存/
// ⑨server.connected 重拉（订阅存活证据）。
// 证据统一写 .workflow/_debug/p0.log（role=tui）。
import { Plugin } from "@opencode/plugin/tui";
import { createSignal, onCleanup } from "solid-js";
import * as ot from "@opentui/solid";
import { Probe } from "../shared/rpc.ts";

// 低层原语（宿主 peer 实例）——类型以实测为准，走 any 别名避免版本签名差异
const { createElement, insert, setProp } = ot as any;

const REPO = "/home/zhuchentong/Projects/zhuchentong/opencode-team";
const DIR = `${REPO}/.workflow/_debug`;
const DB_PATH = `${DIR}/probe.db`;
const BUILD = "P0-probe-tui-v1";

let seq = 0;
const log = (ev: string, data: Record<string, unknown> = {}) => {
  (async () => {
    try {
      const fs = await import("node:fs");
      fs.mkdirSync(DIR, { recursive: true });
      fs.appendFileSync(`${DIR}/p0.log`, JSON.stringify({ at: new Date().toISOString(), role: "tui", build: BUILD, ev: `${ev}#${++seq}`, ...data }) + "\n");
    } catch { /* 探针日志失败不影响探测主体 */ }
  })();
};
const errMsg = (e: unknown) => String((e as Error)?.message ?? e);
const sanitize = (s: string) => (String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, 120) || " ");

// ── 流派 A 节点构造（usage-monitor 纪律）──────────────────────────
function textEl(s: string, fg?: string) {
  const t = createElement("text");
  try { if (fg) setProp(t, "fg", fg); } catch { /* ignore */ }
  setProp(t, "truncate", true);
  insert(t, [sanitize(s)]);
  return t;
}
function boxEl(children: unknown[]) {
  const b = createElement("box");
  setProp(b, "width", "100%");
  setProp(b, "flexDirection", "column");
  for (const c of children) if (c !== null && c !== undefined && c !== false) insert(b, c);
  return b;
}

export default Plugin.define({
  id: "wf-p0-probe-tui",
  async setup(context: any) {
    log("loaded", {
      hasSlot: typeof context?.ui?.slot === "function",
      hasKeymap: typeof context?.keymap?.layer === "function",
      hasDialog: typeof context?.ui?.dialog?.show === "function",
      hasDataListen: typeof context?.data?.listen === "function",
      hasDataSessionGet: typeof context?.data?.session?.get === "function",
      hasRendererEditor: !!context?.renderer,
    });

    // ── 观测计数（流派 A 锚：containers/inserts 必须恒为 1；builds 增长=容器内重建）──
    let containers = 0;
    let insertsN = 0;
    let builds = 0;
    const last = {
      nonce: "-", recvOn: 0, recvListen: 0,
      whereNoLoc: "-", whereLoc: "-",
      db: "-", sessionDir: "-", serverConn: 0,
    };

    // accessor 读的**唯一**信号（顶层零信号读取——render 永不因信号重跑）
    const [snap, setSnap] = createSignal<any>({ tick: 0, lines: ["p0 初始化…"] });
    let lastFp = "";
    let curSid = "";

    // ── ② 流派 A sidebar：render 只建一次恒定容器 + 唯一一条 insert ──
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (input: any) => {
        containers += 1;
        const container = createElement("box");
        setProp(container, "width", "100%");
        setProp(container, "flexDirection", "column");
        insert(container, () => {
          // 信号与宿主 input 全部在 accessor 内读 → 更新只重跑本函数、容器内换树
          builds += 1;
          if (builds === 1 || builds === 2 || builds === 5 || builds === 10 || builds % 20 === 0) {
            log("build", { n: builds, containers, insertsN });
          }
          try {
            curSid = String(input?.sessionID ?? "");
            const s = snap();
            const lines = [`p0 ${BUILD.slice(3)} tick:${s.tick}`, ...((s.lines as string[]) ?? [])];
            return boxEl(lines.map((l: string, i: number) => textEl(l, i === 0 ? "#7dd3fc" : undefined)));
          } catch (e) {
            log("render-ERR", { err: errMsg(e) });
            return boxEl([textEl("p0 render error", "#f87171")]);
          }
        });
        insertsN += 1;
        log("slot-render", { containers, insertsN }); // containers>1 = render 被重跑的实证（应避免）
        return container;
      },
    });

    // ── ③ RPC methods：不带 location（应在 server 自己 folder 执行）vs 带 location ──
    const callWhere = async () => {
      try {
        const rpc = context.client.rpc(Probe);
        const a: any = await rpc.where({ ping: "noloc" });
        last.whereNoLoc = String(a?.directory ?? "?");
      } catch (e) { last.whereNoLoc = `ERR:${errMsg(e)}`; }
      try {
        const rpc = context.client.rpc(Probe);
        const b: any = await rpc.where({ ping: "loc" }, { location: { directory: REPO } });
        last.whereLoc = String(b?.directory ?? "?");
      } catch (e) { last.whereLoc = `ERR:${errMsg(e)}`; }
      log("where-pair", { noloc: last.whereNoLoc, loc: last.whereLoc });
    };

    // ── ⑥ TUI 直读 sqlite（只读）+ sessionID→directory 解析链路 ──
    const readDb = async () => {
      try {
        const sess = context.data?.session?.get?.(curSid);
        last.sessionDir = String(sess?.location?.directory ?? "(null)");
        const { Database } = await import("bun:sqlite");
        const db = new Database(DB_PATH, { readonly: true });
        try {
          const rows = db.query("SELECT COUNT(*) AS c FROM writes").get() as any;
          last.db = `ok rows:${rows?.c ?? "?"}`;
        } finally { db.close(); }
      } catch (e) { last.db = `ERR:${errMsg(e)}`; }
    };

    // 数据刷新：读 DB + 组装指纹；fingerprint 无变化 → 不发信号（流派 A 铁律）
    const refresh = async () => {
      await readDb();
      log("refresh", { db: last.db, sessionDir: last.sessionDir }); // ⑥ 证据落日志（db 直读结果/目录解析链路）
      const lines = [
        `db:${last.db} dir:${last.sessionDir}`,
        `loc:${last.whereLoc} noloc:${last.whereNoLoc}`,
        `recv on:${last.recvOn} listen:${last.recvListen} nonce:${last.nonce}`,
        `conn:${last.serverConn} sid:${curSid.slice(0, 12) || "(none)"}`,
      ];
      const fp = lines.join("|");
      if (fp === lastFp) return; // no-op 不发信号
      lastFp = fp;
      setSnap({ tick: (snap()?.tick ?? 0) + 1, lines }); // tick 恒增 → 每次都是「真实变化→容器内重建」路径
    };

    // ── ④ events（5 条件全满足版）：onCleanup 管理的订阅 ──
    let disposeSub: any = null;
    try {
      disposeSub = context.client.rpc(Probe).events.on("changed", (e: any) => {
        const d = e && typeof e === "object" && "data" in e ? (e as any).data : e;
        const locDir = String(e?.location?.directory ?? "");
        last.recvOn += 1;
        last.nonce = String(d?.nonce ?? "?");
        log("changed-recv", { nonce: last.nonce, locDir, want: REPO, recvOn: last.recvOn });
        refresh().catch(() => { /* ignore */ });
      });
      log("subscribed", { ok: true });
    } catch (e) {
      log("subscribed", { ok: false, err: errMsg(e) });
    }
    // ④ 兜底通道：全事件流路由（quota 同构）——on 不通而 listen 通 = 定位 subclient 层
    let offListen: any = null;
    try {
      offListen = context.data?.listen?.(({ details }: any) => {
        const t = String(details?.type ?? "");
        if (t.startsWith("rpc.wf.p0.probe")) {
          last.recvListen += 1;
          log("listen-recv", { type: t, locDir: String(details?.location?.directory ?? ""), recvListen: last.recvListen });
        }
      });
      log("listen-attached", { ok: !!offListen });
    } catch (e) { log("listen-attach-ERR", { err: errMsg(e) }); }
    // ⑨ 断线补偿：server.connected 重拉 + 记录（其后 changed-recv 若恢复=订阅在共享 SSE 上自动续）
    try {
      const offConn = context.data?.on?.("server.connected", () => {
        last.serverConn += 1;
        log("server-connected", { n: last.serverConn });
        callWhere().catch(() => { /* ignore */ });
        refresh().catch(() => { /* ignore */ });
      });
      onCleanup(() => { try { offConn?.(); } catch { /* ignore */ } });
    } catch (e) { log("data-on-ERR", { err: errMsg(e) }); }

    // ── ① 本地 slash 命令（无冒号对照组）→ toast + dialog ──
    try {
      const un1 = context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "probe.dlg",
            title: "P0 probe dialog",
            group: "Probe",
            palette: true,
            slash: { name: "probe" },
            run: () => {
              log("slash-run", { name: "probe" });
              context.ui.toast.show({ title: "p0", message: `toast ok ${new Date().toISOString().slice(11, 19)}`, variant: "info", duration: 4000 });
              context.ui.dialog.show(() => boxEl([
                textEl("P0 probe dialog"),
                textEl(`recv:${last.recvOn}/${last.recvListen} db:${last.db}`),
                textEl(`loc:${last.whereLoc}`),
              ]));
              context.ui.dialog.set({ size: "medium", centered: true }); // 先 show 再 set（cache-stats 注释）
            },
          },
        ],
      }));
      onCleanup(() => { try { un1?.(); } catch { /* ignore */ } });
      log("layer-slash-registered", { ok: true });
    } catch (e) { log("layer-slash-registered", { ok: false, err: errMsg(e) }); }

    // ── ⑦ 冒号 slash 名探测（注册可能同步 throw 或静默失效——皆记录）──
    try {
      const un2 = context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "probe.colon",
            title: "P0 colon slash 探测",
            palette: true,
            slash: { name: "wf:colon" },
            run: () => {
              log("slash-run", { name: "wf:colon" });
              context.ui.toast.show({ title: "p0", message: "colon slash OK", variant: "success", duration: 4000 });
            },
          },
        ],
      }));
      onCleanup(() => { try { un2?.(); } catch { /* ignore */ } });
      log("layer-colon-registered", { ok: true });
    } catch (e) { log("layer-colon-registered", { ok: false, err: errMsg(e) }); }

    // ── ⑧⑤ 主轨形态：return 键 priority-1 输入拦截（quota 式，同步 run，false 透传）──
    // 与 server 同名命令 wf:pingprobe 共存：命中 → 本地执行（不发 server）；这是「提交路径归属」探测本体
    try {
      const un3 = context.keymap.layer(() => ({
        priority: 1,
        commands: [
          {
            id: "probe.intercept",
            bind: "return",
            run: () => {
              const editor = context.renderer?.currentFocusedEditor;
              const t = String(editor?.plainText ?? "").trim();
              if (t.startsWith("/wf:pingprobe") || t.startsWith("/probe-local")) {
                try { editor?.clear?.(); } catch { /* ignore */ }
                log("intercept-hit", { t: t.slice(0, 40) });
                (async () => {
                  try {
                    const rpc = context.client.rpc(Probe);
                    const w: any = await rpc.where({ ping: "intercept" }, { location: { directory: REPO } });
                    context.ui.toast.show({ title: "p0 本地轨", message: `where=${w?.directory ?? "?"} pid=${w?.pid ?? "?"}`, variant: "info", duration: 5000 });
                    log("intercept-rpc-ok", { directory: String(w?.directory ?? "") });
                  } catch (e) {
                    context.ui.toast.show({ title: "p0 本地轨", message: `ERR ${errMsg(e)}`, variant: "error", duration: 6000 });
                    log("intercept-rpc-ERR", { err: errMsg(e) });
                  }
                })();
                return true; // 已处理
              }
              return false; // 同步透传（返回 Promise 即算已处理——绝不在此 return 异步值）
            },
          },
        ],
      }));
      onCleanup(() => { try { un3?.(); } catch { /* ignore */ } });
      log("layer-intercept-registered", { ok: true });
    } catch (e) { log("layer-intercept-registered", { ok: false, err: errMsg(e) }); }

    // ── 轮询引擎：2.5s（探测期高频；正式 ≤60s）+ 首轮延迟等 server 注册完成 ──
    const t1 = setTimeout(() => { callWhere().catch(() => { /* ignore */ }); refresh().catch(() => { /* ignore */ }); }, 2500);
    const timer = setInterval(() => { refresh().catch(() => { /* ignore */ }); }, 2500);

    // ④ 活性自检（agent-notifications 式简化版）：每 30s 主动 emit 一次由 server 做——
    // TUI 侧无法直接 emit；改为记录「距上次 recv 的时长」供人工断 SSE 观察。
    const heartbeat = setInterval(() => { log("heartbeat", { recvOn: last.recvOn, recvListen: last.recvListen, builds }); }, 30000);

    return () => {
      clearTimeout(t1);
      clearInterval(timer);
      clearInterval(heartbeat);
      try { disposeSub?.(); } catch { try { disposeSub?.dispose?.(); } catch { /* ignore */ } }
      try { offListen?.(); } catch { /* ignore */ }
      try { unregister?.(); } catch { /* ignore */ }
      log("cleanup", { containers, insertsN, builds });
    };
  },
});
