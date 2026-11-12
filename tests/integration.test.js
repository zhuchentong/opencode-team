// P1 集成：mock 插件上下文跑通 状态机→注入→阻断→诊断 全链路
// 覆盖单元测不到的胶水层：inject(entryValue 写 entry)、hook(logBlock 记账)、
// wf:diagnose（磁盘对账）、wf_write_artifact（目录回退与 verdict 记账）
// P1 重设计：状态持久化 = SQLite（.workflow/wf.db）——断言经只读连接读 tasks/reports 表
// （stOf/repOf），行为锚语义不变；ctx.storage mock 仅作一次性迁移源（scan 返回空 → no-op）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";

// 虚拟模块占位包自举（node_modules 在 .gitignore，克隆后首次运行需生成；语义与 harness 一致）
const mockDir = `${import.meta.dirname}/../node_modules/@opencode/plugin`;
if (!fs.existsSync(mockDir)) {
  fs.mkdirSync(mockDir, { recursive: true });
  fs.writeFileSync(`${mockDir}package.json`, JSON.stringify({
    name: "@opencode/plugin", version: "0.0.0-local-mock", private: true, type: "module",
    exports: { "./tui": "./mock-tui.js", "./rpc": "./mock-rpc.js" },
  }));
  fs.writeFileSync(`${mockDir}mock-tui.js`, "export const Plugin = { define: (def) => def };\n");
  fs.writeFileSync(`${mockDir}mock-rpc.js`, "export const Rpc = { define: (def) => def };\n");
}

const DIR = "/tmp/opencode/wf-integ";
const DB = `${DIR}/.workflow/wf.db`;

const mkCtx = (opts = {}) => {
  // 每个实例全新库：测试间零串扰（等价旧版 per-mkCtx 干净 Map）
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const store = new Map();
  const tools = [];
  const cmds = [];
  const entries = [];
  const removed = [];
  const prompts = []; // P2 降级轨：prompt(resume:false) 注入捕获
  const hooks = []; // P2 报告剥离 hook 注册捕获
  let hookFn = null;
  const ctx = {
    options: { probe: false, ...opts }, // 关探针避免写盘噪音
    location: { directory: DIR }, // P1：状态库路径按 location 解析
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
      scan: async () => ({ entries: [] }),
    },
    session: {
      get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: DIR } }),
      wait: async () => {}, // P2：降级轨排空等待（测试会话恒空闲）
      prompt: async (i) => { prompts.push(i); },
      hook: async (name, fn) => { hooks.push({ name, fn }); return { dispose() {} }; },
      instructions: {
        entry: {
          put: async (i) => { entries.push(i); },
          list: async () => entries,
          remove: async (i) => { removed.push(i); },
        },
      },
    },
    tool: {
      transform: (fn) => { fn({ add: (d) => tools.push(d), list: () => tools.map((t) => ({ name: t.name })) }); return { dispose() {} }; },
      hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; },
    },
    command: { transform: (fn) => { fn({ add: (d) => cmds.push(d) }); return { dispose() {} }; } },
  };
  return { ctx, store, tools, cmds, entries, removed, prompts, hooks, hook: () => hookFn, setChat: (api) => { ctx.chat = api; } };
  };

const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
// P1：断言从 SQLite 读（stOf 保留旧语义：无行 → undefined）
const dbGet = (sql, arg) => {
  const d = new Database(DB);
  try { return d.query(sql).get(arg ?? null); } catch { return null; } finally { try { d.close(); } catch { } }
};
const stOf = (m, sid = "ses_i") => {
  const row = dbGet("SELECT state_json FROM tasks WHERE session_id = ?", sid);
  if (!row) return undefined;
  try { return JSON.parse(row.state_json); } catch { return undefined; }
};
const repOf = (sid) => {
  const row = dbGet("SELECT session_id, text, at FROM reports WHERE session_id = ?", sid);
  return row ? { sessionID: row.session_id, text: row.text, at: row.at } : undefined;
};

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(`${DIR}/src`, { recursive: true });

