// wf-workflow — XDG 目录派生单点：roles/skills/state-scan 共用，禁各端重复 env 回退逻辑。
// 纯函数 + env 读取（与 state-scan 的 try/catch fail-open 兼容：homedir 抛错交调用方处置）。
import * as os from "node:os";
import { join } from "node:path";

/** 解析 XDG 配置目录（尊重 XDG_CONFIG_HOME，回退 ~/.config），拼接子段。
 * @param seg 逐级子路径段（如 "opencode", "agents", "wf"）
 * @returns 拼接后的绝对目录路径
 * @throws os.homedir() 失败时异常向上抛（调用方 try/catch 兜底） */
export function xdgConfigDir(...seg: string[]): string {
  const base = process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config");
  return join(base, ...seg);
}

/** 解析 XDG 数据目录（尊重 XDG_DATA_HOME，回退 ~/.local/share），拼接子段。
 * @param seg 逐级子路径段
 * @returns 拼接后的绝对目录路径
 * @throws os.homedir() 失败时异常向上抛（调用方 try/catch 兜底） */
export function xdgDataDir(...seg: string[]): string {
  const base = process.env.XDG_DATA_HOME || join(os.homedir(), ".local", "share");
  return join(base, ...seg);
}
