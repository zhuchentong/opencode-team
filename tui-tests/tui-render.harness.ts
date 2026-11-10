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
  const listeners: Array<() => void> = [];
  const ctx = {
    theme,
    options: {},
    ui: {
      slot: (cfg: any) => { slots[cfg.append] = cfg.render; },
      panel: { open: () => false },
      toast: { show: () => {} },
    },
    keymap: { layer: (fn: any) => { keymaps.push(fn); } },
    client: {
      rpc(_def: any) {
        return {
          state: async (_input: any) => ({ active: false, slug: "", phase: null }),
          list: async (_input: any) => ({ sessions: listSessions }),
          events: { on: (_name: string, cb: () => void) => { listeners.push(cb); return () => {}; } },
        };
      },
    },
    data: { session: { get: (_id: string) => ({ projectID: "p1", location: { directory: "/proj" } }) } },
  };
  return { ctx, slots, keymaps, listeners, setSessions: (s: any[]) => { listSessions = s; } };
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

console.log(`\n${pass} 通过, ${errors.length} 失败`);
if (errors.length) { console.log("失败项：\n - " + errors.join("\n - ")); process.exit(1); }