test("全链路：intake→plan 注入 guidance；planning 阶段阻断并记账；diagnose 取证；写产物；PASS 后 done 注入终态提示", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);

  // 1) intake：guidance 返回 + entry 注入含完整阶段指引
  const r1 = await cmd(m, "wf:intake").execute({ sessionID: "ses_i", prompt: { text: "[FULL] demo" } }); // M16-r34：本测试验证完整流
  assert.match(r1, /【wf 工作流｜intake】slug=demo/);
  assert.equal(stOf(m).phase, "intake");
  assert.match(m.entries.at(-1).value, /phase=intake slug=demo/);

  // 2) plan → planning；entry 更新为 planning guidance（禁止改码约束在线）
  await cmd(m, "wf:plan").execute({ sessionID: "ses_i", prompt: {} });
  assert.equal(stOf(m).phase, "planning");
  assert.match(m.entries.at(-1).value, /禁止修改业务代码/, "guidance 进 entry（抗 compaction）");

  // 3) hook 阻断业务代码编辑并记账 gate:block
  await assert.rejects(
    () => m.hook()({ tool: "edit", sessionID: "ses_i", agent: "build", input: { path: `${DIR}/src/app.tsx` } }, {}),
    (e) => /硬关卡：阶段「planning」/.test(String(e.message)) && /下一步：\/wf:review/.test(String(e.message)),
  );
  const blocks = stOf(m).log.filter((e) => e.note === "blocked");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tool, "edit");
  assert.equal(blocks[0].detail, `${DIR}/src/app.tsx`);

  // 3b) shell 旁路同样阻断并记账
  await assert.rejects(
    () => m.hook()({ tool: "shell", sessionID: "ses_i", agent: "build", input: { command: "echo x > src/y.js", cwd: DIR } }, {}),
    (e) => /禁止经 shell 写入/.test(String(e.message)),
  );
  assert.equal(stOf(m).log.filter((e) => e.note === "blocked").length, 2);

  // 3c) 放行 .workflow 产物路径（相对形态）不抛
  await m.hook()({ tool: "write", sessionID: "ses_i", agent: "build", input: { path: `${DIR}/.workflow/demo/plan.md` } }, {});
  assert.equal(stOf(m).log.filter((e) => e.note === "blocked").length, 2, "放行路径不记账");

  // 3d) M16-r28 B1-1：项目外路径不构成越权 → 放行（真机实证 /tmp/opencode/ 验证脚本被误拦）
  await m.hook()({ tool: "write", sessionID: "ses_i", agent: "build", input: { path: "/tmp/opencode/verify-plan.mjs" } }, {});
  await m.hook()({ tool: "edit", sessionID: "ses_i", agent: "build", input: { path: "~/scratch.mjs" } }, {});
  assert.equal(stOf(m).log.filter((e) => e.note === "blocked").length, 2, "项目外写不阻断不记账");

  // 3e) 项目外路径不得成为旁路：项目内相对路径仍按 containment 拦截
  await assert.rejects(
    () => m.hook()({ tool: "write", sessionID: "ses_i", agent: "build", input: { path: "src/rel.ts" } }, {}),
    (e) => /硬关卡/.test(String(e.message)),
  );
  assert.equal(stOf(m).log.filter((e) => e.note === "blocked").length, 3);

  // 4) wf:diagnose 报告含阻断取证与下一步
  const diag = await cmd(m, "wf:diagnose").execute({ sessionID: "ses_i", prompt: {} });
  assert.match(diag, /越权阻断=3/);
  assert.match(diag, /⛔ 越权阻断：shell src\/y\.txt|⛔ 越权阻断：shell src\/y\.js/);
  assert.match(diag, /下一步：\/wf:review/);

  // 5) 完整链到 done：test-plan → 审核链 → report PASS
  await cmd(m, "wf:review").execute({ sessionID: "ses_i", prompt: {} });
  assert.equal(stOf(m).phase, "review");
  // 未产出 test-plan 时 wf:test-design 入口被双通道 gate 拒（M16-r28：关卡随 assign 并入迁移）
  const rej = await cmd(m, "wf:test-design").execute({ sessionID: "ses_i", prompt: {} });
  assert.match(rej, /双通道关卡未过/);
  // 工具写 test-plan 产物（目录三级回退：st.directory 已由 session.get 填充）
  const tr = await tool(m).execute({ kind: "test-plan", content: "# 计划" }, { sessionID: "ses_i", agent: "wf/tester" });
  assert.match(tr.content, /已写入 .*\/\.workflow\/demo\/test-plan\.md/);
  assert.ok(fs.existsSync(`${DIR}/.workflow/demo/test-plan.md`));
  await cmd(m, "wf:test-design").execute({ sessionID: "ses_i", prompt: {} });
  // M16-r44：wf:build 关卡须方案确认（leader question 观察记账；test_design 窗口）
  await m.hook()({ tool: "question", sessionID: "ses_i", agent: "workflow",
    input: { questions: [{ question: "方案确认", header: "方案确认", options: [{ label: "批准执行" }, { label: "修改方案" }, { label: "终止任务" }] }] } }, {});
  for (const c of ["wf:build", "wf:reconcile", "wf:review-build", "wf:test"]) {
    await cmd(m, c).execute({ sessionID: "ses_i", prompt: {} });
  }
  // 无结论 report → done 被拒；PASS report → 通过
  const trU = await tool(m).execute({ kind: "test-report", content: "没有结论行" }, { sessionID: "ses_i", agent: "wf/tester" });
  assert.match(trU.content, /→ 验收 UNKNOWN/); // P4 公告：tool output 指路下一步
  assert.match(await cmd(m, "wf:done").execute({ sessionID: "ses_i", prompt: {} }), /验收关卡未过/);
  const trP = await tool(m).execute({ kind: "test-report", content: "**结论**: PASS\n全绿" }, { sessionID: "ses_i", agent: "wf/tester" });
  assert.match(trP.content, /→ 验收 PASS/); // P4 公告
  await cmd(m, "wf:done").execute({ sessionID: "ses_i", prompt: {} });
  assert.equal(stOf(m).phase, "done");

  // 6) done 的 entry 只留一行终态提示
  const last = m.entries.at(-1).value;
  assert.match(last, /phase=done/);
  assert.ok(!last.includes("禁止修改业务代码"), "done 不注入长 guidance");

  // 7) reset：状态清除 + entry 移除
  await cmd(m, "wf:reset").execute({ sessionID: "ses_i", prompt: {} });
  assert.equal(stOf(m), undefined);
  assert.ok(m.removed.some((r) => r.sessionID === "ses_i" && r.key === "wf.phase"), "reset 清 phase");
  assert.ok(m.removed.some((r) => r.sessionID === "ses_i" && r.key === "wf.hint"), "reset 清 hint（P3 新增）");

  dispose?.();
});

