# PLAN — arch-maintenance-p1（结构维护批次 P1，已验证待执行）

> 状态：方案已定稿，全部改动点经代码级/实验级验证（§0 证据表），待执行。
> 前置：master @ ab122a3（latency-v3.1 三波次已合入，门禁 395 pass + harness 186 全绿）。
> 执行纪律沿 R3/latency 先例：worktree 隔离、逐任务独立 commit、`bun run check` EXIT=0 门禁、
> 交付确认后才 push。`server/guidance.ts`/`server/state.ts` 为热载面——树内一次性成型，禁分步连续 edit。

## 0. 验证证据（主树实测，可复现）

| # | 验证点 | 方法 | 结果 |
|---|---|---|---|
| V1 | state.ts scan 块自洽性 | 源码盘点 | `:124-226` 边界干净：PROJECT_DBS/PROJECTS_FILE_DEFAULT/projectsListFile/registerProject/scanActiveTasks + ActiveOther 类型；纯移动可行 |
| V2 | 消费面 | grep | 11 文件经 `state.ts` 导入（含 tests/selfmod-guard 的 `projectsListFile`）——**state.ts 必须 re-export 迁出符号，消费方零改动** |
| V3 | ⚠️ swallow-coverage 扫描口径 | 读 tests/swallow-coverage.test.js | `readdirSync(serverDir)` **顶层非递归**——子目录 `state/scan.ts` 会逃逸静默 catch 守卫 → **必须平铺 `server/state-scan.ts`** |
| V4 | 前缀纪律 | AGENTS/R1 规则 | 迁出代码的 4 处 `state:*` swallow 前缀须随迁改名 `state-scan:*`（transition:*/middleware:* 先例） |
| V5 | ⚠️ options.tiers 未知角色 | bun 直调 syncTierAgents | `{ "wf/ghost": "low" }` → **真实落盘** `.opencode/agents/wf/ghost.md`（幽灵 subagent 注册，污染宿主 agent 面）——问题定性从"可观测性"升级为"污染防御" |
| V6 | 非法档名行为 | 同上 | `"bogus"` → `tier-skip:no-variant`（行为安全，仅需 ping 可见化） |
| V7 | ast-grep 语义锚 | bun x ast-grep | `swallow($E, $CODE)` server/ 64 命中（可做前缀==基名语义守卫）；`insert($C, () => $B)` 精确命中 tui/index.tsx P4 锚（注意 `-l tsx`） |
| V8 | 文案锁/导出锁影响 | grep | 本批不触碰 DISPATCH/文案串；无新增 lib 导出（state-scan 不入 barrel，维持 73 名） |

## 1. 任务 A — state.ts 拆分（P1.1'，含 V3/V4 修正）

**目标**：selfmod 护栏域与 CAS 红线域文件级隔离；`server/state.ts` 456→约 250 行。

**改法**：
1. 新建 `server/state-scan.ts`（**平铺顶层**，勿建子目录——V3）：迁出 `PROJECT_DBS`、`PROJECTS_FILE_DEFAULT`、`projectsListFile()`、`registerProject()`、`scanActiveTasks()`、`ActiveOther` 类型，及其全部注释与 swallow 调用。
2. 迁出代码的 swallow 前缀随迁：`state:projects-file-append-fail` 等四处 → `state-scan:*`（V4）。
3. `server/state.ts` 尾部 re-export 保持消费面零改动：
   ```ts
   export { PROJECT_DBS, PROJECTS_FILE_DEFAULT, projectsListFile, registerProject, scanActiveTasks, type ActiveOther } from "./state-scan.ts";
   ```
4. `state-scan.ts` 依赖：`node:fs`/`node:path`/`node:os` + `swallow`（observe.ts）+ `ActiveOther` 类型——确认无环（state-scan 不得 import state.ts）。

**验收**：`bun run check` EXIT=0；selfmod-guard/retry/state-db 测试零改动全绿；`git diff` 显示 state.ts 纯删减 + state-scan.ts 纯新增；swallow-coverage 仍扫全部顶层文件（含新文件）。

