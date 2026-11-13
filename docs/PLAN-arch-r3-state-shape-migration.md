# PLAN — arch-r3-state-shape-migration（R3 形状迁移批次，待执行）

> **状态：计划已定稿，未执行。** 本文档自包含，供任意设备上的执行者（leader 或 Build Agent）
> 直接照做。执行前必读 §1 前置核对与 §2 红线；所有行号/清单以 `07fa0c2` 为盘点基线，
> **动手前必须按 §3.0 方法对当前态重测**（edit 防撞纪律，LRN-20261112-001）。
>
> 上游脉络：架构评审 → 方案 v1 → 设计模式建议 → 方案 v2 → 独立验证（I-1~I-4/S-1~S-6）→
> v2 修订版。R1（`664cc14` 机械重构）与 R2（`07fa0c2` 模式收敛）已交付并推送 origin/master。
> **R1/R2 交付内容与模块地图见 §0.1–0.4（跨设备执行的前置知识，R3 全部锚点建立其上）。**
> R3 是重构三部曲的最后一批，也是**唯一动持久化形状**的一批——风险最高，纪律最严。
> 后续另有 `PLAN-agent-phase-latency-optimization-v3.md`（阶段耗时优化），其自述排在 R1/R2/R3
> 之后启动；本批不依赖它，但它的 P0-A（mock bootstrap 根修）若先做可省本批 worktree 环境税（§7.4）。

## 0. 结论与目标

R3 = 把 R1/R2 收敛好的"形状"落到**持久化层与类型层**，四个功能点 + 一个可选微修：

| 任务 | 一句话 | 风险 |
|---|---|---|
| T3.1 | WfState 平铺字段分组为子对象，「读兼容、写新形」迁移，删两处索引签名 | 高（动 stateJson） |
| T3.2 | Branded Types：SessionId/SidRef 双形态，零回显进类型系统 | 中（纯类型层，运行时零变化） |
| T3.3 | Outbox 正名：Report 对象化 + 去重单实现（server/TUI 共用纯函数） | 中（动 wire 投影，required 不动） |
| T3.4 | tui/index.tsx 拆模块（vite 仍出单 dist，流派 A 约束本体不动） | 中（动 TUI，须真机验证） |
| 微修 | mock bootstrap 根修（可选前置，见 §7.4） | 低 |

**总原则：挪形状、不磨语义。** 所有真机事故换来的不变量（CAS 三态、❌/【互斥、entry key、
流派 A、wire required、零回显）原样保留；R3 只改"数据放在哪个字段/哪个模块"，不改"行为是什么"。

**出口判据（量化，全部须达成）：**
1. 旧形状（平铺）DB 行可正常读写——4 个子步各含「旧 JSON → normalize → 行为等价」跨版本用例。
2. `WfState` 与 `FlowLogEntry` 两处 `[key: string]: unknown` 索引签名均删除；新字段须过
   `tests/wfstate-fields.test.js` 字段名集快照登记。
3. wire required 数组零变化（`tests/rpc-drift.test.js` 全绿）；TUI 消费面零改动（投影层吸收形状差）。
4. TUI 去重逻辑有独立单测（`createDeduper` 纯函数）。
5. `bun run check` 五合一 EXIT=0（build → bun test → tsc --noEmit → oxlint → TUI harness）。
6. 真机跑通一个 `[S]` daily 任务全程到 done（README 验证清单 5 条 + 侧边栏不崩）。

### 0.1 R1 已交付 — 机械重构（commit `664cc14`，52 files，+2363/−1437）

> 行为不变重构；过程产物在 `.workflow/arch-r1-host-split/`（**gitignore 本机文件，跨设备不可见**，
> 交付事实以本节 + `git show 664cc14` 为准）。

- **lib.ts 842→15 行 barrel**：纯逻辑按域拆 `server/domain/{types,flow,guard,artifact,session,report,policy,diagnose}.ts`。
  `types.ts` = 零依赖叶子（共享类型+常量唯一来源）；domain 内部边白名单 = 任意→types + diagnose→{flow,artifact,session}；
  domain 禁 import 编排层（`tests/domain-acyclic.test.js` 守卫）。35 个 import 方经 barrel 零改动。
- **server/host.ts 防腐层**：`adaptHost(ctx)` 是全仓唯一收裸 ctx 的函数；11 文件 50 处 `ctx.` 直戳收敛；
  `tests/host-boundary.test.js` 守卫（audit 口径剥注释/字符串）。宿主升级爆炸半径 15 文件→1。
- **swallow() 环形审计**：observe.ts ring buffer（≤200 FIFO）；66 处静默 catch 清零（探针 3 处除外）；
  diagnose 🔇 摘要节；**code 前缀=文件基名**（`tests/swallow-coverage.test.js` 守卫——R3 新文件写 swallow 须遵守）。
