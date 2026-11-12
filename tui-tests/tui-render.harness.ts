// tui-render.harness.ts — wf-workflow TUI 插件本地渲染测试（P3 流派 A 版）
//
// 历史（ERR-20261110-005/009）：宿主 slot 内「信号更新→返回 JSX 的函数子节点重建整棵子树
// 并换入」必崩 e.length。P3 重设计采用流派 A（usage-monitor/agents-sidebar 真机背书 +
// P0② 本机探针验证）：slot render 只建一次恒定 container，容器内唯一一条
// insert(container, () => buildTree())，信号变化由 Solid 自管 render effect 在容器内换树。
//
// 断言面：
//   P0 slot 注册面（只有 sidebar，面板不得回归）
//   P4 源码静态守卫（流派 A 结构 + 防退化模式）
//   P5 挂载渲染：render 返回单一元素 + testRender 帧不崩
//   P6 report 事件 → toast（本会话弹/跨会话拦）
//   P7 data.listen 兜底通道 + sessionID|at 去重 + 60s 新鲜度门
//   P8 轮询对账：updated 事件触发 refresh → state.lastReport → toast + 同 at 去重
//   P9 return 键拦截主轨：非 /wf: 同步 false 透传；命中 → 清空编辑器 → RPC exec → toast
//   P11 表格化 buildRows 纯函数直测（模式语义 + 列对齐 + 轮次归属 + 尾部关卡/产物）
//   P12 表格真渲染复核：静态树 captureCharFrame，OpenTUI 自身宽度计算验证列对齐
//
// 已知限制（保真度盲区）：testRender 帧循环不推进 renderEffect 更新提交——
// 信号→换树的端到端断言在本地不可靠，由 P0 真机探针 + 静态守卫代劳。
//
// 运行：bun tui-tests/tui-render.harness.ts
import * as fs from "node:fs";

// ── 自举：确保虚拟模块占位包存在（node_modules 在 .gitignore 中，克隆后首次运行需生成）──
// 注意：必须先于下方对 tui/index.tsx 的动态 import 执行
const mockDir = new URL("../node_modules/@opencode/plugin/", import.meta.url).pathname;
if (!fs.existsSync(mockDir)) {
  fs.mkdirSync(mockDir, { recursive: true });
  fs.writeFileSync(
    `${mockDir}package.json`,
    JSON.stringify({
      name: "@opencode/plugin", version: "0.0.0-local-mock", private: true, type: "module",
      description: "本地 TUI harness 占位：宿主运行时用自己的 onResolve alias 优先拦截 @opencode/plugin/*，此包仅在本地 harness 兜底，语义与宿主一致（define 仅透传配置对象）。",
      exports: { "./tui": "./mock-tui.js", "./rpc": "./mock-rpc.js" },
    }, null, 2),
  );
  fs.writeFileSync(`${mockDir}mock-tui.js`, "export const Plugin = { define: (def) => def };\n");
  fs.writeFileSync(`${mockDir}mock-rpc.js`, "export const Rpc = { define: (def) => def };\n");
  console.log("（已生成本地虚拟模块占位包 node_modules/@opencode/plugin）");
}

// 虚拟模块解析依赖上面的占位包，须动态 import（静态 import 会提升到自举之前）
// @ts-ignore bun 原生支持 .tsx
const ns: any = await import("../tui/index.tsx");
const { default: mod, buildRows } = ns;
// M16-r37：表格化辅助（红阶段占位兜底，实现后走真实导出；兜底按 ASCII 宽度必红不崩）
const dispW: (s: string) => number = ns.dispW ?? ((s: string) => String(s ?? "").length);
const listLine: (x: any) => string = ns.listLine ?? ((x: any) => String(x?.slug ?? ""));
const { testRender } = await import("@opentui/solid");