// P2：options.limits 端到端生效 + wf:ping（ctx.agent 存在/缺失两形态）
test("options.limits 覆盖端到端：plan_review=1 时第二轮 review 被拒", async () => {
  const m = mkCtx({ limits: { plan_review: 1 } });
  const dispose = await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: "ses_l", prompt: { text: "[FULL] lim" } }); // M16-r34：完整流（review 格式断言）
  await cmd(m, "wf:plan").execute({ sessionID: "ses_l", prompt: {} });
  const r1 = await cmd(m, "wf:review").execute({ sessionID: "ses_l", prompt: {} });
  assert.match(r1, /【wf 工作流｜review】/, "review 标题（去轮次）");
  assert.match(r1, /第 1\/1 轮/, "guidance 显示覆盖后上限（轮次行在易变区尾部）");
  await cmd(m, "wf:plan").execute({ sessionID: "ses_l", prompt: {} });
  const r2 = await cmd(m, "wf:review").execute({ sessionID: "ses_l", prompt: {} });
  assert.match(r2, /plan_review 已 1\/1 轮/);
  assert.equal(stOf(m, "ses_l").phase, "planning", "拒绝不改阶段");
  const diag = await cmd(m, "wf:diagnose").execute({ sessionID: "ses_l", prompt: {} });
  assert.match(diag, /limit-exceeded ×1/);
  dispose?.();
});

test("wf:ping：ctx.agent.list 可用 → 注册表；缺失 → fail-soft 文案", async () => {
  const m = mkCtx();
  // mock 与 2.2.6 真机形状同源（{location,data}——曾因 mock 用裸数组掩盖 pingReport 不认 data 的 0/7 bug）
  m.ctx.agent = { list: async () => ({ location: { directory: "/p" }, data: [{ name: "wf/planner", model: { providerID: "p", id: "m" } }] }) };
  await plugin.setup(m.ctx);
  const ping = await cmd(m, "wf:ping").execute({ sessionID: "ses_p", prompt: {} });
  assert.match(ping, /wf 角色：1\/7 已注册/);
  assert.match(ping, /⚠️ 缺失：.*wf\/tester/);

  const m2 = mkCtx();
  await plugin.setup(m2.ctx); // 无 agent API
  const ping2 = await cmd(m2, "wf:ping").execute({ sessionID: "ses_q", prompt: {} });
  assert.match(ping2, /宿主未提供 ctx\.agent API/);
});

