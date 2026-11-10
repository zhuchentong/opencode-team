// tui-render.harness.ts — wf-workflow TUI 插件本地渲染测试（侧边栏挂件）
//
// 历史（ERR-20261110-004/005）：wf-board 面板因宿主 session.panel slot 管线在
// 信号更新→子树换入路径崩溃（e.length），多轮修复无效后已删除（r28）。
// 本 harness 相应缩减为：
//   P0 setup 只注册 sidebar slot，不得再注册 session.panel（防面板回归）
//   P4 源码静态守卫：面板相关代码模式不存在
//   P5 侧边栏挂件渲染不崩
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
  const ctx = {
    theme,
    options: {},
    ui: {
      slot: (cfg: any) => { slots[cfg.append] = cfg.render; },
      panel: { open: () => false },
      toast: { show: (t: any) => { toasts.push(t); } },
    },
    keymap: { layer: (fn: any) => { keymaps.push(fn); } },
    client: {
      rpc(_def: any) {
        return {
          state: async (_input: any) => stateReply,
          list: async (_input: any) => ({ sessions: listSessions }),
          events: { on: (name: string, cb: () => void) => { listeners.push({ name, cb }); return () => {}; } },
        };
      },
    },
    data: { session: { get: (_id: string) => ({ projectID: "p1", location: { directory: "/proj" } }) }, listen: (cb: any) => { dataCbs.push(cb); return () => { } } },
  };
  return { ctx, slots, keymaps, listeners, toasts, dataCbs, setSessions: (s: any[]) => { listSessions = s; }, setState: (s: any) => { stateReply = s; } };
}

const t = mod as { id: string; setup: (ctx: any) => void };
console.log(`插件 id: ${t.id}`);

// ── P0：slot 注册面（只有 sidebar，面板必须已移除）──────────────────
{
  const { ctx, slots } = makeCtx();
  t.setup(ctx as any);
  ok("P0 setup 注册了 sidebar.content slot", typeof slots["sidebar.content"] === "function");
  ok("P0 setup 未注册 session.panel（wf-board 已永久移除）", slots["session.panel"] === undefined);
}

// ── P4：源码静态守卫——面板代码模式不得回归（用精确代码串，注释文本不受影响）─
{
  const src = await (await import("node:fs/promises")).readFile(new URL("../tui/index.tsx", import.meta.url), "utf8");
  ok("P4 无 WfBoardPanel 组件定义", !src.includes("function WfBoardPanel"));
  ok("P4 无 session.panel slot 注册代码", !src.includes('append: "session.panel"'));
  ok("P4 无 wf.board 面板打开命令", !src.includes('"wf.board"'));
}

// ── P5：侧边栏挂件（活跃态与回退列表态都不崩）───────────────────────
{
  const { ctx, slots, setSessions } = makeCtx();
  t.setup(ctx as any);
  const sidebarRender = slots["sidebar.content"];
  setSessions([
    { sessionID: "s1", slug: "task-one", phase: "building", rounds: { plan_review: 1, build_review: 0, test_fix: 0 }, testPlanWritten: true, updatedAt: "2026-11-10T10:00:00Z" },
    { sessionID: "s2", slug: "task-two", phase: "testing", rounds: { plan_review: 2, build_review: 1, test_fix: 0 }, testPlanWritten: true, testReportVerdict: "PASS", updatedAt: "2026-11-10T11:00:00Z" },
  ]);
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_y" }), { width: 50, height: 14 });
    await setup.flush();
    await setup.flush();
    const frame = setup.captureCharFrame();
    ok("P5 侧边栏渲染不崩", true);
    ok("P5 侧边栏含 wf 标识", frame.includes("wf"));
    await setup.dispose();
  } catch (e: any) {
    ok("P5 侧边栏渲染不崩", false, e?.message);
  }
}

