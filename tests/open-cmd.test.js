// M16-r46 批2：wf:open 只读命令（产物预览降级轨——非 TUI 客户端/键盘路径）。
// 行为锚：无参列产物清单；有参读内容（白名单=artifacts 记账）；未记账拒绝；文件缺失友好文案；
// 只读豁免集收录（非 leader 可用——leader-only.test.js 同源语义）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js"; // T04：装配收敛（_ctx=setup(ctx) 消费者视图）
import { READONLY_CMDS } from "../server/lib.ts";

const DIR = "/tmp/opencode/wf-open";
const DB = `${DIR}/.workflow/wf.db`;

const mkCtx = () => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  const store = new Map();
  // T04：装配收敛 helpers/host-stub（tools/cmds=stub 注册捕获数组；po1/workflow 形状=sessions.get 覆盖）
  const host = mkHostStub({
    options: { probe: false },
    location: { directory: DIR },
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => { store.set(k, v); },
      remove: async (k) => { store.delete(k); },
      scan: async () => ({ entries: [] }),
    },
    sessions: { get: async () => ({ projectID: "po1", agent: "workflow", location: { directory: DIR } }) },
  });
  return { ctx: host._ctx, tools: host._toolDefs, cmds: host._cmdDefs };
};

const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const tool = (m) => m.tools.find((t) => t.name === "wf_write_artifact");

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(`${DIR}/src`, { recursive: true });

test("wf:open：清单/命中读取/未记账拒绝/账实不符友好文案", async () => {
  const m = mkCtx();
  const dispose = await plugin.setup(m.ctx);
  try {
    await cmd(m, "wf:intake").execute({ sessionID: "ses_o", prompt: { text: "opendl" } });
    await cmd(m, "wf:plan").execute({ sessionID: "ses_o", prompt: {} });
    await tool(m).execute({ kind: "plan", content: "# 计划正文\n\n要点一\n" }, { sessionID: "ses_o", agent: "workflow" });

    // 无参 → 列产物清单
    const r0 = await cmd(m, "wf:open").execute({ sessionID: "ses_o", prompt: { text: "" } });
    assert.match(r0, /plan\.md/, `清单应含 plan.md：${r0}`);

    // 有参命中 → 返回内容
    const r1 = await cmd(m, "wf:open").execute({ sessionID: "ses_o", prompt: { text: "plan.md" } });
    assert.match(r1, /# 计划正文/);

    // 未记账拒绝（含路径穿越形态）
    for (const bad of ["not-recorded.md", "../secret.txt"]) {
      const r2 = await cmd(m, "wf:open").execute({ sessionID: "ses_o", prompt: { text: bad } });
      assert.match(r2, /未记账/, `未记账应拒绝：${r2}`);
    }

    // 账实不符（文件被删）→ 友好文案不抛错
    fs.rmSync(`${DIR}/.workflow/opendl/plan.md`);
    const r3 = await cmd(m, "wf:open").execute({ sessionID: "ses_o", prompt: { text: "plan.md" } });
    assert.match(r3, /缺失/, `账实不符应友好：${r3}`);

    // 无活动任务
    const r4 = await cmd(m, "wf:open").execute({ sessionID: "ses_none", prompt: {} });
    assert.match(r4, /无活动任务/);
  } finally { dispose?.(); }
});

test("wf:open：只读豁免集收录（非 leader 可用）", () => {
  assert.ok(READONLY_CMDS.has("wf:open"), "READONLY_CMDS 应含 wf:open");
});
