// wf-workflow — M16-r45：session-lookup skill 插件托管（域门面；语义同 roles.ts 托管模式）。
// T05（arch-r1-host-split）：通用决策+IO 抽至 managed-sync.ts；本文件留 skill 域渲染/标记语义。
// 安全（逐字保留）：默认开启（options.syncSkills 显式 false 才关闭）+ 写前备份（.bak-<ts>）
//   + 尾行托管标记（SKILL.md frontmatter 必须从第 1 行开始，标记不能占首行）
//   + 无标记不覆盖（用户自有文件安全）+ hash 同跳过（防无谓热载）。fail-soft：同步失败不阻塞插件加载。
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { VERSION } from "./lib.ts";
import { type Host } from "./host.ts"; // T03：registerSkillSync 收 Host
import { swallow } from "./observe.ts"; // T01：静默 catch → 环形审计记账
import { contentHash12, decideSync, syncAll, type SyncAction, type SyncTarget } from "./managed-sync.ts";

export const SKILL_IDS = ["session-lookup"] as const;
export type SkillId = typeof SKILL_IDS[number];
export type { SyncAction };

// 模板目录：仓库 skills/（与 roles.ts ROLES_DIR 同构；server 入口经 bun 直跑 TS，import.meta.dirname 可用）
const SKILLS_SRC_DIR = path.join(import.meta.dirname, "..", "skills");

// 托管标记置于文件**末行**；hash 覆盖标记之前的全部内容（与 roles.ts 首行标记语义对偶）
export function skillMarker(id: SkillId, content: string): string {
  return `<!-- wf-workflow:managed-skill id=${id} version=${VERSION} hash=${contentHash12(content)} -->`;
}
export function renderSkill(id: SkillId): string {
  const src = fs.readFileSync(path.join(SKILLS_SRC_DIR, id, "SKILL.md"), "utf8");
  return `${src.endsWith("\n") ? src : `${src}\n`}${skillMarker(id, src)}\n`;
}
// 解析末行托管标记 → {id, version, hash}；非标记 → null（对 managed-sync 行级解析器签名兼容：取末行语义幂等）
export function parseSkillMarker(fileContent: string): { id: string; version: string; hash: string } | null {
  const last = fileContent.trimEnd().split("\n").pop()?.trim() ?? "";
  const m = /^<!-- wf-workflow:managed-skill id=(\S+) version=(\S+) hash=([0-9a-f]{12}) -->$/.exec(last);
  return m ? { id: m[1], version: m[2], hash: m[3] } : null;
}
// 同步决策转发（旧签名返回动作字符串；消费位 tests/sid-reliability 零改动。输入恒非 null，
// hash 基数=去末行标记内容重算——不能只比标记行，防陈旧 body 带旧标记漏判漂移）。
export function skillSyncDecision(existing: string, rendered: string): "skip" | "write" | "unmanaged" {
  const a = decideSync(existing, rendered, { markerPosition: "tail", parseHashMarker: parseSkillMarker });
  return a === "skip" || a === "write" || a === "unmanaged" ? a : "write"; // create 不可达（保守兜底 write）
}

export type SkillSyncReport = { id: SkillId; action: "skip" | "write" | "unmanaged" | "create" };

// 目标清单：items 预渲染；skill 无 fm 保留问题（标记在末行，宿主 frontmatter 解析不受影响）
const skillTarget = (skillsDir: string, backup: boolean): SyncTarget => ({
  markerPrefix: "wf-workflow:managed-skill",
  markerPosition: "tail",
  parseHashMarker: parseSkillMarker,
  backup,
  items: SKILL_IDS.map((id) => ({ name: id, file: path.join(skillsDir, id, "SKILL.md"), rendered: renderSkill(id) })),
});

// 文件同步（委托 managed-sync：create 全文落盘、write 备份+覆盖、skip/unmanaged 零写）
export function syncSkills(skillsDir: string, opts: { backup?: boolean } = {}): SkillSyncReport[] {
  return syncAll([skillTarget(skillsDir, opts.backup !== false)])
    .map((r) => ({ id: r.name as SkillId, action: r.action }));
}

// 宿主全局 skills 目录解析：options.skillsDir 优先，回退 XDG_CONFIG_HOME 或 ~/.config/opencode/skills
export function resolveSkillsDir(opt: any): string {
  if (opt?.skillsDir) return String(opt.skillsDir);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "skills");
}

// setup 接线（fail-soft，默认开启）：opt.syncSkills 显式 false 才跳过；异常不阻塞插件加载。
export function registerSkillSync(host: Host, opt: any): { dispose: () => void } {
  try {
    if (opt?.syncSkills === false) return { dispose() {} };
    const dir = resolveSkillsDir(opt);
    const report = syncSkills(dir, { backup: true });
    const summary = report.map((r) => `${r.id}:${r.action}`).join(" ");
    host.notify("info", `[wf-workflow] skill 同步（${dir}）：${summary}`); // T03：旧 ctx.log 裸戳+try/catch→notify（缺失/抛错内部 swallow 静默降级）
    const unmanaged = report.filter((r) => r.action === "unmanaged").map((r) => r.id);
    if (unmanaged.length) {
      host.notify("warn", `[wf-workflow] 以下 skill 文件无托管标记，未覆盖（如需托管请移除自定义内容或手动加末行标记）：${unmanaged.join(", ")}`);
    }
  } catch (e) { swallow(e, "skills:sync-fail-soft"); }
  return { dispose() {} };
}
