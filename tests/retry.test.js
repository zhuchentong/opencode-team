// M16-r39 T07（B2）：withStateRetry 归一三处重放（transition/lane/artifact 记账）。
// 纯 fake load/save/apply 单测：首试成功/冲突后成功/持续冲突恰 max 次/halt 不重试/gone/非 stale 不重试。
// 接线行为锚在 integration.test.js（T04 :303 新 intake 不误杀 gone、重试、回滚）+ flows/daily-mode/artifact。
import { test } from "node:test";
import assert from "node:assert/strict";
import { withStateRetry } from "../server/state.ts";

const st = (phase = "intake") => ({ sessionID: "ses_r", slug: "r", phase, rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, log: [] });

test("T07 首试成功：load→apply→save ok，返回 {ok:true,st}", async () => {
  const calls = [];
  const r = await withStateRetry({
    load: async (n) => { calls.push(`load${n}`); return st(); },
    apply: (s, n) => { calls.push(`apply${n}`); s.phase = "planning"; return null; },
    save: async () => { calls.push("save"); return { ok: true, rev: 2 }; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.st.phase, "planning", "返回 apply 后的 st");
  assert.deepEqual(calls, ["load1", "apply1", "save"]);
});

test("T07 冲突 2 次后成功：第 3 次尝试 ok，每 attempt 重 load+apply", async () => {
  let saves = 0;
  const loads = [];
  const r = await withStateRetry({
    load: async (n) => { loads.push(n); return st(); },
    apply: (s) => { s.phase = "planning"; return null; },
    save: async () => { saves++; return saves < 3 ? { ok: false, reason: "stale-rev" } : { ok: true, rev: 4 }; },
  });
  assert.equal(r.ok, true);
  assert.equal(saves, 3);
  assert.deepEqual(loads, [1, 2, 3], "每次尝试重新 load（最新快照重评估）");
});

test("T07 持续冲突：恰 3 次（缺省 maxAttempts）后失败 reason=stale-rev", async () => {
  let saves = 0;
  const r = await withStateRetry({
    load: async () => st(),
    apply: () => null,
    save: async () => { saves++; return { ok: false, reason: "stale-rev" }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale-rev");
  assert.equal(saves, 3, "恰 3 次不多试");
});

test("T07 halt：apply 返回串 → 不 save 不重试，msg 透传", async () => {
  let saves = 0;
  let loads = 0;
  const r = await withStateRetry({
    load: async () => { loads++; return st(); },
    apply: () => "❌ 拒绝理由",
    save: async () => { saves++; return { ok: true, rev: 1 }; },
  });
  assert.deepEqual(r, { ok: false, reason: "halt", msg: "❌ 拒绝理由" });
  assert.equal(saves, 0, "halt 不 save");
  assert.equal(loads, 1, "halt 不重试");
});

test("T07 gone：load null → {ok:false,reason:gone}，不 apply 不 save", async () => {
  let applied = 0;
  const r = await withStateRetry({
    load: async () => null,
    apply: () => { applied++; return null; },
    save: async () => ({ ok: true, rev: 1 }),
  });
  assert.deepEqual(r, { ok: false, reason: "gone" });
  assert.equal(applied, 0);
});

test("T07 非 stale 失败不重试：write-error 一次即返；maxAttempts 可覆盖", async () => {
  let saves = 0;
  const r = await withStateRetry({
    load: async () => st(),
    apply: () => null,
    save: async () => { saves++; return { ok: false, reason: "write-error" }; },
  });
  assert.deepEqual(r, { ok: false, reason: "write-error" });
  assert.equal(saves, 1, "非 stale-rev 不重试");
  // maxAttempts=2：持续冲突恰 2 次
  let n2 = 0;
  const r2 = await withStateRetry({
    load: async () => st(),
    apply: () => null,
    save: async () => { n2++; return { ok: false, reason: "stale-rev" }; },
    maxAttempts: 2,
  });
  assert.equal(r2.ok, false);
  assert.equal(n2, 2);
  // save 无 reason → 归一 write-error
  const r3 = await withStateRetry({
    load: async () => st(),
    apply: () => null,
    save: async () => ({ ok: false }),
  });
  assert.deepEqual(r3, { ok: false, reason: "write-error" });
});

test("T07 apply 支持异步（transition inject 在 apply 内）", async () => {
  const r = await withStateRetry({
    load: async () => st(),
    apply: async (s) => { await Promise.resolve(); s.phase = "review"; return null; },
    save: async () => ({ ok: true, rev: 2 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.st.phase, "review");
});

// ── verify 补充边界（M16-r39 testing）：重试中途行被并发清除 → gone ──
// plan 原例只测首次 load null；此处锁第 2 次 load null（stale-rev 后行被 reset）：
// 须立即 gone 终止，不得继续 apply/save 空转。
test("T07 边界：首次冲突后重载 null（并发 reset）→ gone 终止", async () => {
  let saves = 0; let applied = 0;
  const r = await withStateRetry({
    load: async (n) => (n === 1 ? st() : null),
    apply: () => { applied++; return null; },
    save: async () => { saves++; return { ok: false, reason: "stale-rev" }; },
  });
  assert.deepEqual(r, { ok: false, reason: "gone" });
  assert.equal(saves, 1, "仅首试 save");
  assert.equal(applied, 1, "第 2 次 load null 不得再 apply");
});