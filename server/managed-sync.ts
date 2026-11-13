// wf-workflow — T05（arch-r1-host-split）：托管同步通用层——决策（纯函数）+ fs IO，自
// roles.ts/skills.ts 两份同构实现抽出（单一来源）。域门面保留渲染/标记解析（语义逐字），决策与
// 落盘在此执行。安全语义逐字等价：写前备份 .bak-<ts>／hash 跳过（基数=去标记行内容重算，而非读
// 标记字段——防陈旧标记掩盖内容漂移）／无标记不覆盖（用户自有文件安全）／missing 才 create
// （拼 frontmatter 快照）。备份失败记账走 swallow（红线：静默失败可审计）。
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { swallow } from "./observe.ts";

export type SyncAction = "skip" | "write" | "unmanaged" | "create";
export type SyncStatus = "managed" | "stale" | "unmanaged" | "missing";
export interface SyncReport { name: string; action: SyncAction }
export interface SyncTarget {
  markerPrefix: string;                    // "wf-workflow:managed" | "wf-workflow:managed-skill"（标记格式锚，门面构造自证）
  markerPosition: "head" | "tail";         // roles=body 首行；skills=文件末行（两域对偶）
  items: { name: string; file: string; rendered: string; frontmatter?: string }[]; // 调用方预渲染；frontmatter 可为惰性 getter（仅 create 分支消费，时序同旧）
  parseHashMarker: (line: string) => { version: string; hash: string } | null;     // 两种标记格式各传各的解析器
  backup: boolean;                          // 写前 .bak-<ts>（语义逐字保留）
}

// 内容 hash：sha256 前 12 位 hex（两域同源，替代 roles.bodyHash / skills.contentHash 本地实现）
export const contentHash12 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

// 拆分宿主文件 frontmatter 与 body（--- 块含尾换行原样保留；自 roles.ts 私有实现同形搬移）
function splitFrontmatter(content: string): { fm: string; body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  if (!m) return { fm: "", body: content };
  return { fm: m[0], body: content.slice(m[0].length) };
}

// 标记行定位 / 去标记行内容（head：先剥文件头 --- 块再取首行；tail：trimEnd 归一尾空白后取末行）
function markerLine(content: string, pos: "head" | "tail"): string {
  const body = pos === "head" ? splitFrontmatter(content).body : content;
  return pos === "head" ? body.split("\n")[0] ?? "" : body.trimEnd().split("\n").pop()?.trim() ?? "";
}
function stripMarker(content: string, pos: "head" | "tail"): string {
  const body = pos === "head" ? splitFrontmatter(content).body : content;
  return pos === "head" ? body.split("\n").slice(1).join("\n") : body.trimEnd().split("\n").slice(0, -1).join("\n");
}

// 纯决策（表驱动对齐旧 syncDecision/skillSyncDecision）：null→create；无标记→unmanaged；
// hash 同（基数=去标记行内容）→skip；异→write。
export function decideSync(content: string | null, rendered: string, t: Pick<SyncTarget, "markerPosition" | "parseHashMarker">): SyncAction {
  if (content === null) return "create";
  if (!t.parseHashMarker(markerLine(content, t.markerPosition))) return "unmanaged";
  return contentHash12(stripMarker(content, t.markerPosition)) === contentHash12(stripMarker(rendered, t.markerPosition)) ? "skip" : "write";
}

// fs 执行：create=mkdir -p + frontmatter（此刻才读惰性 getter）+ rendered；write=保既有 fm
// （仅 head 域取）+ 写前备份；unmanaged/skip 零写。备份失败 swallow 记账不阻塞。
export function syncAll(targets: SyncTarget[]): SyncReport[] {
  const report: SyncReport[] = [];
  for (const t of targets) {
    for (const item of t.items) {
      const content = fs.existsSync(item.file) ? fs.readFileSync(item.file, "utf8") : null;
      const action = decideSync(content, item.rendered, t);
      if (action === "create") {
        fs.mkdirSync(path.dirname(item.file), { recursive: true });
        fs.writeFileSync(item.file, (item.frontmatter ?? "") + item.rendered);
      } else if (action === "write" && content !== null) {
        if (t.backup) {
          try { fs.writeFileSync(`${item.file}.bak-${Date.now()}`, content); } catch (e) { swallow(e, "managed-sync:backup-fail"); }
        }
        const fm = t.markerPosition === "head" ? splitFrontmatter(content).fm : "";
        fs.writeFileSync(item.file, fm + item.rendered);
      }
      report.push({ name: item.name, action });
    }
  }
  return report;
}

// 漂移视图（wf:ping 用）：skip→managed／write→stale／无标记→unmanaged／文件缺失→missing
export function statusAll(targets: SyncTarget[]): { name: string; status: SyncStatus }[] {
  const out: { name: string; status: SyncStatus }[] = [];
  for (const t of targets) {
    for (const item of t.items) {
      if (!fs.existsSync(item.file)) { out.push({ name: item.name, status: "missing" }); continue; }
      const action = decideSync(fs.readFileSync(item.file, "utf8"), item.rendered, t);
      out.push({ name: item.name, status: action === "skip" ? "managed" : action === "write" ? "stale" : "unmanaged" });
    }
  }
  return out;
}
