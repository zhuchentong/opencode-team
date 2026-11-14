// wf-workflow — XDG 目录派生单点：roles/skills/state-scan 共用，禁各端重复 env 回退逻辑。
// 纯函数 + env 读取（与 state-scan 的 try/catch fail-open 兼容：homedir 抛错交调用方处置）。
import * as os from "node:os";
import { join } from "node:path";

export function xdgConfigDir(...seg: string[]): string {
  const base = process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config");
  return join(base, ...seg);
}

export function xdgDataDir(...seg: string[]): string {
  const base = process.env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
  return join(base, ...seg);
}
