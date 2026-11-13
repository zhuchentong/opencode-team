// tui/util.ts — R3 T3.4 拆分共用小工具（str/errMsg；panel/notify/index 三处同源）
export const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
export const errMsg = (e: unknown) => String((e as Error)?.message ?? e);

// R3 T3.4：探针工厂（自 index.tsx setup 拆出；REPO 兜底/loaded 时间戳/序列号在此闭环）。
// P6 收敛：默认关闭（WF_DEBUG=1 ./scripts/tui-restart.sh 开启）；写 .workflow/_debug/tui-refresh.log。
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
