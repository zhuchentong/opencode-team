---
name: Codemod
description: >
  pattern 化批量代码改写时必须使用。触发场景：用 ast-grep/codemod 脚本做批量
  替换/重构前；准备对同一 pattern 多文件 apply 时；dryRun report 出来后。
  注意边界：批量发送 shell 探查命令用 wf-batched-execution，本 skill 只管
  代码改写。仅 wf 工作流任务会话内适用；非 wf 任务/普通项目开发不适用。
---

## 铁律三步

**dryRun report（count+样本）→ 自行核验覆盖对得上 → apply。**
禁止跳过 dryRun 直接 apply；禁止逐字手写一次性脚本变体族（t04-group*.cjs 反例）。

## 工具优先级

ast-grep pattern > 可复用参数化脚本（读 plan 表）> bespoke。

## 工程诚实性三条

1. report 截断不得声称为全量。
2. apply 与 report 解耦（rewritesApplied 独立计数）。
3. 工具缺位给恢复指引，不静默放弃。

## 坑例（实证）

- 朴素 pattern `catch {}` 三变体在 ast-grep 全部 parse 失败/0 命中；
  `try { $B } catch { $E }` 实测 25 命中——先验 pattern 可 parse 再批量。
- md5/批量校验循环禁裸 `$fs`（zsh 不分词曾致 md5 全量误报 MISMATCH）——
  用 `while read` 或 `${=fs}`。
