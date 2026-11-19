# AGENTS.md — wf-workflow（OpenCode 工作流插件）

本仓库是 OpenCode **插件**（状态机 + 关卡层），不是可运行应用。宿主经
`exports["./server"|"./tui"|"./rpc"]` 三入口加载。角色（`wf/*`）内容自 M16-r31 起由本插件托管：
仓库 `roles/` 8 模板为单一来源，`options.syncRoles`（v2 起默认开启，显式 false 关闭）时 setup 同步到宿主 `agents/wf/*.md`
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
- lane 依赖边表 + learn 前置（W8 效率批）：plan.md fenced ```lane-deps 机器区（`server/domain/lane-graph.ts` 纯函数解析/校验，解析永不 throw）——R0 M/L 缺区/S 豁免、R3 跨 lane 边 provider.wave<consumer.wave（kind=value|type 同规）、R6 声明 wave<拓扑层深=违规；双执法=markVerdicts 单点自 derive laneDepsOk + artifact-tool 写时预检（硬拒仅限 planning/review，building/testing 降级 ⚠️）+ daily/full 双模式 wf:build 第四要素；lessons 前置至 testing 由 leader 内联（`wf:done` 关卡校验 lessonsWritten，gate-reconcile 对账含 lessons），learner 改职 FAIL 取证/显式深审；效率四指标（r1 首过率/并行有效度/双墙钟/返修根因）与「反事实必须实测」条款——详见 docs/HOST-CONTRACT.md「W8 效率批」。
- plan 三机器区写时预检（W8/W11-v2.1/W14 家族，artifact-tool 原生顺序 dep→pm→esc 三块，均挂 writeFileSync **之后**）：「硬拒」真实语义=**拒绝记账不回滚磁盘**（artifacts hash/审计冻结；register 幂等 no-op 早退先于预检=pre-upgrade plan 重放不受拒）——契约与残差见 docs/HOST-CONTRACT.md「W14 节·实现期真机取证」；新增同款预检勿按「未落盘」措辞想当然（dep/pm 文案该处为登记在案的措辞残差）。三件单一来源：`domain/lane-graph.ts`（边表+第四要素）、`domain/probe-matrix.ts`（探针拓扑机器区，与 lane-deps nodes 双射+type 边强制多文件探针，derive probeMatrixOk=wf:build 第五要素）、`domain/plan-escape.ts`（M/L 逃生门条款在场性，仅写时预检不进 gate——评审 Q7 兜底实质面）；均 tierOf!=="S" 统一门、纯函数 never-throw、lib barrel re-export（lib-exports 全集锁+domain-acyclic FILES 须同步）。
- 取证标准化（W12）：每轮真机复盘用 `scripts/wf-forensics.sh --db <wf.db>` 出七段标准报告（终态/rounds/流转轨迹含 gap/返修与委派区间/计数器/产物/口径注记）；SQL 口径与 wf-headless.sh 同源，S 级无委派容错。
- git-init 机检（W13）：`domain/guard.ts` containsGitInit（引号感知+子命令位匹配防误报）+ guard-hook 独立分支置于 blocking 过滤**之前**（building/testing 期 builder 也拦）；触发=活跃任务∧shell∧未 allowGitInit∧任务目录无 .git；逃生口=项目 opencode.json options.allowGitInit:true。
- .workflow 惰性创建（W15-b）：setup 零磁盘副作用——`.workflow/` 仅在首个 workflow **写意图**物化（`/wf:*`、wf_command/wf_write_artifact、管辖 save；headless 脚本 mkdir 显式豁免）；读口（load/scanStates/getReport/dumpStates/countEvents→`ensureAlive(false)`）对未开库空态返回**不物化**，写口首达 ensureOpen（单槽去重+失败 CAS 回滚，防半开库误报无任务）。纪律：`opened` 与 `curIno` 哨兵分离（混用=幻影防御分支吞首开=全站静默失明）；`ready` 键语义=显式 open 触发（生产勿消费，测试 helper 专用）；guard-hook 8 处取证探针 mkdir 挂 `dbgProbe()`（WF_DEBUG=1）；close 未开态 no-op。契约与残差见 docs/HOST-CONTRACT.md「W15-b 节」；锚=tests/lazy-state.test.js。
- 体量自报漂移治理（W15-a）：launch 钉定 `WF_HEADLESS_SIZE`（wf-headless.sh 前置 [$SIZE] 前缀，验收实验控制自变量）+ 事后观察闸 `domain/tier-audit.ts`（S 自报 plan 双信号同向：lane-deps nodes≥5 ∧ ≥S 预算 10KB → ⚠️ 复判回显 + size:drift-observe 记账；不拒绝不改档，硬化留待 ≥3 例立项）；forensics 终态段 size=/drift-observe= 口径。锚=tier-audit/tier-drift-tool 两测试文件；契约见 HOST-CONTRACT「W15-a 节」。
- lane 并行（P1-E）：`LANE_CAP`（types 叶子）、`wf:lane set --areas=T01,T02`/`done <Tnn>`、receipt per-lane `build-receipt-<Tnn>.md`（写读成对）、planner lane 分组表契约——详见 roles/{planner,leader,builder}.md。
- 测试环境：mock 包自举**只许**在 `tests/_preload.js`（P0-A 单点化，mock-bootstrap.test.js 守卫）；测试文件禁散装自举副本。
- `server/skills.ts` skill 托管同步（M16-r45；latency-v3+batch-2 共 9 个）：仓库 `skills/{session-lookup,wf-worktrees,wf-verify-criteria,wf-env-contract-probe,wf-plan-grill,wf-batched-execution,wf-build-receipt,wf-codemod,wf-plan-revision}/SKILL.md` 单一来源（`SKILL_IDS` 注册，**新 skill 追加数组尾部**——测试按下标取 session-lookup），setup 同步到宿主全局 `~/.config/opencode/skills/`（默认开启 `syncSkills`，显式 false 关闭；备份/尾行托管标记/hash 跳过同 roles 模式）。wf-worktrees=worktree 生命周期协议（清理五步序/lane 分支命名，P0-E）；wf-verify-criteria=判据前台验证纪律（通用无域门）；wf-env-contract-probe=环境契约四探针（域门）；wf-plan-grill=plan 可验证性拷问（域门）；wf-batched-execution=批量执行/e2e 选链路/裁定合并（域门）；wf-build-receipt=回执撰写协议（域门）；wf-codemod=pattern 批量改写 dryRun 纪律（域门）；wf-plan-revision=plan 返修/增量 patch 协议（域门）。
- 完整「想改什么 → 改哪个文件」映射见 README「配置变更点速查」表；升级宿主/改流程语义先过 `docs/UPGRADE.md`。

## 宿主联动 gotchas（2.2.6 真机实证）

- 宿主对 TUI 插件模块**路径级永久缓存**：TUI 改动生效 = `bun run build` + `./scripts/tui-restart.sh` 完全重启（`/reload` 不重读 TUI）；server 侧按内容指纹热载。
- 正在被热载的入口文件**禁止分步连续 edit**（中间态会被真实执行，日志报错≠最终缺陷）；全部编辑完成后以最终文件状态核验日志。
- 插件注册双入口：server 部件进 `opencode.jsonc` 的 `plugins`，TUI 部件须另进 `~/.config/opencode/cli.json` 的 `plugins`（本机均已配置）。
- `{package, options}` 的 options **不传达 TUI 部件**；TUI 调试开关用环境变量 `WF_DEBUG=1`。
- 宿主注入的 ctx API 无官方类型：边界显式 `any`，内部数据流用 lib.ts 领域类型；虚拟模块 `@opencode/plugin/*` 声明在 `types/opencode-plugin.d.ts`，首次测试运行会在 node_modules 自举 mock。
- mock 数据形状必须与 server 真实写入形状同源（形状漂移 = 本地全绿、真机静默哑火）。

## 约定与证据链

- docs/HOST-CONTRACT.md 是真机契约结论（宿主契约备忘+已知边界，自 README 迁出），事故原始记录在 `.learnings/ERRORS.md`、`LEARNINGS.md`（.gitignore 排除；本仓库已生成——只读引用，写入归 learner 链路，勿假设其为空也勿手工清空）。与该结论冲突的"常识修复"一律先查证再动手。
- 注释、文档、提交信息用中文；提交格式 = 中文约定式提交 + emoji（见 git log）。
- `.workflow/`（含运行态 `wf.db`）不入库；`.learnings/` 自 M16-r52 起默认 ignore（agent 生成目录不入库，机制性消除 F4「提交后 learner 续写致工作区复脏」竞态；intake 补 gitignore 含两目录）；希望经验随交付提交的项目显式删 `.learnings/` 的 ignore 行（intake 指引已注明该出口）——两库策略各自定，产物 md、overrides 约定见 README。
- 长 ID 编排纪律（晋升自 LRN-20261112-003，M16-r48 B 层确证）：LLM 编排勿让模型凭记忆复述长不透明 ID——给别名或省略新建、服务端就地自愈改写截断前缀、任何模型可见文本绝不回显完整 ID（回显=转录燃料，抗 compaction 注入点使其常在场自我强化）；DB 审计记录不算回显。
- 引擎自改并发护栏 v2（selfmod-concurrency-guard，双任务+implant 卡死日志实证）：wf:intake 检测任务目录=插件仓库根（lib.ts isSelfModDir，fail-open）→ **跨库扫描**其它活动任务（state.ts scanActiveTasks：PROJECT_DBS 内存 ∪ 持久清单 `~/.local/share/opencode/wf-projects.jsonl`，逐库查 is_active=1；v1 进程注册表因热载清零=静默失明且休眠任务不可见，已退役）→ ⚠️ 告警按 updatedAt 分级（活跃/休眠≥N 天+处置出口 done/reset）进 intake 输出 + st.selfMod 记账驱动 building 纪律行（entry 通道）。builder/纪律文案对 `server/*` 入口文件禁分步连续 edit（中间态被同进程其它项目会话真实执行，notification×phase-a 实证：他项目 wf.db 被静默 ALTER）。测试隔离：`WF_PROJECTS_FILE` 显式设置=扫描只读该文件、注册不落文件（bunfig preload 全局钉临时路径）。已知边界：另一宿主进程不受本进程热载影响=不覆盖；daily FAIL 修订唯一路径 wf:plan（FLOWS_DAILY review→review 边已移除）；full 模式该边保留（在途兼容）。
- edit 防撞纪律（两任务 4 次 edit 撞车实证）：`sed`/脚本批量重写文件后，必须重新 read 再 edit（old 锚点已失效=撞车主因之一）；`.workflow/**` 产物 md 修订只用 wf_write_artifact patch 或原生 edit 前先 read 原文，禁止凭记忆构造 old 串。
- 拒绝文案 ❌ 前缀不变量（notification-brief-display T05）：新增拒绝/halt/错误文案**必须**以 lib.ts `REJECT_PREFIX`（"❌"）开头——OS 通知 `level==="warn"` 判定（levelFor R1）与 brief 分派（briefFor）都依赖它；成功 guidance 恒以【开头，互斥由 tests/brief-level.test.js 守卫锁死（违反=静默漏弹通知）。零回显：redactIds 替换 token=`〔已隐去〕`（shared/redact.ts，G-1——token 改动必含 ses_ 子串则 brief `!includes("ses_")` 不变量断言必红）。已知降噪边界：full 模式 FAIL→wf:plan 修订轮为 info（wf:fix 才 warn，plan §3.3）。