- **managed-sync.ts**：roles/skills 托管同步泛型抽取（内容零触碰）。
- **tests/helpers/ 装配同源**：host-stub/store-stub/command-deps/wiring 四件；mock 形状与真实接口同源。
- 基线：351 测试；lib 导出 62 名锁（`tests/lib-exports.test.js`）；6 新守卫测试。

### 0.2 R2 已交付 — 模式收敛（commit `07fa0c2`，29 files，+915/−398）

> 行为不变重构（HEAD 对比 42 组输出逐字节零差异）；过程产物在 `.workflow/arch-r2-profile-statemachine/`
> （同上，跨设备不可见）。**R3 的全部锚点建立在本节形状之上。**

- **Strategy**：`WorkflowProfile` 注册表（`PROFILES` full/daily 模块自注册；`profileOf(st)` 是 isDaily
  唯一消费点）；`flowFor/gateFor/nextFor` 签名不变、内部读 profile；guidance 经 `GUIDANCE_BY_ID` 按
  profile.id 派发；`tierOf` 归一 + `DISPATCH_BY_TIER`（`st.size ===` 字面清零）。
- **State Object**：`PHASES_FULL/PHASES_DAILY`（PhaseDef{next,blocking}）单点注册；`NEXT/NEXT_DAILY`
  降为派生视图（值逐字不变）；guard-hook blocking 判定读 profile（miss 回退全局 BLOCKING Set）。
- **Specification**：`GATES/GATES_DAILY` 值 = **Gate 对象 `{id,isSatisfiedBy(st),explain(st)}`**（非函数！）；
  文案迁 `shared/prompts/gates.ts`；`st.gateStatus={id,ok,at}` 快照（evaluateTransition 覆写、intake 清除）；
  levelFor R0 结构化判定（❌ 扫描兜底保留）；diagnose 细化 note `gate-rejected:<id>` 按 base 归组 + └ 明细行。
- **解环**：`server/transition.ts`（createTransition：load→校验→应用→inject→save 编排，含计时闭账/
  done-git/selfmod 写点）；`server/command-bus.ts`（**runner 可变盒子已退役**，index 装配期建 bus，
  rpc-bridge/command-tool/commands 三入口共享，`bus.call` 返回 {text,at,brief,level}）；
  `makeInitialWfState`/`REJECT_NOTES`/`WfError` 入 types 叶子。
- **Pipeline**：`server/middleware.ts`（leaderGate×tierSync，`CMD_MW_ORDER` 声明 + tests/middleware.test.js 锁序）；
  `renderReport`（domain/report.ts，文本链单点，旧 sanitizeText 平移）。
- 基线：**369 测试 / 42 文件**；lib 导出锁 **62→70 名**；commands.ts 680→430 行；
  swallow code 前缀随迁移改名（transition:*/middleware:*）。

### 0.3 R2 后模块地图（R3 锚点的前置知识）

| 文件 | 职责（R2 后） | R3 触点 |
|---|---|---|
| `server/domain/types.ts` | 域类型叶子：WfState（**仍平铺+索引签名**）/FlowLogEntry/Gate/PhaseDef/WorkflowProfile/REJECT_NOTES/tierOf/makeInitialWfState | T3.1 分组+删索引签名；T3.2 branded 类型 |
| `server/domain/flow.ts` | PROFILES/PHASES/GATES（Gate 对象）/evaluateTransition（gateStatus 写点、intake 重置块） | T3.1 子步 B/C/D：verdict 读点+重置块改子对象 |
| `server/state.ts` | SQLite tasks/events/reports；writeTaskRow CAS；withStateRetry；rowToState（约 :220） | T3.1 normalize 插入点（load 出口）；**CAS 红线零改** |
| `server/transition.ts` | createTransition 编排（timing 闭账/done-git/selfmod 写点、makeInitialWfState） | T3.1 子步 A/D 写点改子对象 |
| `server/middleware.ts` | leaderGate×tierSync（tierBase/roleSessions 读写） | T3.1 子步 C |
| `server/commands.ts`（430 行） | 命令注册表 + publishOutput/injectReport 双轨 + 辅助命令 | T3.1 status 显示读点；T3.3 publishReport 收敛 |
| `server/command-bus.ts` | bus.call dispatch（未知命令 ❌/brief/level） | T3.3 Report 对象化（dispatch 返回形状） |
| `server/rpc-bridge.ts` | state 投影（st 扁平字段→wire schema，约 :42-50） | T3.1 投影层改读子对象（**wire 形状不变**） |
| `server/domain/session.ts` | resolveSidAlias/completeSidPrefix/isNearTruncation（运行时别名协议） | T3.2 SidRef 唯一构造点 |
| `server/domain/report.ts` | levelFor（R0 gateStatus+R1 ❌）/briefFor 分派/clipBrief/renderReport | T3.1 verdicts 读点；T3.3 brief/level 生成不动 |
| `shared/rpc.ts` | wire 契约（required 数组锁，rpc-drift 快照） | T3.3 只扩 properties |
| `shared/prompts/gates.ts` | 关卡文案模板（字节级红线） | T3.1 子步 B 取值点（文案本体不动） |
| `tui/index.tsx`（692 行） | 流派 A slot render + shown Set 手写去重（:363-400，60s 门+cap50） | T3.3 createDeduper 替换；T3.4 拆模块 |
| `tests/`（369 基线） | lib-exports 70 名锁 / rpc-drift 快照 / domain-acyclic / host-boundary / swallow-coverage 等守卫 | R3 安全网；新锁 wfstate-fields/dedup |

