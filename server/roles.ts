// wf-workflow — M16-r31：角色内容插件托管（B1 文件同步主路径）——域门面。
// T05（arch-r1-host-split）：通用决策+IO 已抽至 managed-sync.ts；本文件只留角色域语义：
// phaseChain 结构事实渲染 / renderRole 全文（标记+body）/ fm 快照 / 标记解析 / 路径解析 / setup 接线。
// 安全语义逐字保留：opt-in（options.syncRoles）+ 写前备份 + 标记区分托管/自有 + 无标记不覆盖 + hash 同跳过；
// create 仅 missing 时读 fm 快照（惰性 getter，与旧「missing 分支才读」时序同源），已存在文件 fm 绝不触碰。
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PHASE_ORDER, FOLD } from "../shared/phases.ts";
import { VERSION } from "./lib.ts";
import { type Host } from "./host.ts"; // T03：registerRoleSync 收 Host
import { swallow } from "./observe.ts"; // T01：静默 catch → 环形审计记账
import {
  contentHash12, decideSync, syncAll, statusAll,
  type SyncAction, type SyncStatus, type SyncReport, type SyncTarget,
} from "./managed-sync.ts";

// 8 角色（leader + 7 subagent）；与 lib.ts WF_ROLES 同源语义（WF_ROLES 不含 leader）
export const ROLE_NAMES = [
  "leader", "planner", "planner-reviewer", "tester",
  "builder", "builder-reviewer", "fixer", "learner",
] as const;
export type RoleName = typeof ROLE_NAMES[number];
export type { SyncAction, SyncReport };
export type RoleStatus = SyncStatus; // 类型别名转发（旧联合值集相同：managed|stale|unmanaged|missing）

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

// 模板 body（结构事实注入后）——hash 必须基于「替换占位符后」最终内容（hash 跳过才有效，防无谓热载）
function roleBody(name: RoleName): string {
  const tpl = fs.readFileSync(path.join(ROLES_DIR, `${name}.md`), "utf8");
  return tpl.replace(/\{\{PHASE_CHAIN\}\}/g, phaseChain());
}

// 托管标记（body 首行）：version + hash。hash 覆盖标记行之后的全部内容。
export function roleMarker(name: RoleName): string {
  return `<!-- wf-workflow:managed version=${VERSION} hash=${contentHash12(roleBody(name))} -->`;
}

// 渲染角色全文 = 托管标记 + 模板 body（结构事实注入）。纯函数（读模板文件，无副作用）。
export function renderRole(name: RoleName): string {
  return `${roleMarker(name)}\n${roleBody(name)}`;
}

// M16-r39 T12：宿主 frontmatter 逐字快照（roles/fm/<name>.md）。仅 missing 自动创建消费。
export function roleFrontmatter(name: RoleName): string {
  return fs.readFileSync(path.join(ROLES_DIR, "fm", `${name}.md`), "utf8");
}

// 解析托管标记行 → {version, hash}；非标记 → null
export function parseMarker(line: string): { version: string; hash: string } | null {
  const m = /^<!-- wf-workflow:managed version=(\S+) hash=([0-9a-f]{12}) -->$/.exec(line.trim());
  return m ? { version: m[1], hash: m[2] } : null;
}

// 同步决策转发（tests/roles.test.js 消费位零改动；语义=decideSync head 形，hash 对去标记行内容重算）
export function syncDecision(existingBody: string, rendered: string): { action: SyncAction } {
  return { action: decideSync(existingBody, rendered, { markerPosition: "head", parseHashMarker: parseMarker }) };
}

// 目标清单构造：items 预渲染（render 留域门面，managed-sync 纯执行）；frontmatter 惰性 getter=仅 create 读快照
const roleTarget = (rolesDir: string, backup: boolean): SyncTarget => ({
  markerPrefix: "wf-workflow:managed",
  markerPosition: "head",
  parseHashMarker: parseMarker,
  backup,
  items: ROLE_NAMES.map((name) => ({
    name,
    file: roleHostFile(rolesDir, name),
    rendered: renderRole(name),
    get frontmatter() { return roleFrontmatter(name); },
  })),
});

// 文件同步（委托 managed-sync；旧「missing 保守不创建」翻转语义、fm 保留、备份、跳过均在对偶实现处）
export function syncRoles(rolesDir: string, opts: { backup?: boolean } = {}): SyncReport[] {
  return syncAll([roleTarget(rolesDir, opts.backup !== false)]);
}

// 漂移守卫（wf:ping 用）：managed=已托管且最新；stale=已托管但陈旧；unmanaged=无标记；missing=文件缺失
export function roleSyncStatus(rolesDir: string): { name: string; status: RoleStatus }[] {
  return statusAll([roleTarget(rolesDir, false)]);
}

// 宿主全局 agents/wf 目录解析：options.rolesDir 优先，回退 XDG_CONFIG_HOME 或 ~/.config/opencode/agents/wf
export function resolveRolesDir(opt: any): string {
  if (opt?.rolesDir) return String(opt.rolesDir);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "agents", "wf");
}

// M16-r38：leader 宿主 agent ID=workflow（顶层 agents/workflow.md），其余 7 角色在 agents/wf/ 下。
export function roleHostFile(rolesDir: string, name: RoleName): string {
  if (name === "leader") return path.join(rolesDir, "..", "workflow.md");
  return path.join(rolesDir, `${name}.md`);
}

// setup 接线（fail-soft）：opt.syncRoles 开启时同步角色文件；异常不阻塞插件加载。返回 dispose（空保持组装一致）。
export function registerRoleSync(host: Host, opt: any): { dispose: () => void } {
  try {
    if (opt?.syncRoles !== true) return { dispose() {} };
    const dir = resolveRolesDir(opt);
    const report = syncRoles(dir, { backup: true });
    const summary = report.map((r) => `${r.name}:${r.action}`).join(" ");
    host.notify("info", `[wf-workflow] 角色同步（${dir}）：${summary}`); // T03：旧 ctx.log 裸戳+try/catch→notify（缺失/抛错内部 swallow 静默降级）
    const unmanaged = report.filter((r) => r.action === "unmanaged").map((r) => r.name);
    if (unmanaged.length) {
      host.notify("warn", `[wf-workflow] 以下角色文件无托管标记，未覆盖（如需托管请移除自定义内容或手动加标记）：${unmanaged.join(", ")}`);
    }
  } catch (e) { swallow(e, "roles:sync-fail-soft"); }
  return { dispose() {} };
}