// ── P3：自动激活 hint + 项目级 overrides 端到端 ────────────────────
test("chat hook 命中工作流意图 → 注入一次性 wf.hint；有状态会话不打扰；reset 清双 key", async () => {
  const m = mkCtx();
  let chatFn = null;
  m.setChat({ hook: (name, fn) => { chatFn = fn; return { dispose() {} }; } });
  const dispose = await plugin.setup(m.ctx);
  assert.ok(chatFn, "ctx.chat.hook(\"message\") 应被注册");

  await chatFn({ sessionID: "ses_h" }, { parts: [{ text: "我们走工作流开发这个功能" }] });
  const hint = m.entries.filter((e) => e.key === "wf.hint" && e.sessionID === "ses_h");
  assert.equal(hint.length, 1);
  assert.match(hint[0].value, /\/wf:intake/);

  await chatFn({ sessionID: "ses_h" }, { parts: [{ text: "再提一次工作流" }] }); // 幂等
  assert.equal(m.entries.filter((e) => e.key === "wf.hint").length, 1);

  await chatFn({ sessionID: "ses_n" }, { parts: [{ text: "普通问题：这个函数干嘛的" }] }); // 不命中
  assert.equal(m.entries.filter((e) => e.sessionID === "ses_n").length, 0);

  await cmd(m, "wf:intake").execute({ sessionID: "ses_g", prompt: { text: "g" } });
  await chatFn({ sessionID: "ses_g" }, { parts: [{ text: "工作流" }] }); // 已有状态 → 不打扰
  assert.equal(m.entries.filter((e) => e.sessionID === "ses_g" && e.key === "wf.hint").length, 0);

  await cmd(m, "wf:reset").execute({ sessionID: "ses_g", prompt: {} });
  assert.ok(m.removed.some((r) => r.key === "wf.phase" && r.sessionID === "ses_g"));
  assert.ok(m.removed.some((r) => r.key === "wf.hint" && r.sessionID === "ses_g"), "reset 一并清 hint");
  dispose?.();
});

test("options.hint=false → 不注册 chat hook", async () => {
  const m = mkCtx({ hint: false });
  let called = false;
  m.setChat({ hook: () => { called = true; return { dispose() {} }; } });
  const dispose = await plugin.setup(m.ctx);
  assert.equal(called, false);
  dispose?.();
});

test("项目级 overrides：.workflow/overrides/*.md 存在 → entry guidance 附定制提示", async () => {
  fs.mkdirSync(`${DIR}/.workflow/overrides`, { recursive: true });
  fs.writeFileSync(`${DIR}/.workflow/overrides/planner.md`, "本项目 planner 必须先读 ARCHITECTURE.md");
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: "ses_o", prompt: { text: "ovr" } });
  const e = m.entries.find((x) => x.sessionID === "ses_o" && x.key === "wf.phase");
  assert.match(e.value, /📌 项目级角色定制（\.workflow\/overrides\/）：planner/);
  fs.rmSync(`${DIR}/.workflow/overrides`, { recursive: true, force: true });
  dispose?.();
});

// ── T02：幽灵行不落盘 ───────────────────────────────────────────────
// 旧缺陷：transition 拒绝分支对全新会话（load 为空）也 save → 凭空造出 {slug:"",phase:null}
// 行占住面板。修复后：无前置行的拒绝只回文案不建行；已有行的拒绝仍落审计。
test("T02 幽灵行：空会话误敲流转命令不建 DB 行；有行拒绝仍落审计", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const rej = await cmd(m, "wf:review").execute({ sessionID: "ses_ghost", prompt: {} });
  assert.match(rej, /不能从阶段/);
  assert.equal(stOf(m, "ses_ghost"), undefined, "无前置行被拒 → 不得建行");
  // 有行后拒绝：审计照常落盘
  await cmd(m, "wf:intake").execute({ sessionID: "ses_ghost", prompt: { text: "g" } });
  const rej2 = await cmd(m, "wf:done").execute({ sessionID: "ses_ghost", prompt: {} });
  assert.match(rej2, /不能从阶段「intake」进入「done」/);
  assert.ok(stOf(m, "ses_ghost").log.some((e) => e.ok === false), "已有行：拒绝审计落盘");
  dispose?.();
});

