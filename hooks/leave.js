#!/usr/bin/env node
// SessionEnd hook — mark agent offline, optionally save handoff note.
// Also usable standalone: node leave.js --handoff "Was working on X"

import { setAgentOffline, setHandoffNote, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

try {
  const identity = resolveIdentity();
  const handoff = getFlag('handoff');
  if (handoff) {
    setHandoffNote(identity.name, identity.projectPath, handoff);
  }
  setAgentOffline(identity.name, identity.projectPath);
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
