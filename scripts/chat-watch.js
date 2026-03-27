#!/usr/bin/env node
// Long-polling watcher: blocks until new messages arrive, then exits with message data.
// Designed for Claude Code's run_in_background — zero token cost while idle.
// Usage: node chat-watch.js --name <agent> [--rooms general,dev] [--timeout 300]

import { watch, statSync } from 'fs';
import { upsertAgent, getUnreadMessages, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { sentinelPath, sentinelDir, touchSentinel } from '../lib/sentinel.js';
import { parseMetadata } from '../lib/format.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const rooms = (getFlag('rooms') || 'general').split(',').map(r => r.trim());
const timeout = parseInt(getFlag('timeout') || '300', 10) * 1000;

// Register agent and init cursors (read-only — don't force online)
upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms, setOnline: false });
for (const room of rooms) {
  initCursorIfNew(identity.name, identity.projectPath, room);
}

// Ensure sentinel file exists for fs.watch
sentinelDir();
touchSentinel(identity.projectHash, identity.name);
const spath = sentinelPath(identity.projectHash, identity.name);

function checkUnread() {
  const result = { rooms: {}, total_unread: 0, listening: rooms };
  for (const room of rooms) {
    const messages = getUnreadMessages(identity.name, identity.projectPath, room, 50);
    if (messages.length > 0) {
      result.rooms[room] = messages.map(m => {
        const meta = parseMetadata(m.metadata);
        return {
          id: m.id,
          type: m.type,
          from: m.from_agent,
          content: m.parent_id ? `[reply to #${m.parent_id}] ${m.content}` : m.content,
          parent_id: m.parent_id,
          priority: meta.priority,
          mentions: meta.mentions,
          created_at: m.created_at,
        };
      });
      result.total_unread += messages.length;
    }
  }
  return result;
}

function exitWith(result) {
  cleanup();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// --- Cleanup ---
let watcher = null;
let fallbackInterval = null;
let timeoutTimer = null;
let exiting = false;

function cleanup() {
  if (exiting) return;
  exiting = true;
  if (watcher) { try { watcher.close(); } catch {} }
  if (fallbackInterval) clearInterval(fallbackInterval);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  closeDb();
}

// --- Check for already-unread messages before watching ---
const initial = checkUnread();
if (initial.total_unread > 0) {
  exitWith(initial);
}

// --- Trigger handler (deduplicated) ---
let checking = false;
function onTrigger() {
  if (exiting || checking) return;
  checking = true;
  try {
    const result = checkUnread();
    if (result.total_unread > 0) {
      exitWith(result);
    }
  } finally {
    checking = false;
  }
}

// --- fs.watch on sentinel file ---
try {
  watcher = watch(spath, (eventType) => {
    // Both 'change' (mtime update) and 'rename' (file recreated) mean activity
    if (eventType === 'rename') {
      // Sentinel was deleted and recreated — re-establish after brief delay
      setTimeout(() => {
        touchSentinel(identity.projectHash, identity.name);
        try {
          watcher.close();
          watcher = watch(spath, () => onTrigger());
        } catch {
          // fs.watch re-establishment failed; fallback interval still active
        }
      }, 100);
    }
    onTrigger();
  });
} catch (err) {
  // fs.watch unavailable — rely on fallback interval at faster rate
  process.stderr.write(`chat-watch: fs.watch failed (${err.code || err.message}), using interval polling\n`);
}

// --- Fallback DB poll (covers missed fs.watch events) ---
const FALLBACK_MS = watcher ? 30000 : 5000; // faster if no watcher
fallbackInterval = setInterval(onTrigger, FALLBACK_MS);

// --- Timeout ---
timeoutTimer = setTimeout(() => {
  cleanup();
  console.log(JSON.stringify({ rooms: {}, total_unread: 0, listening: rooms }));
  process.exit(0);
}, timeout);

// --- Signal handlers ---
function onSignal() {
  cleanup();
  process.exit(0);
}
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
