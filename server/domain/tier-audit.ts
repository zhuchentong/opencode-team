// tier-audit — 体量自报漂移事后观察闸（W15-a，评审收敛形态：事后 override 观察+记账，
// 不事前拒绝、不自动改写 st.size——事前硬拒撞 r49/W7 重写循环否决在案；硬化（强制改档）
// 留待 override 事件积累 ≥3 个真实误标样本再裁，与「第 3 例立项」纪律同口径）。
// 背景：flow.ts intake [S]/[M]/[L] 前缀由模型自报（缺省 M），tierOf(st.size) 是三机器区预检+
// plan-review 关卡四要素的共同信号源——误标 S=执法面整链静默旁路（test_58 实证：leader 主动降标）。
// 零自报结构信号取 plan 落盘时刻两个机器可判特征：lane-deps nodes T 计数（parseLaneDeps 现成、
// never-throw）与 plan 字节数（S 档预算上限自身，无新魔数——T2.1 纪律）。仅当双信号同向超标才
// 判漂移（单信号假阳率高：合法 S 任务可以有大 plan/多 T 点，评审边界角度）。
// 阈值标定（暂定，随 override 事件校准）：nodes≥5=超过全部历史 S 轮功能点数（test_41/42/55/58
// 实测 1~4）；bytes≥ARTIFACT_BUDGET_S_KB.plan（10KB=S 档瘦身预算上限自身，超线即「呈 M 形态」）。
// 消费点：artifact-tool plan 注册路径（dep→pm→esc 三预检之后的第四块观察回显，⚠️+logAdd 记账）。
import { parseLaneDeps } from "./lane-graph.ts";
import { ARTIFACT_BUDGET_S_KB } from "./artifact.ts";
import { tierOf } from "./types.ts";

/** 体量漂移观察判定（W15-a）：S 级 plan 双结构信号同向超标 → drift。
 * @param content plan 全文（非字符串/畸形=无信号，不判漂移）
 * @param size 任务自报体量（原始值；非 S 恒不判——M/L 无豁免面可旁路）
 * @returns {drift, reasons} reasons 为机器可判超标项清单（空=无漂移）；解析 never-throw */
export function auditTierDrift(content: unknown, size?: string | null): { drift: boolean; reasons: string[] } {
  try {
    if (tierOf(size) !== "S") return { drift: false, reasons: [] }; // 仅 S 自报有豁免面可旁路
    const text = typeof content === "string" ? content : "";
    if (!text) return { drift: false, reasons: [] };
    const reasons: string[] = [];
    const nodes = parseLaneDeps(text).nodes.length;
    if (nodes >= TIER_DRIFT_MIN_T) reasons.push(`lane-deps nodes=${nodes}≥${TIER_DRIFT_MIN_T}（历史 S 轮实测 1~4）`);
    if (text.length >= ARTIFACT_BUDGET_S_KB.plan * 1024) reasons.push(`plan ${(text.length / 1024).toFixed(1)}KB≥S 预算 ${ARTIFACT_BUDGET_S_KB.plan}KB`);
    return { drift: reasons.length === 2, reasons }; // 双信号同向才判（单信号假阳率高，评审裁定）
  } catch {
    return { drift: false, reasons: [] }; // never-throw：观察闸绝不阻断注册主路径
  }
}
/** 双信号 T 点阈值（域常量单点，测试锁定）。 */
export const TIER_DRIFT_MIN_T = 5;
