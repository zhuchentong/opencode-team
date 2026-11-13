// wf-workflow — 观测通道（自 index.ts 原样搬移）：debug 目录按会话解析 + 首次触发探针落盘。
// 观测通道：.workflow/_debug/{tools,hook-probe,tool-probe,chat-probe,state}.json（probe:false 可关）
// T01（arch-r1-host-split）：新增模块级 swallow 环形缓冲——server/ 66 处静默 catch 替换为可审计记账；
//   createObserver 内探针路径 3 处 catch 保持静默（探针失败本身属观测通道，排除防自我触发）。
import * as fs from "node:fs";
import { VERSION, type SwallowEntry } from "./lib.ts";
import { type Host } from "./host.ts"; // T03：收 Host（原 ctx:any）

// ── T01：静默失败审计环形缓冲（纯内存 push／零 IO／绝不再抛；FIFO 超限丢最旧）──────
// SwallowEntry 类型单一来源在 lib.ts（T02 归 domain/types.ts——零依赖叶子，observe/diagnose 同型引用）。
// clearSwallows 供测试隔离（bun test 同进程共享模块态）。
export const SWALLOW_RING_MAX = 200;
const swallowRing: SwallowEntry[] = [];

export function swallow(err: unknown, code: string): void {
  let msg: string;
  try { msg = String(err); } catch { msg = "(err unstringifiable)"; } // toString 抛错兜底（体非空，不计静默 catch）
  if (swallowRing.length >= SWALLOW_RING_MAX) swallowRing.shift();
  swallowRing.push({ code, msg, at: new Date().toISOString() });
}

export function listSwallows(): SwallowEntry[] {
  return swallowRing.map((e) => ({ ...e })); // 时序快照拷贝：外部改动不触及环
}

export function clearSwallows(): void {
  swallowRing.length = 0;
}

// M16-r39 T06：deps 类型化（Observer 契约）；T03：入参 ctx→host（防腐层访问器）
export interface Observer {
  debugDirFor(sessionID: string): Promise<string>;
  probeOnce(sessionID: string, name: string, data: Record<string, unknown>): Promise<void>;
  logToolsOnce(namesPromise: Promise<unknown>, sessionID: string): Promise<void>;
}

export function createObserver(host: Host, opt: any): Observer { // T03：ctx→Host（Observer 契约不变）
  // P0-a：debug 目录惰性按会话解析（修 REPO 硬编码）——显式 options.debugDir 优先，
  // 回退会话项目目录（实测工具回调无 directory，须 session.get），再回退进程 cwd。
  const debugDirFor = async (sessionID: string): Promise<string> => {
    if (opt.debugDir) return String(opt.debugDir);
    try {
      const s = await host.sessions.get({ sessionID });
      if (s?.location?.directory) return String(s.location.directory);
    } catch { }
    return process.cwd();
  };

  // 首次触发探针（只写一次，验证插件所见入参形状；ERR-002 教训：先探形状再使用）
  // P0-a：目录改为按会话解析（原为模块级 DBG 常量，硬编码仓库路径）
  // P6 收敛：默认关闭——真机调试期结束；需要时 options.probe=true 或环境变量 WF_DEBUG=1（server/TUI 通用）
  const PROBE = opt.probe === true || process.env.WF_DEBUG === "1";
  const probeOnce = async (sessionID: string, name: string, data: Record<string, unknown>): Promise<void> => {
    try {
      if (!PROBE) return;
      const dir = `${await debugDirFor(sessionID)}/.workflow/_debug`;
      const p = `${dir}/${name}.json`;
      if (fs.existsSync(p)) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2));
    } catch { }
  };

  // P0-a：工具注册证据延迟到首次工具执行时落盘（原在注册回调内写死 DBG 路径；
  // 注册回调无 sessionID，无法解析项目目录）
  let toolsLogged = false;
  const logToolsOnce = async (namesPromise: Promise<unknown>, sessionID: string): Promise<void> => {
    if (!PROBE) return; // M16-r39 T03：补 PROBE 门（旧实现漏门：probe:false 仍写 tools.json）
    if (toolsLogged) return;
    toolsLogged = true;
    try {
      const listed: any = await namesPromise;
      const names = Array.isArray(listed) ? listed.map((t: any) => t?.name ?? String(t)) : listed;
      const dir = `${await debugDirFor(sessionID)}/.workflow/_debug`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${dir}/tools.json`, JSON.stringify({ at: new Date().toISOString(), version: VERSION, tools: names }, null, 2));
    } catch { }
  };

  return { debugDirFor, probeOnce, logToolsOnce };
}
