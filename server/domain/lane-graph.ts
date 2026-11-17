// lane-graph — plan.md「lane 依赖边表」机器区解析与校验（效率批 P1，test_51 F1/F6 复盘批）。
// 结构正确性机械化：文件写集互斥 ≠ 符号级依赖互斥（F1：T03(wave-1,lane-B) 消费 matchesDay@T02(wave-1,lane-A)）；
// 派生调度与声明波次漂移（F6：「T02 合并」vs「T02+T03 已合并」两处措辞不一致）。
// 纯函数零 IO，bun test 直测；解析永不 throw（评审 M7：畸形输入=violations，带行号与修正示例）。
// 规则（violations=硬拒；R6 只拦危险方向）：
//   R0  M/L 级缺 ```lane-deps 机器区（S 豁免——与 lane 分组表交付口径一致）
//   R1  边端点须在 nodes 声明；wave 为 ≥0 整数；kind∈{value,type}；symbol 非空
//   R2  consumer→provider 有向图无环（环=任何波次调度都不可行）
//   R3  跨 lane 边须 provider.wave < consumer.wave（kind=value|type 同规——worktree 类型 import 同样编译失败）
//   R6  声明 wave < 拓扑层深 = 违规（危险方向：声明早于依赖允许）；声明更深=安全（仅浪费并行，不拒）
// lane 均衡**不机械化**（预估实证通胀 55%，test_51「省14min」教训）——留 planner 契约文字与 plan-grill 问项。

/** nodes 表一行：T 点 + 声明波次 + lane。 */
export interface LaneDepsNode { t: string; wave: number; lane: string; }
/** edges 表一行：消费方 → 提供方 的符号级依赖。 */
export interface LaneDepsEdge { consumer: string; provider: string; symbol: string; kind: string; line: number; }
/** parseLaneDeps 结果：present=机器区存在；parseErrors=畸形（不 throw 的兜底面）。 */
export interface LaneDepsParse { present: boolean; nodes: LaneDepsNode[]; edges: LaneDepsEdge[]; parseErrors: string[]; }
/** checkLaneDeps 结果：ok=全过；violations=违规清单（❌ 回显面）；order=声明波次派生合并序（信息面）。 */
export interface LaneDepsCheck { ok: boolean; violations: string[]; order: string; }

/** 表头行单元格白名单（宽松跳过表头，不参与数据/校验）。 */
const HEADER_CELLS = new Set(["T", "wave", "lane", "消费方", "提供方", "符号", "kind"]);

/**
 * 提取 plan.md 中第一个 ```lane-deps 围栏块并宽松解析为 nodes/edges 两表。
 * 宽容：块内空行/`#` 注释行跳过、表格分隔行（|---|）跳过、列两侧空白归一。
 * 严格：nodes 行须 ≥3 列（| T | wave | lane |）、edges 行须 ≥4 列（| 消费方 | 提供方 | 符号 | kind |），
 * 不足=parseErrors（不 throw）。多块/未闭合同样入 parseErrors。
 * @param content plan.md 全文（或任意待检文本；非字符串=无机器区）
 * @returns 解析结果（永不 throw）
 */
export function parseLaneDeps(content: unknown): LaneDepsParse {
  const out: LaneDepsParse = { present: false, nodes: [], edges: [], parseErrors: [] };
  const text = typeof content === "string" ? content : "";
  const starts = text.split("```lane-deps").length - 1;
  if (starts === 0) return out;
  out.present = true;
  if (starts > 1) out.parseErrors.push(`机器区出现 ${starts} 个 \`\`\`lane-deps 块——只允许保留一个`);
  const m = text.match(/```lane-deps[^\n]*\n([\s\S]*?)```/); // 语言尾注容忍（```lane-deps ts 等）
  if (!m) { out.parseErrors.push("lane-deps 块未闭合（缺结尾 ``` 围栏）——补闭合后重试"); return out; }
  let section: "nodes" | "edges" | null = null;
  m[1].split("\n").forEach((raw, i) => {
    const ln = i + 1; // 块内行号（回显定位用）
    const line = raw.trim();
    if (!line) return;
    if (/^nodes:\s*$/.test(line)) { section = "nodes"; return; }
    if (/^edges:\s*$/.test(line)) { section = "edges"; return; }
    if (!line.startsWith("|")) return; // 注释/说明行静默跳过
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))) return; // 表头分隔行
    if (HEADER_CELLS.has(cells[0]) || HEADER_CELLS.has(cells[1])) return; // 表头行（| T | wave | lane | / | 消费方 | 提供方 | ...）——宽松跳过，不参与数据
    if (section === "nodes") {
      if (cells.length < 3) { out.parseErrors.push(`nodes 块内第${ln}行：列数 ${cells.length}<3（应为 | T | wave | lane |）`); return; }
      const wave = Number(cells[1]);
      if (!Number.isInteger(wave) || wave < 0) { out.parseErrors.push(`nodes 块内第${ln}行：wave 须为 ≥0 整数（得 "${cells[1]}"）`); return; }
      out.nodes.push({ t: cells[0], wave, lane: cells[2] });
    } else if (section === "edges") {
      if (cells.length < 4) { out.parseErrors.push(`edges 块内第${ln}行：列数 ${cells.length}<4（应为 | 消费方 | 提供方 | 符号 | kind |）`); return; }
      out.edges.push({ consumer: cells[0], provider: cells[1], symbol: cells[2], kind: cells[3].toLowerCase(), line: ln });
    }
    // section 为 null（标记行之前的表格）→ 静默跳过：畸形已由「nodes 为空」违规兜住
  });
  return out;
}