### 0.4 R1/R2 有意未做（= R3 的边界，勿重做已交付项）

| 未做项 | 现状 | R3 任务 |
|---|---|---|
| WfState 分组 | 仍 30+ 平铺字段；R2 仅**新增** gateStatus 扁平字段（分组留给 R3） | T3.1 |
| 索引签名 | WfState（types.ts:83）与 FlowLogEntry（:24）两处 `[key: string]: unknown` 仍在 | T3.1 子步 D |
| 零回显类型化 | 运行时防线已齐（登记/别名/自愈/渲染纪律），但纪律只在注释 | T3.2 |
| 去重单实现 | exec/事件/轮询三通道 + TUI shown Set 各自手写（语义一致但无单点） | T3.3 |
| tui 拆模块 | 单文件 692 行（流派 A 约束下可拆，R2 未动 TUI） | T3.4 |
| mock bootstrap 根修 | R1 环境层绕过（代码点级拼接已修）；ESM 首跑时序残留 | 可选微修 §7.4 |

> 验证报告（I-1~I-4/S-1~S-6）原文为本地会话产物未入库；其结论已全部吸收进本文档
> （types 叶子/装配分层/GATES 串行/tui 拆分/SidRef 双形态/口径修正等），跨设备执行以本文档为准。

## 1. 前置核对（执行第一步，不可跳过）

```sh
cd <项目根>                      # opencode-team 仓库
git log --oneline -3             # 须见 07fa0c2(R2) 与 664cc14(R1)；若 HEAD 已前进，重读涉及文件当前态
git status --porcelain           # 须干净；有 carryover 先与用户确认处置
bun install                      # 干净环境首装
bun run check                    # 基线门禁须 EXIT=0（369 pass 起步；若基线已红，停下查因，勿带病开工）
```

**全局清场（R3 特有，动持久化形状前的操作层保险）：**
- 本插件被运行中宿主按内容指纹热载，且状态库分散在各项目 `.workflow/wf.db`。R3 改 stateJson
  形状后，**旧代码读不了新形状**——必须确保没有其它项目跑着本插件的旧 checkout。
- 用 selfmod 护栏的跨库扫描确认无其它活动任务：`scanActiveTasks`（state.ts）会扫
  `PROJECT_DBS ∪ ~/.local/share/opencode/wf-projects.jsonl`。执行者应在 intake 告警面板核对，
  休眠任务先 `/wf:status` 核实归属，经用户裁决 done 收尾或 reset 清账（R1 先例：implant-consult
  与 p1-verify 均 reset）。**清场是操作层保险，normalize 读兼容是代码层保险，两者都要。**
- 建议走 **full 模式** wf 流程（`wf:intake [FULL][L] arch-r3-state-shape-migration`）：动持久化
  形状值得 plan-review / test-design 红测试 / build-review 三级审核全开。若用户选择 Build Agent
  直执行（R2 先例），则本文档 §3~§6 的验收表即审核锚，§7 纪律不可省。

## 2. 红线保护清单（全程禁改语义，对应守卫测试）

| 红线 | 守卫 |
|---|---|
| `writeTaskRow` 单语句 CAS / `withStateRetry` 三态（ok/stale-rev/write-error） | retry.test.js / state-db.test.js |
| `REJECT_PREFIX` ❌ 与成功 guidance【互斥；levelFor 兜底扫描不删 | brief-level.test.js |
| entry 通道 key（`wf.phase`/`wf.hint`）+ 抗 compaction 重渲染 | flows.test.js 接线断言 |
| TUI 流派 A：禁 JSX / 恒定容器 / 单 `insert(accessor)`；dist 单文件入库 | harness P4 静态守卫 |
| wire required 数组 / rpc 快照形状 | rpc-drift.test.js |
| 零回显：模型可见文本不出完整 `ses_` ID | sid-reliability.test.js + T3.2 类型化 |
| selfmod `WF_PROJECTS_FILE` 测试隔离（bunfig preload） | selfmod-guard.test.js |
| 关卡拒绝文案 blocked-append「自带下一步」 | daily-mode / flows / plan-confirm |
| domain/types.ts 零依赖 + domain 不 import 编排层 | domain-acyclic.test.js |
| 入口文件禁分步连续 edit（一次 write 或每中间态合法） | 热载纪律，LRN-20261109-004 |

