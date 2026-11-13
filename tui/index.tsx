// wf-workflow TUI（P4：通知层三件套补齐，渲染层保持 P3b 流派 A 逐字不动）
// ── P3b 结论（真机实证）：slot render 顶层零响应式 + 唯一 accessor 换树 = 不崩（containers:1，
//    build 序列无 render-ERR）。P4 只动数据/通知面，渲染结构禁改（harness P4 静态守卫锁定）。
// ── P4 新增（方案 §2.4 通知层）：
//    ① server.connected 重拉：官方 goal.tsx 三件套第三件——SSE 断线窗口内丢失的 rpc.* 事件不重放，
//      重连信号到达即 lastFp 重置 + refresh()，配合 60s 新鲜度门保证窗口期报告由 poll 通道必达；
//    ② attention.notify：toast 实际弹出后，按 server 结构化 level==="warn" 发系统级通知
//      （notification-brief-display T04：废除全文正则误弹——旧 ⚠️/❌/FAIL 判定每次流转必弹）；
//      宿主按终端焦点决定投递（后台时用户可感知），fail-soft（API 缺失静默降级为纯 toast）；
//    ③ AbortSignal：RPC 事件订阅经 AbortController 统一管理，cleanup 时 abort（quota/goal 形态）。
// 主轨命令（P0⑧ 真机验证）：return 键 priority-1 拦截层——输入以 /wf: 开头则清空编辑器并
//   经 RPC exec 本地执行（返回值渲染 toast）；否则同步返回 false 透传（返回 Promise 即算已处理）。
//   server 同名命令注册保留作降级轨（Web/Desktop：wait→prompt(resume:false) 注入）。
// 数据通道：RPC methods（state/list/exec，location 必带）主 + updated/report 事件 + data.listen
//   兜底 + server.connected 重拉 + 5s 轮询对账；事件按 location.directory 过滤（P0 多实例发现）。
// toast：sessionID|at 去重（exec 返回同一 at，本地渲染先行登记，防事件/轮询二次弹）+ 60s 新鲜度门
//   （门 60s ≫ 轮询 5s：任何存活窗口内的报告最迟 5s 被 poll 捞到且仍在门内——轮询必达成对设计）。
// 探针：无条件写 .workflow/_debug/tui-refresh.log（低量：loaded/slot-render/build 抽样/
//   refresh 变化时/recv 每次到达/notify/server-connected）。
import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import * as ot from "@opentui/solid";
const { createElement, insert, setProp } = ot as any; // 低层原语（宿主注入运行时实例，P0 同款）
import { Wf } from "../shared/rpc.ts";
import { STAGE_ORDER, FOLD, CANON, DAILY_STAGE_ORDER } from "../shared/phases.ts";
import { VERSION } from "../shared/version.ts"; // M16-r39 T08：版本归一（server/TUI 同源）
import { redactIds } from "../shared/redact.ts"; // notification-brief-display T04：legacy 降级脱敏同源（G-1/A）

const TUI_BUILD = VERSION;
const ROWS = 20;

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// notification-brief-display T04（plan §4 冻结）：toast/通知文案选择——brief 非空用 brief；
// 否则旧行/旧事件（brief=null）本地降级：text 前两行各截 100 码点并过 redactIds（零回显 A/G-1）。
// 模块级纯函数供 harness 直测；60s 新鲜度门保证降级形态只短暂可见。
export function briefOf(d: any): string {
  const b = str(d?.brief);
  if (b) return b;
  const text = str(d?.text);
  if (!text) return "";
  return text.split("\n").slice(0, 2).map((l: string) => {
    const cps = Array.from(l);
    return redactIds(cps.length > 100 ? cps.slice(0, 100).join("") + "…" : l);
  }).join("\n");
}
const errMsg = (e: unknown) => String((e as Error)?.message ?? e);
const sanitize = (s: string) => (String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, 200) || " ");

