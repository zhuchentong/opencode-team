# wf-workflow — OpenCode 工作流插件

8 角色 9 阶段开发工作流的**状态机与关卡层**：把「规划 → 审核∥可行性 → 测试设计(含分配) → TDD 执行 → 合并 → 执行审核 → 测试 → 修复 → 复盘」变成带硬约束的流转，越权改码被服务端阻断，产物与审计轨迹可诊断。角色（`wf/*`）内容自 M16-r31 起由本插件托管（仓库 `roles/` 单一来源 + 文件同步，宿主留 frontmatter/permissions），本插件只负责流程管控。

> 架构形态：P0-P6 重设计（2026-11）后的版本——状态层 SQLite、命令双轨输出、TUI 流派 A 渲染、vite/oxlint 工具链。版本演进与真机契约（改插件前必读）见 `docs/HOST-CONTRACT.md`；升级/改流程前核对见 `docs/UPGRADE.md`。

## 特性

- **状态机流转**：`/wf:*` 命令驱动，非法来源拒绝、返工边内置（review 不过回 planning、修复后回 reconcile）；流转带 `rev` 乐观锁，并发冲突自动重载重放（≤3 次），最终写不进则显式报错不静默丢推进
- **双入口推进**：模型侧 `wf_command` 工具（leader 用，参数 `name="wf:plan"`、`prompt` 传命令参数）与用户手敲 `/wf:*` 走同一编排（transition+注入+落库+广播）；`wf/*` 子会话调用被硬拒——关卡/上限不存在"模型忘了执行命令"的绕行路径
- **硬关卡**：`/wf:test-design` 双通道（须 test-plan 产出；M16-r28 起原 `/wf:assign` 阶段并入 test_design）；`/wf:done` 验收（须 test-report 首行 `**结论**: PASS`）；M16-r44 方案确认关卡（`wf:build` 须 leader 先经宿主 question 工具向用户做方案确认，S 也须确认；plan 修订/intake 即作废，机制详见 `docs/HOST-CONTRACT.md` r44）；拒绝消息自带下一步命令指引（blocked-append）
- **循环上限**：plan_review / build_review / test_fix 各 3 轮，「进入即计数」，超限拒绝并要求上报用户
- **越权阻断**：planning/review 阶段服务端 `execute.before` hook 拒绝 `edit/write/patch` 与 shell 重定向/写删命令改**项目内**业务文件（`.workflow/`、`.learnings/`、测试文件除外；M16-r28：项目外路径不构成越权，放行），阻断记账进审计轨迹
- **抗 compaction 注入**：阶段 guidance 写入 session instructions entry（每次组装系统提示从存储重新渲染），消息历史压缩不丢阶段约束
- **产物管理**：`wf_write_artifact` 工具按 kind 落盘 `<项目>/.workflow/<slug>/`，循环类产物自动按轮次编号；三模式（互斥）：content 首写 / patch 增量修订（严格未命中自动模糊回退）/ 两者皆缺=注册已原生落盘的产物（大产物分段写+微小注册，抗慢模型流中断）；test-report 输出按 verdict 指路下一步；slug 支持 Unicode（中文任务名原样保留）
- **产物预览**：侧边栏产物清单点击（或 `/wf:open <名>`）打开 `wf-artifact` 预览 route，**markdown 渲染**（标题/表格/代码块/列表经 OpenTUI `markdown` 渲染器，标题/强调/行内代码着色并 conceal 语法标记；旧版宿主能力缺失时自动降级逐行纯文本），**正文可滚动**（scrollbox 包裹，头部信息与返回提示固定；无 scrollbox 能力时直挂降级），`q` 返回会话；详见 `docs/HOST-CONTRACT.md` r46/r48/r48b/r48c
- **命令输出双轨**（宿主 2.2.6 契约 `execute(): Promise<void>` 返回值不显示）：**主轨**（TUI）return 键拦截 → RPC `exec` → 即时 toast 呈现 **3-4 行结构化 brief**（server 从 WfState 生成，非全文墙；notification-brief-display），`level==="warn"`（server 结构化判定：❌ 拒绝/关卡 FAIL 在场/wf:fix 返工/done 交付确认）附 `attention.notify` 系统级通知（终端后台可感知）；**降级轨**（Web/Desktop/无 TUI）`session.wait` + `prompt(resume:false)` 注入会话**全文**（不唤醒模型；context/compaction/generate hook 剥离报告消息，不污染模型上下文；LLM 通道不受 brief 化影响——guidance 全文照旧进 entry/inject 与 reports 槽 text）
- **可观测**：RPC + TUI 侧边栏（阶段/轮次/关卡实时刷新，事件推送 + 重连重拉 + 5s 轮询对账三通道）、`/wf:status` 审计轨迹、`/wf:diagnose` 诊断取证、`/wf:debug` 状态落盘
- **自动激活**（superpowers 式）：用户消息命中工作流意图且会话无状态 → 注入一次性 `/wf:intake` 提示，不自动开任务
- **项目级角色定制**：`.workflow/overrides/<role>.md` 按项目覆盖角色行为（见「项目级角色定制」专节）

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

