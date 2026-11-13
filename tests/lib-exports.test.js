// T02（arch-r1-host-split）：lib 运行时导出集全集锁（先建锁后拆分；R2 前 62 名=bun -e Object.keys(lib)
// 实测；arch-r2-profile-statemachine 有意 +8：REJECT_NOTES/makeInitialWfState（types.ts）+
// PHASES_FULL/PHASES_DAILY/PROFILES/profileOf/registerProfile（flow.ts）+ renderReport（report.ts）→ 70；
// arch-r3-state-shape-migration T3.1 子步 A 有意 +1：normalizeState（types.ts，旧形状归一）→ 71）
// + barrel 形态判据（lib.ts ≤60 行）。m4-smoke 的 9 名抽查保留不动。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as lib from "../server/lib.ts";

const EXPECTED = [
  "ARTIFACT_BUDGET_KB", "ARTIFACT_BUDGET_L_KB", "ARTIFACT_BUDGET_S_KB", "ARTIFACT_PHASE",
  "BLOCKING_PHASES", "BRIEF_LINE_MAX", "DEFAULT_ALLOW_MARKERS", "DEFAULT_ALLOW_RES", "EDIT_TOOLS",
  "FLOWS", "FLOWS_DAILY", "FLOW_CMD_NAMES", "GATES", "GATES_DAILY", "GATE_ERR", "HINT_ENTRY",
  "HINT_TRIGGERS", "KIND_FILES", "LEADER_AGENT", "LEADER_ALIASES", "LIMITS", "NEXT", "NEXT_DAILY",
  "PHASES_DAILY", "PHASES_FULL", "PROFILES", "READONLY_CMDS", "REJECT_NOTES", "REJECT_PREFIX",
  "SID_ALIAS_AUTO", "SID_ALIAS_USAGE", "VERSION", "WF_ROLES",
  "artifactPhaseWarning", "artifactSizeWarning", "briefFallback", "budgetFor", "clipBrief",
  "completeSidPrefix", "diagnoseReport", "evaluateTransition", "extractPaths", "flowFor",
  "fuzzyFind", "gateFor", "hasStrictVerdictLine", "isDaily", "isHintWorthy", "isLeader",
  "isNearTruncation", "isRejectReport", "isSelfModDir", "leaderOnlyReject", "levelFor",
  "makeAllowChecker", "makeInitialWfState", "nextFor", "normalizeFuzzy", "normalizeState", "parseVerdict", "pingReport",
  "profileOf", "promptText", "registerProfile", "renderReport", "resolveSidAlias", "selfModWarnLine",
  "shellWriteTargets", "slugify", "tierOf", "trackRoleSession",
];

test("T02 导出集零漂移：Object.keys(lib) === 71 名全集锁", () => {
  assert.equal(EXPECTED.length, 71);
  assert.deepEqual(Object.keys(lib).toSorted(), [...EXPECTED].toSorted());
});

test("T02 barrel 形态：lib.ts ≤60 行（纯转发无实现体）", () => {
  const src = fs.readFileSync(new URL("../server/lib.ts", import.meta.url), "utf8");
  const n = src.split("\n").length;
  assert.ok(n <= 60, `lib.ts 当前 ${n} 行，须 ≤60（T02 拆分后为 barrel）`);
});