**操作纪律：** 每任务独立 commit、批次打 tag；worktree 隔离作业（主树被热载，全程不碰）；
`.workflow/**` 产物修订只用 patch 或先 read；合并窗口服从清场结果。

## 3. T3.1 — WfState 分组 + 「读兼容、写新形」（核心，最高风险）

### 3.0 方法纪律（每个子步开工前必做）

依据 LRN-20261112-001（模块拆分消费方清单不完整事故）：**对每个将迁字段做符号级 grep 全仓实测**
（`server/ tests/ tui/ tui-tests/ shared/` 全覆盖），且包含**导出集锁/快照守卫测试**
（lib-exports.test.js 70 名锁、wfstate-fields 新锁、rpc-drift 快照）——纯 import grep 会漏。
勿信本文档清单"已 grep 过"，下表是 `07fa0c2` 盘点基线，**执行时以重测为准**；数字不符以实测为准
并在执行记录中说明。禁以源字段 re-export 兜底漏改消费方（会 reintroduce 漂移）。

### 3.1 目标形状

```ts
// server/domain/types.ts —— WfState 分组后（核心热路径字段保留扁平）
export interface WfState {
  // 扁平保留（热路径/查询投影列/高频读）：
  sessionID?; rev?; projectID?; directory?; createdAt?; slug?; phase?;
  size?; mode?; rounds; updatedAt?; prev?; lanes?; artifacts?; log?; logSeq?; entryErr?;
  // 分组子对象（全部可选，存量快照自然缺省）：
  timing?:   { startedAt?: string; phaseEnteredAt?: string; phaseDurations?: Record<string, number>; finishedAt?: string };
  verdicts?: { planReview?: string; testReport?: string; testPlanWritten?: boolean; confirmedAt?: string; gateStatus?: { id: string; ok: boolean; at: string } };
  reuse?:    { roleSessions?: Record<string, { sessionID: string; at: string }>; tierBase?: { providerID: string; id: string; variant?: string; at: string } };
  delivery?: { doneGit?: { isGit: boolean; hasRemote: boolean }; selfMod?: boolean };
  _ext?: Record<string, unknown>;   // 取代 [key: string]: unknown（索引签名收尾）
}
```

字段映射（旧扁平 → 新子对象）：
- `startedAt/phaseEnteredAt/phaseDurations/finishedAt` → `timing.*`
- `planReviewVerdict→verdicts.planReview`、`testReportVerdict→verdicts.testReport`、
  `testPlanWritten→verdicts.testPlanWritten`、`planConfirmedAt→verdicts.confirmedAt`、`gateStatus→verdicts.gateStatus`
- `roleSessions/tierBase` → `reuse.*`
- `doneGit/selfMod` → `delivery.*`

> 命名注意：verdicts 子对象内字段去掉 `Verdict`/`plan` 前缀（planReview/testReport/confirmedAt），
> 消费点改写时勿机械保留旧名。gateStatus 保持 R2 形状（id/ok/at）整体迁入。

### 3.2 迁移机制（决策已定死，防执行时摇摆）

1. **DB 列不动**：tasks 表的 `slug/phase/project_id/directory/is_active/rev/updated_at` 是查询投影列，
   只有 `state_json` 形状变。`scanStates`/GC/events 读列不读 JSON，不受影响（已核 state.ts）。
2. **归一在 load 出口**：`state.ts` 的行→快照解析（模块级纯函数 `rowToState`，约 :220-222）后接
   `normalize(st)`：把旧扁平字段搬入子对象，**内存恒新形**；`save` 写新形。
   - `normalize` 必须**幂等**：已是新形的快照原样通过（子对象存在则不重复搬）；旧扁平字段搬入后
     从顶层 delete（避免双份）。混合形状（部分子对象+部分扁平）也要正确收敛。
   - **不做双写镜像**（冗余字段=新漂移源，v2 验证已否决）。
3. **wire 形状不变**：`rpc-bridge.ts` 的 state 投影层（约 :42-50 读 `st.testPlanWritten/st.planReviewVerdict/
   st.startedAt` 等）改从子对象取值组装**现有 schema 字段**——`rpc-drift.test.js` 快照应保持绿，
   它是本任务的安全网；**TUI 零改动**（T3.4 才动 TUI）。
4. **intake 重置块同步**：`flow.ts evaluateTransition` 的 intake 重置（delete 扁平 verdicts/doneGit/
   selfMod/timing 字段处）改为 delete 子对象内字段或整组重置；`transition.ts` 的计时闭账/done-git/
   selfmod 写点改子对象访问。
5. **索引签名收尾**：删 `WfState`（types.ts:83）与 `FlowLogEntry`（types.ts:24）两处
   `[key: string]: unknown` → `_ext?: Record<string, unknown>`；新增 `tests/wfstate-fields.test.js`
   字段名集快照（顶层键 + 各子对象键），新字段须显式登记否则红。

### 3.3 四个子步（串行，每步独立 commit + 跨版本兼容用例）

