// P0 冒烟：插件模块可加载、导出形状正确（原 m4 空壳替换）
import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../server/index.js";
import * as lib from "../server/lib.ts";

test("插件默认导出形状", () => {
  assert.equal(plugin.id, "wf-workflow");
  assert.equal(typeof plugin.setup, "function");
});

test("lib 导出关键纯逻辑", () => {
  for (const k of ["FLOWS", "GATES", "LIMITS", "KIND_FILES", "evaluateTransition",
    "makeAllowChecker", "shellWriteTargets", "extractPaths", "parseVerdict", "guidance"]) {
    assert.ok(lib[k] !== undefined, `lib 缺少导出 ${k}`);
  }
});
