#!/usr/bin/env bash
# scripts/wf-forensics.sh — wf 任务单库机械取数标准化（W12，2026-11-18 合并批）。
# 背景：每轮验证的人工取证（四指标/流转轨迹/自愈计数）为多条手写 SQL，口径易漂移——本脚本把
#   效率四指标与流程轨迹收敛为一条命令的只读报表（与 wf-headless.sh 同源 SQL 口径：sqlite3 -readonly、
#   events.at、timing json_extract）。
# 用法：wf-forensics.sh <项目目录> [session_id]     # 目录态：读 <目录>/.workflow/wf.db
#       wf-forensics.sh --db <wf.db路径> [session_id]  # 直连态（备份库/非常规布局）
#       session_id 缺省=该库最新任务（updated_at DESC）。
# 输出七节：①终态+双墙钟 ②rounds 三计数 ③流转轨迹（逐行 gap 秒）④返修链与委派区间 ⑤计数器
#   ⑥plan 体积+工件清单 ⑦口径注记。只读零写入；守护日志切片属操作层，不在本脚本域（见⑦）。
# S 级容错：无 tier:inject/deleg 事件的库输出「—（无委派）」不报错。
set -uo pipefail
bash -n "$0" || { echo "❌ 脚本语法错误（bash -n 预检）"; exit 2; }
command -v sqlite3 >/dev/null || { echo "❌ 缺 sqlite3（wf.db 只读取数依赖）"; exit 2; }

DB=""; DIR=""; SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="${2:?--db 需要路径}"; shift 2 ;;
    -h|--help) echo "用法: wf-forensics.sh <项目目录> [session_id] | wf-forensics.sh --db <wf.db路径> [session_id]"; exit 0 ;;
    *) if [ -z "$DIR" ]; then DIR="$1"; else SID="$1"; fi; shift ;;
  esac
done
[ -z "$DB" ] && { [ -n "$DIR" ] || { echo "❌ 用法: wf-forensics.sh <项目目录> [session_id] | --db <wf.db路径> [session_id]"; exit 2; }; DB="$DIR/.workflow/wf.db"; }
[ -f "$DB" ] || { echo "❌ wf.db 不存在：$DB"; exit 2; }
case "$SID" in *"'"*) echo "❌ session_id 含单引号（注入防御，拒绝）"; exit 2 ;; esac
ROOT="$(dirname "$(dirname "$DB")")" # <目录>/.workflow/wf.db → 项目根（--db 直连态同样成立）
q() { sqlite3 -readonly "$DB" "$1" 2>/dev/null; }

# ── ① 终态+双墙钟 ─────────────────────────────────────────────
WHERE=""; [ -n "$SID" ] && WHERE="WHERE session_id='$SID'"
ROW="$(q "SELECT slug, phase, session_id, json_extract(state_json,'\$.timing.startedAt'), json_extract(state_json,'\$.timing.finishedAt') FROM tasks $WHERE ORDER BY updated_at DESC LIMIT 1;")"
[ -n "$ROW" ] || { echo "❌ 库内无任务行：$DB"; exit 3; }
SLUG="$(echo "$ROW" | cut -d'|' -f1)"; PHASE="$(echo "$ROW" | cut -d'|' -f2)"
[ -z "$SID" ] && SID="$(echo "$ROW" | cut -d'|' -f3)"
S_AT="$(echo "$ROW" | cut -d'|' -f4)"; F_AT="$(echo "$ROW" | cut -d'|' -f5)"
echo "═══ ① 终态 ═══"
SIZE="$(q "SELECT coalesce(json_extract(state_json,'$.size'),'∅') FROM tasks $WHERE ORDER BY updated_at DESC LIMIT 1;")"
DRIFT_N="$(q "SELECT COUNT(*) FROM events WHERE session_id='$SID' AND json_extract(entry_json,'$.cmd')='size:drift-observe';")"
echo "slug=$SLUG  phase=$PHASE  size=$SIZE  drift-observe=$DRIFT_N  session=$SID" # W15-a：size 口径（M 级验收轮断言 size=M 在场）+漂移观察计数
FLOW=""
if [ -n "$S_AT" ] && [ -n "$F_AT" ]; then
  SE=$(date -d "$S_AT" +%s 2>/dev/null); FE=$(date -d "$F_AT" +%s 2>/dev/null)
  if [ -n "$SE" ] && [ -n "$FE" ]; then FLOW=$(( FE - SE )); echo "流程墙（timing startedAt→finishedAt）: ${FLOW}s（$S_AT → $F_AT）"; fi
fi
[ -z "$FLOW" ] && echo "流程墙: —（timing 缺失）"
FIRST="$(q "SELECT at FROM events WHERE session_id='$SID' ORDER BY id LIMIT 1;")"
LAST="$(q "SELECT at FROM events WHERE session_id='$SID' ORDER BY id DESC LIMIT 1;")"
if [ -n "$FIRST" ] && [ -n "$LAST" ]; then
  FE1=$(date -d "$FIRST" +%s 2>/dev/null); FL=$(date -d "$LAST" +%s 2>/dev/null)
  [ -n "$FE1" ] && [ -n "$FL" ] && echo "事件首尾墙（首事件→末事件）: $(( FL - FE1 ))s"