**子步 A — timing**（消费面基线@07fa0c2）：
`server/domain/flow.ts`、`server/domain/types.ts`、`server/rpc-bridge.ts`、`server/transition.ts`、
`tests/flows.test.js`、`tests/rpc-drift.test.js`、`tui/index.tsx`（仅投影读点，TUI 经 wire 不直接读 st，
实际 TUI 零改——以重测为准）、`tui-tests/tui-render.harness.ts`。
- 验收：旧快照（含 startedAt 等扁平）load 后 timing 子对象成形；流转计时闭账行为逐字不变
  （flows.test.js 计时组 A1-A6 全绿）；rpc state 投影 4 字段值不变（rpc-drift 绿）。

**子步 B — verdicts**（消费面最广，26 文件基线）：
`server/artifact-tool.ts`、`server/commands.ts`、`server/domain/{diagnose,flow,report,types}.ts`、
`server/guard-hook.ts`、`server/guidance.ts`、`server/rpc-bridge.ts`、`server/state.ts`、
`shared/prompts/gates.ts`（文案模板读 verdict 参数，改取值点）、`shared/rpc.ts`（schema 不动，仅核）、
`tests/{artifact-patch,artifact-register,brief-level,daily-mode,diagnose,done-git,flows,helpers-contract,
plan-confirm,plan-invalidate,rpc-drift}.test.js`、`tests/helpers/store-stub.js`、`tui/index.tsx`、
`tui-tests/tui-render.harness.ts`。
- 验收：GATES 判定（isSatisfiedBy 读 verdicts.*）行为不变；plan-confirm/plan-invalidate 清零链路绿；
  artifact verdict 记账绿；levelFor R0/R3 读 verdicts 绿；diagnose 关卡视图绿。

**子步 C — reuse**：
`server/commands.ts`、`server/domain/{flow,session,types}.ts`、`server/guard-hook.ts`、
`server/guidance.ts`、`server/middleware.ts`、`tests/{artifact-register,brief-level,session-reuse,
sid-reliability}.test.js`。
- 验收：roleSessions 自动登记/续用指引零回显不变（session-reuse/sid-reliability 绿）；
  tierBase 切模型检测+清 roleSessions 不变（middleware tierCheck）；guidance reuseLines 渲染不变。

**子步 D — delivery/selfMod + 索引签名收尾**：
`server/commands.ts`、`server/domain/{flow,policy,report,types}.ts`、`server/guidance.ts`、
`server/host.ts`（核，应零改）、`server/index.ts`（核）、`server/transition.ts`、
`tests/{brief-level,done-git,host-boundary,lib-exports,selfmod-guard}.test.js`。
- 验收：done-git 交付确认渲染不变（done-git A1-A5/F4 绿）；selfmod 告警/隔离不变（selfmod-guard 绿）；
  两处索引签名删除；wfstate-fields 快照锁建立；lib-exports 70 名锁随新增导出同步（如有）。

### 3.4 T3.1 总验收

- 4 子步各含「旧扁平 JSON → normalize → 与 HEAD 行为等价」用例（隔离对比法见 §9.2）。
- `grep -rn "\[key: string\]: unknown" server/domain/types.ts` 返回空。
- 全量 `bun test` 绿；`bun run check` EXIT=0；rpc-drift 快照零变化。
- 真机：旧任务（R2 期间建的平铺快照）继续推进不报错（读兼容实证）。

## 4. T3.2 — Branded Types：零回显进类型系统（纯类型层，运行时零变化）

### 4.1 背景

长 ID 死循环史（M16-r40/r41/r45 三轮事故）：LLM 凭记忆复述 `ses_…` 长 ID → 截断 → 守卫回显纠正 →
再转录，经 instructions.entry 抗 compaction 每调用在场自我强化。现运行时防线已齐（roleSessions 自动
登记 + 别名/省略新建指路 + 截断前缀就地自愈 + 零回显渲染），但「sid 不进渲染文本」纪律只写在注释里。
T3.2 把它升格为**编译期事实**。

### 4.2 设计

```ts
// server/domain/types.ts（或 session.ts，依 domain-acyclic 规则定——types 叶子优先）
declare const sidBrand: unique symbol;
export type SessionId = string & { readonly [sidBrand]: true };   // 裸 string 不可赋值

// SidRef 双形态（对齐 SID_ALIAS_USAGE 协议：auto ∥ lane 登记后 @Tnn）——v2 验证 S-4 修订
export type SidRef = { form: "auto" } | { form: "lane"; lane: string };
// 唯一构造点：roleSessions 登记读取 或 resolveSidAlias() 解析结果；不可从字面量构造。
// 唯一渲染出口：
export function sidRefText(ref: SidRef): string;   // 产出 'sessionID="auto"' 或 '"@Tnn"'，永不产出裸 ID
```

- `Slug` 同法轻处理：`type Slug = string & {…}`，`slugify` 唯一构造点。
- 渲染层函数（guidance reuseLines、guard-hook 拒绝文案、command-tool 返回）签名收 `SidRef`，
  其 toString/模板插值只经 `sidRefText`——「渲染文本含裸 sessionID」变成不可编译。
