#!/bin/bash
# ccchat-improve Statusline - terminal UI dashboard for Claude Code
# Receives JSON session data on stdin

DATA=$(cat)

# ── Single jq pass: extract every field as a tab-separated row ─────────────
ROW=$(echo "$DATA" | jq -r '
  [
    (.agent.name // ""),
    (.model.display_name // .model.id // "unknown"),
    (.effort.level // ""),
    (.context_window.used_percentage // 0 | tostring),
    (((.context_window.current_usage.input_tokens // 0)
      + (.context_window.current_usage.cache_creation_input_tokens // 0)
      + (.context_window.current_usage.cache_read_input_tokens // 0)) | tostring),
    (.context_window.context_window_size // "" | tostring),
    (.cost.total_cost_usd // 0 | tostring),
    (.cost.total_duration_ms // 0 | tostring),
    (.cost.total_lines_added // 0 | tostring),
    (.cost.total_lines_removed // 0 | tostring),
    (.rate_limits.five_hour.used_percentage // "" | tostring),
    (.rate_limits.five_hour.resets_at // "" | tostring),
    (.rate_limits.seven_day.used_percentage // "" | tostring),
    (.rate_limits.seven_day.resets_at // "" | tostring),
    (.rate_limits.spend_limit.used_usd // "" | tostring),
    (.rate_limits.spend_limit.limit_usd // "" | tostring),
    (.workspace.project_dir // ""),
    (.workspace.current_dir // .cwd // ""),
    (.worktree.branch // ""),
    (.prompt_cache.hit_ratio // "" | tostring),
    (.session_name // "")
  ] | join("\u001f")
' 2>/dev/null)

# NOTE: a tab (or any whitespace-only IFS) makes bash `read` collapse/strip
# empty leading fields, silently shifting every later field. Use the
# non-whitespace unit-separator (0x1F) instead.
IFS=$'\x1f' read -r AGENT MODEL EFFORT CTX_PCT CTX_USED CTX_TOTAL COST DURATION_MS \
  LINES_ADD LINES_REM RATE_5H RATE_5H_RESET RATE_7D RATE_7D_RESET SPEND_USD \
  SPEND_LIMIT PROJECT_DIR CURRENT_DIR WT_BRANCH CACHE_HIT_RATIO SESSION_NAME <<< "$ROW"

# ── ANSI color definitions ──────────────────────────────────────────────────
RESET="\033[0m"
BOLD="\033[1m"
DIM="\033[2m"

# 256-color palette
C_AGENT="\033[1;38;5;75m"     # Bold bright blue — agent name
C_MODEL="\033[38;5;117m"      # Bright cyan — model
C_COST="\033[38;5;228m"       # Bright yellow — cost
C_DIM_WHITE="\033[2;37m"      # Dim white — duration
C_LINES_ADD="\033[38;5;114m"  # Green — lines added
C_LINES_REM="\033[38;5;203m"  # Red — lines removed
C_FRAME="\033[38;5;240m"      # Dim gray — borders and separators
C_BAR_GREEN="\033[38;5;114m"  # Progress bar low
C_BAR_YELLOW="\033[38;5;226m" # Progress bar mid
C_BAR_RED="\033[38;5;203m"    # Progress bar high
C_PROJECT="\033[38;5;180m"    # Warm tan — project name
C_BRANCH="\033[38;5;156m"     # Light green — branch

# ── Agent name fallback chain ───────────────────────────────────────────────
# agent.name -> <project_dir>/.claude/ccchat-identity.json -> session_name -> project basename
if [ -z "$AGENT" ] && [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/.claude/ccchat-identity.json" ]; then
  AGENT=$(jq -r '.name // empty' "$PROJECT_DIR/.claude/ccchat-identity.json" 2>/dev/null)
fi
if [ -z "$AGENT" ] && [ -n "$SESSION_NAME" ]; then
  AGENT="$SESSION_NAME"
fi

# ── Context bar color thresholds ────────────────────────────────────────────
CTX_INT=${CTX_PCT%.*}
CTX_INT=${CTX_INT:-0}

if [ "$(echo "$CTX_PCT > 85" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
  CTX_COLOR="$C_BAR_RED"
elif [ "$(echo "$CTX_PCT > 60" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
  CTX_COLOR="$C_BAR_YELLOW"
else
  CTX_COLOR="$C_BAR_GREEN"
fi

# ── Gradient progress bar (15 chars wide) ───────────────────────────────────
BAR_WIDTH=15
FULL_CELLS=$(( CTX_INT * BAR_WIDTH / 100 ))
REMAINDER=$(( (CTX_INT * BAR_WIDTH * 8 / 100) - (FULL_CELLS * 8) ))
EMPTY_CELLS=$(( BAR_WIDTH - FULL_CELLS ))

PARTIAL_CHARS=(" " "▏" "▎" "▍" "▌" "▋" "▊" "▉")

BAR="${CTX_COLOR}"
for ((i=0; i<FULL_CELLS; i++)); do BAR+="█"; done

if [ "$FULL_CELLS" -lt "$BAR_WIDTH" ] && [ "$REMAINDER" -gt 0 ]; then
  BAR+="${PARTIAL_CHARS[$REMAINDER]}"
  EMPTY_CELLS=$(( EMPTY_CELLS - 1 ))
fi

BAR+="${DIM}"
for ((i=0; i<EMPTY_CELLS; i++)); do BAR+="░"; done
BAR+="${RESET}"

# ── Token count formatting (e.g., "450k/1M") ───────────────────────────────
format_tokens() {
  local tokens="$1"
  if [ -z "$tokens" ] || [ "$tokens" = "null" ]; then
    echo ""
    return
  fi
  local t=${tokens%.*}
  [ -z "$t" ] && t=0
  if [ "$t" -ge 1000000 ]; then
    local m=$(( t / 100000 ))
    local whole=$(( m / 10 ))
    local frac=$(( m % 10 ))
    if [ "$frac" -eq 0 ]; then
      echo "${whole}M"
    else
      echo "${whole}.${frac}M"
    fi
  elif [ "$t" -ge 1000 ]; then
    echo "$(( t / 1000 ))k"
  else
    echo "${t}"
  fi
}

TOKEN_USED_FMT=$(format_tokens "$CTX_USED")
TOKEN_TOTAL_FMT=$(format_tokens "$CTX_TOTAL")

# Build context label: "450k/1M" if tokens available, otherwise just "%"
if [ -n "$TOKEN_USED_FMT" ] && [ -n "$TOKEN_TOTAL_FMT" ]; then
  CTX_LABEL="${TOKEN_USED_FMT}/${TOKEN_TOTAL_FMT}"
else
  CTX_LABEL="${CTX_INT}%"
fi

# ── Project name (basename of project_dir, fallback current_dir, then cwd) ──
PROJECT_PATH="$PROJECT_DIR"
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$CURRENT_DIR"
[ -z "$PROJECT_PATH" ] && PROJECT_PATH="$(pwd)"
PROJECT=""
[ -n "$PROJECT_PATH" ] && PROJECT=$(basename "$PROJECT_PATH")

if [ -z "$AGENT" ]; then
  AGENT="$PROJECT"
fi

# ── Branch: worktree.branch, else git in current_dir ────────────────────────
BRANCH="$WT_BRANCH"
if [ -z "$BRANCH" ]; then
  GIT_DIR="$CURRENT_DIR"
  [ -z "$GIT_DIR" ] && GIT_DIR="$(pwd)"
  BRANCH=$(git -C "$GIT_DIR" branch --show-current 2>/dev/null)
fi

# ── Duration formatting ──────────────────────────────────────────────────────
: "${DURATION_MS:=0}"
[ -z "$DURATION_MS" ] && DURATION_MS=0
DURATION_SEC=$((${DURATION_MS%.*} / 1000))
HOURS=$((DURATION_SEC / 3600))
MINS=$(( (DURATION_SEC % 3600) / 60 ))
SECS=$((DURATION_SEC % 60))
if [ "$HOURS" -gt 0 ]; then
  DURATION_FMT=$(printf "%dh%02dm" "$HOURS" "$MINS")
else
  DURATION_FMT=$(printf "%dm%02ds" "$MINS" "$SECS")
fi

# ── Cost formatting ──────────────────────────────────────────────────────────
[ -z "$COST" ] && COST=0
COST_FMT=$(printf '$%.2f' "$COST")

# ── Reset countdown formatting (epoch seconds -> "2h10m" / "3d4h") ─────────
format_reset() {
  local resets_at="$1"
  [ -z "$resets_at" ] && { echo ""; return; }
  local resets_int=${resets_at%.*}
  local now
  now=$(date +%s)
  local diff=$(( resets_int - now ))
  [ "$diff" -lt 0 ] && diff=0
  local days=$(( diff / 86400 ))
  local hours=$(( (diff % 86400) / 3600 ))
  local mins=$(( (diff % 3600) / 60 ))
  if [ "$days" -gt 0 ]; then
    echo "${days}d${hours}h"
  elif [ "$hours" -gt 0 ]; then
    echo "${hours}h${mins}m"
  else
    echo "${mins}m"
  fi
}

# ── Rate limit string ────────────────────────────────────────────────────────
RATE_STR=""
if [ -n "$RATE_5H" ]; then
  RATE_5H_INT=${RATE_5H%.*}
  if [ "$(echo "$RATE_5H > 80" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
    R5_COLOR="$C_LINES_REM"
  elif [ "$(echo "$RATE_5H > 50" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
    R5_COLOR="$C_BAR_YELLOW"
  else
    R5_COLOR="$C_LINES_ADD"
  fi
  RATE_5H_RST=$(format_reset "$RATE_5H_RESET")
  RATE_STR="${R5_COLOR}5h:${RATE_5H_INT}%"
  [ -n "$RATE_5H_RST" ] && RATE_STR="${RATE_STR} ↻${RATE_5H_RST}"
  RATE_STR="${RATE_STR}${RESET}"
  if [ -n "$RATE_7D" ]; then
    RATE_7D_INT=${RATE_7D%.*}
    RATE_7D_RST=$(format_reset "$RATE_7D_RESET")
    RATE_STR="${RATE_STR} ${DIM}7d:${RATE_7D_INT}%"
    [ -n "$RATE_7D_RST" ] && RATE_STR="${RATE_STR} ↻${RATE_7D_RST}"
    RATE_STR="${RATE_STR}${RESET}"
  fi
fi
if [ -n "$SPEND_USD" ]; then
  RATE_STR="${RATE_STR}${RATE_STR:+ }${DIM}spend:\$${SPEND_USD}/\$${SPEND_LIMIT}${RESET}"
fi

# ── Prompt cache hit ratio (0..1 -> "%") ─────────────────────────────────────
CACHE_STR=""
if [ -n "$CACHE_HIT_RATIO" ]; then
  CACHE_PCT=$(echo "$CACHE_HIT_RATIO" | awk '{printf "%.0f", $1 * 100}' 2>/dev/null)
  [ -n "$CACHE_PCT" ] && CACHE_STR="⚙${CACHE_PCT}%"
fi

# ── Model + effort ───────────────────────────────────────────────────────────
MODEL_LABEL="$MODEL"
[ -n "$EFFORT" ] && MODEL_LABEL="${MODEL}·${EFFORT}"

# ── Build single content line ────────────────────────────────────────────────
SEP="${C_FRAME}│${RESET}"

COL_AGENT="${C_AGENT}💬 ${AGENT}${RESET}"
COL_CTX="${BAR} ${CTX_COLOR}${CTX_LABEL}${RESET}"
COL_MODEL="${C_MODEL}🧠 ${MODEL_LABEL}${RESET}"
COL_COST="${C_COST}💰 ${COST_FMT}${RESET}"
COL_DUR="${C_DIM_WHITE}⏱️  ${DURATION_FMT}${RESET}"
COL_LINES="${C_LINES_ADD}📝 +${LINES_ADD}${RESET}${C_FRAME}/${RESET}${C_LINES_REM}-${LINES_REM}${RESET}"

# Start building the line
COL_CONTENT=" ${COL_AGENT}"

# Add project name if available
if [ -n "$PROJECT" ]; then
  COL_CONTENT="${COL_CONTENT} ${SEP} ${C_PROJECT}📂 ${PROJECT}${RESET}"
fi

# Add branch if available
if [ -n "$BRANCH" ] && [ "$BRANCH" != "null" ]; then
  COL_CONTENT="${COL_CONTENT} ${SEP} ${C_BRANCH}🌿 ${BRANCH}${RESET}"
fi

# Add remaining segments
COL_CONTENT="${COL_CONTENT} ${SEP} ${COL_CTX} ${SEP} ${COL_MODEL} ${SEP} ${COL_COST} ${SEP} ${COL_DUR} ${SEP} ${COL_LINES}"

# Add rate limits if present
if [ -n "$RATE_STR" ]; then
  COL_CONTENT="${COL_CONTENT} ${SEP} ${C_COST}⚡${RESET} ${RATE_STR}"
fi

# Add prompt cache hit ratio if present
if [ -n "$CACHE_STR" ]; then
  COL_CONTENT="${COL_CONTENT} ${SEP} ${DIM}${CACHE_STR}${RESET}"
fi

COL_CONTENT="${COL_CONTENT} "

# ── Render ───────────────────────────────────────────────────────────────────
echo -e "${COL_CONTENT}"