fi

# ── ② rounds 三计数 ───────────────────────────────────────────
echo "═══ ② rounds ═══"
q "SELECT 'plan_review='||json_extract(state_json,'\$.rounds.plan_review')||'  build_review='||coalesce(json_extract(state_json,'\$.rounds.build_review'),0)||'  test_fix='||coalesce(json_extract(state_json,'\$.rounds.test_fix'),0) FROM tasks WHERE session_id='$SID';"

# ── ③④ 流转轨迹 + 返修链与委派区间（同一 awk 遍历）─────────────
echo "═══ ③ 流转轨迹（gap=距上一事件秒）═══"
q "SELECT at||'|'||json_extract(entry_json,'\$.cmd')||'|'||coalesce(json_extract(entry_json,'\$.from'),'-')||'|'||coalesce(json_extract(entry_json,'\$.to'),'-')||'|'||coalesce(json_extract(entry_json,'\$.note'),'') FROM events WHERE session_id='$SID' ORDER BY id;" \
| awk -F'|' '
  { ts=$1; cmd=$2; gsub(/^[ \t]+|[ \t]+$/, "", ts);
    epoch=""; "date -d \"" ts "\" +%s" | getline epoch; close("date -d \"" ts "\" +%s");
    gap = (prev=="" ? "-" : epoch-prevE);
    printf "%s  %-22s %s→%-9s gap=%ss  %s\n", ts, cmd, $3, $4, gap, substr($5,1,60);
    # ④a 委派区间：tier:inject 开窗 → 下一 wf:* 流转关窗（同 phase 近似口径）
    if (cmd=="tier:inject") { pending=epoch; pendingTs=ts }
    else if (pending!="" && cmd ~ /^wf:/) { printf "DELEG %s", $4; printf "  %s → %s = %ds（tier:inject→本流转）\n", pendingTs, ts, epoch-pending; pending="" }
    # ④b 返修链：wf:plan(review→planning)=patch 开窗 → 下一 wf:review 关窗；其后再遇 wf:build 前的区间=复审
    if (cmd=="wf:plan" && $3=="review") { patch=epoch; patchTs=ts }
    else if (patch!="" && cmd=="wf:review") { printf "REWORK plan修订  %s → %s = %ds（patch 落盘）\n", patchTs, ts, epoch-patch; patch2=epoch; patch2Ts=ts; patch="" }
    else if (patch2!="" && cmd=="wf:build") { printf "REWORK r2复审    %s → %s = %ds（复审→放行 build）\n", patch2Ts, ts, epoch-patch2; patch2="" }
  }
'
echo "═══ ④ 返修链与委派区间汇总 ═══"
echo "（口径：DELEG=tier:inject→下一 wf:* 流转；REWORK=patch 落盘与 r2 复审分段；无输出行=该库无委派/无返修）"

# ── ⑤ 计数器 ─────────────────────────────────────────────────
echo "═══ ⑤ 计数器 ═══"
CORRECT="$(q "SELECT count(*) FROM events WHERE session_id='$SID' AND entry_json LIKE '%session:correct%';")"
BLOCK="$(q "SELECT count(*) FROM events WHERE session_id='$SID' AND entry_json LIKE '%gate:block%';")"
CONFIRM="$(q "SELECT count(*) FROM events WHERE session_id='$SID' AND (entry_json LIKE '%intake:confirm%' OR entry_json LIKE '%plan:confirm%');")"
DELEG_N="$(q "SELECT count(*) FROM events WHERE session_id='$SID' AND entry_json LIKE '%deleg:observe%';")"
echo "session:correct=${CORRECT:-0}  gate:block=${BLOCK:-0}  confirm-observed=${CONFIRM:-0}  deleg=${DELEG_N:-0}"

# ── ⑥ plan 体积 + 工件清单 ────────────────────────────────────
echo "═══ ⑥ 产物 ═══"
PLAN="$ROOT/.workflow/$SLUG/plan.md"
if [ -f "$PLAN" ]; then echo "plan.md: $(wc -c < "$PLAN") bytes"; else echo "plan.md: —（未产出于 $PLAN）"; fi
ARTDIR="$ROOT/.workflow/$SLUG"
if [ -d "$ARTDIR" ]; then echo "工件清单："; ls "$ARTDIR" | sed 's/^/  - /'; else echo "工件目录不存在：$ARTDIR"; fi

# ── ⑦ 口径注记 ───────────────────────────────────────────────
echo "═══ ⑦ 口径注记 ═══"
echo "- 流程墙=tasks.timing startedAt→finishedAt；事件首尾墙=intake 事件→末事件（两者差=done 后收尾差异）"
echo "- DELEG/REWORK 区间为近似口径（tier:inject 开窗含委派前置间隙）；并行有效度需多 lane 场景，本脚本不估算（反事实必须实测）"
echo "- 守护日志 state:phantom-* / failed-to-load 切片属操作层（/proc/<pid>/fd 或 opencode.log），不在本脚本域"
echo "- 会话过滤：session_id=$SID；库=$DB"
