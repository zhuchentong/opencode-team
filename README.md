# wf-workflow — OpenCode 工作流插件

8 角色 10 阶段开发工作流的**状态机与关卡层**：把「规划 → 审核 → 分配 → 测试设计 → TDD 执行 → 合并 → 执行审核 → 测试 → 修复 → 复盘」变成带硬约束的流转，越权改码被服务端阻断，产物与审计轨迹可诊断。角色（`wf/*` subagent）由 OpenCode agents 配置提供，本插件负责流程管控。

## 特性

- **状态机流转**：`/wf:*` 命令驱动，非法来源拒绝、返工边内置（review 不过回 planning、修复后回 reconcile）
- **硬关卡**：`/wf:assign` 双通道（须 test-plan 产出）；`/wf:done` 验收（须 test-report 首行 `**结论**: PASS`）
- **循环上限**：plan_review / build_review / test_fix 各 3 轮，「进入即计数」，超限拒绝并要求上报用户
- **越权阻断**：planning/review 阶段服务端 `execute.before` hook 拒绝 `edit/write/patch` 与 shell 重定向/写删命令改业务文件（`.workflow/`、`.learnings/`、测试文件除外）
- **抗 compaction 注入**：阶段 guidance 写入 session instructions entry（每次组装系统提示从存储重新渲染），消息历史压缩不丢阶段约束
- **产物管理**：`wf_write_artifact` 工具按 kind 落盘 `<项目>/.workflow/<slug>/`，循环类产物自动按轮次编号
- **可观测**：RPC + TUI 侧边栏（阶段/轮次/关卡实时刷新）、`/wf:status` 审计轨迹、`/wf:diagnose` 诊断取证、`/wf:debug` 状态落盘

## 安装

OpenCode 配置（`opencode.json(c)` 全局或项目级）的 `plugins` 数组加入：

```jsonc
{
  "plugins": [
    { "package": "/path/to/opencode-team", "options": {} }
  ]
}
```

包入口：`exports["./server"]`（状态机/工具/命令/hook）与 `exports["./tui"]`（侧边栏）。配置变化无需重启，`/reload` 可强制重载。

## 快速上手

```
/wf:intake <slug>        # 入口：澄清需求、读 .learnings/
/wf:plan                 # planning：委派 wf/planner 产出 plan.md
/wf:review               # review：planner-reviewer ∥ tester(feasibility)，≤3 轮
/wf:assign               # assign：双通道关卡（须 test-plan.md）
/wf:test-design          # test_design：tester(design) 按冻结接口写红验收测试
/wf:build                # building：每 lane 一 worktree + wf/builder（TDD）
/wf:reconcile            # reconcile：各 worktree 合并回主树
/wf:review-build         # build_review：builder-reviewer，≤3 轮
/wf:test                 # testing：tester(verify) → test-report.md（PASS|FAIL）
/wf:fix                  # fixing：≤3 轮；同 lane 回 builder / 跨 lane 用 fixer
/wf:done                 # done：验收关卡（PASS）+ 并行 learner 复盘
```

辅助命令：`/wf:status`（只读状态+轨迹）、`/wf:diagnose`（诊断）、`/wf:lane`（lane 登记）、`/wf:reset`（清除）、`/wf:debug`（观测落盘）。

## 架构

```
server/index.js   注册层：命令 /wf:*、工具 wf_write_artifact、
                  execute.before hook（越权阻断+记账）、RPC 桥、TUI 数据源
server/lib.js     纯逻辑层：FLOWS/GATES/KIND_FILES/evaluateTransition/
                  makeAllowChecker/shellWriteTargets/diagnoseReport（bun test 覆盖）
shared/phases.js  阶段定义单一来源（server/tui 共用，防漂移）
shared/rpc.ts     RPC 契约（TUI 侧边栏订阅 state/list + updated 事件）
tui/index.tsx     TUI 侧边栏（阶段进度、轮次、关卡、产物）
```

状态按会话存于 `ctx.storage`（键 `wf-workflow/state/<sessionID>`）；`wf/*` 子会话经项目索引（`wf-workflow/project/<projectID>`）反查管辖状态，同样受闸门约束。

## 插件 options

| 键 | 默认 | 说明 |
|---|---|---|
| `debugDir` | 会话项目目录（回退 cwd） | 观测通道落盘根目录 |
| `probe` | `true` | 首次触发探针（`_debug/*.json` 记录宿主 API 形状） |
| `allowMarkers` | `[]` | 追加放行路径片段（合并默认 `.workflow/.learnings/tests/...`） |
| `allowRegexps` | `[]` | 追加放行正则（字符串形式） |

## 观测与诊断

- `.workflow/_debug/{tools,hook-probe,tool-probe,state}.json`：探针与状态快照（`probe:false` 可关）
- `/wf:diagnose`：审计轨迹拒绝分类计数、越权阻断取证、轮次余量告警、产物「state 记账 vs 磁盘」对账、注入/RPC 异常、下一步建议
- 状态 GC：done 且 14 天未更新的状态在面板扫描时自动清理

## 开发与测试

```sh
bun install
bun test          # tests/：流转矩阵、关卡、计数器语义、放行/shell 解析、
                  # verdict、kind 命名、phases 一致性守卫、mock 环境端到端
```

## 已知边界（测试锁定现状）

- verdict 解析正则带 `i`：小写 `pass` 也判 PASS；`PASSED` 因 `\b` 边界不判
- intake 非重置分支下 slug 会被新 text 覆盖（rounds/记账保留）
- `tee out.txt < input` 会把 `input` 误判为 shell 写目标（fail-closed 方向，仅阻断阶段误伤）
- hook 内部异常 fail-open（不阻断），关卡异常（含 `GATE_ERR`）才拦截

## 许可

MIT
