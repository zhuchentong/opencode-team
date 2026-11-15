// tui/dedup.ts — R3 T3.3/T3.4：TUI 侧去重薄封装（单实现落 shared/report.ts，此处仅默认实例工厂）。
// 三通道（exec/事件/轮询）共用同一实例（index.tsx 装配处创建一次传入）。
/**
 * 转发 shared/report.ts 的去重单实现（createDeduper=实例工厂、reportId=幂等键构造），
 * TUI 侧仅提供默认实例薄封装；三通道（exec/事件/轮询）共用同一实例。
 */
export { createDeduper, reportId } from "../shared/report.ts";
