// W15-b 惰性创建回归锚（评审验收 A1/A4/A5 等价 bun test 形态；真机四步取证另见 HOST-CONTRACT W15-b 节）：
// ①createStore 构造期零磁盘副作用；②读口对未开且无库 → 空态返回且不物化目录（A1 核心）；
// ③写口首达即建（openAll+迁移单飞）；④close 未开态 no-op 且不留 swallow 假故障（A4）；
// ⑤并发写口单槽去重（A5：openAll/迁移恰执行一次，以库文件与数据一致性间接锁定）；
// ⑥ready 契约键语义=显式 open 触发（测试 helper 依赖面）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createStore } from "../server/state.ts";
import { listSwallows, clearSwallows } from "../server/observe.ts";
import { mkHostStub } from "./helpers/host-stub.js";

const tmpDir = () => { fs.mkdirSync("/tmp/opencode", { recursive: true }); return fs.mkdtempSync("/tmp/opencode/wf-lazy-"); };
const wfDir = (dir) => `${dir}/.workflow`;
const mkHost = (dir) => mkHostStub({
  location: { directory: dir },
  storage: { scan: async () => ({ entries: [] }), get: async () => null, set: async () => {}, remove: async () => {} },
  sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: dir } }) },
});

test("W15-b① 构造期零磁盘副作用：createStore 后不 touch 任何方法 → .workflow 不存在", async () => {
  clearSwallows();
  const dir = tmpDir();
  const s = createStore(mkHost(dir));
  assert.equal(fs.existsSync(wfDir(dir)), false, "构造即建=回归红");
  s.close(); // 未开态 close：no-op 且无 swallow 假故障
  assert.equal(fs.existsSync(wfDir(dir)), false, "close 不复活目录");
  assert.equal(listSwallows().filter((e) => String(e?.code ?? "").startsWith("state:")).length, 0, "未开 close 无 swallow 假故障（A4）");
});

test("W15-b② 读口无建：load/scanStates/getReport/dumpStates/countEvents 空态返回且不物化目录", async () => {
  const dir = tmpDir();
  const s = createStore(mkHost(dir));
  assert.equal(await s.load("ses_x"), null);
  assert.deepEqual(await s.scanStates(), []);
  assert.equal(await s.getReport("ses_x"), null);
  assert.deepEqual(await s.dumpStates(), []);
  assert.equal(await s.countEvents?.("wf:intake"), 0);
  assert.equal(fs.existsSync(wfDir(dir)), false, "读口不得建目录（A1 分水岭）");
  s.close();
});

test("W15-b③ 写口首达即建：save 物化目录+库，迁移闩一次收口；后续读口正常", async () => {
  const dir = tmpDir();
  const s = createStore(mkHost(dir));
  const w = await s.save({ sessionID: "ses_a", slug: "demo", phase: "intake", rounds: {}, log: [] });
  assert.equal(w.ok, true);
  assert.equal(fs.existsSync(`${wfDir(dir)}/wf.db`), true, "写口物化");
  assert.equal((await s.load("ses_a"))?.slug, "demo", "写后读回");
  assert.deepEqual(await s.dumpStates().then((r) => r.map((x) => x.value?.slug)), ["demo"]);
  s.close();
});

test("W15-b⑤ 并发写口单槽去重：10 路并发 save 首开恰建库一次、数据一致", async () => {
  const dir = tmpDir();
  const s = createStore(mkHost(dir));
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    s.save({ sessionID: `ses_p${i}`, slug: `t${i}`, phase: "intake", rounds: {}, log: [] })));
  const all = await s.dumpStates();
  assert.equal(all.length, 10, "并发首开不丢写");
  s.close();
});

test("W15-b⑥ ready 契约键=显式 open 触发：await ready 建库（测试 helper 依赖面）", async () => {
  const dir = tmpDir();
  const s = createStore(mkHost(dir));
  assert.equal(fs.existsSync(wfDir(dir)), false);
  await s.ready;
  assert.equal(fs.existsSync(`${wfDir(dir)}/wf.db`), true, "ready 即显式 open");
  s.close();
});
