# wf-workflow — OpenCode 工作流插件

8 角色 10 阶段开发工作流的**状态机与关卡层**：把「规划 → 审核 → 分配 → 测试设计 → TDD 执行 → 合并 → 执行审核 → 测试 → 修复 → 复盘」变成带硬约束的流转，越权改码被服务端阻断，产物与审计轨迹可诊断。角色（`wf/*` subagent）由 OpenCode agents 配置提供，本插件负责流程管控。

> 架构形态：P0-P6 重设计（2026-11）后的版本——状态层 SQLite、命令双轨输出、TUI 流派 A 渲染、vite/oxlint 工具链。设计依据与宿主契约证据见文末「宿主契约备忘」。

## 特性

- **状态机流转**：`/wf:*` 命令驱动，非法来源拒绝、返工边内置（review 不过回 planning、修复后回 reconcile）；流转带 `rev` 乐观锁防陈旧快照覆盖
- **硬关卡**：`/wf:assign` 双通道（须 test-plan 产出）；`/wf:done` 验收（须 test-report 首行 `**结论**: PASS`）；拒绝消息自带下一步命令指引（blocked-append）
- **循环上限**：plan_review / build_review / test_fix 各 3 轮，「进入即计数」，超限拒绝并要求上报用户
- **越权阻断**：planning/review 阶段服务端 `execute.before` hook 拒绝 `edit/write/patch` 与 shell 重定向/写删命令改业务文件（`.workflow/`、`.learnings/`、测试文件除外），阻断记账进审计轨迹
- **抗 compaction 注入**：阶段 guidance 写入 session instructions entry（每次组装系统提示从存储重新渲染），消息历史压缩不丢阶段约束
- **产物管理**：`wf_write_artifact` 工具按 kind 落盘 `<项目>/.workflow/<slug>/`，循环类产物自动按轮次编号；test-report 输出按 verdict 指路下一步
- **命令输出双轨**（宿主 2.2.6 契约 `execute(): Promise<void>`，返回值对用户不显示）：
  - **主轨（TUI）**：return 键 priority-1 输入拦截 → RPC `exec` 本地执行 → 即时 toast；重要信号（⚠️/❌/FAIL）附加 `attention.notify` 系统级通知（终端后台时用户可感知）
  - **降级轨（Web/Desktop/无 TUI）**：`session.wait` 排空 → `prompt(resume:false, delivery:"steer")` 注入会话（不唤醒模型）；context/compaction/generate hook 按 metadata 剥离报告消息，不污染模型上下文
- **可观测**：RPC + TUI 侧边栏（阶段/轮次/关卡实时刷新，事件推送 + 重连重拉 + 5s 轮询对账三通道）、`/wf:status` 审计轨迹、`/wf:diagnose` 诊断取证、`/wf:debug` 状态落盘
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

包入口：`exports["./server"]` = `server/index.ts`（状态机/工具/命令/hook，TS 源码由宿主直接加载）、`exports["./tui"]` = `dist/tui.js`（**vite 构建产物**，已入库；改 TUI 源码后需 `bun run build`）、`exports["./rpc"]` = `shared/rpc.ts`（契约，server/TUI 同源结构）。

> 实测注意：宿主配置里 `{ package, options }` 的 **options 不传达 TUI 部件**（2.2.6 真机证实），TUI 的 `compact` 选项当前无效；server 侧 options 生效。

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

辅助命令：`/wf:status`（只读状态+轨迹）、`/wf:diagnose`（诊断）、`/wf:ping`（角色注册与模型健康检查）、`/wf:lane`（lane 登记）、`/wf:reset`（清除）、`/wf:debug`（观测落盘）。在 TUI 里直接回车执行走主轨（即时 toast）；从 `/` 下拉菜单选择执行走降级轨（注入会话消息，可见不唤醒）。

## 架构

