# PLAN — r54 优化批次方案（test_008 日志实证驱动，2026-11-15）

> 状态:**已执行完毕**(2026-11-15)——批次 A/B/C/D1/D2 分别落 f34bb6f/a20ab7f/(C commit)/c76a86f/(D2 commit),每批门禁 EXIT=0(421→427 pass+TUI 189+oxlint 0);D 批触 tui/ 已随建 dist,**生效须 `./scripts/tui-restart.sh` 完全重启**(宿主对 TUI 模块路径级永久缓存);契约记录见 HOST-CONTRACT M16-r54 条。
> 数据来源:test_008 全流程日志(.workflow/_debug 11 探针+tui-refresh.log 1625 行+跨库 wf.db 实况+宿主进程 fd 实况);交叉验证后 D2 换靶(fingerprint 桶→interval 跳拍)、撤销"扫描连接 LRU"(scanActiveTasks 已 finally close,常驻连接属设计内)、新增 A3(GC 5s 空转,比原方案收益更大)。

## 批次 A · state.ts 数据安全(f34bb6f)
- **A3 GC 节流**(新发现,最高收益):scanStates 60s 窗口跳过 qGc/qGhost——TUI 对空闲项目每 5s 调 list→scanStates 白跑 2 条 DELETE 写事务(实证:~/.workflow、插件库 -wal/-shm mtime 任务结束后仍在刷新)。
- **A1 WAL 收口**:done/reset 后显式 `wal_checkpoint(TRUNCATE)` + `wal_autocheckpoint` 1000→64 页(默认 1000 页≈4MB 是 45KB WAL 悬唯一副本永不收拢的根因;test_008 状态库空库事故暴露面)。

## 批次 B · diagnose 孤儿产物对账(a20ab7f)
`orphanArtifactLines` 纯函数(lib 出口,77 名全集锁同步)+wf:diagnose 接线(dumpStates 复用零新 SQL):.workflow 子目录近期(≤14 天,与 done GC 窗口对齐防完工误报)含 md 但 tasks 无 slug → ⚠️ 信息行(不加 ❌ 前缀)。已知局限:mtime 可被 touch 干扰(HOST-CONTRACT r54)。

## 批次 C · wf-projects.jsonl 去重
registerProject 同 dir+dbFile 去重(进程内 SEEN+惰性基线回读);判定抽 `projectAppendNeeded` 直测——WF_PROJECTS_FILE 钩子既有契约(env 设置=注册完全不落盘)保持不变,故写入面经判定函数测试。存量 98KB 重复行不写迁移代码,diagnose 观测+手工去重即可。

## 批次 D · TUI 两项(生效须完全重启)
- **D1(c76a86f)**:loaded 探针加 distMtime(selfMtimeIso,import.meta.url 先例)——版本标签陈旧归因锚(test_008 实证 10:35 跑 build=M16-r47/11:18 重建才 r53)。
- **D2**:空闲轮询退避——pollSkip 纯函数,空闲态每 6 拍执行 1 次(等效 30s),活跃每拍照旧;**交叉验证否决了 v1 的 fingerprint 桶方案**(只门渲染不省 RPC)与 setTimeout 自重排(撞 harness R7「无 setTimeout/setInterval 唯一」锚),最终形态=节拍内跳过 RPC 调用。

## 批次 E · 观察项(不立项,挂账)
- 单写者写队列:BUSY 样本第 2 例(test_008 lane 登记撞锁×2),第 3 例再立项(save 侧按 dbFile 键控 promise 串行链);
- events 裁剪:跨库实测 ≤12 行,无膨胀证据;
- scanStates 免 normalize:A3 落地后如轮询成本仍显著再议。

## 明确不做
FLOWS/GATES 语义、TUI 渲染结构、append 模式——同 r53 口径。

---

# PLAN — r53 优化批次方案(v2,test_007 检查后修订)

> 状态:**已执行完毕**(2026-11-14)——批次 0.5/1/2/3/4 分别落 a004a0b/f9d3c4d/bf82ddc/3cf1b56/c2e6917,每批门禁 EXIT=0(414→417 pass+TUI 189+oxlint 0);批次 0 剩真机探针目检(WF_DEBUG=1,留用户);契约记录见 HOST-CONTRACT M16-r53 条。
> 纪律:改 `server/*` 入口文件禁分步连续 edit;拒绝文案 ❌ 前缀;零回显;rpc-drift 快照同步;每批 `bun run check` EXIT=0 + 中文约定式提交。

## 批次 0 · 数据采集(已回收 2/3,仅剩真机探针)

**已回收(test_007,slug=todolist-app,daily·M·6-lane)**:
- A/B 墙钟:building 17m37s(vs 基线 97.6min,**≈5.5x**);总墙钟 ~36min,瓶颈=波间合并/基建/回执补档(lessons 已契约化于 bc15d05)。
- 硬准入:`deleg:observe` 14/14 unset(100%);样本仅 1 单(立项条件需 ≥3 单)→ **裁决=提示层**(批次 4 采纳)。
- 待办:WF_DEBUG=1 真机探针目检(见下)。

**剩余操作**:
1. 完全重启宿主(`./scripts/tui-restart.sh`),启动环境带 `WF_DEBUG=1`。
2. 打开含产物的任务侧边栏,点击已记账产物名,目检并 grep 日志:
   - `syntax-style-ok`(r48c markdown 着色)vs `syntax-style-import-err`
   - `route-render-md-ok` / `navigate-ok` / `router-probe`(r46 预览路由)