> 实测注意：宿主配置里 `{ package, options }` 的 **options 不传达 TUI 部件**（2.2.6 真机证实），TUI 的 `compact` 选项因此无效——M16-r39 起提供环境变量开关 `WF_COMPACT=1`（与 options.compact:true 同效）；server 侧 options 生效。

## 快速上手

日常流（默认；intake 用 `[S]/[M]/[L]` 前缀声明体量）：

```
/wf:intake <slug>   # 入口：澄清需求、读 .learnings/
/wf:plan            # planning：拟定方案（S 自拟轻量 / M/L 委派 planner 拆 T<nn> 功能点）
/wf:review          # review：独立验证 ≤3 轮（S 自验五维 / M/L plan-review PASS 关卡）
/wf:build           # building：TDD 执行（全体量须先经 question 方案确认关卡）
/wf:test            # testing：独立核对 → test-report.md（PASS|FAIL）
/wf:done            # done：验收 + learner 复盘
```

testing FAIL → `/wf:fix` 回 building 返工（test_fix ≤3）。

完整流（`[FULL]` 显式声明，9 阶段）：

```
/wf:intake → /wf:plan → /wf:review → /wf:test-design → /wf:build → /wf:reconcile
→ /wf:review-build → /wf:test → /wf:fix → /wf:done
# test-design 双通道关卡（须 test-plan.md，原 /wf:assign 已并入）；build 每 lane 一 worktree + builder TDD；
# review-build ≤3 轮；fix 同 lane 回 builder / 跨 lane 用 fixer
```

辅助命令：`/wf:status`（只读状态+轨迹）、`/wf:diagnose`（诊断）、`/wf:ping`（角色注册与模型健康检查）、`/wf:lane`（lane 登记）、`/wf:reset`（清除）、`/wf:debug`（观测落盘）。在 TUI 里直接回车执行走主轨（即时 toast）；从 `/` 下拉菜单选择执行走降级轨（注入会话消息，可见不唤醒）。leader 会话中模型会自行调用 `wf_command` 工具推进上述流转，用户无需逐条手敲（手敲入口保留，二者等价）。

## 架构

