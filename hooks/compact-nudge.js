#!/usr/bin/env node
// UserPromptSubmit hook — one-time context warning when compact signal is present.
const THRESHOLD = 60;
// Fires on every prompt but only injects context once per session (nudgedPath guard).
// Registered by setup.js alongside the existing poll.js UserPromptSubmit hook.

import { readFileSync, existsSync, writeFileSync } from 'fs';

let input = {};
try {
  const stdin = readFileSync(0, 'utf-8').trim();
  if (stdin) input = JSON.parse(stdin);
} catch { /* hook must never crash */ }

const sessionId  = input.session_id ?? 'unknown';
const signalPath = `/tmp/ccchat-compact-${sessionId}`;
const nudgedPath = `/tmp/ccchat-nudged-${sessionId}`;

// Already nudged this session — stay silent
if (existsSync(nudgedPath)) process.exit(0);

// No signal yet — context still fine
if (!existsSync(signalPath)) process.exit(0);

// Read threshold percentage from signal
let pct = THRESHOLD;
try {
  const sig = JSON.parse(readFileSync(signalPath, 'utf-8'));
  pct = sig.used_percentage ?? pct;
} catch {}

// Mark nudged so this fires exactly once per session
try { writeFileSync(nudgedPath, '1'); } catch {}

// Inject warning into Claude's context via additionalContext
const warning =
  `⚠️  ccchat: context window is at ${pct}%. ` +
  `When you reach a natural pause point, run /compact. ` +
  `Your ccchat state (rooms, cursors, open tasks) will be saved automatically ` +
  `by the PostCompact hook and restored next session via chat-catchup.`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName:     'UserPromptSubmit',
    additionalContext: warning,
  },
}));


