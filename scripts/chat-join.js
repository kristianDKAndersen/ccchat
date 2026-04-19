#!/usr/bin/env node
// Join a room (switches current room to the specified room).
// Usage: node chat-join.js --room <room> [--create] [--name agent] [--project path] [--json]

import { setCurrentRoom, upsertAgent, createRoom, closeDb } from '../lib/db.js';
import { resolveIdentity, updateIdentityFile } from '../lib/identity.js';

import { args, getFlag } from '../lib/args.js';

const room = getFlag('room');
const jsonOut = args.includes('--json');
const createIfMissing = args.includes('--create');

if (!room) {
  console.error('Usage: node chat-join.js --room <room> [--create] [--name agent] [--project path] [--json]');
  process.exit(1);
}

try {
  const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });

  upsertAgent({ name: identity.name, projectPath: identity.projectPath, currentRoom: identity.currentRoom || 'lobby' });
  if (createIfMissing) {
    createRoom(identity.name, identity.projectPath, room);
  }
  setCurrentRoom(identity.name, identity.projectPath, room);
  updateIdentityFile(identity.projectPath, { currentRoom: room });

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, agent: identity.name, joined: room, currentRoom: room }));
  } else {
    console.log(`${identity.name} joined [${room}].`);
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
