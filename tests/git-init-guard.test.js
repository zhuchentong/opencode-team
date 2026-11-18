// tests/git-init-guard.test.js — W13：git init 引号感知侦测纯函数直测（containsGitInit）。
// 主锚=评审 F-R6 误伤防线（`grep 'git init' plan.md`/`echo "git init 禁止"` 不得命中）与
// 用户敕令「全程不 init」机检口径（含命令替换/sh -c 包装/git -C 保守边界；残差见 HOST-CONTRACT W11 节）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { containsGitInit } from "../server/lib.ts";

test("W13 命中面：裸调/组合/旗标/命令替换/sh 包装均识别", () => {
  const hits = [
    "git init",
    "git init -b main",
    "cd /tmp/x && git init",
    "git -C /tmp/other init",
    "git --git-dir=x init",
    "$(git init)",
    "`git init`",
    'bash -c "git init"',
    "zsh -c 'git init'",
    "sh -c \"cd /tmp && git init && ls\"",
    "/usr/bin/git init",
    "mkdir -p p && cd p && git init",
  ];
  for (const cmd of hits) assert.equal(containsGitInit(cmd), true, `应命中：${cmd}`);
});

test("W13 误伤防线：引号字面量/非 git 命令/相近词不命中", () => {
  const misses = [
    "grep 'git init' plan.md",
    'echo "git init 禁止"',
    'git commit -m "init"',
    "git commit -m init",
    "git status",
    "git log --oneline",
    "gitinit",
    "xgit init",
    "echo git init",
    "ls; git status",
    "cat plan.md",
    "",
    null,
    42,
  ];
  for (const cmd of misses) assert.equal(containsGitInit(cmd), false, `不应命中：${String(cmd)}`);
});

test("W13 残差口径：变量间接不承诺命中（文档化接受，防模型漂移非人类攻击）", () => {
  assert.equal(containsGitInit("G=git; $G init"), false, "变量间接=已声明残差");
});