- **运行时协议零变化**：resolveSidAlias/completeSidPrefix/isNearTruncation 的输入输出形状不动
  （sid-reliability/session-reuse 锚的是运行时行为，必须全绿）；branded 类型只在编译期约束构造路径。

### 4.3 验收

- `tsc --noEmit` 零错误；故意写 `const s: SessionId = "ses_x"` 应编译失败（负例验证后删除）。
- sid-reliability / session-reuse / selfmod-guard 全绿（运行时行为不变）。
- 零回显不变量测试（brief-level「无 ses_」断言）仍绿；新增「SidRef 渲染不含裸 ID」类型级用例。
- 依赖 T3.1 子步 C（reuse 分组）先落地——roleSessions 已在 reuse 子对象，构造点取值路径稳定。

## 5. T3.3 — Outbox 正名：Report 对象化 + 去重单实现

### 5.1 背景

r29e 事故（server emit 成功但 TUI 零接收）后演化出 Outbox 野生形态：**reports 表=outbox（事实源），
事件=机会性加速通道，TUI 轮询=对账投递，`sessionID|at`=幂等消费键**。概念自洽但无名义，导致每个
消费方（exec 返回/事件回调/轮询）各自手写去重。T3.3 给已存在的正确设计穿上模式外衣。

### 5.2 设计

```ts
// shared/report.ts（新，shared 下层——server 与 TUI 均可 import，合法）
export interface Report { id: string; at: string; text: string; brief: string | null; level: ReportLevel | null }
// id = `${sessionID}|${at}`（幂等消费键，单一生成点 reportId()）
export function reportId(sessionID: string, at: string): string;

// 去重纯函数（server/TUI 共用）——取代 tui/index.tsx:363-400 的手写 shown Set + 60s 门 + cap50
export function createDeduper(opts?: { ttlMs?: number; cap?: number }): {
  seen(key: string, now?: number): boolean;   // true=首次（应处理），false=重复/过期（应跳过）
};
// 默认 ttlMs=60000, cap=50（与现 TUI 行为逐字一致：60s 新鲜度门 + FIFO 淘汰最旧）
```

- server：`publishReport()` 单实现「先持久化（reports 表）后广播（事件，机会性）」契约；
  `commands.ts publishOutput` 收敛为调用它（brief/level 生成逻辑不动）。
- TUI：`tui/index.tsx` 的 `shown` Set + stale 门 + cap 段（约 :363-400）删出，改 import
  `createDeduper`；`toastReport` 仅调用。三通道（exec/事件/轮询）共用同一 deduper 实例。
- `shared/rpc.ts`：report 事件 / exec output **只扩 properties 不动 required**（沿 brief/level
  兼容先例，旧 TUI 不炸）；如加 `id` 字段，nullable + required 不变。
- `docs/HOST-CONTRACT.md`：补一节以 **Transactional Outbox** 命名此契约（关联 r29e 事故记录），
  写明「reports 表事实源 / 事件机会性 / 轮询对账 / sessionID|at 幂等键」四要素。

### 5.3 验收

- rpc-drift.test.js：required 数组零变化（快照 review 后更新 properties 部分）。
- 新增 `tests/dedup.test.js`：createDeduper 首见/重复/过期/淘汰四态 + cap 边界（纯函数直测）。
- TUI harness：dedup 行为断言（原 :398-400 逻辑等价）；真机三通道不二次弹 toast。
- `bun run check` EXIT=0；HOST-CONTRACT.md Outbox 节落盘。

## 6. T3.4 — tui 源码拆模块（vite 仍出单 dist，流派 A 本体不动）

### 6.1 设计

`tui/index.tsx`（692 行@07fa0c2）拆为：
- `tui/panel.tsx` — 侧边栏渲染（状态列/阶段行/产物清单/耗时列）
- `tui/dedup.ts` — T3.3 迁入的 createDeduper 消费封装（若 T3.3 已落 shared/report.ts，此处仅薄封装）
- `tui/exec-intercept.ts` — return 键拦截 / 主轨 exec 调度
- `tui/notify.ts` — toast + attention.notify 通知层
- `tui/index.tsx` — 仅留 slot render 顶层（恒定容器 + 单 `insert(accessor)`）+ 装配

**约束（不可违反）：**
- 流派 A 结构约束（禁 JSX 低层原语之外的写法 / render 顶层零响应式 / 唯一动态点=容器内一条
  `insert(accessor)`）仅约束 index.tsx 的 slot render 顶层；子模块不受此限，但**不得把响应式读取
  泄漏回 render 顶层**（真机崩溃形态 `e.length`，见 HOST-CONTRACT.md / LRN-20261111-006）。
