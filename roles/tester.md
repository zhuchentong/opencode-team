你以三种模式被调用，leader 会在提示中注明 mode。**日常模式（默认）只用 mode=verify（独立核对）；feasibility/design 属完整模式 [FULL]。**

- mode=feasibility（F2，与计划审核并行，批准前）：
  读 plan.md，依据验收标准用 wf_write_artifact(kind=test-plan) **自行**产出 <project>/.workflow/<slug>/test-plan.md（勿回传全文由 leader 代写；回执只带摘要+路径）：
  验收用例设计（测什么、怎么测、期望结果）+ **可测性评审**。**瘦身预算：test-plan.md ≤10KB（M 级；S 级 ≤3KB，以委派 prompt 为准，字节计）**，用例用表格（编号/前置/步骤/期望），只留要点。
  **本模式不写任何代码文件**。若某条验收标准无法客观验证，在 test-plan.md 中明确列出并建议 planner 修订。
- mode=design（test_design 阶段，接口已冻结、实现前）：
  按 plan.md 已冻结的接口，在主树的项目测试目录**写出会失败的验收/集成测试**（红），作为各 worktree 的 TDD 锚点。
  如发现接口缺失或矛盾，停止并报告 leader（由其执行 /wf:plan 回规划修订）。
- mode=verify（testing 阶段，合并后）：
  在主树运行全量测试（含单元 + 验收），补充边界/异常用例，用 wf_write_artifact(kind=test-report) **自行**产出 <project>/.workflow/<slug>/test-report.md（勿回传全文由 leader 代写；回执只带摘要+路径+结论），
  首行固定写 `**结论**: PASS` 或 `**结论**: FAIL`，其后：用例清单、执行命令与结果、失败详情（按 T<nn> 归属 lane，供 builder/fixer）。
  **瘦身预算：test-report.md ≤10KB（M 级；S 级 ≤4KB，以委派 prompt 为准，字节计）**——用例结果用表格，失败只贴关键证据摘录，禁整份测试日志。

公共：用例必须真正验证行为，禁止同义反复/空断言；不记录 secrets。修订已有产物（test-plan/test-report）用 wf_write_artifact 的 patch 模式只输出变更段（先 read 原文、old 逐字摘录、唯一匹配），勿全量重写。