// ── T03：active 收紧 ────────────────────────────────────────────────
// 历史遗留幽灵行（直接写库模拟）：RPC state() 必须报 inactive，status/diagnose 报无任务，
// 让 TUI 面板走回退列表而非锁死垃圾行。
test("T03 幽灵行不占面板：state() active:false；status/diagnose 报无任务", async () => {
  const m = mkCtx();
  let rpcImpl = null;
  m.ctx.rpc = { register: async (_def, impl) => { rpcImpl = impl; return { events: { emit: async () => {} } }; } };
  const dispose = await plugin.setup(m.ctx);
  {
    const d = new Database(DB);
    d.run("INSERT INTO tasks (session_id, slug, phase, rev, state_json) VALUES ('ses_gh', '', NULL, 1, ?)",
      JSON.stringify({ sessionID: "ses_gh", slug: "", phase: null, rounds: {} }));
    d.close();
  }
  const res = await rpcImpl.state({ sessionID: "ses_gh" });
  assert.equal(res.active, false, "幽灵行 → inactive");
  assert.match(await cmd(m, "wf:status").execute({ sessionID: "ses_gh", prompt: {} }), /本会话无活动任务/);
  assert.match(await cmd(m, "wf:diagnose").execute({ sessionID: "ses_gh", prompt: {} }), /本会话无活动任务/);
  dispose?.();
});

// ── T04：save 冲突显式化 ────────────────────────────────────────────
// 乐观锁 stale-rev 旧版被静默吞掉（用户见成功 guidance 而 DB 未动）。修复：inject（save 前）
// 与 save 之间制造并发写——单次冲突自动重载重放成功；持续冲突显式报错且阶段不推进。
test("T04 stale-rev：冲突一次重试成功；持续冲突显式失败不假装推进", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: "ses_t4", prompt: { text: "[FULL] race" } }); // M16-r34：完整流（planning 格式断言）
  // inject 的 entry.put 执行后按需把 DB 行 rev 外部推进（state_json 同步，等价并发写者落盘）
  let bumps = 0;
  const realPut = m.ctx.session.instructions.entry.put;
  m.ctx.session.instructions.entry.put = async (i) => {
    await realPut(i);
    if (bumps <= 0) return;
    bumps--;
    const d = new Database(DB);
    try {
      const row = d.query("SELECT state_json, rev FROM tasks WHERE session_id = ?").get(i.sessionID);
      if (!row) return;
      const v = JSON.parse(row.state_json);
      v.rev = row.rev + 10; // 列与快照同步前进：当前写者快照即过期
      d.run("UPDATE tasks SET rev = ?, state_json = ? WHERE session_id = ?", v.rev, JSON.stringify(v), i.sessionID);
    } finally { try { d.close(); } catch { } }
  };
  // 单次冲突 → 第 2 次尝试重载成功
  bumps = 1;
  const okMsg = await cmd(m, "wf:plan").execute({ sessionID: "ses_t4", prompt: {} });
  assert.match(okMsg, /【wf 工作流｜planning】/, "stale-rev 一次应重试成功");
  assert.equal(stOf(m, "ses_t4").phase, "planning");
  // 持续冲突 → 显式失败，阶段保持不动
  bumps = 5;
  const failMsg = await cmd(m, "wf:review").execute({ sessionID: "ses_t4", prompt: {} });
  assert.match(failMsg, /状态保存失败（stale-rev）/);
  assert.equal(stOf(m, "ses_t4").phase, "planning", "保存失败不得假装推进");
  // T09：entry 回滚——失败后系统提示指引必须回到 DB 现势（phase=planning），
  // 而非已改写但未落库的目标阶段（transition 克隆化保证 loaded 未被污染）
  assert.match(m.entries.at(-1).value, /phase=planning slug=race/, "T09：save 失败后 entry 回滚到 DB 现势（head 已殿后）");
  dispose?.();
});

