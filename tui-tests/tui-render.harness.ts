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
function makeCtx(opts?: { noRouter?: boolean }) {
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
  let readReply: any = null;
  const editor = { plainText: "", clear() { this.plainText = ""; } };
  // M16-r46 批2：router mock（形状对齐 2.2.6 二进制取证的 register/navigate/current）
  const router: any = { registered: [] as any[], navigated: [] as any[], cur: null as any,
    register: (d: any) => { router.registered.push(d); },
    navigate: (d: any) => { router.navigated.push(d); if (d?.name) router.cur = d; },
    current: () => router.cur };
  const ctx: any = {
    theme,
    options: {},
    location: { directory: "/proj" },
    ui: {
      slot: (cfg: any) => { slots[cfg.append] = cfg.render; },
      panel: { open: () => false },
      toast: { show: (t: any) => { toasts.push(t); } },
      ...(opts?.noRouter ? {} : { router }),
    },
    keymap: { layer: (fn: any) => { keymaps.push(fn); } },
    renderer: { currentFocusedEditor: editor },
    client: {
      rpc(_def: any) {
        return {
          state: async (_input: any) => stateReply,
          list: async (_input: any) => ({ sessions: listSessions }),
          // notification-brief-display T04：形状与 server 真实写入同源（LRN⑧）——
          // rpc-bridge exec 现返回 {text, at, brief, level} 四字段
          exec: async (input: any) => { lastExec = input; return { text: "exec 报告", at: new Date().toISOString(), brief: "exec 摘要", level: "info" }; },
          read: async (_input: any) => readReply,
          events: { on: (name: string, cb: () => void, opts?: any) => { listeners.push({ name, cb, opts }); return () => { }; } },
        };
      },
    },
    attention: { notify: (n: any) => { notifies.push(n); } },
    data: { session: { get: (_id: string) => ({ projectID: "p1", location: { directory: "/proj" } }) }, listen: (cb: any) => { dataCbs.push(cb); return () => { }; }, on: (type: string, cb: any) => { if (type === "server.connected") connCbs.push(cb); return () => { }; } },
  };
  return {
    ctx, slots, keymaps, listeners, toasts, dataCbs, editor, notifies, connCbs, router,
    setSessions: (s: any[]) => { listSessions = s; },
    setState: (s: any) => { stateReply = s; },
    setRead: (r: any) => { readReply = r; },
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
  // M16-r46 批2：产物点击接线静态守卫（换树盲区由本守卫+真机目检代劳——探针③已实证 OpenTUI 命中）
  ok("P4 产物行 onMouseDown 绑定点在位", src.includes('"onMouseDown"'));
  ok("P4 router fail-soft 探测在位", src.includes("hasRegister"));
  // notification-brief-display T04：level 判定废除全文正则 + execLocal 透传新字段（C 意见）
  ok("P4 无 isImportant 全文正则（T04 废除对象不得回归）", !src.includes("isImportant"));
  ok("P4 execLocal 传参透传 brief/level（C：exec 通道 toast=brief 前提）", src.includes("brief: r.brief") && src.includes("level: r.level"));
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
    // ── notification-brief-display T04：report 事件带 brief → toast 文案 === brief（非全文墙）──
    const longText = Array.from({ length: 30 }, (_, i) => `第${i}行 指引全文内容`).join("\n");
    const brief1 = "【wf 工作流｜building·日常模式·M】slug=x\n行动：/wf:test";
    reportCbs.forEach((l) => l.cb({ sessionID: "ses_z", text: longText, at: new Date(Date.now() + 1000).toISOString(), brief: brief1, level: "info" }));
    ok("P6 事件带 brief → toast === brief（非全文）", toasts.some((x) => x.message === brief1) && !toasts.some((x) => x.message === longText));
    // legacy 行（brief:null，旧库/旧事件）→ 本地降级 text 前两行截断且 ses_ 脱敏（A/G-1）
    // （at 显式 +2000ms：与上一事件同毫秒会被 sessionID|at 去重键误拦）
    reportCbs.forEach((l) => l.cb({ sessionID: "ses_z", text: "状态行 session=ses_A1B2c3d4\nslug=demo phase=building\n不该出现的第三行", at: new Date(Date.now() + 2000).toISOString(), brief: null, level: null }));
    ok("P6 legacy brief:null → 降级 2 行且无 ses_", (() => {
      const m = String(toasts.at(-1)?.message ?? "");
      return m === "状态行 session=〔已隐去〕\nslug=demo phase=building";
    })(), JSON.stringify(toasts.at(-1)?.message));
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
  // T04：mock 行形状与 state.ts getReport 真实写入同源（5 字段，LRN⑧）
  setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p8", text: "轮询报告\n全文第二行", at: at1, brief: "轮询报告摘要", level: "info" } });
  cleanups.push(t.setup(ctx as any)!);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_p8" }), { width: 50, height: 24 });
    await setup.flush();
    await sleep(80); // 等 mount 时的 refresh（async RPC）落地
    ok("P8 refresh 读到 lastReport → toast 呈现 brief", toasts.some((x) => x.message === "轮询报告摘要"), `toasts=${JSON.stringify(toasts.map((x) => x.message))}`);
    // 同一 at 再次对账不重复弹
    const updCbs = listeners.filter((l) => l.name === "updated");
    updCbs.forEach((l) => l.cb({}));
    await sleep(80);
    const n = toasts.filter((x) => x.message === "轮询报告摘要").length;
    ok("P8 同 at 跨轮询去重", n === 1, `弹了 ${n} 次（应为 1）`);
    // 新 at 的新报告 → 再弹
    setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p8", text: "轮询报告2", at: new Date().toISOString(), brief: "轮询报告2摘要", level: "info" } });
    updCbs.forEach((l) => l.cb({}));
    await sleep(80);
    ok("P8 新 at 报告呈现", toasts.some((x) => x.message === "轮询报告2摘要"));
    // T04 legacy：旧库行 brief:null → 降级 2 行且 ses_ 脱敏（P6 事件通道的轮询镜像）
    setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p8", text: "状态 session=ses_P8LegacyID\nphase=testing\n第三行", at: new Date().toISOString(), brief: null, level: null } });
    updCbs.forEach((l) => l.cb({}));
    await sleep(80);
    ok("P8 legacy brief:null → 降级 2 行无 ses_", (() => {
      const m = toasts.map((x) => String(x.message)).find((s) => s.startsWith("状态 session="));
      return m === "状态 session=〔已隐去〕\nphase=testing";
    })(), JSON.stringify(toasts.map((x) => x.message)));
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
    ok("P9 exec 返回值 → toast 呈现 brief（T04/C：execLocal 透传后可达）", toasts.some((x) => x.message === "exec 摘要"), `toasts=${JSON.stringify(toasts.map((x) => x.message))}`);
    await setup.dispose();
  } catch (e: any) {
    ok("P9 return 拦截不崩", false, e?.message);
  }
}

