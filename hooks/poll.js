#!/usr/bin/env node
// UserPromptSubmit hook — show unread banner on stderr.
// Reads DB directly, no server needed.

import { upsertAgent, getUnreadCountAllRooms, getUnreadMessages, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { parseMetadata } from '../lib/format.js';

try {
  const identity = resolveIdentity();

  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: identity.rooms, setOnline: false });
  for (const room of identity.rooms) {
    initCursorIfNew(identity.name, identity.projectPath, room);
  }

  const counts = getUnreadCountAllRooms(identity.name, identity.projectPath);
  let total = 0;
  for (const c of counts.values()) total += c;

  if (total > 0) {
    const lines = [`CCCHAT: ${total} new message${total !== 1 ? 's' : ''}`];
    let hasQuestion = false;

    let hasUrgentOrMention = false;

    for (const [room, count] of counts) {
      const messages = getUnreadMessages(identity.name, identity.projectPath, room, 5);
      // Filter out own messages
      const filtered = messages.filter(m => m.from_agent !== identity.name);
      if (filtered.length === 0) continue;
      const last = filtered[filtered.length - 1];
      const meta = parseMetadata(last.metadata);
      const parts = [];
      if (last.type === 'question') { parts.push('QUESTION'); hasQuestion = true; }
      if (meta.priority === 'urgent') { parts.push('URGENT'); hasUrgentOrMention = true; }
      if (meta.mentions.includes(identity.name)) { parts.push('@you'); hasUrgentOrMention = true; }
      const tag = parts.length ? ` (${parts.join(', ')})` : '';
      lines.push(`  [${room}] ${last.from_agent}${tag}: ${last.content.slice(0, 120)}`);
    }

    if (hasQuestion || hasUrgentOrMention) {
      lines.push('  Use ccchat skill to read and respond.');
    }
    console.error(lines.join('\n'));
  }
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