```
server/index.ts         组装层：按依赖序接线各模块（exports 入口）
server/state.ts         状态层：bun:sqlite 单库 .workflow/wf.db（WAL；tasks/events/reports 三表，
                        partial unique index 一会话一活跃；rev 乐观锁；done 14 天 GC；ctx.storage 一次性迁移）
server/rpc-bridge.ts    RPC 桥：Wf.state/list/exec（state 附 lastReport）+ updated/report 事件
server/commands.ts      /wf:* 命令：11 流转表驱动 + 6 辅助；publishOutput（reports 表+事件）+
                        injectReport（降级轨 wait→prompt resume:false）+ hook 剥离报告消息
server/artifact-tool.ts wf_write_artifact 工具：kind → .workflow/<slug>/ 落盘+记账+verdict 指路公告
server/guard-hook.ts    execute.before 越权阻断（含 shell 门控；拒绝消息附下一步命令指引）
server/hint.ts          自动激活：消息 hook 多形态防御注册 → wf.hint 一次性提示
server/observe.ts       观测通道：debugDirFor/probeOnce（WF_DEBUG=1 或 options.probe 开启，默认关）
server/lib.ts           纯逻辑+领域类型单一来源：FLOWS/GATES/KIND_FILES/evaluateTransition/…（bun test 覆盖）
shared/phases.ts        阶段定义单一来源（server/tui 共用，含 STAGE_ORDER 直接导出）
shared/rpc.ts           RPC 契约（Rpc.define；server/TUI 各进程 import 同一源文件，tests 快照守卫防漂移）
tui/index.tsx           TUI 源码（流派 A：slot render 恒定容器 + 唯一 insert(accessor) 换树；return 键拦截主轨；
                        数据三通道=事件+server.connected 重拉+5s 轮询；fingerprint 无变化不发信号）
dist/tui.js             TUI 发布产物（vite lib 构建，solid/@opentui/@opencode/node:fs 全 external 共享宿主运行时）
tui-tests/              本地渲染 harness（真实 @opentui/solid testRender + 虚拟模块自举，46 断言含
                        流派 A 静态守卫/去重/拦截面/通知层）：bun tui-tests/tui-render.harness.ts
types/opencode-plugin.d.ts  宿主虚拟模块声明（@opencode/plugin/rpc|tui）
scripts/tui-restart.sh      完全重启 TUI 进程（宿主对 TUI 插件模块路径级缓存，/reload 不重读）
```

TypeScript：全仓 `strict`（tsconfig），`bunx tsc --noEmit` 零错误；宿主注入 API 边界显式 `any`（无官方类型），内部数据流用 lib.ts 领域类型。`bun test`（94 用例）为行为锚，含 wf.db 落库、RPC 契约快照、双轨注入断言。

状态按会话存 `.workflow/wf.db` 的 `tasks` 表（项目根 = 会话 `location.directory`）；`wf/*` 子会话经 `project_id` 反查管辖状态，同样受闸门约束。`.workflow/.gitignore` 自动写入（wf.db 及其 WAL 附属文件不入库，产物 md 可提交）。

## 插件 options（仅 server 部件生效）

| 键 | 默认 | 说明 |
|---|---|---|
| `debugDir` | 会话项目目录（回退 cwd） | 观测通道落盘根目录 |
| `probe` | `false` | 首次触发探针（`_debug/*.json` 记录宿主 API 形状）；或环境变量 `WF_DEBUG=1` |
| `allowMarkers` | `[]` | 追加放行路径片段（合并默认 `.workflow/.learnings/tests/...`） |
| `allowRegexps` | `[]` | 追加放行正则（字符串形式） |
| `limits` | — | 覆盖循环上限，如 `{ "plan_review": 2 }`（仅正整数生效，guidance/状态/诊断同步显示） |
| `hint` | `true` | 自动激活：用户消息命中工作流意图关键词且会话无 wf 状态时，注入一次性 `/wf:intake` 提示 |

## 项目级角色定制（overrides）

在工作流活动项目的 `.workflow/overrides/` 下放 `<角色名>.md`（如 `planner.md`、`builder.md`），当前阶段 guidance 会自动附一行提示：委派同名 `wf/*` 角色时必须把该文件全文带入子任务提示词。效果=不改全局 agents、按项目覆盖角色行为。例：

```
.workflow/overrides/planner.md   ← 「planner 必须先读 ARCHITECTURE.md，任务粒度 ≤2h」
.workflow/overrides/tester.md    ← 「集成测试一律打真 SQLite，不许 mock」
```

## 真机验证清单

插件改动生效方式：**TUI 改动需 `bun run build` + 完全重启 TUI 进程**（宿主对 TUI 插件模块路径级缓存，`/reload` 不重读——用 `./scripts/tui-restart.sh`）；server 改动 watcher 按内容指纹热载即效；仅改 `opencode.jsonc` 配置可 `/reload`。首轮真机跑一遍：

1. 开 session → 侧边栏显示 `── wf ──` 20 行面板且**不崩**；`/wf:intake probe-test` 回车 → toast 弹出 guidance + 面板变 F0 intake + 系统提示出现 `<context key="wf.phase">` 块
2. `/wf:ping` 回车 → 即时 toast「wf 角色：7/7 已注册」（主轨：回车拦截 → RPC exec）
3. 输入 `/wf` 从下拉菜单**选择** `/wf:status` → 输出作为消息注入会话 inbox（降级轨，不唤醒模型；TUI 里可见于 /inbox）
4. 终端切到后台再触发一次命令 → 系统级通知弹出（attention.notify；仅 ⚠️/❌/FAIL 类重要信号）
5. （调试期可选）`WF_DEBUG=1 ./scripts/tui-restart.sh` → 探针写 `.workflow/_debug/tui-refresh.log`（loaded/slot-render/build/recv 序列）

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

