// wf-workflow RPC 契约（M8-a）
// server 侧 ctx.rpc.register(Wf, impl) 注册；TUI 侧 context.client.rpc(Wf) 调用、
// rpc.events.on("updated") 订阅。放在 shared/ 而非 rpc/，避免被当作插件 rpc part 入口加载。
import { Rpc } from "@opencode/plugin/rpc";

// 状态输出（TUI 侧边栏所需最小集）
const stateSchema = {
  type: "object",
  properties: {
    sessionID: { type: ["string", "null"] },
    active: { type: "boolean" },
    slug: { type: "string" },
    phase: { type: ["string", "null"] },
    rounds: { type: "object", additionalProperties: true },
    testPlanWritten: { type: "boolean" },
    testReportVerdict: { type: ["string", "null"] },
    artifacts: { type: "object", additionalProperties: true },
    updatedAt: { type: ["string", "null"] },
  },
  required: ["active"],
  additionalProperties: true,
};

// 列表项（M8-b 面板看板）
const listItemSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    slug: { type: "string" },
    phase: { type: ["string", "null"] },
    rounds: { type: "object", additionalProperties: true },
    testPlanWritten: { type: "boolean" },
    testReportVerdict: { type: ["string", "null"] },
    updatedAt: { type: ["string", "null"] },
  },
  required: ["sessionID"],
  additionalProperties: true,
};

export const Wf = Rpc.define({
  id: "wf",
  methods: {
    // 读取某会话的工作流状态；无活动任务时 active=false
    state: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: stateSchema,
    },
    // 枚举所有工作流任务（M8-b 面板看板用）
    list: {
      input: { type: "object", properties: { projectID: { type: "string" }, directory: { type: "string" } }, additionalProperties: false },
      output: {
        type: "object",
        properties: { sessions: { type: "array", items: listItemSchema } },
        required: ["sessions"],
        additionalProperties: true,
      },
    },
  },
  events: {
    // 流转成功 / 产物落盘时广播（事件数据必须是对象）
    updated: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          slug: { type: "string" },
          phase: { type: ["string", "null"] },
          rounds: { type: "object", additionalProperties: true },
        },
        required: ["sessionID"],
        additionalProperties: true,
      },
    },
  },
});
