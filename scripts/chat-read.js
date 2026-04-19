#!/usr/bin/env node
// Read unread messages in current room.
// Usage: node chat-read.js --name <agent> --project <path> [--room room] [--limit 20] [--json] [--compact]

import { getDb, upsertAgent, getUnreadMessages, getMaxMessageId, updateCursor, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { formatMessage, formatRoomHeader, formatNoMessages, parseMetadata } from '../lib/format.js';

import { args, getFlag } from '../lib/args.js';

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const room = getFlag('room') || identity.currentRoom || 'lobby';
const limit = parseInt(getFlag('limit') || '50', 10);
const jsonOut = args.includes('--json');
const compact = args.includes('--compact');
const quiet = args.includes('--quiet');

try {
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, currentRoom: identity.currentRoom, setOnline: false });

  const db = getDb();
  let messages = [];
  let totalUnread = 0;

  // Wrap read+cursor-advance in a single transaction to prevent messages
  // slipping between read and cursor update (atomicity bug fix)
  const readRoom = db.transaction(() => {
    initCursorIfNew(identity.name, identity.projectPath, room);
    messages = getUnreadMessages(identity.name, identity.projectPath, room, limit);

    // Always advance cursor to max message ID (including own messages) to prevent re-triggering
    const maxId = getMaxMessageId(room);
    if (maxId > 0) {
      updateCursor(identity.name, identity.projectPath, room, maxId);
    }

    totalUnread = messages.length;
  });
  readRoom();

  if (jsonOut) {
    if (totalUnread === 0) {
      console.log(JSON.stringify({ room, messages: [], total_unread: 0 }));
    } else {
      const formatted = messages.map(m => {
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
      console.log(JSON.stringify({ room, messages: formatted, total_unread: totalUnread }, null, 2));
    }
  } else {
    if (totalUnread === 0) {
      if (!quiet) console.log(formatNoMessages([room]));
    } else {
      console.log(formatRoomHeader(room, totalUnread));
      for (const m of messages) {
        console.log(formatMessage(m, { compact }));
      }
      console.log(`\nTotal: ${totalUnread} unread`);
    }
  }
} finally {
  closeDb();
}
