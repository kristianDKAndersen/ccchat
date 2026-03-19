#!/usr/bin/env node
// BeforeAgent hook for Gemini CLI — output unread banner to stdout.
// Gemini CLI surfaces stdout from hooks into the model's context.

import { upsertAgent, getUnreadCountAllRooms, getUnreadMessages, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';

try {
  const identity = resolveIdentity();

  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: identity.rooms });
  for (const room of identity.rooms) {
    initCursorIfNew(identity.name, identity.projectPath, room);
  }

  const counts = getUnreadCountAllRooms(identity.name, identity.projectPath);
  let total = 0;
  for (const c of counts.values()) total += c;

  if (total > 0) {
    const lines = [`CCCHAT: ${total} new message${total !== 1 ? 's' : ''}`];
    let hasQuestion = false;

    for (const [room, count] of counts) {
      const messages = getUnreadMessages(identity.name, identity.projectPath, room, 5);
      const filtered = messages.filter(m => m.from_agent !== identity.name);
      if (filtered.length === 0) continue;
      const last = filtered[filtered.length - 1];
      const tag = last.type === 'question' ? ' (QUESTION)' : '';
      if (last.type === 'question') hasQuestion = true;
      lines.push(`  [${room}] ${last.from_agent}${tag}: ${last.content.slice(0, 120)}`);
    }

    if (hasQuestion) {
      lines.push('  Run: node scripts/chat-read.js --name "gemini" --rooms "general" to read and respond.');
    }

    // Gemini CLI: stdout from hooks gets injected into model context
    console.log(lines.join('\n'));
  }
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
