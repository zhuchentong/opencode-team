// tui/util.ts — R3 T3.4 拆分共用小工具（str/errMsg；panel/notify/index 三处同源）
import { statSync } from "node:fs"; // r54 D1：产物文件指纹（静态内建导入，bundle 外部化）
/** 空值安全转字符串：null/undefined 归一为空串，其余 String()。
 * @param v 任意输入值。
 * @returns 字符串形式（null/undefined 归一为空串）。 */
export const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
/** 任意抛出值转错误消息串（优先 Error.message，兜底 String(e)）。
 * @param e 任意抛出值（catch 入参）。
 * @returns 错误消息串。 */
export const errMsg = (e: unknown) => String((e as Error)?.message ?? e);
/** r54 D1：本产物文件（dist/tui.js）mtime ISO 串——版本标签陈旧归因锚（test_008 实证：10:35 运行
 * build=M16-r47 而 11:18 重建后才是 r53，归因只能靠猜）；失败返回空串（探针 fail-soft）。
 * @returns 产物文件修改时间 ISO 串；stat 失败为 ""。 */
export function selfMtimeIso(): string {
  try {
    return statSync(decodeURIComponent(new URL(import.meta.url).pathname)).mtime.toISOString();
  } catch { return ""; }
}
/** r54 D2 空闲轮询跳拍判定（纯函数，bun test 直测）：空闲（无状态/err/done）时每 6 拍执行 1 次
 * （5s 节拍 ×6=等效 30s 退避），活跃态每拍执行。守锚约束：单 setInterval、无新 timer
 * （harness R7）——故不做 setInterval 重排，改为节拍内跳过 RPC 调用。
 * @param idle 当前是否空闲（无活跃任务/错误态）
 * @param tick 5s 节拍计数（自增序号，1 起）
 * @returns true=本拍跳过 refresh 调用 */
export const pollSkip = (idle: boolean, tick: number): boolean => idle && tick % 6 !== 0;

// R3 T3.4：探针工厂（自 index.tsx setup 拆出；REPO 兜底/loaded 时间戳/序列号在此闭环）。
// P6 收敛：默认关闭（WF_DEBUG=1 ./scripts/tui-restart.sh 开启）；写 .workflow/_debug/tui-refresh.log。
/**
 * 创建 TUI 调试探针：WF_DEBUG=1 时把诊断事件追加写入 .workflow/_debug/tui-refresh.log，默认关闭。
 * @param context 宿主注入的插件上下文（取 location.directory 定位仓库根）。
 * @param opts 选项对象。
 * @param opts.build 当前构建版本号（随日志行落盘，便于跨重启对账）。
 * @returns REPO（解析出的仓库根目录）与 probe（异步追加写日志的探针函数，失败静默不影响 UI）。
 */
export function setupProbe(context: any, opts: { build: string }) {
  // REPO 兜底：location 缺失时由模块 URL 反推仓库根（P3a 疑点：探针可能写错位置）
  const REPO = String(context?.location?.directory ?? "") || decodeURIComponent(new URL(/* @vite-ignore */ "../../", import.meta.url).pathname).replace(/\/$/, "");
  const LOADED_AT = new Date().toISOString();
  let seq = 0;
  const PROBE_ON = process.env.WF_DEBUG === "1";
  const probe = (data: Record<string, unknown>) => {
    if (!PROBE_ON) return;
    (async () => {
      try {
        const fs = await import("node:fs");
        const dir = `${REPO}/.workflow/_debug`;
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(`${dir}/tui-refresh.log`, JSON.stringify({ at: new Date().toISOString(), build: opts.build, loadedAt: LOADED_AT, seq: ++seq, ...data }) + "\n");
      } catch { /* 探针失败不影响 UI */ }
    })();
  };
  return { REPO, probe };
}
