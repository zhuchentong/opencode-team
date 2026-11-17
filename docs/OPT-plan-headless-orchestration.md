# 优化方案 v2：无头编排与状态库治理（源自 test_44 真机验证复盘）

> 依据：test_44 csvkit-rfc4180 M 级任务（非交互 `opencode run`，WF_DEBUG=1）运行日志×3、
> opencode.db 4 会话消息、wf.db 事件。总耗时 24 分钟（vs wecom 基线 141 分钟），
> 但**子代理委派 0 次**（leader 单会话自演全角色）——本方案治理验证中暴露的 5 个问题。
> **v2 修订**：经两路独立审查（逻辑审查 3 major + 代码对质审查 1 blocker + 3 major）后重写
> M1/M2/M3 并吸收 F5 线索，消项记录见 §十。

## 一、问题 → 措施映射（含实测锚点）

| # | 问题（实证） | 级别 | 落点（实测锚点） |
|---|---|---|---|
| 1 | 非交互模式模型回合结束即停，需外部循环脚本踢进 | P1 | M1b `scripts/wf-headless.sh`（唯一驱动）+ M1 `wf:resume` 审计/guidance 轨 |
| 2 | 同 slug 双活任务（resolveState 兜底路由污染风险） | P1 | M2 intake apply 步闸（transition.ts）+ 防并发唯一索引 |
| 3 | 新项目 wf.db 首启含异项目行（test_44 实证） | P2 | M4 调查：**头号嫌疑=state.ts ready() 一次性迁移 L393-432**（host.storage.scan 全量导入，updatedAt 原样保留——与现场"新文件含旧时间戳行"签名吻合） |
| 4 | 确认卡审计无法区分用户确认 vs 非交互自动裁定 | P2 | M3 环境信号标记（execute.before 观测不到取消，原设计已否决） |
| 5 | headless 已知边界无文档；9 个托管 skill 域门在无头模式触发情况未验证 | P3 | M5 HOST-CONTRACT 新节（含 skill 触发盲区条目） |

## 二、措施设计

### M1b `scripts/wf-headless.sh`（**唯一驱动轨**，治 #1）

**改动**：产品化本次 advance-loop 脚本。已修正的三处可操作性欠账：
1. **session id 来源**：参数改为 `<项目目录> [初始提示]`——无既存会话时 wrapper 自己发起首次
   `opencode run --agent workflow`（内含 intake 指令）并从 stdout/stderr 解析会话 id；有既存会话时
   **以 wf.db 为权威反查**（`SELECT session_id FROM tasks ORDER BY updated_at DESC LIMIT 1`——
   真机教训：opencode.db `rowid DESC` 会选中已 reset 的残留会话，导致对 done 任务误重跑）；
2. **终态分支**：phase=`done` → PASS 退出 0；事件 `ok:false`（halt——仓内无 failed phase，halt 时 phase 保持原值，判定锚是事件而非 phase）/迭代上限耗尽/sqlite3 读数失败重试 3 次仍败 → **FAIL 退出非 0**
   并输出最后事件（区分"推到 done"与"没推到"）；
3. **依赖与前置检查**：头部 `command -v sqlite3` 检查（缺失报错退出）；**硬编码内建
   `--agent workflow`**（机制性消除默认 build 误启）；入口校验 `--model` 的 provider 已配置
   （复用上次 anthropic 失败教训）。

**验收**：test_44 场景回放——一条命令从 building 推到 done，退出码 0；人为 halt 场景退出码非 0。

### M1 `wf:resume` 命令（**审计/guidance 轨**，诚实降级）

**已核实的边界**：commands.ts injectReport 用 `prompt(resume:false, steer)`（L150），HOST-CONTRACT
明记 resume:false **源码级不唤醒模型**——回合结束即退出，服务端注入不能独立驱动推进。
**因此 M1 诚实降级为**：`wf:resume` 只做①读 phase ②在会话轨记审计（`resume:issued` 事件）
③组装推进指令写入 instructions（若恰有活跃回合则被消费）。**推进唯一驱动=M1b**。
**验收相应改写**：wf:resume 的验收=事件记账与 guidance 组装正确（单测）；"推到 done"验收归 M1b。

