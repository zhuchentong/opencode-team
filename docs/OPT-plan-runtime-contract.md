# 优化方案 v3：执行阶段耗时治理（wecom-dingtalk-login 复盘）

> 依据：wf.db 42 条事件 + 6 会话逐消息时间线。任务总耗时 141:54，building 102:19（72%）。
> 本版为**唯一权威版本**（v1/v2 经两路独立审查后重写，旧版措辞一律以本文为准）。
> 审查记录：逻辑完备性审查（首轮 FAIL，8 findings）+ 代码对质审查（首轮 PASS 但 4 major 虚假声明），
> 本版已逐条消项，见文末「十、审查消项记录」。

## 一、收益口径（统一表，全文唯一测算）

| # | 根因（实证） | 浪费上限 | 其中合理成本 | 计入预期节省 | 落点 |
|---|---|---|---|---|---|
| 1 | 环境契约问题执行中段才暴露（env 净化 / AI_AGENT→configHash / .vue 盲区 / URL 重写） | ~40min | 部分排查属必要（~10min） | ~30min | planner + planner-reviewer |
| 2 | 判据命令放后台 → 会话假死 → 4 次 session:correct 续接 | ~15min | 0 | ~15min | builder 纪律 + guidance 一行 |
| 3 | 波2 单 lane 串行（T07→T08 同会话 63min） | ~25min | 0 | ~25min | planner lane 规则 |
| 4 | e2e 全量冷启动反复跑（cache:false，≥6 轮，其中红绿抽查 2 轮合理） | ~12min | 合理轮次 ~4min | ~8min | builder 纪律 + 项目脚本 |
| 5 | 交互裁定碎片化（6 次 question 共 9min，单次最长 5:18）+ 虚假归因返工 | ~9min | 少量裁定必要 | ~5min | builder/leader 协议 |

口径说明：①浪费上限合计 ~101min 全部发生在 building 阶段；②「计入预期节省」合计 **~83min，
为高置信项合计（各项相互独立、可加总）**；③对外承诺口径取保守值 **building 102min → 50-60min、
总时长 141min → 90-100min**（留出探针本身 ~10min 成本与执行折扣）；④更高收益（→40min）视为上行空间
不作承诺。收益为同规模任务的上限估计，实际以回放验收为准（见 §八）。

---

## 二、措施设计（权威描述，取代 v1 P0-P2 章节与 v2 部分表述）

### M1 判据前台纪律（治根因 2）

- `skills/wf-verify-criteria/SKILL.md`（**通用 skill，无域门**）：借鉴 obra/superpowers
  verification-before-completion 骨架——铁律（无新鲜验证证据不得宣称完成）→ Gate 五步 →
  红旗清单 → 借口表（"上次跑过"→不算；"应该能过"→去跑；"放后台了"→重跑前台 timeout≥900000ms）
  → 正反例（tester 5:31 标杆 vs 波2 后台假死 4 次续接）。
- `roles/builder.md` 追加 1 行（自带触发条件）：「判据命令（build/test/e2e/check 等决定回执结论的
  命令）一律前台执行、timeout≥900000ms、直采退出码——执行前按 `wf-verify-criteria` skill 核对」。
- **L2 服务端强化**：`server/guidance.ts` building 动态尾（L166-181 单点）追加一行
  「判据命令须前台 timeout≥900000ms 直采退出码」。已核验：dynamicTail 消费链在 L244；
  daily-mode/p3-hint-overrides/intake-guidance 测试无 building 文案字节锚（p3 仅数值正则）；
  【开头惯例与 REJECT_PREFIX ❌ 不变量（brief-level.test）不涉及 body 追加行。
- ⚠️ **observe.ts 行为级检测（检测"判据命令被放后台"）明确不做**：已核验 background-lamp 实际在
  guard-hook.ts 且只观测委派参数 `input.background`，看不到 shell 命令执行方式；实现需 shell 工具
  新增 execute.before 钩子 + 记账，属全新 server 逻辑 → 列入 §六独立任务单。

### M2 环境契约探针（治根因 1）

