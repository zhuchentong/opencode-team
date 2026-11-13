// tui/dedup.ts — R3 T3.3/T3.4：TUI 侧去重薄封装（单实现落 shared/report.ts，此处仅默认实例工厂）。
// 三通道（exec/事件/轮询）共用同一实例（index.tsx 装配处创建一次传入）。
export { createDeduper, reportId } from "../shared/report.ts";
