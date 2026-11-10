#!/usr/bin/env bash
# scripts/tui-restart.sh — wf-workflow TUI 插件「重启验证」助手
#
# 背景（ERR-20261110-004）：宿主 opencode 的 CLI/TUI 进程对插件模块做**路径级永久缓存**，
#   首次解析成功/失败的模块记录在进程存续期内永不失效；/reload 只重载 server 侧，
#   无法清除 TUI 侧冻结缓存。因此修改插件文件后必须**完全重启进程**并验证新版加载。
#
# 用法：
#   scripts/tui-restart.sh            # 确认后终止 opencode → 前台重启 → 退出时自动判定加载结果
#   scripts/tui-restart.sh --check    # 仅健康检查（不终止任何进程，可随时运行）
#
# 判定依据：
#   ✅ 成功 = .workflow/_debug/tui-refresh.log 出现 loadedAt > 重启时刻 的新记录（新版挂件渲染探针）
#   ❌ 失败 = opencode.log 重启时刻后出现 plugin operation failed（打印具体 error）
#   ⚠️ 未判定 = 两者都没等到，请用 /plugins 面板人工确认
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${OPENCODE_LOG:-$HOME/.local/share/opencode/log/opencode.log}"
REFRESH="$ROOT/.workflow/_debug/tui-refresh.log"

# ── 健康检查（--check）：磁盘一致性 / 近期错误 / 新版新鲜度 ──────────
check() {
  local fail=0
  echo "== [1/3] 磁盘一致性（phases.js shim 与 phases.ts 均须提供 STAGE_ORDER）"
  for f in shared/phases.js shared/phases.ts; do
    if grep -q "STAGE_ORDER = PHASE_ORDER" "$ROOT/$f" 2>/dev/null; then
      echo "  ✅ $f"
    else
      echo "  ❌ $f 缺 STAGE_ORDER 导出"; fail=1
    fi
  done

  echo "== [2/3] 宿主日志错误扫描（最近 10 分钟）"
  if [[ ! -f "$LOG" ]]; then
    echo "  ⚠️ 日志不存在：$LOG"
  else
    local cutoff newest
    cutoff=$(date -u -d '10 minutes ago' '+%Y-%m-%dT%H:%M' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M')
    newest=$(grep -a "plugin operation failed" "$LOG" 2>/dev/null | grep -av "spawning" \
      | grep -oE '^timestamp=[0-9T:.Z-]+' | cut -d= -f2 | sort | tail -1)
    if [[ -z "$newest" ]]; then
      echo "  ✅ 无任何插件错误记录"
    elif [[ "${newest:0:16}" < "$cutoff" ]]; then
      echo "  ✅ 最新错误在 10 分钟前（$newest）——当前无活跃错误"
    else
      echo "  ❌ 活跃错误（最新 $newest）："
      grep -a "plugin operation failed" "$LOG" | grep -av "spawning" | grep -a "$newest" \
        | grep -oE 'error="[^"]*"' | sort -u | head -3 | sed 's/^/     /'
      fail=1
    fi
  fi

  echo "== [3/3] TUI 新版加载判定（tui-refresh.log 的 loadedAt 新鲜度）"
  if [[ ! -f "$REFRESH" ]]; then
    echo "  ⚠️ 无渲染探针记录：$REFRESH"
  else
    local lat
    lat=$(grep -o '"loadedAt":"[^"]*"' "$REFRESH" | tail -1 | cut -d'"' -f4)
    local now10
    now10=$(date -u -d '10 minutes ago' '+%Y-%m-%dT%H:%M' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M')
    if [[ "${lat:0:16}" > "$now10" || "${lat:0:16}" == "$now10" ]]; then
      echo "  ✅ 新版挂件已加载并渲染（loadedAt=$lat）"
    else
      echo "  ⚠️ loadedAt=$lat（超过 10 分钟未刷新——若刚重启过，说明新版未加载）"
    fi
  fi

  echo
  [[ $fail -eq 0 ]] && { echo "结论：✅ 健康"; return 0; } || { echo "结论：❌ 存在问题"; return 1; }
}

# ── 重启 + 自动判定 ────────────────────────────────────────────────
restart() {
  echo "⚠️  即将终止所有 opencode 进程（包含当前正在运行的 AI 会话）。"
  echo "    请在 opencode **外部**的终端运行本脚本。"
  read -rp "确认继续？[y/N] " a
  [[ "$a" == "y" || "$a" == "Y" ]] || { echo "已取消"; exit 0; }

  pkill -x opencode 2>/dev/null && echo "→ 已发送终止信号" || echo "→ 未发现 opencode 进程"
  sleep 1
  pgrep -x opencode >/dev/null 2>&1 && { echo "❌ 仍有残留进程，请手动检查：pgrep -af opencode"; exit 1; }

  local T0; T0=$(date -u '+%Y-%m-%dT%H:%M:%S')
  echo "→ 前台重启 opencode（判定基准时刻 T0=$T0）"
  echo "──────────────────────────────────────────────────"
  opencode
  # TUI 退出后自动判定
  echo "──────────────────────────────────────────────────"
  judge "$T0"
}

judge() {
  local T0="$1"
  local lat=""
  [[ -f "$REFRESH" ]] && lat=$(grep -o '"loadedAt":"[^"]*"' "$REFRESH" | tail -1 | cut -d'"' -f4)
  if [[ -n "$lat" && "${lat:0:19}" > "$T0" ]]; then
    echo "✅ 新版 TUI 已加载（loadedAt=$lat > T0=$T0）"
    echo "   建议继续人工复核：/plugins 面板状态 + /wf:ping 工具通道"
    return 0
  fi
  local err
  err=$(awk -v t="$T0" 'index($0,"timestamp=")>0 { ts=substr($0,11,19); if (ts>t && index($0,"plugin operation failed")>0) print $0 }' "$LOG" 2>/dev/null | tail -1)
  if [[ -n "$err" ]]; then
    echo "❌ 重启后仍有插件错误："
    echo "$err" | grep -oE 'error="[^"]*"' | head -1 | sed 's/^/   /'
    echo "   将错误文本反馈给 AI 定位。"
    return 1
  fi
  echo "⚠️ 未判定（无新渲染记录也无新错误）——请在 opencode 内执行 /plugins 人工确认。"
  return 2
}

case "${1:-}" in
  --check) check ;;
  "") restart ;;
  *) grep - '^# 用法' -A4 "${BASH_SOURCE[0]}" | sed 's/^# \{0,2\}//'; exit 2 ;;
esac
