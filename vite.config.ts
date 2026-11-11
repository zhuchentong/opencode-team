// P5：TUI 产物构建（vite lib 模式，ESM 单文件 → dist/tui.js）
// external 纪律（方案 §2.3 跨版本兼容）：@opencode/*、solid-js、@opentui/* 全部 external——
// 运行时由宿主注入同一实例（防双 Solid runtime，usage-monitor/skills-tui 先例）；
// shared/rpc.ts 与 shared/phases.ts 打进产物（结构同一由 tests/rpc-drift.test.js 源码级守卫锁定，
// 两进程本就无法共享对象实例——方案验证报告②结论）。
// 注意：TUI 源码已是低层原语形态（无 JSX，P4 静态守卫锁定 <box/<text 全文件禁），
// esbuild 对 .tsx 仅按 TS 处理，无需 solid babel preset（流派 A 换树走显式 insert()，非编译期转换）。
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "tui/index.tsx",
      formats: ["es"],
      fileName: () => "tui.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    minify: false, // 保留可读性与既有探针语义
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      external: [
        "@opencode/plugin/tui",
        "@opentui/solid",
        "solid-js",
        "node:fs", // 探针写日志用（宿主 bun 运行时原生可用；不标 external 会被 vite 替换成 browser-external shim）
      ],
      output: { inlineDynamicImports: true }, // 单文件产物（dist/tui.js 唯一入口，无 hash chunk）
    },
  },
});