- `skills/wf-env-contract-probe/SKILL.md`（**带域门**）：借鉴 systematic-debugging Phase1
  "组件边界逐层取证"。四探针，各给单行命令模板 + 判定标准：
  1. env 透传：`WF_PROBE_MARKER=1 <runner> <已有任务>` → 任务内 `echo $WF_PROBE_MARKER`，空=净化；
  2. 缓存稳定：两次异 env 启动比对 configHash/optimizeDeps 行为（是否触发重优化+子应用 reload）；
  3. 工具链盲区：(a) .vue SFC 注入已知不存在的导出 import 跑 typecheck；(b) external 共享包
     import 不存在 named export 跑 build——任一静默 = 该缺陷不受波次闸保护；
  4. 断言路径：核对 e2e 断言点 URL 不被应用路由/replaceState 重写。
  产出格式：命令|退出码|结论 三列表（直接粘进 plan）。借口表：「VITE_ 前缀够用」→探针1；
  「loadEnv 会透传 process.env」→那是 .env 文件语义非 runner 语义。
- `roles/planner.md` 追加：M/L 级 plan 必含「环境契约探针」节；**未执行的验证禁写"已实证/
  ×首跑实证"**，只能写「假设：…；首跑前验证：<命令>」，且列为对应 T 点第一个验收步骤。
- ⚠️ **"plan 缺探针节时 wf:review 自动 warn"守卫不做**：warn 需 server 在 review 路径新增
  plan.md 内容解析，非零 server 改动 → 由 M3 审查维度人工兜底；如需自动化列入 §六独立任务单。

### M3 计划审核「可验证性」维度（配合 M2）

- `skills/wf-plan-grill/SKILL.md`（**带域门**）：借鉴 mattpocock grill-me——逐分支拷问 +
  「能自答必取证」原则 + 固定问项「每条'已核实/实证'的取证命令与退出码在哪？无→降级假设并打回」。
- `roles/planner-reviewer.md`「五维汇总」扩「六维」⚠️ **五维硬编码共 7 处，须同步改**（已执行核实
  比预估多 2 处）：roles/planner-reviewer.md（L1/L13）、roles/leader.md（**L37 与 L38 两处**）、
  server/guidance.ts（L152 注释 + L217-218 review 委派文案）、shared/prompts/gates.ts（L26
  wf:review 委派 prompt）、README.md（L45）、tests/roles.test.js（L256 锚改 `/六维/`）。**漏改
  gates.ts/guidance.ts 会导致委派指令与角色模板契约漂移（模型收到矛盾指令）**。

### M4 执行形态纪律（治根因 3/4/5）

- `skills/wf-batched-execution/SKILL.md`（**带域门**）：①探查类 shell 一条消息批量发；②e2e
  迭代期选链路执行、收尾+tester 才全量+红绿抽查一次、全量轮次入回执（>3 轮须写原因）；
  **项目 e2e 无选链路参数时，先为 e2e 脚本加该参数并列为 T 点第一个验收步骤（不假设参数存在）**；
  ③runner 缓存用 untrackedEnv 白名单，禁 `cache:false` 全关；④范围外/方案类裁定满 3 条或 10 分钟
  合并一次 question，question 响应定性「参考意见」，正式裁定须 leader 记录可追溯。
- `roles/planner.md` lane 分组表节追加三补丁：
  1. 单 lane 内 T 点链长 >2 须附不可拆证据；
  2. **lane 预估自检**（静态纪律，planner 规划时执行；不涉及 wf:build 运行时行为）：lane 预估
     >30min（e2e/门禁型 45min）须在 lane 表附分组理由；
  3. 含 e2e 的 T 点预列「可能牵连的基建文件」（vite config/runner env/凭证注入）并给预裁定。
- `roles/leader.md` 追加一行：回执中「上级裁定」表述须核对自身交互记录确认裁定确曾下达。
- ⚠️ **guidance 检测 question 间隔自动提示不做**：guidance() 是纯函数（profile-shape.test 锁定
  派发形态），拿不到工具调用历史；guard-hook 现有 question 观测仅 leader 门控与确认窗口，building
  阶段 question 不入 st；实现需记账 + RPC 契约扩展（必撞 rpc-drift.test 快照）→ 列入 §六独立任务单。

---

## 三、skills 通用规格（4 个 skill 一致约束）

- frontmatter：**第 1 行必须是 `---`**（sid-reliability L239 锚），含 `name` + `description`
  （YAML 块标量）双字段——宿主按 name 展示/匹配，description 按触发措辞写（仿 session-lookup 范式）；