const errors: string[] = [];
let pass = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { errors.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── mock 宿主 context（与 index.tsx 用到的 API 面对齐）───────────────
const theme = {
  text: { base: "#fff", muted: "#888", action: { primary: "#0af" }, feedback: { error: "#f55", success: "#5f5" } },
};
function makeCtx() {
  const slots: Record<string, (props: any) => any> = {};
  const keymaps: any[] = [];
  let listSessions: any[] = [];
  const listeners: Array<{ name: string; cb: (data?: any) => void; opts?: any }> = [];
  const toasts: any[] = [];
  const notifies: any[] = [];
  const connCbs: any[] = [];
  const dataCbs: any[] = [];
  let stateReply: any = { active: false, slug: "", phase: null };
  let lastExec: any = null;
  const editor = { plainText: "", clear() { this.plainText = ""; } };
  const ctx = {
    theme,
    options: {},
    location: { directory: "/proj" },
    ui: {
      slot: (cfg: any) => { slots[cfg.append] = cfg.render; },
      panel: { open: () => false },
      toast: { show: (t: any) => { toasts.push(t); } },
    },
    keymap: { layer: (fn: any) => { keymaps.push(fn); } },
    renderer: { currentFocusedEditor: editor },
    client: {
      rpc(_def: any) {
        return {
          state: async (_input: any) => stateReply,
          list: async (_input: any) => ({ sessions: listSessions }),
          exec: async (input: any) => { lastExec = input; return { text: "exec 报告", at: new Date().toISOString() }; },
          events: { on: (name: string, cb: () => void, opts?: any) => { listeners.push({ name, cb, opts }); return () => { }; } },
        };
      },
    },
    attention: { notify: (n: any) => { notifies.push(n); } },
    data: { session: { get: (_id: string) => ({ projectID: "p1", location: { directory: "/proj" } }) }, listen: (cb: any) => { dataCbs.push(cb); return () => { }; }, on: (type: string, cb: any) => { if (type === "server.connected") connCbs.push(cb); return () => { }; } },
  };
  return {
    ctx, slots, keymaps, listeners, toasts, dataCbs, editor, notifies, connCbs,
    setSessions: (s: any[]) => { listSessions = s; },
    setState: (s: any) => { stateReply = s; },
    getExec: () => lastExec,
  };
}

const t = mod as { id: string; setup: (ctx: any) => any };
const cleanups: Array<() => void> = [];
console.log(`插件 id: ${t.id}`);

// ── P0：slot 注册面（只有 sidebar，面板必须已移除）──────────────────
{
  const { ctx, slots } = makeCtx();
  const cleanup = t.setup(ctx as any);
  ok("P0 setup 注册了 sidebar.content slot", typeof slots["sidebar.content"] === "function");
  ok("P0 setup 未注册 session.panel（wf-board 已永久移除）", slots["session.panel"] === undefined);
  ok("P0 setup 返回 cleanup 函数", typeof cleanup === "function");
  cleanup?.();
}

// ── P4：源码静态守卫——流派 A 结构锁定 + 防退化（精确代码串，注释文本不受影响）─
{
  const src = await (await import("node:fs/promises")).readFile(new URL("../tui/index.tsx", import.meta.url), "utf8");
  ok("P4 无 WfBoardPanel 组件定义", !src.includes("function WfBoardPanel"));
  ok("P4 无 session.panel slot 注册代码", !src.includes('append: "session.panel"'));
  ok("P4 无 wf.board 面板打开命令", !src.includes('"wf.board"'));
  // 旧死点防退化（ERR-20261110-009）：IIFE 函数子节点模式不得回归
  ok("P4 全文件无 rc(IIFE) 子树重建模式", !src.includes("rc(() =>"));
  // 流派 A 结构锚：低层原语 + 容器内唯一 insert 动态点 + 恒定行数
  ok("P4 存在 insert(container, …) 唯一动态挂载点", src.includes("insert(container,"));
  ok("P4 存在 const ROWS = 20 恒定行数", src.includes("const ROWS = 20"));
  // 流派 A 不用 JSX/Show/memo 声明式壳（防两个流派混用产生未验证形态）
  ok("P4 渲染走低层原语而非 JSX 元素", !src.includes("<box") && !src.includes("<text"));
  ok("P4 无 createMemo 声明式壳", !src.includes("createMemo"));
  // P3b 防退化（P3a→P3b 真机崩溃根因偏离，p0-probe 真机实证形态之外一律禁止）：
  // render 顶层零 effect 创建（纯计算上下文禁区）、零同步外部调用（数据拉取经 microtask/timer/事件）
  ok("P4 无 effect 创建（P3a 偏离①回归禁止）", !src.includes("createEffect("));
  ok("P4 无 untrack 包裹（P3a 偏离①配套禁止）", !src.includes("untrack("));
  ok("P4 通知层①server.connected 重拉存在", src.includes('"server.connected"'));
  ok("P4 通知层②attention.notify 接入存在", src.includes("attention"));
  ok("P4 通知层③AbortSignal 统一订阅存在", src.includes("ac.abort()"));
}

// ── P5：挂载渲染——render 返回单一元素 + testRender 帧不崩 ───────────
{
  const { ctx, slots } = makeCtx();
  cleanups.push(t.setup(ctx as any)!);
  const sidebarRender = slots["sidebar.content"];
  try {
    let node: any = undefined;
    const setup = await testRender(() => { node = sidebarRender({ sessionID: "ses_y" }); return node; }, { width: 50, height: 24 });
    await setup.flush();
    await setup.flush();
    ok("P5 render 返回单一元素（非 undefined/函数/数组）",
      !!node && typeof node === "object" && !Array.isArray(node) && typeof node !== "function");
    const frame = setup.captureCharFrame();
    ok("P5 侧边栏挂载渲染不崩", true);
    ok("P5 帧含 Workflow 分隔线", frame.includes("── Workflow"), JSON.stringify(frame.slice(0, 80)));
    await setup.dispose();
  } catch (e: any) {
    ok("P5 侧边栏挂载渲染不崩", false, e?.message);
  }
}

// ── P6：report 事件 → toast（本会话弹/跨会话拦）─────────────────────
{
  const { ctx, slots, listeners, toasts } = makeCtx();
  cleanups.push(t.setup(ctx as any)!);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_z" }), { width: 50, height: 24 });
    await setup.flush();
    const reportCbs = listeners.filter((l) => l.name === "report");
    ok("P6 侧边栏订阅了 report 事件", reportCbs.length >= 1, `listeners=${listeners.map((l) => l.name).join(",")}`);
    reportCbs.forEach((l) => l.cb({ sessionID: "ses_z", text: "wf 健康检查报告" }));
    ok("P6 report 本会话 → toast 呈现", toasts.some((x) => x.message === "wf 健康检查报告" && x.variant === "info"));
    reportCbs.forEach((l) => l.cb({ sessionID: "ses_other", text: "跨会话报告" }));
    ok("P6 report 他会话 → 不弹 toast", !toasts.some((x) => x.message === "跨会话报告"));
    // 信封形状兼容（宿主事件实为 {type,location,data}）
    reportCbs.forEach((l) => l.cb({ sessionID: "ignored", data: { sessionID: "ses_z", text: "信封报告" } }));
    ok("P6 信封形状 → 解包后呈现", toasts.some((x) => x.message === "信封报告"));
    await setup.dispose();
  } catch (e: any) {
    ok("P6 report→toast 不崩", false, e?.message);
  }
}

