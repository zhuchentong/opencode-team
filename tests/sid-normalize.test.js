// W6-r3（test_49 复盘）：sid 残渣值盲归一 + 子会话身份通用登记 + parentID 三级回退守卫测试。
// 事故链：intake 期 git init → opencode 项目身份漂移 → 子会话 projectID 全 miss → roleSessions
//   全程空 → guard-hook L243 静默放行 → "ses" 残渣直通宿主报错 ×6 且审计零痕迹。
// 覆盖：值盲归一（残渣×{无登记剥离, lane 语境拒绝}）/ 通用登记（bash-only 子会话首调即登记）/
//   漂移 fixture（projectID 不匹配 + parentID 链）/ 孤儿会话不误绑 / untracked 放行记账。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import plugin from "../server/index.ts";
import { mkHostStub } from "./helpers/host-stub.js";

const DIR = "/tmp/opencode/wf-sid-normalize";
const DB = `${DIR}/.workflow/wf.db`;
const LEADER = "ses_normLeader01";
const LANE_SID = "ses_normLane001";

// 条件化 sessions.get：leader=任务行同源身份；其余会话可按用例注入漂移身份/parentID
const mkCtx = (childShape) => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { } }
  fs.rmSync(`${DIR}/.opencode`, { recursive: true, force: true });
  fs.rmSync(`${DIR}/.workflow/_debug`, { recursive: true, force: true });
  const entries = [];
  let hookFn = null;
  const host = mkHostStub({
    options: { probe: false, requireIntakeConfirm: false },
    location: { directory: DIR },
    storage: { get: async () => null, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    sessions: { get: async (q) => {
      const sid = String(q?.sessionID ?? "");
      if (sid === LEADER) return { projectID: "pi1", agent: "wf/leader", location: { directory: DIR }, parentID: null };
      return childShape(sid);
    } },
    instructions: { put: async (i) => { entries.push(i); }, list: async () => entries },
    tools: { hook: (_ev, fn) => { hookFn = fn; return { dispose() {} }; } },
  });
  return { ctx: host.rawCtx, tools: host.toolDefs, cmds: host.cmdDefs, hook: () => hookFn };
};
const cmd = (m, name) => m.cmds.find((c) => c.name === name);
const stOf = (sid) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid); return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
const setup = async (childShape) => {
  const m = mkCtx(childShape); await plugin.setup(m.ctx);
  await cmd(m, "wf:intake").execute({ sessionID: LEADER, prompt: { text: "[S] normalize" } });
  await cmd(m, "wf:plan").execute({ sessionID: LEADER, prompt: {} }); // → planning
  return m;
};
const callSub = (m, input) => m.hook()({ tool: "subagent", sessionID: LEADER, agent: "workflow", input }, {});

// ── W6-2：残渣无登记（lanes 空）→ 剥离按新建 + session:normalize 记账 ──
test("W6-2：残渣无登记 → 剥离 args.sessionID 按新建 + normalize 记账（不再静默放行）", async () => {
  const m = await setup(() => ({ projectID: "piDRIFT", agent: "wf/builder", location: { directory: DIR }, parentID: null }));
  const input = { agent: "wf/builder", sessionID: "ses" };
  await callSub(m, input); // 不 throw 即剥离
  assert.equal("sessionID" in input ? input.sessionID : undefined, undefined, "sessionID 键应被删除（按省略新建处理）");
  const log = stOf(LEADER).log;
  const ev = log.find((e) => e.cmd === "session:normalize");
  assert.ok(ev, "必须有 session:normalize 记账");
  assert.equal(ev.note, "no-registry-stripped");
  assert.ok(!JSON.stringify(ev).includes("ses_norm"), "记账零回显（不含任何 sid）");
});

// ── W6-2：残渣无登记（lanes 非空）→ loud-fail 指路 @Tnn（防 lane 纪律外造会话）──
test("W6-2：lane 语境残渣 → loud-fail 指路 @Tnn + lane-context-reject 记账", async () => {
  const m = await setup((sid) => sid === LANE_SID
    ? { projectID: "pi1", agent: "wf/builder", location: { directory: DIR }, parentID: LEADER }
    : { projectID: "piDRIFT", agent: "wf/builder", location: { directory: DIR }, parentID: null });
  const lane = cmd(m, "wf:lane");
  const out = await lane.execute({ sessionID: LEADER, prompt: { text: `set T01 ${LANE_SID} /tmp/wf-sidnorm-wt --areas=T01` } });
  assert.ok(!String(out).startsWith("❌"), `lane 登记应成功：${out}`);
  await assert.rejects(
    () => callSub(m, { agent: "wf/builder", sessionID: "ses" }),
    (e) => String(e.message).includes("[wf-workflow]") && String(e.message).includes("@Tnn"),
  );
  const ev = stOf(LEADER).log.find((e) => e.cmd === "session:normalize");
  assert.ok(ev && ev.note === "lane-context-reject", "lane 语境拒绝必须记账");
});

