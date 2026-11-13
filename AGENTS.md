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
- `tui/index.tsx`：流派 A 低层原语渲染，**禁 JSX**（harness 静态守卫全文件禁 `<box`/`<text`）；slot render 顶层零响应式、唯一动态点是容器内一条 `insert(accessor)`。此结构真机崩溃形态见 docs/HOST-CONTRACT.md，勿"顺手重构"。
- `server/index.ts` 仅按依赖序组装接线，逻辑都在各模块内。
- `server/model-tier.ts` 动态档位跟随（M16-r43）：TIER_MAP/强度序降级/项目级派生文件（纯函数+IO 分离，bun test 直测）。
- `server/skills.ts` skill 托管同步（M16-r45）：仓库 `skills/session-lookup/SKILL.md` 单一来源，setup 同步到宿主全局 `~/.config/opencode/skills/`（默认开启 `syncSkills`，显式 false 关闭；备份/尾行托管标记/hash 跳过同 roles 模式）。
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
- `.workflow/`（含运行态 `wf.db`）与 `.learnings/` 不入库；产物 md、overrides 约定见 README。
- 长 ID 编排纪律（晋升自 LRN-20261112-003，M16-r48 B 层确证）：LLM 编排勿让模型凭记忆复述长不透明 ID——给别名或省略新建、服务端就地自愈改写截断前缀、任何模型可见文本绝不回显完整 ID（回显=转录燃料，抗 compaction 注入点使其常在场自我强化）；DB 审计记录不算回显。
