// r54 批次 C：wf-projects.jsonl 去重锚（test_008 实证 98KB/数百重复行——每次 createStore/热载
// 无条件 append）。projectAppendNeeded 同 dir+dbFile 去重 + 惰性基线回读；
// WF_PROJECTS_FILE 钩子语义不变（env 设置=注册完全不落盘——故写入面经判定函数直测，读面走 env 钉临时文件）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { projectAppendNeeded } from "../server/state-scan.ts";

const tmpDir = () => fs.mkdtempSync("/tmp/opencode/wf-projects-");

// 顺序敏感：基线读取是进程级单例（生产语义=每进程一次），本用例须先于其它用例执行
test("C 基线回读：历史文件既有 dir+dbFile 判定 false（热载后模块重初始化场景）", () => {
  const f = `${tmpDir()}/wf-projects.jsonl`;
  fs.writeFileSync(f, JSON.stringify({ dir: "/proj/base", dbFile: "/proj/base/.workflow/wf.db" }) + "\n");
  const prev = process.env.WF_PROJECTS_FILE;
  process.env.WF_PROJECTS_FILE = f; // projectsListFile 派生单点 → 基线读临时文件
  try {
    assert.equal(projectAppendNeeded("/proj/base", "/proj/base/.workflow/wf.db"), false, "基线命中不 append");
    assert.equal(projectAppendNeeded("/proj/other", "/proj/other/.workflow/wf.db"), true, "基线外项目照常放行");
  } finally {
    if (prev === undefined) delete process.env.WF_PROJECTS_FILE; else process.env.WF_PROJECTS_FILE = prev;
  }
});

test("C 追加判定：同 dir+dbFile 首次 true，重复 false；dbFile 变更（搬家）再 true", () => {
  assert.equal(projectAppendNeeded("/proj/a", "/proj/a/.workflow/wf.db"), true);
  assert.equal(projectAppendNeeded("/proj/a", "/proj/a/.workflow/wf.db"), false, "SEEN 命中不重复");
  assert.equal(projectAppendNeeded("/proj/a", "/proj/a/.workflow/wf.db"), false);
  assert.equal(projectAppendNeeded("/proj/a", "/new/home/.workflow/wf.db"), true, "项目搬家 → 允许追加新行（扫描侧 Set 取后者）");
});
