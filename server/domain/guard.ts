// wf-workflow — domain/guard：闸门工具集/路径提取/放行判定/shell 写目标解析（自 lib.ts 逐字节平移）。
// B1-1 翻案（=>/比较符/tee<）与 fail-closed 取舍注释保留原位；BLOCKING 单一来源见 shared/phases.ts。
import { BLOCKING } from "../../shared/phases.ts"; // M10-d A1：阶段闸门单一来源（原 lib.ts 顶层 import 随迁）

/** 视为写文件的宿主工具名集合（越权判定对象）。 */
export const EDIT_TOOLS: Set<string> = new Set(["edit", "write", "patch"]);
/** 受闸阶段集合（这些阶段业务写被拒；单一来源 shared/phases BLOCKING）。 */
export const BLOCKING_PHASES: Set<string> = new Set<string>(BLOCKING); // M10-d A1：见 shared/phases.ts
/** 默认放行路径标记（工作流产物/测试目录等，任何 agent 可写）。 */
export const DEFAULT_ALLOW_MARKERS = ["/.workflow/", "/.learnings/", "/tests/", "/test/", "/__tests__/"];
/** 默认放行测试文件名正则（与 marker 并列的第二放行通道）。 */
export const DEFAULT_ALLOW_RES = [/\.(test|spec)\.[cm]?[jt]sx?$/i, /(^|\/)test_[^/]*\.(py|go)$/i];

// ── M4：越权路径提取 ────────────────────────────────────────────────
/**
 * 越权路径提取：从工具调用参数里解析出写目标路径（patch 工具扫 "*** Add/Update/Delete File:" 行，
 * 其余取 path/filePath/file 字段）。
 * @param tool 宿主工具名
 * @param args 工具调用参数（ctx 边界形状，任意对象）
 * @returns 提取到的路径数组（无法解析时为空数组）
 */