## 2. 任务 B — options.tiers 白名单校验（P2.1'，含 V5 升级）

**目标**：配置错误从"幽灵角色落盘"降级为"审计行+ping 可见"。

**改法**（`server/middleware.ts` tierCheck 合并点）：
1. 白名单过滤：
   ```ts
   const userTiers = host.options.tiers ?? {};
   const unknown = Object.keys(userTiers).filter((r) => !TIER_ROLES.includes(r));
   const tiers = { ...TIER_MAP, ...(Object.fromEntries(Object.entries(userTiers).filter(([r]) => TIER_ROLES.includes(r)))) };
   ```
2. `unknown.length` → `notes.push(`__AUDIT__tiers-invalid:${unknown.join(",")}`)`（logAdd 既有通道，随 tier-model-switch 同型落审计）。
3. `wf:ping` tierLine（commands.ts P0-B 回显块）：unknown 角色追加 `wf/xxx=(配置无效)`，让配置面错误在只读视图即可见。
4. 非法档名（在 TIER_ROLES 内但档名不在网关 variants）：保持现行为（`skip:no-variant`），ping 回显即 `(基座默认)`，不加新逻辑（V6 已证安全）。

**验收**：model-tier 测试 +2（unknown 角色不落盘+审计行；ping 无效标注）；现有 syncTierAgents 纯函数不动（过滤在 middleware 层）；`bun run check` EXIT=0。

## 3. 任务 C — AGENTS.md 速查表刷新（P1.2）

补入（按现有「结构单一来源」小节风格）：
- T3.4 tui 子模块地图（index=装配+slot 顶层；panel/data/notify/exec-intercept/dedup/util）+ **harness `TUI_SOURCES` 扫描面纪律**：新增 tui 文件必须加进清单，否则静态守卫盲扫。
- P0-A：mock 包自举只许在 `tests/_preload.js`（测试文件散装副本已清零，mock-bootstrap.test.js 守卫）。
- latency 面：`LANE_CAP`（types 叶子）、`wf:lane set --areas=T01,T02` / `done <Tnn>` 子命令、receipt per-lane `build-receipt-<Tnn>.md` 写读成对、learner「流程效率观察」节（墙钟口径）。
- skills/wf-worktrees（清理五步序）与 lane 分支命名 `wf/<slug>/lane-Tnn`。

## 4. 任务 D — v3 旧文档标注被取代（P1.3）

`PLAN-agent-phase-latency-optimization-v3.md` 头部引言下加：
> **状态：已被 v3.1 取代**（病灶口径/行号/落点有修正，见 `PLAN-agent-phase-latency-optimization-v3.1.md` §修正汇总）。本文档仅存档，勿按此执行。

## 5. 顺序与依赖

```
A（state-scan 拆分）→ B（tiers 校验，独立可并行）→ C/D（文档，随时）
```
A/B 写集互斥（state-scan.ts vs middleware/model-tier/commands），可并行评估；串行更稳。每任务独立 commit；批次 tag `arch-maint-p1-done`。

## 6. 红线与风险

| 红线/风险 | 缓解 | 回滚 |
|---|---|---|
| CAS 红线（writeTaskRow/withStateRetry） | 纯移动出域，state.ts 内实现零触碰 | A 单 commit revert |
| swallow-coverage 逃逸 | 平铺顶层（V3 修正）；coverage 测试本身不改 | — |
| 消费面漂移 | re-export（V2）；`git diff` 审查消费方零改动 | B 单 commit revert |
| 幽灵角色存量 | 本批只防新增；存量 ghost.md 手工清理（发现一处清一处，属宿主数据） | — |
| 热载面分步 edit | guidance/state.ts 树内一次成型 | — |

## 7. 明确不做（本批）

- P2.2 静态守卫 ast-grep 升级：维持"新守卫直接用、存量误红才升"增量策略（V7 已证可行，不排期）。
- P2.3 guidance dynamicTail 收敛：下次改 guidance 时顺手。
- guidance/commands 拆分、状态再分组、wire 收紧：见 v3.1 评估负结论，维持不做。
