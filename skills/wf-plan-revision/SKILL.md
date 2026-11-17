---
name: Plan Revision
description: >
  plan 返修/多轮修订时必须使用。触发场景：wf:review FAIL 后 wf:plan 修订轮；
  收到 plan-review-r<N>.md findings 时；需要对已落盘 plan 做增量修改时。
  仅 wf 工作流任务会话内适用；非 wf 任务/普通项目开发不适用。
---

## 铁律

**动手修订前先逐条复跑**最新 review 的 FAIL findings 的验证动作（read/grep 核对
plan 原文与代码现状），确认销项路径再落笔——勿靠自觉；复跑动作须写死在回执。

## findings 处理去向（逐条，禁口头带过）

- 阻断（FAIL）：复跑取证 → 修订 → plan 原文标注改动点。
- 非阻断（minor/info）：同样在 plan 原文标注——采纳→改动点；不采纳→一行理由。

## 计数单位声明

plan 首节声明计数口径（按文件/按符号/按功能点），全文所有数量论断与验收标准
共用此口径（防「N 个文件」各算各的）。

## 增量修订（patch 协议）

1. 先 read plan.md 原文，勿凭记忆构造 old 串。
2. 用 `wf_write_artifact(kind=plan, patch=[{old,new}])` 或原生 edit **只输出变更段**：
   old 逐字摘录、唯一匹配；严格未命中自动模糊回退引号/破折号变体与行尾空白；
   其余原样保留，勿整份重写。
3. patch 落盘后记账自动完成；原生 edit 改过 plan.md 则须 `wf_write_artifact(kind=plan)`
   （不带 content=注册；内容未变则幂等 no-op）。