// ── W6-1：通用登记——bash-only 子会话首个工具调用即登记（不依赖 wf_write_artifact/edit）──
test("W6-1：子会话 bash 调用（projectID 同源）→ roleSessions 即登记 + agent-key 探针落盘", async () => {
  const m = await setup(() => ({ projectID: "pi1", agent: "wf/builder", location: { directory: DIR }, parentID: LEADER }));
  await m.hook()({ tool: "bash", sessionID: "ses_normChildX", agent: "wf/builder", input: { command: "ls" } }, {});
  const rs = stOf(LEADER).reuse?.roleSessions;
  assert.equal(rs?.["wf/builder"]?.sessionID, "ses_normChildX", "首调 bash 即登记（生产端固化）");
  assert.ok(fs.existsSync(`${DIR}/.workflow/_debug/agent-key-probe.json`), "一次性形状取证落盘");
});

// ── W6-0：身份漂移 fixture（projectID 不匹配 + parentID 链）→ 三级回退命中仍登记 ──
test("W6-0：projectID 漂移（任务行 pi1 / 子会话 piDRIFT）+ parentID=leader → 回退命中登记", async () => {
  const m = await setup(() => ({ projectID: "piDRIFT", agent: "wf/planner", location: { directory: DIR }, parentID: LEADER }));
  await m.hook()({ tool: "bash", sessionID: "ses_normDriftP", agent: "wf/planner", input: { command: "ls" } }, {});
  assert.equal(stOf(LEADER).reuse?.roleSessions?.["wf/planner"]?.sessionID, "ses_normDriftP",
    "漂移子会话经 parentID 单跳回退命中 leader 任务行（test_49 事故形态修复）");
});

// ── W6-0：孤儿会话（漂移且无 parentID）→ 不误绑、不登记、不崩 ──
test("W6-0：孤儿会话（漂移 + 无 parentID）→ resolveState null，零登记零异常", async () => {
  const m = await setup(() => ({ projectID: "piDRIFT", agent: "wf/planner", location: { directory: DIR }, parentID: null }));
  await m.hook()({ tool: "bash", sessionID: "ses_normOrphan", agent: "wf/planner", input: { command: "ls" } }, {});
  assert.equal(stOf(LEADER).reuse?.roleSessions?.["wf/planner"], undefined, "不误绑（守卫次序：仅 wf/* 分支内回退）");
});

// ── W6-3：合法形状非登记非 lane → 放行宿主归属校验 + untracked 记账（既有决策不翻转）──
test("W6-3：合法形状无登记 → 放行不干预 + session:untracked 记账（审计盲区消除）", async () => {
  const m = await setup(() => ({ projectID: "piDRIFT", agent: "wf/builder", location: { directory: DIR }, parentID: null }));
  const input = { agent: "wf/builder", sessionID: "ses_normOther99" };
  await callSub(m, input); // 不 throw（放行宿主归属校验）
  assert.equal(input.sessionID, "ses_normOther99", "合法形状不被剥离");
  const ev = stOf(LEADER).log.find((e) => e.cmd === "session:untracked");
  assert.ok(ev && ev.note === "untracked-passthrough");
});

// ── 回归锚：有登记的残渣仍走前缀自愈（test_48 已证路径不受 W6-2 影响）──
test("回归：有登记的 'ses' 残渣 → 前缀自愈改写（原 T01 路径保持）", async () => {
  const m = await setup((sid) => sid === LEADER
    ? { projectID: "pi1", agent: "wf/leader", location: { directory: DIR }, parentID: null }
    : { projectID: "pi1", agent: "wf/planner", location: { directory: DIR }, parentID: LEADER });
  await cmd(m, "wf:intake").execute({ sessionID: LEADER, prompt: { text: "[S] guard" } });
  await cmd(m, "wf:plan").execute({ sessionID: LEADER, prompt: {} });
  await m.tools.find((t) => t.name === "wf_write_artifact").execute({ kind: "plan", content: "# plan\nT01" }, { sessionID: "ses_normRegP01", agent: "wf/planner" });
  const input = { agent: "wf/planner", sessionID: "ses" };
  await callSub(m, input);
  assert.equal(input.sessionID, "ses_normRegP01", "有登记残渣 → 前缀自愈（机制不变）");
});
