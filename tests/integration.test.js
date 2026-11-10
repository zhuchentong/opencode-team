// P1 集成：mock 插件上下文跑通 状态机→注入→阻断→诊断 全链路
// 覆盖单元测不到的胶水层：inject(entryValue 写 entry)、hook(logBlock 记账)、
// wf:diagnose（磁盘对账）、wf_write_artifact（目录回退与 verdict 记账）
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import plugin from "../server/index.js";

const DIR = "/tmp/opencode/wf-integ";

const mkCtx = (opts = {}) => {
  const store = new Map();
  const tools = [];
  const cmds = [];
  const entries = [];
  const removed = [];
  let hookFn = null;
  const ctx = {
    options: { probe: false, ...opts }, // 关探针避免写盘噪音
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
      scan: async () => ({ entries: [] }),
    },
    session: {
      get: async () => ({ projectID: "pi1", location: { directory: DIR } }),
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
  return { ctx, store, tools, cmds, entries, removed, hook: () => hookFn };
  };

const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");
const stOf = (m, sid = "ses_i") => m.store.get(`wf-workflow/state/${sid}`);

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(`${DIR}/src`, { recursive: true });

test("全链路：intake→plan 注入 guidance；planning 阶段阻断并记账；diagnose 取证；写产物；PASS 后 done 注入终态提示", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);

  // 1) intake：guidance 返回 + entry 注入含完整阶段指引
  const r1 = await cmd(m, "wf:intake").execute({ sessionID: "ses_i", prompt: { text: "demo" } });
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
    (e) => /硬关卡：阶段「planning」/.test(String(e.message)),
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

  // 4) wf:diagnose 报告含阻断取证与下一步
  const diag = await cmd(m, "wf:diagnose").execute({ sessionID: "ses_i", prompt: {} });
  assert.match(diag, /越权阻断=2/);
  assert.match(diag, /⛔ 越权阻断：shell src\/y\.txt|⛔ 越权阻断：shell src\/y\.js/);
  assert.match(diag, /下一步：\/wf:review/);

  // 5) 完整链到 done：test-plan → 审核链 → report PASS
  await cmd(m, "wf:review").execute({ sessionID: "ses_i", prompt: {} });
  assert.equal(stOf(m).phase, "review");
  // 未产出 test-plan 时 assign 被 gate 拒
  const rej = await cmd(m, "wf:assign").execute({ sessionID: "ses_i", prompt: {} });
  assert.match(rej, /双通道关卡未过/);
  // 工具写 test-plan 产物（目录三级回退：st.directory 已由 session.get 填充）
  const tr = await tool(m).execute({ kind: "test-plan", content: "# 计划" }, { sessionID: "ses_i", agent: "wf/tester" });
  assert.match(tr.content, /已写入 .*\/\.workflow\/demo\/test-plan\.md/);
  assert.ok(fs.existsSync(`${DIR}/.workflow/demo/test-plan.md`));
  await cmd(m, "wf:assign").execute({ sessionID: "ses_i", prompt: {} });
  for (const c of ["wf:test-design", "wf:build", "wf:reconcile", "wf:review-build", "wf:test"]) {
    await cmd(m, c).execute({ sessionID: "ses_i", prompt: {} });
  }
  // 无结论 report → done 被拒；PASS report → 通过
  await tool(m).execute({ kind: "test-report", content: "没有结论行" }, { sessionID: "ses_i", agent: "wf/tester" });
  assert.match(await cmd(m, "wf:done").execute({ sessionID: "ses_i", prompt: {} }), /验收关卡未过/);
  await tool(m).execute({ kind: "test-report", content: "**结论**: PASS\n全绿" }, { sessionID: "ses_i", agent: "wf/tester" });
  await cmd(m, "wf:done").execute({ sessionID: "ses_i", prompt: {} });
  assert.equal(stOf(m).phase, "done");

  // 6) done 的 entry 只留一行终态提示
  const last = m.entries.at(-1).value;
  assert.match(last, /phase=done/);
  assert.ok(!last.includes("禁止修改业务代码"), "done 不注入长 guidance");

  // 7) reset：状态清除 + entry 移除
  await cmd(m, "wf:reset").execute({ sessionID: "ses_i", prompt: {} });
  assert.equal(stOf(m), undefined);
  assert.deepEqual(m.removed.at(-1), { sessionID: "ses_i", key: "wf.phase" });

  dispose?.();
});

// P2：options.limits 端到端生效 + wf:ping（ctx.agent 存在/缺失两形态）
test("options.limits 覆盖端到端：plan_review=1 时第二轮 review 被拒", async () => {
  const m = mkCtx({ limits: { plan_review: 1 } });
  const dispose = await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: "ses_l", prompt: { text: "lim" } });
  await cmd(m, "wf:plan").execute({ sessionID: "ses_l", prompt: {} });
  const r1 = await cmd(m, "wf:review").execute({ sessionID: "ses_l", prompt: {} });
  assert.match(r1, /review（第 1\/1 轮）/, "guidance 显示覆盖后上限");
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
  m.ctx.agent = { list: async () => [{ name: "wf/planner", model: { providerID: "p", id: "m" } }] };
  await plugin.setup(m.ctx);
  const ping = await cmd(m, "wf:ping").execute({ sessionID: "ses_p", prompt: {} });
  assert.match(ping, /wf 角色：1\/7 已注册/);
  assert.match(ping, /⚠️ 缺失：.*wf\/tester/);

  const m2 = mkCtx();
  await plugin.setup(m2.ctx); // 无 agent API
  const ping2 = await cmd(m2, "wf:ping").execute({ sessionID: "ses_q", prompt: {} });
  assert.match(ping2, /宿主未提供 ctx\.agent API/);
});
