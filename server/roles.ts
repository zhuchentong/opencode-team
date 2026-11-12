// wf-workflow — M16-r31：角色内容插件托管（B1 文件同步主路径）
// 背景：宿主 wf/* 角色文件与插件版本漂移（r28 删 assign 后 leader.md 滞留 r27，r30 才手工同步）。
// 机制：仓库 roles/ 单一来源 → setup 渲染全文 → 写宿主文件 body（保留 frontmatter/permissions）
//       → 宿主文件热载（P0 真机实证：agent 文件 create/edit/delete 免重启即时生效）。
// 安全：opt-in（options.syncRoles）+ 写前备份 + 版本标记区分托管/用户自有 + 无标记不覆盖 + hash 同跳过。
// 结构事实（阶段链）从 shared/phases.ts 动态生成——流转语义变更自动传播到角色内容，根治漂移。
// 注意：不调用 guidance()（它是状态依赖的每任务运行时指引，形状不符静态角色 system）。
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { PHASE_ORDER, FOLD } from "../shared/phases.ts";
import { VERSION } from "./lib.ts";

// 8 角色（leader + 7 subagent）；与 lib.ts WF_ROLES 同源语义（WF_ROLES 不含 leader）
export const ROLE_NAMES = [
  "leader", "planner", "planner-reviewer", "tester",
  "builder", "builder-reviewer", "fixer", "learner",
] as const;
export type RoleName = typeof ROLE_NAMES[number];

// 模板目录：仓库 roles/（server 入口经 bun 直跑 TS，import.meta.dirname 可用）
const ROLES_DIR = path.join(import.meta.dirname, "..", "roles");

// 阶段链动态渲染：PHASE_ORDER 主干 + FOLD 折叠态标注（building(+reconcile)、done(∥retrospect)）
export function phaseChain(): string {
  const foldOf: Record<string, string[]> = {};
  for (const [sub, main] of Object.entries(FOLD)) (foldOf[main] ??= []).push(sub);
  return PHASE_ORDER.map((p) => {
    const subs = foldOf[p];
    if (!subs?.length) return p;
    const sep = p === "done" ? "∥" : "+";
    return `${p}(${sep}${subs.join(",")})`;
  }).join("→");
}

// 内容 hash：对「去标记行的 body」取 sha256 前 12 位（标记含 hash，故计算时须剥离首行标记）
function bodyHash(bodyWithoutMarker: string): string {
  return createHash("sha256").update(bodyWithoutMarker).digest("hex").slice(0, 12);
}

// 模板 body（结构事实注入后）——hash 必须基于「替换占位符后」的最终内容，
// 否则标记 hash 与实际写盘 body 不一致 → 每次 setup 都判 write（hash 跳过失效、无谓热载）。
function roleBody(name: RoleName): string {
  const tpl = fs.readFileSync(path.join(ROLES_DIR, `${name}.md`), "utf8");
  return tpl.replace(/\{\{PHASE_CHAIN\}\}/g, phaseChain());
}

// 托管标记（body 首行）：version + hash。hash 覆盖标记行之后的全部内容。
export function roleMarker(name: RoleName): string {
  return `<!-- wf-workflow:managed version=${VERSION} hash=${bodyHash(roleBody(name))} -->`;
}

// 渲染角色全文 = 托管标记 + 模板 body（结构事实注入）。纯函数（读模板文件，无副作用）。
export function renderRole(name: RoleName): string {
  return `${roleMarker(name)}\n${roleBody(name)}`;
}

// 解析托管标记行 → {version, hash}；非标记 → null
export function parseMarker(line: string): { version: string; hash: string } | null {
  const m = /^<!-- wf-workflow:managed version=(\S+) hash=([0-9a-f]{12}) -->$/.exec(line.trim());
  return m ? { version: m[1], hash: m[2] } : null;
}

export type SyncAction = "skip" | "write" | "unmanaged" | "missing";

// 同步决策（纯函数）：给定宿主现有 body 与最新渲染全文 → 动作。
// 关键：hash 须对「现有 body 去掉标记行后的实际内容」重算，再与渲染内容 hash 比——
// 不能只比两个标记行的 hash（陈旧 body 往往仍带旧标记行，只比标记会漏判内容漂移）。
// 已托管且实际内容 hash 一致→skip；已托管但内容陈旧→write；无标记（用户自有）→unmanaged（不覆盖）。
export function syncDecision(existingBody: string, rendered: string): { action: SyncAction } {
  const firstLine = existingBody.split("\n")[0] ?? "";
  if (!parseMarker(firstLine)) return { action: "unmanaged" };
  const existingContent = existingBody.split("\n").slice(1).join("\n");
  const renderedContent = rendered.split("\n").slice(1).join("\n");
  if (bodyHash(existingContent) === bodyHash(renderedContent)) return { action: "skip" };
  return { action: "write" };
}

