---
name: Env Contract Probe
description: >
  规划 M/L 级任务时必须使用。触发场景：写 plan 的「环境契约探针」节前；涉及
  env 透传/构建缓存/工具链盲区（.vue、external 包）/e2e 断言 URL 的方案；
  plan 中任何"已实证"表述需取证命令时。借鉴 systematic-debugging Phase1
  组件边界逐层取证。仅 wf 工作流任务会话内适用；非 wf 任务/普通项目开发不适用。
---

## 铁律

**未实跑探针的结论只能写「假设」**：plan 里每条环境契约论断 = 命令|退出码|结论 三列实证，
或显式「假设：…；首跑前验证：<命令>」。

## 四探针（各一行命令 + 判定标准）

1. **env 透传**：`WF_PROBE_MARKER=1 <runner> <已有任务>`，任务内 `echo $WF_PROBE_MARKER`
   ——空 = 被净化，VITE_/process.env 假设即失效。
2. **缓存稳定**：两次异 env 启动，比对 configHash/optimizeDeps 行为——触发重优化+子应用
   reload = 缓存键含 env，禁 `cache:false` 全关（改白名单）。
3. **工具链盲区**：(a) .vue SFC 注入已知不存在的导出 import 跑 typecheck；(b) external
   共享包 import 不存在 named export 跑 build——任一静默 = 该缺陷不受波次闸保护。
4. **断言路径**：核对 e2e 断言点 URL 不被应用路由/replaceState 重写。

## 产出格式（直接粘进 plan）

| 命令 | 退出码 | 结论 |
|---|---|---|

## 借口表

| 借口 | 处置 |
|---|---|
| "VITE_ 前缀够用" | 探针 1 实测透传再下结论 |
| "loadEnv 会透传 process.env" | 那是 .env 文件语义，非 runner 语义——探针 1 |
