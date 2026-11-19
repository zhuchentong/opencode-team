// T02（arch-r1-host-split）：lib 运行时导出集全集锁（先建锁后拆分；R2 前 62 名=bun -e Object.keys(lib)
// 实测；arch-r2-profile-statemachine 有意 +8：REJECT_NOTES/makeInitialWfState（types.ts）+
// PHASES_FULL/PHASES_DAILY/PROFILES/profileOf/registerProfile（flow.ts）+ renderReport（report.ts）→ 70；
// arch-r3-state-shape-migration T3.1 子步 A 有意 +1：normalizeState（types.ts，旧形状归一）；
// T3.2 有意 +1：sidRefText（types.ts，SidRef 唯一渲染出口）；latency-v3.1 P1-E 有意 +1：LANE_CAP → 73；
// r54 批次 B 有意 +1：orphanArtifactLines（diagnose.ts，孤儿产物对账纯函数）→ 77；
// r55 有意 +2：laneCapNote（policy.ts，cap 波次残留口径）+ laneTableWritten（artifact.ts，lane 表判定归一）→ 79；LANE_STALE_MS 常量单点同批 +1 → 80）
// opt-agentic 项① 有意 +1：markVerdicts（artifact.ts，产物记账单点——artifact-tool mark 与
// gate-reconcile 补记共用，消除 laneTableWritten 旧正则口径分叉）→ 81）
// 效率批 P1 有意 +2：checkLaneDeps/parseLaneDeps（lane-graph.ts，lane 依赖边表机器区解析/校验纯函数）→ 83）
// W11-v2.1 有意 +3：checkProbeMatrix/parseProbeMatrix（probe-matrix.ts，探针拓扑机器区）+ containsGitInit
// （guard.ts，git init 引号感知侦测纯函数）→ 86）
// W14 有意 +1：checkPlanEscape（plan-escape.ts，扩展逃生门条款写时预检纯函数）→ 89；W15-a 再 +2：auditTierDrift/TIER_DRIFT_MIN_T）
// + barrel 形态判据（lib.ts ≤60 行）。m4-smoke 的 9 名抽查保留不动。
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as lib from "../server/lib.ts";

const EXPECTED = [
  "ARTIFACT_BUDGET_KB", "ARTIFACT_BUDGET_L_KB", "ARTIFACT_BUDGET_S_KB", "ARTIFACT_PHASE",
  "BLOCKING_PHASES", "BRIEF_LINE_MAX", "CHUNK_KB", "CHUNK_MAX", "DAY_MS", "DEFAULT_ALLOW_MARKERS", "DEFAULT_ALLOW_RES", "EDIT_TOOLS",
  "FLOWS", "FLOWS_DAILY", "FLOW_CMD_NAMES", "GATES", "GATES_DAILY", "GATE_ERR", "HINT_ENTRY",
  "HINT_TRIGGERS", "KIND_FILES", "LANE_CAP", "LEADER_AGENT", "LEADER_ALIASES", "LIMITS", "NEXT", "NEXT_DAILY",
  "PHASES_DAILY", "PHASES_FULL", "PROFILES", "READONLY_CMDS", "REJECT_NOTES", "REJECT_PREFIX",
  "SID_ALIAS_AUTO", "SID_ALIAS_USAGE", "VERSION", "WF_ROLES",
  "artifactPhaseWarning", "artifactSizeWarning", "briefFallback", "budgetFor", "checkLaneDeps", "checkPlanEscape", "checkProbeMatrix", "auditTierDrift", "TIER_DRIFT_MIN_T", "clipBrief", "containsGitInit",
  "completeSidPrefix", "diagnoseReport", "evaluateTransition", "extractPaths", "flowFor",
  "fuzzyFind", "gateFor", "hasStrictVerdictLine", "isDaily", "isHintWorthy", "isLeader",
  "LANE_STALE_MS", "isNearTruncation", "isRejectReport", "isSelfModDir", "laneCapNote", "laneTableWritten", "leaderOnlyReject", "levelFor",
  "makeAllowChecker", "makeInitialWfState", "markVerdicts", "nextFor", "normalizeFuzzy", "normalizeState", "orphanArtifactLines", "parseLaneDeps", "parseProbeMatrix", "parseVerdict", "pingReport",
  "profileOf", "promptText", "registerProfile", "renderReport", "resolveSidAlias", "selfModWarnLine", "sidRefText",
  "shellWriteTargets", "slugify", "tierOf", "trackRoleSession",
];

test("T02 导出集零漂移：Object.keys(lib) === 89 名全集锁", () => {
  assert.equal(EXPECTED.length, 89); // W15-a +2：auditTierDrift/TIER_DRIFT_MIN_T（tier-audit.ts 体量漂移观察闸）
  assert.deepEqual(Object.keys(lib).toSorted(), [...EXPECTED].toSorted());
});

test("T02 barrel 形态：lib.ts ≤60 行（纯转发无实现体）", () => {
  const src = fs.readFileSync(new URL("../server/lib.ts", import.meta.url), "utf8");
  const n = src.split("\n").length;
  assert.ok(n <= 60, `lib.ts 当前 ${n} 行，须 ≤60（T02 拆分后为 barrel）`);
});
