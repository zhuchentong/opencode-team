// M16-r39 T03（A3）：logToolsOnce 补 PROBE 门——probe:false 且 WF_DEBUG 未设时
// tools.json 不得落盘（旧实现漏门：探针关闭仍写注册证据）。测毕恢复 env。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createObserver } from "../server/observe.ts";
// T04：装配收敛 helpers/host-stub
import { mkHostStub } from "./helpers/host-stub.js";
// T01（arch-r1-host-split）：静默失败可审计化——环形缓冲纯内存记账
import { swallow, listSwallows, clearSwallows, SWALLOW_RING_MAX } from "../server/observe.ts";

const tmpDir = () => fs.mkdtempSync("/tmp/opencode/wf-observe-");
const host = mkHostStub({ sessions: { get: async () => ({ location: { directory: "/nonexistent" } }) } });
const names = Promise.resolve([{ name: "wf_write_artifact" }, { name: "wf_command" }]);

test("T03 PROBE 门：probe:false + WF_DEBUG 未设 → logToolsOnce 不写 tools.json", async () => {
  const prev = process.env.WF_DEBUG;
  delete process.env.WF_DEBUG;
  try {
    const dir = tmpDir();
    const ob = createObserver(host, { debugDir: dir, probe: false });
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
    const ob = createObserver(host, { debugDir: dir, probe: true });
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

// ── T01（arch-r1-host-split）：swallow 环形缓冲（≤200，FIFO，纯内存零 IO）──
test("T01 swallow：环上限 200 超限丢最旧；listSwallows 时序快照拷贝；clearSwallows 清空", () => {
  clearSwallows();
  assert.equal(SWALLOW_RING_MAX, 200);
  for (let i = 1; i <= SWALLOW_RING_MAX + 1; i++) swallow(new Error("e" + i), "t:code-" + i);
  const l = listSwallows();
  assert.equal(l.length, 200, "超限丢最旧");
  assert.equal(l[0].code, "t:code-2", "首条=第 2 条（第 1 条已淘汰）");
  assert.equal(l[199].code, "t:code-201", "末条=最新");
  assert.equal(l[0].msg, "Error: e2", "msg=String(err)");
  assert.match(l[0].at, /^\d{4}-\d{2}-\d{2}T/, "at=ISO 时间");
  // 快照拷贝：改返回数组不影响环
  l.length = 0;
  assert.equal(listSwallows().length, 200);
  clearSwallows();
  assert.deepEqual(listSwallows(), []);
});

test("T01 swallow：任意 err 形状绝不抛（null→String(null)；toString 抛错仍有兜底记录）", () => {
  clearSwallows();
  assert.doesNotThrow(() => swallow(null, "t:null"));
  assert.equal(listSwallows()[0].msg, "null", "null err → msg=String(null)");
  assert.doesNotThrow(() => swallow(undefined, "t:undef"));
  assert.equal(listSwallows()[1].msg, "undefined");
  assert.doesNotThrow(() => swallow("纯文本", "t:str"));
  assert.doesNotThrow(() => swallow({ toString() { throw new Error("bomb"); } }, "t:throwable"));
  assert.equal(listSwallows().length, 4, "异常形状仍记账（msg 兜底非空）");
  assert.ok(String(listSwallows()[3].msg).length > 0);
  clearSwallows();
});