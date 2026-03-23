#!/usr/bin/env node
// Send a message to a room.
// Usage: node chat-send.js --name <agent> --project <path> --room <room> --message "<text>" [--to <agent>] [--type message|question]

import { upsertAgent, insertMessage, initCursorIfNew, updateCursor, getMessage, getOnlineAgents, projectHash, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { formatSendConfirm, parseMentions } from '../lib/format.js';
import { touchSentinel } from '../lib/sentinel.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const room = getFlag('room') || 'general';
const message = getFlag('message');
const toAgent = getFlag('to');
const type = getFlag('type') || 'message';
const replyTo = getFlag('reply-to');
const parentId = replyTo ? parseInt(replyTo, 10) : undefined;
const urgent = args.includes('--urgent');
const evidence = getFlag('evidence');
const jsonOut = args.includes('--json');

if (!message) {
  console.error('Usage: node chat-send.js --message "<text>" [--name agent] [--project path] [--room room] [--to agent] [--type message|question] [--reply-to <id>] [--urgent]');
  process.exit(1);
}

try {
  const mentions = parseMentions(message);
  const priority = urgent ? 'urgent' : 'normal';
  const metadata = { mentions, priority };
  if (evidence) metadata.evidence = evidence;

  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: [room] });
  initCursorIfNew(identity.name, identity.projectPath, room);
  const result = insertMessage({
    type,
    fromAgent: identity.name,
    fromProject: identity.projectPath,
    toAgent,
    room,
    content: message,
    metadata,
    parentId,
  });
  // Advance cursor past own message so hooks don't false-trigger
  updateCursor(identity.name, identity.projectPath, room, Number(result.id));

  // Touch sentinel files for fast-path notification
  try {
    if (parentId) {
      // Reply: touch only the parent message author's sentinel
      const parent = getMessage(parentId);
      if (parent && parent.from_agent !== identity.name) {
        touchSentinel(projectHash(parent.from_project), parent.from_agent);
      }
    } else {
      // Broadcast (or DM): touch sentinels for target agents
      const agents = getOnlineAgents();
      for (const a of agents) {
        if (a.name === identity.name && a.project_hash === projectHash(identity.projectPath)) continue;
        if (toAgent && a.name !== toAgent) continue;
        const rooms = JSON.parse(a.rooms || '[]');
        if (!toAgent && !rooms.includes(room)) continue;
        touchSentinel(a.project_hash, a.name);
      }
    }
  } catch {
    // Sentinel touching is best-effort
  }

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, id: Number(result.id), from: identity.name, room, type, parent_id: parentId || null, mentions, priority }));
  } else {
    console.log(formatSendConfirm(Number(result.id), room));
  }
} finally {
  closeDb();
}
