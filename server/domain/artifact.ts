// wf-workflow — domain/artifact：kind→文件名/verdict 解析/patch 模糊匹配/阶段纪律/瘦身预算（自 lib.ts 逐字节平移）。
import { tierOf, type WfState } from "./types.ts"; // R2 T2.1：tierOf 平移至 types 叶子（flow 域消费合法化）

// ── M3：产物 kind → 文件名（循环类产物按轮次编号）──────────────────
/** 产物 kind → 文件名工厂（循环类产物按当前轮次编号）。 */
export const KIND_FILES: Record<string, (st: WfState) => string> = {
  "plan":         () => "plan.md",
  "plan-review":  (st) => `plan-review-r${Math.max(1, st.rounds?.plan_review ?? 1)}.md`, // M14：进入即计数语义下轮次即编号（旧 +1 会致首轮成 r2）
  "test-plan":    () => "test-plan.md",
  "build-review": (st) => `build-review-r${Math.max(1, st.rounds?.build_review ?? 1)}.md`, // M14：同上
  "test-report":  () => "test-report.md",
  "lessons":      () => "lessons.md",
};

// ── 产物分段阈值（M16-r47 契约单一来源）：guidance/artifact-tool 文案经 lib 引用，
// 禁在散文里散落 "2KB" 字面量——调阈值只改此处（lib-exports 全集锁须同步 +2）。
/** 产物分段阈值（KB 单位，M16-r47 契约单一来源）。 */
export const CHUNK_KB = 2;
/** 分段阈值换算为字节的常量（CHUNK_KB × 1024）。 */
export const CHUNK_MAX = CHUNK_KB * 1024;

// test-report 首行「**结论**: PASS|FAIL」解析（宽松值匹配 + 严格行首格式探测）
/**
 * 解析 test-report 首行「**结论**: PASS|FAIL」（宽松值匹配），无结论返回 UNKNOWN。
 * @param content 报告全文（容错）
 * @returns "PASS" | "FAIL" | "UNKNOWN"
 */
export function parseVerdict(content: unknown): "PASS" | "FAIL" | "UNKNOWN" {
  const m = String(content ?? "").match(/^\s*\*\*结论\*\*\s*[:：]\s*(PASS|FAIL)\b/im);
  return m ? (m[1].toUpperCase() as "PASS" | "FAIL") : "UNKNOWN";
}
/**
 * 严格探测内容是否含行首「**结论**:」格式行（宽松匹配在场的格式校验）。
 * @param content 报告全文（容错）
 * @returns 存在严格格式结论行为 true
 */
export function hasStrictVerdictLine(content: unknown): boolean {
  return /^\*\*结论\*\*[:：]/m.test(String(content ?? ""));
}

// ── M16-r47（A+B 方案）：patch 模糊匹配——三级回退，对齐宿主 edit 语义 ──────────
// 真机取证（tui-sidebar-elapsed r45）：planner-reviewer 大 payload 流中断（ECONNRESET）后
// 全量重生成再失败；严格 indexOf 的「未命中→重写全文」放大同类浪费。fuzzy 把转录微差
// （弯引号/破折号/nbsp、行尾空白）从「失败重试」降为「直接命中」。
// 阶段①：exact indexOf；阶段②：1:1 字符归一（弯引号/破折号/nbsp→ASCII，全为单
// UTF-16 unit 保长度→索引直接回映原文）；阶段③：逐行尾空白剥离后匹配，idxMap 回映。
// 每阶段歧义（多次命中）即报——宁可报错也不误替换。纯函数，bun test 直测。
const FUZZY_MAP: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201C": '"', "\u201D": '"',
  "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u00A0": " ",
};
const FUZZY_CHARS = /[\u2018\u2019\u201C\u201D\u2013\u2014\u2212\u00A0]/g;
/**
 * patch 模糊匹配的字符归一：弯引号/各类破折号/nbsp → ASCII 等价（单 UTF-16 unit 保长度）。
 * @param s 原字符串
 * @returns 归一后的字符串（长度不变）
 */
