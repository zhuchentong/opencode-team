# Agent 阶段耗时优化方案 v3.1（v3 可行性验证后的修正版）

> 本版对 v3（`PLAN-agent-phase-latency-optimization-v3.md`）逐项做了代码级/实验级可行性验证，
> 修正三处过时锚点、一处病灶口径、两处落点缺位；验证证据全部可复现（§0）。
> 前置核对：R1-R3 已合入 master（`aae41b1`，tag arch-r3-done），本版所有行号/锚点以该基线重测。
> 总原则、明确不做清单、波次结构与预期收益路径与 v3 一致，此处不重复（v3 §总原则/§负结论/§收益）。

## 0. 验证证据（2026-11-13 主树实测，全部可复现）

| # | 假设 | 验证方法 | 结果 |
|---|---|---|---|
| V1 | P0-A 干净安装首跑必红 | `mv node_modules/@opencode /tmp && bun test` | **红实证**：8 fail + `Unhandled error: Cannot find module '@opencode/plugin/rpc' from shared/rpc.ts` |
| V2 | P0-A preload 根修有效 | bootstrap 原型写入 `tests/_preload.js` 后同条件复跑 | **绿实证**：389 pass 0 fail，mock 包正确落盘（package.json/mock-rpc.js/mock-tui.js）——红→绿闭环 |
| V3 | P0-D 朴素 pattern 不可用 | `bun x @ast-grep/cli` 实测三变体 | `catch { }` → `Cannot parse query`（实证）；`catch {}`、`catch { $E }`、`catch {$$$}` → **0 命中**（空 catch 体不匹配 metavariable）|
| V4 | 可行 pattern 覆盖 | `try { $B } catch { $E }` | **25 命中**（server/ 全树；grep `catch {` 实数 23，量级吻合）——纪律应写死此实测形态 |
| V5 | bun x ast-grep 有回退开销 | bunx 输出 | `[warn] postinstall script did not run; falling back to runtime binary resolution` 实证 → `bun add -D` 依据坐实 |
| V6 | inherit 哨兵有天然落点 | `server/model-tier.ts` 精读 | `resolveTierRef`：未知档名 `ORDER.indexOf(tier)<0 → null`（:48-49）=不写派生文件=继承基座默认——**现有代码已天然通路**，改法最小化（见 P0-B 修正） |
| V7 | P0-B 开关陷阱 | middleware.ts:59 | `host.options.tierAgents !== true` 空返回门实测在位 ✓ |
| V8 | P1-E/P2-G 前提 | guard-hook | `execute.before` hook（:40）+ subagent 一次性探针（:34-35）在位 ✓ |
| V9 | P1-E lanes 扩字段 vs R3 新锁 | `tests/wfstate-fields.test.js` 锁面 | 锁只覆盖 WfState 顶层键 + timing/verdicts/reuse/delivery 四分组子键——**lanes 值对象内部扩 `areas/status/lastUsedAt` 不触发锁**（但勿顺手把 lanes 迁组） |
| V10 | bunfig preload 钩子 | bunfig.toml | `preload = ["./tests/_preload.js"]` 在位 ✓（根修无需改 bunfig） |
| V11 | P0-M 承接点 | roles/learner.md | 现**无**「流程效率观察」节——需新增（v3 默认有承接点，修正） |
| V12 | P0-E 落点 | skills/ 目录 | 仅有 `session-lookup`，**无 wf-worktrees**——需新建 skill（v3「或仓库 skills/ 源」两可表述收敛为新建） |
| V13 | 波次3.8 文案锁行号 | selfmod-guard.test.js | :181-183（`/分批/`、`/每批 ≤4/`、`/worktree/`）实测仍准 ✓ |
| V14 | guidance 文案锚点 | guidance.ts | receipt 行 **:147→:161**（v3 行号过时）；DISPATCH_L **:102**；DISPATCH_M :103 |

## 修正汇总（相对 v3）