// ── P7：data.listen 兜底 + sessionID|at 去重 + 新鲜度门 ─────────────
{
  const { ctx, slots, listeners, toasts, dataCbs } = makeCtx();
  cleanups.push(t.setup(ctx as any)!);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_d" }), { width: 50, height: 24 });
    await setup.flush();
    ok("P7 订阅了 data.listen 兜底通道", dataCbs.length >= 1);
    dataCbs.forEach((cb) => cb({ details: { type: "rpc.wf.report", data: { sessionID: "ses_d", text: "data 通道报告" } } }));
    ok("P7 data 通道 report → toast 呈现", toasts.some((x) => x.message === "data 通道报告"));
    dataCbs.forEach((cb) => cb({ details: { type: "session.idle", data: {} } }));
    ok("P7 非 rpc.wf 事件忽略", toasts.length === 1, `toasts=${toasts.length}`);
    // 去重：同一 (sessionID,at) 跨通道都到 → 只弹一次
    const n0 = toasts.length;
    const atNow = new Date().toISOString();
    dataCbs.forEach((cb) => cb({ details: { type: "rpc.wf.report", data: { sessionID: "ses_d", text: "dup 文本", at: atNow } } }));
    const rpCbs = listeners.filter((l) => l.name === "report");
    rpCbs.forEach((l) => l.cb({ sessionID: "ses_d", text: "dup 文本", at: atNow }));
    ok("P7 跨通道同 at 去重", toasts.length - n0 === 1, `新增 ${toasts.length - n0} 条（应为 1）`);
    // 新鲜度门：>60s 旧报告不弹
    const oldAt = new Date(Date.now() - 120000).toISOString();
    dataCbs.forEach((cb) => cb({ details: { type: "rpc.wf.report", data: { sessionID: "ses_d", text: "过期报告", at: oldAt } } }));
    ok("P7 60s 外旧报告不弹（新鲜度门）", !toasts.some((x) => x.message === "过期报告"));
    // location 过滤（P0 多实例并存发现）：异目录事件丢弃
    const n1 = toasts.length;
    dataCbs.forEach((cb) => cb({ details: { type: "rpc.wf.report", location: { directory: "/other" }, data: { sessionID: "ses_d", text: "他目录报告", at: new Date().toISOString() } } }));
    ok("P7 异 location 事件被过滤", toasts.length === n1 && !toasts.some((x) => x.message === "他目录报告"));
    await setup.dispose();
  } catch (e: any) {
    ok("P7 双通道不崩", false, e?.message);
  }
}

