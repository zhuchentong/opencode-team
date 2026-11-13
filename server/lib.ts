// wf-workflow — 兼容 barrel：T02（arch-r1-host-split）把 842 行纯逻辑单体重写为按域转发。
// 符号单一来源已迁至 server/domain/*（types/flow/guard/artifact/session/report/policy/diagnose）；
// 本文件只做 re-export（含 VERSION 转发），35 个 import 方（server12+tests23）零改动。
// 不转发 guidance（防环，M16-r39 T08 语义保留）。原则不变：只放无 ctx/storage 依赖的纯逻辑供 bun test 直测。
// 守卫：tests/domain-acyclic.test.js（内部边白名单/零依赖叶/无编排层依赖/无环）+
// tests/lib-exports.test.js（Object.keys(lib) 62 名全集锁 + 本文件 ≤60 行）。
export * from "./domain/types.ts";
export * from "./domain/flow.ts";
export * from "./domain/guard.ts";
export * from "./domain/artifact.ts";
export * from "./domain/session.ts";
export * from "./domain/report.ts";
export * from "./domain/policy.ts";
export * from "./domain/diagnose.ts";
export { VERSION } from "../shared/version.ts"; // M16-r39 T08：版本单一来源（T13 升 r39）
