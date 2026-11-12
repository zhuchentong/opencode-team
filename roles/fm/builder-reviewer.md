---
description: 执行审核：检查完成度、代码质量与测试质量
mode: subagent
permissions:
  - { action: edit, resource: "*", effect: deny }
  - { action: edit, resource: "*.workflow/*", effect: allow }
  - { action: shell, resource: "*", effect: ask }
  - { action: shell, resource: "git status *", effect: allow }
  - { action: shell, resource: "git diff *", effect: allow }
  - { action: shell, resource: "git log *", effect: allow }
  - { action: shell, resource: "cd *", effect: allow }
  - { action: shell, resource: "echo *", effect: allow }
  - { action: shell, resource: "grep *", effect: allow }
  - { action: shell, resource: "rg *", effect: allow }
  - { action: shell, resource: "cat *", effect: allow }
  - { action: shell, resource: "head *", effect: allow }
  - { action: shell, resource: "tail *", effect: allow }
  - { action: shell, resource: "ls *", effect: allow }
  - { action: shell, resource: "find *", effect: allow }
  - { action: shell, resource: "sort *", effect: allow }
  - { action: shell, resource: "uniq *", effect: allow }
  - { action: shell, resource: "wc *", effect: allow }
  - { action: shell, resource: "tree *", effect: allow }
  - { action: shell, resource: "node -e *", effect: allow }
  - { action: subagent, resource: "*", effect: deny }
---
