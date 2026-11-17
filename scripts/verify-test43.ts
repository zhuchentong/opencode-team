// verify-test43 — opt-agentic 本轮改动端到端验证（真机文件系统级，M 级任务全流程）
// 验证面：①serial-dispatch 文案（M 派发策略含「勿逐 T 新建委派」）②tier inject-only 零项目目录落地
// ③tier:inject 派发时 args.model 注入 ④markVerdicts 口径（大写 Lane 分组表经 wf:build 关卡）
// ⑤builder-recreate 观察灯 ⑥wf:ping 只读化（verified 即时视图，零落库）⑦tier-timing.jsonl 探针
// 运行：WF_DEBUG=1 bun scripts/verify-test43.ts   （项目目录=/home/zhuchentong/Projects/test-space/test_43）
import * as fs from "node:fs";
import { Database } from "bun:sqlite";

process.env.WF_DEBUG = "1"; // 必须先于动态 import（commands.reportProbe 为模块级常量活读例外，middleware tierProbeOn 为活读）
const { mkHostStub } = await import("../tests/helpers/host-stub.js");
const { default: plugin } = await import("../server/index.ts");
const { guidance } = await import("../server/guidance.ts");

const DIR = "/home/zhuchentong/Projects/test-space/test_43";
const DB = `${DIR}/.workflow/wf.db`;
const LEADER = "ses_lead43";
let pass = 0, fail = 0;
const ok = (cond: unknown, label: string) => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}`); }
};

// ── 环境复位 ──
for (const f of [DB, `${DB}-wal`, `${DB}-shm`, `${DIR}/.workflow/.gitignore`]) { try { fs.rmSync(f, { force: true }); } catch { } }
fs.rmSync(`${DIR}/.opencode`, { recursive: true, force: true });
fs.rmSync(`${DIR}/.workflow/_debug`, { recursive: true, force: true });

// ── Host stub（形状对齐 session-guard mkCtx；sessions.get 按会话区分 leader/子会话）──
const entries: any[] = [];
let hookFn: any = null;
const host = mkHostStub({
  options: { probe: false, requireIntakeConfirm: false }, // 不设 tierAgents = 新默认 inject-only
  location: { directory: DIR },
  storage: { get: async () => null, set: async () => { }, remove: async () => { }, scan: async () => ({ entries: [] }) },
  sessions: {
    get: async ({ sessionID }: any) => sessionID === LEADER
      ? { projectID: "p43", agent: "workflow", location: { directory: DIR }, model: { providerID: "prov", id: "m1" } }
      : { projectID: "p43", location: { directory: DIR } },
  },
  models: { list: async () => [{ id: "m1", providerID: "prov", variants: [{ id: "low" }, { id: "high" }] }] },
  instructions: { put: async (i: any) => { entries.push(i); }, list: async () => entries },
  tools: { hook: (_ev: any, fn: any) => { hookFn = fn; return { dispose() { } }; } },
  agents: async () => [{ name: "wf/planner" }, { name: "wf/builder" }], // ping 需 agents.list（缺省 undefined=降级轨）
});
await plugin.setup((host as any).rawCtx);
const m = { ctx: (host as any).rawCtx, tools: (host as any).toolDefs, cmds: (host as any).cmdDefs, hook: () => hookFn };
const cmd = (name: string) => m.cmds.find((c: any) => c.name === name);
const artifactTool = m.tools.find((t: any) => t.name === "wf_write_artifact");
const stOf = (sid = LEADER) => {
  const d = new Database(DB);
  try { const row = d.query("SELECT state_json FROM tasks WHERE session_id = ?").get(sid) as any; return row ? JSON.parse(row.state_json) : undefined; }
  finally { try { d.close(); } catch { } }
};
const callSub = (input: any) => m.hook()({ tool: "subagent", sessionID: LEADER, agent: "workflow", input }, {});

console.log("\n━━ ① serial-dispatch 文案（M 派发策略）━━");
const g = guidance("building", { mode: "daily", size: "M", rounds: {}, log: [], artifacts: {} } as any);
ok(g.includes("一次委派串行到底"), "M 文本保留「一次委派串行到底」");
ok(g.includes("勿逐 T 新建委派"), "M 文本新增「勿逐 T 新建委派」（serial-dispatch-fix）");
const gl = guidance("building", { mode: "daily", size: "L", rounds: {}, log: [], artifacts: {} } as any);
ok(gl.includes("单树串行：单 wf/builder 一次委派完成全部 T<nn>"), "L 文本串行形态唯一化");
ok(gl.includes("逐 T 新建委派=错误形态"), "L 文本明文禁止逐 T 新建");

console.log("\n━━ ② M 级任务流转：intake → plan → review ━━");
let out = await cmd("wf:intake").execute({ sessionID: LEADER, prompt: { text: "[M] test-43 M级验证任务" } });
ok(!String(out).startsWith("❌"), "wf:intake 开任务（daily 默认，M 级）");
ok(stOf().mode === "daily" && stOf().size === "M", "mode=daily size=M");
out = await cmd("wf:plan").execute({ sessionID: LEADER, prompt: {} });
ok(!String(out).startsWith("❌"), "wf:plan → planning");
// plan 含大写「Lane 分组表」（r55 口径 + markVerdicts 路径验证）
out = await artifactTool.execute({ kind: "plan", content: "# 计划\n\n## Lane 分组表\n\n| lane | areas |\n|---|---|\n| T01 | src/a |\n| T02 | src/b |\n" }, { sessionID: "ses_planner43", agent: "wf/planner" });
ok(stOf().verdicts?.laneTableWritten === true, "markVerdicts：大写「Lane 分组表」记账 true（口径统一）");
ok(!!stOf().artifacts?.["plan.md"]?.hash, "artifacts 补 hash（记账单点）");
out = await cmd("wf:review").execute({ sessionID: LEADER, prompt: {} });
ok(!String(out).startsWith("❌"), "wf:review → review");
out = await artifactTool.execute({ kind: "plan-review", content: "**结论**: PASS\n\n五维过。\n" }, { sessionID: "ses_rev43", agent: "wf/planner-reviewer" });
ok(stOf().verdicts?.planReview === "PASS", "plan-review PASS 记账");

console.log("\n━━ ③ 方案确认（question 观测）→ wf:build 关卡 ━━");
await m.hook()({ tool: "question", sessionID: LEADER, agent: "workflow", input: { questions: [{ options: [{ label: "批准执行" }] }] } }, {});
ok(!!stOf().verdicts?.confirmedAt, "question 观测记账 confirmedAt（M16-r44）");
out = await cmd("wf:build").execute({ sessionID: LEADER, prompt: {} });
ok(!String(out).startsWith("❌"), "wf:build 过 daily-build 三要素关卡（确认+lane 表+review PASS）");
ok(stOf().phase === "building", "phase=building");

console.log("\n━━ ④ tier inject-only：派发时注入 + 零项目目录落地 ━━");
const input: any = { agent: "wf/builder" };
await callSub(input); // 新建委派（省略 sessionID）
ok(input.model === "prov/m1#low", `派发时注入 args.model=${input.model}（builder=low，TIER_MAP）`);
ok(stOf().log.some((l: any) => l.cmd === "tier:inject" && l.note.includes("wf/builder")), "tier:inject 审计落盘");
ok(!fs.existsSync(`${DIR}/.opencode`), "★ inject-only 零项目目录落地（.opencode 未生成——用户需求核心断言）");
ok(stOf().reuse?.tierBase?.id === "m1", "tierBase 登记照常（tierCheck inject 分支）");
// 复测：wf:lane set + 二次流转后仍零落地
await cmd("wf:lane").execute({ sessionID: LEADER, prompt: { text: `set T01 ses_b43 /tmp/wf43-lane-t01 --areas=T01` } });
await cmd("wf:test").execute({ sessionID: LEADER, prompt: {} });
ok(!fs.existsSync(`${DIR}/.opencode`), "多次流转后仍零落地（files 模式会写 7 文件，inject 恒零）");

console.log("\n━━ ⑤ builder-recreate 观察灯 ━━");
await artifactTool.execute({ kind: "plan", content: "# p" }, { sessionID: "ses_b43", agent: "wf/builder" }); // 登记 builder 子会话
await callSub({ agent: "wf/builder" }); // 已登记却新建
const lamp = stOf().log.filter((l: any) => l.cmd === "deleg:observe").at(-1);
ok(/builder-recreate/.test(lamp?.note ?? ""), "已登记新建 → 观察灯记 builder-recreate");
ok(!String(lamp?.note).includes("ses_"), "灯 note 零回显");
await callSub({ agent: "wf/builder", sessionID: "ses_b43" }); // 显式续用
const lamp2 = stOf().log.filter((l: any) => l.cmd === "deleg:observe").at(-1);
ok(!/builder-recreate/.test(lamp2?.note ?? ""), "显式续用 → 不记");

console.log("\n━━ ⑥ wf:ping 只读化 + 活算视图 ━━");
const reuseBefore = JSON.stringify(stOf().reuse);
out = await cmd("wf:ping").execute({ sessionID: LEADER, prompt: {} });
out = (out as any).content ?? out; // artifact 工具返回 {content}
ok(String(out).includes("活算") && String(out).includes("wf/builder=prov/m1#low"), "ping 档位视图走 tierBase 活算（无文件）");
ok(String(m.cmds.find((c: any) => c.name === "wf:ping").description).includes("即时视图不落库"), "ping description 声明只读语义");
ok(JSON.stringify(stOf().reuse) === reuseBefore, "ping 零写路径（reuse 快照不变——项②回归锚）");
ok(String(out).includes("角色托管"), "角色托管行在（roles 同步状态）");

console.log("\n━━ ⑦ WF_DEBUG=1 探针（tier-timing.jsonl）━━");
const timingPath = `${DIR}/.workflow/_debug/tier-timing.jsonl`;
ok(fs.existsSync(timingPath), "tier-timing.jsonl 已落盘（middleware 耗时探针）");
if (fs.existsSync(timingPath)) {
  const rows = fs.readFileSync(timingPath, "utf8").trim().split("\n").map((l: string) => JSON.parse(l));
  const last = rows.at(-1);
  ok(typeof last?.msTotal === "number" && /^wf:(plan|review|build|test|done|intake)$/.test(last?.cmd ?? ""), `分步耗时记录 msTotal=${last?.msTotal}ms cmd=${last?.cmd}（最后一条流转命令）`);
  ok(rows.every((r: any) => !JSON.stringify(r).includes("ses_")), "探针零回显");
}

console.log("\n━━ ⑧ 收尾：test-report PASS → wf:done 验收 ━━");
await cmd("wf:build").execute({ sessionID: LEADER, prompt: {} }); // testing→fixing 无；直接回 building？wf:test from testing…当前 testing → wf:fix 需 FAIL；直接 wf:build from testing? FLOWS_DAILY wf:build from ["review"]——testing 不合法；用 wf:test 重入 testing
out = await cmd("wf:test").execute({ sessionID: LEADER, prompt: {} });
ok(!String(out).startsWith("❌"), "wf:test → testing");
out = await artifactTool.execute({ kind: "test-report", content: "**结论**: PASS\n\n全绿。\n" }, { sessionID: "ses_b43", agent: "wf/builder" });
ok(String((out as any).content ?? out).includes("wf:done"), "verdict 指路：PASS → wf:done");
out = await cmd("wf:done").execute({ sessionID: LEADER, prompt: {} });
ok(!String(out).startsWith("❌") && stOf().phase === "done", "wf:done 验收通过（acceptance 关卡 PASS）");

console.log("\n━━ ⑨ 落盘形态核验 ━━");
ok(fs.existsSync(DB), "wf.db 已落库（真实 SQLite）");
ok(fs.existsSync(`${DIR}/.workflow/.gitignore`), ".workflow/.gitignore 自动写入");
const flowCmds = stOf().log.filter((l: any) => l.ok !== false && ["wf:intake", "wf:plan", "wf:review", "wf:build", "wf:test", "wf:done"].includes(l.cmd));
ok(flowCmds.length >= 6, `流转轨迹完整（${flowCmds.length} 条 ok 流转）`);

console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n结果：${pass} pass / ${fail} fail（项目目录=${DIR}）`);
if (fail > 0) process.exit(1);
