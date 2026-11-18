#!/usr/bin/env bash
# wf-headless.sh — 无头编排唯一驱动轨（headless-orch M1b，源自 test_44 复盘 advance-loop 产品化）。
# 用法：wf-headless.sh <项目目录> [初始提示]
#   无既存会话：自动发起首次 `opencode run --agent workflow`（内建，防默认 build 误启）；
#   有既存会话：按全局 opencode.db 反查该目录最新顶层 workflow 会话续接。
# 终态：wf.db tasks.phase=done → PASS 退出 0；末事件恰为 wf:* 流转拒绝 ok:false（W2 R2-收窄：
#   记账事件 gate:block/session:correct 不触发 halt；halt 时 phase 保持原值）/ 迭代上限耗尽 /
#   sqlite3 读数失败重试 3 次仍败 → FAIL 退出非 0 并输出末事件。
# 环境变量：WF_HEADLESS_MAX_ITER（默认 40）、WF_HEADLESS_INTERVAL（默认 5 秒）、
#   WF_HEADLESS_MODEL（provider/model，入口前检 provider 已配置——复用 anthropic 未配置失败教训）、
#   WF_HEADLESS_PROMPT（无既存会话时的初始提示，缺省=按 entry 指引发起 intake）。
# 本脚本导出 WF_HEADLESS=1（兼容非守护宿主+语义自描述；确认卡审计标记的权威信号是项目哨兵文件
#   .workflow/.wf-headless，confirm-sentinel M3 v2——守护宿主 env 不可达）。
set -u
bash -n "$0" || { echo "❌ 脚本语法错误（bash -n 预检）"; exit 2; } # bash 逐块惰性解析——分支内语法错误执行到才暴露（test_52 L87 实证烧完 27min），启动即全文预检
DIR="${1:?用法: wf-headless.sh <项目目录> [初始提示]}"; DIR="$(cd "$DIR" && pwd)"
T0=$(date +%s) # 效率批 P3：进程墙起点（脚本起止——learner/收尾尾巴不再隐形混入单一墙钟口径）
# headless-fix W1（test_45 首启事故）：opencode run 按调用者 cwd 定项目——不切换则任务落进
# 调用者所在库（跨项目 wf.db 污染实证）。静默切换（cd 后无论从哪调用都正确，比拒绝式更根治：
# 拒绝会给自动化跨目录调用引入新失败模式）；exit 2 为防御性冗余（上一行归一化已 cd 成功，实际不可达）。
cd "$DIR" || exit 2
echo "· cwd 已切换至 $DIR" # 防静默掩盖调用方路径错误
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
  # F3 效率批补（provider env 预检）：{env:VAR} 由守护进程侧解析——模型调用经 service.json 端口
  # 代理，run 进程自带 key 无效（test_52 实证 401 Invalid token）。检查语义=存在性而非有效性
  # （key 被吊销仍会运行期 401，探针不覆盖）。作用域=仅本 provider 配置块——全文件提取会误伤
  # 其它 provider/MCP 的 {env:}（本机实证 4 var 守护进程仅 1 有）。仅 WF_HEADLESS_MODEL 设置时
  # 执行，与上方 provider 名检查同域；逃生口 WF_HEADLESS_SKIP_ENV_CHECK=1。工具缺失/解析失败/
  # 权限不足一律 ⚠️ 放行（预检是护栏不是关卡）；唯「守护进程环境缺 VAR」❌ 快速失败。
  if [ -n "${WF_HEADLESS_SKIP_ENV_CHECK:-}" ]; then
    echo "· 跳过 provider env 预检（WF_HEADLESS_SKIP_ENV_CHECK=1）"
  else
    VARS="$(awk -v re="\"${provider}\"[ ]*:[ ]*[{]" '$0 ~ re {inb=1; next} inb && (/^    "/ || /^  "[a-zA-Z]/) {exit} inb {print}' "$f" 2>/dev/null \
      | grep -oE '\{env:[A-Za-z_][A-Za-z0-9_]+\}' | sed -E 's/^[{]env:(.+)[}]$/\1/' | sort -u)"
    if [ -z "$VARS" ]; then
      echo "⚠️ provider env 预检：未从配置块提取到 $provider 的 {env:} 引用（块锚漂移/auth.json 字面 key），放行"
    else
      PORT=""
      SVC="$HOME/.config/opencode/service.json"
      [ -f "$SVC" ] && PORT="$(grep -oE '"port"[ ]*:[ ]*[0-9]+' "$SVC" | grep -oE '[0-9]+' | head -1)"
      DPID=""
      if [ -n "$PORT" ]; then
        if command -v ss >/dev/null 2>&1; then
          LISTENED="$(ss -tln 2>/dev/null | grep -c ":$PORT ")"
          DPID="$(ss -tlnp 2>/dev/null | grep ":$PORT " | head -1 | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
        elif command -v lsof >/dev/null 2>&1; then
          lsof -i ":$PORT" >/dev/null 2>&1 && LISTENED=1 || LISTENED=0
          DPID="$(lsof -t -i ":$PORT" 2>/dev/null | head -1)"
        else
          echo "⚠️ provider env 预检：ss/lsof 均不可用，无法定位守护进程环境（fail-open），放行"; PORT=""
        fi
        if [ -n "$PORT" ] && [ "${LISTENED:-}" = "0" ]; then PORT=""; fi # 端口无监听=无守护进程 → 转自查
        if [ -n "$PORT" ] && [ -z "$DPID" ]; then
          echo "⚠️ provider env 预检：端口 $PORT 在听但 pid 不可解析（跨用户/无 -p 权限），放行"; PORT=""
        fi
      fi
      MISS=""
      for v in $VARS; do
        if [ -n "$PORT" ] && [ -n "$DPID" ]; then
          if [ -r "/proc/$DPID/environ" ]; then
            tr '\0' '\n' < "/proc/$DPID/environ" 2>/dev/null | grep -q "^${v}=" || MISS="$MISS $v"
          else
            echo "⚠️ provider env 预检：/proc/$DPID/environ 不可读（跨用户？），放行"; MISS=""; break
          fi
        else
          [ -n "${!v:-}" ] || MISS="$MISS $v" # 无守护进程：run 进程自身解析 {env:}，自查 shell 环境（${!v:-} 在 set -u 下安全，已验证）
        fi
      done
      if [ -n "$MISS" ]; then
        echo "❌ 守护进程环境缺:$MISS——{env:VAR} 在守护进程侧解析（service.json:$PORT 端口代理，run 进程带 key 无效）；用带 key 的 shell 重启守护进程（kill <pid> 后：env ${MISS# }=<值> setsid nohup /usr/bin/opencode serve --service &；test_52 实证）；或 WF_HEADLESS_SKIP_ENV_CHECK=1 跳过"
        exit 2
      fi
      echo "· provider env 预检通过（$VARS）"
    fi
  fi
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
    echo "✅ PASS：任务已推到 done（迭代 $i）"
    # 效率批 P3：双墙钟——流程墙（state_json timing startedAt→finishedAt，GNU date 换算；读失败降级只打进程墙）
    FLOW=""
    TIMING="$(db_retry "$WF_DB" "SELECT json_extract(state_json,'\$.timing.startedAt')||'|'||json_extract(state_json,'\$.timing.finishedAt') FROM tasks WHERE session_id='$SID' LIMIT 1;" 2>/dev/null)" || TIMING=""
    if [ -n "${TIMING:-}" ] && [[ "$TIMING" == *"|"* ]]; then
      S_AT="${TIMING%%|*}"; F_AT="${TIMING##*|}"
      S_EPOCH=$(date -d "$S_AT" +%s 2>/dev/null) && F_EPOCH=$(date -d "$F_AT" +%s 2>/dev/null) && [ -n "$S_EPOCH" ] && [ -n "$F_EPOCH" ] && FLOW=$(( F_EPOCH - S_EPOCH ))
    fi
    PROC=$(( $(date +%s) - T0 ))
    if [ -n "$FLOW" ]; then echo "⏱ 流程墙 ${FLOW}s｜进程墙 ${PROC}s（差值=done 后收尾尾巴）"; else echo "⏱ 进程墙 ${PROC}s（timing 缺失，仅进程墙）"; fi
    exit 0
  fi
  LAST="$(db_retry "$WF_DB" "SELECT entry_json FROM events WHERE session_id='$SID' ORDER BY id DESC LIMIT 1;")" \
    || { echo "❌ FAIL：事件读数失败（重试 3 次仍败）"; exit 3; }
  # headless-fix W2（R2-收窄定案）：halt 锚=「全表末事件恰为 wf:* 流转命令且 ok=false」。
  # 白名单 wf:% 而非黑名单（未来新增记账 cmd 不会重新引入误报）；gate:block/session:correct 等
  # 记账事件（ok:0 常态）不再触发误 halt（test_46 实证 correct 垫底 4 次）。不对称取舍：漏报
  # （真 halt 被记账事件垫底遮住）=多踢一轮无害；误报=杀死活任务。
  LAST_ID="$(db_retry "$WF_DB" "SELECT id FROM events WHERE session_id='$SID' ORDER BY id DESC LIMIT 1;")" \
    || { echo "❌ FAIL：事件读数失败（重试 3 次仍败）"; exit 3; }
  HALT_ID="$(db_retry "$WF_DB" "SELECT id FROM events WHERE session_id='$SID' AND json_extract(entry_json,'\$.cmd') LIKE 'wf:%' AND json_extract(entry_json,'\$.ok')=0 ORDER BY id DESC LIMIT 1;")" \
    || { echo "❌ FAIL：事件读数失败（重试 3 次仍败）"; exit 3; }
  if [ -n "$HALT_ID" ] && [ "$HALT_ID" = "$LAST_ID" ]; then
    echo "❌ FAIL（halt）：末事件为 wf:* 流转拒绝 ok:false（phase=$PHASE 保持原值）"
    echo "末事件：$LAST"
    exit 1
  fi
  echo "· [$i/$MAX_ITER] phase=$PHASE——踢进下一回合"
  opencode run --session "$SID" "${RUN_ARGS[@]}" \
    "继续推进当前 wf 任务：按 entry/guidance 执行 phase=$PHASE 的下一步并推进状态机；若需要确认卡，选择推荐项继续。" \
    || { echo "❌ FAIL：run 回合异常退出（phase=$PHASE，未推到 done）"; exit 4; }
  sleep "$INTERVAL"
done
echo "❌ FAIL：迭代上限 $MAX_ITER 耗尽仍未到 done（phase=${PHASE:-未知}）"
exit 5
