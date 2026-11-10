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
- **自动激活**（superpowers 式）：用户消息命中工作流意图且会话无状态 → 注入一次性 `/wf:intake` 提示，不自动开任务
- **项目级角色定制**：`.workflow/overrides/<role>.md` 存在则 guidance 自动要求委派同名角色时全文带上（按项目覆盖角色行为，不动全局 agents）

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

辅助命令：`/wf:status`（只读状态+轨迹）、`/wf:diagnose`（诊断）、`/wf:ping`（角色注册与模型健康检查）、`/wf:lane`（lane 登记）、`/wf:reset`（清除）、`/wf:debug`（观测落盘）。

## 架构

```
server/index.js        组装层：按依赖序接线各模块（55 行）
server/state.js        状态存取：load/save/resolveState/scanStates(GC)/resolveProjectDir
server/observe.js      观测通道：debugDirFor/probeOnce/logToolsOnce（.workflow/_debug/ 落盘）
server/rpc-bridge.js   RPC 桥：Wf.state/list + updated 事件（TUI 数据源）
server/artifact-tool.js wf_write_artifact 工具：kind → .workflow/<slug>/ 落盘+记账
server/guard-hook.js   execute.before 越权阻断（planning/review 拒业务代码写，含 shell 门控）
server/hint.js         P3 自动激活：消息 hook 多形态防御注册 → wf.hint 一次性提示
server/commands.js     /wf:* 命令：11 个流转命令表驱动 + 6 个辅助命令 + transition/inject 编排
server/lib.js          纯逻辑单一来源：FLOWS/GATES/KIND_FILES/evaluateTransition/…（bun test 覆盖）
shared/phases.js       阶段定义单一来源（server/tui 共用，防漂移）
shared/rpc.ts          RPC 契约（TUI 侧边栏订阅 state/list + updated 事件）
tui/index.tsx          TUI 注册壳（slot/panel/keymap）
tui/widget.tsx         侧边栏挂件（当前会话状态 + M15 回退列表）
tui/board.tsx          看板面板（全部任务、范围切换）
tui/format.ts          公共格式化（stageOf/str/hhmm/listLine）
```

状态按会话存于 `ctx.storage`（键 `wf-workflow/state/<sessionID>`）；`wf/*` 子会话经项目索引（`wf-workflow/project/<projectID>`）反查管辖状态，同样受闸门约束。

## 插件 options

| 键 | 默认 | 说明 |
|---|---|---|
| `debugDir` | 会话项目目录（回退 cwd） | 观测通道落盘根目录 |
| `probe` | `true` | 首次触发探针（`_debug/*.json` 记录宿主 API 形状） |
| `allowMarkers` | `[]` | 追加放行路径片段（合并默认 `.workflow/.learnings/tests/...`） |
| `allowRegexps` | `[]` | 追加放行正则（字符串形式） |
| `limits` | — | 覆盖循环上限，如 `{ "plan_review": 2 }`（仅正整数生效，guidance/状态/诊断同步显示） |
| `hint` | `true` | superpowers 式自动激活：用户消息命中工作流意图关键词且会话无 wf 状态时，注入一次性 `/wf:intake` 提示（`wf.hint` entry，reset 一并清除；宿主无消息 hook 则自然失效） |

## 项目级角色定制（overrides）

在工作流活动项目的 `.workflow/overrides/` 下放 `<角色名>.md`（如 `planner.md`、`builder.md`），当前阶段 guidance 会自动附一行提示：委派同名 `wf/*` 角色时必须把该文件全文带入子任务提示词。效果=不改全局 agents、按项目覆盖角色行为。例：

```
.workflow/overrides/planner.md   ← 「planner 必须先读 ARCHITECTURE.md，任务粒度 ≤2h」
.workflow/overrides/tester.md    ← 「集成测试一律打真 SQLite，不许 mock」
```

## 真机验证清单（/reload 后）

插件改动需 `/reload` 生效。首轮真机跑一遍：
1. `/wf:intake probe-test` → 返回 intake guidance；查 `.workflow/probe-test/` 与系统提示中 `<context key="wf.phase">` 多行块是否渲染
2. `/wf:ping` → 角色注册表；查 `_debug/agent-probe.json` 确认 `ctx.agent.list` 实际形状
3. 发一条含「走工作流」的新会话消息（无 wf 状态会话）→ 应出现 `wf.hint` 提示块；查 `_debug/chat-probe.json` 确认消息 hook 是否在本宿主（v2.2.6）触发
4. `/wf:debug` → `_debug/state.json` 全量快照

## 角色模型路由（待选型）

7 个 `wf/*` 角色由 OpenCode agents（`~/.config/opencode/agents/wf/`）定义。按 omo-slim 的「质量/速度/成本」路由思路，结合本机可用模型的**建议对照表**（未启用，选定后可在 agents 前置配 `model`，或后续由插件 `options.agentModels` 落地）：

| 角色 | 职责 | 选型思路 | 本机候选 |
|---|---|---|---|
| leader（当前会话） | 编排/调度/裁决 | 最强推理 | `glm-5.3-flash (high/max)` |
| wf/planner | 需求分析与任务分解 | 强规划 | `glm-5.3-flash (high)` |
| wf/planner-reviewer | 计划五角度审查 | 强推理 | `glm-5.3-flash (high)` |
| wf/tester | 可行性/红测试/验收 | 可靠编码+测试素养 | `mimo-v2.6-pro` |
| wf/builder | worktree 内 TDD 执行 | 快而稳的执行模型 | `qwen3.8-flash` / `mimo-v2.6-flash` |
| wf/builder-reviewer | 完成度/质量审核 | 强推理 | `glm-5.3-flash (high)` |
| wf/fixer | 跨 lane 修复 | 强调试 | `glm-5.3-flash (max)` |
| wf/learner | 复盘沉淀 | 便宜快速 | `mimo-v2.6-flash` / `qwen3.8-flash` |

`/wf:ping` 可随时查看各角色当前注册状态与生效模型。

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

## 设计借鉴对照

| 来源机制 | 本项目映射 | 取舍 |
|---|---|---|
| superpowers post-compaction 重注入 | guidance 写入 entry（存储重渲染天然抗压缩）+ `wf.hint` 自动激活 | ✅ 采纳 |
| superpowers skills 自动触发 | `isHintWorthy` 关键词门槛（误触优先于召回），不自动开任务 | ✅ 保守采纳 |
| superpowers 会话诊断（diagnosing-superpowers） | `/wf:diagnose`：拒绝分类计数 + 阻断取证 + 磁盘对账 | ✅ 采纳 |
| omo-slim 每角色模型路由 | README 候选表 + `/wf:ping` 查看生效模型；`options.agentModels` 未启用 | ⏳ 待选型 |
| omo-slim 项目级自定义 | `.workflow/overrides/` 约定 | ✅ 采纳 |
| omo-slim council-inject 按需注入 | 阶段 guidance 本身就是「当前阶段才在线」的按需注入 | ✅ 等价实现 |
| Council 共识 / marketplace / multiplexer | — | ❌ 不照搬（场景/宿主不符） |

## 许可

MIT