/**
 * 全量校验：R0 缺区（M/L）/R1 端点与字段/R2 无环/R3 跨 lane 波次/R6 声明 vs 层深。
 * @param content plan.md 全文
 * @param tier tierOf(st.size) 归一体量（"S" 豁免 R0；缺省按 M——与 tierOf 语义一致）
 * @returns ok=可过关；violations=逐条违规（含块内行号与修正示例）；order=声明波次合并序
 */
export function checkLaneDeps(content: unknown, tier: string | null | undefined): LaneDepsCheck {
  try {
    const p = parseLaneDeps(content);
    const violations: string[] = [];
    if (tier !== "S" && !p.present) {
      violations.push(
        "缺 ```lane-deps 机器区（M/L 级必交付）。在 plan.md 末尾追加（edges 空表=单 lane 串行，合法）：\n" +
        "```lane-deps\nnodes:\n| T | wave | lane |\n|---|---|---|\n| T01 | 0 | lane-0 |\nedges:\n| 消费方 | 提供方 | 符号 | kind |\n|---|---|---|\n```",
      );
    }
    violations.push(...p.parseErrors);
    if (p.present) {
      if (!p.nodes.length) violations.push("nodes 表为空——每个 T<nn> 须一行（| T | wave | lane |）");
      const byT = new Map(p.nodes.map((n) => [n.t, n]));
      for (const e of p.edges) {
        if (!byT.has(e.consumer)) violations.push(`edges 块内第${e.line}行：消费方 ${e.consumer} 未在 nodes 声明`);
        if (!byT.has(e.provider)) violations.push(`edges 块内第${e.line}行：提供方 ${e.provider} 未在 nodes 声明`);
        if (!e.symbol) violations.push(`edges 块内第${e.line}行：符号列为空（写被消费的符号名，漏边=评审核对盲区）`);
        if (e.kind !== "value" && e.kind !== "type") violations.push(`edges 块内第${e.line}行：kind 须为 value|type（得 "${e.kind}"）`);
      }
      // R2 环检测（三色 DFS，consumer→provider 有向；back-edge 报完整环路径）
      const color = new Map(p.nodes.map((n) => [n.t, 0])); // 0=白 1=灰 2=黑
      const adj = new Map(p.nodes.map((n) => [n.t, [] as string[]]));
      for (const e of p.edges) adj.get(e.consumer)?.push(e.provider);
      const onpath: string[] = [];
      const visit = (u: string): void => {
        color.set(u, 1); onpath.push(u);
        for (const w of adj.get(u) ?? []) {
          if (color.get(w) === 1) {
            const cyc = onpath.slice(onpath.indexOf(w)).concat(w).join("→");
            violations.push(`依赖环：${cyc}（环=任何波次调度都不可行，请打破）`);
          } else if (color.get(w) === 0) visit(w);
        }
        onpath.pop(); color.set(u, 2);
      };
      for (const n of p.nodes) if (color.get(n.t) === 0) visit(n.t);
      // R6 层深（provider→consumer 方向最长路；环由 R2 上报，此处按已访问收敛防递归）
      const depth = new Map<string, number>();
      const settled = new Set<string>();
      const depthOf = (t: string): number => {
        if (settled.has(t)) return depth.get(t) ?? 0;
        settled.add(t);
        const provs = p.edges.filter((e) => e.consumer === t && byT.has(e.provider)).map((e) => e.provider);
        const v = provs.length ? Math.max(...provs.map(depthOf)) + 1 : 0;
        depth.set(t, v);
        return v;
      };
      for (const n of p.nodes) depthOf(n.t);
      for (const e of p.edges) {
        const c = byT.get(e.consumer); const pv = byT.get(e.provider);
        if (!c || !pv) continue;
        if (c.lane !== pv.lane && pv.wave >= c.wave) {
          violations.push(`edges 块内第${e.line}行：跨 lane 边 ${e.consumer}(wave${c.wave}) ← ${e.provider}(wave${pv.wave}) 同/更早波次——${e.kind} 边在 worktree 同样编译失败，须把 ${e.provider} 下沉至更早 wave`);
        }
        const dv = depth.get(e.consumer) ?? 0;
        if (c.wave < dv) violations.push(`edges 块内第${e.line}行：${e.consumer} 声明 wave${c.wave} 早于其依赖层深 wave${dv}（声明波次须 ≥ 拓扑层深）`);
      }
    }
    return { ok: violations.length === 0, violations, order: orderString(p) };
  } catch (e) {
    return { ok: false, violations: [`lane-deps 解析异常（请检查机器区格式）：${(e as Error)?.message ?? e}`], order: "" };
  }
}

/**
 * 声明波次派生合并序（信息面，附 artifact-tool 成功 note）：wave 升序分组，同 wave 多 lane 用 ∥ 连接。
 * @param p parseLaneDeps 结果
 * @returns 形如 `wave0{T01} → wave1{T02∥T03} → wave2{T04}`；无 nodes 时空串
 */
function orderString(p: LaneDepsParse): string {
  if (!p.nodes.length) return "";
  const waves = [...new Set(p.nodes.map((n) => n.wave))].sort((a, b) => a - b);
  return waves.map((w) => {
    const ts = p.nodes.filter((n) => n.wave === w).map((n) => n.t);
    const lanes = new Set(p.nodes.filter((n) => n.wave === w).map((n) => n.lane));
    return `wave${w}{${ts.join(lanes.size > 1 ? "∥" : "→")}}`;
  }).join(" → ");
}
