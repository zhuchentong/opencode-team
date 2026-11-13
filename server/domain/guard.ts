// wf-workflow — domain/guard：闸门工具集/路径提取/放行判定/shell 写目标解析（自 lib.ts 逐字节平移）。
// B1-1 翻案（=>/比较符/tee<）与 fail-closed 取舍注释保留原位；BLOCKING 单一来源见 shared/phases.ts。
import { BLOCKING } from "../../shared/phases.ts"; // M10-d A1：阶段闸门单一来源（原 lib.ts 顶层 import 随迁）

export const EDIT_TOOLS: Set<string> = new Set(["edit", "write", "patch"]);
export const BLOCKING_PHASES: Set<string> = new Set<string>(BLOCKING); // M10-d A1：见 shared/phases.ts
export const DEFAULT_ALLOW_MARKERS = ["/.workflow/", "/.learnings/", "/tests/", "/test/", "/__tests__/"];
export const DEFAULT_ALLOW_RES = [/\.(test|spec)\.[cm]?[jt]sx?$/i, /(^|\/)test_[^/]*\.(py|go)$/i];

// ── M4：越权路径提取 ────────────────────────────────────────────────
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
