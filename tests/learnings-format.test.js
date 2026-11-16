// learnings-lifecycle P5：知识层格式守卫（纯 JS，禁 TS 语法）。
// 背景：.learnings/ 是唯一无守卫的数据面——曾发生 ERR-20261110-008 一号两条、过期结论保持
// pending/high 权威误导后续任务。本守卫锁四条规则：ID 唯一 / Pattern-Key 唯一 /
// superseded 必填 Superseded-By 且目标 key 存在 / corrected 必有 Correction 注记。
// 主测 synthetic fixture（不依赖真实语料）；真实 .learnings/ 存在时机会性扫描，缺失 skip
// （该目录默认 gitignore——fresh clone/CI 无此目录，硬依赖即红）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** 解析条目块：按 ## 标题切分；字段容忍粗体/非粗体两种形态；标题允许改名后缀。 */
function parseEntries(text) {
  const entries = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const nl = block.indexOf("\n");
    const head = nl === -1 ? block : block.slice(0, nl);
    const body = nl === -1 ? "" : block.slice(nl + 1);
    const id = (head.match(/(?:LRN|ERR|FEAT)-\d{8}-\d{3}/) || [])[0] || head.trim();
    const field = (name) => {
      const m = body.match(new RegExp(`^-\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*[:：]\\s*(.+)$`, "m"));
      return m ? m[1].trim() : null;
    };
    entries.push({
      id,
      key: field("Pattern-Key"),
      status: (field("Status") || "").toLowerCase(),
      supersededBy: field("Superseded-By"),
      hasCorrection: /^-\s*(?:\*\*)?Correction/m.test(body),
    });
  }
  return entries;
}

/** 校验规则集：返回问题清单（空=合规）。 */
function validate(entries) {
  const problems = [];
  const ids = new Set();
  const keys = new Set();
  for (const e of entries) {
    if (ids.has(e.id)) problems.push(`ID 重复: ${e.id}`);
    ids.add(e.id);
    if (e.key) {
      if (keys.has(e.key)) problems.push(`Pattern-Key 重复: ${e.key}`);
      keys.add(e.key);
    }
  }
  for (const e of entries) {
    if (e.status === "superseded") {
      if (!e.supersededBy) {
        problems.push(`${e.id}: superseded 缺 Superseded-By`);
      } else {
        const target = (e.supersededBy.match(/^[A-Za-z0-9._-]+/) || [])[0];
        if (!target || !keys.has(target)) problems.push(`${e.id}: Superseded-By 目标 key 不存在: ${e.supersededBy}`);
      }
    }
    if (e.status === "corrected" && !e.hasCorrection) problems.push(`${e.id}: corrected 缺 Correction 注记`);
  }
  return problems;
}

// ── fixture：合规语料（含粗体/非粗体混排、改名标题、跨条取代链）──────────────
const GOOD = [
  "# Learnings",
  "## LRN-20261116-001",
  "- **Pattern-Key**: area.old-claim",
  "- **Status**: superseded",
  "- **Superseded-By**: area.new-claim（① 节；权威见结论层）",
  "- **Evidence**: 历史证据保留",
  "## LRN-20261116-002",
  "- **Pattern-Key**: area.new-claim",
  "- **Status**: resolved",
  "## ERR-20261116-003（原 ERR-20261116-009，编号冲突改名）",
  "- Pattern-Key: area.mixed-entry",
  "- Status: corrected",
  "- **Correction**（2026-11-16）：部分 claim 被取代，有效部分迁结论层。",
].join("\n");

test("P5 合规语料零问题（粗体/非粗体混排+改名标题+取代链目标存在）", () => {
  const entries = parseEntries(GOOD);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].id, "ERR-20261116-003", "改名标题取首个 ID（忽略后缀里的旧编号）");
  assert.deepEqual(validate(entries), []);
});

test("P5 ID 重复必捕获（ERR-20261110-008 一号两条事故形态）", () => {
  const dup = GOOD + "\n## LRN-20261116-001\n- **Pattern-Key**: area.another\n- **Status**: pending\n";
  const problems = validate(parseEntries(dup));
  assert.ok(problems.some((p) => p.includes("ID 重复: LRN-20261116-001")), problems.join("; "));
});

test("P5 Pattern-Key 重复必捕获（去重键唯一性——引用键免疫编号冲突的前提）", () => {
  const dup = GOOD + "\n## LRN-20261116-004\n- **Pattern-Key**: area.new-claim\n- **Status**: pending\n";
  const problems = validate(parseEntries(dup));
  assert.ok(problems.some((p) => p.includes("Pattern-Key 重复: area.new-claim")), problems.join("; "));
});

test("P5 superseded 缺 Superseded-By / 目标 key 不存在必捕获", () => {
  const missing = "## LRN-20261116-005\n- **Pattern-Key**: area.x\n- **Status**: superseded\n";
  assert.ok(validate(parseEntries(missing)).some((p) => p.includes("缺 Superseded-By")));
  const dangling = "## LRN-20261116-006\n- **Pattern-Key**: area.y\n- **Status**: superseded\n- **Superseded-By**: area.ghost\n";
  assert.ok(validate(parseEntries(dangling)).some((p) => p.includes("目标 key 不存在")));
});

test("P5 corrected 缺 Correction 注记必捕获（防整条失效误杀有效 claim）", () => {
  const bare = "## LRN-20261116-007\n- **Pattern-Key**: area.z\n- **Status**: corrected\n";
  assert.ok(validate(parseEntries(bare)).some((p) => p.includes("缺 Correction 注记")));
});

// ── 真实语料机会性扫描（.learnings/ 默认 gitignore，缺失 skip——fresh clone/CI 安全）──
const dir = join(import.meta.dir, "..", ".learnings");
test("P5 真实语料合规（LEARNINGS+ERRORS 合并校验；目录缺失 skip）", { skip: !existsSync(dir) }, () => {
  const texts = ["LEARNINGS.md", "ERRORS.md"]
    .filter((f) => existsSync(join(dir, f)))
    .map((f) => readFileSync(join(dir, f), "utf8"));
  const entries = texts.flatMap(parseEntries);
  assert.ok(entries.length > 0, "语料非空");
  assert.deepEqual(validate(entries), [], "真实语料存在格式违规（见问题清单）");
});