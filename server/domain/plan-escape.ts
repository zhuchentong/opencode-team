// plan-escape — M/L 级 plan「扩展逃生门条款」写时预检（W14，test_57 复盘批）。
// 措辞路线已被对照实验证伪：roles/planner.md L9 明载 test_54 同族教训原文（探针版 ambient 缺声明、
// T01 写集锁死致 T06 无合法修复路径，r1 FAIL 返修 8.2min），test_57 planner 读着它仍未写逃生门条款
// （F1 同族二现，幸有 patch+增量复审协议压到 149s）——同一缺陷、同一提示词层、二现 = 结构强制。
// 探测器取证（评审 v1 F-1）：裸 /写集/ 标记在真实 M 级语料假阳率 2/3（test_53/test_56 合法 plan
// 各含「写集」9/7 处、条款 0——planner lane 分组表契约天然要求写集列），故信号源与 checkLaneDeps
// R-P1 / checkProbeMatrix R-P1 同款：**tierOf!=="S" 统一门**（状态派生零自报、零词表依赖；代价=
// 无冻结语义的 M plan 也补一句许可性样板条款，语义无害）。
// 残差如实声明（HOST-CONTRACT W14 节）：①关键词在场≠语义在场——机器管结构在场、评审 Q7 管实质；
// ②硬拒窗覆盖 planning/review=plan 全部产生/修订窗口，building 期 patch 删条款无下游兜底（接受）。
// 纯函数零 IO，bun test 直测；check 永不 throw（probe-matrix/lane-graph 同款不变量）。

/** checkPlanEscape 结果：ok=可过关；violations=违规清单（❌ 回显面）。 */
export interface PlanEscapeCheck { ok: boolean; violations: string[] }

/** 条款标记词表（任一命中=结构在场；语义由评审 Q7 抽查兜底）。 */
const ESCAPE_MARKERS = ["追加式扩展", "逃生门", "合法修复路径", "扩展条款"];

/** 缺条款时的修复例句（与 test_57 r2 实际落盘条款同型）。 */
const FIX_EXAMPLE =
  "§3 总则追加一句（M/L 级 plan 必带，写时预检机检）：\n" +
  "「下游 T 点可对共享声明文件（如 types/ambient.d.ts）做追加式扩展（只增不改不删），并在回执记录扩展行。」";

/**
 * 校验 plan 文本是否带扩展逃生门条款。
 * @param content plan.md 最终全文（三模式同源 finalContent；非字符串按 miss 处理，never throw）
 * @param tier tierOf(st.size) 归一体量（"S" 豁免；缺省按 M——与 checkLaneDeps/checkProbeMatrix 语义一致）
 */
export function checkPlanEscape(content: unknown, tier: string | null | undefined): PlanEscapeCheck {
  try {
    if (tier === "S") return { ok: true, violations: [] };
    const text = typeof content === "string" ? content : "";
    if (ESCAPE_MARKERS.some((m) => text.includes(m))) return { ok: true, violations: [] };
    return {
      ok: false,
      violations: [`M/L 级 plan 缺「扩展逃生门」条款（冻结写集类计划必须给出缺声明的合法修复路径，` +
        `否则下游 T 点需扩声明即死锁——test_54/57 同族两现实证）。${FIX_EXAMPLE}`],
    };
  } catch {
    // never-throw 兜底：内部异常一律视为 miss（宁可多拦一次教育，不可漏放到评审）
    return { ok: false, violations: ["plan-escape 内部异常（已兜底为未过），请重试注册"] };
  }
}
