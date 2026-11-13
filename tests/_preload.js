// 测试隔离预载（bunfig.toml [test].preload）：把持久项目清单钉到临时路径，
// 防测试进程的 createStore→registerProject 污染真实 ~/.local/share/opencode/wf-projects.jsonl。
// ??= 仅在未显式设置时生效；selfmod-guard.test.js 模块级覆写自己的文件（preload 先于测试文件执行）。
process.env.WF_PROJECTS_FILE ??= "/tmp/opencode/wf-test-projects.jsonl";

// ── P0-A mock bootstrap 单点化（agent-phase-latency-optimization-v3.1）────────
// 病灶：13 个测试文件经 server/index.ts→rpc-bridge→shared/rpc.ts 解析 @opencode/plugin/rpc；
// mock 包原由 4 个测试文件运行期自举写入，而模块解析发生在加载期——干净 node_modules 首跑
// 解析先于写入必红（R3 worktree + v3.1 V1 双实证：8 fail + unhandled error）。
// preload（bunfig [test].preload）先于全部测试文件执行 = 时序根修。幂等：目录已存在即跳过。
// harness（bun tui-tests/...）非 bun test 文件不经 preload，自带同款自举（保留不动）。
import fs from "node:fs";
const mockDir = new URL("../node_modules/@opencode/plugin/", import.meta.url).pathname;
if (!fs.existsSync(`${mockDir}package.json`)) {
  fs.mkdirSync(mockDir, { recursive: true });
  fs.writeFileSync(`${mockDir}package.json`, JSON.stringify({
    name: "@opencode/plugin", version: "0.0.0-local-mock", private: true, type: "module",
    exports: { "./tui": "./mock-tui.js", "./rpc": "./mock-rpc.js" },
  }));
  fs.writeFileSync(`${mockDir}mock-tui.js`, "export const Plugin = { define: (def) => def };\n");
  fs.writeFileSync(`${mockDir}mock-rpc.js`, "export const Rpc = { define: (def) => def };\n");
}
