// 测试隔离预载（bunfig.toml [test].preload）：把持久项目清单钉到临时路径，
// 防测试进程的 createStore→registerProject 污染真实 ~/.local/share/opencode/wf-projects.jsonl。
// ??= 仅在未显式设置时生效；selfmod-guard.test.js 模块级覆写自己的文件（preload 先于测试文件执行）。
process.env.WF_PROJECTS_FILE ??= "/tmp/opencode/wf-test-projects.jsonl";