// ── P6：report 事件 → toast（命令输出可见性通道，ERR-20261110-007）──
{
  const { ctx, slots, listeners, toasts } = makeCtx();
  t.setup(ctx as any);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_z" }), { width: 50, height: 14 });
    await setup.flush();
    const reportCbs = listeners.filter((l) => l.name === "report");
    ok("P6 侧边栏订阅了 report 事件", reportCbs.length >= 1, `listeners=${listeners.map((l) => l.name).join(",")}`);
    reportCbs.forEach((l) => l.cb({ sessionID: "ses_z", text: "wf 健康检查报告" }));
    ok("P6 report 本会话 → toast 呈现", toasts.some((x) => x.message === "wf 健康检查报告" && x.variant === "info"));
    reportCbs.forEach((l) => l.cb({ sessionID: "ses_other", text: "跨会话报告" }));
    ok("P6 report 他会话 → 不弹 toast", !toasts.some((x) => x.message === "跨会话报告"));
    await setup.dispose();
  } catch (e: any) {
    ok("P6 report→toast 不崩", false, e?.message);
  }
}

// ── P7：双通道兜底（context.data 全事件流）+ 跨通道去重（r29d）──
{
  const { ctx, slots, listeners, toasts, dataCbs } = makeCtx();
  t.setup(ctx as any);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_d" }), { width: 50, height: 14 });
    await setup.flush();
    ok("P7 订阅了 data.listen 兜底通道", dataCbs.length >= 1);
    // data 通道信封（宿主真实形状待真机 data-raw 探针确认，此处按文档 details.type/details.data）
    dataCbs.forEach((cb) => cb({ details: { type: "rpc.wf.report", data: { sessionID: "ses_d", text: "data 通道报告" } } }));
    ok("P7 data 通道 report → toast 呈现", toasts.some((x) => x.message === "data 通道报告"));
    // 非 wf 事件被忽略（不产生 toast）
    dataCbs.forEach((cb) => cb({ details: { type: "session.idle", data: {} } }));
    ok("P7 非 rpc.wf 事件忽略", toasts.length === 1, `toasts=${toasts.length}`);
    // 去重：同一 (sessionID,at) 两通道都到 → 只弹一次（r29e 统一 key=sessionID|at）
    const n0 = toasts.length;
    const atNow = new Date().toISOString();
    dataCbs.forEach((cb) => cb({ details: { type: "rpc.wf.report", data: { sessionID: "ses_d", text: "dup 文本", at: atNow } } }));
    const rpCbs = listeners.filter((l) => l.name === "report");
    rpCbs.forEach((l) => l.cb({ sessionID: "ses_d", text: "dup 文本", at: atNow }));
    ok("P7 跨通道同 at 去重", toasts.length - n0 === 1, `新增 ${toasts.length - n0} 条（应为 1）`);
    // 新鲜度门：>60s 的旧报告不弹（防新挂载重放）
    const oldAt = new Date(Date.now() - 120000).toISOString();
    dataCbs.forEach((cb) => cb({ details: { type: "rpc.wf.report", data: { sessionID: "ses_d", text: "过期报告", at: oldAt } } }));
    ok("P7 60s 外旧报告不弹（新鲜度门）", !toasts.some((x) => x.message === "过期报告"));
    await setup.dispose();
  } catch (e: any) {
    ok("P7 双通道不崩", false, e?.message);
  }
}

// ── P8：轮询主通道——state.lastReport → toast（r29e 主通道：事件投递真机不通，methods 实证可用）──
{
  const { ctx, slots, toasts, setState } = makeCtx();
  setState({ active: false, slug: "", phase: null, lastReport: { sessionID: "ses_p8", text: "轮询报告", at: new Date().toISOString() } });
  t.setup(ctx as any);
  const sidebarRender = slots["sidebar.content"];
  try {
    const setup = await testRender(() => sidebarRender({ sessionID: "ses_p8" }), { width: 50, height: 14 });
    await setup.flush();
    await setup.flush();
    await new Promise((r) => setTimeout(r, 100));
    ok("P8 轮询读到 lastReport → toast 呈现", toasts.some((x) => x.message === "轮询报告"), `toasts=${JSON.stringify(toasts)}`);
    // 同一 at 再轮询不重复弹（去重）
    await new Promise((r) => setTimeout(r, 2600));
    const n = toasts.filter((x) => x.message === "轮询报告").length;
    ok("P8 同 at 跨轮询周期去重", n === 1, `弹了 ${n} 次（应为 1）`);
    await setup.dispose();
  } catch (e: any) {
    ok("P8 轮询通道不崩", false, e?.message);
  }
}

console.log(`\n${pass} 通过, ${errors.length} 失败`);
if (errors.length) { console.log("失败项：\n - " + errors.join("\n - ")); process.exit(1); }
