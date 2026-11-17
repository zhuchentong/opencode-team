#!/usr/bin/env bash
# wf-headless.sh — 无头编排唯一驱动轨（headless-orch M1b，源自 test_44 复盘 advance-loop 产品化）。
# 用法：wf-headless.sh <项目目录> [初始提示]
#   无既存会话：自动发起首次 `opencode run --agent workflow`（内建，防默认 build 误启）；
#   有既存会话：按全局 opencode.db 反查该目录最新顶层 workflow 会话续接。
# 终态：wf.db tasks.phase=done → PASS 退出 0；最后事件 ok:false（halt 判定锚是事件，非 phase——
#   halt 时 phase 保持原值）/ 迭代上限耗尽 / sqlite3 读数失败重试 3 次仍败 → FAIL 退出非 0 并输出末事件。
# 环境变量：WF_HEADLESS_MAX_ITER（默认 40）、WF_HEADLESS_INTERVAL（默认 5 秒）、
#   WF_HEADLESS_MODEL（provider/model，入口前检 provider 已配置——复用 anthropic 未配置失败教训）、
#   WF_HEADLESS_PROMPT（无既存会话时的初始提示，缺省=按 entry 指引发起 intake）。
# 本脚本导出 WF_HEADLESS=1（guard-hook 确认卡审计 auto=non-interactive 标记的数据源，M3）。
set -u
DIR="${1:?用法: wf-headless.sh <项目目录> [初始提示]}"; DIR="$(cd "$DIR" && pwd)"
FIRST_PROMPT="${2:-${WF_HEADLESS_PROMPT:-}}"

# ── 依赖与前置检查（fail-fast）─────────────────────────────────────
command -v sqlite3 >/dev/null || { echo "❌ 缺 sqlite3（wf.db/事件读取依赖），请安装后重试"; exit 2; }
command -v opencode >/dev/null || { echo "❌ 缺 opencode CLI"; exit 2; }
GLOBAL_DB="${WF_HEADLESS_GLOBAL_DB:-$HOME/.local/share/opencode/opencode.db}"
WF_DB="$DIR/.workflow/wf.db"
[ -f "$GLOBAL_DB" ] || { echo "❌ 全局会话库不存在：$GLOBAL_DB"; exit 2; }
if [ -n "${WF_HEADLESS_MODEL:-}" ]; then
  provider="${WF_HEADLESS_MODEL%%/*}"
  cfg_hit=0
  for f in "$DIR"/opencode.json "$DIR"/opencode.jsonc "$HOME"/.config/opencode/opencode.json "$HOME"/.config/opencode/opencode.jsonc "$HOME"/.local/share/opencode/auth.json; do
    [ -f "$f" ] && grep -q "\"$provider\"\|\"$provider/\|$provider/" "$f" 2>/dev/null && { cfg_hit=1; break; }
  done
  [ "$cfg_hit" = 1 ] || { echo "❌ model provider=$provider 未在项目/全局配置或 auth 中找到（复用 anthropic 失败教训——先配置再跑）"; exit 2; }
fi
export WF_HEADLESS=1
# confirm-sentinel M3：无头确认标记哨兵——守护宿主（opencode serve --service）不继承 wrapper env，
# WF_HEADLESS 对插件不可达（test_45 实证）。改用项目哨兵文件 <$DIR>/.workflow/.wf-headless 传信号：
# 初值 pending:<epoch>（首启 run 期间的 intake 卡亦须被标记——SID 未定稿阶段，评审 BLOCKER b）；
# 反查到 SID 后改写为会话 id（guard-hook 以 sid 全等为主防误标机制）。GUI 场景无此文件=零影响。
SENTINEL="$DIR/.workflow/.wf-headless"
mkdir -p "$DIR/.workflow"
printf '%s' "pending:$(date +%s)" > "$SENTINEL"
trap 'rm -f "$SENTINEL"' EXIT
trap 'exit 130' INT TERM # bash 的 INT/TERM 不自动触发 EXIT trap，须显式中转否则 Ctrl-C 必残留哨兵
RUN_ARGS=(--agent workflow)
[ -n "${WF_HEADLESS_MODEL:-}" ] && RUN_ARGS+=(--model "$WF_HEADLESS_MODEL")

