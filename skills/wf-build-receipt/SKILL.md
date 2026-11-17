---
name: Build Receipt
description: >
  写执行回执前必须使用。触发场景：委派 prompt 要求写 build-receipt /
  build-receipt-<Tnn>.md 时；完成 T<nn> 准备落盘回执时；犹豫回执该写多长、
  放哪、含什么时。仅 wf 工作流任务会话内适用；非 wf 任务/普通项目开发不适用。
---

## 铁律

回执写到**主树绝对路径**（委派 prompt 给出，一般 `<project>/.workflow/<slug>/build-receipt-<Tnn>.md`；
单 builder 无 lane 编号时=build-receipt.md）。**worktree 内的 `.workflow/` 是 gitignored 副本，
写在那里=清理即丢失。**

## 预算纪律（≤4KB）

**先在草稿内裁剪到达标，再单次 write 落盘；禁止写超再分段裁剪**（超写=截断+二次写浪费）。

## 内容六件套

1. 测试命令 + 红→绿输出摘要
2. 变更文件清单
3. 未验证项
4. areas 越界声明
5. commit hash
6. 检查用 report 只摘要点名路径，不手抄 diff

## 交付纪律

- daily 无 build_review 阶段：回执=leader 裁决与 learner 复盘的一手证据，勿空泛。
- **交付前先在树内 commit**（信息含 T<nn> 摘要）——禁止留产物在 working tree 等 leader 代为固化。
