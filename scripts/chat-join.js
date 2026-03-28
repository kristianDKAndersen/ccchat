#!/usr/bin/env node
// Join a room.
// Usage: node chat-join.js --name <agent> --project <path> --room <room>

import { joinRoom, getAgentRooms, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const room = getFlag('room');
const jsonOut = args.includes('--json');

if (!room) {
  console.error('Usage: node chat-join.js --room <room> [--name agent] [--project path] [--json]');
  process.exit(1);
}

try {
  const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });

  joinRoom(identity.name, identity.projectPath, room);

  const rooms = getAgentRooms(identity.name, identity.projectPath);

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, agent: identity.name, joined: room, rooms }));
  } else {
    console.log(`${identity.name} joined [${room}]. Now in: ${rooms.join(', ')}`);
  }
} finally {
  closeDb();
}