// ── P8：轮询对账通道——updated 事件触发 refresh → state.lastReport → toast ──
{
  const { ctx, slots, listeners, toasts, setState } = makeCtx();
  const at1 = new Date().toISOString();
  setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p8", text: "轮询报告", at: at1 } });
  cleanups.push(t.setup(ctx as any)!);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_p8" }), { width: 50, height: 24 });
    await setup.flush();
    await sleep(80); // 等 mount 时的 refresh（async RPC）落地
    ok("P8 refresh 读到 lastReport → toast 呈现", toasts.some((x) => x.message === "轮询报告"), `toasts=${JSON.stringify(toasts.map((x) => x.message))}`);
    // 同一 at 再次对账不重复弹
    const updCbs = listeners.filter((l) => l.name === "updated");
    updCbs.forEach((l) => l.cb({}));
    await sleep(80);
    const n = toasts.filter((x) => x.message === "轮询报告").length;
    ok("P8 同 at 跨轮询去重", n === 1, `弹了 ${n} 次（应为 1）`);
    // 新 at 的新报告 → 再弹
    setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p8", text: "轮询报告2", at: new Date().toISOString() } });
    updCbs.forEach((l) => l.cb({}));
    await sleep(80);
    ok("P8 新 at 报告呈现", toasts.some((x) => x.message === "轮询报告2"));
    await setup.dispose();
  } catch (e: any) {
    ok("P8 轮询通道不崩", false, e?.message);
  }
}

