#!/usr/bin/env node
// Read unread messages across rooms.
// Usage: node chat-read.js --name <agent> --project <path> [--rooms general,dev] [--limit 20] [--json] [--compact]

import { getDb, upsertAgent, getUnreadMessages, getMaxMessageId, updateCursor, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { formatMessage, formatRoomHeader, formatNoMessages, parseMetadata } from '../lib/format.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const rooms = (getFlag('rooms') || 'general').split(',').map(r => r.trim());
const limit = parseInt(getFlag('limit') || '50', 10);
const jsonOut = args.includes('--json');
const compact = args.includes('--compact');
const quiet = args.includes('--quiet');

try {
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms, setOnline: false });

  const result = { rooms: {}, total_unread: 0 };

  // Wrap read+cursor-advance in a single transaction to prevent messages
  // slipping between read and cursor update (atomicity bug fix)
  const db = getDb();
  const readAllRooms = db.transaction(() => {
    for (const room of rooms) {
      initCursorIfNew(identity.name, identity.projectPath, room);
      const messages = getUnreadMessages(identity.name, identity.projectPath, room, limit);

      // Always advance cursor to max message ID (including own messages) to prevent re-triggering
      const maxId = getMaxMessageId(room);
      if (maxId > 0) {
        updateCursor(identity.name, identity.projectPath, room, maxId);
      }

      if (messages.length > 0) {
        result.rooms[room] = messages;
        result.total_unread += messages.length;
      }
    }
  });
  readAllRooms();

  if (jsonOut) {
    // Structured JSON with [reply to] prefix for backwards compat
    const jsonResult = { rooms: {}, total_unread: result.total_unread };
    for (const [room, msgs] of Object.entries(result.rooms)) {
      jsonResult.rooms[room] = msgs.map(m => {
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
    }
    if (jsonResult.total_unread === 0) {
      console.log(JSON.stringify({ rooms: {}, total_unread: 0, listening: rooms }));
    } else {
      console.log(JSON.stringify(jsonResult, null, 2));
    }
  } else {
    if (result.total_unread === 0) {
      if (!quiet) console.log(formatNoMessages(rooms));
    } else {
      for (const [room, msgs] of Object.entries(result.rooms)) {
        console.log(formatRoomHeader(room, msgs.length));
        for (const m of msgs) {
          console.log(formatMessage(m, { compact }));
        }
      }
      console.log(`\nTotal: ${result.total_unread} unread`);
    }
  }
} finally {
  closeDb();
}