**改动**：server/commands.ts 注册表新增（leader-only 变更类：不入 policy.ts READONLY_CMDS——
变更类 fail-closed；拒绝文案 REJECT_PREFIX ❌ 开头）；commands.ts 头注释「6 辅助命令」计数同步。

### M2 intake slug 唯一性闸（治 #2，含并发窗口）

**改动**（三件，缺一即为隐藏 server 改动——v1 教训）：
1. **deps 签名**：`TransitionDeps`（transition.ts L56-63）加 `dumpStates`；commands.ts L109 调用点
   解构同步；tests/helpers/command-deps.js:18 默认 stub 恒返回 []——**4+1 个新测试例须显式覆写
   deps 接 store-stub**（flows.test 的 helper 是 mkSt/mkWiringHarness，非 stOf）；
2. **闸逻辑**（intake apply 步，评估通过后写行前）：同库 `slug 相同 ∧ is_active=1 ∧ session_id 不同
   ∧ phase NOT IN ('done')` → ❌ 拒绝（含对端 session 短前缀别名 + `wf:reset` 出口）；放行分支：
   本会话 re-intake／对端 done／**对端 is_active=0**。测试共 **5 例（含 fail-soft 反例）**：
   ①跨会话同名拒（❌ 含出口）②本会话 re-intake 放行 ③对端 done 放行 ④对端 is_active=0 放行
   ⑤dumpStates fail-soft（catch 返回 []）→ 闸放行=静默漏拦的反例须显式断言该形态的处理约定。
3. **并发窗口收口**：check-then-insert 对跨行无锁（CAS 只锁本会话行），SCHEMA 迁移追加
   partial unique index `ON tasks(slug) WHERE is_active=1 AND slug!=''`；**存量库可能有既有重复行**
   → 建索引失败（IntegrityError）时 fail-open：swallow 记账 + diagnose 报告提示手工清理
   （不阻塞启动）；新库索引天然生效。

**测试**：tests/flows.test.js 补 5 例 + fail-soft 反例；**验证**：`bun test tests/flows.test.js`。

### M3 确认卡审计 auto 标记（治 #4，重设计：环境信号轨）

**v1 设计已否决**（blocker）：guard-hook 只注册 `execute.before`（guard-hook.ts L4/L58，文件头实测
"output 为空"），L281/L293 观测点在工具执行前触发，**取消发生在 hook 返回之后，原理上不可从
工具 state 判定**；且存量锚 tests/plan-confirm.test.js:103、intake-orch.test.js:105/126 精确断言
note==="question-observed"。

**v2 设计——环境信号整会话标记**：
1. **前置探针步**（实施第一步，不可跳过）——**已执行，结论（2026-11-17 取证回写）**：
   - **①取消形态 hook 观测点**：test_44 生产取证（非交互 run，`.workflow/_debug/question-probe.json`
     @2026-11-16T09:48 + wf.db 事件）证明 **execute.before 对 question 照常触发**：input 形状
     `{tool, sessionID, agent, messageID, id, input{questions}}` 与 GUI 相同（hookAgent=workflow）；
     事件轨在非交互下照常记账 `intake:confirm`/`plan:confirm` note=`question-observed`（09:55/10:06
     两条）——锚定标签匹配（`需求无误`/`批准`）作用于**模型入参 options**，与用户侧是否取消无关，
     取消形态不改变匹配行为。宿主"取消/自动裁定"发生在 hook 返回之后（或自动放行），不可从
     hook 观测——这正是审计无法区分的根因，也是 v1 blocker 的准确表述。
   - **②WF_HEADLESS 可达性**：同进程 env 继承成立——生产实证：本仓 `.workflow/_debug/cmd-report.jsonl`
     有真实输出（2026-11-11 `slot+emit` 多条），该探针门控即 `process.env.WF_DEBUG === "1"`
     （commands.ts PROBE_ON），证明插件 server 进程内 `process.env` 读取生效且继承启动 CLI 的环境；
     `opencode run` 与 GUI server 同一启动链 → WF_HEADLESS=1 经 wrapper 环境传入 server 进程，
     guard-hook 作用域可读。降级方向安全：若宿主未来改多进程架构致 env 不可达，标记退化为
     GUI 同形（零标记），无误标风险。
   - 探针局限说明：审查沙箱 HOME 只读，无法活体复现 `opencode run`；①②结论基于 test_44/本仓
     生产取证 + 同进程事实，复现命令=M5 文档（headless run + WF_DEBUG=1 联查 question-probe.json
     与 wf.db question-observed 事件）。