- `vite.config.ts`：多源码 → **单入口打包**，`dist/tui.js` 仍是一文件入库（宿主对 TUI 插件模块
  路径级永久缓存，`/reload` 不重读 TUI——改 TUI 必须 `bun run build` + `./scripts/tui-restart.sh` 完全重启）。
- harness P4 静态守卫（全文件禁 `<box`/`<text` 等）范围随拆分更新 import 面，**约束本体逐字保留**。

### 6.2 验收

- `bun run build` 产出 dist/tui.js；`bun tui-tests/tui-render.harness.ts` 全绿（186 起步）。
- 真机验证清单第 1 条：开 session → 侧边栏 `── Workflow ──` 面板正常渲染**不崩**；
  `/wf:intake probe-test` → toast + 面板刷新 + entry 块出现。
- index.tsx 行数显著下降（目标 ≤200 行，仅装配+slot 顶层）；子模块各自可独立阅读。

## 7. 执行纪律（引擎自改场景，全程适用）

### 7.1 worktree 隔离
- 主树被运行中宿主按内容指纹热载——**R3 全程只在 worktree 内改业务代码**，主树保持干净直到合并。
- 建树：`worktree_create`（opencode 工具）或 `git worktree add`；树内 `bun install`。
- 基线陷阱：worktree 基于 HEAD 建树，主树未提交 carryover 不在树内——§1 已要求主树干净。

### 7.2 入口文件一次成型
- `server/domain/types.ts`、`server/state.ts`、`server/index.ts`、`tui/index.tsx` 等入口/热载面文件
  **禁分步连续 edit**（中间态会被同进程其它项目会话真实执行，双任务日志实证）。多 hunk 改动一次 write，
  或保证每个中间态语法+语义合法（先增 import → 改体 → 清旧 import 的合法序）。
- 非入口文件可常规 edit，但批量重写后必须重新 read 再 edit（old 锚点失效=撞车主因）。

### 7.3 合并窗口（reconcile）
1. builder/执行者回执齐备（含红→绿证据）后，leader 合并树内产物回主树。
2. **md5 逐字节核验**每个变更文件（R1/R2 先例：29/42 项全一致）。
3. 主树跑 `bun run check` 全量验证（树内绿≠主树绿，环境可能不同）。
4. 数字不符/冲突 → 停下问用户，不自动解决。
5. 清理：先 `rm` 树内已合并的 untracked 副本 → `git restore .`（tracked M 也阻塞非 force 移除，
   ERR-20261113-001）→ `worktree_remove`（非 force；force 仅在用户明确确认后）。

### 7.4 可选前置微修（mock bootstrap 根修）
- 病灶：`tests/{integration,artifact-patch,artifact-register,leader-only}.test.js` 四处
  `${mockDir}package.json` 缺尾部 `/`，干净 node_modules 首跑必红（R1 期间环境层绕过，根修未做）。
- 彻底解需 preload 级改动（ESM import 提升使文件生成晚于解析）——见
  `PLAN-agent-phase-latency-optimization-v3.md` P0-A（单点化进 tests/_preload.js + 守卫测试）。
- **与本批关系**：若先执行 P0-A 可省 R3 每个 worktree ~7min 环境税；不阻塞 R3（R3 可沿用 R1/R2 的
  环境层补齐做法）。执行者自行决定是否插此微修，决定记入执行记录。

### 7.5 交付确认（git）
- 顺序固定「总结 → 提交/不提交 → 完成」；经验沉淀（learner 回执或自写 lessons）落盘后才发起确认。
- 用 question 询问用户（选项标签固定：提交并推送/仅提交/跳过；无 remote 隐藏推送）；
  **未经批准不得 commit/push**；批准后先跑 `bun run check` 通过才提交。
- 提交范围=本任务代码 + .learnings/（若项目选择入库；本仓库 .gitignore 历史 ignore .learnings/，
  以当前 .gitignore 为准）；只暂存相关文件；提交信息=中文约定式提交 + emoji（R1/R2 先例 ♻️ refactor(core): …）。

## 8. 任务顺序与依赖

```
T3.1 子步 A(timing) → B(verdicts) → C(reuse) → D(delivery+索引签名)
                                              │
T3.2 Branded Types ───────────────────────────┤（依赖 C：roleSessions 已在 reuse 子对象）
T3.3 Outbox（shared/report.ts + dedup）────────┤（独立，可与 T3.2 并行）
T3.4 tui 拆模块 ──────────────────────────────┘（依赖 T3.3：dedup 先入 shared 再被 tui 引用）
```
- T3.1 四子步**严格串行**（同改 types.ts/state.ts/flow.ts，禁并行）。
- T3.2 与 T3.3 可并行（写集互斥：types/session vs shared/report+rpc）；T3.4 在 T3.3 后。
- 每子步/任务独立 commit；批次完成打 tag（如 `arch-r3-done`）。

## 9. 验证方法

### 9.1 门禁（每子步 + 合并后）
```sh
bun run check        # build → bun test → tsc --noEmit → oxlint(correctness=error) → TUI harness
bun test tests/<相关>.test.js   # 子步快速锚
```