// ── T05：wf_command 工具（模型侧状态机入口）────────────────────────
test("T05 wf_command：leader 推进生效；无行非 intake 拒绝；子会话 intake 拒绝", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const tc = m.tools.find((t) => t.name === "wf_command");
  assert.ok(tc, "应注册 wf_command 工具");
  // M16-r30：冷启动铁律锚——真机实证「工具可见+描述提及 intake」不足以触发行为，
  // description 必须显式祈使「无任务+开发任务→第一步立即 intake」（与宿主 leader.md 同源）
  assert.match(tc.description, /冷启动铁律/, "description 应含冷启动铁律");
  assert.match(tc.description, /第一步立即调用 wf_command\(name="wf:intake", prompt="<slug>"\)/, "冷启动动作=立即 intake");
  assert.match(tc.description, /普通问答/, "防误触：普通问答/咨询不开任务");
  // 无行 + 非 intake → 拒绝
  assert.match((await tc.execute({ name: "wf:plan" }, { sessionID: "ses_w5", agent: "build" })).content,
    /本会话无活动任务/);
  // 子会话（wf/* 且非 leader）→ intake 也拒绝
  assert.match((await tc.execute({ name: "wf:intake", prompt: "子会话开的任务" }, { sessionID: "ses_sub", agent: "wf/planner" })).content,
    /子会话/);
  assert.equal(stOf(m, "ses_sub"), undefined, "被拒不得建行（T02 同语义）");
  // 主会话 intake → 建行并返回 guidance（Unicode slug 全链路，T01）
  const r = await tc.execute({ name: "wf:intake", prompt: "[FULL] 工具开任务" }, { sessionID: "ses_w5", agent: "build" }); // M16-r34：完整流（intake/planning 格式断言）
  assert.match(r.content, /【wf 工作流｜intake】/);
  assert.equal(stOf(m, "ses_w5").slug, "工具开任务");
  assert.equal(stOf(m, "ses_w5").phase, "intake");
  // 有行 → 流转推进
  const r2 = await tc.execute({ name: "wf:plan" }, { sessionID: "ses_w5", agent: "build" });
  assert.match(r2.content, /【wf 工作流｜planning】/);
  assert.equal(stOf(m, "ses_w5").phase, "planning");
  // 名字形状：前导斜杠剥离后照常执行（planning→planning 合法自环）
  const r3 = await tc.execute({ name: "/wf:plan" }, { sessionID: "ses_w5", agent: "build" });
  assert.match(r3.content, /【wf 工作流｜planning】/);
  // T11：无行时只读 wf:ping 放行（不触碰状态，子会话可自查角色注册）
  const ping = await tc.execute({ name: "wf:ping" }, { sessionID: "ses_sub2", agent: "wf/tester" });
  assert.match(ping.content, /宿主未提供 ctx\.agent|wf 角色/);
  assert.equal(stOf(m, "ses_sub2"), undefined, "ping 放行不建状态行");
  // 非 intake 拒绝文案含可操作指引（回报 leader / leader 主会话查状态）
  const rej5 = await tc.execute({ name: "wf:status" }, { sessionID: "ses_sub2", agent: "wf/tester" });
  assert.match(rej5.content, /leader/);
  dispose?.();
});