// ── P9：return 键拦截主轨（quota 式，P0⑧ 真机验证形态）─────────────
{
  const { ctx, slots, keymaps, toasts, getExec, editor, setState } = makeCtx();
  setState({ active: false, slug: "", phase: null });
  cleanups.push(t.setup(ctx as any)!);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_p9" }), { width: 50, height: 24 });
    await setup.flush();
    ok("P9 注册了 keymap layer", keymaps.length >= 1);
    const layer = keymaps[keymaps.length - 1]();
    ok("P9 拦截层 priority=1", layer.priority === 1);
    const cmd = layer.commands[0];
    // 非 /wf: 输入 → 同步返回 false 透传（返回 Promise 即算已处理——绝不允许）
    editor.plainText = "hello world";
    const r0 = cmd.run();
    ok("P9 非 wf 输入同步 false 透传", r0 === false, `typeof=${typeof r0}`);
    // 其它前缀（/other:）也透传
    editor.plainText = "/other:ping";
    ok("P9 非 /wf: 前缀透传", cmd.run() === false);
    // /wf:ping 参数 → 命中：清空编辑器 + 同步 true + exec 调用 + toast
    editor.plainText = "/wf:ping 额外参数";
    const r1 = cmd.run();
    ok("P9 /wf: 命中同步返回 true", r1 === true);
    ok("P9 命中后编辑器已清空", editor.plainText === "");
    await sleep(80);
    const ex = getExec();
    ok("P9 exec 调用携带 name/prompt/sessionID",
      ex?.name === "wf:ping" && ex?.prompt === "额外参数" && ex?.sessionID === "ses_p9", JSON.stringify(ex));
    ok("P9 exec 返回值 → toast 呈现", toasts.some((x) => x.message === "exec 报告"));
    await setup.dispose();
  } catch (e: any) {
    ok("P9 return 拦截不崩", false, e?.message);
  }
}

// ── P10：P4 通知层——server.connected 重拉 + attention.notify + AbortSignal ──
{
  const { ctx, slots, listeners, toasts, notifies, connCbs, setState } = makeCtx();
  const at1 = new Date().toISOString();
  setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p10", text: "连接初拉报告", at: at1 } });
  cleanups.push(t.setup(ctx as any)!);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_p10" }), { width: 50, height: 24 });
    await setup.flush();
    await sleep(80);
    ok("P10 events.on 订阅携带 AbortSignal", listeners.some((l) => l.opts && l.opts.signal && typeof l.opts.signal.aborted === "boolean"),
      `opts=${JSON.stringify(listeners.map((l) => ({ n: l.name, hasSig: !!l.opts?.signal })))}`);
    ok("P10 已订阅 server.connected", connCbs.length >= 1);
    ok("P10 初拉报告 toast 且非重要不 notify", toasts.some((x) => x.message === "连接初拉报告") && notifies.length === 0);
    // 模拟断线窗口：服务端更新报告（⚠️ 重要信号）但事件回调不到——重连信号触发重拉必达
    const at2 = new Date(Date.now() + 1000).toISOString();
    setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p10", text: "⚠️ 断线窗口报告", at: at2 } });
    connCbs.forEach((cb) => cb());
    await sleep(80);
    ok("P10 server.connected 重拉送达窗口期报告", toasts.some((x) => x.message === "⚠️ 断线窗口报告"));
    ok("P10 重要信号 → attention.notify", notifies.some((n) => String(n.message).includes("断线窗口报告")), JSON.stringify(notifies));
    // 普通信号只 toast 不 notify
    const at3 = new Date(Date.now() + 2000).toISOString();
    setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p10", text: "普通报告", at: at3 } });
    connCbs.forEach((cb) => cb());
    await sleep(80);
    ok("P10 普通报告 toast 且不触发 notify", toasts.some((x) => x.message === "普通报告") && notifies.length === 1, `notifies=${notifies.length}`);
    await setup.dispose();
  } catch (e: any) {
    ok("P10 通知层不崩", false, e?.message);
  }
}

