# 优化方案 batch-2：skill 提取第二批（wf-build-receipt / wf-codemod / wf-plan-revision）

> 依据：batch-1（v3，docs/OPT-plan-runtime-contract.md）完成后对剩余 roles 的可提取性分析。
> 本批为**纯文案+注册批**：零 server 逻辑改动（仅 `SKILL_IDS` 数组与测试锚同步），不动 guidance 运行时。
> skill 通用规格沿用 v3 §三（首行 `---`、name+description、正文 ≤40 行、域门措辞、roles 引用行自带触发条件），不再重复。

## 一、提取对象与收益口径

| # | 来源段落（现状） | 问题 | 去向 |
|---|---|---|---|
| 1 | builder.md L7 回执撰写段（~400 字：≤4KB 预算裁剪、内容六件套、主树绝对路径坑、交付前 commit） | 每次委派必执行却占 builder 常驻上下文；low 档遵从度差 | `skills/wf-build-receipt/` |
| 2 | builder.md L6 codemod-first 段（dryRun→核验→apply、优先级序、工程诚实性三条）+ L11 zsh md5 坑 | 低频高危，混在通用段稀释注意力 | `skills/wf-codemod/`（L11 并入坑例节） |
| 3 | planner.md L12-14 返修纪律 + 增量 patch 修订协议（复跑取证、去向标注、计数单位、old 逐字/模糊回退/记账补注册） | 仅返修轮触发，与首轮写 plan 混排 | `skills/wf-plan-revision/` |

预期收益为质量收益（遵从度/单点可校验），**不承诺时长数字**（无实证基线，勿虚构口径）。

## 二、措施设计

### S1 wf-build-receipt（域门）
- skill 内容：触发时机（委派 prompt 要求写回执时）→ 预算纪律（草稿内裁剪达标后单次 write，禁写超再分段）→ 内容六件套（测试命令+红→绿摘要/变更文件/未验证项/areas 越界声明/commit hash）→ 路径铁律（主树绝对路径；树内 .workflow/=gitignored 副本清理即丢）→ 交付前树内 commit。
- builder.md 保留行（**必须携带守卫锚关键词**）：「满足 <委派 prompt 要求写回执> 时按 `wf-build-receipt` skill 执行（≤4KB 预算、含 commit hash、写主树绝对路径）」。

### S2 wf-codemod（域门）
- skill 内容：优先级（ast-grep pattern > 参数化脚本 > bespoke）→ 铁律三步（dryRun report→自行核验覆盖→apply）→ 工程诚实性三条（截断不称全量/rewritesApplied 独立计数/工具缺位给恢复指引）→ 坑例节（朴素 `catch {}` 三变体 0 命中实证；zsh 不分词 `$fs` → `while read`/`${=fs}`）。
- builder.md 保留行：「满足 <pattern 化批量变更> 时按 `wf-codemod` skill 执行」。
- **description 互斥声明**：与 wf-batched-execution 边界——本 skill 管"pattern 化**代码改写**"，彼 skill 管"批量 **shell 探查命令**发送"；两者 description 各写一句排斥语防误触发。

### S3 wf-plan-revision（域门）
- skill 内容：触发时机（review FAIL→wf:plan 返修轮 / 多轮修订）→ 返修前置（逐条复跑最新 review FAIL findings 的验证动作，非阻断 findings 标注去向：采纳→改动点/不采纳→一行理由）→ 计数单位声明（plan 首节，全文共用）→ 增量修订（先 read 原文；wf_write_artifact patch 或原生 edit，old 逐字摘录唯一匹配+模糊回退；原生 edit 后须 wf_write_artifact(kind=plan) 注册补记账）。
- planner.md 保留行（**携带守卫锚**）：「返修/多轮修订时满足 <存在 plan-review findings 或需增量修订> 条件按 `wf-plan-revision` skill 执行（patch 增量修订、回执只带摘要禁全文）」。

## 三、锚点约束（提取前已实测，提取后必须保住）