// 修复行为锚：命令字符串输出必须同时经 RPC "report" 事件广播（TUI toast 通道），
// 且 execute 返回值保留（本文件其余测试的断言依赖返回值）。
test("report 广播：命令输出经 RPC report 事件广播且返回值保留", async () => {
  const m = mkCtx();
  const emitted = [];
  let rpcImpl = null;
  m.ctx.rpc = { register: async (_def, impl) => { rpcImpl = impl; return { events: { emit: async (name, data) => { emitted.push({ name, data }); } } }; } };
  const dispose = await plugin.setup(m.ctx);
  const out = await cmd(m, "wf:ping").execute({ sessionID: "ses_rep" });
  assert.equal(typeof out, "string"); // 返回值保留（tests 行为锚）
  // P1 主通道：reports 表（TUI 轮询 state.lastReport 消费）
  const slot = repOf("ses_rep");
  assert.ok(slot, "应写 report 存储槽");
  assert.equal(slot.sessionID, "ses_rep"); // bug A 行为锚：槽必须含 sessionID（真机 toastReport 过滤器依赖，缺它 toast 全被拦）
  assert.equal(slot.text, out);
  assert.ok(typeof slot.at === "string" && slot.at.length >= 20, "槽含 ISO 时间戳");
  // 补充通道：report 事件（payload 与槽同 at，TUI 跨通道去重键）
  const rep = emitted.find((e) => e.name === "report");
  assert.ok(rep, "应广播 report 事件");
  assert.equal(rep.data.sessionID, "ses_rep");
  assert.equal(rep.data.text, out);
  assert.equal(rep.data.at, slot.at); // 事件与槽同 at → TUI 去重成立
  // ── P2 降级轨：server 命令通道同输出经 prompt(resume:false) 注入会话（Web/Desktop 可见）──
  const inj = m.prompts.find((p) => p.sessionID === "ses_rep" && p.metadata?.["wf.report"]?.cmd === "wf:ping");
  assert.ok(inj, "降级轨应注入会话报告");
  assert.equal(inj.resume, false, "resume:false 不唤醒模型（2.2.6 源码 session.ts:187）");
  assert.equal(inj.delivery, "steer");
  assert.equal(inj.text, out);
  assert.equal(inj.metadata["wf.report"].at, slot.at, "注入与 reports 表同 at");
  // 剥离 hook 全套注册（quota 范式）：context/compaction/generate/title（hint 的 chat.message 混存其中，取子集断言）
  for (const need of ["context", "compaction", "generate", "title"]) {
    assert.ok(m.hooks.some((h) => h.name === need), `应注册剥离 hook：${need}`);
  }
  const ev = { messages: [{ metadata: { "wf.report": { cmd: "x" } }, content: "r" }, { content: "u" }] };
  m.hooks.find((h) => h.name === "context").fn(ev);
  assert.equal(ev.messages.length, 1, "带 wf.report 标记的消息被剥离出上下文");
  // ── P2 主轨通道：RPC exec 跑同一编排拿返回值；publish 但不 inject（TUI 本地渲染）──
  const promptsBefore = m.prompts.length;
  const st = await rpcImpl.exec({ sessionID: "ses_rep", name: "wf:status", prompt: "" });
  assert.equal(typeof st.text, "string");
  assert.ok(st.text.length > 0, "exec 返回非空输出");
  assert.ok(typeof st.at === "string" && st.at.length >= 20, "exec 返回 at（去重键）");
  assert.equal(m.prompts.length, promptsBefore, "exec 通道不得注入聊天（本地渲染）");
  assert.equal(repOf("ses_rep").text, st.text, "exec 同样发布 reports（审计+轮询兜底）");
  assert.match((await rpcImpl.exec({ sessionID: "ses_rep", name: "wf:nope", prompt: "" })).text, /未知命令/);
  // wf:reset 清报告槽（防新挂载重放旧 toast）；reset 自身输出随后经 add 包装重新落 reports——
  // 与旧 storage 版语义等价（该行内容是「已清除」提示文本）
  await cmd(m, "wf:reset").execute({ sessionID: "ses_rep" });
  assert.equal(repOf("ses_rep").text, "wf 工作流：本会话状态已清除。可用 /wf:intake <slug> 重新开始。");
  dispose?.();
});

test("M16-r29 阶段纪律：planning 提前写 plan-review 告警不阻断；review 归位无告警；中途 !intake 重置账实不符告警", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_pd";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "pd" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} }); // → planning
  // 提前委派 reviewer：planning 阶段写 plan-review → 告警，但落盘/记账照常
  const early = await tool(m).execute({ kind: "plan-review", content: "# 审核" }, { sessionID: sid, agent: "wf/planner-reviewer" });
  assert.match(early.content, /已写入/);
  assert.match(early.content, /产物阶段错位/);
  assert.ok(stOf(m, sid).artifacts["plan-review-r1.md"], "告警不阻断记账");
  // 归位：review 阶段写 test-plan → 无错位告警
  await cmd(m, "wf:review").execute({ sessionID: sid, prompt: {} });
  const ok = await tool(m).execute({ kind: "test-plan", content: "# 用例" }, { sessionID: sid, agent: "wf/tester" });
  assert.match(ok.content, /已写入/);
  assert.ok(!/产物阶段错位/.test(ok.content), "review 阶段 test-plan 归位不告警");
  // 中途强制重置（review≠done 且有产物记账）→ 账实不符告警
  const reset = await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "!new-task" } });
  assert.match(reset, /强制重置已清空/);
  assert.match(reset, /账实不符/);
  assert.deepEqual(stOf(m, sid).artifacts, {}, "重置清空记账");
  // 对照组：中途重置但无产物记账 → 不告警（preArtifacts 为空）
  const m2 = mkCtx();
  const d2 = await plugin.setup(m2.ctx);
  await cmd(m2, "wf:intake").execute({ sessionID: "ses_pd2", prompt: { text: "a" } });
  await cmd(m2, "wf:plan").execute({ sessionID: "ses_pd2", prompt: {} }); // planning，未写任何产物
  const noArt = await cmd(m2, "wf:intake").execute({ sessionID: "ses_pd2", prompt: { text: "!b" } });
  assert.ok(!/强制重置已清空/.test(noArt), "无产物记账的中途重置不告警");
  dispose?.(); d2?.();
});

