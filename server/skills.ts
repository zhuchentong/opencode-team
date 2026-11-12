// wf-workflow — M16-r45：session-lookup skill 插件托管（文件同步，语义同 roles.ts 托管模式）
// 背景：OpenCode skill 只从文件系统/config 源发现，插件 JS 入口不能注册 skill →
//   借 setup 把仓库 skills/（单一来源）同步落盘到宿主全局 skills 目录（~/.config/opencode/skills/）。
// 安全：默认开启（options.syncSkills 显式 false 才关闭）+ 写前备份（.bak-<ts>）
//   + 尾行托管标记（SKILL.md frontmatter 必须从第 1 行开始，标记不能占首行）
//   + 无标记不覆盖（用户自有文件安全）+ hash 同跳过（防无谓热载）。fail-soft：同步失败不阻塞插件加载。
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { VERSION } from "./lib.ts";

export const SKILL_IDS = ["session-lookup"] as const;
export type SkillId = typeof SKILL_IDS[number];

// 模板目录：仓库 skills/（与 roles.ts ROLES_DIR 同构；server 入口经 bun 直跑 TS，import.meta.dirname 可用）
const SKILLS_SRC_DIR = path.join(import.meta.dirname, "..", "skills");

const contentHash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 12);

// 托管标记置于文件**末行**；hash 覆盖标记之前的全部内容（与 roles.ts 首行标记语义对偶）
export function skillMarker(id: SkillId, content: string): string {
  return `<!-- wf-workflow:managed-skill id=${id} version=${VERSION} hash=${contentHash(content)} -->`;
}
export function renderSkill(id: SkillId): string {
  const src = fs.readFileSync(path.join(SKILLS_SRC_DIR, id, "SKILL.md"), "utf8");
  return `${src.endsWith("\n") ? src : `${src}\n`}${skillMarker(id, src)}\n`;
}
// 解析末行托管标记 → {id, version, hash}；非标记 → null
export function parseSkillMarker(fileContent: string): { id: string; version: string; hash: string } | null {
  const last = fileContent.trimEnd().split("\n").pop()?.trim() ?? "";
  const m = /^<!-- wf-workflow:managed-skill id=(\S+) version=(\S+) hash=([0-9a-f]{12}) -->$/.exec(last);
  return m ? { id: m[1], version: m[2], hash: m[3] } : null;
}
// 同步决策（纯函数）：无标记→unmanaged；内容 hash 同→skip；hash 异→write。
// hash 对「去末行标记后的实际内容」重算（不能只比标记行，防陈旧 body 带旧标记漏判漂移）。
export function skillSyncDecision(existing: string, rendered: string): "skip" | "write" | "unmanaged" {
  if (!parseSkillMarker(existing)) return "unmanaged";
  const bodyOf = (s: string) => s.trimEnd().split("\n").slice(0, -1).join("\n");
  return contentHash(bodyOf(existing)) === contentHash(bodyOf(rendered)) ? "skip" : "write";
}

export type SkillSyncReport = { id: SkillId; action: "skip" | "write" | "unmanaged" | "create" };

// 文件同步（fs 副作用，可用临时目录测试）：write 时写前备份、全文覆盖（skill 无 frontmatter 保留问题——
// 标记在末行，宿主 frontmatter 解析不受影响）
export function syncSkills(skillsDir: string, opts: { backup?: boolean } = {}): SkillSyncReport[] {
  const report: SkillSyncReport[] = [];
  for (const id of SKILL_IDS) {
    const file = path.join(skillsDir, id, "SKILL.md");
    const rendered = renderSkill(id);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rendered);
      report.push({ id, action: "create" });
      continue;
    }
    const existing = fs.readFileSync(file, "utf8");
    const action = skillSyncDecision(existing, rendered);
    if (action === "write") {
      if (opts.backup !== false) {
        try { fs.writeFileSync(`${file}.bak-${Date.now()}`, existing); } catch { /* 备份失败不阻塞 */ }
      }
      fs.writeFileSync(file, rendered);
    }
    report.push({ id, action });
  }
  return report;
}

// 宿主全局 skills 目录解析：options.skillsDir 优先，回退 XDG_CONFIG_HOME 或 ~/.config/opencode/skills
export function resolveSkillsDir(opt: any): string {
  if (opt?.skillsDir) return String(opt.skillsDir);
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "skills");
}

// setup 接线（fail-soft，默认开启）：opt.syncSkills 显式 false 才跳过；异常不阻塞插件加载。
export function registerSkillSync(ctx: any, opt: any): { dispose: () => void } {
  try {
    if (opt?.syncSkills === false) return { dispose() {} };
    const dir = resolveSkillsDir(opt);
    const report = syncSkills(dir, { backup: true });
    const summary = report.map((r) => `${r.id}:${r.action}`).join(" ");
    try { ctx?.log?.info?.(`[wf-workflow] skill 同步（${dir}）：${summary}`); } catch { }
    const unmanaged = report.filter((r) => r.action === "unmanaged").map((r) => r.id);
    if (unmanaged.length) {
      try { ctx?.log?.warn?.(`[wf-workflow] 以下 skill 文件无托管标记，未覆盖（如需托管请移除自定义内容或手动加末行标记）：${unmanaged.join(", ")}`); } catch { }
    }
  } catch { /* fail-soft：skill 同步失败不阻塞插件 */ }
  return { dispose() {} };
}