// ── P11: M16-r37 侧边栏表格化——buildRows 纯函数直测（绕开 testRender 信号→换树盲区）──
// 布局锚：t0 头线/t1 slug/t2 进度/t4 表头/t5 细线/t6.. 阶段行（daily 6→6..11，full 9→6..14）；
// 尾段 cursor=6+n（剩余>3 行先插空行）→ 关卡/产物1/产物2；t18 提示行/t19 尾线。
// 列几何：1+2+1+8+2+4+2+4=24 cell；状态词起始偏移恒 14；轮次右对齐 4 cell。
{
  const T = theme;
  const base = { active: true, slug: "todo", rounds: {}, artifacts: {}, testPlanWritten: false, testReportVerdict: null };
  const statusAt = (row: string) => { const m = /(完成|进行|待办)/.exec(row); return m ? dispW(row.slice(0, m.index)) : -1; };
  // daily S：徽标 + 6 行表格 + 对齐 + 模式语义
  const s = buildRows({ ...base, mode: "daily", size: "S", phase: "building" }, null, [], "", T);
  ok("P11 daily S slug 行带 [daily·S] 徽标", s.t[1].includes("[daily·S]"), s.t[1]);
  ok("P11 daily building=F3 进度 3/6", s.t[2].includes("F3") && s.t[2].includes("3/6") && s.t[2].includes("●●●○○○"), s.t[2]);
  ok("P11 表头含 阶段/状态/轮次", s.t[4].includes("阶段") && s.t[4].includes("状态") && s.t[4].includes("轮次"), s.t[4]);
  const rows6 = s.t.slice(6, 12);
  ok("P11 daily 6 阶段行序号连续", rows6.every((r: string, k: number) => r.startsWith(` 0${k + 1} `)), JSON.stringify(rows6));
  ok("P11 daily 中文阶段名", rows6[0].includes("需求录入") && rows6[3].includes("执行") && rows6[5].includes("交付"), JSON.stringify(rows6));
  ok("P11 状态派生 完成/进行/待办", rows6[0].includes("完成") && rows6[3].includes("进行") && rows6[4].includes("待办"), JSON.stringify(rows6));
  ok("P11 阶段行状态列对齐（偏移=14）", rows6.every((r: string) => statusAt(r) === 14), JSON.stringify(rows6.map(statusAt)));
  ok("P11 阶段行等宽 24 cell（轮次右对齐）", rows6.every((r: string) => dispW(r) === 24), JSON.stringify(rows6.map(dispW)));
  ok("P11 进行行整行蓝高亮", s.c[9] === T.text.action.primary, s.c[9]);
  ok("P11 计划审核行挂 plan 轮次", s.t[8].includes("0/3"), s.t[8]);
  ok("P11 daily 测试行挂 fix 轮次", s.t[10].includes("0/3"), s.t[10]);
  ok("P11 daily 无 test-plan 假缺失", !s.t.some((r: string) => r.includes("test-plan")), JSON.stringify(s.t));
  ok("P11 daily S verify 显示自检", s.t[13].includes("自检"), s.t[13]);
  ok("P11 daily S plan-review 显示免", s.t[14].includes("免"), s.t[14]);
  ok("P11 其他产物计数行", s.t[15].includes("0 项"), s.t[15]);
  ok("P11 提示行 /wf:status", s.t[18].includes("/wf:status"), s.t[18]);
  // daily M：verify 关卡随 planReviewVerdict + plan-review 产物显式 + 其他产物不重复计数
  const m = buildRows({ ...base, mode: "daily", size: "M", phase: "review", planReviewVerdict: "PASS", artifacts: { "plan.md": { at: "x" }, "plan-review-r1.md": { at: "x" } } }, null, [], "", T);
  ok("P11 daily M verify PASS 可见", m.t[13].includes("verify") && m.t[13].includes("PASS"), m.t[13]);
  ok("P11 daily M verify PASS 绿色", m.c[13] === T.text.feedback.success, m.c[13]);
  ok("P11 daily M plan-review ✓", m.t[14].includes("plan-review") && m.t[14].includes("✓"), m.t[14]);
  ok("P11 daily M plan-review 不计入其他产物", m.t[15].includes("0 项"), m.t[15]);
  // daily done：满格 + 全行完成
  const d = buildRows({ ...base, mode: "daily", size: "S", phase: "done" }, null, [], "", T);
  ok("P11 daily done 6/6 满格", d.t[2].includes("6/6"), d.t[2]);
  ok("P11 daily done 全行完成", d.t.slice(6, 12).every((r: string) => r.includes("完成")), JSON.stringify(d.t.slice(6, 12)));
  // 轮次上限红警
  const cap = buildRows({ ...base, mode: "daily", size: "S", phase: "testing", rounds: { test_fix: 3 } }, null, [], "", T);
  ok("P11 轮次≥3 该行红色", cap.c[10] === T.text.feedback.error && cap.t[10].includes("3/3"), cap.t[10]);
  // 存量回归锚：无 mode（旧任务）/full → 9 行表格语义不变（行号重锚）
  const legacy = buildRows({ ...base, phase: "building" }, null, [], "", T);
  ok("P11 存量 building 仍 4/9", legacy.t[2].includes("4/9"), legacy.t[2]);
  const rows9 = legacy.t.slice(6, 15);
  ok("P11 存量 9 阶段行序号连续", rows9.every((r: string, k: number) => r.startsWith(` 0${k + 1} `)), JSON.stringify(rows9));
  ok("P11 存量阶段行同样对齐", rows9.every((r: string) => statusAt(r) === 14 && dispW(r) === 24), JSON.stringify(rows9.map(statusAt)));
  ok("P11 存量执行审核行挂 build 轮次", legacy.t[11].includes("执行审核") && legacy.t[11].includes("0/3"), legacy.t[11]);
  ok("P11 存量修复行挂 fix 轮次", legacy.t[13].includes("修复") && legacy.t[13].includes("0/3"), legacy.t[13]);
  ok("P11 存量 test-plan 关卡仍在", legacy.t[15].includes("test-plan"), legacy.t[15]);
  ok("P11 存量 test-plan.md 产物行仍在", legacy.t[16].includes("test-plan.md"), legacy.t[16]);
  ok("P11 存量 slug 行无徽标", !legacy.t[1].includes("["), legacy.t[1]);
  const full = buildRows({ ...base, mode: "full", phase: "building" }, null, [], "", T);
  ok("P11 full 与存量视图逐字一致", JSON.stringify(full) === JSON.stringify(legacy));
  // 其他任务列表对齐 + 错误/无任务/非活跃视图
  const l1 = listLine({ slug: "a", phase: "planning", rounds: {} });
  const l2 = listLine({ slug: "very-long-slug-xx", phase: "build_review", rounds: { plan_review: 1 } });
  const phAt = (ln: string, zh: string) => dispW(ln.slice(0, ln.indexOf(zh)));
  ok("P11 其他任务列表列对齐（slug 截断+阶段列偏移恒定）", l1.includes("计划") && l2.includes("执行审核") && phAt(l1, "计划") === phAt(l2, "执行审核"), JSON.stringify([l1, l2]));
  const e = buildRows(null, "boom", [], "", T);
  ok("P11 错误视图红色", e.t[1].includes("boom") && e.c[1] === T.text.feedback.error, e.t[1]);
  const n = buildRows(null, null, [], "", T);
  ok("P11 无状态视图不崩", n.t[1].includes("wf"), n.t[1]);
  const inactive = buildRows({ active: false }, null, [l1], "本项目", T);
  ok("P11 其他任务视图呈现", inactive.t[1].includes("本项目") && inactive.t[2].includes(l1), inactive.t[2]);
}