1. **P0-A 病灶口径修正**：v3 说「`${mockDir}package.json` 缺 `/`」——实测四处现均为 `${mockDir}/package.json`（路径正确），真因是 **ESM 首跑时序**：mock 包由 4 个测试文件运行期自举写入，而其它测试文件的 `import server/index.ts → shared/rpc.ts → @opencode/plugin/rpc` 在加载期解析，干净 node_modules 下解析先于写入（V1）。根修方案不变（单点化进 preload），已 V2 红→绿实证。
2. **P0-D pattern 族修正**：纪律文本须写死**已实测可行** pattern（`try { $B } catch { $E }`，V4:25 命中）与**已实测失败**变体（V3 三组 0 命中/parse 失败），dryRun count 对账口径以本节数字为种子；新增空 catch 体专项 pattern 需另测（metavariable 不匹配空体是 ast-grep 语义，勿想当然）。
3. **P0-B 改法最小化修正**：`inherit` 不需新增降级逻辑——`resolveTierRef` 对未知档名已返回 null=继承（V6）；改法收敛为：①TIER_MAP 值允许 `"inherit"` 并在 syncTierAgents 里特判输出专用审计行 `tier-inherit:<role>`（现走 `tier-skip:<role>:no-variant`，语义误导）；②`wf:ping` tierLine 回显 variant 时对 inherit 角色显示 `(基座默认)`。原子性要求不变（改映射与开 tierAgents 必须同一次上线，V7）。
4. **P0-E 落点收敛**：新建 `skills/wf-worktrees/SKILL.md`（复用 `server/skills.ts` 托管同步泛型，session-lookup 同模式），内容=清理步完整顺序：合并→核已在主树→rm untracked→**`git restore .`**→`worktree remove`（非 force 被 untracked 与 tracked M 双阻塞，ERR-001）。
5. **P0-M 落点修正**：learner.md **新增**「流程效率观察」节（V11），口径=各阶段墙钟自 wf.db events 表取（本方案分析脚本同源）。
6. **行号全面更新**：receipt 硬编码 :161、DISPATCH_L :102、tierAgents 门 middleware.ts:59 / ping 行 commands.ts:241（V14）。

## 波次 1（低风险高确定性）——与 v3 相同的任务集，按修正执行

建议拆 2 个 wf 任务（写集互斥可并行评估，串行更稳）：

**任务 1：P0-A mock bootstrap 根修（[S] daily，独立 commit）**
- `tests/_preload.js` 追加幂等自举（V2 原型代码为准）；**删除** integration/artifact-patch/artifact-register/leader-only 四处存量自举块（单点化后留副本=漂移源；四文件头部改为仅注释指路 preload）。
- 守卫测试（新 `tests/mock-bootstrap.test.js`）：临时目录断言三文件落盘路径/内容形状 + `_preload.js` 含自举代码（防回退）。
- `bun add -D @ast-grep/cli`（V5）。
- 验证：`rm -rf node_modules/@opencode && bun test` 首跑全绿（V1/V2 同法）；`bun run check` EXIT=0。
- 注：tui-render.harness.ts:27 自带的正确版自举保留不动（harness 非 bun test 文件，不经 preload）。

**任务 2：纪律与文案批（[S] daily，纯 prompt/文档层 + guidance 加行）**
- P0-D：roles/builder.md 写死 codemod-first（dryRun report→核验→apply；pattern 族以 V3/V4 实测为准；禁 bespoke 脚本变体族）；工程诚实性三条照 v3。
- P0-C⁺：roles/planner.md 交付可执行方案契约（dryRun 校验过的 pattern 族/YAML/行区间终表+对账口径）+ roles/fixer.md 按归因直修 + builder receipt 补「检查用 report 不手抄 diff」。
- R5：roles/planner-reviewer.md 审查维度加「pattern/规则与目标文件对得上吗、count 合理吗」。
- P1-F：builder/tester/reviewer/learner 预算纪律统一为「先裁剪后单次落盘」。
- P0-M：roles/learner.md 新增「流程效率观察」节（墙钟自 events 表）。
- P0-E：新建 skills/wf-worktrees/SKILL.md（清理步五步序）。
- guidance 同步锚点（:161 receipt 行、building/done 动态尾）；对应 tests 快照（brief-level/flows/selfmod-guard:183 文案锁不受影响，改动行不在锁面）。