```
server/index.ts         组装层：按依赖序接线各模块（exports 入口）
server/state.ts         状态层：bun:sqlite 单库 .workflow/wf.db（WAL；tasks/events/reports 三表，
                        partial unique index 一会话一活跃；rev 乐观锁；done 14 天 GC；ctx.storage 一次性迁移）
server/rpc-bridge.ts    RPC 桥：Wf.state/list/exec（state 附 lastReport）+ updated/report 事件
server/commands.ts      /wf:* 命令：10 流转表驱动 + 6 辅助；publishOutput（reports 表+事件）+
                        injectReport（降级轨 wait→prompt resume:false）+ hook 剥离报告消息
server/artifact-tool.ts wf_write_artifact 工具：kind → .workflow/<slug>/ 落盘+记账+verdict 指路公告；三模式 content/patch/register（M16-r47，fuzzy 匹配纯函数在 lib.ts）
server/guard-hook.ts    execute.before 越权阻断（含 shell 门控）+ subagent 续接自愈（r41）
                        + question 方案确认观察记账（r44）；拒绝消息附下一步命令指引
server/hint.ts          自动激活：消息 hook 多形态防御注册 → wf.hint 一次性提示
server/observe.ts       观测通道：debugDirFor/probeOnce（WF_DEBUG=1 或 options.probe 开启，默认关）
server/model-tier.ts    动态档位跟随（M16-r43）：TIER_MAP/降级链/项目级派生文件读写（纯函数+IO 分离）
server/lib.ts           纯逻辑+领域类型单一来源：FLOWS/GATES/KIND_FILES/evaluateTransition/…（bun test 覆盖）
shared/phases.ts        阶段定义单一来源（server/tui 共用，含 STAGE_ORDER 直接导出）
shared/rpc.ts           RPC 契约（Rpc.define；server/TUI 各进程 import 同一源文件，tests 快照守卫防漂移）
tui/index.tsx           TUI 源码（流派 A：slot render 恒定容器 + 唯一 insert(accessor) 换树；return 键拦截主轨；
                        数据三通道=事件+server.connected 重拉+5s 轮询；fingerprint 无变化不发信号）
dist/tui.js             TUI 发布产物（vite lib 构建，solid/@opentui/@opencode/node:fs 全 external 共享宿主运行时）
tui-tests/              本地渲染 harness（真实 @opentui/solid testRender + 虚拟模块自举，断言含
                        流派 A 静态守卫/去重/拦截面/通知层/表格对齐纯函数+真渲染复核）：bun tui-tests/tui-render.harness.ts
types/opencode-plugin.d.ts  宿主虚拟模块声明（@opencode/plugin/rpc|tui）
scripts/tui-restart.sh      完全重启 TUI 进程（宿主对 TUI 插件模块路径级缓存，/reload 不重读）
```

TypeScript：全仓 `strict`（tsconfig），`bunx tsc --noEmit` 零错误；宿主注入 API 边界显式 `any`（无官方类型），内部数据流用 lib.ts 领域类型。`bun test` 为行为锚，含 wf.db 落库、RPC 契约快照、双轨注入断言。

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
| `tierAgents` | `false` | 动态档位跟随（M16-r43）：流转时读会话所选模型，按 `tiers` 为各流程角色写项目级 `.opencode/agents/wf/<role>.md`。**前置：基座模型须在宿主 opencode.jsonc 声明 variants（body 直注 `reasoning_effort`——openai-compatible 包不转发 settings.reasoningEffort，真机抓包实证）** |
| `tiers` | TIER_MAP | 档位映射覆盖（默认 planner/planner-reviewer/tester/builder-reviewer/fixer=`high`，builder/learner=`off`） |

## 项目级角色定制（overrides）

在工作流活动项目的 `.workflow/overrides/` 下放 `<角色名>.md`（如 `planner.md`、`builder.md`），当前阶段 guidance 会自动附一行提示：委派同名 `wf/*` 角色时必须把该文件全文带入子任务提示词。效果=不改全局 agents、按项目覆盖角色行为。例：

```
.workflow/overrides/planner.md   ← 「planner 必须先读 ARCHITECTURE.md，任务粒度 ≤2h」
.workflow/overrides/tester.md    ← 「集成测试一律打真 SQLite，不许 mock」
```

## 真机验证清单

插件改动生效方式：**TUI 改动需 `bun run build` + 完全重启 TUI 进程**（宿主对 TUI 插件模块路径级缓存，`/reload` 不重读——用 `./scripts/tui-restart.sh`）；server 改动 watcher 按内容指纹热载即效；仅改 `opencode.jsonc` 配置可 `/reload`。首轮真机跑一遍：

