// probe-matrix — plan.md「probe-matrix 机器区」解析与校验（W11-v2.1，test_54/56 探针盲区家族复盘批）。
// 措辞路线（planner 探针条款两轮加固）只能堵已见的维度——盲区按维度轮转：test_54 符号维（探针 ambient
// 缺 Bun.spawnSync）、test_56 结构维（probe.ts 单文件双绿不支撑跨文件 .ts import 契约，TS5097）。
// 本区把「探针样本与冻结写集消费形态同构」从 planner 自觉升级为落盘声明+机器枚举：每 T 一行声明探针
// 拓扑，R-P3 集合级规则由 lane-deps type 边派生强制多文件探针——多文件探针按冻结 tsconfig 实跑，任意
// 配置/导入形态不兼容在 planning 期自曝（不再等评审）。
// 纯函数零 IO，bun test 直测；解析永不 throw（lane-graph M7 同款不变量：畸形输入=parseErrors/violations）。
// 规则（violations=硬拒面）：
//   R-P1  M/L 级缺 ```probe-matrix 机器区（S 豁免——信号源与 checkLaneDeps 同款 tierOf，评审 F-R1：
//         lane-deps 存在性≠级别信号，循环耦合且误伤带边表的 S 级）
//   R-P2  矩阵行 T 集合与 lane-deps nodes T 集合双射（多行/缺行均 violations，消息附双方清单——评审
//         F-R2：wave≥2 的 T 全是消费方，只矩阵化总闸点关不死本族；R-P4 方向断言被双射蕴含，不再单列）
//   R-P3  行级 cross_file_import=yes ⇒ probe_files≥2 ∧ tsconfig_notes 非空；集合级 lane-deps 存在任一
//         type 边 ⇒ 矩阵至少一行 cross_file_import=yes ∧ probe_files≥2（parseLaneDeps 派生，零自报）
// probe_files 自报真实性=接受残差（lane-deps 同款信任模型：自报+内部一致性机检+评审复跑；升级路径见
// HOST-CONTRACT W11 节）。tsconfig_notes 与冻结 tsconfig 的一致性=机器不可达上限，由探针实跑+评审复跑覆盖。

import { parseLaneDeps } from "./lane-graph.ts";

/** 矩阵一行：T 点 + 探针文件数 + 是否含跨文件 import + tsconfig 关键开关注记。 */
export interface ProbeMatrixRow { t: string; probeFiles: number; crossFileImport: boolean; tsconfigNotes: string; line: number; }
/** parseProbeMatrix 结果：present=机器区存在；parseErrors=畸形（不 throw 的兜底面）。 */
export interface ProbeMatrixParse { present: boolean; rows: ProbeMatrixRow[]; parseErrors: string[]; }
/** checkProbeMatrix 结果：ok=全过；violations=违规清单（❌ 回显面）。 */
export interface ProbeMatrixCheck { ok: boolean; violations: string[]; }

/** 表头行单元格白名单（宽松跳过表头；中英别名同候）。 */
const HEADER_CELLS = new Set(["T", "probe_files", "cross_file_import", "tsconfig_notes", "探针文件数", "跨文件import", "跨文件导入", "tsconfig开关"]);

/**
 * 提取 plan.md 中第一个 ```probe-matrix 围栏块并宽松解析为行表。
 * 宽容：空行/`#` 注释行跳过、表格分隔行跳过、列两侧空白归一；严格：每行须 ≥4 列、
 * probe_files 为 ≥0 整数、cross_file_import ∈ {yes,no}（小写归一），不足=parseErrors（不 throw）。
 * @param content plan.md 全文（或任意待检文本；非字符串=无机器区）
 */
export function parseProbeMatrix(content: unknown): ProbeMatrixParse {
  const out: ProbeMatrixParse = { present: false, rows: [], parseErrors: [] };
  const text = typeof content === "string" ? content : "";
  const starts = text.split("```probe-matrix").length - 1;
  if (starts === 0) return out;
  out.present = true;
  if (starts > 1) out.parseErrors.push(`机器区出现 ${starts} 个 \`\`\`probe-matrix 块——只允许保留一个`);
  const m = text.match(/```probe-matrix[^\n]*\n([\s\S]*?)```/); // 语言尾注容忍（```probe-matrix ts 等）
  if (!m) { out.parseErrors.push("probe-matrix 块未闭合（缺结尾 ``` 围栏）——补闭合后重试"); return out; }
  m[1].split("\n").forEach((raw, i) => {
    const ln = i + 1; // 块内行号（回显定位用）
    const line = raw.trim();
    if (!line || !line.startsWith("|")) return; // 注释/说明行静默跳过
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))) return; // 表头分隔行
    if (HEADER_CELLS.has(cells[0]) || HEADER_CELLS.has(cells[1])) return; // 表头行宽松跳过
    if (cells.length < 4) { out.parseErrors.push(`块内第${ln}行：列数 ${cells.length}<4（应为 | T | probe_files | cross_file_import | tsconfig_notes |）`); return; }
    const files = Number(cells[1]);
    if (!Number.isInteger(files) || files < 0) { out.parseErrors.push(`块内第${ln}行：probe_files 须为 ≥0 整数（得 "${cells[1]}"）`); return; }
    const xfile = cells[2].toLowerCase();
    if (xfile !== "yes" && xfile !== "no") { out.parseErrors.push(`块内第${ln}行：cross_file_import 须为 yes|no（得 "${cells[2]}"）`); return; }
    out.rows.push({ t: cells[0], probeFiles: files, crossFileImport: xfile === "yes", tsconfigNotes: cells[3], line: ln });
  });
  return out;
}

