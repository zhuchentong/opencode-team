# AGENTS.md — wf-workflow（OpenCode 工作流插件）

本仓库是 OpenCode **插件**（状态机 + 关卡层），不是可运行应用。宿主经
`exports["./server"|"./tui"|"./rpc"]` 三入口加载。角色（`wf/*`）内容自 M16-r31 起由本插件托管：
仓库 `roles/` 8 模板为单一来源，`options.syncRoles=true` 时 setup 同步到宿主 `agents/wf/*.md`
的 body（宿主保留 frontmatter/permissions）；改角色内容改 `roles/`，勿手改宿主文件（会被同步覆盖，
无托管标记的用户自有文件除外）。详见 README「已知边界 M16-r31」。

## 命令

- `bun run check` — 唯一门禁五合一：build → `bun test` → `tsc --noEmit` → oxlint（仅 correctness=error 阻塞，warnings 不阻）→ TUI harness。**声明完成前必须跑过。**
- 单测：`bun test tests/flows.test.js`（node:test 兼容，mock ctx，状态库写 `/tmp/opencode/`，无需真宿主）；TUI harness 非 bun test 文件，单独 `bun tui-tests/tui-render.harness.ts`。
- 改 `tui/` 源码后**必须 `bun run build`**（`dist/tui.js` 是已入库的发布产物；生效方式见下方 gotchas）。

## 结构单一来源（改动前先看这里）

- `server/lib.ts`：流转/关卡/纯逻辑与领域类型唯一来源（FLOWS/GATES/evaluateTransition）。改流程语义只改这里，bun test 直接覆盖。
- `shared/phases.ts`：阶段定义，server/tui 共用，勿在任一侧复制。
- `shared/rpc.ts`：RPC 契约，server 与 TUI 两进程各自 import 同源文件；`tests/rpc-drift.test.js` 逐字段快照锁死——改形状必须同步守卫，否则事件/调用静默失联。
- `tui/`（T3.4 拆分后）：`index.tsx`（183 行）=装配+slot render 顶层——流派 A 约束本体（禁 JSX / 顶层零响应式 / 唯一动态点 `insert(accessor)`）只锁它；子模块 `panel.tsx`（渲染纯函数+预览 route）/`data.ts`（对账拉取）/`notify.ts`/`exec-intercept.ts`/`dedup.ts`/`util.ts`。**新增 tui 文件必须加进 `tui-tests/tui-render.harness.ts` 的 `TUI_SOURCES` 清单**（静态守卫拼接扫描，漏加=守卫盲区）。崩溃形态与结构真机结论见 docs/HOST-CONTRACT.md，勿"顺手重构"。
- `server/index.ts` 仅按依赖序组装接线，逻辑都在各模块内。
- `server/model-tier.ts` 动态档位跟随（M16-r43）：TIER_MAP（builder/learner=low，P0-B）/强度序降级/`inherit` 哨兵（不派生=跟随基座）/项目级派生文件（纯函数+IO 分离，bun test 直测）；`options.tiers` 覆盖经 middleware 白名单过滤（未知角色=幽灵 subagent 防御，P1-B）。
- `server/state-scan.ts`（P1-A）：selfmod 护栏域（scanActiveTasks/项目清单）自 state.ts 拆出——state.ts re-export 兼容旧导入路径；**新 scan 类代码写本文件，swallow 前缀 `state-scan:*`**；勿建 state/ 子目录（逃逸 swallow-coverage 非递归扫描）。
- lane 并行（P1-E）：`LANE_CAP`（types 叶子）、`wf:lane set --areas=T01,T02`/`done <Tnn>`、receipt per-lane `build-receipt-<Tnn>.md`（写读成对）、planner lane 分组表契约——详见 roles/{planner,leader,builder}.md。
- 测试环境：mock 包自举**只许**在 `tests/_preload.js`（P0-A 单点化，mock-bootstrap.test.js 守卫）；测试文件禁散装自举副本。
- `server/skills.ts` skill 托管同步（M16-r45）：仓库 `skills/{session-lookup,wf-worktrees}/SKILL.md` 单一来源（`SKILL_IDS` 注册），setup 同步到宿主全局 `~/.config/opencode/skills/`（默认开启 `syncSkills`，显式 false 关闭；备份/尾行托管标记/hash 跳过同 roles 模式）。wf-worktrees=worktree 生命周期协议（清理五步序/lane 分支命名，P0-E）。
- 完整「想改什么 → 改哪个文件」映射见 README「配置变更点速查」表；升级宿主/改流程语义先过 `docs/UPGRADE.md`。

## 宿主联动 gotchas（2.2.6 真机实证）

