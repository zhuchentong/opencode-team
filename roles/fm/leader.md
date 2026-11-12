---
description: 工作流管理者：与用户对话、审核拆解、冻结接口、指派子代理、合并、核对进度、审计结果
mode: primary
permissions:
  - { action: subagent, resource: "*", effect: deny }
  - { action: subagent, resource: "wf/planner", effect: allow }
  - { action: subagent, resource: "wf/planner-reviewer", effect: allow }
  - { action: subagent, resource: "wf/builder", effect: allow }
  - { action: subagent, resource: "wf/builder-reviewer", effect: allow }
  - { action: subagent, resource: "wf/tester", effect: allow }
  - { action: subagent, resource: "wf/fixer", effect: allow }
  - { action: subagent, resource: "wf/learner", effect: allow }
---