- 正文 ≤40 行，铁律置首节，探针命令压成单行代码块（低档模型遵从度约束，builder 实跑 low 档）；
- **域门**：`wf-plan-grill`/`wf-env-contract-probe`/`wf-batched-execution` 的 description 末尾加
  「仅 wf 工作流任务会话内适用；非 wf 任务/普通项目开发不适用」（skills 同步到宿主全局目录对所有
  agent/项目可见，HOST-CONTRACT r56）；`wf-verify-criteria` 通用不做域门；
- roles 引用行必须自带触发条件判断（"满足 <条件> 时按 `wf-xxx` skill 执行"），不能只写"见 skill"。

---

## 四、执行清单（唯一权威版本，按序执行）

| 步骤 | 内容 | 验证方式 | 预估 |
|---|---|---|---|
| 1 | `wf-verify-criteria` skill（§三规格）+ builder 引用行 | 文件在位 + 内容自审 | 0.5h |
| 2 | `wf-env-contract-probe` skill + planner 探针节 + 措辞禁令 | 同上 | 1.5h |
| 3 | `wf-plan-grill` skill + 六维改造（**含 §二 M3 的 5 处同步 + roles.test L256 锚**） | `bun test tests/roles.test.js` | 1.5h |
| 4 | `wf-batched-execution` skill + lane 三补丁 + leader 防归因行 | 文件在位 + 内容自审 | 1.5h |
| 5 | `SKILL_IDS` 追加 4 id（**追加数组尾部**，sid-reliability 多处按下标取 session-lookup，
     插前面会静默改变断言语义）+ **sid-reliability 锚同步**（L236 deepEqual 扩 6 项 + 新增同步用例）
     + AGENTS.md/README 的 skill 清单枚举更新 | `bun test tests/sid-reliability.test.js` | 1h |
| 6 | guidance.ts building 一行强化（§二 M1-L2） | `bun test tests/daily-mode.test.js tests/p3-hint-overrides.test.js` | 0.5h |
| 7 | `bun run check` 全绿 + 冒烟（§八） | 见 §八 | 0.5h |

合计 **~7h**。每步独立可交付，做完一步跑对应测试，全部完成跑 `bun run check`。

## 五、显式不做清单（本批不做，均有理由）

| 项 | 不做理由 | 去向 |
|---|---|---|
| observe.ts 检测判据命令放后台 | background-lamp 在 guard-hook 且只看委派参数，需 shell execute.before 新钩子 | 独立任务单 |
| plan 缺探针节 wf:review 自动 warn | 需 server 解析 plan.md 内容 | M3 审查维度人工兜底；自动化列独立任务单 |
| guidance 检测 question 间隔 | guidance 纯函数无工具历史；需记账 + RPC 契约扩展（撞 rpc-drift 快照） | 独立任务单 |
| P0-3 挂载冒烟闸（波次闸判据加挂载冒烟） | 动 gate-reconcile 判据 + 测试 | 独立任务单（0.5-1d） |

## 六、独立任务单（不在本批）

1. 挂载冒烟闸：波次闸在 test+typecheck 外追加 `createApp().mount` 冒烟判据；探针 3b 判定工具链
   不查 .vue 时升为必选。验收：App.vue `usePinia` 类崩溃在波1 闸即红。
2. 判据后台执行行为级检测（见 §五第 1 行）。
3. question 频次观测与批量裁定提示（见 §五第 3 行）。

## 七、回滚方式

- skills：删除 `SKILL_IDS` 中对应 id + 删仓库 `skills/<id>/` 目录；宿主侧文件由托管标记
  （`wf-workflow:managed-skill` 末行标记 + hash）管理，同步器对未注册 id 不再写入；
  手动清理可删 `~/.config/opencode/skills/<id>/`（同步时自动有 `.bak-<ts>` 备份）。
- roles/guidance：还原追加行即可（roles 由 fm 快照 + hash 托管，追加行删除后 hash 回退 → 下次
  setup 同步自动还原宿主文件）；guidance 一行删除后无消费残留。

## 八、冒烟与回放验收