// ── P12: 表格真渲染复核——静态树（零信号）captureCharFrame，OpenTUI 自身宽度计算验证列对齐 ──
{
  const ot2: any = await import("@opentui/solid");
  const s = buildRows({ active: true, slug: "todo", mode: "daily", size: "S", phase: "building", rounds: {}, artifacts: {}, testPlanWritten: false, testReportVerdict: null }, null, [], "", theme);
  try {
    const setup = await ot2.testRender(() => {
      const b = ot2.createElement("box");
      ot2.setProp(b, "width", "100%");
      ot2.setProp(b, "flexDirection", "column");
      for (let i = 0; i < s.t.length; i++) {
        const tx = ot2.createElement("text");
        ot2.setProp(tx, "truncate", true);
        ot2.insert(tx, [s.t[i]]);
        ot2.insert(b, tx);
      }
      return b;
    }, { width: 50, height: 24 });
    await setup.flush();
    const frame: string = setup.captureCharFrame();
    ok("P12 帧含表头与阶段行", frame.includes("阶段") && frame.includes("需求录入") && frame.includes("交付"), JSON.stringify(frame.slice(0, 120)));
    const stAt = (ln: string) => { const m = /(完成|进行|待办)/.exec(ln); return m ? dispW(ln.slice(0, m.index)) : -1; };
    const stageLines = frame.split("\n").filter((ln: string) => /0[1-6] /.test(ln) && /(完成|进行|待办)/.test(ln));
    ok("P12 真渲染 6 阶段行齐全", stageLines.length === 6, `n=${stageLines.length}`);
    ok("P12 真渲染状态列对齐（偏移=14）", stageLines.every((ln: string) => stAt(ln) === 14), JSON.stringify(stageLines.map(stAt)));
    ok("P12 真渲染行宽 24 cell（trimEnd 后）", stageLines.every((ln: string) => dispW(ln.trimEnd()) === 24), JSON.stringify(stageLines.map((ln: string) => dispW(ln.trimEnd()))));
    ok("P12 帧含轮次与提示行", frame.includes("0/3") && frame.includes("/wf:status"));
    await setup.dispose();
  } catch (e: any) {
    ok("P12 表格真渲染不崩", false, e?.message);
  }
}