3. 结果回写 HOST-CONTRACT(r46/r48c 条:待验→已验/降级),待验清单归零。

## 批次 0.5 · test_007 实证缺陷三连修(新增,优先于原批次 1)

三个均为数据实证缺陷,改动小、收益直接:

**F1 · done 时 lanes 自动收尾**(实证:任务 done,6 条 lane 全部残留 `status:"active"`,跨库并发护栏会误判活跃)
- 文件:`server/lib.ts`(或 transition 的 done 分支)、tests。
- 语义:`wf:done` acceptance gate 通过时,遍历 `st.lanes` 全部置 `status:"done"`(复用 `wf:lane done` 语义);`wf:reset` 同样清空。存量残留任务无迁移必要(next 指引可覆盖)。
- 测试:done 后 lanes 全 done;lanes 空=幂等;跨库扫描对 done lane 不告警。

**F2 · DISPATCH 回填 worktree 路径**(实证:lane 分支 `wf/todolist-app/lane-*` 真实存在,登记 `worktree:None`,返工路由只能靠命名约定反查)
- 文件:`server/guidance.ts`(DISPATCH_L 模板渲染)、`server/commands.ts`(wf:lane set 可选 `--worktree=<path>` 参数,或由 guard-hook 委派观察回填)。
- 语义:leader 派发 lane 时把 worktree 绝对路径写入 lanes 条目(值内部字段,不触 wfstate-fields 锁);`/wf:status lanes` 行显示路径尾段。
- 测试:set 带 worktree 落账;缺省 None 不报错;rpc 形状零变化(worktree 属 state 非投影新增——若进 RPC state 需同步 stateSchema)。

**F3 · 杂物 wf.db 护栏**(实证:`.workflow/todolist-app/wf.db` 为无表空库,误导 learner 取数)
- 文件:`server/state.ts`(库路径解析单点)、`server/commands.ts`(diagnose)、tests。
- 语义:① 状态库路径解析收窄:仅 `<project>/.workflow/wf.db` 合法,fail-open 记审计;② `wf:diagnose` 增"产物目录内异常 .db 文件"检查项,提示可删。
- 测试:合法路径不受影响;diagnose 对空 db 报告;删文件指导文案 ❌ 前缀不适用( informational)。

**验收**:三修各自独立 commit;`bun run check` 全绿;HOST-CONTRACT 补一条 r53 记录(test_007 实证 + 三修语义)。

## 批次 1 · register 幂等 hash 增强

**文件**:`server/artifact-tool.ts`(守卫点 :112-115)、`server/lib.ts` 纯函数、register 测试。

- bytes 一致 → sha256 复核;hash 同 → no-op 早退;bytes 同 hash 异 → 走既有"修订即清"+告警。
- artifacts 值加 `hash` 字段不触 wfstate-fields 锁;存量无 hash → 首次 register 补算,缺 hash 退回 bytes 比较(向后兼容)。
- hash 记入 audit detail(wf.db 不进模型上下文,无回显风险)。
- **验收**:新用例 ≥3;HOST-CONTRACT r47 "碰撞为文档化局限"改为已消除。

## 批次 2 · gate 拒绝路径自动补注册

**文件**:新平铺文件 `server/gate-reconcile.ts`(register 链路共享 helper,防 import 环;swallow 前缀 `gate-reconcile:*`)、`server/transition.ts`、tests。

- 语义:**拒绝路径补救**——evaluateTransition(:103)返回 gate 失败 → 查 gate 依赖产物 canonical 路径盘上存在且未记账 → register 记账 → 重放评估一次;仍失败原拒绝文案逐字不变。
- 勿在评估前注册:位于 withStateRetry CAS 周期内,前置 save 会引发 rev 冲突与重放重复执行(交叉验证结论)。
- 边界:只补"已落盘未记账";0 字节/缺失不造;重放仅一次。
- **验收**:「原生 edit 后忘 register」端到端演示;+2 用例。

## 批次 3 · guidance 注入预算仪表

**文件**:`server/guidance.ts`(新纯函数)、`server/commands.ts`(pingReport)、tests。

- `wf:ping` 增一行「📐 guidance 注入:planning=X KB / building=Y KB …」;`wf:status` 不动。
- 口径固化:测量=固定形态(该阶段 r=1、无 lanes/selfMod 典型 st)并入测试锚。
- 纯显示不管控;RPC 契约零变化;不触 tui 源码。

## 批次 4 · 裁决=提示层(硬准入不立项)

按批次 0 数据(100% unset,样本 1 单)执行 EVAL §3 中间档:
- DISPATCH_L/DISPATCH_M 委派模板+guidance 文案显式加 `background=true` 要求(roles/leader.md 同步);
- `deleg:observe` 继续采集,再观察 2 单;若 unset 降至 <30% → 永久搁置硬准入;
- 多 lane 写冲突若再现 → 先加 BUSY 重试计数观测,再评估单写者队列化。

## 明确不做

FLOWS/GATES 语义改动、TUI 渲染结构重构、append 模式、r41 存活探针盲区(待提示层数据再议)。

## 门禁与顺序

0 剩余(真机探针,随时可做)→ 0.5(三连修)→ 1 → 2 → 3 串行独立交付;批次 4 提示层可与 0.5 同批或紧随;每批 `bun run check` 五合一;全程不触 `tui/` 源码,无需重打包 dist。