| 锚 | 位置 | 保住方式 |
|---|---|---|
| `/增量修订|只重产受影响/` | roles.test.js L207（planner） | planner 保留行含「增量修订」 |
| `/≤4KB/`、非`/回执…≤2KB/` | roles.test.js L221-222（builder） | builder 保留行含「≤4KB」 |
| `/commit hash/`、`/主树绝对路径/` | roles.test.js L224-225（builder） | builder 保留行含两关键词 |
| `/patch/` + `/摘要|勿回传全文…/` | roles.test.js L236-237（遍历 planner/planner-reviewer/tester/builder-reviewer/learner，**不含 builder**——builder 删回执段不受此行约束） | planner 保留行含「patch」「摘要」 |

## 四、执行清单（按序执行，每步独立可交付）

| 步骤 | 内容 | 验证方式 | 预估 |
|---|---|---|---|
| 1 | `wf-build-receipt` skill + builder 保留行（携锚） | `bun test tests/roles.test.js`（L221-225 锚） | 1h |
| 2 | `wf-codemod` skill（含坑例节）+ builder 保留行 + 与 wf-batched-execution description 互斥句双向补写 | 文件在位 + 内容自审 | 1h |
| 3 | `wf-plan-revision` skill + planner 保留行（携锚，替换 L12-14 两段） | `bun test tests/roles.test.js`（L207、L236-237 锚） | 1h |
| 4 | `SKILL_IDS` **追加数组尾部** 3 id + sid-reliability L236 deepEqual 扩 **9 项** + 同步用例扩 3 id 域门断言 + AGENTS.md/README 枚举更新（6→9） | `bun test tests/sid-reliability.test.js` | 1h |
| 5 | `bun run check`（tsc 既有 scripts/verify-test43 报错属基线，不计）+ 冒烟（§六） | 见 §六 | 0.5h |

合计 **~4.5h**。注意：步骤 1/2 同改 builder.md，**一次编辑会话内连续完成再统一验证**（防撞车纪律）。

## 五、显式不做清单

| 项 | 不做理由 |
|---|---|
| 提取 tester 三模式 / learner 状态机纪律 | 模式分叉=role 身份本身；内容 <10 行，无协议密度 |
| 提取 wf-wave-gate（lane 放行/登记协议） | leader 为 high 档主会话红利小；与 `wf:lane` help/planner lane 表三处耦合，需先做一致性验证 → 独立任务单 |
| 提取 wf-rework-route（返工归属路由） | 路由判据在 guidance 动态行，机制不同；如做仅抽"归属判定判据"半层 → 独立任务单 |
| 删除 guidance L244 回执委派行 | guidance 与 skill 分工：guidance 说"现在做什么"，skill 说"怎么写"——两层保留 |

## 六、冒烟与回放验收

```bash
ls ~/.config/opencode/skills/ | grep -E "wf-build-receipt|wf-codemod|wf-plan-revision"   # 3 行命中
grep -l "仅 wf 工作流任务会话内适用" ~/.config/opencode/skills/wf-{build-receipt,codemod,plan-revision}/SKILL.md  # 3 文件域门
grep -c "≤4KB" roles/builder.md   # ≥1（守卫锚词留在 role 正文保留行）
```
3 条全过=冒烟 PASS。回放验收：首个批量变更类 T 点回执含 dryRun report 摘要；首个返修轮 plan patch 无全量重写。

## 七、回滚

同 v3 §七：删 `SKILL_IDS` 对应 id + 删 `skills/<id>/` 目录；role 还原追加/保留行（hash 回退 → 下次 setup 同步自动还原宿主文件）。

## 八、审核记录（落计划即审，2026-11-16）

| 检查项 | 结论 |
|---|---|
| 锚点完整性 | §三 5 组锚已实测存在；步骤 1/3 验证方式直指锚文件 ✅ |
| 触发互斥 | S2 与 wf-batched-execution description 互斥句双向补写（步骤 2 含改既有 skill）✅ |
| 下标安全 | SKILL_IDS 追加尾部，既有 [0]/[1] 断言不变 ✅ |
| server 改动面 | 仅 SKILL_IDS 数组+测试锚，与 v3 步骤 5 同款，零逻辑 ✅ |
| 收益口径 | 不承诺时长（无基线），只声明质量收益——避免 v1 三套数字教训 ✅ |
| 审核修正 1 | 冒烟第 3 条原为伪语法，已改可执行命令（grep -c 具体路径）✅ |
| 审核修正 2 | L236-237 遍历范围实测不含 builder，锚表口径已纠正（builder 仅受 L221-225 约束）✅ |
