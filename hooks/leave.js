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
  const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
  const handoff = getFlag('handoff');
  if (handoff) {
    setHandoffNote(identity.name, identity.projectPath, handoff);
  }
  setAgentOffline(identity.name, identity.projectPath);

  // Also mark offline any other project registrations for this agent name.
  // An agent may have registered from multiple projects (e.g., via cross-project chat).
  try {
    const d = (await import('../lib/db.js')).getDb();
    d.prepare("UPDATE agents SET online = 0, last_seen = datetime('now') WHERE name = ? AND online = 1")
      .run(identity.name);
  } catch {
    // Best-effort
  }
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