**波次 1 门禁：`bun run check` + 一单 daily M 真机对照。预期 139 → ~105-115 min。**

## 波次 2（P0-B 原子包，[M] daily）

三件同一次上线（v3 要点保持，按 §修正 3 落地）：
1. TIER_MAP → `options.tiers` 配置层（model-tier.ts 已留 `tiers` 参数位 :79，改默认来源即可）；默认 builder=`low`、learner=`low`（"off"→low 保留 lessons 思考），其余 high 不动。
2. `inherit` 显式哨兵（V6 最小改法：特判 + `tier-inherit:<role>` 审计行 + 跳写派生文件）；**改映射与 tierAgents=true 必须同一 commit**（V7 陷阱）。
3. `wf:ping` 每角色生效 variant 回显（commands.ts:241 tierLine 扩展；inherit 显示 `(基座默认)`）；存量 `.opencode/agents/wf/*.md` 下次 setup 重写（syncTierAgents 幂等，列入验收步骤）。
- R3 交互：tierBase 读写已在 `st.reuse.tierBase`（R3 子步 C），本任务零形状改动；新增导出须同步 lib-exports 锁（72 名）。
- A/B 指标：building 墙钟、builder reasoning 量、rounds.test_fix 不升高（events 表口径）；回滚=inherit 一行配置。
- 预期单独省 10-20 min。累计 → ~80-90 min。

## 波次 3（P1-E lane 并行，[L] full，最后）

与 v3 八点一致，按 R3 后现状补充约束：
- 前提实证不变：写集低交叉是并行收益前提（planner 侧 lane 分组表先行）。
- DISPATCH_L 重写锚点 :102；M 串行文案 :103（「多 builder 并行需用户同意」句与并行授权收编 plan:confirm 卡的对齐点）。
- receipt per-lane 读侧锚点 **:161**（回执路径硬编码行）+ testing 裁决文案 + learner 复盘消费点，写读成对改。
- lanes 扩 `areas/status/lastUsedAt`：值对象内部字段，不触 wfstate-fields 锁（V9）；勿迁组。准入计数复用 `scanActiveTasks`（勿新建计数器）；硬准入（guard-hook 外扩 leader 管辖）单列评估不进主体（V8 探针在位）。
- 文案锁同步清单：selfmod-guard.test.js:181-183、flows/rpc 快照、roles/leader.md M/L 段、guidance 全部动态尾行。
- 预期：单 lane ~70-80；降交叉成立+并行 ~50-60。

## P2 顺手项与明确不做

与 v3 完全一致（P2-G background 观察灯 / P2-H 只读检查并行 / P2-I 模型 fallback；负结论清单六项照抄不重审——本验证未发现推翻依据）。

## 实施备忘

- 借鉴源索引照 v3 文末（slim clone 副本说明不变）。
- 落点更新：server/{model-tier,guidance,commands,guard-hook}.ts、tests/{_preload,mock-bootstrap(新)}、roles/{planner,planner-reviewer,builder,fixer,learner,leader}.md、skills/wf-worktrees(新)、package.json。
- 每波次一个 wf 任务（波次 1 建议拆 2）；改 roles/ 经托管同步生效；改 server/* 入口文件禁分步连续 edit；`WF_PROJECTS_FILE` 测试隔离经 preload 已钉。
- R3 红利复用：normalizeState 模板（未来 lanes 若迁组）、shared/report.ts 同源结构（P0-B 配置默认值单点可参照）。
