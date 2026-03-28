#!/usr/bin/env node
// Long-polling watcher: blocks until new messages arrive, then exits with message data.
// Designed for Claude Code's run_in_background — zero token cost while idle.
//
// --persist: Self-respawn after notifications with exponential backoff on rapid failures.
//            Still exits on timeout (prevents zombie processes).
//
// Usage: node chat-watch.js --name <agent> [--rooms general,dev] [--timeout 300] [--persist]

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
const persist = args.includes('--persist');

// --- Self-respawn state (--persist mode) ---
const MAX_RESTARTS = 20;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30000;
let restartCount = 0;
let lastNotifyTime = 0;

function runWatchCycle() {
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

  function notifyAndMaybeRespawn(result) {
    cleanup();
    console.log(JSON.stringify(result, null, 2));

    if (!persist) {
      process.exit(0);
    }

    // Self-respawn: check backoff
    const now = Date.now();
    const sinceLastNotify = now - lastNotifyTime;
    lastNotifyTime = now;

    // Reset restart count if last notification was >60s ago (stable operation)
    if (sinceLastNotify > 60000) {
      restartCount = 0;
    } else {
      restartCount++;
    }

    if (restartCount >= MAX_RESTARTS) {
      process.stderr.write(`chat-watch: max restarts (${MAX_RESTARTS}) reached — exiting. Possible tight loop.\n`);
      process.exit(1);
    }

    // Exponential backoff on rapid restarts
    const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, restartCount), MAX_BACKOFF_MS);
    if (restartCount > 0) {
      process.stderr.write(`chat-watch: respawning in ${backoff}ms (restart #${restartCount})\n`);
    }

    setTimeout(() => runWatchCycle(), backoff);
  }

  function exitOnTimeout() {
    cleanup();
    console.log(JSON.stringify({ rooms: {}, total_unread: 0, listening: rooms }));
    process.exit(0); // Always exit on timeout, even in persist mode
  }

  // --- Cleanup ---
  let fsWatcher = null;
  let fallbackInterval = null;
  let timeoutTimer = null;
  let cycleExiting = false;

  function cleanup() {
    if (cycleExiting) return;
    cycleExiting = true;
    if (fsWatcher) { try { fsWatcher.close(); } catch {} }
    if (fallbackInterval) clearInterval(fallbackInterval);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  // --- Check for already-unread messages before watching ---
  const initial = checkUnread();
  if (initial.total_unread > 0) {
    notifyAndMaybeRespawn(initial);
    return;
  }

  // --- Trigger handler (deduplicated) ---
  let checking = false;
  function onTrigger() {
    if (cycleExiting || checking) return;
    checking = true;
    try {
      const result = checkUnread();
      if (result.total_unread > 0) {
        notifyAndMaybeRespawn(result);
      }
    } finally {
      checking = false;
    }
  }

  // --- fs.watch on sentinel file ---
  try {
    fsWatcher = watch(spath, (eventType) => {
      if (eventType === 'rename') {
        setTimeout(() => {
          touchSentinel(identity.projectHash, identity.name);
          try {
            fsWatcher.close();
            fsWatcher = watch(spath, () => onTrigger());
          } catch {
            // fs.watch re-establishment failed; fallback interval still active
          }
        }, 100);
      }
      onTrigger();
    });
  } catch (err) {
    process.stderr.write(`chat-watch: fs.watch failed (${err.code || err.message}), using interval polling\n`);
  }

  // --- Fallback DB poll (covers missed fs.watch events) ---
  const FALLBACK_MS = fsWatcher ? 30000 : 5000;
  fallbackInterval = setInterval(onTrigger, FALLBACK_MS);

  // --- Timeout ---
  timeoutTimer = setTimeout(exitOnTimeout, timeout);
}

// --- Start first cycle ---
runWatchCycle();

// --- Signal handlers ---
function onSignal() {
  closeDb();
  process.exit(0);
}
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