// ── M16-r37 表格化：显示宽度（CJK=2 cell）与 cell 补位 ────────────────
// 对齐列内只允许 CJK+ASCII（状态词 完成/进行/待办 各 4 cell、占位 ·），
// 歧义宽度字符（●○▶✓✗—）一律留在非表格行，杜绝终端宽度分歧导致的错列。
export const dispW = (s: string) => {
  let w = 0;
  for (const ch of String(s ?? "")) {
    const c = ch.codePointAt(0) ?? 0;
    w += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xac00 && c <= 0xd7af) ? 2 : 1;
  }
  return w;
};
const padE = (s: string, w: number) => s + " ".repeat(Math.max(0, w - dispW(s)));
const padS = (s: string, w: number) => " ".repeat(Math.max(0, w - dispW(s))) + s;
const fit = (s: string, w: number) => {
  let out = "";
  let acc = 0;
  for (const ch of String(s ?? "")) {
    const cw = dispW(ch);
    if (acc + cw > w) break;
    out += ch;
    acc += cw;
  }
  return padE(out, w);
};
// tui-sidebar-elapsed：耗时格式 m:ss（负数钳 0；>999:59 由 padS/fit 自然截，>16.6h 极端场景接受截断）
export const fmtElapsed = (sec: number): string => { const s2 = Math.max(0, Math.floor(sec)); return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, "0")}`; };
// 中文阶段名（TUI 显示层本地映射；shared/phases.ts 语义常量不动，折叠语义沿用 FOLD）
const ZH: Record<string, string> = {
  intake: "需求录入", planning: "计划", review: "计划审核", test_design: "测试设计",
  building: "执行", reconcile: "合并", build_review: "执行审核", testing: "测试",
  fixing: "修复", done: "交付", retrospect: "交付", assign: "测试设计",
};
const zhOf = (phase: any) => ZH[FOLD[phase] ?? phase] ?? str(phase ?? "?");
const mark = (ok: boolean) => (ok ? "✓" : "✗");
// M16-r46 批1：产物清单格式化（KB 大小 0.5k/1.2k；行=▸+名字 fit 18+✓/✗/免+大小）——模块级纯函数
const fmtKB = (b: unknown) => { const n = Number(b ?? 0); return n > 0 ? `${(n / 1024).toFixed(1).replace(/\.0$/, "")}k` : ""; };
const artLine = (name: string, ok: boolean, kb: string, exempt?: boolean) =>
  `  ▸ ${fit(name, 18)} ${exempt ? "免" : mark(ok)}${exempt || !kb ? "" : ` ${kb}`}`;

// ── 节点构造：P0 探针逐字收敛（真机不崩的形态）────────────────────
function textEl(s: string, fg?: any) {
  const t = createElement("text");
  try { if (fg) setProp(t, "fg", fg); } catch { /* ignore */ }
  try { setProp(t, "wrapMode", "none"); } catch { /* fail-soft：宿主旧版无此 prop 不杀 slot */ }
  insert(t, [sanitize(s)]); // 数组形态（P0 实证）；文本恒非空
  return t;
}
function boxEl(children: unknown[], height?: string) {
  const b = createElement("box");
  setProp(b, "width", "100%");
  if (height) { try { setProp(b, "height", height); } catch { /* fail-soft：旧版宿主 prop 形态不符不杀 slot */ } }
  setProp(b, "flexDirection", "column");
  for (const c of children) if (c !== null && c !== undefined && c !== false) insert(b, c);
  return b;
}
// M16-r48c artifact-md-syntaxstyle：syntaxStyle 接线（真机 markdown 无着色/conceal 根因修复）。
// core CodeRenderable 高亮路径直接用裸字段 this._syntaxStyle（无 fallback getter，chunk-bun:14987）
// → undefined → treeSitterToTextChunks2 TypeError → 被内部 catch（"Code highlighting failed, falling
// back to plain text"）→ 静默退化 raw 文本。宿主自身 markdown 组件总是显式传 theme 派生 syntaxStyle。
// 宿主二进制含 runtime-module 映射 Zz=["@opentui/core","@opentui/core/testing"]→opentui:runtime-module:
// → 动态 import 预期拿到宿主同份 core 实例（类身份一致）；vite external 同步（防打包第二份 core）。
// 三层 fail-soft：import 失败/类缺失/create·setProp throw → 不传 → 现状 raw（不崩）。
// 缓存按 nativeScene owner 分键（Map）：SyntaxStyle 资源绑定 owner（宿主二进制 "SyntaxStyle Context
// owner mismatch" 佐证）——harness 每 testRender 新建 renderer，单一全局缓存会跨 context 误用致正文
// 消失（P17a 红态实证）；真机单 renderer 仅一项，不泄漏（MarkdownRenderable destroy 不释放外部
// syntaxStyle，宿主另有独立 destroyContextSyntaxStyle 佐证）。
let SyntaxStyleClass: any = null;
let syntaxStyleImportErr = "";
const syntaxStyleCache = new Map<any, any>();
import("@opentui/core").then(
  (mod: any) => { SyntaxStyleClass = mod?.SyntaxStyle ?? null; },
  (e: unknown) => { syntaxStyleImportErr = errMsg(e); }, // 异步回调执行时 errMsg 已初始化（无 TDZ）
);
// M16-r48 artifact-md-preview：markdown 正文构造器（流派 A 同构原语）。
// catalogue 缺 markdown（旧版宿主）或构造/建块异常 → createElement/setProp 构造期同步 throw → 返回 null，
// 调用方走纯文本逐行降级轨；onError 由 setup 闭包注入（probe 归因 hasMd）。
// 注意：content 原文直喂，不经 sanitize——sanitize 折叠换行+截 200 字符会毁整篇块语义（表格/围栏必须完整行）。
const hasMdCatalogue = (): boolean | "unknown" => {
  try { return !!(ot as any).getComponentCatalogue?.().markdown; } catch { return "unknown"; }
};
function mdEl(content: string, onError?: (info: { err: string; hasMd: boolean | "unknown" }) => void, onStyle?: (info: Record<string, unknown>) => void) {
  let m: any = null;
  try {
    m = createElement("markdown");
    try { setProp(m, "width", "100%"); } catch { /* 旧版宿主 prop 形态不符：fail-soft 不杀主轨 */ }
    // M16-r48c：syntaxStyle 必须先于 content——content setter 同步建块，子 CodeRenderable 构造时
    // 捕获 this._syntaxStyle；缺失则异步 highlight throw 被吞、静默退化 raw（本次根因）。
    if (SyntaxStyleClass) {
      try {
        const owner = m.ctx?.nativeScene;
        let ss = syntaxStyleCache.get(owner);
        if (ss === undefined) { ss = SyntaxStyleClass.create(owner); syntaxStyleCache.set(owner, ss); }
        setProp(m, "syntaxStyle", ss);
        onStyle?.({ evt: "syntax-style-ok" });
      } catch (e2) {
        onStyle?.({ evt: "syntax-style-err", err: errMsg(e2) });
      }
    } else if (syntaxStyleImportErr) {
      onStyle?.({ evt: "syntax-style-import-err", err: syntaxStyleImportErr });
    }
    setProp(m, "content", content || " "); // 恒非空（textBuffer 语义与 textEl 对齐）
    return m;
  } catch (e) {
    if (m && typeof m.destroy === "function") { try { m.destroy(); } catch { /* 次级清理错误忽略 */ } }
    onError?.({ err: errMsg(e), hasMd: hasMdCatalogue() });
    return null;
  }
}
// M16-r48b artifact-preview-scroll：正文滚动容器构造器（宿主 2.2.6 plugin route 挂载链无滚动容器——
// 取证 x1e→H0→UA 全程裸挂，自然高度溢出视口即裁剪；r46 纯文本轨同缺陷）。children 为滚动内容，
// 头尾固定行由调用方留在外层。flexGrow 1 占满外层 column 剩余高度（外层 height 约束，不在本元素设
// height:100%——那会挤出兄弟固定行）。catalogue 缺 scrollbox（旧宿主）→ 构造期同步 throw → null，
// 调用方正文直挂（=现状行为）。
const hasScrollCatalogue = (): boolean | "unknown" => {
  try { return !!(ot as any).getComponentCatalogue?.().scrollbox; } catch { return "unknown"; }
};
function scrollEl(children: unknown[], onError?: (info: { err: string; hasScroll: boolean | "unknown" }) => void) {
  let s: any = null;
  try {
    s = createElement("scrollbox");
    try { setProp(s, "width", "100%"); } catch { /* fail-soft */ }
    try { setProp(s, "flexGrow", 1); } catch { /* fail-soft */ }
    for (const c of children) if (c !== null && c !== undefined && c !== false) insert(s, c);
    return s;
  } catch (e) {
    if (s && typeof s.destroy === "function") { try { s.destroy(); } catch { /* 次级清理错误忽略 */ } }
    onError?.({ err: errMsg(e), hasScroll: hasScrollCatalogue() });
    return null;
  }
}

const stageOf = (phase: any, order: string[] = STAGE_ORDER) => {
  const p = FOLD[phase] ?? phase;
  const i = order.indexOf(p);
  return i < 0 ? 0 : i;
};

export const listLine = (x: any) => {
  const r = x?.rounds ?? {};
  return `${fit(str(x?.slug || "(未定)"), 14)} ${fit(zhOf(x?.phase), 8)} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
};

