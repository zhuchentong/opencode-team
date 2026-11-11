# wf-workflow — OpenCode 工作流插件

8 角色 9 阶段开发工作流的**状态机与关卡层**：把「规划 → 审核∥可行性 → 测试设计(含分配) → TDD 执行 → 合并 → 执行审核 → 测试 → 修复 → 复盘」变成带硬约束的流转，越权改码被服务端阻断，产物与审计轨迹可诊断。角色（`wf/*`）内容自 M16-r31 起由本插件托管（仓库 `roles/` 单一来源 + 文件同步，宿主留 frontmatter/permissions），本插件负责流程管控（M16-r28：assign 并入 test_design；M16-r29：阶段纪律告警；M16-r30：冷启动自动 intake；M16-r31：角色内容插件托管——插件更新自动同步 agent 内容，根治版本漂移；M16-r32：产物瘦身预算——压生成与下游审核耗时）。

> 架构形态：P0-P6 重设计（2026-11）后的版本——状态层 SQLite、命令双轨输出、TUI 流派 A 渲染、vite/oxlint 工具链。设计依据与宿主契约证据见文末「宿主契约备忘」。

## 特性

- **状态机流转**：`/wf:*` 命令驱动，非法来源拒绝、返工边内置（review 不过回 planning、修复后回 reconcile）；流转带 `rev` 乐观锁，并发冲突自动重载重放（≤3 次），最终写不进则显式报错不静默丢推进
- **双入口推进**：模型侧 `wf_command` 工具（leader 用，参数 `name="wf:plan"`、`prompt` 传命令参数）与用户手敲 `/wf:*` 走同一编排（transition+注入+落库+广播）；`wf/*` 子会话调用被硬拒——关卡/上限不存在"模型忘了执行命令"的绕行路径
- **硬关卡**：`/wf:test-design` 双通道（须 test-plan 产出；M16-r28 起原 `/wf:assign` 阶段并入 test_design）；`/wf:done` 验收（须 test-report 首行 `**结论**: PASS`）；拒绝消息自带下一步命令指引（blocked-append）
- **循环上限**：plan_review / build_review / test_fix 各 3 轮，「进入即计数」，超限拒绝并要求上报用户
- **越权阻断**：planning/review 阶段服务端 `execute.before` hook 拒绝 `edit/write/patch` 与 shell 重定向/写删命令改**项目内**业务文件（`.workflow/`、`.learnings/`、测试文件除外；M16-r28：项目外路径不构成越权，放行），阻断记账进审计轨迹
- **抗 compaction 注入**：阶段 guidance 写入 session instructions entry（每次组装系统提示从存储重新渲染），消息历史压缩不丢阶段约束
- **产物管理**：`wf_write_artifact` 工具按 kind 落盘 `<项目>/.workflow/<slug>/`，循环类产物自动按轮次编号；test-report 输出按 verdict 指路下一步；slug 支持 Unicode（中文任务名原样保留）
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
/wf:review               # review：planner-reviewer ∥ tester(feasibility) 并发，≤3 轮（r≥2 增量复审）
/wf:test-design          # test_design：双通道关卡（须 test-plan.md）；冻结接口排 lane + tester(design) 写红验收测试
                         #（M16-r28：原 /wf:assign 阶段并入本阶段，命令移除；存量 assign 任务可直接推进本命令）
/wf:build                # building：每 lane 一 worktree + wf/builder（TDD）
/wf:reconcile            # reconcile：各 worktree 合并回主树
/wf:review-build         # build_review：builder-reviewer，≤3 轮
/wf:test                 # testing：tester(verify) → test-report.md（PASS|FAIL）
/wf:fix                  # fixing：≤3 轮；同 lane 回 builder / 跨 lane 用 fixer
/wf:done                 # done：验收关卡（PASS）+ 并行 learner 复盘
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
- **agent 文件热载（M16-r31 P0 真机实证）**：宿主全局 `agents/*.md` 的创建/编辑/删除**免重启即时生效**——经 `GET /api/agent` 读 `Agent.Info.system` 验证（scratch 探针 create→visible / edit→hot-reload / delete→gone 全过）。`Agent.Info.system`（string）= 角色提示词字段，frontmatter 映射 `description/mode/permissions`。此为角色内容插件托管（B1 文件同步）的地基；`ctx.agent.transform` 的 editor 无 `add`（文档），故不走 transform 而走文件同步
- **keymap**：`run` 返回 Promise 即算已处理（同步透传必须返回 `false`）；冒号命令名在宿主 slash 派发静默失效（主轨因此选 return 拦截形态）
- **杂项**：插件 id 含 `:` 与 storage 文件命名冲突；`@opencode/schema` 运行时版本错位会崩（依赖全 external 共享宿主实例）；宿主对 node_modules 不跑 TSX transform（发布前预编译）

## 已知边界（测试锁定现状）