// ── P10：P4 通知层——server.connected 重拉 + attention.notify（T04：level 结构化判定，
//    废除全文正则误弹）+ AbortSignal ──────────────────────────────────────
{
  const { ctx, slots, listeners, toasts, notifies, connCbs, setState } = makeCtx();
  const at1 = new Date().toISOString();
  setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p10", text: "连接初拉报告", at: at1, brief: "连接初拉摘要", level: "info" } });
  cleanups.push(t.setup(ctx as any)!);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_p10" }), { width: 50, height: 24 });
    await setup.flush();
    await sleep(80);
    ok("P10 events.on 订阅携带 AbortSignal", listeners.some((l) => l.opts && l.opts.signal && typeof l.opts.signal.aborted === "boolean"),
      `opts=${JSON.stringify(listeners.map((l) => ({ n: l.name, hasSig: !!l.opts?.signal })))}`);
    ok("P10 已订阅 server.connected", connCbs.length >= 1);
    ok("P10 初拉 info → toast 且 notify 不发", toasts.some((x) => x.message === "连接初拉摘要") && notifies.length === 0);
    // 断线窗口：level=warn → 重拉送达 + OS 通知（message=brief）
    const at2 = new Date(Date.now() + 1000).toISOString();
    setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p10", text: "⚠️ 断线窗口报告全文", at: at2, brief: "断线窗口报告摘要", level: "warn" } });
    connCbs.forEach((cb) => cb());
    await sleep(80);
    ok("P10 server.connected 重拉送达窗口期报告（toast=brief）", toasts.some((x) => x.message === "断线窗口报告摘要"));
    ok("P10 level=warn → attention.notify(message=brief)", notifies.some((n) => n.message === "断线窗口报告摘要"), JSON.stringify(notifies));
    // 误弹回归锚（T04 核心）：level=info 但全文含 ⚠️/❌/FAIL/illegal → 只 toast 不 notify
    const at3 = new Date(Date.now() + 2000).toISOString();
    setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p10", text: "⚠️ FAIL ❌ illegal 旧全文正则必误弹", at: at3, brief: "正常流转摘要", level: "info" } });
    connCbs.forEach((cb) => cb());
    await sleep(80);
    ok("P10 info+⚠️/❌/FAIL 文本 → 不触发 notify（误弹回归锚）", toasts.some((x) => x.message === "正常流转摘要") && notifies.length === 1, `notifies=${notifies.length}`);
    // warn 且 brief >160 → notify message 截前 160
    const at4 = new Date(Date.now() + 3000).toISOString();
    const longBrief = "L".repeat(200);
    setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p10", text: "x", at: at4, brief: longBrief, level: "warn" } });
    connCbs.forEach((cb) => cb());
    await sleep(80);
    ok("P10 warn → notify message 为 brief 前 160 字", notifies.some((n) => n.message === longBrief.slice(0, 160)), JSON.stringify(notifies.map((n: any) => n.message?.length)));
    await setup.dispose();
  } catch (e: any) {
    ok("P10 通知层不崩", false, e?.message);
  }
}

// ── T04：briefOf 模块级纯函数直测（toast 文案选择：brief 优先，legacy 降级 2 行+脱敏）──
{
  const briefOf = ns.briefOf;
  ok("T04 briefOf 已导出（模块级纯函数）", typeof briefOf === "function");
  if (typeof briefOf === "function") {
    ok("T04 briefOf：brief 非空 → 原样返回（不截断不加行）", briefOf({ brief: "B\n行二", text: "T" }) === "B\n行二");
    ok("T04 briefOf：brief 空串/缺失 → 走降级", briefOf({ brief: "", text: "单行" }) === "单行" && briefOf({ text: "单行" }) === "单行");
    const legacy = briefOf({ brief: null, text: `首行 ${"a".repeat(150)}\n次行\n三行勿见` });
    const ls = String(legacy).split("\n");
    ok("T04 briefOf：降级只取前两行", ls.length === 2 && ls[1] === "次行", JSON.stringify(legacy.slice(0, 30)));
    ok("T04 briefOf：每行截 100 码点加 …", Array.from(ls[0]).length === 101 && ls[0].endsWith("…"));
    ok("T04 briefOf：降级行过 redactIds 无 ses_", !String(briefOf({ brief: null, text: "状态 session=ses_A1B2c3d4E5" })).includes("ses_"));
    ok("T04 briefOf：空/无 text 不炸", briefOf({}) === "" && briefOf(null) === "");
  }
}

