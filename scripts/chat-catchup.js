#!/usr/bin/env node
// Session bootstrap — get oriented quickly with unread, handoff notes, and recent history.
// Usage: node chat-catchup.js --name <agent> --project <path> [--room room] [--budget 30] [--json] [--compact]

import { getDb, upsertAgent, getUnreadMessages, getMaxMessageId, getRecentMessages, getHandoffNotes, getPinnedMessages, updateCursor, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { formatMessage, formatRoomHeader, parseMetadata } from '../lib/format.js';

import { args, getFlag } from '../lib/args.js';

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const room = getFlag('room') || identity.currentRoom || 'lobby';
const budget = parseInt(getFlag('budget') || '30', 10);
const jsonOut = args.includes('--json');
const compact = args.includes('--compact');

try {
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, currentRoom: room, setOnline: false });

  const result = { handoff_notes: [], pinned: {}, unread: {}, backfill: {}, total_unread: 0, total_pinned: 0, total_backfill: 0 };

  // Section 1: Handoff notes from all agents (48h TTL enforced by DB layer)
  const handoffs = getHandoffNotes();
  for (const h of handoffs) {
    result.handoff_notes.push({
      from: h.name,
      project: h.project_path,
      note: h.handoff_notes,
      at: h.handoff_at,
    });
  }

  // Section 2: Pinned messages (context)
  const pinned = getPinnedMessages(room);
  if (pinned.length > 0) {
    result.pinned[room] = pinned;
    result.total_pinned += pinned.length;
  }

  // Section 3: Unread messages (most actionable)
  // Wrap read+cursor-advance in transaction to prevent messages slipping through
  const db = getDb();
  const readUnread = db.transaction(() => {
    initCursorIfNew(identity.name, identity.projectPath, room);
    const messages = getUnreadMessages(identity.name, identity.projectPath, room, budget);

    if (messages.length > 0) {
      result.unread[room] = messages;
      result.total_unread += messages.length;
    }

    // Advance cursor
    const maxId = getMaxMessageId(room);
    if (maxId > 0) {
      updateCursor(identity.name, identity.projectPath, room, maxId);
    }
  });
  readUnread();

  // Section 4: History backfill (background context)
  // Cap at 10 messages, skip entirely if unread >= 30
  const backfillCap = result.total_unread >= 30 ? 0 : Math.min(10, Math.max(0, 30 - result.total_unread));
  if (backfillCap > 0) {
    const unreadIds = new Set((result.unread[room] || []).map(m => m.id));
    const recent = getRecentMessages(room, backfillCap, 1); // sinceHours=1
    const backfill = recent.filter(m => !unreadIds.has(m.id));

    if (backfill.length > 0) {
      result.backfill[room] = backfill;
      result.total_backfill += backfill.length;
    }
  }

  // Output
  if (jsonOut) {
    const jsonResult = {
      handoff_notes: result.handoff_notes,
      pinned: {},
      unread: {},
      backfill: {},
      total_pinned: result.total_pinned,
      total_unread: result.total_unread,
      total_backfill: result.total_backfill,
    };
    for (const [r, msgs] of Object.entries(result.pinned)) {
      jsonResult.pinned[r] = msgs.map(m => {
        const meta = parseMetadata(m.metadata);
        return {
          id: m.id, type: m.type, from: m.from_agent,
          content: m.content, parent_id: m.parent_id,
          priority: meta.priority, mentions: meta.mentions,
          pinned: true, created_at: m.created_at,
        };
      });
    }
    for (const [r, msgs] of Object.entries(result.unread)) {
      jsonResult.unread[r] = msgs.map(m => {
        const meta = parseMetadata(m.metadata);
        return {
          id: m.id, type: m.type, from: m.from_agent,
          content: m.parent_id ? `[reply to #${m.parent_id}] ${m.content}` : m.content,
          parent_id: m.parent_id, priority: meta.priority, mentions: meta.mentions,
          created_at: m.created_at,
        };
      });
    }
    for (const [r, msgs] of Object.entries(result.backfill)) {
      jsonResult.backfill[r] = msgs.map(m => {
        const meta = parseMetadata(m.metadata);
        return {
          id: m.id, type: m.type, from: m.from_agent,
          content: m.parent_id ? `[reply to #${m.parent_id}] ${m.content}` : m.content,
          parent_id: m.parent_id, priority: meta.priority, mentions: meta.mentions,
          created_at: m.created_at,
        };
      });
    }
    console.log(JSON.stringify(jsonResult, null, 2));
  } else {
    // Handoff notes
    if (result.handoff_notes.length > 0) {
      console.log('=== Handoff Notes ===');
      for (const h of result.handoff_notes) {
        const time = (h.at || '').slice(11, 16);
        console.log(`  ${h.from} (${time}): ${h.note}`);
      }
      console.log('');
    }

    // Pinned
    if (result.total_pinned > 0) {
      console.log('=== Pinned Messages ===');
      for (const [r, msgs] of Object.entries(result.pinned)) {
        console.log(`[${r}] ${msgs.length} pinned:`);
        for (const m of msgs) {
          console.log(formatMessage(m, { compact: true }));
        }
      }
      console.log('');
    }

    // Unread
    if (result.total_unread > 0) {
      console.log('=== Unread Messages ===');
      for (const [r, msgs] of Object.entries(result.unread)) {
        console.log(formatRoomHeader(r, msgs.length));
        for (const m of msgs) {
          console.log(formatMessage(m, { compact }));
        }
      }
      console.log('');
    }

    // Backfill
    if (result.total_backfill > 0) {
      console.log('=== Recent History ===');
      for (const [r, msgs] of Object.entries(result.backfill)) {
        console.log(`[${r}] ${msgs.length} recent message${msgs.length !== 1 ? 's' : ''}:`);
        for (const m of msgs) {
          console.log(formatMessage(m, { compact: true }));
        }
      }
      console.log('');
    }

    if (result.total_unread === 0 && result.total_backfill === 0 && result.total_pinned === 0 && result.handoff_notes.length === 0) {
      console.log('No unread messages, handoff notes, or recent history.');
    } else {
      const parts = [];
      if (result.total_unread > 0) parts.push(`${result.total_unread} unread`);
      if (result.total_pinned > 0) parts.push(`${result.total_pinned} pinned`);
      if (result.total_backfill > 0) parts.push(`${result.total_backfill} backfill`);
      if (result.handoff_notes.length > 0) parts.push(`${result.handoff_notes.length} handoff note${result.handoff_notes.length !== 1 ? 's' : ''}`);
      console.log(`Catchup: ${parts.join(', ')}. Listening in: ${room}`);
    }
  }
} finally {
  closeDb();
}
