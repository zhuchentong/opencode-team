# UPGRADE — 升级与改流程前的核对流程

借鉴 [znlgis/my-opencode-deepseek-config](https://github.com/znlgis/my-opencode-deepseek-config) 的升级纪律：**升级宿主/插件/改流程语义不要凭记忆改**——先过一遍不变量，改完跑验收命令。

## 不变量（改动前确认是否触碰；触碰则须同步守卫）

| 不变量 | 锁定方式 | 触碰后果 |
|---|---|---|
| TUI 渲染结构冻结（流派 A：slot render 顶层零响应式 + 唯一 `insert(accessor)`） | harness P4 静态守卫（全文件禁 `<box`/`<text`） | 真机撞 reconciler 崩溃（docs/HOST-CONTRACT.md） |
| RPC 契约形状（`shared/rpc.ts`） | `tests/rpc-drift.test.js` 逐字段快照 | 事件/调用静默失联 |
| FLOWS / FLOWS_DAILY 流转语义与关卡 | `tests/flows.test.js`、`daily-mode.test.js` | 存量会话流转断裂 |
| 阶段定义（`shared/phases.ts`）与 DAILY_STAGE_ORDER 可达集一致 | `tests/phases.test.js` | 侧边栏进度条跳格 |
| guidance 易变区纪律（静态指引在前，轮次/sessionID/head 殿后） | `tests/diagnose.test.js`「head 殿后」断言 | 每轮 entry 变化打穿 prompt cache |
| 宿主注入 API 边界显式 `any`，内部数据流用 lib.ts 领域类型 | `bunx tsc --noEmit` | strict 类型链断裂 |
| mock 数据形状与 server 真实写入形状同源 | 各 test 的 mkCtx fixture | 本地全绿、真机静默哑火 |

## 基线表（当前语义快照，改流程时逐项核对 diff）

- **流转**：full 9 阶段 `intake→planning⇄review→test_design→building→reconcile→build_review→testing⇄fixing→done`；daily 6 阶段砍 test_design/reconcile/build_review/fixing（FAIL 返工 `wf:fix.to=building` 复用 test_fix 计数）。
- **循环上限**：plan_review / build_review / test_fix 各 3（`options.limits` 可覆盖，仅正整数）。
- **关卡**：`wf:test-design` 须 test-plan 产出；daily M/L `wf:build` 须 planReviewVerdict=PASS（S 只跳此校验）；`wf:done` 须 test-report 首行 `**结论**: PASS`；M16-r44：全模式 `wf:build` 须方案确认记账 planConfirmedAt（leader question 交互观察，S 也须确认；plan 修订/intake 即作废）。BLOCKING（业务写闸）= planning/review/build_review。
- **产物 kind 与预算（字节，M 级 / S 级）**：plan 20K/10K、plan-review 8K/3K、test-plan 10K/3K、build-review 8K/3K、test-report 10K/4K、lessons 6K/3K（L 级仅 plan 放宽至 30K，其余沿用 M 值；档位归一 `tierOf`，表 `ARTIFACT_BUDGET_L_KB`）。写入模式：content 全文 / patch=[{old,new}] 增量。
- **审查分级**：planner-reviewer / builder-reviewer 两级（初检 Abbreviated 默认 → 升级触发见 `roles/*.md`）；r≥2 前轮 findings 按未验证线索确认。
- **guidance 易变区**：`entryValue` = 静态指引 → 轮次行 → reuseLines → head 行殿后；done = DONE_ENTRY 在前、head 殿后。

## 宿主升级核对点（opencode 版本变化时）

1. 读宿主 release notes，重点核对：`server`/`tui`/`rpc` 插件入口契约、`session.instructions` entry 渲染、RPC methods/events 五硬条件、TUI 插件模块缓存策略是否变化。
2. 探针复跑：`WF_DEBUG=1 ./scripts/tui-restart.sh` → 查 `.workflow/_debug/`（probeOnce 形状 / tui-refresh.log）。
3. 真机清单：README「真机验证清单」全过（侧边栏不崩、ping、降级轨、通知；第 5 步探针为调试期可选）。
4. 宿主文件联动：`agents/wf/*.md`（roles 托管同步产物）是否被宿主升级重置 → `/wf:ping` 查 managed/stale。

## 验收命令

```sh
bun run check        # 门禁五合一：build → bun test → tsc --noEmit → oxlint → TUI harness
bun tui-tests/tui-render.harness.ts   # 单独跑 TUI harness（非 bun test 文件）
```

- 改 `tui/` 源码：`bun run build` + `./scripts/tui-restart.sh`（宿主对 TUI 插件模块路径级永久缓存，`/reload` 不重读）。
- 仅改 server/guidance/roles：server 侧按内容指纹热载即效，无需重建。
- 角色模板改动生效前提：宿主 `opencode.jsonc` 插件 options `"syncRoles": true`；改完 `/wf:ping` 确认 8 角色 managed 无 stale。
