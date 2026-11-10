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
const { default: mod } = await import("../tui/index.tsx");
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
  const listeners: Array<{ name: string; cb: (data?: any) => void }> = [];
  const toasts: any[] = [];
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
          events: { on: (name: string, cb: () => void) => { listeners.push({ name, cb }); return () => { }; } },
        };
      },
    },
    data: { session: { get: (_id: string) => ({ projectID: "p1", location: { directory: "/proj" } }) }, listen: (cb: any) => { dataCbs.push(cb); return () => { }; } },
  };
  return {
    ctx, slots, keymaps, listeners, toasts, dataCbs, editor,
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
    ok("P5 帧含 wf 分隔线", frame.includes("── wf"), JSON.stringify(frame.slice(0, 80)));
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

console.log("（清理 setup 定时器与订阅）");
for (const c of cleanups) { try { c(); } catch { } }
console.log(`\n${pass} 通过, ${errors.length} 失败`);
if (errors.length) { console.log("失败项：\n - " + errors.join("\n - ")); process.exit(1); }