export function normalizeFuzzy(s: string): string {
  return s.replace(FUZZY_CHARS, (c) => FUZZY_MAP[c] ?? c);
}
function allHits(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}
// 逐行剥离尾空白（[ \t]+$）：返回剥离文本 + 位置映射表（stripped 索引→原文索引；
// \n 映射到其原文位置，故替换区间天然吞掉行尾空白）。末位哨兵=原文长度。
function stripTrailingWs(s: string): [string, number[]] {
  const lines = s.split("\n");
  const kept: string[] = [];
  const map: number[] = [];
  let pos = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const t = line.replace(/[ \t]+$/, "");
    for (let k = 0; k < t.length; k++) map.push(pos + k);
    if (li < lines.length - 1) map.push(pos + line.length); // \n 原位
    kept.push(t);
    pos += line.length + 1;
  }
  map.push(s.length);
  return [kept.join("\n"), map];
}
/** fuzzyFind 结果：命中（附替换区间与命中通道）/多义/未找到三级。 */
export type FuzzyMatch =
  | { status: "ok"; start: number; end: number; via: "exact" | "typo" | "ws" }
  | { status: "ambiguous" }
  | { status: "notfound" };
/**
 * patch 旧文本定位三级回退（对齐宿主 edit 语义）：exact indexOf → 字符归一 → 行尾空白剥离，
 * 后两级经位置映射回映原文索引；每级多义即报 ambiguous（宁可报错不误替换）。纯函数。
 * @param cur 当前文件全文
 * @param old 待定位的旧文本
 * @returns 命中区间（原文索引）或 ambiguous/notfound
 */
export function fuzzyFind(cur: string, old: string): FuzzyMatch {
  let hits = allHits(cur, old);
  if (hits.length === 1) return { status: "ok", start: hits[0], end: hits[0] + old.length, via: "exact" };
  if (hits.length > 1) return { status: "ambiguous" };
  // 阶段②：仅当归一实际改变操作数时有意义（未变=与阶段①同结果，天然 0 命中）
  const nCur = normalizeFuzzy(cur);
  const nOld = normalizeFuzzy(old);
  if (nCur !== cur || nOld !== old) {
    hits = allHits(nCur, nOld);
    if (hits.length === 1) return { status: "ok", start: hits[0], end: hits[0] + nOld.length, via: "typo" };
    if (hits.length > 1) return { status: "ambiguous" };
  }
  // 阶段③：双向剥行尾空白后匹配，idxMap 回映原文索引
  const [sCur, map] = stripTrailingWs(cur);
  const [sOld] = stripTrailingWs(old);
  if (!sOld) return { status: "notfound" }; // old 剥后为空（纯空白）不可匹配
  hits = allHits(sCur, sOld);
  if (hits.length === 1) return { status: "ok", start: map[hits[0]], end: map[hits[0] + sOld.length], via: "ws" };
  if (hits.length > 1) return { status: "ambiguous" };
  return { status: "notfound" };
}

// ── M16-r29：阶段纪律——产物期望阶段映射 + 错位告警（纯函数可测）────────────
// 真机实证（auth-login r28）：leader 把 reviewer/tester 提前塞进 planning，产物重复写
// 浪费 ~15-20m。此处只做「告警不阻断」：让错位在 tool output 可见，引导 leader 归位。
/** 产物 kind → 期望产出阶段映射（错位告警依据，告警不阻断）。 */
export const ARTIFACT_PHASE: Record<string, string> = {
  plan: "planning",
  "plan-review": "review",
  "test-plan": "review",
  "build-review": "build_review",
  "test-report": "testing",
  lessons: "done",
};
/**
 * 产物错位告警：kind 有期望阶段且当前阶段不符时返回 ⚠️ 文案，否则 null（纯函数）。
 * @param kind 产物类型
 * @param phase 当前阶段名
 * @returns ⚠️ 错位告警文案或 null
 */
export function artifactPhaseWarning(kind: string, phase: string | null | undefined): string | null {
  const expected = ARTIFACT_PHASE[kind];
  if (!expected || !phase || phase === expected) return null;
  return `⚠️ 产物阶段错位：${kind} 应在「${expected}」阶段产出，当前「${phase}」——疑似提前委派（会重复写、浪费工时）。请归位：各 wf 角色只在对应阶段委派（planner→planning、reviewer/tester→review）。`;
}