export function extractPaths(tool: string, args: Record<string, unknown> | null | undefined): string[] {
  if (!args || typeof args !== "object") return [];
  if (tool === "patch") {
    const txt = String(args.patchText ?? "");
    const out: string[] = [];
    for (const m of txt.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
    return out;
  }
  const p = args.path ?? args.filePath ?? args.file;
  return typeof p === "string" && p !== "" ? [p] : [];
}

// 放行判定工厂（M10-a：闸门拒绝文案与 allowlist 同源生成，I2 防漂移）
/**
 * 放行判定工厂：由 marker 列表与正则列表生成路径谓词（闸门拒绝文案与 allowlist 同源生成，I2 防漂移）。
 * @param allowMarkers 路径包含标记（形如 "/.workflow/"，兼容相对路径无前导斜杠）
 * @param allowRes 文件名正则（测试文件等）
 * @returns (p) => boolean 谓词，true=放行
 */
export function makeAllowChecker(allowMarkers: string[], allowRes: RegExp[]): (p: unknown) => boolean {
  return (p) => {
    // 兼容绝对/相对路径：marker 形如 "/.workflow/"，相对路径没有前导斜杠，两种都比对
    const norm = String(p ?? "").replace(/\\/g, "/");
    return (
      allowMarkers.some((m) => norm.includes(m) || norm.includes(m.replace(/^\//, ""))) ||
      allowRes.some((re) => re.test(norm))
    );
  };
}

// ── M10-c：shell 写目标解析（重定向 + 写/删类命令尾参）──────────────
// M16-r28 翻案（性能审计批次 1 B1-1）：真机实证 review 阶段 4 次误伤（node -e 代码里的
//   `=>` 被解析成重定向、`tee out.txt < input` 把 input 当目标），每次误伤=一轮拦截+重试。
//   修正：①重定向符前为 <>= 时不匹配（箭头函数/比较符）；②目标含 $ 或反引号跳过
//   （变量拼接无法判定具体文件，与尾参分支既有过滤同语义）；③尾参过滤 <>&| 起始 token。
// 仍保留 fail-closed：纯数字目标（`> 2`）视为代码比较跳过；无法解析的形态宁可漏判不误伤。
const SHELL_DEST_CMDS: Set<string> = new Set(["touch", "mkdir", "rm", "mv", "cp", "tee", "rsync", "ln", "install"]);
/**
 * shell 写目标解析：重定向目标 + 写/删类命令尾参（越权判定的 shell 侧证据）。
 * 形态无法解析时宁可漏判不误伤（fail-open 方向，B1-1 翻案后语义）。
 * @param cmd shell 命令行原文
 * @returns 解析到的写目标路径数组（去重）
 */
export function shellWriteTargets(cmd: unknown): string[] {
  const found = new Set<string>();
  if (!cmd || typeof cmd !== "string") return [];
  // 重定向目标：> f / >> f / 2> f（引号或裸 token，含 * 的跳过）
  // (?<![运算符]) 排除 `=>`/`->`/`<=` 等代码比较符（真机实证 node -e 内被误拦）
  const re = /(?<![<>=+*/%&|^~-])(?:\d*>>?|<>)\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) {
    const bare = m[3];
    const t = m[1] ?? m[2] ?? bare;
    if (!t || t.includes("*") || t.includes("$") || t.includes("`") || /^\d+$/.test(t)) continue;
    // 裸 token 须像路径（含 / 或 .）——比较符后的代码词（`a > b` 的 b、`> {`）不再误伤；
    // 无扩展名裸重定向（`> build`）漏判可接受（fail-open 方向，见 docs/HOST-CONTRACT.md 已知边界）
    if (bare && !bare.includes("/") && !bare.includes(".")) continue;
    found.add(t);
  }
  // 目的参数明确的写/删类命令：取每段最后一个非旗标参数（rm/mv/cp 目的在最后）
  for (const seg of cmd.split(/(?:&&|\|\||[;|\n])/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    const head = (toks[0] ?? "").replace(/^.*\//, "");
    if (!SHELL_DEST_CMDS.has(head)) continue;
    const pos: string[] = [];
    for (const x of toks.slice(1)) {
      if (/^[<>&|]/.test(x)) break; // M16-r28：遇重定向符即停——`tee out.txt < input` 不得把 input 当目标
      if (x.startsWith("-") || /^\d+$/.test(x) || x.includes("$") || x.includes("`")) continue;
      pos.push(x);
    }
    const last = pos[pos.length - 1];
    if (last && !last.includes("*")) found.add(last.replace(/^["']|["']$/g, ""));
  }
  return [...found];
}

// ── W13（2026-11-18 合并批）：git init 引号感知侦测（用户敕令「全程不 init」机检化）────────
// 误伤防线（评审 F-R6）：①单/双引号字面量先剥离——`grep 'git init' plan.md`、`echo "git init 禁止"`
//   不得命中；②命令替换 $(…)/`…` 无论外层引号状态都执行 → 递归侦测内层；③sh/bash/zsh -c "<cmd>"
//   的内层是命令语境（构建器常用形态）→ 仅对该形态递归，其余双引号按字面剥离。
// 残差明示接受：变量间接（G=git;$G init）、行 Continuation（git\<换行>init）、别名/函数包装——
//   防的是模型漂移非人类攻击（HOST-CONTRACT W11 节口径）。保守边界：`git -C <任意目录> init` 命中
//   （init 落点不受 -C 收窄——敕令口径=任务目录未 git 化期间一律禁止）。
/**
 * 引号感知侦测命令行中的 git init 调用（含命令替换与 sh -c 包装内层）。
 * @param cmd shell 命令行原文
 * @returns 是否命中（true=应拦截）
 */
export function containsGitInit(cmd: unknown): boolean {
  if (typeof cmd !== "string" || !cmd) return false;
  // ① 命令替换：$(…)/`…` 恒为命令语境（引号内也执行）→ 递归内层（单层嵌套足够，更深视为畸形漏判可接受）
  const subst = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g;
  let sm: RegExpExecArray | null;
  while ((sm = subst.exec(cmd))) {
    if (containsGitInit(sm[1] ?? sm[2] ?? "")) return true;
  }
  // ② sh -c 包装：内层字符串是命令语境 → 递归（仅此形态递归；echo/printf 的引号串按字面剥离）
  const wrap = /(?:^|[;&|(]\s*)(?:[a-zA-Z0-9_./-]+\/)?(?:bash|zsh|sh|dash|ksh)\s+(?:-{1,2}[^\s]+\s+)*-c\s+("(?:[^"\\]|\\.)*"|'[^']*')/g;
  let wm: RegExpExecArray | null;
  while ((wm = wrap.exec(cmd))) {
    const inner = wm[1].startsWith("\"") ? wm[1].slice(1, -1).replace(/\\(["\\$`])/g, "$1") : wm[1].slice(1, -1);
    if (containsGitInit(inner)) return true;
  }
  // ③ 剥离引号字面量后分段 tokenize：命令 basename==git → **子命令位置**（首个非旗标 token，
  //    -C/-c 的值参跳过）是否为 init——位置判定防 `git commit -m init` 值参误伤（评审后首跑实证）。
  const stripped = cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const seg of stripped.split(/(?:&&|\|\||[;|\n])/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    if ((toks[0] ?? "").replace(/^.*\//, "").replace(/^["']+|["']+$/g, "") !== "git") continue;
    let skipNext = false;
    for (const t of toks.slice(1)) {
      const bare = t.replace(/^["']+|["']+$/g, "");
      if (skipNext) { skipNext = false; continue; }
      if (/^-{1,2}[^=]/.test(bare) || /^--[^=]/.test(bare)) { if (bare === "-C" || bare === "-c") skipNext = true; continue; }
      if (bare === "init") return true;
      break; // 首个非旗标 token=子命令位置；非 init 即非目标（`git commit -m init` 的 init 是 -m 值参，不到此）
    }
  }
  return false;
}
