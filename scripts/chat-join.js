#!/usr/bin/env node
// Join a room.
// Usage: node chat-join.js --name <agent> --project <path> --room <room>

import { joinRoom, getAgentRooms, closeDb } from '../lib/db.js';
import { resolveIdentity, updateIdentityFile } from '../lib/identity.js';

import { args, getFlag } from '../lib/args.js';

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
  updateIdentityFile(identity.projectPath, { rooms });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, agent: identity.name, joined: room, rooms }));
  } else {
    console.log(`${identity.name} joined [${room}]. Now in: ${rooms.join(', ')}`);
  }
} finally {
  closeDb();
}
