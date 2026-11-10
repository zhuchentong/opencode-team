// P0-b：路径提取 / slug / prompt 形态测试
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPaths, slugify, promptText } from "../server/lib.js";

test("edit/write/patch 工具的 path/filePath/file 三键", () => {
  assert.deepEqual(extractPaths("edit", { path: "/a/b.js" }), ["/a/b.js"]);
  assert.deepEqual(extractPaths("write", { filePath: "/a/b.ts" }), ["/a/b.ts"]);
  assert.deepEqual(extractPaths("write", { file: "/a/b.md" }), ["/a/b.md"]);
});

test("无路径参数返回空数组", () => {
  assert.deepEqual(extractPaths("edit", {}), []);
  assert.deepEqual(extractPaths("edit", { path: "" }), []);
  assert.deepEqual(extractPaths("edit", { path: 123 }), []);
  assert.deepEqual(extractPaths("edit", null), []);
  assert.deepEqual(extractPaths("edit", undefined), []);
});

test("patch 工具从 patchText 解析多文件", () => {
  const txt = [
    "*** Begin Patch",
    "*** Update File: src/a.js",
    "@@ -1,2 +1,2 @@",
    "*** Add File: lib/new.ts",
    "+export const x = 1;",
    "*** Delete File: old.md",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(extractPaths("patch", { patchText: txt }), ["src/a.js", "lib/new.ts", "old.md"]);
});

test("patch 空/无目标文本返回空数组", () => {
  assert.deepEqual(extractPaths("patch", { patchText: "" }), []);
  assert.deepEqual(extractPaths("patch", { patchText: "*** Begin Patch\n*** End Patch" }), []);
  assert.deepEqual(extractPaths("patch", null), []);
});

test("非 patch 工具不读 patchText（path 优先）", () => {
  assert.deepEqual(extractPaths("edit", { patchText: "*** Update File: x", path: "real.js" }), ["real.js"]);
});

test("slugify：小写、非法字符转连字符、首尾去连字符、截断 40", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("My Cool Feature!"), "my-cool-feature");
  assert.equal(slugify("--a--b--"), "a-b");
  assert.equal(slugify("对象形态 slug"), "slug", "中文段折叠为连字符，字母段保留");
  assert.equal(slugify("任务a 测试b"), "a-b", "中英混排：字母保留、中文折叠");
  assert.equal(slugify("纯中文"), "", "无 a-z0-9 内容→空串");
  assert.equal(slugify(null), "");
  const long = slugify("x".repeat(100) + "-tail");
  assert.ok(long.length <= 40, `长度 ${long.length}`);
  assert.equal(long, "x".repeat(40));
});

test("promptText：字符串 / {text} / {content} / 其它", () => {
  assert.equal(promptText("raw"), "raw");
  assert.equal(promptText({ text: "t" }), "t");
  assert.equal(promptText({ content: "c" }), "c");
  assert.equal(promptText({ text: "t", content: "c" }), "t", "text 优先");
  assert.equal(promptText({}), "");
  assert.equal(promptText(null), "");
  assert.equal(promptText(42), "");
});
