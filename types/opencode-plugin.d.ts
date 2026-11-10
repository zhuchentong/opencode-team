// OpenCode 宿主虚拟模块声明（onResolve alias 注入，运行时由宿主提供）。
// 形状按本项目已实测 API（实测 2026-11-09/10）最小化声明；未验证字段保持 any。

declare module "@opencode/plugin/rpc" {
  // Rpc.define 契约工厂：返回注册/调用所需的定义对象（实际形状由宿主提供）
  export const Rpc: { define: (def: { id: string; methods?: any; events?: any }) => any };
  export const Wf: any;
}

declare module "@opencode/plugin/tui" {
  export const Plugin: {
    define: (config: any) => any;
  };
}
