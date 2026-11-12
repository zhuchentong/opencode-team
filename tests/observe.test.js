// M16-r39 T03（A3）：logToolsOnce 补 PROBE 门——probe:false 且 WF_DEBUG 未设时
// tools.json 不得落盘（旧实现漏门：探针关闭仍写注册证据）。测毕恢复 env。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createObserver } from "../server/observe.ts";

const tmpDir = () => fs.mkdtempSync("/tmp/opencode/wf-observe-");
const ctx = { session: { get: async () => ({ location: { directory: "/nonexistent" } }) } };
const names = Promise.resolve([{ name: "wf_write_artifact" }, { name: "wf_command" }]);

test("T03 PROBE 门：probe:false + WF_DEBUG 未设 → logToolsOnce 不写 tools.json", async () => {
  const prev = process.env.WF_DEBUG;
  delete process.env.WF_DEBUG;
  try {
    const dir = tmpDir();
    const ob = createObserver(ctx, { debugDir: dir, probe: false });
    await ob.logToolsOnce(names, "ses_ob1");
    assert.equal(fs.existsSync(`${dir}/.workflow/_debug/tools.json`), false, "探针关闭不得写 tools.json");
    // probeOnce 本就带门（对照锚）
    await ob.probeOnce("ses_ob1", "tool-probe", { x: 1 });
    assert.equal(fs.existsSync(`${dir}/.workflow/_debug/tool-probe.json`), false);
  } finally {
    if (prev !== undefined) process.env.WF_DEBUG = prev;
  }
});

test("T03 probe:true → tools.json 落盘且含 version/tools", async () => {
  const prev = process.env.WF_DEBUG;
  delete process.env.WF_DEBUG;
  try {
    const dir = tmpDir();
    const ob = createObserver(ctx, { debugDir: dir, probe: true });
    await ob.logToolsOnce(names, "ses_ob2");
    const p = `${dir}/.workflow/_debug/tools.json`;
    assert.equal(fs.existsSync(p), true, "probe:true 应写 tools.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.ok(typeof j.version === "string" && j.version.length > 0, "含 version");
    assert.deepEqual(j.tools, ["wf_write_artifact", "wf_command"], "含工具名列表");
    // 幂等：二次调用不重写（at 不变）
    const at1 = j.at;
    await ob.logToolsOnce(names, "ses_ob2");
    assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).at, at1, "只写一次");
  } finally {
    if (prev !== undefined) process.env.WF_DEBUG = prev;
  }
});