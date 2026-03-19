#!/usr/bin/env node
// Stop hook — block if there are unread messages.
// Reads DB directly, no server needed.

import { upsertAgent, getUnreadCountAllRooms, getUnreadMessages, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { parseMetadata } from '../lib/format.js';

async function main() {
  // Read stdin for hook input
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());

  const identity = resolveIdentity({ project: input.cwd });

  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: identity.rooms, setOnline: false });
  for (const room of identity.rooms) {
    initCursorIfNew(identity.name, identity.projectPath, room);
  }

  const counts = getUnreadCountAllRooms(identity.name, identity.projectPath);
  let total = 0;
  for (const c of counts.values()) total += c;

  if (total > 0) {
    // Block on urgent messages or @mentions — regular messages get surfaced by the poll hook
    const lines = [];
    let shouldBlock = false;

    for (const [room] of counts) {
      const messages = getUnreadMessages(identity.name, identity.projectPath, room, 5);
      const filtered = messages.filter(m => m.from_agent !== identity.name);
      if (filtered.length === 0) continue;

      for (const m of filtered) {
        const meta = parseMetadata(m.metadata);
        const isUrgent = meta.priority === 'urgent';
        const mentionsMe = meta.mentions.includes(identity.name);
        if (isUrgent || mentionsMe) {
          shouldBlock = true;
          const tags = [];
          if (isUrgent) tags.push('URGENT');
          if (mentionsMe) tags.push('@you');
          lines.push(`  [${room}] ${m.from_agent} (${tags.join(', ')}): ${m.content.slice(0, 120)}`);
        }
      }
    }

    if (shouldBlock) {
      lines.unshift(`CCCHAT: Urgent / mentioned`);
      lines.push('  Use ccchat skill to read and respond.');
      console.log(JSON.stringify({ decision: 'block', reason: lines.join('\n') }));
    }
    // Regular messages: don't block — the poll hook will show them on next prompt
  }
}

main().catch(e => { process.stderr.write(`ccchat stop hook error: ${e.message}\n`); }).finally(() => closeDb());