1. 开 session → 侧边栏显示 `── Workflow ──` 20 行面板且**不崩**；`/wf:intake probe-test` 回车 → toast 弹出 3-4 行 brief（非全文墙；guidance 全文仍在系统提示）+ 面板变 F0 intake + 系统提示出现 `<context key="wf.phase">` 块
2. `/wf:ping` 回车 → 即时 toast「wf 角色：7/7 已注册」（主轨：回车拦截 → RPC exec）
3. 输入 `/wf` 从下拉菜单**选择** `/wf:status` → 输出作为消息注入会话 inbox（降级轨，不唤醒模型；TUI 里可见于 /inbox）
4. 终端切到后台再触发一次命令 → 系统级通知弹出（attention.notify；仅 server 结构化 `level==="warn"`——旧 ⚠️/❌/FAIL 全文正则已废除，含 ⚠️ 行的正常流转不再误弹）
5. （调试期可选）`WF_DEBUG=1 ./scripts/tui-restart.sh` → 探针写 `.workflow/_debug/tui-refresh.log`（loaded/slot-render/build/recv 序列）

## 角色档位跟随（M16-r43 动态路由）

`options.tierAgents: true` 启用后：流转时读会话所选模型，按档位映射为各流程角色写**项目级** `.opencode/agents/wf/<role>.md`（`model: <基座>#<档位>`；frontmatter 仅 mode+model，空 body 保留全局角色提示词），宿主热载即效。**切模型即全角色跟随**（5h 用量上限场景：下一次 `wf_command` 后新委派自动用新基座对应档位）；基座变化审计 `tier-model-switch` 并清空 roleSessions，提示句附加到命令文本（旧子会话=旧模型，重委派一律新建）。

- **默认档位映射**：见上表 `tiers` 行（`options.tiers` 可覆盖）；workflow（primary）天然跟随会话模型，不接线
- **降级链**：请求档不在基座 variants 集合 → 强度序（off<low<medium<high<xhigh<max）向下取最近；无更低 → 继承会话默认档；**variants 为空 → 跳写**（纯继承，少 7 个派生文件）
- **variants 声明是宿主配置前置义务**（插件不创建；`settings.reasoningEffort` 不转发，须 variant body 直注——见上表 tierAgents 前置说明）；GLM/qwen 四档已真机验证
- **档位生效视图**：`/api/agent` 序列化不含 model 键——读项目级派生文件（`wf:ping` 附加行）或委派后子会话的 `Session.Info.model`

```jsonc
// 宿主 opencode.jsonc 变体声明样例（tu-coding 网关实测写法）
"providers": {
  "tu-coding": { "models": { "glm-5.3-flash": { "variants": [
    { "id": "off",  "body": { "reasoning_effort": "none" } },
    { "id": "low",  "body": { "reasoning_effort": "low" } },
    { "id": "high", "body": { "reasoning_effort": "high" } },
    { "id": "max",  "body": { "reasoning_effort": "max" } } ] } } }
}
// 插件 options：{ "tierAgents": true, "tiers": { "wf/builder": "off" } }
```

> **写法陷阱（借鉴 my-opencode-deepseek-config 真机实证，DeepSeek 场景验证）**：agent frontmatter 的 `options.*` 装不下 provider 设置（如 `reasoningEffort` 无效——`options` 只落到 `request.body`），思考档位须在**模型层**声明；headless `opencode run` 不读 `agent.model`（主会话按全局 `model` 解析）；子会话/命令绑定的一次性调用按 `agent.model` 解析。将来启用 `options.agentModels` 落地本表时，须先真机核验 GLM 的对应参数面再写 frontmatter。

## 观测与诊断

- 探针默认关闭；`WF_DEBUG=1`（或 server `options.probe:true`）时写 `.workflow/_debug/`（probeOnce 形状探针 / cmd-report.jsonl 广播记录 / tui-refresh.log TUI 生命周期）
- `/wf:diagnose`：审计轨迹拒绝分类计数、越权阻断取证、轮次余量告警、产物「state 记账 vs 磁盘」对账、注入/RPC 异常、下一步建议
- `/wf:debug`：全量状态快照落盘 `_debug/state.json` + 活跃任务枚举
- 状态 GC：done 且 14 天未更新的状态在任务枚举（RPC list）时自动清理；`wf.db` 的 `events` 表 append-only 保留审计

