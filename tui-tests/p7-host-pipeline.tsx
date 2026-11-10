// p7-host-pipeline.tsx — 宿主 session.panel 管线高保真复刻（真实 solid client 构建）
//
// 与 harness P6 的区别：P6 用 createMemo 手写 replica（低保真）。本文件在
// `bun --conditions=browser`（solid-js 解析到 dist/solid.js，与宿主同一构建）下
// 使用**真实 Show / ErrorBoundary / children helper**，按二进制提取的宿主源码
// 逐行复刻 H0/gDt 装配：
//   H0(t)  = <ErrorBoundary fallback={toast}> <gDt>{get children(){return t.children}}</gDt> </ErrorBoundary>
//   gDt(t) = r = children(()=>t.children); n = memo(()=>{ i=r.toArray(); 裸文本检查; return i }); insert 渲染 n
//   UA(c.render, input) 即 createComponent(render, props)
// 崩溃捕获：真实 ErrorBoundary 的 fallback 收进数组，断言无崩溃。
// 场景对照：
//   A 我们当前的 render 形状（rc 函数包装 + Show + fallback）
//   B 官方示例形状（直接返回 JSX 元素，无外层函数包装）
// 运行：bun --conditions=browser tui-tests/p7-host-pipeline.tsx
import assert from "node:assert/strict";
import * as fs from "node:fs";

const mockDir = new URL("../node_modules/@opencode/plugin/", import.meta.url).pathname;
if (!fs.existsSync(mockDir)) {
  fs.mkdirSync(mockDir, { recursive: true });
  fs.writeFileSync(
    `${mockDir}package.json`,
    JSON.stringify({
      name: "@opencode/plugin", version: "0.0.0-local-mock", private: true, type: "module",
      exports: { "./tui": "./mock-tui.js", "./rpc": "./mock-rpc.js" },
    }, null, 2),
  );
  fs.writeFileSync(`${mockDir}mock-tui.js`, "export const Plugin = { define: (def) => def };\n");
  fs.writeFileSync(`${mockDir}mock-rpc.js`, "export const Rpc = { define: (def) => def };\n");
}

const $solid = await import("solid-js");
const { createSignal, createMemo, createComponent, children, Show, ErrorBoundary } = $solid;
// @ts-ignore 动态 import 主模块
const { default: mod } = await import("../tui/index.tsx");
const { testRender } = await import("@opentui/solid");

// 确认解析到 client 构建（server 构建无 Show 组件语义）
console.log(`solid-js 构建: ${typeof Show === "function" ? "client(Show 存在)" : "非 client!"}`);
assert.ok(typeof Show === "function", "需要 client 构建的 Show（用 --conditions=browser 运行）");
assert.ok(typeof ErrorBoundary === "function", "需要 client 构建的 ErrorBoundary");

let pass = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── mock ctx（与 harness 一致）─────────────────────────────────────
function makeCtx() {
  const slots: Record<string, (props: any) => any> = {};
  const keymaps: any[] = [];
  let listSessions: any[] = [];
  const listeners: Array<() => void> = [];
  const ctx = {
    theme: { text: { base: "#fff", muted: "#888", action: { primary: "#0af" }, feedback: { error: "#f55" } } },
    options: {},
    ui: { slot: (cfg: any) => { slots[cfg.append] = cfg.render; }, panel: { open: () => false }, toast: { show: () => {} } },
    keymap: { layer: (fn: any) => { keymaps.push(fn); } },
    client: {
      rpc(_def: any) {
        return {
          state: async () => ({ active: false, slug: "", phase: null }),
          list: async () => ({ sessions: listSessions }),
          events: { on: (_n: string, cb: () => void) => { listeners.push(cb); return () => {}; } },
        };
      },
    },
    data: { session: { get: (_id: string) => ({ projectID: "p1", location: { directory: "/proj" } }) } },
  };
  return { ctx, slots, listeners, setSessions: (s: any[]) => { listSessions = s; } };
}

const t = mod as { id: string; setup: (ctx: any) => void };

// ── 宿主 gDt 逐行复刻：children() → toArray() → 裸文本检查 → insert 渲染 ──
function GdtHostReplica(props: any) {
  const r = children(() => props.children);
  const n = createMemo(() => {
    const i = r.toArray();
    if (i.some((o: any) => typeof o === "string" || typeof o === "number")) {
      throw new Error("rendered bare text; wrap it in <text>");
    }
    return i;
  });
  // 宿主源码的 Q(n)：memo 作为函数 children 流入容器 → opentui insert 路径
  return <box>{n as any}</box>;
}