// M16-r37 表格化：恒定 20 行 = 头线/slug/进度/空/表头/细线/阶段行(6|9)/尾段(关卡+产物×2)/提示/尾线。
// 阶段行列几何 1+2+1+8+2+4+2+4+2+6=32 cell（状态词偏移恒 14、轮次右对齐 4 cell 20-23、
// 耗时右对齐 6 cell 26-31；tui-sidebar-elapsed）；装饰线拉满 w（缺省 80，超宽靠 wrapMode:"none" 硬裁剪）。
// 导出供 harness P11 纯函数直测 + P12 真渲染复核（绕开 testRender 信号→换树盲区）；渲染结构不变。
export const buildRows = (s: any, err: string | null, oth: string[], othScope: string, T: any, now?: number, w?: number) => {
  const t: string[] = Array.from({ length: ROWS }, () => " ");
  const c: any[] = Array.from({ length: ROWS }, () => T.text.muted);
  // M16-r46 批2：af[r] = 该行首个可点击产物文件名（null=不可点击）——render 端据此绑 onMouseDown。
  // 可点击判定：已记账（✓）且在白名单（artifacts key）；✗/免/溢出/计数不绑（验证问题3 决策）。
  const af: (string | null)[] = Array.from({ length: ROWS }, () => null);
  // tui-sidebar-elapsed：装饰线拉满 pane 宽 w（缺省 80）；在 early-return 分支前赋值，错误/无任务/非活跃自然继承
  const W = w ?? 80;
  t[0] = "── Workflow " + "─".repeat(Math.max(0, W - 12));
  t[ROWS - 1] = "─".repeat(W);
  if (err) {
    t[1] = `wf 错误: ${err}`; c[1] = T.text.feedback.error;
    return { t, c, af };
  }
  if (!s) {
    t[1] = "  wf: …";
    return { t, c, af };
  }
  if (!s.active) {
    if (oth.length > 0) {
      t[1] = `  活动任务·${othScope}`; c[1] = T.text.base;
      for (let n = 0; n < 3; n++) { if (oth[n]) { t[2 + n] = `  ${oth[n]}`; c[2 + n] = T.text.action.primary; } }
    } else {
      t[1] = "  wf: 本会话无活动任务";
    }
    return { t, c, af };
  }
  const r = s.rounds ?? {};
  // 模式感知：daily 按 6 行连续进度；mode 缺失（存量）/full 走 9 行（语义同旧版，视图表格化）
  const daily = s.mode === "daily";
  const order = daily ? DAILY_STAGE_ORDER : STAGE_ORDER;
  const i = stageOf(s.phase, order);
  const total = order.length;
  const isDone = s.phase === "done" || s.phase === "retrospect";
  const planV = r.plan_review ?? 0;
  const buildV = r.build_review ?? 0;
  const fixV = r.test_fix ?? 0;
  const done = isDone ? total : i;
  const bar = "●".repeat(done) + "○".repeat(total - done);
  const arts = s.artifacts ?? {};
  const extraCount = Object.keys(arts).filter((n: string) => CANON.indexOf(n) < 0).length;
  const verdict = s.testReportVerdict;
  const size = str(s.size || "M");
  const pv = s.planReviewVerdict;
  t[1] = daily ? `  ${str(s.slug || "(未定)")} [daily·${size}]` : `  ${str(s.slug || "(未定)")}`; c[1] = T.text.base;
  t[2] = `  ${bar} ${done}/${total} · F${i} ${zhOf(s.phase)}`; c[2] = T.text.action.primary;
  // tui-sidebar-elapsed：总耗时（墙钟·冻结）——done=finishedAt-startedAt 冻结差值；否则 now-startedAt；缺失/NaN 不追加「共」
  const totalSec = s.finishedAt && s.startedAt ? (Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 1000
    : s.startedAt && now ? (now - Date.parse(s.startedAt)) / 1000 : null;
  if (totalSec !== null && Number.isFinite(totalSec)) t[2] += ` · 共 ${fmtElapsed(totalSec)}`;
  t[4] = ` ${padE("#", 2)} ${padE("阶段", 8)}  ${padE("状态", 4)}  ${padS("轮次", 4)}  ${padS("耗时", 6)}`; c[4] = T.text.muted;
  t[5] = " " + "─".repeat(W - 1); c[5] = T.text.muted;
  // 轮次归属：计划审核=plan_review、执行审核=build_review（full）、修复=fix（full）/测试=fix（daily）
  const roundOf = (stage: string) => {
    if (stage === "review") return `${planV}/3`;
    if (stage === "build_review") return `${buildV}/3`;
    if (stage === "fixing" || (daily && stage === "testing")) return `${fixV}/3`;
    return "·";
  };
  const capOf = (stage: string) =>
    (stage === "review" && planV >= 3) || (stage === "build_review" && buildV >= 3) ||
    ((stage === "fixing" || (daily && stage === "testing")) && fixV >= 3);
  for (let k = 0; k < total; k++) {
    const stage = order[k];
    const st = isDone || k < i ? "完成" : k === i ? "进行" : "待办";
    // tui-sidebar-elapsed：耗时列——完成=phaseDurations[FOLD[stage]??stage]（多轮累计）；进行中=now-phaseEnteredAt；
    // 待办/缺字段/NaN → ·（存量任务自然降级）
    let ev = "·";
    if (st === "完成") {
      const d = s.phaseDurations?.[FOLD[stage] ?? stage];
      if (Number.isFinite(d)) ev = fmtElapsed(d);
    } else if (st === "进行" && now && s.phaseEnteredAt) {
      const sec = (now - Date.parse(s.phaseEnteredAt)) / 1000;
      if (Number.isFinite(sec)) ev = fmtElapsed(sec);
    }
    const row = 6 + k;
    t[row] = ` ${String(k + 1).padStart(2, "0")} ${padE(ZH[stage] ?? stage, 8)}  ${st}  ${padS(roundOf(stage), 4)}  ${padS(ev, 6)}`;
    c[row] = capOf(stage) ? T.text.feedback.error
      : k === i && !isDone ? T.text.action.primary
        : isDone || k < i ? T.text.base : T.text.muted;
  }
  // 尾段：cursor=6+n；距提示行(ROWS-2)剩余>3 行先插空行，再 关卡/产物1/产物2 三行
  let k = 6 + total;
  if (ROWS - 2 - k > 3) { t[k] = " "; c[k] = T.text.base; k++; }
  const vTxt = verdict ? str(verdict) : "—";
  if (daily) {
    const g = size === "S" ? "verify 自检(S)" : `verify ${pv ? str(pv) : "—"}`;
    const fail = pv === "FAIL" || verdict === "FAIL";
    const pass = verdict === "PASS" || (size !== "S" && pv === "PASS");
    t[k] = `  关卡 ${g} · report ${vTxt}`;
    c[k] = fail ? T.text.feedback.error : pass ? T.text.feedback.success : T.text.muted;
  } else {
    t[k] = `  关卡 test-plan ${s.testPlanWritten ? "✓" : "✗"} · report ${vTxt}`;
    c[k] = verdict === "FAIL" ? T.text.feedback.error : verdict === "PASS" ? T.text.feedback.success : T.text.muted;
  }
  k++;
  // ── M16-r46 批1：产物区两形态 ──
  // daily：逐文件清单（前 3 项 + 「…N 更多」溢出行）——canonical 优先（plan → plan-review → test-report），
  //        extras 按 at 最近写入降序；KB 大小随 ✓ 项显示；S 级 plan-review 免审占位行。
  // full：紧凑两行（原形态 + ▸ 可点击暗示，列内容不变）。fmtKB/artLine 见模块级。
  if (daily) {
    const items: Array<{ name: string; ok: boolean; kb: string; exempt?: boolean }> = [
      { name: "plan.md", ok: !!arts["plan.md"], kb: fmtKB(arts["plan.md"]?.bytes) },
    ];
    if (size === "S") {
      items.push({ name: "plan-review", ok: false, kb: "", exempt: true }); // S 级免复审占位
    } else {
      const pr = Object.keys(arts).filter((n: string) => n.startsWith("plan-review"))
        .toSorted((a: string, b: string) => String(arts[b]?.at ?? "").localeCompare(String(arts[a]?.at ?? "")))[0];
      if (pr) items.push({ name: pr, ok: true, kb: fmtKB(arts[pr]?.bytes) });
    }
    items.push({ name: "test-report.md", ok: !!arts["test-report.md"], kb: fmtKB(arts["test-report.md"]?.bytes) });
    const extras = Object.keys(arts).filter((n: string) => CANON.indexOf(n) < 0 && !n.startsWith("plan-review"))
      .toSorted((a: string, b: string) => String(arts[b]?.at ?? "").localeCompare(String(arts[a]?.at ?? "")));
    for (const n of extras) items.push({ name: n, ok: true, kb: fmtKB(arts[n]?.bytes) });
    for (let n = 0; n < 3 && n < items.length; n++) {
      const it = items[n];
      t[14 + n] = artLine(it.name, it.ok, it.kb, it.exempt);
      c[14 + n] = T.text.base;
      if (it.ok && !it.exempt) af[14 + n] = it.name; // ✓ 项可点击（免/✗ 不绑）
    }
    const more = items.length - 3;
    if (more > 0) { t[17] = `  ▸ …${more} 更多`; c[17] = T.text.muted; }
  } else {
    t[k] = `  ▸ plan.md ${mark(!!arts["plan.md"])} · test-plan.md ${mark(!!arts["test-plan.md"])}`; c[k] = T.text.base;
    k++;
    t[k] = `     test-report.md ${mark(!!arts["test-report.md"])} · 其他 ${extraCount} 项`; c[k] = T.text.base;
    // 行级命中（终端无子行粒度）：取该行首个已记账产物；计数区不可点
    af[k - 1] = arts["plan.md"] ? "plan.md" : arts["test-plan.md"] ? "test-plan.md" : null;
    af[k] = arts["test-report.md"] ? "test-report.md" : null;
  }
  t[ROWS - 2] = "  /wf:status 查看状态"; c[ROWS - 2] = T.text.muted;
  return { t, c, af };
};

// ── notification-brief-display T04：旧全文正则判定（⚠️/❌/FAIL/illegal）已删除 ──
// 旧判定对含 ⚠️ 行的 guidance 每次流转必弹 OS 通知（误弹）。现由 server 结构化
// levelFor 判定（plan §3.3），TUI 仅 level==="warn" 通知；判定逻辑单一来源在 lib.ts。

export default Plugin.define({
  id: "wf-workflow-tui",
  setup(context: any) {
    const compact = context?.options?.compact === true || process.env.WF_COMPACT === "1"; // M16-r39 T11：env 开关（options 不传达 TUI 的主路径）
    // REPO 兜底：location 缺失时由模块 URL 反推仓库根（P3a 疑点：探针可能写错位置）
    const REPO = String(context?.location?.directory ?? "") || decodeURIComponent(new URL("../../", import.meta.url).pathname).replace(/\/$/, "");
    const LOADED_AT = new Date().toISOString();
    let seq = 0;
    // P6 收敛：探针默认关闭（真机调试期结束）；WF_DEBUG=1 ./scripts/tui-restart.sh 开启
    const PROBE_ON = process.env.WF_DEBUG === "1";
    const probe = (data: Record<string, unknown>) => {
      if (!PROBE_ON) return;
      (async () => {
        try {
          const fs = await import("node:fs");
          const dir = `${REPO}/.workflow/_debug`;
          fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(`${dir}/tui-refresh.log`, JSON.stringify({ at: new Date().toISOString(), build: TUI_BUILD, loadedAt: LOADED_AT, seq: ++seq, ...data }) + "\n");
        } catch { /* 探针失败不影响 UI */ }
      })();
    };
    // loaded 探针带 options 形状（真机已证：{package,options} 的 options 未传达 TUI → context.options={}；
    //  因此 debug 探针无条件写，compact 选项当前实际不可用——P6 文档注明）
    probe({ evt: "loaded", repo: REPO, options: JSON.stringify(context?.options ?? null), loc: str(context?.location?.directory), hasSlot: typeof context?.ui?.slot === "function", hasKeymap: typeof context?.keymap?.layer === "function", hasDataListen: typeof context?.data?.listen === "function", hasDataOn: typeof context?.data?.on === "function", hasAttention: typeof context?.attention?.notify === "function", hasRendererEditor: !!context?.renderer });

    // ── 数据层（全部拉取只发生在 timer/microtask/事件回调——追踪上下文之外）──
    const [snap, setSnap] = createSignal<any>(null); // { st, oth, othScope, err }
    let latestSid = "";
    const shown = new Set<string>();
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

    // P4②：系统级通知（终端焦点感知由宿主决定投递）——notification-brief-display T04：
    // 仅 server 结构化 level==="warn" 弹（废除全文正则），message 取 brief 前 160
    const notifyImportant = (msg: string, level: string) => {
      if (level !== "warn") return;
      try {
        context.attention?.notify?.({ title: "wf", message: msg.slice(0, 160), sound: false });
        probe({ evt: "notify" });
      } catch { /* attention 不可用则纯 toast 降级 */ }
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
        // T04：toast 呈现 brief（3-4 行结构化，server 生成；旧行本地降级）——全文墙终结；
        // 全文回看通道不变（entry/inject、wf_command 返回值、reports 槽 text 照旧）
        const brief = briefOf(d);
        context.ui.toast.show({ message: brief, variant: "info" });
        probe({ reportEv: "toast-shown", chan });
        notifyImportant(brief, str(d?.level));
      } catch (er) { probe({ reportEv: "toast-err", err: errMsg(er) }); }
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
        // fingerprint 门禁：无真实变化且同一 5s tick 内绝不发信号（OpenTUI 不短路赋值，bump 即全树重建重绘）；
        // tui-sidebar-elapsed：tick=floor(now/5000) 闲置期驱动耗时刷新（复用 5s 轮询，不加新 timer）
        const fp = JSON.stringify([s ?? null, oth, othScope, Math.floor(Date.now() / 5000)]);
        if (fp !== lastFp) {
          lastFp = fp;
          probe({ evt: "refresh", sid, active: !!s?.active, othN: oth.length });
          setSnap({ st: s ?? { active: false }, oth, othScope, err: null });
        }
      } catch (e) {
        const msg = errMsg(e);
        probe({ evt: "refresh-err", err: msg });
        const fp = "ERR:" + msg;
        if (fp !== lastFp) { lastFp = fp; setSnap({ st: null, oth: [], othScope: "", err: msg }); }
      }
    };

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

    // ── M16-r46 批2：产物预览（点击/命令 → RPC read → router route；全链 fail-soft）──
    // API 面实证状态：onMouseDown 命中=本地 harness 实证（P14）；router=2.2.6 二进制取证
    // （register/navigate/current 形状）+ 真机探针待确认（probe evt: router-probe/route-render）。
    // 降级链：router 不可用 → toast 路径；read 错误 → toast 文案；navigate 抛错 → 同上。
    const ROUTE_NAME = "wf-artifact";
    const openArtifact = async (file: string) => {
      const sid = latestSid;
      if (!sid || !file) return;
      probe({ evt: "open-artifact", file });
      try {
        const r = await rpc().read({ sessionID: sid, file }, rpcOpts());
        if (!r || r.error) { context.ui.toast.show({ message: String(r?.error ?? `读取产物失败：${file}`), variant: "info" }); return; }
        if (routerOk) {
          try {
            context.ui.router.navigate({ type: "plugin", name: ROUTE_NAME, data: { file, text: r.text, bytes: r.bytes ?? 0, path: r.path, truncated: !!r.truncated } });
            probe({ evt: "navigate-ok", file });
            return;
          } catch (e) { probe({ evt: "navigate-err", err: errMsg(e) }); }
        }
        context.ui.toast.show({ message: `产物路径：${r.path}（预览 route 不可用）`, variant: "info" });
      } catch (e) { context.ui.toast.show({ message: `打开产物失败：${errMsg(e)}`, variant: "error" }); }
    };
    let routerOk = false;
    try {
      const R = context.ui?.router;
      probe({ evt: "router-probe", hasRegister: typeof R?.register === "function", hasNavigate: typeof R?.navigate === "function", hasCurrent: typeof R?.current === "function" });
      if (typeof R?.register === "function" && typeof R?.navigate === "function") {
        R.register({
          name: ROUTE_NAME,
          render: (input: any) => {
            // 流派 A 同构：恒定容器 + 唯一 insert(accessor)；data 快照消费（navigate 时读好，零响应式依赖）
            probe({ evt: "route-render", keys: Object.keys(input ?? {}).slice(0, 8).join(",") }); // 探针①：render 入参形状取证
            const container = boxEl([], "100%"); // M16-r48b：外层高度=视口（scrollbox flexGrow 的前提；无 scroll 能力时 100% 无害）
            insert(container, () => {
              try {
                const d: any = input?.data ?? input ?? {};
                const T = context.theme ?? { text: { muted: "gray", base: "white", feedback: { error: "red" } } };
                const body = String(d.text ?? "").split("\n");
                const head = `  ${str(d.file)} · ${(Number(d.bytes) / 1024).toFixed(1)}k${d.truncated ? " · 超64KB已截断" : ""}`;
                const fixedHead = [
                  textEl("── wf 产物预览 ────────────────", T.text.muted),
                  textEl(head, T.text.muted),
                  textEl(`  ${str(d.path)}`, T.text.muted),
                  textEl(" ", T.text.muted),
                ];
                const fixedFoot = [textEl(" ", T.text.muted), textEl("  q 返回会话", T.text.muted)];
                // M16-r48 主轨：前 200 行原文喂 MarkdownRenderable（表格/代码块同步建块；标题/强调着色为异步高亮）。
                // mdEl 返回 null（构造 throw）→ 下方纯文本逐行降级轨（行为=旧版）。
                // M16-r48b：两轨正文均入 scrollbox（r48 边界「滚动区高度适配」补全）；scrollEl null → 正文直挂（=r48 行为）。
                const md = mdEl(body.slice(0, 200).join("\n"), (info) => probe({ evt: "md-el-err", ...info }), (info) => probe(info));
                if (md) {
                  probe({ evt: "route-render-md-ok", lines: Math.min(body.length, 200) });
                  const kids: unknown[] = [
                    md,
                    ...(body.length > 200 ? [textEl(`  …（共 ${body.length} 行，仅显示前 200 行；截断可能落在代码块/表格中段）`, T.text.muted)] : []),
                  ];
                  const sc = scrollEl(kids, (info) => probe({ evt: "scroll-el-err", ...info }));
                  return boxEl([...fixedHead, ...(sc ? [sc] : kids), ...fixedFoot], "100%");
                }
                // 降级轨（纯文本逐行）：正文行同样包 scrollbox，头尾固定在外
                const kids: unknown[] = [
                  ...body.slice(0, 200).map((ln: string) => textEl("  " + ln, T.text.base)),
                  ...(body.length > 200 ? [textEl(`  …（共 ${body.length} 行，仅显示前 200 行）`, T.text.muted)] : []),
                ];
                const sc2 = scrollEl(kids, (info) => probe({ evt: "scroll-el-err", ...info }));
                return boxEl([...fixedHead, ...(sc2 ? [sc2] : kids), ...fixedFoot], "100%");
              } catch (e) {
                probe({ evt: "route-render-ERR", err: errMsg(e) });
                return boxEl([textEl(`wf 预览异常: ${errMsg(e)}`, "red")]);
              }
            });
            return container;
          },
        });
        routerOk = true;
      }
    } catch (e) { probe({ evt: "router-register-err", err: errMsg(e) }); }
    if (routerOk) {
      // 退出键层（探针②：enabled 判定依赖 current() 形状——形状不符时恒 false，不劫持他处 q/esc）
      try {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 2,
          commands: [{
            id: "wf.artifact.close",
            title: "wf: 关闭产物预览",
            bind: "q",
            enabled: () => {
              try { const cur = context.ui?.router?.current?.(); return String(cur?.name ?? "") === ROUTE_NAME; } catch { return false; }
            },
            run: () => {
              try { context.ui.router.navigate({ type: "session", sessionID: latestSid }); return true; } catch (e) { probe({ evt: "close-nav-err", err: errMsg(e) }); return false; }
            },
          }],
        }));
      } catch (e) { probe({ evt: "keymap-err", err: errMsg(e) }); }
    }

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
        lastFp = ""; // 强制重拉（服务端可能已换/事件窗口有损）
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
              lastFp = "";
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
          // M16-r46 批2：wf:open 带文件名且 route 可用 → 本地产物预览（read+navigate）；
          // 其余情况（无参列清单 / router 不可用）透传 server exec（全文/清单 toast 降级轨）。
          if (name === "wf:open" && promptText.trim() && routerOk) void openArtifact(promptText.trim());
          else void execLocal(name, promptText);
          probe({ evt: "intercept-hit", name });
          return true;
        },
      }],
    }));

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
