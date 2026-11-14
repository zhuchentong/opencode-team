// T03（arch-r1-host-split）：Host 防腐层边界守卫。
// 规则（M1 裁决口径 = plan §0 audit 口径）：剥注释与字符串/模板字面量文本（${} 表达式=代码保留）后，
// `ctx.／ctx?.` 属性访问在 server/*.ts + shared/*.ts 的命中——白名单=**仅 server/host.ts**——期望 0。
// 附带 adaptHost 降级轨单测（残缺 ctx 构造零解引用；方法体缺失语义与旧裸戳点一致）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

// ── audit 口径剥离器（状态机：CODE/LINE/BLOCK/STRING/REGEX/TEMPLATE 栈，保行号）──
function stripCommentsStrings(src) {
  const stack = [{ t: "code", b: 0 }];
  let out = "", i = 0, prev = "";
  const n = src.length;
  const isRegexStart = () => !/[\w$)\]'"`]/.test(prev);
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i], d = src[i + 1];
    if (top.t === "code") {
      if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && d === "*") {
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i++; }
        i += 2; continue;
      }
      if (c === '"' || c === "'") {
        i++;
        while (i < n && src[i] !== c) { if (src[i] === "\\") { if (src[i + 1] === "\n") out += "\n"; i += 2; continue; } i++; }
        i++; prev = c; continue;
      }
      if (c === "`") { stack.push({ t: "tpl" }); i++; prev = c; continue; }
      if (c === "/" && isRegexStart()) {
        i++; let inCls = false;
        while (i < n) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") inCls = true;
          else if (src[i] === "]") inCls = false;
          else if (src[i] === "/" && !inCls) break;
          else if (src[i] === "\n") break;
          i++;
        }
        i++; while (i < n && /[a-z]/.test(src[i])) i++;
        prev = "/"; continue;
      }
      if (c === "{") { top.b++; out += c; i++; prev = c; continue; }
      if (c === "}") {
        if (top.b === 0 && stack.length > 1 && stack[stack.length - 2].t === "tpl") { stack.pop(); i++; prev = "}"; continue; }
        if (top.b > 0) top.b--;
        out += c; i++; prev = c; continue;
      }
      out += c; if (!/\s/.test(c)) prev = c; i++; continue;
    }
    if (top.t === "tpl") {
      if (c === "\\") { if (src[i + 1] === "\n") out += "\n"; i += 2; continue; }
      if (c === "`") { stack.pop(); i++; prev = "`"; continue; }
      if (c === "$" && d === "{") { stack.push({ t: "code", b: 0 }); i += 2; prev = "{"; continue; }
      if (c === "\n") out += "\n";
      i++; continue;
    }
  }
  return out;
}
function ctxHits(src) {
  const hits = [];
  stripCommentsStrings(src).split("\n").forEach((l, idx) => {
    [...l.matchAll(/(?:^|[^\w$.])ctx\s*\??\.\s*[a-zA-Z(]/g)].forEach(() => hits.push(idx + 1));
  });
  return hits;
}

const WHITELIST = "host.ts"; // 全仓唯一允许 ctx.<prop> 裸戳处

test("T03 host.ts 在位且确为 ctx 收敛点", () => {
  assert.ok(fs.existsSync(new URL(`../server/${WHITELIST}`, import.meta.url)), "server/host.ts 必须存在");
  const hits = ctxHits(fs.readFileSync(new URL(`../server/${WHITELIST}`, import.meta.url), "utf8"));
  assert.ok(hits.length > 0, "host.ts 应含 ctx 访问（否则防腐层空转）");
});

test("T03 audit 口径：非 host.ts 的 server/*.ts 与 shared/*.ts ctx. 直戳 = 0", () => {
  const dirs = [["server", "../server/"], ["shared", "../shared/"]];
  const report = [];
  for (const [name, u] of dirs) {
    for (const f of fs.readdirSync(new URL(u, import.meta.url)).filter((x) => x.endsWith(".ts"))) {
      if (name === "server" && f === WHITELIST) continue;
      const hits = ctxHits(fs.readFileSync(new URL(`${u}${f}`, import.meta.url), "utf8"));
      if (hits.length) report.push(`${name}/${f}:${hits.join(",")}`);
    }
  }
  assert.deepEqual(report, [], `ctx. 直戳残留（白名单仅 host.ts）：${report.join(" | ")}`);
});

test("T03 adaptHost：残缺 ctx 构造零解引用；降级轨语义（缺失→undefined/null/静默）", async () => {
  const { adaptHost } = await import("../server/host.ts");
  const host = adaptHost({});
  assert.deepEqual(host.options, {}, "options 缺省 {}（活读）");
  assert.equal(host.location.directory, undefined, "location 缺省 undefined");
  assert.equal(await host.sessions.wait({ sessionID: "s" }), undefined, "wait 缺失→resolved");
  assert.equal(await host.sessions.hook("x", () => {}), null, "session.hook 缺失→null");
  assert.equal(await host.instructions.list({ sessionID: "s" }), undefined, "entry.list 缺失→undefined（capability 信号）");
  assert.equal(await host.agents.list(), undefined, "agent.list 缺失→undefined（ping 降级轨）");
  assert.equal(await host.models.list(), undefined, "model.list 缺失→undefined");
  assert.equal(await host.storage.scan({ prefix: "p" }), undefined, "storage.scan 缺失→undefined");
  assert.equal(await host.rpc.register({}, {}), null, "rpc.register 缺失→null（rpcErr 记账素材）");
  assert.equal(host.chatMessages(async () => {}), null, "chatMessages 无任何形态→null");
  assert.doesNotThrow(() => host.notify("info", "x"), "notify 缺失静默（内部 swallow）");
  await assert.rejects(() => host.sessions.get({ sessionID: "s" }), "get 缺失=rejected（旧 try/catch 站语义）");
  await assert.rejects(() => host.instructions.put({ sessionID: "s", key: "k", value: "v" }), "put 缺失=rejected（entryErr 记账链保持）");
  await assert.rejects(() => host.instructions.remove({ sessionID: "s", key: "k" }), "remove 缺失=rejected（swallow 站语义）");

  // 透传完整性：present ctx 各面原样到达
  const calls = [];
  const full = {
    options: { a: 1 }, location: { directory: "/d" },
    session: {
      get: (q) => { calls.push(["get", q]); return { agent: "workflow" }; },
      wait: (q) => calls.push(["wait", q]),
      prompt: (q) => calls.push(["prompt", q]),
      hook: (n, _cb) => { calls.push(["hook", n]); return { dispose() {} }; },
      instructions: { entry: { put: (q) => calls.push(["put", q]), list: (q) => { calls.push(["list", q]); return ["E"]; }, remove: (q) => calls.push(["rem", q]) } },
    },
    command: { transform: (_fn) => { calls.push(["cmdT"]); return { dispose() {} }; } },
    tool: { transform: (_fn) => { calls.push(["toolT"]); return { dispose() {} }; }, hook: (n, _cb) => { calls.push(["toolH", n]); return { dispose() {} }; } },
    agent: { list: () => { calls.push(["agentL"]); return []; } },
    model: { list: () => { calls.push(["modelL"]); return []; } },
    storage: { scan: (q) => { calls.push(["scan", q]); return []; } },
    rpc: Object.assign((_def) => { calls.push(["rpcCall"]); return { state: async (_i) => "S", list: async (_i) => "L" }; }, { register: async (_def, _impl) => { calls.push(["rpcReg"]); return { events: { emit: async () => {} }, dispose() {} }; } }),
    log: { info: (m) => calls.push(["log", "info", m]), warn: (m) => calls.push(["log", "warn", m]) },
    chat: { hook: (n, _cb) => { calls.push(["chatH", n]); return { dispose() {} }; } },
  };
  const h = adaptHost(full);
  assert.equal((await h.sessions.get({ sessionID: "s1" })).agent, "workflow");
  assert.deepEqual(await h.instructions.list({ sessionID: "s1" }), ["E"]);
  assert.equal(await h.agents.list() && "ok", "ok");
  assert.equal(await h.storage.scan({ prefix: "p" }) && "ok", "ok");
  const reg = await h.rpc.register({}, {});
  assert.equal(typeof reg.events.emit, "function", "register 返回值携 events.emit（rpc-bridge 通道）");
  assert.equal(await h.rpc.client({}).state({}), "S");
  h.notify("warn", "wmsg");
  assert.equal(h.chatMessages(async () => {})?.dispose && "ok", "ok", "chatMessages 首选形态命中 ctx.chat.message");
  assert.deepEqual(calls.filter((c) => c[0] === "chatH"), [["chatH", "message"]], "三形态按序探测取首个");
  const logCalls = calls.filter((c) => c[0] === "log");
  assert.deepEqual(logCalls, [["log", "warn", "wmsg"]], "notify 映射 ctx.log[level]");
});

test("T03 adaptHost：options/location 活读（setup 后覆写即时可见——selfModRoot 同模式）", async () => {
  const { adaptHost } = await import("../server/host.ts");
  const ctx = { options: { leaderOnly: true } };
  const host = adaptHost(ctx);
  assert.equal(host.options.leaderOnly, true);
  ctx.options = { leaderOnly: false }; // 整体替换（热载/测试 patch 形态）
  assert.equal(host.options.leaderOnly, false, "活读：options 替换后立见");
  ctx.location = { directory: "/x" };
  assert.equal(host.location.directory, "/x", "活读：location 后设立见");
});