- 探针默认关闭；`WF_DEBUG=1`（或 server `options.probe:true`）时写 `.workflow/_debug/`（probeOnce 形状探针 / cmd-report.jsonl 广播记录 / tui-refresh.log TUI 生命周期）
- `/wf:diagnose`：审计轨迹拒绝分类计数、越权阻断取证、轮次余量告警、产物「state 记账 vs 磁盘」对账、注入/RPC 异常、下一步建议
- `/wf:debug`：全量状态快照落盘 `_debug/state.json` + 活跃任务枚举
- 状态 GC：done 且 14 天未更新的状态在任务枚举（RPC list）时自动清理；`wf.db` 的 `events` 表 append-only 保留审计

## 开发与测试

```sh
bun install
bun run build    # vite 构建 dist/tui.js（TUI 源码改动后必须）
bun run check    # 门禁五合一：build → bun test(94) → tsc --noEmit → oxlint → harness(46)
bun run lint     # oxlint（correctness=error，warnings 不阻塞）
```

## 宿主契约备忘（2.2.6 真机实证，重设计依据）

以下行为均有 `.learnings/ERRORS.md` 事故记录与官方源码核对支撑，改动本插件时勿「修复」成反效果：

- **TUI slot 渲染**：宿主 PluginOutput memo 跟踪 slot render 顶层的响应式读取——顶层读信号 → claim.render 重跑返回全新根 → 撞 reconciler `e.length` 崩。安全形态=恒定容器 + 容器内唯一 `insert(accessor)`（社区 usage-monitor/agents-sidebar 先例，本插件 P0 探针真机复刻）；`session.panel` 场景多贡献共存高危，wf-board 面板已永久移除
- **命令返回值**：`execute(): Promise<void>` 契约返回值被丢弃；抛错的 message 会以 error toast 显示（语义错误勿用）。`tui.toast.show` 服务端事件在 2.2.6 已无发布者
- **prompt/synthetic**：`resume:false` 源码级不唤醒模型（durable admit 进 inbox）；忙会话需先 `session.wait` 否则 steer 注入诱发多走一步
- **RPC**：methods 调用必须带 `{location:{directory}}`；events 五硬条件（id/事件名逐字一致、events 声明、对象 schema、emit await+catch、live-only 订阅）——事件按 `location.directory` 过滤（多实例并存全 folder 广播），错过不重放故配轮询对账
- **加载与缓存**：宿主对 TUI 插件模块**路径级永久缓存**（唯一解完全重启）；server 侧按内容指纹热载；正被加载的入口文件禁止分步 edit（热重载读中间态）；`{package,options}` 不传达 TUI
- **keymap**：`run` 返回 Promise 即算已处理（同步透传必须返回 `false`）；冒号命令名在宿主 slash 派发静默失效（主轨因此选 return 拦截形态）
- **杂项**：插件 id 含 `:` 与 storage 文件命名冲突；`@opencode/schema` 运行时版本错位会崩（依赖全 external 共享宿主实例）；宿主对 node_modules 不跑 TSX transform（发布前预编译）

## 已知边界（测试锁定现状）

- verdict 解析正则带 `i`：小写 `pass` 也判 PASS；`PASSED` 因 `\b` 边界不判
- intake 非重置分支下 slug 会被新 text 覆盖（rounds/记账保留）
- `tee out.txt < input` 会把 `input` 误判为 shell 写目标（fail-closed 方向，仅阻断阶段误伤）
- hook 内部异常 fail-open（不阻断），关卡异常（含 `GATE_ERR`）才拦截
- 降级轨消息注入会话历史（context/compaction/generate hook 剥离仅护模型面，用户面保留可读）

## 设计借鉴对照

| 来源机制 | 本项目映射 | 取舍 |
|---|---|---|
| 社区 usage-monitor/agents-sidebar（流派 A） | sidebar 恒定容器 + insert(accessor) + fingerprint 门禁 | ✅ 采纳（P0 探针复刻验证） |
| quota 插件双轨输出 | return 拦截主轨 + resume:false 注入降级轨 + hook 剥离 | ✅ 采纳 |
| brhp（V2 工作流同形样本） | SQLite 单库 + partial unique index + 一会话一活跃 | ✅ 采纳 |
| goopspec blocked-append | 闸门/verdict 消息自带下一步命令指引；wouldRegress 防倒退（rev 锁实现） | ✅ 采纳 |
| superpowers post-compaction 重注入 | guidance 写入 entry（存储重渲染天然抗压缩）+ `wf.hint` 自动激活 | ✅ 采纳 |
| superpowers 会话诊断 | `/wf:diagnose`：拒绝分类计数 + 阻断取证 + 磁盘对账 | ✅ 采纳 |
| omo-slim 每角色模型路由 | README 候选表 + `/wf:ping` 查看生效模型；`options.agentModels` 未启用 | ⏳ 待选型 |
| omo-slim 项目级自定义 | `.workflow/overrides/` 约定 | ✅ 采纳 |
| Council 共识 / marketplace / multiplexer | — | ❌ 不照搬（场景/宿主不符） |

## 许可

MIT
