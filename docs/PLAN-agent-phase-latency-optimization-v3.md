# Agent 阶段耗时优化方案 v3（终版，待 R1/R2/R3 执行完后启动）

> **状态：已被 v3.1 取代**（`PLAN-agent-phase-latency-optimization-v3.1.md`——病灶口径/行号/落点有修正，见其 §修正汇总与 §0 证据表）。本文档仅存档，勿按此执行。

> 证据基线：arch-r1-host-split（daily/L，2026-11-13 全流程实测，终值数据见 §0）+
> oh-my-opencode-slim 源码精读（借鉴机制与源码位置索引见文末备忘；如需回读原文：
> `git clone --depth 1 https://github.com/alvinunreal/oh-my-opencode-slim`，本机历史副本在
> /tmp/opencode/slim-src/，跨设备不存在属正常）+ 两轮方案验证报告（严重问题 1-3 已吸收）。
> 前置：本方案排在 phase-a-layer-deps-guard（R1/R2/R3，见 ~/.opencode/plan/，未入库随本机执行）
> 之后启动，两者文件冲突面小——启动前先 `git log --oneline` 核对 R1-R3 是否已合入，若其改动
> 涉及 roles/*.md、guidance.ts、tests 快照，必须重读本方案涉及文件的当前态再动手（edit 防撞纪律）。
> 取证方法可复现：wf.db events 表阶段时间戳 + `/api/session/{id}/message` reasoning 分段口径。

## 0. 实测基线（优化对象）

全流程模型侧 ≈139 min（墙钟 07:06→09:30 = 144 min）：

| 阶段 | 实测 | 判定 |
|---|---|---|
| planning | 16.2 min（reasoning 120K，99%） | 设计=产品，保留；换取执行端提速 |
| review | 11.5 min（reasoning 123K，99%） | 审查=产品，保留 |
| **building** | **97.6 min**（批次1 41 + 批次2 56） | **病态**：reasoning 占比失控、双重设计、手搓脚本 |
| testing(verify) | 7.2 min（reasoning 52K） | 健康 |
| done(learner) | 6.9 min（reasoning 68K） | 健康 |

质量终值：test_fix=0、plan-review 一轮过、tester 七维度全 PASS——优化空间不在"少想"，
在消灭**重复生成**：①builder 368K reasoning 中 78K 是重复 planner 已做的设计（planner 52K
拆分推导 + builder 21K split 脚本再推导）；②37K 脑内枚举 66 处 catch；③批次2 模型逐字手写
5 个一次性迁移脚本 t04-group*.cjs 共 ~62KB（groupb 两版）；④worktree 环境税 ~7 min
（mock bootstrap 缺 `/`）；⑤receipt 写超再 8 轮裁剪 ~2 min。

## 总原则

**推理预算跟着角色职责走**：设计角色（planner/reviewer）的 reasoning 保留甚至前移；执行角色
（builder）的重复设计、脑内枚举、手搓脚本用机制消灭。**并行预算给执行，多视角留给 review**。

---

## 波次 1（低风险高确定性，可拆独立 PR/任务）

### P0-A mock bootstrap 根修（省 ~7 min × 每 worktree 任务）
- 病灶：`${mockDir}package.json` 缺尾部 `/`，在 tests/{integration(13-21),artifact-patch(12),
  artifact-register(14),leader-only(15)}.test.js 四处复制粘贴；13 个文件 import server/index.ts，
  主树靠已存在的目录掩盖（tui-render.harness.ts:27 是带斜杠的正确版）。干净 node_modules 首跑必红。
- 改法：单点化进 `tests/_preload.js`（bunfig.toml 已 hook，先于测试文件执行）+ 守卫测试断言
  空目录下 package.json/mock-rpc.js 落盘路径正确。
- **同波顺带**：`bun add -D @ast-grep/cli`（实测 bun x 有 postinstall 回退开销，装进依赖后 worktree
  共享 bun install 产物）。
- 依据已就绪：本任务 lessons LRN-005 已把"preload 级彻底解"列为 leader 批准的后续项。
- 验证：`rm -rf node_modules && bun test` 首跑全绿；守卫测试入 check 门禁。

### P0-D codemod-first 纪律（builder.md + 实测教训写死）
- 实测教训（写进纪律时引用）：朴素 pattern `catch {}` 三变体在 ast-grep 全部 parse 失败
  （"Multiple AST nodes"）；`try { $B } catch { }` 形态在本仓库旧 state.ts 仅命中 8/18（44%）。
- 纪律（roles/builder.md）：pattern 化批量变更必须 **dryRun report（count+样本）→ 模型核验 →
  apply**；禁止模型逐字手写一次性脚本变体族（t04-group*.cjs 反例）——优先 ast-grep pattern，
  其次可复用参数化脚本（读 plan 表），最后才是 bespoke。
- 工程诚实性三条（borrow slim）：report 截断不得声称为全量；apply 与 report 解耦
  （rewritesApplied 独立）；工具缺位给恢复指引。
- 预期：省 8–15 min/任务（44% 覆盖率口径，勿按全量估）。

### P0-C⁺ 通用交接契约（"交付物 = 上游推理的可执行形态"，消灭跨角色双重设计费）
- planner→builder：机械拆分/批量变更类 T 点，plan 必须交付 **planner 自己 dryRun 实测校验过的
  pattern 族 / `kind` 规则 YAML / 行区间终表**，含对账口径"预期匹配数 = dryRun count"。
  "原则级"描述不算可执行方案（本任务 52K+21K 双重设计费实证）。
- tester(verify)→fixer：test-report 必含**失败归因 + 精确位置（文件:行+可疑代码）+ 最小复现
  命令**；roles/fixer.md 加纪律"按报告归因直接修，归因存疑才重做根因推理并说明理由"。
- builder→builder-reviewer/testing：receipt 已承担（本任务形态接近合格，补"检查用 report
  不手抄 diff"一句）。
- roles/planner.md、roles/fixer.md、guidance 对应阶段文案同步。
- 注：LRN-007（清零判据 plan 期定死）= 本契约的既有成功样本，引用为依据。

### R5 planner-reviewer 可执行性审查
- roles/planner-reviewer.md 审查维度加一行：pattern/规则与目标文件对得上吗、count 合理吗
  （reviewer 有 codegraph 上下文，抽验即可）。P0-C⁺ 产物质量由此把关。

### P1-F 先裁剪后落盘（扩至全部产物）
- builder/tester/reviewer/learner 的产物预算纪律统一措辞："按预算先在草稿内裁剪，达标后单次
  write/content 落盘；禁止写超再分段裁剪"（本任务 receipt 8 轮返修实证）。

### P0-E worktree 清理步补一行（ERR-001，learner 已列后续）
- skills/wf-worktrees（或仓库 skills/ 源）清理步补完整顺序：合并→核已在主树→rm untracked→
  **`git restore .`**→`worktree remove`（非 force 被 untracked 与 tracked M 两类残留共同阻塞）。

### P0-M 墙钟度量承接（零新工具）
- building/done 阶段 guidance 加一行：learner「流程效率观察」节必须记各阶段墙钟（从 events 表
  取）。波次 A/B 基线由此闭环，验证方法=本任务分析口径（reasoning 字符量分段）。

**波次 1 预期：139 → ~105-115 min。门禁：`bun run check` + 一单 daily M 真机对照。**

---

## 波次 2（A/B 实验项）：P0-B per-role effort 原子包（三件必须同一次上线）

1. `server/model-tier.ts` TIER_MAP 硬编码 → **`options.tiers` 配置层**（角色→档位），内置默认：
   - builder = `low`（该网关 qwen3.8-flash variants=[off,low,high,max]，**无 medium**，写死实测存在档）
   - learner = `low`（现为 "off"=零思考意图，实测其 68K reasoning=lessons 质量本体，归零是事故）
   - planner / planner-reviewer / tester / builder-reviewer / fixer = `high`（不动）
2. **`inherit` 显式哨兵**消除 `"off"` 多义词：resolveTierRef 在 ORDER 降级链外特判 +
   syncTierAgents 支持"不派生文件=跟随基座默认"。当前 tierAgents=false（commands.ts:314
   `!== true` 返回空）才是"全角色跟随基座默认重思考"的真因——TIER_MAP 的 "off" 一旦开开关就
   真归零，此为本包最大陷阱，**改映射与开 tierAgents 必须原子**。
3. `wf:ping` 增加"每角色生效 variant"回显行供核验；存量 `.opencode/agents/wf/*.md` 下次 setup
   重写（syncTierAgents 幂等，列入验收步骤）。

- A/B 指标（wf.db events + 本方案分析脚本口径）：building 墙钟、builder reasoning 量、
  **rounds.test_fix 不升高**；回滚=inherit 一行配置。
- 预期单独省 10–20 min。**波次 2 后累计 → ~80-90 min。**

---

## 波次 3（改动最大，最后做）：P1-E lane 并行制度

前提实证：本任务写集密集相交（T01∩T05=roles/skills、T03 相交 11 文件），**不降交叉则并行收益≈0**。

1. **planner 侧（前置条件）**：任务拆分目标加"写集低交叉"（可移交的变更点移交归属 T 点）+
   **lane 分组表**（写集交叠传递闭包=同 lane）+ 每 lane 预估净增 KB。
2. **leader 侧**：`server/guidance.ts` DISPATCH_L 重写——lane≥2 且互斥证据充分 → 多 builder
   并行（subagent `background=true`、独立 worktree、`@Tnn` 别名）；不满足 → 维持单树串行
   （**不为并行而并行**）。并行授权收编进 plan:confirm 卡（卡片展示 lane 划分+预计耗时，
   confirm=批准并行，不新增交互）。
3. **准入·第一步（软）**：`wf:lane set` 时统计活跃 builder lane 数（口径=仅 builder lane；
   实现复用 selfmod `scanActiveTasks`，勿新建计数器），超限→返回值告警 + building guidance
   动态尾显示并发数。默认 cap=2（防本地网关互相挤占；状态持久 wf.db，热载后"重占名额"语义
   = reconstructing reality，非 admitting new work——borrow slim restoreTask）。
4. **准入·第二步（硬，单列评估，不进本波主体）**：经既有 `ctx.tool.hook("execute.before")`
   （guard-hook.ts:40，已观测 subagent 调用）做事前拦截——guard-hook 管辖首次外扩到 leader
   会话，风险单独评审。
5. **运行时 ownership 双保险**（borrow slim worktrees skill）：`state_json.lanes` 扩
   `areas/status/lastUsedAt`（areas 由 leader 从 plan lane 表登记，**勿走 CLI 空格参数**）；
   builder 写前核对 areas，越界=停下回报；空闲 lane 续用提示进 guidance 动态尾（borrow
   trimReusable LRU）。lane 分支命名 `wf/<slug>/lane-Tnn`；managed gitignore 块。
6. **receipt per-lane（写侧+读侧成对改，缺读侧=证据链静默断链）**：
   - 写侧：`build-receipt-<lane>.md`，builder 自写（守 WRITE_CONTRACT，leader 不代写只汇总路径）；
   - **读侧**：guidance.ts:147 回执路径硬编码行 + testing 裁决文案 + learner 复盘消费点同步
     （daily 无 build_review，receipt=唯一审查证据）。
7. **reconcile**：逐 lane 展示 diff 摘要再合（borrow slim Phase 3）。
8. **文案锁同步清单**：tests/selfmod-guard.test.js:183（锁 /分批//每批 ≤4//worktree/）、
   flows/rpc 快照、roles/leader.md M/L 段、上述全部 guidance 行。

**波次 3 后：单 lane 场景 → ~70-80；降交叉成立+并行 → ~50-60（building 97.6→~35-45）。**

---

## P2 顺手项与远期

- **P2-G background 观察灯**（borrow slim observation lamp，他们实测 2:1 foreground habit）：
  委派是否显式 `background` 记入 events（guard-hook 已有 subagent 探针，属扩展既有），量化
  我们的干等占比，供波次 3 决策是否上硬拦截。
- **P2-H** builder.md：互不依赖的只读检查合并同消息并行发出。
- **P2-I（远期）**：模型 fallback 数组 + 每条目 variant（slim ModelEntry 形态）；variant 降级链先顶。

## 明确不做（负结论清单）

| 不做 | 依据 |
|---|---|
| planner/reviewer/learner 降 effort | reasoning≈产品本身（99%/68K 复盘实证） |
| planning/review/testing 阶段并行 | 单一全局设计/单对象/单道执行，无低交叉窗口 |
| 周期 wake 唤醒 leader | 宿主 first-terminal 通知已在；slim v2 亦自删周期 wake |
| lanes/board 状态注入 prompt 主体 | slim v2 整体退役（board-injection-cache-safety 注释）；维持静态前缀+动态小尾 |
| Council 式多模型共识 | slim 自标最高成本路径；多视角已由 planner-reviewer∥tester 承担 |

## 实施备忘（借鉴源索引）

- slim 机制原文位置（路径基于 clone 副本根，跨设备先按文件头说明浅克隆）——
  准入 `src/utils/background-task-concurrency.ts`（resolveTier:314/restoreTask:169/migrateTask:197）、
  Board `src/utils/background-job-board.ts`（generation fence/trimReusable:1757/nextAlias:1952）、
  后台默认翻转 `src/hooks/task-session-manager/tool-execute-hooks.ts:234-259`、
  worktrees 协议 `src/skills/worktrees/SKILL.md`、ast-grep `src/tools/ast-grep/{cli,tools}.ts`、
  档位配置 `src/config/runtime.ts:359-377`（host>runtime>plugin 三层 + inheritModelFrom）。
- 本仓库落点：server/{model-tier,guidance,lib,commands,guard-hook}.ts、tests/{selfmod-guard,flows,
  _preload,_mock-bootstrap(新)},、roles/{planner,planner-reviewer,builder,fixer,leader}.md、
  skills/wf-worktrees、bunfig/package.json。
- 每个波次建议各开一个 wf 任务（wf:intake 起）；改 roles/ 经托管同步生效，勿手改宿主文件；
  改正在热载的 server/* 入口文件禁分步连续 edit（引擎自改并发护栏）。