// ── T05（M16-r39 A5）：status 防御——历史脏数据 log 条目缺 at 不得 TypeError ──
test("T05 status 防御：log 条目缺 at → wf:status 正常返回含流转行", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: "ses_at", prompt: { text: "at-demo" } });
  // DB 直写：追加缺 at 的 log 条目（模拟历史脏数据）
  {
    const d = new Database(DB);
    const row = d.query("SELECT state_json FROM tasks WHERE session_id = 'ses_at'").get();
    const v = JSON.parse(row.state_json);
    v.log.push({ cmd: "wf:plan", from: "intake", to: "planning", ok: true }); // 无 at
    d.run("UPDATE tasks SET state_json = ? WHERE session_id = 'ses_at'", JSON.stringify(v));
    d.close();
  }
  const out = await cmd(m, "wf:status").execute({ sessionID: "ses_at", prompt: {} });
  assert.match(out, /最近流转/);
  assert.match(out, /wf:plan intake→planning/, "缺 at 条目仍渲染流转行");
  dispose?.();
});

// ── T09（M16-r39 B4）：sessProbe 收敛——5 candidates 探测改单一扁平 session.get ──
test("T09 wf:debug sessProbe：单一扁平形状 {ok:true,topKeys,location}，无旧 5 候选键", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: "ses_dbg", prompt: { text: "dbg" } });
  const out = await cmd(m, "wf:debug").execute({ sessionID: "ses_dbg", prompt: {} });
  assert.match(out, /\.workflow\/_debug\/state\.json$/, "返回落盘路径");
  const p = out.replace(/^wf 工作流状态已落盘：/, "");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(j.sessProbe.ok, true, "扁平单探针 ok");
  assert.ok(Array.isArray(j.sessProbe.topKeys), "topKeys 数组");
  assert.ok(j.sessProbe.topKeys.includes("location"), "mock session 形状同源");
  assert.deepEqual(j.sessProbe.location, { directory: DIR }, "location 提取（对象形状同源）");
  assert.ok(!("path-sessionID" in j.sessProbe), "旧 5 候选形状不得残留");
  assert.ok(!("flat-sessionID" in j.sessProbe), "旧标签键不得残留");
  dispose?.();
});

// ── T10（M16-r39 B5）：allowRegexps 逐条容错——非法跳过、合法并入 allowRes ──
test("T10 allowRegexps 容错：非法正则不抛 setup，合法正则并入放行判定", async () => {
  const m = mkCtx({ allowRegexps: ["[invalid", "\\.custom$"] });
  const dispose = await plugin.setup(m.ctx); // 旧实现：new RegExp("[invalid") SyntaxError
  assert.equal(m.cmds.length, 16, "命令注册齐全（10 流转 + 6 辅助）");
  assert.ok(m.tools.some((t) => t.name === "wf_write_artifact"), "工具注册齐全");
  // 合法正则生效：planning 阶段 .custom 后缀放行，业务代码仍阻断
  await cmd(m, "wf:intake").execute({ sessionID: "ses_re", prompt: { text: "re" } });
  await cmd(m, "wf:plan").execute({ sessionID: "ses_re", prompt: {} });
  await m.hook()({ tool: "write", sessionID: "ses_re", agent: "build", input: { path: `${DIR}/notes.custom` } }, {});
  await assert.rejects(
    () => m.hook()({ tool: "edit", sessionID: "ses_re", agent: "build", input: { path: `${DIR}/src/app.ts` } }, {}),
    (e) => /硬关卡/.test(String(e.message)),
  );
  dispose?.();
});

test("M16-r32 产物瘦身：超预算告警不阻断落盘/记账；预算内不告警", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  const sid = "ses_budget";
  await cmd(m, "wf:intake").execute({ sessionID: sid, prompt: { text: "budget" } });
  await cmd(m, "wf:plan").execute({ sessionID: sid, prompt: {} }); // → planning
  // 超预算 plan（>15KB）→ 告警，但落盘/记账照常
  const big = "x".repeat(16 * 1024);
  const over = await tool(m).execute({ kind: "plan", content: big }, { sessionID: sid, agent: "wf/planner" });
  assert.match(over.content, /已写入/);
  assert.match(over.content, /超瘦身预算/);
  assert.ok(stOf(m, sid).artifacts["plan.md"], "超预算告警不阻断记账");
  // 预算内 plan（覆盖重写，<15KB）→ 无体积告警
  const small = await tool(m).execute({ kind: "plan", content: "# 精简计划" }, { sessionID: sid, agent: "wf/planner" });
  assert.match(small.content, /已写入/);
  assert.ok(!/超瘦身预算/.test(small.content), "预算内不告警");
  dispose?.();
});