- verdict 解析正则带 `i`：小写 `pass` 也判 PASS；`PASSED` 因 `\b` 边界不判
- intake 非重置分支下 slug 会被新 text 覆盖（rounds/记账保留）
- shell 写目标解析翻案（M16-r28 B1-1，真机实证误伤后修订）：`=>`/`->`/比较符不再误判为重定向；`tee out.txt < input` 不再把 `input` 当目标；目标含 `$/反引号/通配` 跳过。**残留边界（翻案的另一面，fail-open 方向）**：代码字符串里的 ` > `（两侧带空格的比较）后跟「含点/斜杠 token」仍会误判（如 `'s/a. b/ > c.d/'`）；无扩展名无斜杠的裸重定向（`echo x > build`）不再识别（漏判）
- BLOCKING 阶段 containment（M16-r28）：越权判定仅对**项目内**路径生效（write/edit 与 shell 两分支同源）；`st.directory` 解析不到时按项目内处理（fail-closed 兜底）
- M16-r28 assign 阶段移除：`wf:test-design.from` 保留 `"assign"` 存量兼容边（`LEGACY_PHASES` 守卫）；卡在 assign 的在途任务下一步指引 = `/wf:test-design`，直接推进即可
- M16-r29 阶段纪律（真机 auth-login r28 实证：leader 提前委派 reviewer/tester 致产物重复写）：planning/intake guidance 增「禁止提前委派」文案；`wf_write_artifact` 对产物错位（`ARTIFACT_PHASE` 映射）**告警不阻断**（落盘/记账照常）；中途 `!intake` 强制重置清空产物记账时输出账实不符告警（done 后正常换任务、无产物记账不告警）。**边界**：告警仅提示，不强制拦截提前委派——leader 行为约束仍靠 guidance；`lessons` 期望 done，若复盘提前写会告警
- M16-r30 冷启动自动 intake（真机实证：wf/leader 收到开发任务从不调 wf:intake——宿主 leader.md 无 intake 指令、技能仅触发词加载）：`wf_command` description 注入「冷启动铁律」（无任务+开发任务→第一步立即 intake，slug 从需求提炼；不足先澄清；普通问答不开任务），与宿主 `agents/wf/leader.md`/`skills/wf-workflow/SKILL.md` 同源同步（9 阶段、删 assign）。**边界**：提示词级软约束，非硬拦截——工具可见性本身不足以触发行为（失败会话插件已加载仍不 intake），行为裁决以真机 wf.db 首个 event 为准；宿主文件在仓外，漂移需人工同步
- M16-r31 角色内容插件托管（B1 文件同步，根治宿主角色文件与插件版本漂移）：仓库 `roles/` 8 模板单一来源，阶段链从 `PHASE_ORDER`+`FOLD` 动态渲染（流转变更自动传播）；setup 在 `options.syncRoles=true` 时写宿主 `agents/wf/*.md` 的 **body**（保留 frontmatter/permissions），宿主文件热载生效（P0 实证）。安全：写前备份 `.bak-<ts>` + 首行托管标记 `<!-- wf-workflow:managed version= hash= -->` + **无标记文件不覆盖**（unmanaged 跳过+告警）+ 内容 hash 一致跳过（避免无谓热载）。`wf:ping` 附角色托管漂移守卫（managed/stale/unmanaged/missing）。**边界**：opt-in（默认关）；`missing` 不自动创建文件（保守，需用户先装骨架）；hash 基于「去标记行的实际 body」重算（只比标记行 hash 会漏判内容漂移）；技能 SKILL.md 暂未纳入托管（仍人工同步）；transform 路线（不写文件）因 editor 无 add 且 API 未实证而降为可选未来增强
- M16-r32 产物瘦身预算（真机 auth-login 实证：plan.md 40KB 生成 ~6.6min，耗时与体积成正比，wf_write_artifact 本身毫秒级）：`ARTIFACT_BUDGET_KB` 软预算（plan 15 / plan-review 8 / test-plan 10 / build-review 8 / test-report 10 / lessons 6 KB）写入对应 `roles/` 模板（表格化/只留要点/禁冗长散文），planner 另加「返工增量修订」；`wf_write_artifact` 超预算**告警不阻断**（落盘/记账照常，与 r29 阶段告警同模式）。**边界**：软约束非硬拦截，体积收敛看真机；预算只压产物生成，不改变流转语义；经 r31 角色托管自动同步宿主
- hook 内部异常 fail-open（不阻断），关卡异常（含 `GATE_ERR`）才拦截
- 降级轨消息注入会话历史（context/compaction/generate hook 剥离仅护模型面，用户面保留可读）
- `wf_command` 子会话判定依赖 agent 名前缀 `wf/*`（2.2.6 真机实证 `session.get` 无 `parentID`）：非 wf 命名的自定义 subagent 可经 `wf:intake` 自开任务——新行挂其自身会话，不污染 leader 行，代价仅面板出现其合法任务行；若需收紧，待宿主暴露父子会话关系后改 parentID 判定
- `transition` 在 save 连续冲突（3 次）失败时回滚 entry 指引（T09），但 reports 槽/事件通道的时间戳不回滚——用户以 `/wf:status` 为准

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
