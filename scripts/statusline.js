#!/usr/bin/env node
// ccchat statusline — context window bar + auto-compact signal.
// Registered via setup.js as statusLine.command in .claude/settings.json.
// Receives JSON session data on stdin from Claude Code after every turn.
//
// Behaviour:
//   - Always renders a compact context bar in the status line
//   - When used_percentage >= THRESHOLD, writes a one-time signal file so
//     compact-nudge.js (UserPromptSubmit hook) can warn the agent

import { readFileSync, writeFileSync, existsSync } from 'fs';

const THRESHOLD = 60; // % at which to trigger the nudge

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  process.exit(0);
}

const pct       = Math.round(input?.context_window?.used_percentage ?? 0);
const sessionId = input?.session_id ?? 'unknown';

// Write signal file once when threshold is crossed
if (pct >= THRESHOLD) {
  const signalPath = `/tmp/ccchat-compact-${sessionId}`;
  if (!existsSync(signalPath)) {
    try {
      writeFileSync(signalPath, JSON.stringify({
        session_id:      sessionId,
        used_percentage: pct,
        triggered_at:    new Date().toISOString(),
      }));
    } catch { /* best-effort — never crash the status bar */ }
  }
}

// Render
const icon = pct >= 80 ? '🔴' : pct >= THRESHOLD ? '🟡' : '🟢';
console.log(`${icon} ctx ${bar(pct)} ${pct}%`);

function bar(pct, width = 10) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
