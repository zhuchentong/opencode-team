// P3：自动激活提示 + 项目级角色定制覆盖——纯函数测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { isHintWorthy, HINT_ENTRY, HINT_TRIGGERS, guidance, entryValue } from "../server/lib.js";

test("isHintWorthy：中文/英文关键词命中", () => {
  assert.equal(isHintWorthy("我们走工作流开发这个功能"), true);
  assert.equal(isHintWorthy("按流程实现登录"), true);
  assert.equal(isHintWorthy("let's use the WF Workflow for this"), true); // 大小写不敏感
  assert.equal(isHintWorthy("superpowers style please"), true);
});

test("isHintWorthy：普通开发请求不误触", () => {
  assert.equal(isHintWorthy("修一下这个 bug"), false);
  assert.equal(isHintWorthy("帮我看看这段代码"), false);
  assert.equal(isHintWorthy(""), false);
  assert.equal(isHintWorthy(null), false);
  assert.equal(isHintWorthy(undefined), false);
});

test("HINT_ENTRY 指向 /wf:intake 且可忽略", () => {
  assert.match(HINT_ENTRY, /\/wf:intake/);
  assert.match(HINT_ENTRY, /忽略本提示/);
  assert.ok(HINT_TRIGGERS.length >= 5);
});

test("guidance：overrides 附加行（去 .md，列出角色名）", () => {
  const st = { slug: "d", rounds: {} };
  const g = guidance("planning", st, undefined, ["planner.md", "tester.md"]);
  assert.match(g, /📌 项目级角色定制（\.workflow\/overrides\/）：planner, tester/);
  assert.match(g, /把对应文件全文带入子任务提示词/);
  assert.match(g, /wf 工作流｜planning/); // 原文完整保留
});

test("guidance：overrides 空/缺省 → 无附加行（向后兼容）", () => {
  const st = { slug: "d", rounds: {} };
  assert.ok(!guidance("planning", st).includes("📌"));
  assert.ok(!guidance("planning", st, undefined, []).includes("📌"));
});

test("entryValue：overrides 透传；done 阶段不带", () => {
  const e = entryValue({ phase: "testing", slug: "d", rounds: {} }, undefined, ["builder.md"]);
  assert.match(e, /builder/);
  const done = entryValue({ phase: "done", slug: "d", rounds: {} }, undefined, ["builder.md"]);
  assert.ok(!done.includes("📌"), "done 只留一行提示");
});
