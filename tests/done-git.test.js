// done-git-delivery-confirm T01：done 流转 git 环境检测与交付确认提示（A1-A5，plan §验收逐字）
// 经 registerCommands + 内存 store mock 驱动 commands.ts 真实 transition（harness 形态与 flows.test.js 同源）；
// fs 临时目录造 .git 形态。tests/ 保持 .js：禁任何 TS 语法（ERR 教训）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { guidance } from "../server/guidance.ts"; // F4b：done 串行文案纯渲染断言（不经 transition）
import { mkWiringHarness as mkWiring } from "./helpers/wiring.js"; // T04：装配同源（harness 参数化包装）

const mkTmp = () => fs.mkdtempSync("/tmp/opencode/wf-done-git-");
const A1_OPT = "A1：有 remote → 选项=提交并推送/仅提交/跳过";

// kind: "remote"=.git 目录+config 含 remote；"noremote"=无 remote；"linked"=.git 文件+gitdir 指针；null=无 .git
const writeGit = (dir, kind) => {
  const remote = '[remote "origin"]\n\turl = https://example.com/r.git\n';
  if (kind === "remote" || kind === "noremote") {
    fs.mkdirSync(`${dir}/.git`, { recursive: true });
    fs.writeFileSync(`${dir}/.git/config`, kind === "remote" ? remote : "[core]\n\trepositoryformatversion = 0\n");
  } else if (kind === "linked") {
    const real = `${dir}/.real-git/worktrees/w1`;
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(`${real}/config`, remote);
    fs.writeFileSync(`${dir}/.git`, `gitdir: ${real}\n`);
  }
};

const mkHarness = (dir) => {
  // T04：装配收敛 helpers/wiring；puts=entry.put 值捕获（done 交付提示断言面），其余同旧内联 mock 等价
  const puts = [];
  const sid = "ses_donegit";
  return mkWiring({
    store: new Map(), sessionID: sid, dir,
    instructions: { put: async (q) => { puts.push(q.value); } },
  }).then((h) => ({ ...h, puts }));
};

// daily 链推进至 done 并返回 wf:done 输出文本（关卡前置经 patch 置账）
const toDone = async (h, slug) => {
  await h.run("wf:intake", slug);
  await h.run("wf:plan");
  await h.run("wf:review");
  h.patch({ planConfirmedAt: new Date().toISOString(), planReviewVerdict: "PASS" });
  await h.run("wf:build");
  await h.run("wf:test");
  h.patch({ testReportVerdict: "PASS" });
  return h.run("wf:done");
};

test("A1：.git 含 remote → done 输出交付确认三选项，doneGit 记账，entry 含提示", async () => {
  const dir = mkTmp(); writeGit(dir, "remote");
  const h = await mkHarness(dir);
  const out = await toDone(h, "git-a1");
  assert.match(out, /提交并推送\/仅提交\/跳过/, A1_OPT);
  assert.match(out, /question/, "A1：须指令 leader 用 question 询问");
  assert.deepEqual(h.st().delivery?.doneGit, { isGit: true, hasRemote: true }, "A1：记账形状"); // R3 T3.1 子步 D
  assert.match(h.puts[h.puts.length - 1], /交付确认/, "A1：done entry 抗 compaction 含提示");
  h.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

test("A2：.git 无 remote → 仅提交/跳过，隐藏推送", async () => {
  const dir = mkTmp(); writeGit(dir, "noremote");
  const h = await mkHarness(dir);
  const out = await toDone(h, "git-a2");
  assert.match(out, /仅提交\/跳过/, "A2：选项=仅提交/跳过");
  assert.doesNotMatch(out, /提交并推送/, "A2：无 remote 不得出现推送选项");
  assert.deepEqual(h.st().delivery?.doneGit, { isGit: true, hasRemote: false }, "A2：hasRemote=false");
  h.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

test("A3：无 .git → 零交付提示，done 行为与旧版一致", async () => {
  const dir = mkTmp();
  const h = await mkHarness(dir);
  const out = await toDone(h, "git-a3");
  assert.doesNotMatch(out, /交付确认/, "A3：非 git 项目不渲染");
  assert.equal(h.st().delivery?.doneGit, undefined, "A3：无记账");
  assert.doesNotMatch(h.puts[h.puts.length - 1], /交付确认/, "A3：entry 不含提示");
  h.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

test("A4：.git 为文件（linked worktree gitdir 指针）→ 解析 config 判 remote", async () => {
  const dir = mkTmp(); writeGit(dir, "linked");
  const h = await mkHarness(dir);
  const out = await toDone(h, "git-a4");
  assert.match(out, /提交并推送\/仅提交\/跳过/, "A4：指针 config 有 remote → 三选项");
  assert.deepEqual(h.st().delivery?.doneGit, { isGit: true, hasRemote: true }, "A4：linked 记账形状");
  h.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

// ── F4（用户报告竞态实证）：git 项目 done=「总结→提交/不提交→完成」串行 ──
test("F4：git 项目 done 文案串行——learner 回执门控交付确认+提交范围含经验文件；S 级同构；无记账零变化", async () => {
  const dir = mkTmp(); writeGit(dir, "remote");
  const h = await mkHarness(dir);
  const out = await toDone(h, "git-f4");
  assert.match(out, /总结 → 提交\/不提交 → 完成/, "F4：顺序固定并写入文案");
  assert.match(out, /提交范围=本任务代码\+\.learnings\//, "F4：经验文件随交付入库");
  assert.match(out, /确认前落盘，提交后不得再写|回执到齐前不得发起交付确认/, "F4：确认前经验全部落盘（防提交后复脏）");
  h.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});

// ── F4（用户报告竞态实证）：git 项目 done=「总结→提交/不提交→完成」串行 ──
test("F4b（full 模式同源）：git=回执门控交付确认；无记账=旧并行文案逐字", () => {
  const g = guidance("done", { slug: "x", phase: "done", rounds: {}, mode: "full", size: "M", delivery: { doneGit: { isGit: true, hasRemote: true } } }); // R3 T3.1 子步 D
  assert.match(g, /回执到齐前不得发起交付确认/, "full 模式也串行");
  assert.match(g, /总结→提交\/不提交→完成/, "顺序固定行内标注");
  const old = guidance("done", { slug: "x", phase: "done", rounds: {}, mode: "full", size: "M" });
  assert.match(old, /并行委派 wf\/learner 复盘沉淀（不阻塞交付）/, "无记账=旧文案零回归（残窗=检测 fail-open，接受）");
});

test("A5：done 后新任务 intake → doneGit 清除，不残留旧交付提示", async () => {
  const dir = mkTmp(); writeGit(dir, "remote");
  const h = await mkHarness(dir);
  await toDone(h, "git-a5");
  assert.deepEqual(h.st().delivery?.doneGit, { isGit: true, hasRemote: true }, "前置：旧任务已记账");
  await h.run("wf:intake", "git-a5-next");
  assert.equal(h.st().delivery?.doneGit, undefined, "A5：新任务清账（intake 重置块）");
  h.dispose(); fs.rmSync(dir, { recursive: true, force: true });
});