// ── M16-r32：产物瘦身预算——体积/结构约束（纯函数可测）────────────
// 真机实证（auth-login r28）：plan.md 40KB 生成 ~6.6min，耗时与体积成正比；工具本身毫秒级。
// 软预算 + 超预算告警（不阻断）：压生成耗时，同时减下游 reviewer 阅读量（双重收益）。
// M16-r50：plan 预算按体量分级 S10/M20/L30KB（大任务方案要素多，15KB 常被迫精简重写反而费工）；
// 其余产物类型维持原预算。单位=KB（字节计，中文×~1.5）。
/** M 级产物瘦身预算表（KB，字节计）：软预算，超预算只告警不阻断。 */
export const ARTIFACT_BUDGET_KB: Record<string, number> = {
  plan: 20,
  "plan-review": 8,
  "test-plan": 10,
  "build-review": 8,
  "test-report": 10,
  lessons: 6,
};
// M16-r33 P2：S 级（简易/演示任务）收紧预算——真机取证 todolist 简易任务 plan 26KB/test-plan 22KB
// 杀鸡用牛刀。
// M16-r49：S 级 plan 5→10KB——5KB 对正常方案过紧，频繁超预算触发精简重写反而费工；10KB 仍严于 M。
/** S 级（简易任务）收紧预算表（KB）。 */
export const ARTIFACT_BUDGET_S_KB: Record<string, number> = {
  plan: 10,
  "plan-review": 3,
  "test-plan": 3,
  "build-review": 3,
  "test-report": 4,
  lessons: 3,
};
// M16-r50：L 级（大型任务）预算表——只放宽 plan（30KB），其余产物沿用 M 值；
// 表形状保持六类齐全（与 KIND_FILES 键一致，测试锁定）。
/** L 级（大型任务）预算表：只放宽 plan 至 30KB，其余沿用 M 值（键集与 KIND_FILES 一致，测试锁定）。 */
export const ARTIFACT_BUDGET_L_KB: Record<string, number> = {
  plan: 30,
  "plan-review": 8,
  "test-plan": 10,
  "build-review": 8,
  "test-report": 10,
  lessons: 6,
};
// 体量归一 tierOf：R2 T2.1 平移至 domain/types.ts（flow 域 GATES_DAILY 消费合法化；
// budgetFor/artifactSizeWarning 内部引用 + lib barrel 导出名不变）。
/**
 * 按体量取 kind 的预算（KB）：查对应分级表，未登记的 kind 返回 null。
 * @param kind 产物类型
 * @param size 体量标记（S/M/L，可空）
 * @returns 预算 KB 数或 null
 */
export function budgetFor(kind: string, size?: string | null): number | null {
  const tier = tierOf(size);
  const table = tier === "S" ? ARTIFACT_BUDGET_S_KB : tier === "L" ? ARTIFACT_BUDGET_L_KB : ARTIFACT_BUDGET_KB;
  return table[kind] ?? null;
}
/**
 * 产物超预算告警：超过分级预算时返回 ⚠️ 精简指引文案，否则 null。
 * @param kind 产物类型
 * @param bytes 产物字节数
 * @param size 体量标记（可空）
 * @returns ⚠️ 超预算告警文案或 null
 */
export function artifactSizeWarning(kind: string, bytes: number, size?: string | null): string | null {
  const budget = budgetFor(kind, size);
  if (!budget || bytes <= budget * 1024) return null;
  const tier = tierOf(size);
  return `⚠️ 产物超瘦身预算：${kind} ${(bytes / 1024).toFixed(1)}KB > ${budget}KB（${tier} 级，字节计）——请精简（表格化/只留要点/删冗长散文）；修订用 wf_write_artifact 的 patch 模式删减冗余章节，勿全量重写。`;
}
// r55 修复1（test_010 实证）：lane 分组表判定纯函数——planner 写节标题自用「Lane 分组表」大写 L，
// 旧区分大小写子串匹配（/lane 分组表/）误拒 → build 拒绝连锁（清 review+确认重走全流程 ~9min）。
// 大小写归一 + 容忍表内空格变体；字符归一非语义放宽（仍要求该节标题存在）。
/** 判定 plan.md 是否含 lane 分组表节（kind=plan 注册记账，daily M/L wf:build 关卡消费）。
 * @param content plan 全文
 * @returns 含 lane 分组表节=true（大小写不敏感、容空白） */
export function laneTableWritten(content: unknown): boolean {
  return /lane\s*分组表/i.test(String(content ?? ""));
}
