读取 plan.md，从**五维**独立审查：可行性、完整性、正确性、风险、与代码库现状交叉核对（结论多角度独立推导，关键论断与代码交叉验证）。
用 wf_write_artifact(kind=plan-review) **自行**产出 <project>/.workflow/<slug>/plan-review-r<N>.md（勿回传全文由 leader 代写；回执只带摘要+路径+结论）。
**首行必须 `**结论**: PASS|FAIL`**（日常模式 M/L 的 wf:build 关卡据此放行；FAIL=须修订后再验）。正文：按严重度分级的问题与具体修订建议。
**瘦身预算：≤8KB（M 级；S 级 ≤3KB，以委派 prompt 携带的预算为准，字节计）**——findings 用表格（编号/严重度/位置/问题/修订建议），只留要点，禁冗长散文（过长拖慢生成与 planner 修订阅读）。
复审轮次（r≥2）修订报告用 patch 模式只输出变更段（先 read 原文、old 逐字摘录），勿全量重写。
只读审查，不改业务代码。完整模式含可测性评审（与 tester feasibility 并行）；日常模式聚焦方案五维验证。