#!/usr/bin/env bash
# Spawn an on-demand Claude agent in another project via ccchat.
#
# Usage:
#   spawn-agent.sh --project ~/dev/devtest/maestro --question "How should I structure auth?"
#   spawn-agent.sh --project ~/dev/devtest/maestro --question "Help me bootstrap" --open
#
# Flow:
#   1. Resolve caller identity (from --name/--project or cwd)
#   2. Check if target agent is already online
#   3. Send the question to ccchat (queued for when agent reads)
#   4. If agent is offline: print the command to start it (or open terminal with --open)

set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Parse flags ---
PROJECT=""
QUESTION=""
NAME=""
ROOM="general"
# Default to --open on macOS
if [[ "$(uname)" == "Darwin" ]]; then
  OPEN=true
else
  OPEN=false
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)  PROJECT="$2"; shift 2 ;;
    --question) QUESTION="$2"; shift 2 ;;
    --name)     NAME="$2"; shift 2 ;;
    --room)     ROOM="$2"; shift 2 ;;
    --open)     OPEN=true; shift ;;
    --no-open)  OPEN=false; shift ;;
    -h|--help)
      echo "Usage: spawn-agent.sh --project <dir> --question \"<msg>\" [--name <caller>] [--room <room>] [--open]"
      echo ""
      echo "  --project   Target project directory (required)"
      echo "  --question  Question to send via ccchat (required)"
      echo "  --name      Caller agent name (default: current dir basename)"
      echo "  --room      Chat room (default: general)"
      echo "  --open      Open a new terminal tab via osascript (macOS only)"
      exit 0
      ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  echo "Error: --project is required" >&2
  exit 1
fi

if [[ -z "$QUESTION" ]]; then
  echo "Error: --question is required" >&2
  exit 1
fi

# Resolve target project directory
PROJECT="$(cd "$PROJECT" 2>/dev/null && pwd)" || {
  echo "Error: project directory does not exist: $PROJECT" >&2
  exit 1
}

TARGET_AGENT="$(basename "$PROJECT")"

# Resolve caller name (fall back to cwd basename)
CALLER="${NAME:-$(basename "$(pwd)")}"

# --- Step 1: Check if target agent is already online ---
ONLINE=$(node "$SCRIPTS_DIR/status.js" --raw 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const match = d.online_agents.find(a => a.name === '$TARGET_AGENT');
  console.log(match ? 'yes' : 'no');
" 2>/dev/null || echo "no")

# --- Step 2: Send the question via ccchat (always, so it's queued) ---
node "$SCRIPTS_DIR/chat-send.js" \
  --name "$CALLER" \
  --room "$ROOM" \
  --type question \
  --message "$QUESTION"

MSG_ID=$(node "$SCRIPTS_DIR/chat-history.js" --room "$ROOM" --last 1 --json 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d.messages?.[0]?.id || '?');
" 2>/dev/null || echo "?")

echo "Sent question #${MSG_ID} to [$ROOM] as $CALLER"

# --- Step 3: If online, we're done. If offline, help the user start the agent ---
if [[ "$ONLINE" == "yes" ]]; then
  echo "$TARGET_AGENT is already online — they'll see your message."
  exit 0
fi

echo "$TARGET_AGENT is offline."

LAUNCH_CMD="cd $PROJECT && claude /ccchat"

if [[ "$OPEN" == true ]]; then
  # Attempt osascript (macOS only) — use separate -e flags to avoid quote mangling
  if command -v osascript &>/dev/null; then
    osascript \
      -e "tell application \"Terminal\"" \
      -e "activate" \
      -e "do script \"$LAUNCH_CMD\"" \
      -e "end tell" 2>/dev/null && {
      echo "Opened new Terminal tab for $TARGET_AGENT."
      exit 0
    }
    echo "Warning: osascript failed. Print command instead." >&2
  else
    echo "Warning: osascript not available (not macOS?). Print command instead." >&2
  fi
fi

echo ""
echo "Run this in a new terminal to bring $TARGET_AGENT online:"
echo ""
echo "  $LAUNCH_CMD"
echo ""