- 宿主对 TUI 插件模块**路径级永久缓存**：TUI 改动生效 = `bun run build` + `./scripts/tui-restart.sh` 完全重启（`/reload` 不重读 TUI）；server 侧按内容指纹热载。
- 正在被热载的入口文件**禁止分步连续 edit**（中间态会被真实执行，日志报错≠最终缺陷）；全部编辑完成后以最终文件状态核验日志。
- 插件注册双入口：server 部件进 `opencode.jsonc` 的 `plugins`，TUI 部件须另进 `~/.config/opencode/cli.json` 的 `plugins`（本机均已配置）。
- `{package, options}` 的 options **不传达 TUI 部件**；TUI 调试开关用环境变量 `WF_DEBUG=1`。
- 宿主注入的 ctx API 无官方类型：边界显式 `any`，内部数据流用 lib.ts 领域类型；虚拟模块 `@opencode/plugin/*` 声明在 `types/opencode-plugin.d.ts`，首次测试运行会在 node_modules 自举 mock。
- mock 数据形状必须与 server 真实写入形状同源（形状漂移 = 本地全绿、真机静默哑火）。

## 约定与证据链

- docs/HOST-CONTRACT.md 是真机契约结论（宿主契约备忘+已知边界，自 README 迁出），事故原始记录在 `.learnings/ERRORS.md`、`LEARNINGS.md`（.gitignore 排除但本机存在）。与该结论冲突的"常识修复"一律先查证再动手。
- 注释、文档、提交信息用中文；提交格式 = 中文约定式提交 + emoji（见 git log）。
- `.workflow/`（含运行态 `wf.db`）不入库；`.learnings/` 默认应入库随交付提交（wf intake 指引口径，F4），本仓库历史选择仍 ignore——两库策略各自定，产物 md、overrides 约定见 README。
- 长 ID 编排纪律（晋升自 LRN-20261112-003，M16-r48 B 层确证）：LLM 编排勿让模型凭记忆复述长不透明 ID——给别名或省略新建、服务端就地自愈改写截断前缀、任何模型可见文本绝不回显完整 ID（回显=转录燃料，抗 compaction 注入点使其常在场自我强化）；DB 审计记录不算回显。
- 引擎自改并发护栏 v2（selfmod-concurrency-guard，双任务+implant 卡死日志实证）：wf:intake 检测任务目录=插件仓库根（lib.ts isSelfModDir，fail-open）→ **跨库扫描**其它活动任务（state.ts scanActiveTasks：PROJECT_DBS 内存 ∪ 持久清单 `~/.local/share/opencode/wf-projects.jsonl`，逐库查 is_active=1；v1 进程注册表因热载清零=静默失明且休眠任务不可见，已退役）→ ⚠️ 告警按 updatedAt 分级（活跃/休眠≥N 天+处置出口 done/reset）进 intake 输出 + st.selfMod 记账驱动 building 纪律行（entry 通道）。builder/纪律文案对 `server/*` 入口文件禁分步连续 edit（中间态被同进程其它项目会话真实执行，notification×phase-a 实证：他项目 wf.db 被静默 ALTER）。测试隔离：`WF_PROJECTS_FILE` 显式设置=扫描只读该文件、注册不落文件（bunfig preload 全局钉临时路径）。已知边界：另一宿主进程不受本进程热载影响=不覆盖；daily FAIL 修订唯一路径 wf:plan（FLOWS_DAILY review→review 边已移除）；full 模式该边保留（在途兼容）。
- edit 防撞纪律（两任务 4 次 edit 撞车实证）：`sed`/脚本批量重写文件后，必须重新 read 再 edit（old 锚点已失效=撞车主因之一）；`.workflow/**` 产物 md 修订只用 wf_write_artifact patch 或原生 edit 前先 read 原文，禁止凭记忆构造 old 串。
- 拒绝文案 ❌ 前缀不变量（notification-brief-display T05）：新增拒绝/halt/错误文案**必须**以 lib.ts `REJECT_PREFIX`（"❌"）开头——OS 通知 `level==="warn"` 判定（levelFor R1）与 brief 分派（briefFor）都依赖它；成功 guidance 恒以【开头，互斥由 tests/brief-level.test.js 守卫锁死（违反=静默漏弹通知）。零回显：redactIds 替换 token=`〔已隐去〕`（shared/redact.ts，G-1——token 改动必含 ses_ 子串则 brief `!includes("ses_")` 不变量断言必红）。已知降噪边界：full 模式 FAIL→wf:plan 修订轮为 info（wf:fix 才 warn，plan §3.3）。
