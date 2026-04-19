#!/usr/bin/env node
// Long-polling watcher: blocks until new messages arrive, then exits with message data.
// Designed for Claude Code's run_in_background — zero token cost while idle.
//
// --persist: Self-respawn after notifications with exponential backoff on rapid failures.
//            Still exits on timeout (prevents zombie processes).
//
// Usage: node chat-watch.js --name <agent> [--room general] [--timeout 300] [--persist]

import { watch, statSync } from 'fs';
import { upsertAgent, getUnreadMessages, initCursorIfNew, getCrossRoomSignals, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { sentinelPath, sentinelDir, touchSentinel } from '../lib/sentinel.js';
import { parseMetadata } from '../lib/format.js';

import { args, getFlag } from '../lib/args.js';

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const room = getFlag('room') || identity.currentRoom || 'lobby';
const timeout = parseInt(getFlag('timeout') || '300', 10) * 1000;
const persist = args.includes('--persist');

// --- Self-respawn state (--persist mode) ---
const MAX_RESTARTS = 20;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30000;
let restartCount = 0;
let lastNotifyTime = 0;
let lastNotifiedMaxId = 0;

function getMaxIdFromResult(result) {
  return result.messages.reduce((m, msg) => Math.max(m, msg.id), 0);
}

function runWatchCycle() {
  // chat-watch running = agent is actively listening. setOnline:true makes
  // presence strong: the daemon heartbeats every cycle (5 min default) and
  // keeps the agent online even when their Claude session is idle between
  // user prompts. SessionEnd's leave hook is responsible for flipping offline.
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, currentRoom: room, setOnline: true });
  initCursorIfNew(identity.name, identity.projectPath, room);

  // Ensure sentinel file exists for fs.watch
  sentinelDir();
  touchSentinel(identity.projectHash, identity.name);
  const spath = sentinelPath(identity.projectHash, identity.name);

  function checkUnread() {
    const messages = getUnreadMessages(identity.name, identity.projectPath, room, 50).map(m => {
      const meta = parseMetadata(m.metadata);
      return { id: m.id, type: m.type, from: m.from_agent,
        content: m.parent_id ? `[reply to #${m.parent_id}] ${m.content}` : m.content,
        parent_id: m.parent_id, priority: meta.priority, mentions: meta.mentions, created_at: m.created_at };
    });
    return { room, messages, total_unread: messages.length, listening: room };
  }

  function notifyAndMaybeRespawn(result) {
    cleanup();
    lastNotifiedMaxId = getMaxIdFromResult(result);
    console.log(JSON.stringify(result, null, 2));

    if (!persist) {
      // Loud respawn directive: SKILL.md tells Claude to respawn, but the
      // skill instructions are read at skill-load time — by the time this
      // watcher exits, Claude has likely moved on. Putting the directive
      // directly in this process's exit output makes it unmissable at the
      // exact moment respawn has to happen. Echo back the EXACT argv so the
      // per-agent --name flag is preserved on respawn.
      const respawnCmd = 'node ' + process.argv.slice(1).join(' ');
      console.log('\n==== CCCHAT WATCHER EXITED — RESPAWN REQUIRED ====');
      console.log('After processing the messages above, you MUST respawn the');
      console.log('watcher or you will go blind to new ccchat messages:');
      console.log('  Bash(command="' + respawnCmd + '", run_in_background=true)');
      console.log('====================================================');
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
    if (persist) {
      // Silent respawn on timeout — keep the watcher alive without emitting a no-op
      // notification that would wake the agent. Reset restart counter since timeout
      // means we ran a full cycle without crashing.
      restartCount = 0;
      setTimeout(() => runWatchCycle(), 0);
      return;
    }
    console.log(JSON.stringify({ room, messages: [], total_unread: 0, listening: room }));
    // Same loud respawn directive on timeout — even with no messages, the
    // watcher MUST be respawned or real-time notification dies silently.
    const respawnCmd = 'node ' + process.argv.slice(1).join(' ');
    console.log('\n==== CCCHAT WATCHER EXITED (timeout) — RESPAWN REQUIRED ====');
    console.log('No messages arrived this cycle, but you MUST respawn the');
    console.log('watcher or you will go blind to new ccchat messages:');
    console.log('  Bash(command="' + respawnCmd + '", run_in_background=true)');
    console.log('=============================================================');
    process.exit(0);
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
    if (getMaxIdFromResult(initial) > lastNotifiedMaxId) {
      notifyAndMaybeRespawn(initial);
      return;
    }
  }

  // --- Trigger handler (deduplicated) ---
  let checking = false;
  function onTrigger() {
    if (cycleExiting || checking) return;
    checking = true;
    try {
      const result = checkUnread();
      if (result.total_unread > 0 && getMaxIdFromResult(result) > lastNotifiedMaxId) {
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
