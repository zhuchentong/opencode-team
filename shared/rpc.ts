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
    // M16-r35：侧边栏模式感知（nullable——存量任务无 mode 字段，TUI 按 full 旧视图渲染）
    mode: { type: ["string", "null"] },
    size: { type: ["string", "null"] },
    planReviewVerdict: { type: ["string", "null"] },
    // M16-r44：方案确认记账（ISO 时间戳，null=未经 question 确认）
    planConfirmedAt: { type: ["string", "null"] },
    artifacts: { type: "object", additionalProperties: true },
    // 档位跟随视图（M16-r49）：role→variant 映射（server 读项目级派生文件实况）；
    // 未派生/读失败=null → TUI 静默不显示（nullable，存量/旧 server 行不炸）
    tiers: { type: ["object", "null"], additionalProperties: true },
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
    // M16-r46 批1：产物预览数据通道——TUI 点击产物行/执行 /wf:open 时读产物内容。
    // 错误不抛错（quota 教训：抛错 client 只见 rpc.internal 原因被吞），走 output.error 字段。
    // 白名单 = state.artifacts 记账 key（防路径穿越）；超 64KB 截断置 truncated。
    read: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, file: { type: "string" } },
        required: ["sessionID", "file"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
          bytes: { type: "integer" },
          path: { type: "string" },
          truncated: { type: "boolean" },
          error: { type: "string" },
        },
        required: ["text", "path"],
        additionalProperties: true,
      },
    },
    // P2 主轨通道：TUI 本地命令经此执行任意 /wf:*（返回值不丢——methods 通道契约可用）。
    // 服务端跑与 command execute 相同的编排（状态推进 + guidance + reports 发布），仅不注入聊天。
    // at 与 reports 行/事件同一时间戳：TUI 本地渲染据此登记去重键，防事件/轮询通道二次弹 toast。
    exec: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, name: { type: "string" }, prompt: { type: "string" } },
        required: ["sessionID", "name"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          text: { type: "string" },
          at: { type: "string" },
          // notification-brief-display T01：brief/level 随 exec 通道透传（runner 结果）；
          // nullable 且不动 required——旧 TUI 不受影响（plan §3.4）
          brief: { type: ["string", "null"] },
          level: { type: ["string", "null"] },
        },
        required: ["text"],
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
    // 命令输出广播（2.2.6 宿主 execute 契约 Promise<void>，返回值不显示给用户）。
    // r29e：真机实证事件投递不通（server emit 成功但 TUI 双通道零接收）——事件降为机会性
    // 补充通道；主通道 = storage 槽 + TUI 轮询 state.lastReport（methods 通道实证可用）。
    // at 与存储槽同一时间戳，TUI 用 sessionID|at 统一去重。
    report: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          text: { type: "string" },
          at: { type: "string" },
          // notification-brief-display T01：结构化摘要/级别（三通道传播之一）；
          // 只扩 properties——required 保持三字段，旧事件载荷不炸
          brief: { type: ["string", "null"] },
          level: { type: ["string", "null"] },
        },
        required: ["sessionID", "text", "at"],
        additionalProperties: true,
      },
    },
  },
});