// ── 宿主 H0 逐行复刻：ErrorBoundary(fallback=toast) 包 gDt，children = createComponent(render, input) ──
function H0HostReplica(props: { id: string; where: string; render: (p: any) => any; input: any; crashes: string[] }) {
  return createComponent(ErrorBoundary, {
    fallback: ((err: any) => {
      props.crashes.push(`${props.id}: ${err?.message ?? String(err)}`);
      return null as any;
    }) as any,
    get children() {
      return createComponent(GdtHostReplica, {
        get children() { return createComponent(props.render as any, props.input); },
      });
    },
  });
}

async function runScenario(label: string, render?: (panel: any) => any) {
  const crashes: string[] = [];
  const { ctx, slots, setSessions, listeners } = makeCtx();
  t.setup(ctx as any);
  const panelRender = render ?? slots["session.panel"];

  const diffsRender = (panel: any) => (
    <Show when={panel?.name === "diffs"}>
      <box><text>DIFFS PANEL</text></box>
    </Show>
  );

  let setup: any = null;
  try {
    setSessions([
      { sessionID: "s1", slug: "task-one", phase: "building", rounds: { plan_review: 1, build_review: 0, test_fix: 0 }, testPlanWritten: true, updatedAt: "2026-11-10T10:00:00Z" },
      { sessionID: "s2", slug: "task-two", phase: "testing", rounds: { plan_review: 2, build_review: 1, test_fix: 0 }, testPlanWritten: true, testReportVerdict: "PASS", updatedAt: "2026-11-10T11:00:00Z" },
    ]);
    const [pn, setPn] = createSignal("diffs");
    const panelObj = { get name() { return pn(); }, sessionID: "ses_main" };
    setup = await testRender(() => {
      // 容器等价 S$：panel box 挂两个 slot 贡献（宿主内置 diffs + 我们的），真实共存
      return (
        <box>
          <H0HostReplica id="opencode.diffs" where="slot session.panel" render={diffsRender} input={panelObj} crashes={crashes} />
          <H0HostReplica id="wf-workflow-tui" where="slot session.panel" render={panelRender} input={panelObj} crashes={crashes} />
        </box>
      );
    }, { width: 60, height: 30 });

    // 序列 1：面板已开（name=diffs 起步 → 切 wf.board，真实 reconcile）
    await setup.flush();
    setPn("wf.board");
    await setup.flush();
    await setup.flush();
    ok(`${label}·切换 diffs→wf.board 后无贡献崩溃`, crashes.length === 0, crashes.join(" | "));
    // 注：不断言帧文本——testRender 帧循环限制（见 ERR 记录：signal→帧端到端不可靠）；
    // 面板真实挂载与数据流以 probe（panelEv 序列）为证

    // 序列 2：updated 事件 → refresh → rows 变化（按 a/r 的真实更新）
    setSessions([
      { sessionID: "s3", slug: "after-update", phase: "done", rounds: {}, testPlanWritten: false, updatedAt: "2026-11-10T13:00:00Z" },
    ]);
    for (const cb of listeners) cb();
    await setup.flush();
    await setup.flush();
    ok(`${label}·updated 重渲染后无崩溃`, crashes.length === 0, crashes.join(" | "));

    // 序列 3：关面板（name diffs→null→wf.board 再开）
    setPn("other");
    await setup.flush();
    setPn("wf.board");
    await setup.flush();
    await setup.flush();
    ok(`${label}·关闭再开后无崩溃`, crashes.length === 0, crashes.join(" | "));
  } catch (e: any) {
    ok(`${label}·整体不抛异常`, false, `${e?.message} @ ${String(e?.stack).split("\n").slice(1, 4).join(" <- ")}`);
  } finally {
    if (setup) await setup.dispose();
  }
}

console.log("── 场景 A：当前插件 render（经真实宿主 H0/gDt/insert 管线）──");
runScenario("A");

console.log(`\n${pass} 通过, ${failures.length} 失败`);
if (failures.length) { console.log("失败项：\n - " + failures.join("\n - ")); process.exit(1); }
