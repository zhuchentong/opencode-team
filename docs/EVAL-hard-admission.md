# 评估 — 波次 3 硬准入（guard-hook 外扩 leader 会话管辖）

> 状态：评估文档，未实施。结论=**暂缓**，触发条件见 §4。v3.1 波次 3 明确将硬准入单列评估，本文件即该评估。

## 1. 硬准入是什么

现状（软准入）：`wf:lane set` 超 LANE_CAP=2 时返回值告警，building guidance 动态尾显示并发数——不拦截。
硬准入：经 `ctx.tool.hook("execute.before")`（guard-hook.ts:40，已观测 subagent 调用）对 leader 发起的
subagent/task 委派做事前拦截：活跃 builder lane ≥cap 且新委派无 lane 登记时，拒绝或强制要求
background=true（不干等）。

## 2. 风险（v3 波次 3 单列评估的原因）

| 风险 | 说明 |
|---|---|
| **管辖面首次外扩** | guard-hook 现管辖 wf/* 子会话与 leader 的 edit/shell/question/subagent 续接；硬准入新增"leader 可以发起几个委派"的裁量剥夺——插件从纪律层升级为配额层，误拦=任务停摆（fail-closed 代价高） |
| **误判源多** | "活跃"口径（status!=done？跨库任务？计算型 subagent 是否算 builder lane？）任一口径错=拦错 |
| **与 confirm 卡授权冲突** | 用户已在 plan:confirm 卡批准并行（卡面展示 lane 数），硬准入再按 cap 拦=二次否定用户决策 |
| **网关多样性** | cap=2 是本机单网关口径；多网关/远端执行场景下 cap 语义失效 |

## 3. 数据先行（P2-G 观察灯已就位，`5fced18` 后任一委派即采集）

硬准入的前提是量化「leader 显式 background 占比」（slim 实测 2:1 foreground habit）。观察灯口径：
`deleg:observe` events → `bg=explicit | explicit-false | unset`，含 lane 键。判定规则：
- **unset 占比 <30%**（leader 已习惯显式 background）→ 硬准入收益低，**永久搁置**，维持软准入+confirm 卡。
- **unset 占比 ≥50% 且单 lane 场景为主** → 先做提示层（DISPATCH 文案+委派模板加 background=true），观察一单后再议拦截。
- **多 lane 并行实际发生（≥2 活跃 lane 频次 ≥3 单）且 unset 高** → 硬准入立项（届时复评 §2 风险表）。

## 4. 结论

1. 立即实施：§3 观察灯已上线（`5fced18` 后自动采集），**零新成本**。
2. 暂缓硬准入：等 ≥2 单含 lane 并行意向的任务数据；触发条件见 §3。
3. 若未来立项：只拦「新增未登记 lane 的第 3+ 个 builder 委派」，不改既有 lane；拦截文案走 ❌ 前缀+指路
   confirm 卡/`wf:lane`（零回显不变量适用）。