## 配置变更点速查

| 想改的东西 | 文件 | 说明 |
| --- | --- | --- |
| 流转语义 / 关卡 / 循环上限默认值 | `server/lib.ts` | FLOWS/GATES/LIMITS 单一来源，bun test 覆盖 |
| 阶段清单 / 侧边栏行序 | `shared/phases.ts` | server/TUI 共用；DAILY_STAGE_ORDER 可达集有守卫 |
| 阶段 guidance 文案 / 易变区顺序 | `server/guidance.ts` | 易变区纪律：静态在前、轮次/sessionID/head 殿后 |
| RPC 契约 | `shared/rpc.ts` | 改形状必须同步 `tests/rpc-drift.test.js` 快照 |
| TUI 渲染 / 侧边栏 | `tui/index.tsx` → `bun run build` | dist/tui.js 入库；结构冻结见 harness P4 |
| 角色行为 / 分级审查触发 / 拒绝契约 | `roles/*.md` | syncRoles 同步宿主；改后 `/wf:ping` 查漂移 |
| session-lookup skill 内容 | `skills/session-lookup/SKILL.md` | syncSkills（默认开启）同步宿主全局 skills 目录；改后需 `/reload` 或新会话生效 |
| 续接别名语法 / 近似截断阈值 | `server/lib.ts`（resolveSidAlias / isNearTruncation） | guidance/leader.md/SKILL.md 文案同源靠测试内容锚 |
| 产物预算 | `server/lib.ts`（ARTIFACT_BUDGET_KB / _S_KB） | guidance 双通道渲染 |
| 引擎自改并发护栏 | `server/lib.ts`（isSelfModDir/selfModWarnLine）+ `server/state.ts`（PROJECT_DBS+持久清单+scanActiveTasks 跨库扫描）+ `server/commands.ts`（intake 接线） | 任务目录=插件仓库根→跨项目扫描其它活动任务（活跃/休眠分级）告警+st.selfMod 记账；探测根可 `options.selfModRoot` 覆盖；清单路径钩子 `WF_PROJECTS_FILE`（测试隔离） |
| 观测 / 探针 | `server/observe.ts` + options | 默认关，`WF_DEBUG=1` 开 |
| 升级宿主 / 改流程语义 | 先读 `docs/UPGRADE.md` | 不变量、基线表、核对点、验收命令 |

## 开发与测试

```sh
bun install
bun run build    # vite 构建 dist/tui.js（TUI 源码改动后必须）
bun run check    # 门禁五合一：build → bun test → tsc --noEmit → oxlint → harness
bun run lint     # oxlint（correctness=error，warnings 不阻塞）
```

> 升级宿主版本或改动流程语义前，先过 `docs/UPGRADE.md`（不变量 → 基线表 → 宿主核对点 → 验收命令）。

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
| omo-slim 续接不靠模型抄 ID + terminal-gate | roleSessions 自动登记 + guidance 渲染续用指引零回显（A 层 r40，回显燃料已拆——截断前缀服务端就地自愈改写 + 别名/省略新建指路）+ subagent 续接守卫 + 存活探针（B 层 r41） | ✅ 采纳（父归属宿主原生已校验，不借 adoption/lease/job-board） |
| znlgis/my-opencode-deepseek-config（omo-slim 同源纯配置实践） | 两级审查+升级触发+线索确认（roles + guidance）；角色拒绝契约；guidance 易变区纪律（易变殿后）；docs/UPGRADE.md 升级核对流程 | ✅ 采纳（M16-r42）；thinking tiers / skill 名册预算 / 权限基线属宿主层，不引入 |
| 同上·thinking tiers（静态模型层档位） | M16-r43 动态档位跟随：会话所选基座 + TIER_MAP 派生项目级 agents（variants body 直注 reasoning_effort） | ✅ 变体采纳（5h 上限切模型场景驱动；档位词汇同源 off/low/high/max；非 DeepSeek 静态钉死） |
| Council 共识 / marketplace / multiplexer | — | ❌ 不照搬（场景/宿主不符） |

## 许可

MIT
