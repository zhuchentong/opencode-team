// wf-workflow — T03（arch-r1-host-split）：Host 防腐层。全仓唯一允许 ctx.<prop> 裸戳处
//（守卫=tests/host-boundary.test.js，audit 口径剥注释/字符串，白名单仅本文件）。
// 成员按实测直戳面（51 处/11 文件）推导，接口签名以 plan §T03 冻结为准。
// 语义纪律：每个方法是旧裸戳点的薄透传——旧站用可选链降级的（wait/hook/agents/models/storage/entry.list）
// 保持「缺失→undefined/null」；旧站裸戳依赖 try/catch 兜底的（get/prompt/put/remove/rpc 调用/transform/
// tools.hook）保持「缺失→rejected TypeError」，使 entryErr/audit/swallow 记账链逐字不变。
// 构造期零解引用（任何属性访问都在方法体内）：残缺/假 ctx 直喂 setup() 仍活（integration 全链锚）。
// options/location 为活读 getter（防 setup 期快照丢失热载/测试覆写——selfModRoot 同模式）。
// setup(ctx:any) 入口签名不动（宿主契约）；adaptHost 是全仓唯一收 ctx 的函数。
import { swallow } from "./observe.ts";

export interface HostDisposer { dispose: () => void }

export interface Host {
  options: Record<string, any>;
  location: { directory: string | undefined };
  sessions: {
    get(q: { sessionID: string }): Promise<any>;
    wait(q: { sessionID: string }): Promise<unknown>;
    prompt(q: Record<string, any>): Promise<unknown>;
    hook(name: string, cb: (event: any) => unknown): Promise<HostDisposer | null>;
  };
  instructions: {
    put(q: { sessionID?: string; key: string; value: string }): Promise<unknown>; // sessionID 可选（同旧 entry.put 调用面）
    // list 增可选 key（plan 冻结形态的最小扩展）：旧 wf:debug 站以 (sessionID) / (sessionID,key) 两形态
    // 试探，缺失语义靠返回 undefined 作 capability 信号（对应旧 !E?.list → "no entry API" 分支）。
    list(q: { sessionID?: string; key?: string }): Promise<unknown>;
    remove(q: { sessionID?: string; key: string }): Promise<unknown>;
  };
  commands: { transform(fn: (draft: any) => void): HostDisposer };
  tools: {
    transform(fn: (draft: any) => void): HostDisposer;
    hook(name: string, cb: (i: any, o: any) => unknown): HostDisposer;
  };
  agents: { list(): Promise<any> | undefined };
  models: { list(): Promise<any> | undefined };
  storage: {
    // 返回宿主原样：数组或 {entries} 形态由 state.ts 迁移路径两分支消化；缺失→undefined（capability 信号）
    scan(q: { prefix: string }): Promise<any[] | { entries?: any[] } | undefined>;
  };
  rpc: {
    register(def: any, impl: any): Promise<(HostDisposer & { events?: { emit(n: string, p: any): Promise<void> } }) | null>;
    client(def: any): { state(i: any): Promise<any>; list(i: any): Promise<any> };
  };
  notify(level: "info" | "warn", msg: string): void;
  chatMessages(cb: (i: any, o: any) => Promise<unknown>): HostDisposer | null;
}

// 旧站依赖 try/catch 的形态：缺失 → rejected Promise（等价旧 TypeError 进入原 catch 链）
const missing = (what: string): Promise<never> =>
  Promise.reject(new TypeError(`[wf-host] ${what} unavailable`));

export function adaptHost(ctx: any): Host {
  return {
    get options() { return ctx?.options ?? {}; },
    get location() { return { directory: ctx?.location?.directory ?? undefined }; },
    sessions: {
      get: (q) => (ctx?.session?.get ? ctx.session.get(q) : missing("ctx.session.get")),
      wait: async (q) => ctx.session?.wait?.(q),
      prompt: (q) => (ctx?.session?.prompt ? ctx.session.prompt(q) : missing("ctx.session.prompt")),
      hook: async (name, cb) => (await ctx.session?.hook?.(name, cb)) ?? null,
    },
    instructions: {
      put: (q) => { const e = ctx?.session?.instructions?.entry; return e?.put ? e.put(q) : missing("instructions.entry.put"); },
      // list 缺失 → undefined capability 信号（非 reject：旧 wf:debug 以 !E?.list 分支报 "no entry API"）
      list: (q) => { const e = ctx?.session?.instructions?.entry; return e?.list ? e.list(q) : Promise.resolve(undefined); },
      remove: (q) => { const e = ctx?.session?.instructions?.entry; return e?.remove ? e.remove(q) : missing("instructions.entry.remove"); },
    },
    commands: { transform: (fn) => ctx.command.transform(fn) },
    tools: {
      transform: (fn) => ctx.tool.transform(fn),
      hook: (name, cb) => ctx.tool.hook(name, cb),
    },
    agents: { list: () => ctx.agent?.list?.() },
    models: { list: () => ctx.model?.list?.() },
    storage: { scan: (q) => ctx?.storage?.scan?.(q) },
    rpc: {
      // 缺失→null（rpc-bridge rpcErr="ctx.rpc 不可用" 记账判据逐字；present 时透传宿主返回原样，
      // 含 events.emit 通道——emitUpdated/emitReport 体在 bridge 零改动）
      register: (def, impl) => (ctx?.rpc?.register ? Promise.resolve(ctx.rpc.register(def, impl)) : Promise.resolve(null)),
      client: (def) => { const c = ctx.rpc(def); return { state: (i: any) => c.state(i), list: (i: any) => c.list(i) }; },
    },
    notify: (level, msg) => { try { ctx?.log?.[level]?.(msg); } catch (e) { swallow(e, "host:notify-fail"); } },
    // hint.ts 三形态探测收敛于此（真机 chat API 形状未定案，HOST-CONTRACT 已知边界保留）
    chatMessages: (cb) => {
      for (const [api, name] of [[ctx?.chat, "message"], [ctx?.chat, "chat.message"], [ctx?.session, "chat.message"]] as [any, string][]) {
        if (typeof api?.hook !== "function") continue;
        try { const reg = api.hook(name, cb); if (reg) return reg; } catch (e) { swallow(e, "host:chat-hook-register-fail"); }
      }
      return null;
    },
  };
}
