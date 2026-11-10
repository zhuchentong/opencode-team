// P0 契约探针 — RPC 定义（server/TUI 各自经本文件 import，验证「结构同一」路由）。
// id 无冒号（插件 id 冒号地雷）；wire 事件类型 = rpc.wf.p0.probe.changed。
import { Rpc } from "@opencode/plugin/rpc";

export const Probe = Rpc.define({
  id: "wf.p0.probe",
  methods: {
    // where：回显 server 执行目录 —— 带/不带 location 调用的对照探针（③）
    where: {
      input: { type: "object", properties: { ping: { type: "string" } }, required: ["ping"], additionalProperties: false },
      output: {
        type: "object",
        properties: { directory: { type: "string" }, pid: { type: "number" }, echo: { type: "string" } },
        required: ["directory"],
        additionalProperties: true,
      },
    },
    // dbrows：server 侧读 probe.db（⑥ TUI 直读失败时的对照通道）
    dbrows: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          rows: { type: "array", items: { type: "object", additionalProperties: true } },
          err: { type: ["string", "null"] },
        },
        required: ["rows"],
        additionalProperties: true,
      },
    },
  },
  events: {
    // changed：5 条件事件探针（④）——payload 为 object，emit 侧 await+catch
    changed: {
      schema: {
        type: "object",
        properties: { nonce: { type: "string" }, at: { type: "string" } },
        required: ["nonce"],
        additionalProperties: true,
      },
    },
  },
});
