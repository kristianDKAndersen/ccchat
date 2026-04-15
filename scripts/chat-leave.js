#!/usr/bin/env node
// Leave a room.
// Usage: node chat-leave.js --name <agent> --project <path> --room <room>

import { leaveRoom, getAgentRooms, closeDb } from '../lib/db.js';
import { resolveIdentity, updateIdentityFile } from '../lib/identity.js';
import { removeSentinel } from '../lib/sentinel.js';

import { args, getFlag } from '../lib/args.js';

const room = getFlag('room');
const jsonOut = args.includes('--json');

if (!room) {
  console.error('Usage: node chat-leave.js --room <room> [--name agent] [--project path] [--json]');
  process.exit(1);
}

try {
  const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });

  const result = leaveRoom(identity.name, identity.projectPath, room);

  // Atomic sentinel cleanup
  if (result) {
    removeSentinel(result.hash, identity.name);
  }

  const rooms = getAgentRooms(identity.name, identity.projectPath);
  updateIdentityFile(identity.projectPath, { rooms });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, agent: identity.name, left: room, rooms }));
  } else {
    console.log(`${identity.name} left [${room}]. Now in: ${rooms.join(', ')}`);
  }
} catch (e) {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  } else {
    console.error(`Error: ${e.message}`);
  }
  process.exit(1);
} finally {
  closeDb();
}