### 9.2 行为不变隔离对比法（R1/R2 已验证可复现）
```sh
# 导出 HEAD 版 server+shared 到隔离目录
git archive HEAD server shared | tar -x -C /tmp/opencode/r3-head
# 同一脚本分别 import HEAD 版与树版，对 ≥20 组输入对比核心纯函数输出 JSON 逐字
#   evaluateTransition（双模式×S/M/L×合法/非法/超限/各 gate 态）
#   diagnoseReport / briefFor / levelFor / nextFor
# 注意排除 R3 有意差异：st 子对象形状（对比时取投影后的扁平视图或只比 ok/note/msg/phase/rounds）
bun /tmp/opencode/r3-cmp.mjs /tmp/opencode/r3-head > head.json
bun /tmp/opencode/r3-cmp.mjs <树根> > tree.json
diff head.json tree.json   # 期望零差异（有意差异单列说明）
```

### 9.3 真机验证清单（合并后，README 5 条）
1. 开 session → 侧边栏面板正常**不崩**；`/wf:intake probe-test` → toast brief + 面板刷新 + entry 块。
2. `/wf:ping` → 角色注册 toast。
3. `/` 下拉选 `/wf:status` → 降级轨注入 inbox（不唤醒模型）。
4. 终端切后台触发命令 → 仅 level=warn 弹 OS 通知。
5. （可选）`WF_DEBUG=1 ./scripts/tui-restart.sh` → 探针落盘。
- **R3 加验**：跑通一个 `[S]` daily 任务全程到 done；用 R2 期间建的旧平铺快照任务继续推进（读兼容实证）。
- TUI 改动后必须 `bun run build` + `./scripts/tui-restart.sh`（/reload 不重读 TUI）。

## 10. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| normalize 非幂等/漏字段 → 旧任务读崩 | 4 子步各含跨版本用例；幂等性单测；真机旧任务实证 | 每子步独立 commit，`git revert` 单子步 |
| 消费方漏改（LRN-20261112-001 复发） | §3.0 符号级 grep 全仓重测 + 导出锁/快照守卫 | tsc --noEmit 兜底（删索引签名后漏改即编译红） |
| wire 形状漂移 → TUI 哑火 | rpc-drift 快照锁 required；投影层吸收形状差 | rpc-drift 红即阻断合并 |
| 其它项目跑旧 checkout 读新 shape | §1 全局清场；单仓库热载所有宿主同步新代码 | 清场不彻底则暂停合并，问用户 |
| TUI 拆分泄漏响应式到 render 顶层 → e.length 崩 | 流派 A 约束本体保留；harness P4 守卫；真机清单第 1 条 | dist/tui.js 入库可 revert；tui-restart 恢复 |
| 索引签名删除暴露隐藏动态字段 | wfstate-fields 快照 + _ext 兜底；全量测试 | 子步 D 独立 revert |

**批次级回滚**：R3 全部提交在独立 commit 链，`git revert 664cc14..HEAD` 区间内 R3 提交可整体回退到
R2 态（07fa0c2）；stateJson 新形回退后旧代码可读（normalize 只搬不删数据语义，回退后旧代码读扁平字段
仍在——**回滚窗口内勿让新形 save 覆盖旧任务**，故回滚须连同 DB 备份评估，执行前 `cp .workflow/wf.db` 备份）。

## 11. 跨设备执行备注

- 本文档自包含：不依赖本机会话上下文、不依赖 /tmp/opencode/slim-src 等本机历史副本。
  R1/R2 过程产物（.workflow/arch-r1-host-split/、.workflow/arch-r2-profile-statemachine/）为
  gitignore 本机文件，跨设备不可见——交付事实以 §0.1–0.4 + `git show 664cc14 07fa0c2` 为准。
- 环境：bun（版本见 package.json/bun.lock）、git、opencode 宿主（真机验证需）。`bun install` 即可。
- 测试隔离：`WF_PROJECTS_FILE` 由 bunfig.toml preload（tests/_preload.js）钉临时路径，跨设备一致。
- 状态库：各项目 `.workflow/wf.db`（gitignore，不入库）；跨设备执行时本仓库自身的 wf.db 是测试对象，
  真机验证用独立 probe 任务，勿污染既有任务。
- 若执行设备宿主版本不同：先过 `docs/UPGRADE.md`（不变量→基线表→宿主核对点→验收命令），
  宿主契约结论见 `docs/HOST-CONTRACT.md`（与本结论冲突的"常识修复"一律先查证再动手）。
- 执行记录建议落 `.workflow/arch-r3-state-shape-migration/`（baseline/plan-review/test-report/
  build-receipt/lessons），与本 PLAN 互为证据链。

---
_盘点基线：07fa0c2（R2）。本文档由 R2 执行会话沉淀，方案 v2 修订版 I-1~I-4/S-1~S-6 已吸收。_