2. **实现**：wrapper（M1b）启动时设 `WF_HEADLESS=1`；插件与宿主同进程，`process.env` 直接可达
   （探针②生产实证如上）；检测该 env → `note` 追加 `auto=non-interactive`；**交互模式（GUI）不设 env，
   note 零改动**——存量锚按"env 未设"路径零改动成立。
**验收**：探针报告 + 2 测试例（env 设/不设两态）；**验证**：对应测试文件（plan-confirm.test.js
归属）+ `bun test`。

### M4 状态库种子污染调查（治 #3，先取证后改）

**头号嫌疑（代码对质审查 F5 提供，签名吻合）**：state.ts `ready()` 一次性迁移 L393-432——
tasks 空时从 `host.storage.scan({prefix:STATE_PREFIX})` 全量导入旧行且 **updatedAt 原样保留**
（L416 qUpsert）——精确解释"新文件含旧时间戳行"与无 slug 幽灵行。**第一取证项=该 scan 的
作用域**（per-project 还是全局——若全局，任何新项目首启都会吸入全部历史项目任务行）。
取证步骤：①读 ready() 迁移条件与 scan prefix 语义；②复现：构造含旧项目行的 host.storage，
新目录首启观察导入范围；③按根因出修复任务卡（方向：scan 加 project 维度过滤或迁移加
directory 归属校验）。**本批零代码改动**。

### M5 headless 已知边界文档（治 #5）

docs/HOST-CONTRACT.md 新节「无头模式（opencode run）实测边界」：
- 必带 `--agent workflow`（默认 build → leader 闸 ❌ 拒）；子代理 depth=1 不可用 → leader 自演，
  **lane 并行/tier/worktree 架构不被覆盖**，架构验收必须 GUI 任务；
- question 非交互取消 → 宿主降级 + auto 标记（M3）；
- **9 个托管 skill 的域门在无头模式的触发情况未验证**（test_44 仅见 5 个触发横幅，
  wf-batched-execution/wf-worktrees/wf-codemod 未见）——headless 不作为 skill 触发的验收环境；
- injectReport resume:false 不唤醒模型（M1 边界的出处）。
README.md:158 速查表加一行索引。**验收**：每条含复现命令与预期输出（评审 checklist 判 PASS）。

## 三、执行清单（唯一权威版本）

| 步骤 | 内容 | 验证命令 | 预估 |
|---|---|---|---|
| 1 | M2 三件套：deps 签名 + 闸逻辑（5 例 + fail-soft 反例）+ partial unique index 迁移 | `bun test tests/flows.test.js` | 2.5h |
| 2 | M3 **前置探针**（取消路径 hook 形态 + WF_HEADLESS 可达性），结论回写文档 | 探针报告评审（含可复现命令=PASS） | 1h |
| 3 | M3 实现（env 信号 + 2 测试例；探针若证伪则回 §四改文档层审计边界） | `bun test tests/plan-confirm.test.js tests/intake-orch.test.js` | 1h |
| 4 | M1 wf:resume（审计轨，含头注释计数）+ M1b wrapper（终态分支/依赖检查/内置 agent/model 前检） | `bun test` + test_44 回放（done=退出 0，halt=非 0） | 2.5h |
| 5 | M5 文档 + README 索引 | §二 M5 checklist | 0.5h |
| 6 | M4 调采取证（零代码），根因报告 | 报告含可复现命令=PASS | 1h |
| 7 | `bun run check` 全绿 | 门禁五合一 | 0.5h |

合计 **~9h**。步骤 1/3/4 动 server 入口文件，**禁分步连续 edit**（热载 gotcha）；
一个编辑会话内连续完成后统一验证。

## 四、显式不做清单