// ── P11: M16-r37 侧边栏表格化——buildRows 纯函数直测（绕开 testRender 信号→换树盲区）──
// 布局锚：t0 头线/t1 slug/t2 进度/t4 表头/t5 细线/t6.. 阶段行（daily 6→6..11，full 9→6..14）；
// 尾段 cursor=6+n（剩余>3 行先插空行）→ 关卡/产物1/产物2；t18 提示行/t19 尾线。
// 列几何：1+2+1+8+2+4+2+4+2+6=32 cell（tui-sidebar-elapsed：+2 分隔+6 耗时列）；
// 状态词起始偏移恒 14；轮次右对齐 4 cell（20-23）；耗时右对齐 6 cell（26-31）。
{
  const T = theme;
  const base = { active: true, slug: "todo", rounds: {}, artifacts: {}, testPlanWritten: false, testReportVerdict: null };
  const statusAt = (row: string) => { const m = /(完成|进行|待办)/.exec(row); return m ? dispW(row.slice(0, m.index)) : -1; };
  // daily S：徽标 + 6 行表格 + 对齐 + 模式语义
  const s = buildRows({ ...base, mode: "daily", size: "S", phase: "building" }, null, [], "", T);
  ok("P11 daily S slug 行带 [daily·S] 徽标", s.t[1].includes("[daily·S]"), s.t[1]);
  ok("P11 daily building=F3 进度 3/6", s.t[2].includes("F3") && s.t[2].includes("3/6") && s.t[2].includes("●●●○○○"), s.t[2]);
  ok("P11 表头含 阶段/状态/轮次/耗时", s.t[4].includes("阶段") && s.t[4].includes("状态") && s.t[4].includes("轮次") && s.t[4].includes("耗时"), s.t[4]);
  const rows6 = s.t.slice(6, 12);
  ok("P11 daily 6 阶段行序号连续", rows6.every((r: string, k: number) => r.startsWith(` 0${k + 1} `)), JSON.stringify(rows6));
  ok("P11 daily 中文阶段名", rows6[0].includes("需求录入") && rows6[3].includes("执行") && rows6[5].includes("交付"), JSON.stringify(rows6));
  ok("P11 状态派生 完成/进行/待办", rows6[0].includes("完成") && rows6[3].includes("进行") && rows6[4].includes("待办"), JSON.stringify(rows6));
  ok("P11 阶段行状态列对齐（偏移=14）", rows6.every((r: string) => statusAt(r) === 14), JSON.stringify(rows6.map(statusAt)));
  ok("P11 阶段行等宽 32 cell（轮次/耗时右对齐）", rows6.every((r: string) => dispW(r) === 32), JSON.stringify(rows6.map(dispW)));
  ok("P11 进行行整行蓝高亮", s.c[9] === T.text.action.primary, s.c[9]);
  ok("P11 计划审核行挂 plan 轮次", s.t[8].includes("0/3"), s.t[8]);
  ok("P11 daily 测试行挂 fix 轮次", s.t[10].includes("0/3"), s.t[10]);
  ok("P11 daily 无 test-plan 假缺失", !s.t.some((r: string) => r.includes("test-plan")), JSON.stringify(s.t));
  ok("P11 daily S verify 显示自检", s.t[13].includes("自检"), s.t[13]);
  // M16-r46 批1：产物区逐文件清单（daily 3 行 + 溢出行）
  ok("P11 daily S 产物2=plan-review 免（重锚 r15）", s.t[15].includes("plan-review") && s.t[15].includes("免"), s.t[15]);
  ok("P11 daily S 产物3=test-report ✗", s.t[16].includes("test-report.md") && s.t[16].includes("✗"), s.t[16]);
  ok("P11 daily S 无溢出行（extras 0）", !s.t.some((r: string) => r.includes("更多")), JSON.stringify(s.t));
  ok("P11 提示行 /wf:status", s.t[18].includes("/wf:status"), s.t[18]);
  // daily M：verify 关卡随 planReviewVerdict + plan-review 产物显式 + 其他产物不重复计数
  const m = buildRows({ ...base, mode: "daily", size: "M", phase: "review", planReviewVerdict: "PASS", artifacts: { "plan.md": { at: "x" }, "plan-review-r1.md": { at: "x" } } }, null, [], "", T);
  ok("P11 daily M verify PASS 可见", m.t[13].includes("verify") && m.t[13].includes("PASS"), m.t[13]);
  ok("P11 daily M verify PASS 绿色", m.c[13] === T.text.feedback.success, m.c[13]);
  // M16-r46 批1：daily M 产物清单 = plan.md ✓+大小 / plan-review 真名 / test-report ✗；extras 0 无溢出
  const a2 = buildRows({ ...base, mode: "daily", size: "M", phase: "review", planReviewVerdict: "PASS", artifacts: { "plan.md": { at: "2026-01-01T00:00:00Z", bytes: 1228 }, "plan-review-r1.md": { at: "2026-01-02T00:00:00Z", bytes: 820 } } }, null, [], "", T);
  ok("P11 daily M 产物行含 ▸ 可点击暗示", [14, 15, 16].every((k) => a2.t[k].includes("▸")), JSON.stringify(a2.t.slice(14, 18)));
  ok("P11 daily M plan.md 行带 KB 大小", a2.t[14].includes("plan.md") && a2.t[14].includes("✓") && a2.t[14].includes("1.2k"), a2.t[14]);
  ok("P11 daily M plan-review 显示真名+大小", a2.t[15].includes("plan-review-r1.md") && a2.t[15].includes("0.8k"), a2.t[15]);
  ok("P11 daily M test-report ✗ 无大小", a2.t[16].includes("test-report.md") && a2.t[16].includes("✗") && !a2.t[16].includes("k"), a2.t[16]);
  ok("P11 daily M 名字列对齐（fit 18，▸ 后起 2）", [14, 15, 16].every((k) => a2.t[k].indexOf("plan") === 2 || /▸ [^\n]{18}/.test(a2.t[k])), JSON.stringify(a2.t.slice(14, 18)));
  ok("P11 daily M canonical 排序 plan 先于 review", a2.t.findIndex((r: string) => r.includes("plan.md")) < a2.t.findIndex((r: string) => r.includes("plan-review")), JSON.stringify(a2.t.slice(14, 18)));
  ok("P11 daily M 无溢出行", !a2.t.some((r: string) => r.includes("更多")), JSON.stringify(a2.t));
  // M16-r46 批1：extras 溢出 → …N 更多；extras 按 at 降序
  const a3 = buildRows({ ...base, mode: "daily", size: "M", phase: "review", artifacts: { "plan.md": { at: "2026-01-01T00:00:00Z", bytes: 1024 }, "custom-a.md": { at: "2026-01-03T00:00:00Z", bytes: 2048 }, "custom-b.md": { at: "2026-01-02T00:00:00Z", bytes: 4096 } } }, null, [], "", T);
  ok("P11 daily 溢出行 …1 更多", a3.t[17].includes("1 更多"), a3.t[17]);
  ok("P11 daily extras 按 at 降序（custom-a 入列、custom-b 溢出）", a3.t.some((r: string) => r.includes("custom-a")) && !a3.t.some((r: string) => r.includes("custom-b")), JSON.stringify(a3.t.slice(14, 18)));
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
  ok("P11 存量阶段行同样对齐", rows9.every((r: string) => statusAt(r) === 14 && dispW(r) === 32), JSON.stringify(rows9.map(statusAt)));
  ok("P11 存量执行审核行挂 build 轮次", legacy.t[11].includes("执行审核") && legacy.t[11].includes("0/3"), legacy.t[11]);
  ok("P11 存量修复行挂 fix 轮次", legacy.t[13].includes("修复") && legacy.t[13].includes("0/3"), legacy.t[13]);
  ok("P11 存量 test-plan 关卡仍在", legacy.t[15].includes("test-plan"), legacy.t[15]);
  ok("P11 存量 test-plan.md 产物行仍在", legacy.t[16].includes("test-plan.md"), legacy.t[16]);
  // M16-r46 批1：full 产物行加 ▸ 前缀（可点击暗示；full 与 legacy 同路径仍逐字一致）
  ok("P11 full 产物行 ▸ 前缀", legacy.t[16].startsWith("  ▸") || legacy.t[16].includes("▸"), legacy.t[16]);
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
        ot2.setProp(tx, "wrapMode", "none");
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
    ok("P12 真渲染行宽 32 cell（trimEnd 后）", stageLines.every((ln: string) => dispW(ln.trimEnd()) === 32), JSON.stringify(stageLines.map((ln: string) => dispW(ln.trimEnd()))));
    ok("P12 帧含轮次与提示行", frame.includes("0/3") && frame.includes("/wf:status"));
    // R6（tui-sidebar-elapsed 验收6）：耗时表头在帧内 + 装饰线拉满 w=80 被 wrapMode:"none" 硬裁到帧宽 50
    ok("R6 帧含耗时表头", frame.includes("耗时"), JSON.stringify(frame.slice(0, 160)));
    const headLine = frame.split("\n").find((ln: string) => ln.includes("── Workflow")) ?? "";
    ok("R6 装饰线头线帧内宽度 50（wrapMode:none 硬裁剪生效）", dispW(headLine.trimEnd()) === 50, JSON.stringify(headLine));
    const tailLine = frame.split("\n").find((ln: string) => /^─+$/.test(ln.trimEnd())) ?? "";
    ok("R6 装饰线尾线帧内宽度 50", dispW(tailLine.trimEnd()) === 50, JSON.stringify(tailLine));
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

// ── P14: M16-r46 批2 产物预览——buildRows af 纯函数 + router 接线 + 主轨/降级/退出 ──
{
  const T = theme;
  const base = { active: true, slug: "todo", rounds: {}, testPlanWritten: false, testReportVerdict: null };
  // 14a：af 维——daily ✓ 项可点击 / ✗ 与免不可点 / full 行级首个已记账产物
  const d14 = buildRows({ ...base, mode: "daily", size: "M", phase: "building", artifacts: { "plan.md": { at: "2026-01-01T00:00:00Z", bytes: 1228 } } }, null, [], "", T);
  ok("P14a daily ✓plan.md 行可点(af14) 而 ✗test-report 行不可点(af16)", d14.af[14] === "plan.md" && d14.af[16] === null, JSON.stringify(d14.af));
  const d14b = buildRows({ ...base, mode: "daily", size: "M", phase: "building", artifacts: { "plan.md": { at: "2026-01-01T00:00:00Z", bytes: 1 }, "plan-review-r1.md": { at: "2026-01-02T00:00:00Z", bytes: 2 }, "test-report.md": { at: "2026-01-03T00:00:00Z", bytes: 3 }, "custom.md": { at: "2026-01-04T00:00:00Z", bytes: 4 } } }, null, [], "", T);
  ok("P14a daily plan-review/test-report 真名可点", d14b.af[14] === "plan.md" && d14b.af[15] === "plan-review-r1.md" && d14b.af[16] === "test-report.md", JSON.stringify(d14b.af.slice(14, 18)));
  ok("P14a daily 溢出行不可点", d14b.af[17] === null, JSON.stringify(d14b.af));
  const f14 = buildRows({ ...base, phase: "building", artifacts: { "test-plan.md": { at: "x", bytes: 1 }, "extra.md": { at: "x", bytes: 2 } } }, null, [], "", T);
  ok("P14a full 行取首个已记账产物（plan ✗→test-plan ✓）", f14.af[16] === "test-plan.md" && f14.af[17] === null, JSON.stringify(f14.af));
  ok("P14a 错误/无任务视图 af 全空不崩", (() => { const e = buildRows(null, "boom", [], "", T); return e.af.every((x: string | null) => x === null); })());

  // 14b：setup 注册 wf-artifact route（register 形状 name/render）
  {
    const { ctx, router } = makeCtx();
    cleanups.push(t.setup(ctx as any)!);
    ok("P14b setup 注册 wf-artifact route", router.registered.length === 1 && router.registered[0].name === "wf-artifact" && typeof router.registered[0].render === "function", JSON.stringify(router.registered.map((r: any) => r.name)));
    // 14c：主轨 /wf:open 带参 → openArtifact（read→navigate，data 快照携带 text/file）
    const { ctx: ctx2, slots: s2, router: r2, keymaps: k2, setRead, setState, editor, getExec } = makeCtx();
    setState({ ...base, mode: "daily", size: "M", phase: "building", artifacts: { "plan.md": { at: "x", bytes: 1228 } } });
    setRead({ text: "# 计划\n内容", bytes: 1228, path: "/proj/.workflow/todo/plan.md", truncated: false });
    cleanups.push(t.setup(ctx2 as any)!);
    try {
      const st2 = await testRender(() => s2["sidebar.content"]({ sessionID: "ses_p14c" }), { width: 50, height: 24 });
      await st2.flush();
      await sleep(100); // mount refresh 落地（latestSid 就位）
      const cmdsOf = (ks: any[]) => ks.map((f: any) => f()).flatMap((l: any) => l.commands ?? []);
      const wfCmd = cmdsOf(k2).find((c: any) => c.id === "wf.exec");
      ok("P14c 主轨 wf.exec 层在位", !!wfCmd);
      editor.plainText = "/wf:open plan.md";
      const rr = wfCmd.run();
      ok("P14c /wf:open 带参同步 true（route 可用→本地预览）", rr === true);
      await sleep(150);
      ok("P14c read→navigate 携带 plugin route 与 data 快照", r2.navigated.some((n: any) => n.type === "plugin" && n.name === "wf-artifact" && n.data?.file === "plan.md" && n.data?.text.includes("# 计划")), JSON.stringify(r2.navigated));
      // 14d：退出键层——route 激活时 enabled → q run → navigate 回 session
      const closeLayer = cmdsOf(k2).find((c: any) => c.id === "wf.artifact.close");
      ok("P14d 退出键层注册（q）", !!closeLayer);
      ok("P14d route 激活时 enabled=true（navigate 过 wf-artifact）", closeLayer?.enabled() === true);
      const nBefore = r2.navigated.length;
      ok("P14d q 返回 run 同步 true", closeLayer?.run() === true);
      ok("P14d 返回=navigate session route", r2.navigated.length === nBefore + 1 && r2.navigated.at(-1).type === "session", JSON.stringify(r2.navigated.at(-1)));
      // 14e：无参 /wf:open → server exec（清单降级轨）
      editor.plainText = "/wf:open";
      wfCmd.run();
      await sleep(100);
      ok("P14e 无参透传 exec（清单由 server 出）", getExec()?.name === "wf:open" && getExec()?.prompt === "", JSON.stringify(getExec()));
      await st2.dispose();
    } catch (e: any) { ok("P14c-e 预览链路不崩", false, e?.message); }
    void ctx; void router;
  }
  // 14f：noRouter 降级——带参也走 execLocal（server 全文 toast）
  {
    const { ctx: c3, slots: s3, keymaps: k3, setState, editor: ed3, getExec } = makeCtx({ noRouter: true });
    setState({ ...base, mode: "daily", size: "M", phase: "building", artifacts: { "plan.md": { at: "x", bytes: 1 } } });
    cleanups.push(t.setup(c3 as any)!);
    try {
      const st3 = await testRender(() => s3["sidebar.content"]({ sessionID: "ses_p14f" }), { width: 50, height: 24 });
      await st3.flush();
      await sleep(100);
      const wfCmd3 = k3.map((f: any) => f()).flatMap((l: any) => l.commands ?? []).find((c: any) => c.id === "wf.exec");
      ed3.plainText = "/wf:open plan.md";
      wfCmd3.run();
      await sleep(120);
      ok("P14f noRouter → 带参透传 exec（降级 server 全文）", getExec()?.name === "wf:open" && getExec()?.prompt === "plan.md", JSON.stringify(getExec()));
      ok("P14f noRouter 不注册退出键层", !k3.map((f: any) => f()).some((l: any) => (l.commands ?? []).some((c: any) => c.id === "wf.artifact.close")));
      await st3.dispose();
    } catch (e: any) { ok("P14f 降级不崩", false, e?.message); }
  }
  // 14g：点击端到端=已知换树盲区（testRender 帧循环不提交信号→换树，头注纪律：真机+静态守卫代劳）。
  // OpenTUI 层命中已由本机 mockMouse 探针实证（批0 探针③：setProp onMouseDown→click 命中触发）；
  // 插件接线由 P4 静态守卫锁定（onMouseDown 绑定点在位）+ 行为逻辑由 P14a/P14c 锁定；
  // 真机目检（宿主 sidebar scrollbox 内点击）留用户验收，probe evt: open-artifact/navigate-ok 取证。
}

// ── P15: artifact-md-preview—route render markdown 双轨（mdEl 优先 + 纯文本降级）──
{
  const MD_SAMPLE = [
    "# 计划标题",
    "",
    "**结论**: PASS",
    "",
    "| 列A | 列B |",
    "| --- | --- |",
    "| 甲 | 乙 |",
    "",
    "- 项目一",
    "",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");
  const mdSnapshot = { file: "plan.md", text: MD_SAMPLE, bytes: 200, path: "/proj/.workflow/todo/plan.md", truncated: false };

  // 15a：markdown 主轨——同步构造特征：代码围栏独立成 code block（围栏字符消失）、表格变表格（分隔行消失、单元可见）。
  // 标题 ## 与强调 ** 的 conceal/着色属异步高亮 pass，testRender 帧循环不提交（头注盲区）——不断言。
  {
    const { ctx, router } = makeCtx();
    cleanups.push(t.setup(ctx as any)!);
    const routeRender = router.registered[0].render;
    try {
      const st = await testRender(() => routeRender({ data: mdSnapshot }), { width: 60, height: 30 });
      await st.flush();
      const frame: string = st.captureCharFrame();
      ok("P15a 主轨帧含代码块内容", frame.includes("const x = 1"), JSON.stringify(frame.slice(0, 160)));
      ok("P15a 代码围栏 ``` 原样消失（同步成独立代码块）", !frame.includes("```"), JSON.stringify(frame.slice(0, 160)));
      ok("P15a 表格渲染：单元文本可见且 | --- 分隔行消失", frame.includes("列A") && frame.includes("甲") && !frame.includes("| ---"), JSON.stringify(frame.slice(0, 220)));
      await st.dispose();
    } catch (e: any) { ok("P15a markdown 主轨渲染不崩", false, e?.message); }
  }

  // 15b：降级轨——catalogue 无 markdown（createElement 构造期同步 throw）→ 逐行纯文本，围栏与 ** 原样保留
  {
    const solidAny: any = await import("@opentui/solid");
    const cat = typeof solidAny.getComponentCatalogue === "function" ? solidAny.getComponentCatalogue() : null;
    ok("P15b getComponentCatalogue 含 markdown 键（本地 0.8.3 能力确认）", !!cat && !!cat.markdown);
    if (cat && cat.markdown) {
      const saved = cat.markdown;
      delete cat.markdown;
      try {
        const { ctx, router } = makeCtx();
        cleanups.push(t.setup(ctx as any)!);
        const st = await testRender(() => router.registered[0].render({ data: mdSnapshot }), { width: 60, height: 30 });
        await st.flush();
        const frame: string = st.captureCharFrame();
        ok("P15b 降级轨=逐行纯文本（``` 与 **结论** 原样保留）", frame.includes("```") && frame.includes("**结论**"), JSON.stringify(frame.slice(0, 200)));
        await st.dispose();
      } catch (e: any) { ok("P15b 降级轨不崩", false, e?.message); }
      finally { cat.markdown = saved; }
    }
  }

  // 15c：静态守卫——mdEl 接线点 + 双轨探针 + 不经 sanitize
  {
    const src = await (await import("node:fs/promises")).readFile(new URL("../tui/index.tsx", import.meta.url), "utf8");
    ok("P15c createElement(\"markdown\") 构造点在位", src.includes('createElement("markdown")'));
    ok("P15c md 双轨探针在位（route-render-md-ok/md-el-err/hasMd 归因）", src.includes("route-render-md-ok") && src.includes("md-el-err") && src.includes("hasMd"));
    const mi = src.indexOf("function mdEl");
    ok("P15c mdEl 定义在位", mi >= 0);
    if (mi >= 0) {
      const mb = src.slice(mi, src.indexOf("\n}", mi));
      ok("P15c mdEl 不经 sanitize（换行语义保持）", !mb.includes("sanitize("));
    }
  }
}

// ── P16: artifact-preview-scroll—route 正文 scrollbox 包裹（双轨正文入滚动区，头尾固定）──
{
  const P16_MD = ["# 计划标题", "", "**结论**: PASS", "", "| 列A | 列B |", "| --- | --- |", "| 甲 | 乙 |", "", "```ts", "const x = 1;", "```"].join("\n");
  const P16_LONG = ["# 长产物", "", ...Array.from({ length: 100 }, (_, i) => `正文第 ${i} 行，内容稍长以撑高内容区`)].join("\n");

  // 树遍历工具：st.renderer.root → _childrenInLayoutOrder（运行时实证 2026-11-13：无公开 children getter）
  const findNode = (n: any, namePart: string): any => {
    if (!n) return null;
    if ((n.constructor?.name ?? "").includes(namePart)) return n;
    for (const c of n._childrenInLayoutOrder ?? []) { const r = findNode(c, namePart); if (r) return r; }
    return null;
  };

  // 16a：主轨——scrollbox 在位，markdown 元素为其子；头部标题行仍在 scrollbox 之外（固定区）
  {
    const { ctx, router } = makeCtx();
    cleanups.push(t.setup(ctx as any)!);
    try {
      const st = await testRender(() => router.registered[0].render({ data: { file: "plan.md", text: P16_MD, bytes: 200, path: "/p/plan.md", truncated: false } }), { width: 60, height: 30 });
      await st.flush();
      const root: any = (st as any).renderer?.root;
      const sb = findNode(root, "ScrollBox");
      ok("P16a 主轨树含 scrollbox", !!sb, sb ? "found" : "not found");
      ok("P16a markdown 为 scrollbox 之子", !!sb && (sb._childrenInLayoutOrder ?? []).some((c: any) => (c.constructor?.name ?? "").includes("Markdown")), sb ? String((sb._childrenInLayoutOrder ?? []).map((c: any) => c.constructor?.name)) : "no sb");
      await st.dispose();
    } catch (e: any) { ok("P16a 主轨滚动渲染不崩", false, e?.message); }
  }

  // 16b：长文档溢出——viewport 有界（≤终端高）且 content 高度 > viewport 高度（滚动语义成立的结构性前提）
  {
    const { ctx, router } = makeCtx();
    cleanups.push(t.setup(ctx as any)!);
    try {
      const st = await testRender(() => router.registered[0].render({ data: { file: "plan.md", text: P16_LONG, bytes: 9000, path: "/p/plan.md", truncated: false } }), { width: 60, height: 30 });
      await st.flush();
      const sb = findNode((st as any).renderer?.root, "ScrollBox");
      const vh = sb?.viewport?.height, ch = sb?.content?.height;
      ok("P16b scrollbox viewport 有界", !!sb && vh > 0 && vh <= 30, `vh=${vh}`);
      ok("P16b content 溢出 viewport（可滚动结构成立）", !!sb && ch > vh, `vh=${vh} ch=${ch}`);
      await st.dispose();
    } catch (e: any) { ok("P16b 长文档滚动渲染不崩", false, e?.message); }
  }

  // 16c：能力缺失降级——catalogue 无 scrollbox（旧宿主）→ scrollEl 构造期同步 throw → null → 正文直挂，不崩且 markdown 仍生效
  {
    const solidAny: any = await import("@opentui/solid");
    const cat = typeof solidAny.getComponentCatalogue === "function" ? solidAny.getComponentCatalogue() : null;
    ok("P16c getComponentCatalogue 含 scrollbox 键（本地 0.8.x 能力确认）", !!cat && !!cat.scrollbox);
    if (cat && cat.scrollbox) {
      const saved = cat.scrollbox;
      delete cat.scrollbox;
      try {
        const { ctx, router } = makeCtx();
        cleanups.push(t.setup(ctx as any)!);
        const st = await testRender(() => router.registered[0].render({ data: { file: "plan.md", text: P16_MD, bytes: 200, path: "/p/plan.md", truncated: false } }), { width: 60, height: 30 });
        await st.flush();
        const frame: string = st.captureCharFrame();
        ok("P16c 无 scrollbox 不崩且 markdown 主轨仍生效", frame.includes("const x = 1"), JSON.stringify(frame.slice(0, 160)));
        ok("P16c 无 scrollbox 时树中确无滚动节点（降级直挂）", !findNode((st as any).renderer?.root, "ScrollBox"));
        await st.dispose();
      } catch (e: any) { ok("P16c 降级轨不崩", false, e?.message); }
      finally { cat.scrollbox = saved; }
    }
    // 16c2：纯文本降级轨（无 markdown）正文同样入 scrollbox
    if (cat && cat.markdown) {
      const savedM = cat.markdown;
      delete cat.markdown;
      try {
        const { ctx, router } = makeCtx();
        cleanups.push(t.setup(ctx as any)!);
        const st = await testRender(() => router.registered[0].render({ data: { file: "plan.md", text: P16_LONG, bytes: 9000, path: "/p/plan.md", truncated: false } }), { width: 60, height: 30 });
        await st.flush();
        const sb = findNode((st as any).renderer?.root, "ScrollBox");
        ok("P16c2 纯文本轨正文亦入 scrollbox（text 为其子）", !!sb && (sb._childrenInLayoutOrder ?? []).some((c: any) => (c.constructor?.name ?? "").includes("Text")), sb ? String((sb._childrenInLayoutOrder ?? []).length) : "no sb");
        await st.dispose();
      } catch (e: any) { ok("P16c2 纯文本滚动轨不崩", false, e?.message); }
      finally { cat.markdown = savedM; }
    }
  }

  // 16d：静态守卫——scrollEl 构造点 + 探针归因 + 不设 height:100% 于 scrollbox（避免挤出头尾固定行）
  {
    const src = await (await import("node:fs/promises")).readFile(new URL("../tui/index.tsx", import.meta.url), "utf8");
    ok("P16d createElement(\"scrollbox\") 构造点在位", src.includes('createElement("scrollbox")'));
    ok("P16d scroll 降级探针在位（scroll-el-err/hasScroll 归因）", src.includes("scroll-el-err") && src.includes("hasScroll"));
    const si = src.indexOf("function scrollEl");
    ok("P16d scrollEl 定义在位", si >= 0);
    if (si >= 0) {
      const sbBody = src.slice(si, src.indexOf("\n}", si));
      ok("P16d scrollEl 不设 height（高度约束只在外层容器，防挤出头尾）", !sbBody.includes('"height"'));
    }
  }
}

// ── P17: artifact-md-syntaxstyle—markdown 高亮/conceal 生效（syntaxStyle 接线）──
{
  const HL_MD = ["# 标题一", "", "段落里 **加粗** 与 `行内代码`。"].join("\n");

  // 17a 行为面：异步 highlight pass 经真定时器提交（probe-md-fix 实证 ~1.5s 足够；
  // R7 setTimeout 守卫扫描对象是 tui/index.tsx 源码，不含本 harness）→ conceal 生效。
  {
    const { ctx, router } = makeCtx();
    cleanups.push(t.setup(ctx as any)!);
    try {
      const st = await testRender(() => router.registered[0].render({ data: { file: "plan.md", text: HL_MD, bytes: 100, path: "/p/plan.md", truncated: false } }), { width: 60, height: 12 });
      await st.flush();
      await new Promise((r) => setTimeout(r, 1600));
      await st.flush();
      const frame: string = st.captureCharFrame();
      ok("P17a syntaxStyle 接线：标题 # conceal", !frame.includes("# 标题一") && frame.includes("标题一"), JSON.stringify(frame.slice(0, 120)));
      ok("P17a 加粗/行内代码 conceal", !frame.includes("**加粗**") && frame.includes("加粗") && !frame.includes("`行内代码`"), JSON.stringify(frame.slice(0, 160)));
      await st.dispose();
    } catch (e: any) { ok("P17a 高亮渲染不崩", false, e?.message); }
  }

  // 17b 静态守卫：import 点在位 + mdEl 内 syntaxStyle 先于 content + 三探针归因 + 模块级缓存（防泄漏）
  {
    const src = await (await import("node:fs/promises")).readFile(new URL("../tui/index.tsx", import.meta.url), "utf8");
    ok("P17b import(\"@opentui/core\") 动态装载点在位", src.includes('import("@opentui/core")'));
    const mi = src.indexOf("function mdEl");
    ok("P17b mdEl 定义在位", mi >= 0);
    if (mi >= 0) {
      const mb = src.slice(mi, src.indexOf("\n}", mi));
      const ssi = mb.indexOf("syntaxStyle");
      ok("P17b mdEl 内 syntaxStyle setProp 点在位", ssi >= 0);
      ok("P17b syntaxStyle 先于 content（子 CodeRenderable 建块前就位）", ssi >= 0 && mb.indexOf('"content"') > ssi);
    }
    ok("P17b 三探针归因在位（ok/err/import-err）", src.includes("syntax-style-ok") && src.includes("syntax-style-err") && src.includes("syntax-style-import-err"));
    ok("P17b 按 owner 分键缓存（Map get/set，防跨 context 误用与 native 泄漏）", src.includes("syntaxStyleCache.get(") && src.includes("syntaxStyleCache.set(") && src.includes("new Map<any, any>()"));
    const vc = await (await import("node:fs/promises")).readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
    ok("P17b vite external 含 @opentui/core（防打包第二份 core）", vc.includes('"@opentui/core"'));
  }
}

// ── R1-R7: tui-sidebar-elapsed 侧边栏宽度填充+阶段耗时列（plan §4 T03 验收 1-7）──
// 口径=墙钟·冻结：intake 起连续累计；done 冻结总耗时；进行中依赖调用点 now；存量降级 ·。
// R6 见 P12 块（真渲染 width:50）；R7 静态守卫与 P4 结构守卫互补（禁新 timer）。
{
  const T = theme;
  const base = { active: true, slug: "todo", rounds: {}, artifacts: {}, testPlanWritten: false, testReportVerdict: null };
  const statusAt = (row: string) => { const m = /(完成|进行|待办)/.exec(row); return m ? dispW(row.slice(0, m.index)) : -1; };
  const NOW = Date.parse("2026-11-12T12:00:00.000Z"); // 固定 now：纯函数确定性

  // R1 几何：32 cell + 偏移 14 + 表头四列（daily 6 行 / legacy 9 行）
  const g6 = buildRows({ ...base, mode: "daily", size: "S", phase: "building" }, null, [], "", T);
  const g9 = buildRows({ ...base, phase: "building" }, null, [], "", T);
  ok("R1 daily 6 阶段行 32 cell", g6.t.slice(6, 12).every((r: string) => dispW(r) === 32), JSON.stringify(g6.t.slice(6, 12).map(dispW)));
  ok("R1 legacy 9 阶段行 32 cell", g9.t.slice(6, 15).every((r: string) => dispW(r) === 32), JSON.stringify(g9.t.slice(6, 15).map(dispW)));
  ok("R1 状态列偏移仍 14", [...g6.t.slice(6, 12), ...g9.t.slice(6, 15)].every((r: string) => statusAt(r) === 14), JSON.stringify([...g6.t.slice(6, 12), ...g9.t.slice(6, 15)].map(statusAt)));
  ok("R1 表头含 阶段/状态/轮次/耗时", ["阶段", "状态", "轮次", "耗时"].every((k) => g6.t[4].includes(k)), g6.t[4]);

  // R2 计时数值（固定 now）：进行中 1:05 / 完成 0:42、2:10 / 总耗时 12:34（startedAt=now-754000ms）
  ok("R2 fmtElapsed 导出", typeof ns.fmtElapsed === "function");
  if (typeof ns.fmtElapsed === "function") {
    ok("R2 fmtElapsed 格式 m:ss（负数钳 0）", ns.fmtElapsed(65) === "1:05" && ns.fmtElapsed(754) === "12:34" && ns.fmtElapsed(0) === "0:00" && ns.fmtElapsed(-5) === "0:00");
  }
  const timed = buildRows({
    ...base, mode: "daily", size: "M", phase: "building",
    startedAt: new Date(NOW - 754000).toISOString(),
    phaseEnteredAt: new Date(NOW - 65000).toISOString(),
    phaseDurations: { intake: 42, planning: 130, review: 5 },
  }, null, [], "", T, NOW);
  ok("R2 进行中行含 1:05（padS 6）", timed.t[9].includes("   1:05") && timed.t[9].endsWith("  1:05"), timed.t[9]);
  ok("R2 完成行含 0:42/2:10", timed.t[6].includes("   0:42") && timed.t[7].includes("   2:10"), JSON.stringify(timed.t.slice(6, 9)));
  ok("R2 t[2] 总耗时 共 12:34", timed.t[2].includes("共 12:34"), timed.t[2]);

  // R3 降级：无计时字段 → 耗时列 padS("·",6)、t[2] 不含「共」；缺 now → 进行中亦 ·
  const legacyRows = [...g6.t.slice(6, 12), ...g9.t.slice(6, 15)];
  ok("R3 无计时字段各行耗时列 ·（padS 6）", legacyRows.every((r: string) => r.endsWith("     ·")), JSON.stringify(legacyRows));
  ok("R3 无计时字段 t[2] 不含 共", !g6.t[2].includes("共") && !g9.t[2].includes("共"), g6.t[2]);
  const noNow = buildRows({ ...base, mode: "daily", size: "S", phase: "building", phaseEnteredAt: new Date(NOW - 65000).toISOString() }, null, [], "", T);
  ok("R3 缺 now 进行中行降级 ·（纯函数确定性）", noNow.t[9].endsWith("     ·"), noNow.t[9]);

  // R4 done 冻结：总耗时与 now 无关（两次不同 now 结果逐字相同）
  const doneSt = {
    ...base, mode: "daily", size: "M", phase: "done",
    startedAt: new Date(NOW - 754000).toISOString(),
    finishedAt: new Date(NOW - 700000).toISOString(),
    phaseDurations: { intake: 42, planning: 130, review: 5, building: 60, testing: 30 },
  };
  const d1 = buildRows(doneSt, null, [], "", T, NOW);
  const d2 = buildRows(doneSt, null, [], "", T, NOW + 600000);
  ok("R4 done 总耗时冻结（两 now 逐字相同）", JSON.stringify(d1) === JSON.stringify(d2));
  ok("R4 done t[2] 含 共 0:54（finishedAt-startedAt）", d1.t[2].includes("共 0:54"), d1.t[2]);

  // R5 装饰线：w=80 头/细/尾线；缺省 w 同 80；early-return 分支继承
  const w80 = buildRows({ ...base, mode: "daily", size: "S", phase: "building" }, null, [], "", T, undefined, 80);
  ok("R5 w=80 头线 80 cell", dispW(w80.t[0]) === 80, w80.t[0]);
  ok("R5 w=80 细线 空格+79─", w80.t[5] === " " + "─".repeat(79), w80.t[5]);
  ok("R5 w=80 尾线 80─", w80.t[19] === "─".repeat(80), w80.t[19]);
  ok("R5 缺省 w 同 80", dispW(g6.t[0]) === 80 && g6.t[5] === " " + "─".repeat(79) && g6.t[19] === "─".repeat(80), g6.t[0]);
  const e80 = buildRows(null, "boom", [], "", T, undefined, 80);
  ok("R5 错误分支装饰线继承 w", dispW(e80.t[0]) === 80 && e80.t[19] === "─".repeat(80), e80.t[0]);

  // R7 fp tick 不加 timer（静态守卫；P4 结构守卫全绿另见 P4 块）
  const src = await (await import("node:fs/promises")).readFile(new URL("../tui/index.tsx", import.meta.url), "utf8");
  ok("R7 setInterval 唯一（复用 5s 轮询，不加新 timer）", (src.match(/setInterval\(/g) ?? []).length === 1);
  ok("R7 无 setTimeout", !src.includes("setTimeout("));
  ok("R7 fp 含 5s tick（闲置驱动刷新）", src.includes("Math.floor(Date.now() / 5000)"));
}

console.log("（清理 setup 定时器与订阅）");
for (const c of cleanups) { try { c(); } catch { } }
console.log(`\n${pass} 通过, ${errors.length} 失败`);
if (errors.length) { console.log("失败项：\n - " + errors.join("\n - ")); process.exit(1); }
