---
name: WF Worktrees
description: >
  wf 工作流的 worktree 生命周期协议（创建/单树串行/合并/清理）。触发场景：builder 在
  leader 指定的 worktree 路径内工作；leader 合并批次回主树；任务收尾清理 worktree；
  遇到 "worktree remove" 被拒（untracked/modified 残留）；lane 分支命名。
  固化清理步完整顺序（ERR-001：非 force 移除被 untracked 与 tracked M 两类残留共同阻塞）。
---

# WF Worktrees 协议

## 创建
- `worktree_create`（opencode 工具）或 `git worktree add <path> -b <branch>`；树内先 `bun install`。
- 分支命名：批次树 `wf/<slug>/batch<N>`；lane 树 `wf/<slug>/lane-Tnn`（P1-E；lane 写集归属见 `wf:lane ls` 的 areas 列）。
- lane 树内 `.workflow/`（wf.db 等）不入 git：createStore 已在每个项目目录写 `.workflow/.gitignore`（managed 块）——树内首次跑测试自动生成，勿手工删除该块。
- 基线陷阱：worktree 基于 HEAD 建树——主树未提交的 carryover 不在树内，开工前主树必须干净。

## 单树串行执行（builder）
- 只在 leader 指定的 worktree 绝对路径内工作，不越界修改其他 lane 文件。
- 主树被运行中宿主热载——**全程不在主树改业务代码**，合并窗口由 leader 统一执行。

## 合并（leader）
0. 合并前校验树内 `git status` 干净（builder 已 commit；未 commit 残留 → 退回 builder 固化，勿代写）。
1. builder 回执齐备（含红→绿证据）后才合并；**回执必须已双写主树**（`<主树>/.workflow/<slug>/build-receipt-<Tnn>.md` ls 验证存在且非空——树内 `.workflow/` 是 gitignored 副本，清理序会 rm 它；`cp 2>/dev/null &&` 静默短路曾致回执丢失、靠 sessionID 续接补档）。
2. md5 逐文件核验树内产物与主树一致（防部分拷贝）。
3. 主树跑全量门禁（树内绿≠主树绿，环境可能不同）。
4. 数字不符/冲突 → 停下问用户，不自动解决。

## 清理（顺序固定，ERR-001）
1. 先 `rm` 树内已合并的 untracked 副本（产物 md 等；回执主树副本已在合并序第 1 步验证）；
2. **`git restore .`**（tracked M 也阻塞非 force 移除——只 rm untracked 不够）；
3. `worktree remove`（**非 force**；force 仅在用户明确确认后使用）。

## 状态持久语义
- 空闲 lane 续用=reconstructing reality（重建现状），非 admitting new work——热载/重启后重占名额按 lanes 登记恢复，不算新并行授权。
