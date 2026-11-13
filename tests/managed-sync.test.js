// T05（arch-r1-host-split）：managed-sync.ts 通用层直测——决策纯函数 5 分支 × head/tail 双位置对偶语义、
// syncAll IO（create 拼 fm 惰性读快照/write 保 fm+备份/hash 基数=去标记行）、statusAll、contentHash12。
// 决策表与旧 roles.ts syncDecision / skills.ts skillSyncDecision 逐一对齐（含陈旧标记+内容漂移反例）。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { contentHash12, decideSync, syncAll, statusAll } from "../server/managed-sync.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wf-msync-"));

// head 形标记（roles 对偶）：body 首行 `<!-- mk version=V hash=H -->`
const parseHead = (line) => {
  const m = /^<!-- mk version=(\S+) hash=([0-9a-f]{12}) -->$/.exec(String(line).trim());
  return m ? { version: m[1], hash: m[2] } : null;
};
const HEAD = { markerPosition: "head", parseHashMarker: parseHead };
const bodyH = "角色 body 内容\n第二行\n";
const renderedH = `<!-- mk version=T hash=${contentHash12(bodyH)} -->\n${bodyH}`;

// tail 形标记（skills 对偶）：文件末行，hash 基数=去末行内容
const parseTail = (line) => {
  const m = /^<!-- mk id=(\S+) version=(\S+) hash=([0-9a-f]{12}) -->$/.exec(String(line).trim());
  return m ? { version: m[2], hash: m[3] } : null;
};
const TAIL = { markerPosition: "tail", parseHashMarker: parseTail };
const srcS = "skill 正文\n";
const renderedS = `${srcS}<!-- mk id=x version=T hash=${contentHash12(srcS.trimEnd())} -->\n`;

test("contentHash12：sha256 前 12 位（两域同源替换各自实现）", () => {
  assert.equal(contentHash12("abc"), createHash("sha256").update("abc").digest("hex").slice(0, 12));
  assert.equal(contentHash12(""), createHash("sha256").update("").digest("hex").slice(0, 12));
  assert.notEqual(contentHash12("a"), contentHash12("b"));
});

test("decideSync head：null→create；无标记→unmanaged；hash 同→skip；内容异→write；陈旧标记+内容漂移→write", () => {
  assert.equal(decideSync(null, renderedH, HEAD), "create");
  assert.equal(decideSync("用户自有内容", renderedH, HEAD), "unmanaged");
  assert.equal(decideSync("", renderedH, HEAD), "unmanaged", "空文件→unmanaged（旧表驱动对齐）");
  assert.equal(decideSync(renderedH, renderedH, HEAD), "skip");
  assert.equal(decideSync(renderedH.replace("角色 body", "旧版 body"), renderedH, HEAD), "write");
  // 关键反例：标记行 hash 是陈旧值但去标记内容一致→skip 须基于内容重算而非读标记字段
  assert.equal(decideSync(`<!-- mk version=OLD hash=deadbeefdead -->\n${bodyH}`, renderedH, HEAD), "skip");
  // 陈旧标记+内容漂移→write
  assert.equal(decideSync(`<!-- mk version=OLD hash=deadbeefdead -->\n旧内容`, renderedH, HEAD), "write");
});

test("decideSync tail：五分支同样成立（hash 基数=去末行内容，trimEnd 语义对偶）", () => {
  assert.equal(decideSync(null, renderedS, TAIL), "create");
  assert.equal(decideSync("用户自有 skill", renderedS, TAIL), "unmanaged");
  assert.equal(decideSync(renderedS, renderedS, TAIL), "skip");
  assert.equal(decideSync(renderedS.replace("skill 正文", "旧正文"), renderedS, TAIL), "write");
  // 尾部多余空行差异（trimEnd 归一）→ 仍 skip
  assert.equal(decideSync(renderedS.trimEnd() + "\n\n\n", renderedS, TAIL), "skip");
});

