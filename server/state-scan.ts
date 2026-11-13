// server/state-scan.ts — P1-A（arch-maintenance-p1）自 state.ts 拆出：selfmod 护栏域。
// 跨项目活动任务扫描（scanActiveTasks）+ 项目清单登记（registerProject/JSONL）。
// 平铺顶层原因：swallow-coverage 守卫 readdirSync 非递归，子目录会逃逸静默 catch 扫描（V3）。
// swallow 前缀随迁基名纪律：state:* → state-scan:*（transition:*/middleware:* 先例）。
// 与 state.ts 的关系：单向依赖（本文件不 import state.ts，防环）；state.ts re-export 本文件符号。
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { type ActiveOther } from "./lib.ts";
export type { ActiveOther }; // state.ts re-export 链用
import { swallow } from "./observe.ts";

// ── selfmod-concurrency-guard T01（F2 v2）：跨项目活动任务扫描 ──────────────────
// v1 进程内存注册表两处盲区（双任务+implant 卡死日志实证）：①休眠未收尾任务不在内存——用户多日
//   resume 习惯下恰是主要干扰源；②模块级内存表随热载清零——护栏静默失明（I-1，正击穿其保护目标）。
// v2 = PROJECT_DBS 内存表（加速）∪ 持久项目清单（append-only JSONL，热载后仍在）；扫描逐库校验
//   存在性。全链 fail-open：只产告警素材绝不阻断流转；单坏库跳过不影响其它；写清单失败静默降级纯内存。
// 隔离钩子：WF_PROJECTS_FILE 显式设置=只读该文件、忽略内存表与写入（测试确定性，防同进程他文件库污染）。
export const PROJECT_DBS = new Map<string, string>();
export const PROJECTS_FILE_DEFAULT = (() => {
  try {
    const base = process.env.XDG_DATA_HOME || join(process.env.HOME ?? os.homedir(), ".local", "share");
    return join(base, "opencode", "wf-projects.jsonl");
  } catch { return ""; }
})();
export function projectsListFile(): string { return process.env.WF_PROJECTS_FILE || PROJECTS_FILE_DEFAULT; }
// 登记（createStore 调用）：内存恒记；文件仅在未设 WF_PROJECTS_FILE 时追加（env 钩子=完全接管语义）。
// JSONL 逐行 append：无读-改-写竞态（多进程并发安全，坏行=撕裂写，扫描侧跳过）。
export function registerProject(dir: string, dbFile: string): void {
  try {
    if (!dir || !dbFile) return;
    PROJECT_DBS.set(dir, dbFile);
    if (process.env.WF_PROJECTS_FILE !== undefined) return;
    const f = projectsListFile();
    if (!f) return;
    fs.mkdirSync(dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ dir, dbFile }) + "\n");
  } catch (e) { swallow(e, "state-scan:projects-file-append-fail"); }
}
function readProjectsList(): string[] {
  try {
    const txt = fs.readFileSync(projectsListFile(), "utf8");
    const out: string[] = [];
    for (const line of txt.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && typeof o.dbFile === "string" && o.dbFile) out.push(o.dbFile);
      } catch (e) { swallow(e, "state-scan:projects-line-bad"); }
    }
    return out;
  } catch { return []; }
}
// 扫描其它会话的活动任务（intake 自改命中时调用）。排除自身会话行；防御性过滤（无 slug/done 行
// 即使 is_active=1 也不展示——外部写库形状漂移兜底）。updatedAt 原样带出（lib 侧分级措辞消费）。
export function scanActiveTasks(excludeSessionID: string): ActiveOther[] {
  const sid = String(excludeSessionID ?? "");
  const files = new Set<string>();
  if (!process.env.WF_PROJECTS_FILE) for (const f of PROJECT_DBS.values()) files.add(f);
  for (const f of readProjectsList()) files.add(f);
  const out: ActiveOther[] = [];
  for (const f of files) {
    let d: any = null;
    try {
      if (!fs.existsSync(f)) continue; // 清单条目对应项目已删（存在性逐条目校验，防清单虚胖）
      // S-3 降级链：readonly 打开（不扰活写者）→ WAL 恢复等失败退普通打开（create:false 不建库）→ 仍败跳过
      try { d = new Database(f, { readonly: true }); }
      catch { d = new Database(f, { create: false }); }
      const rows = d.prepare(
        "SELECT slug, phase, directory, updated_at FROM tasks WHERE is_active = 1 AND session_id != ?",
      ).all(sid) as { slug: string; phase: string | null; directory: string | null; updated_at: string | null }[];
      for (const r of rows) {
        if (!r?.slug || r.phase === "done") continue;
        out.push({ slug: String(r.slug), phase: r.phase ?? null, directory: r.directory ?? null, updatedAt: r.updated_at ?? null });
      }
    } catch (e) { swallow(e, "state-scan:scan-db-skip"); }
    finally { try { d?.close(); } catch (e) { swallow(e, "state-scan:db-handle-close-fail"); } }
  }
  out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  return out;
}
