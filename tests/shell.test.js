// P0-b：shell 写目标解析测试（重定向 + 写/删类命令尾参）
// M16-r28 B1-1 翻案：`=>` 箭头/比较不再误判为重定向（真机实证 node -e 代码被误拦）；
//   目标含 $/反引号/纯数字跳过；`tee out.txt < input` 不再把 input 当目标（尾参过滤 <>&| 起始）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { shellWriteTargets } from "../server/lib.ts";

test("重定向 > 与 >> 与 2>", () => {
  assert.deepEqual(shellWriteTargets("echo x > out.txt"), ["out.txt"]);
  assert.deepEqual(shellWriteTargets("echo x >> log.txt"), ["log.txt"]);
  assert.deepEqual(shellWriteTargets("make 2> err.txt"), ["err.txt"]);
  assert.deepEqual(shellWriteTargets("cmd 2>> err.log"), ["err.log"]);
});

test("引号目标（含空格）", () => {
  assert.deepEqual(shellWriteTargets(`echo "a b" > "my file.txt"`), ["my file.txt"]);
  assert.deepEqual(shellWriteTargets(`echo x > '单字 名.txt'`), ["单字 名.txt"]);
});

test("通配符目标跳过（无法判定具体文件）", () => {
  assert.deepEqual(shellWriteTargets("cmd > a*.txt"), []);
  assert.deepEqual(shellWriteTargets("cp src/*.js dst/"), ["dst/"]);
});

test("写/删类命令尾参（rm/mv/cp/touch/mkdir/tee/ln/install/rsync）", () => {
  assert.deepEqual(shellWriteTargets("rm -rf build/"), ["build/"]);
  assert.deepEqual(shellWriteTargets("cp a.txt b.txt"), ["b.txt"]);
  assert.deepEqual(shellWriteTargets("mv old.txt new.txt"), ["new.txt"]);
  assert.deepEqual(shellWriteTargets("touch /tmp/marker"), ["/tmp/marker"]);
  assert.deepEqual(shellWriteTargets("mkdir -p src/gen"), ["src/gen"]);
  assert.deepEqual(shellWriteTargets("tee out.txt"), ["out.txt"]);
  assert.deepEqual(shellWriteTargets("ln -s target link-name"), ["link-name"]);
  assert.deepEqual(shellWriteTargets("rsync -a src/ dst/"), ["dst/"]);
  assert.deepEqual(shellWriteTargets("install -m 644 a b"), ["b"]);
});

test("多段命令（; && || 管道）各段目标合并", () => {
  const t = shellWriteTargets("rm old.txt; touch new.txt");
  assert.ok(t.includes("old.txt") && t.includes("new.txt"), `实际：${t}`);
  const t2 = shellWriteTargets("make && cp x y");
  assert.ok(t2.includes("y"), `实际：${t2}`);
});

test("非写类命令无目标", () => {
  assert.deepEqual(shellWriteTargets("grep -r foo src/"), []);
  assert.deepEqual(shellWriteTargets("cat /etc/hostname"), []);
  assert.deepEqual(shellWriteTargets(""), []);
  assert.deepEqual(shellWriteTargets(null), []);
});

test("旗标与纯数字参数不算目标（如 chmod 644 f）", () => {
  // chmod 不在 SHELL_DEST_CMDS → 无目标；install 分支里 -m 644 被过滤
  assert.deepEqual(shellWriteTargets("install -m 644 src dst"), ["dst"]);
});

test("家目录目标（~）保留原始形态由调用方过滤", () => {
  // lib 层不过滤 ~（hook 里 continue），此处锁定解析行为
  assert.deepEqual(shellWriteTargets("echo x > ~/.zshrc"), ["~/.zshrc"]);
});

// ── M16-r28 B1-1 翻案锁定（真机误伤形态）────────────────────────────
test("箭头函数与比较符不再误判为重定向（真机 run-2 实证形态）", () => {
  assert.deepEqual(shellWriteTargets(`node -e "const f=x=>x+1; console.log(f(2))"`), []);
  assert.deepEqual(shellWriteTargets("node -e 'console.log(a > b ? `x` : {y:1})'"), []);
  assert.deepEqual(shellWriteTargets("sed -i 's/a->b/c/' f.ts"), []);
});

test("目标含 $/反引号/纯数字跳过（无法判定具体文件）", () => {
  assert.deepEqual(shellWriteTargets("echo x > \"$OUT/f.txt\""), []);
  assert.deepEqual(shellWriteTargets("echo x > ${h}h"), []);
  assert.deepEqual(shellWriteTargets("node -e 'if (n > 2) go()'"), []);
});

test("tee out.txt < input 不再把 input 当目标（原已知边界翻案）", () => {
  assert.deepEqual(shellWriteTargets("cat data | tee out.txt < input"), ["out.txt"]);
});

test("真实重定向不受翻案影响仍解析", () => {
  assert.deepEqual(shellWriteTargets("make > build.log 2> errors.log"), ["build.log", "errors.log"]);
  assert.deepEqual(shellWriteTargets("git checkout -- . && echo done > status.txt"), ["status.txt"]);
});
