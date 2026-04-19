#!/usr/bin/env node
// Leave the current room (returns to lobby).
// Usage: node chat-leave.js [--name agent] [--project path] [--json]

import { leaveCurrentRoom, projectHash, closeDb } from '../lib/db.js';
import { resolveIdentity, updateIdentityFile } from '../lib/identity.js';
import { removeSentinel } from '../lib/sentinel.js';

import { args, getFlag } from '../lib/args.js';

const jsonOut = args.includes('--json');

try {
  const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });

  const result = leaveCurrentRoom(identity.name, identity.projectPath);

  if (result.alreadyInLobby) {
    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, agent: identity.name, alreadyInLobby: true }));
    } else {
      console.log('Already in lobby.');
    }
    process.exit(0);
  }

  updateIdentityFile(identity.projectPath, { currentRoom: 'lobby' });

  // Sentinel cleanup for the room we left
  if (result.hash) {
    removeSentinel(result.hash, identity.name);
  } else {
    removeSentinel(projectHash(identity.projectPath), identity.name);
  }

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, agent: identity.name, left: result.room, currentRoom: 'lobby' }));
  } else {
    console.log(`${identity.name} left [${result.room}]. Current room: lobby`);
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
