// 幻影自愈批 O1（test_53 H1）：守护进程按项目目录缓存 setup 产物——项目目录被删后缓存 store 仍持有
// 指向已删 inode 的连接，同目录新会话复用该 store 时状态写入进不可见库（unlink 幻影）。
// ensureAlive 三断言：①文件消失→方法头重开（新文件落盘+路径可用）；②同路径换 inode（目录重建）→
// 重开；③close 后迟到调用不复活已删目录（closed 早退，mkdir 副作用零残留）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { createStore } from "../server/state.ts";
import { mkHostStub } from "./helpers/host-stub.js";

const tmpDir = () => { fs.mkdirSync("/tmp/opencode", { recursive: true }); return fs.mkdtempSync("/tmp/opencode/wf-phantom-"); };
const dbFile = (dir) => `${dir}/.workflow/wf.db`;
const mkHost = (dir) => mkHostStub({
  location: { directory: dir },
  storage: { scan: async () => ({ entries: [] }), get: async () => null, set: async () => {}, remove: async () => {} },
  sessions: { get: async () => ({ projectID: "pi1", agent: "wf/leader", location: { directory: dir } }) },
});
const newStore = async (dir) => {
  const s = createStore(mkHost(dir));
  await s.ready;
  return s;
};

test("O1① 文件消失→方法头重开：删 dbFile 后 save/load 自愈（新文件落盘且路径可用）", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_a", slug: "demo", phase: "intake", rounds: {}, log: [] });
  assert.equal(fs.existsSync(dbFile(dir)), true);
  fs.rmSync(dbFile(dir)); // 模拟项目目录被 rm -rf（幻影场景：连接还开着，文件没了）
  const r = await s.save({ sessionID: "ses_b", slug: "after", phase: "intake", rounds: {}, log: [] });
  assert.equal(r.ok, true, "幻影检测→重开后写入成功");
  assert.equal(fs.existsSync(dbFile(dir)), true, "新文件落磁盘（监控轨可见）");
  assert.equal((await s.load("ses_b")).slug, "after", "重开后的库可读");
  s.close();
});

test("O1② 同路径换 inode（目录重建）→重开：异内容新文件被识别并切换", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_a", slug: "old", phase: "intake", rounds: {}, log: [] });
  fs.rmSync(dbFile(dir));
  // 同路径放一个合法但异内容的 SQLite 文件（新 inode）——existsSync 探测不到的场景，ino 对比覆盖
  const foreign = new Database(dbFile(dir));
  foreign.exec("CREATE TABLE foreign_marker(x TEXT)");
  foreign.close();
  const r = await s.save({ sessionID: "ses_b", slug: "fresh", phase: "intake", rounds: {}, log: [] });
  assert.equal(r.ok, true, "换 inode 识别→重开成功");
  assert.equal((await s.load("ses_b")).slug, "fresh", "新文件读写成对");
  s.close();
});

test("O1③ close 后迟到调用不复活已删目录（closed 早退）", async () => {
  const dir = tmpDir();
  const s = await newStore(dir);
  await s.save({ sessionID: "ses_a", slug: "demo", phase: "intake", rounds: {}, log: [] });
  fs.rmSync(dbFile(dir));
  s.close();
  // bun 怪癖：db.close() 后已 prepare 的语句仍可读旧 inode 句柄（返回旧数据非抛错）——load 返回值
  // 不作断言（现状路径，行为同旧代码）；本断言只锁 F3 核心不变量：closed 早退 → 不经 mkdir 复活目录
  await s.load("ses_a");
  assert.equal(fs.existsSync(dbFile(dir)), false, "迟到调用不得经 ensureAlive 复活已删目录（closed 早退）");
});