// 拆分宿主文件 frontmatter 与 body（--- ... --- 包裹的头部原样保留）
function splitFrontmatter(content: string): { fm: string; body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  if (!m) return { fm: "", body: content };
  return { fm: m[0], body: content.slice(m[0].length) };
}

export interface SyncReport { name: string; action: SyncAction; detail?: string }

// 文件同步（fs 副作用，可用临时目录测试）：对每个角色按 syncDecision 处理。
// write 时保留 frontmatter、写前备份（.bak-<ts>）、body=渲染全文。missing 不自动创建（保守）。
export function syncRoles(rolesDir: string, opts: { backup?: boolean } = {}): SyncReport[] {
  const report: SyncReport[] = [];
  for (const name of ROLE_NAMES) {
    const file = roleHostFile(rolesDir, name);
    if (!fs.existsSync(file)) { report.push({ name, action: "missing" }); continue; }
    const content = fs.readFileSync(file, "utf8");
    const { fm, body } = splitFrontmatter(content);
    const rendered = renderRole(name);
    const { action } = syncDecision(body, rendered);
    if (action === "write") {
      if (opts.backup !== false) {
        try { fs.writeFileSync(`${file}.bak-${Date.now()}`, content); } catch { /* 备份失败不阻塞 */ }
      }
      fs.writeFileSync(file, fm + rendered);
    }
    report.push({ name, action });
  }
  return report;
}

// 漂移守卫（wf:ping 用）：逐角色读宿主文件，比对「实际 body 内容 hash vs 仓库期望」。
// managed=已托管且最新；stale=已托管但陈旧；unmanaged=无标记（用户自有）；missing=文件缺失。
export type RoleStatus = "managed" | "stale" | "unmanaged" | "missing";
export function roleSyncStatus(rolesDir: string): { name: string; status: RoleStatus }[] {
  const out: { name: string; status: RoleStatus }[] = [];
  for (const name of ROLE_NAMES) {
    const file = roleHostFile(rolesDir, name);
    if (!fs.existsSync(file)) { out.push({ name, status: "missing" }); continue; }
    const { body } = splitFrontmatter(fs.readFileSync(file, "utf8"));
    const { action } = syncDecision(body, renderRole(name));
    out.push({ name, status: action === "skip" ? "managed" : action === "write" ? "stale" : "unmanaged" });
  }
  return out;
}

// 宿主全局 agents/wf 目录解析：options.rolesDir 优先，回退 XDG_CONFIG_HOME 或 ~/.config/opencode/agents/wf
export function resolveRolesDir(opt: any): string {
  if (opt?.rolesDir) return String(opt.rolesDir);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "agents", "wf");
}

// M16-r38：leader 宿主 agent ID=workflow（顶层 agents/workflow.md），其余 7 角色在 agents/wf/ 下。
// agent ID 由文件相对 agents/ 的路径派生：agents/workflow.md→workflow、agents/wf/<name>.md→wf/<name>。
// rolesDir 即 agents/wf；leader 目标取其上级目录的 workflow.md（模板仍 roles/leader.md，内部角色名不变）。
export function roleHostFile(rolesDir: string, name: RoleName): string {
  if (name === "leader") return path.join(rolesDir, "..", "workflow.md");
  return path.join(rolesDir, `${name}.md`);
}

// setup 接线（fail-soft）：opt.syncRoles 开启时同步角色文件；异常不阻塞插件加载。
// 返回 dispose（无资源占用，置空保持组装层一致）。
export function registerRoleSync(ctx: any, opt: any): { dispose: () => void } {
  try {
    if (opt?.syncRoles !== true) return { dispose() {} };
    const dir = resolveRolesDir(opt);
    const report = syncRoles(dir, { backup: true });
    const summary = report.map((r) => `${r.name}:${r.action}`).join(" ");
    try { ctx?.log?.info?.(`[wf-workflow] 角色同步（${dir}）：${summary}`); } catch { }
    const unmanaged = report.filter((r) => r.action === "unmanaged").map((r) => r.name);
    if (unmanaged.length) {
      try { ctx?.log?.warn?.(`[wf-workflow] 以下角色文件无托管标记，未覆盖（如需托管请移除自定义内容或手动加标记）：${unmanaged.join(", ")}`); } catch { }
    }
  } catch { /* fail-soft：角色同步失败不阻塞插件 */ }
  return { dispose() {} };
}