**冒烟（步骤 7，可判定）**：
```bash
ls ~/.config/opencode/skills/ | grep -E "wf-verify-criteria|wf-env-contract-probe|wf-plan-grill|wf-batched-execution"   # 4 行命中
tail -1 ~/.config/opencode/skills/wf-verify-criteria/SKILL.md | grep -q "wf-workflow:managed-skill"                      # 托管标记在位
head -1 ~/.config/opencode/skills/wf-env-contract-probe/SKILL.md | grep -q -- "---"                                      # frontmatter 首行
grep -l "仅 wf 工作流任务会话内适用" ~/.config/opencode/skills/wf-{env-contract-probe,plan-grill,batched-execution}/SKILL.md  # 3 文件域门在位
```
4 条全过 = 冒烟 PASS；任一失败 = 检查 `SKILL_IDS` 注册与 setup 同步日志（notify「skill 同步」）。

**回放验收（首个同规模任务）**：plan 含探针节；building 无后台判据；无 session:correct 续接；
e2e 全量 ≤3 轮；question ≤2 次。达标 = 方案生效（目标 building 102min → 50-60min）。
不达标分层定位：L1 未触发→改 description 触发措辞；触发未遵从→升 L2（检查 guidance 行是否在
building brief 中出现）；审计超标→任务级复盘晋升纪律。

## 九、正面核验结论（代码对质审查确认，供执行者信心）

skills 托管链路（SKILL_IDS 一行注册 + renderSkill/syncSkills/managed-sync）成立且宿主真机已落盘；
R2-L2 guidance 一行改动无测试字节锚冲突、不变量（【开头/❌ 前缀）不涉及；roles/*.md 追加纪律行安全
（fm 快照仅 missing→create 使用，追加→hash 变→write 保既有 fm，无反向内容锚）；wf/builder 子会话
可达宿主 skills（HOST-CONTRACT r56）。

## 十、审查消项记录（2026-11-16 两路独立审查，合计 15 条：逻辑 8 + 代码 7）

| 来源 | finding | 消项 |
|---|---|---|
| 逻辑审查 blocker | 三份执行清单并存且两份自称最终 | 本文 §四为唯一权威清单，v1/v2 清单随旧章节一并移除 |
| 逻辑审查 major | P0-4 observe.ts vs R2-L2 口径不一 | §二 M1 明确 observe.ts 检测不做（§五），仅保留 guidance 静态行 |
| 逻辑审查 major | "无 server 逻辑改动"与多项 server 需求冲突 | §五显式不做清单 + §六独立任务单，逐条注明理由 |
| 逻辑审查 major | §七"替代第六节"但章节编号不存在、被替代章节未标注 | v3 重构消除叠层；被替代表述全部移除，M 章为唯一措施描述 |
| 逻辑审查 major | 收益三套数字互斥（101 vs 65；51 vs 92） | §一统一口径表：浪费上限 101 / 高置信可省 83 / 对外承诺保守 141→90-100，声明不可跨口径加总 |
| 逻辑审查 major | lane 预估 wf:build 运行时提示混入纯文案步骤 | §二 M4 补丁 2 改为 planner 规划期静态自检纪律 |
| 逻辑审查 minor | 冒烟步骤不可判定 | §八给出 4 条具体命令与 PASS 判据 |
| 逻辑审查 minor | 无回滚说明 | §七补回滚方式（托管标记 + hash 回退机制） |
| 代码审查 major | observe.ts 无 lamp/background 代码，检测点不存在 | 同第 2 行消项，§二 M1 ⚠️ 段已写明真实位置（guard-hook）与实现成本 |
| 代码审查 major | guidance 纯函数拿不到 question 历史，P2-3 不可行 | §五第 3 行显式不做 |
| 代码审查 major | P0-1 warn 守卫需 server 解析 plan.md，"纯文案+守卫测试"虚假 | §五第 2 行显式不做，M3 人工兜底 |
| 代码审查 major | 五维硬编码 5 处（含 gates.ts/guidance.ts/roles.test L256 锚），方案漏列 | §二 M3 显式列 5 处同步清单；步骤 3 验证含 roles.test |
| 代码审查 minor | frontmatter 规格不完整（name 字段/首行 ---） | §三通用规格 |
| 代码审查 minor | AGENTS.md/README skill 枚举过期 | 步骤 5 收尾项 |
| 代码审查 minor | SKILL_ID 插入位置影响下标断言语义 | 步骤 5 明确"追加数组尾部" |