| 项 | 理由 | 去向 |
|---|---|---|
| 无头模式支持子代理委派 | 宿主 run 能力边界，插件仓外 | opencode 上游需求 |
| wf:resume 服务端自动多轮循环 | 宿主无迭代原语；resume:false 不唤醒模型（F2 实证） | M1b wrapper 唯一驱动 |
| guard-hook 判定 question 取消（v1 M3 原设计） | execute.before 观测不到执行后取消（F1 blocker） | 改环境信号轨（M3 v2） |
| 状态库污染直接修码 | M4 先取证；头号嫌疑 ready() 迁移已锁定 | 根因报告后立任务卡 |
| lane 并行/tier/worktree 无头覆盖 | 架构验收属 GUI 任务 | GUI M 级任务回放 |
| skill 域门无头触发验收 | 无头非 skill 验收环境（leader 自演无 builder） | GUI 任务回放清单补查 |

## 五、回放验收（生效判据）

1. test_44 场景：`wf-headless.sh` 一条命令 building→done 退出码 0；人为 halt 退出码非 0 且输出末事件；
2. 跨会话同 slug intake → ❌ 拒绝含 reset 出口；re-intake/对端 done/对端非活跃三正例放行；
   并发双 intake（同 slug 两会话同时）→ 至多一成功（索引兜底）；
3. wrapper 场景事件 note 含 `auto=non-interactive`；GUI 会话（env 未设）note 不变；
4. M4 根因报告含可复现命令（=PASS），修复任务卡就绪；
5. GUI 交互 M 级任务：子会话 ≥3、tier:inject 实发、lane worktree 在位（架构层补验）。

## 六、回滚

- M1/M2/M3 均追加逻辑：还原 hunk 即可；M2 唯一索引为增量迁移——回滚需显式 DROP INDEX
  （文档在实现时注明索引名）；M1b 脚本删除即回滚；文档直接还原。
- rpc-drift 不涉（未改 shared/rpc）；roles/skills 托管面不动。

## 十、审查消项记录（2026-11-17 两路独立审查：逻辑 3 major+4 minor；代码 1 blocker+3 major+2 minor）

| 来源 | finding | 消项 |
|---|---|---|
| 代码 F1 blocker | M3 前提不成立（execute.before 观测不到取消；存量锚精确断言） | M3 重设计为环境信号轨（WF_HEADLESS 整会话标记）+ 前置探针步；原设计移入不做清单 |
| 代码 F2 major | inject resume:false 不唤醒模型，M1 验收恐落空 | M1 诚实降级为审计/guidance 轨；推进唯一驱动=M1b；验收分离 |
| 代码 F3 major | M2 漏列 dumpStates deps 签名/调用点/测试 stub 改动 | M2 改动三件套显式列全（TransitionDeps L56-63、commands L109、command-deps.js:18） |
| 代码 F4 major | check-then-insert TOCTOU 并发窗口 | 增 partial unique index 迁移 + 存量库 IntegrityError fail-open 处理 |
| 代码 F5 minor·线索 | 状态库污染头号嫌疑=ready() 迁移 host.storage.scan | M4 第一取证项改写 |
| 代码 F6 minor | dumpStates fail-soft 静默漏拦 + parse 裸字符串形态 | M2 实现 guard 要求 + fail-soft 反例测试 |
| 代码 F8 minor | commands.ts 头注释"6 辅助"计数将过时 | 步骤 4 收尾项 |
| 逻辑 #1 major | M3 缺实证锚 | 同 F1 消项（前置探针步成为步骤 2，不可跳过） |
| 逻辑 #2 major | wf-batched-execution 触发盲区未纳入 | M5 边界文档补条目 + 不做清单第 6 行 |
| 逻辑 #3 major | M1b session id 来源/终态分支/sqlite3 依赖欠账 | M1b 三处修正（来源定义/done 与 FAIL 退出码区分/依赖前置检查）+ 内建 --agent workflow 与 model 前检 |
| 逻辑 #4 minor | slug 闸缺 is_active=0 维度测试例 | M2 测试扩为 5 例 |
| 逻辑 #5 minor | 步骤 2/4/5 验证命令不可判定 | 各步验证落到具名文件/checklist 判据 |
| 逻辑 #6 minor | agent 误启/model 失败应机制性消除 | 并入 M1b 内建前检（覆盖逻辑 #2 遗漏①②） |
| 两路共同 | 工时预估偏低 | 6.5h → 9h（含探针步与并发收口） |