# ── 会话 id 来源：优先反查既存（只读），无则首启并事后反查 ──────────
db_retry() { # db_retry <db> <sql>：sqlite3 读数失败重试 3 次（busy 窗口容忍）
  local db="$1" sql="$2" out="" i
  for i in 1 2 3; do
    out="$(sqlite3 -readonly "$db" "$sql" 2>/dev/null)" && { printf '%s' "$out"; return 0; }
    sleep 2
  done
  return 1
}
SID="$(db_retry "$WF_DB" "SELECT session_id FROM tasks ORDER BY updated_at DESC LIMIT 1;")"

if [ -z "$SID" ]; then
  echo "· 无既存会话——首启 opencode run（内建 --agent workflow）"
  if [ -z "$FIRST_PROMPT" ]; then
    echo "❌ 无既存会话须提供初始提示（参数 2 或 WF_HEADLESS_PROMPT）"; exit 2
  fi
  opencode run "${RUN_ARGS[@]}" "$FIRST_PROMPT" || { echo "❌ 首启 run 失败（检查 model 配置/网络）"; exit 2; }
SID="$(db_retry "$WF_DB" "SELECT session_id FROM tasks ORDER BY updated_at DESC LIMIT 1;")"
  [ -n "$SID" ] || { echo "❌ 首启后仍无法定位会话 id（反查 $GLOBAL_DB 失败）"; exit 2; }
fi
echo "· 会话 $SID｜项目 $DIR"
printf '%s' "$SID" > "$SENTINEL" # 哨兵定稿：此后以 sid 全等防 GUI 并发会话误标

# ── 推进循环 ───────────────────────────────────────────────────────
MAX_ITER="${WF_HEADLESS_MAX_ITER:-40}"
INTERVAL="${WF_HEADLESS_INTERVAL:-5}"
for i in $(seq 1 "$MAX_ITER"); do
  touch "$SENTINEL" # 每迭代刷新 mtime（guard-hook 24h 新鲜窗口；含 wf.db 未出现的 WAIT 分支）
  [ -f "$WF_DB" ] || { echo "· 待 wf.db 出现（$WF_DB）…"; sleep "$INTERVAL"; continue; }
  PHASE="$(db_retry "$WF_DB" "SELECT phase FROM tasks WHERE session_id='$SID' ORDER BY rowid DESC LIMIT 1;")" \
    || { echo "❌ FAIL：wf.db 读数失败（重试 3 次仍败）"; exit 3; }
  if [ "$PHASE" = "done" ]; then
    echo "✅ PASS：任务已推到 done（迭代 $i）"; exit 0
  fi
  LAST="$(db_retry "$WF_DB" "SELECT entry_json FROM events WHERE session_id='$SID' ORDER BY id DESC LIMIT 1;")" \
    || { echo "❌ FAIL：事件读数失败（重试 3 次仍败）"; exit 3; }
  case "$LAST" in
    *'"ok":false'*)
      echo "❌ FAIL（halt）：最后事件为 ok:false（phase=$PHASE 保持原值）"
      echo "末事件：$LAST"
      exit 1 ;;
  esac
  echo "· [$i/$MAX_ITER] phase=$PHASE——踢进下一回合"
  opencode run --session "$SID" "${RUN_ARGS[@]}" \
    "继续推进当前 wf 任务：按 entry/guidance 执行 phase=$PHASE 的下一步并推进状态机；若需要确认卡，选择推荐项继续。" \
    || { echo "❌ FAIL：run 回合异常退出（phase=$PHASE，未推到 done）"; exit 4; }
  sleep "$INTERVAL"
done
echo "❌ FAIL：迭代上限 $MAX_ITER 耗尽仍未到 done（phase=${PHASE:-未知}）"
exit 5
