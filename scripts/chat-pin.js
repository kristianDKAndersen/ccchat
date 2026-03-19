#!/usr/bin/env node
// Pin or unpin a message, or list pinned messages.
// Usage:
//   node chat-pin.js --pin <id>                    # pin a message
//   node chat-pin.js --unpin <id>                  # unpin a message
//   node chat-pin.js --room general [--json]       # list pinned messages

import { pinMessage, unpinMessage, getPinnedMessages, getMessage, closeDb } from '../lib/db.js';
import { formatMessage, parseMetadata } from '../lib/format.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const pinId = getFlag('pin');
const unpinId = getFlag('unpin');
const room = getFlag('room') || 'general';
const jsonOut = args.includes('--json');

try {
  if (pinId) {
    const id = parseInt(pinId, 10);
    const msg = getMessage(id);
    if (!msg) {
      console.error(`Message #${id} not found`);
      process.exit(1);
    }
    pinMessage(id);
    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, action: 'pin', id }));
    } else {
      console.log(`Pinned #${id}`);
    }
  } else if (unpinId) {
    const id = parseInt(unpinId, 10);
    unpinMessage(id);
    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, action: 'unpin', id }));
    } else {
      console.log(`Unpinned #${id}`);
    }
  } else {
    // List pinned messages
    const pinned = getPinnedMessages(room);
    if (jsonOut) {
      const formatted = pinned.map(m => {
        const meta = parseMetadata(m.metadata);
        return {
          id: m.id, type: m.type, from: m.from_agent,
          content: m.content, parent_id: m.parent_id,
          priority: meta.priority, mentions: meta.mentions,
          created_at: m.created_at,
        };
      });
      console.log(JSON.stringify({ room, pinned: formatted }, null, 2));
    } else {
      if (pinned.length === 0) {
        console.log(`No pinned messages in [${room}]`);
      } else {
        console.log(`[${room}] ${pinned.length} pinned message${pinned.length !== 1 ? 's' : ''}:`);
        for (const m of pinned) {
          console.log(formatMessage(m));
        }
      }
    }
  }
} finally {
  closeDb();
}
