// tests/helpers/host-stub.js — 规范 Host 形 stub（T04 arch-r1-host-split）。
// 实现策略：先构造底层 ctx 原语（缺省表 + over 命名空间级浅合并），再经 adaptHost(ctx) 包装——
// 保证「stub 的降级/缺失/透传语义」与生产防腐层同源单一实现（LRN 形状漂移教训：mock 形状必须与
// server 真实消费同源）。返回的 Host 附非契约面：
//   _ctx：原始 ctx 视图（setup(ctx) 入口消费者的装配逃生门——入口签名是宿主契约不可改，装配同源）
//   notifications / _cmdDefs / _toolDefs：notify 与 transform 注册捕获数组
// 缺省表（plan §T04 冻结）：sessions.get→null、wait/prompt→resolved、hook→null、instructions.*→{}、
// commands/tools.transform→注册即回调 {dispose}、agents/models/storage→undefined（降级轨）、
// rpc.register→null、rpc.client→throwing stub、notify 记录、chatMessages→null、options:{}。
import { adaptHost } from "../../server/host.ts";

export function mkHostStub(over = {}) {
  const o = over ?? {};
  const notifications = [];
  const cmdDefs = [];
  const toolDefs = [];
  const sn = o.sessions ?? {};
  const ins = o.instructions ?? {};
  const cmd = o.commands ?? {};
  const tls = o.tools ?? {};
  const rpc = o.rpc ?? {};
  const asList = (v) => (v == null ? undefined : typeof v === "function" ? { list: v } : v); // agents/models：函数=list 或 {list}
  const ctx = {
    options: o.options ?? {},
    location: o.location ?? { directory: "/tmp/opencode" },
    session: {
      get: sn.get ?? (async () => null),
      wait: sn.wait ?? (async () => {}),
      prompt: sn.prompt ?? (async () => ({})),
      hook: sn.hook ?? (() => null), // 同步 null：兼保 chatMessages 缺省→null（Promise 恒真值会误命中）
      instructions: {
        entry: {
          put: ins.put ?? (async () => ({})),
          list: ins.list ?? (async () => ({})),
          remove: ins.remove ?? (async () => ({})),
        },
      },
    },
    command: {
      transform: cmd.transform ?? ((fn) => { fn({ add: (d) => cmdDefs.push(d), remove: () => {} }); return { dispose() {} }; }),
    },
    tool: {
      transform: tls.transform ?? ((fn) => { fn({ add: (d) => toolDefs.push(d), remove: () => {} }); return { dispose() {} }; }),
      hook: tls.hook ?? (() => ({ dispose() {} })),
    },
    // rpc：callable（client 通道）+ register 命名空间双形态（2.2.6 实测形状），缺省 client=throwing
    rpc: Object.assign(rpc.call ?? (() => { throw new TypeError("[stub] rpc client unavailable"); }), {
      register: rpc.register ?? (async () => null),
    }),
    log: o.log ?? {
      info: (m) => { notifications.push({ level: "info", msg: m }); },
      warn: (m) => { notifications.push({ level: "warn", msg: m }); },
    },
  };
  // 降级轨命名空间：缺省 undefined（不进 ctx 键）——agents.list/models.list/storage.scan 经 adaptHost 可选链→undefined
  const ag = asList(o.agents); if (ag) ctx.agent = ag;
  const md = asList(o.models); if (md) ctx.model = md;
  if (o.storage) ctx.storage = o.storage;
  if (o.chat) ctx.chat = o.chat;
  if (o.raw) Object.assign(ctx, o.raw); // 底层逃生（罕见形态；命名空间面已覆盖 16 文件全部旧装配）
  const host = adaptHost(ctx);
  host._ctx = ctx;
  host.notifications = notifications;
  host._cmdDefs = cmdDefs;
  host._toolDefs = toolDefs;
  return host;
}
