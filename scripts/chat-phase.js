#!/usr/bin/env node
// Phase state CLI — set and query the discussion phase for a room.
// Usage:
//   node chat-phase.js --room <room> --set <phase> --by <agent> [--notes <text>]
//   node chat-phase.js --room <room> --get
//   node chat-phase.js --room <room> --log [--limit 20]
//   node chat-phase.js --room <room> --set <phase> --by <agent> --json

import { setPhase, getPhase, getPhaseHistory, closeDb } from '../lib/db.js';
import { args, getFlag } from '../lib/args.js';
import { resolveIdentity } from '../lib/identity.js';

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const room = getFlag('room') || identity.currentRoom || 'lobby';
const setFlag = getFlag('set');
const byAgent = getFlag('by');
const notesFlag = getFlag('notes');
const logFlag = args.includes('--log');
const showCurrent = args.includes('--get');
const limit = parseInt(getFlag('limit') || '20', 10);
const jsonOut = args.includes('--json');

const VALID_PHASE_NAMES = ['brainstorm', 'draft', 'spec', 'execute', 'peer_review', 'review', 'done', 'hold', 'cancelled'];

if (!setFlag && !logFlag && !showCurrent) {
  console.error('Usage: node chat-phase.js --room <room> [--set <phase> --by <agent>] [--get] [--log]');
  process.exit(1);
}

try {
  if (setFlag) {
    if (!byAgent) {
      console.error('Error: --set requires --by <agent>');
      process.exit(1);
    }
    const normalizedPhase = setFlag.toLowerCase();
    if (!VALID_PHASE_NAMES.includes(normalizedPhase)) {
      console.error(`Error: Unknown phase '${setFlag}'. Valid phases: ${VALID_PHASE_NAMES.join(', ')}`);
      process.exit(1);
    }
    setPhase(room, normalizedPhase, byAgent, notesFlag || null);
    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, room, phase: normalizedPhase, set_by: byAgent }));
    } else {
      console.log(`Phase set: [${room}] → ${normalizedPhase} (by ${byAgent})`);
    }
  } else if (showCurrent) {
    const current = getPhase(room);
    if (jsonOut) {
      console.log(JSON.stringify(current || { room, phase: null }));
    } else if (!current) {
      console.log(`[${room}] No phase set`);
    } else {
      const notes = current.notes ? ` — ${current.notes}` : '';
      console.log(`[${room}] Current phase: ${current.phase} (set by ${current.set_by} at ${current.set_at.slice(0, 16)})${notes}`);
    }
  } else if (logFlag) {
    const history = getPhaseHistory(room, limit);
    if (jsonOut) {
      console.log(JSON.stringify({ room, history }));
    } else if (history.length === 0) {
      console.log(`[${room}] No phase history`);
    } else {
      console.log(`[${room}] Phase history (${history.length}):`);
      for (const h of history) {
        const notes = h.notes ? ` — ${h.notes}` : '';
        console.log(`  ${h.set_at.slice(0, 16)} ${h.phase.padEnd(16)} by ${h.set_by}${notes}`);
      }
    }
  }
} finally {
  closeDb();
}
