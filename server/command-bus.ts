// wf-workflow — R2 T2.4（arch-r2-profile-statemachine）：命令总线。
// 取代旧「runner={run:null} 可变盒子」解 bridge↔commands 循环依赖的形态：Map 注册表可在
// setup 早期共享引用（index 先建 bus → rpc-bridge/command-tool 持引用 → registerCommands 后
// 填充），装配时序即解环，无运行时替换面。dispatch 语义=旧 runner.run 赋值体逐字节迁移
//（未知命令 ❌/briefFallback/levelFor；成功 {text,at,...meta}；无 text 缺省 {brief:"",level:"info"}）。
// publish 回调由 commands.ts attach（双轨输出编排留原层，bus 不持 IO）。
import { briefFallback, levelFor, type ReportLevel } from "./lib.ts";

export type CmdHandler = (a: any) => Promise<unknown>;
export type DispatchResult = { text: string; at: string; brief: string | null; level: ReportLevel | null };
export type PublishFn = (name: string, text: string, at: string, a: any) => Promise<{ brief: string; level: ReportLevel }>;

export interface CommandBus {
  register(name: string, fn: CmdHandler): void;
  has(name: string): boolean;
  names(): string[];
  attachPublish(fn: PublishFn): void;
  call(name: string, a: any): Promise<DispatchResult>;
}

export function createCommandBus(): CommandBus {
  const m = new Map<string, CmdHandler>();
  let publish: PublishFn | null = null;
  return {
    register: (name, fn) => { m.set(name, fn); },
    has: (name) => m.has(name),
    names: () => [...m.keys()],
    attachPublish: (fn) => { publish = fn; },
    async call(name: string, a: any): Promise<DispatchResult> {
      const base = m.get(name);
      if (!base) {
        // 未知命令不发布（与旧行为一致），但返回体四字段齐备：❌ 前缀不变量 → levelFor=warn，
        // brief 走 fallback 纯函数（与 publishOutput 同源判定，TUI 无需特判）
        const t = `❌ 未知命令：${name}`;
        return { text: t, at: "", brief: briefFallback(name, t), level: levelFor(name, t, null) };
      }
      const out = await base(a);
      const text = typeof out === "string" ? out : "";
      const at = new Date().toISOString();
      // T03（plan §4）：publish 结果透传；无 text 不发布 → 缺省 brief="" level="info"
      const meta = text && publish ? await publish(name, text, at, a) : { brief: "", level: "info" as ReportLevel };
      return { text, at, ...meta };
    },
  };
}