test("syncAll：create 拼 frontmatter（惰性 getter）；二次全 skip 无新 .bak；write 保 fm+备份", () => {
  const dir = tmp();
  let fmReads = 0;
  const mkTarget = (fm) => {
    const item = { name: "a", file: `${dir}/a.md`, rendered: renderedH };
    // 注意：不能用 {...{get x(){}}} 展开——spread 即时求值 getter；defineProperty 才是真惰性
    if (fm) Object.defineProperty(item, "frontmatter", { get() { fmReads++; return fm; } });
    return { markerPrefix: "mk", markerPosition: "head", parseHashMarker: parseHead, backup: true, items: [item] };
  };
  const fmSnap = "---\ndescription: 快照\n---\n";
  const r1 = syncAll([mkTarget(fmSnap)]);
  assert.deepEqual(r1, [{ name: "a", action: "create" }]);
  assert.equal(fs.readFileSync(`${dir}/a.md`, "utf8"), fmSnap + renderedH, "create=fm+rendered");
  assert.equal(fmReads, 1, "fm 仅 create 分支读一次");
  const r2 = syncAll([mkTarget(fmSnap)]);
  assert.deepEqual(r2.map((x) => x.action), ["skip"]);
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes(".bak")).length, 0, "二次 skip 无新 .bak");
  assert.equal(fmReads, 1, "skip 不读 fm 快照");
  // 陈旧托管（自定义 fm 保留）→ write：fm 原样 + 备份旧内容
  const stale = "---\ncustom: 用户 fm\n---\n" + renderedH.replace("角色 body", "旧版 body");
  fs.writeFileSync(`${dir}/a.md`, stale);
  const r3 = syncAll([mkTarget(fmSnap)]);
  assert.deepEqual(r3.map((x) => x.action), ["write"]);
  assert.equal(fs.readFileSync(`${dir}/a.md`, "utf8"), "---\ncustom: 用户 fm\n---\n" + renderedH, "write 保既有 fm 不用快照");
  const baks = fs.readdirSync(dir).filter((f) => f.startsWith("a.md.bak"));
  assert.equal(baks.length, 1, "写前备份一次");
  assert.equal(fs.readFileSync(`${dir}/${baks[0]}`, "utf8"), stale, "备份=旧全文");
  assert.equal(fmReads, 1, "write 也不读快照");
  // 幂等
  assert.deepEqual(syncAll([mkTarget(fmSnap)]).map((x) => x.action), ["skip"]);
  // unmanaged 不覆盖
  fs.writeFileSync(`${dir}/a.md`, "用户自有内容");
  const r5 = syncAll([mkTarget(fmSnap)]);
  assert.deepEqual(r5.map((x) => x.action), ["unmanaged"]);
  assert.equal(fs.readFileSync(`${dir}/a.md`, "utf8"), "用户自有内容");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("syncAll：backup:false 不产 .bak；tail 域 write 全文覆盖（无 fm 保留）", () => {
  const dir = tmp();
  const target = (backup) => ({
    markerPrefix: "mk", markerPosition: "tail", parseHashMarker: parseTail, backup,
    items: [{ name: "s", file: `${dir}/s.md`, rendered: renderedS }],
  });
  assert.deepEqual(syncAll([target(false)]).map((x) => x.action), ["create"]);
  fs.writeFileSync(`${dir}/s.md`, renderedS.replace("skill 正文", "旧正文"));
  assert.deepEqual(syncAll([target(false)]).map((x) => x.action), ["write"]);
  assert.equal(fs.readFileSync(`${dir}/s.md`, "utf8"), renderedS, "tail 域全文=rendered");
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes(".bak")).length, 0, "backup:false 无 .bak");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("statusAll：missing/managed(stale→write 判)/unmanaged 映射", () => {
  const dir = tmp();
  const target = {
    markerPrefix: "mk", markerPosition: "head", parseHashMarker: parseHead, backup: false,
    items: [
      { name: "miss", file: `${dir}/miss.md`, rendered: renderedH },
      { name: "ok", file: `${dir}/ok.md`, rendered: renderedH },
      { name: "old", file: `${dir}/old.md`, rendered: renderedH },
      { name: "user", file: `${dir}/user.md`, rendered: renderedH },
    ],
  };
  fs.writeFileSync(`${dir}/ok.md`, renderedH);
  fs.writeFileSync(`${dir}/old.md`, renderedH.replace("角色 body", "旧版 body"));
  fs.writeFileSync(`${dir}/user.md`, "自有");
  assert.deepEqual(statusAll([target]), [
    { name: "miss", status: "missing" },
    { name: "ok", status: "managed" },
    { name: "old", status: "stale" },
    { name: "user", status: "unmanaged" },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});