/**
 * 全量校验：R-P1 缺区（M/L）/R-P2 与 lane-deps nodes 双射/R-P3 跨文件 import 行级+集合级规则。
 * @param content plan.md 全文
 * @param tier tierOf(st.size) 归一体量（"S" 豁免 R-P1/双射/集合级——与 lane-graph 豁免口径一致）
 * @returns ok=可过关；violations=逐条违规（含块内行号与修正示例）
 */
export function checkProbeMatrix(content: unknown, tier: string | null | undefined): ProbeMatrixCheck {
  try {
    const p = parseProbeMatrix(content);
    const d = parseLaneDeps(content);
    const violations: string[] = [];
    if (tier !== "S" && !p.present) {
      violations.push(
        "缺 ```probe-matrix 机器区（M/L 级必交付，与 lane-deps 双伴）。在 plan.md 末尾追加（每 T 一行，声明探针拓扑与冻结 tsconfig 的真实消费形态同构）：\n" +
        "```probe-matrix\n| T | probe_files | cross_file_import | tsconfig_notes |\n|---|---|---|---|\n| T01 | 2 | yes | allowImportingTsExtensions |\n```",
      );
    }
    violations.push(...p.parseErrors);
    if (p.present) {
      const seen = new Set<string>();
      for (const r of p.rows) {
        if (seen.has(r.t)) violations.push(`块内第${r.line}行：T 点 ${r.t} 重复声明（每 T 恰一行）`);
        seen.add(r.t);
        // R-P3 行级：跨文件 import ⇒ 探针必须多文件（按冻结 tsconfig 实跑才能自曝 TS5097 类配置缺陷）∧ 开关注记非空
        if (r.crossFileImport && r.probeFiles < 2) violations.push(`块内第${r.line}行：${r.t} cross_file_import=yes 但 probe_files=${r.probeFiles}<2——跨文件消费形态须多文件探针实跑`);
        if (r.crossFileImport && !r.tsconfigNotes) violations.push(`块内第${r.line}行：${r.t} cross_file_import=yes 但 tsconfig_notes 为空（写冻结 tsconfig 的关键开关，如 allowImportingTsExtensions）`);
      }
      // R-P2 双射 + R-P3 集合级：仅 M/L（S 级 lane-deps 可缺省，跨表规则整体豁免——与 R-P1 同口径）
      if (tier !== "S" && d.present) {
        const laneT = [...new Set(d.nodes.map((n) => n.t))];
        const matrixT = [...new Set(p.rows.map((r) => r.t))];
        const missing = laneT.filter((t) => !matrixT.includes(t));
        const extra = matrixT.filter((t) => !laneT.includes(t));
        if (missing.length) violations.push(`矩阵缺行：${missing.join("、")} 在 lane-deps nodes 声明但无 probe-matrix 行（双射要求每 T 恰一行）`);
        if (extra.length) violations.push(`矩阵多行：${extra.join("、")} 不在 lane-deps nodes 中（双射要求每 T 恰一行；lane-deps 侧=${laneT.join("、")}）`);
        const hasTypeEdge = d.edges.some((e) => e.kind === "type");
        if (hasTypeEdge && !p.rows.some((r) => r.crossFileImport && r.probeFiles >= 2)) {
          violations.push("lane-deps 存在 type 边（跨文件类型消费）——矩阵须至少一行 cross_file_import=yes ∧ probe_files≥2（多文件探针按冻结 tsconfig 实跑，配置不兼容在规划期自曝）");
        }
      }
    }
    return { ok: violations.length === 0, violations };
  } catch (e) {
    return { ok: false, violations: [`probe-matrix 解析异常（请检查机器区格式）：${(e as Error)?.message ?? e}`] };
  }
}
