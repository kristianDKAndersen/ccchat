#!/usr/bin/env node
// Browse past messages (read-only, no cursor changes).
// Usage: node chat-history.js --room <room> [--last <N>] [--before <id>] [--json]

import { getHistory, closeDb } from '../lib/db.js';
import { formatMessage, formatHistoryHeader, formatHistoryFooter, parseMetadata } from '../lib/format.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const room = getFlag('room') || 'general';
const last = parseInt(getFlag('last') || '20', 10);
const beforeRaw = getFlag('before');
const beforeId = beforeRaw ? parseInt(beforeRaw, 10) : null;
const jsonOut = args.includes('--json');

try {
  const { messages, has_more } = getHistory(room, last, beforeId);

  if (jsonOut) {
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
    console.log(JSON.stringify({ room, messages: formatted, has_more }, null, 2));
  } else {
    if (messages.length === 0) {
      console.log(`No messages in [${room}]`);
    } else {
      console.log(formatHistoryHeader(room, messages[0].id, messages[messages.length - 1].id));
      for (const m of messages) {
        console.log(formatMessage(m));
      }
      console.log(formatHistoryFooter(has_more, messages[0].id));
    }
  }
} finally {
  closeDb();
}