// ── P13: M16-r39 T11 WF_COMPACT env 开关——compact 判定 = options.compact===true || WF_COMPACT==="1" ──
// testRender 换树盲区→仅断言初始帧（snap=null：compact 单行「无活动任务」；非 compact 表头「── Workflow」）。
{
  const prevEnv = process.env.WF_COMPACT;
  const renderFrame = async (ctx: any, sid: string) => {
    const { slots } = { slots: (ctx as any).__slots };
    const setup = await testRender(() => slots["sidebar.content"]({ sessionID: sid }), { width: 50, height: 24 });
    await setup.flush();
    const frame: string = setup.captureCharFrame();
    await setup.dispose();
    return frame;
  };
  const setupWith = (options: any) => {
    const m = makeCtx();
    m.ctx.options = options;
    cleanups.push(t.setup(m.ctx as any)!);
    (m.ctx as any).__slots = m.slots;
    return m.ctx;
  };
  try {
    // env=1（options 空——真机 options 不传达 TUI 的主路径）
    process.env.WF_COMPACT = "1";
    const f1 = await renderFrame(setupWith({}), "ses_p13a");
    ok("P13 WF_COMPACT=1 初始帧单行含「无活动任务」", f1.includes("无活动任务"), JSON.stringify(f1.slice(0, 80)));
    ok("P13 WF_COMPACT=1 初始帧无表头「── Workflow」", !f1.includes("── Workflow"), JSON.stringify(f1.slice(0, 80)));
    // options.compact:true 同效（env 未设）
    delete process.env.WF_COMPACT;
    const f2 = await renderFrame(setupWith({ compact: true }), "ses_p13b");
    ok("P13 options.compact:true 同效（单行无表头）", f2.includes("无活动任务") && !f2.includes("── Workflow"), JSON.stringify(f2.slice(0, 80)));
    // env 未设 + options 空 → 表头在（默认表格视图不回归）
    const f3 = await renderFrame(setupWith({}), "ses_p13c");
    ok("P13 env 未设默认表格视图表头在", f3.includes("── Workflow"), JSON.stringify(f3.slice(0, 80)));
  } catch (e: any) {
    ok("P13 WF_COMPACT 开关不崩", false, e?.message);
  } finally {
    if (prevEnv === undefined) delete process.env.WF_COMPACT; else process.env.WF_COMPACT = prevEnv;
  }
}

console.log("（清理 setup 定时器与订阅）");
for (const c of cleanups) { try { c(); } catch { } }
console.log(`\n${pass} 通过, ${errors.length} 失败`);
if (errors.length) { console.log("失败项：\n - " + errors.join("\n - ")); process.exit(1); }
