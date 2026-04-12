#!/usr/bin/env node
// SessionEnd hook — mark agent offline, optionally save handoff note.
// Also usable standalone: node leave.js --handoff "Was working on X"

import { execSync } from 'child_process';
import { setAgentOffline, setHandoffNote, releaseAgentTasks, insertMessage, getDb, projectHash, closeDb } from '../lib/db.js';
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
  // Release any in_progress plan tasks owned by this agent
  try {
    const released = releaseAgentTasks(identity.name);
    for (const task of released) {
      insertMessage({
        type: 'system',
        fromAgent: identity.name,
        fromProject: identity.projectPath,
        room: task.room,
        content: `${identity.name} left — released task #${task.id}: ${task.title} back to pending (plan #${task.plan_id})`,
      });
    }
  } catch {
    // Best-effort — tables may not exist yet
  }

  setAgentOffline(identity.name, identity.projectPath);

  // Mark offline ALL agents for this project_hash — not just the resolved name.
  // Prevents ghost agents: if a project previously registered under a different name
  // (e.g., "maestro" then "d-kristian"), stale names would linger as online.
  const d = getDb();
  const hash = projectHash(identity.projectPath);
  try {
    d.prepare("UPDATE agents SET online = 0, last_seen = datetime('now') WHERE project_hash = ? AND online = 1")
      .run(hash);
  } catch {
    // Best-effort
  }

  // Also mark offline any other project registrations for this agent name.
  // An agent may have registered from multiple projects (e.g., via cross-project chat).
  try {
    d.prepare("UPDATE agents SET online = 0, last_seen = datetime('now') WHERE name = ? AND online = 1")
      .run(identity.name);
  } catch {
    // Best-effort
  }

  // Kill dashboard server if no agents remain online
  try {
    const remaining = d.prepare('SELECT COUNT(*) as n FROM agents WHERE online = 1').get();
    if (remaining.n === 0) {
      execSync('pkill -f "chat-dashboard.js" 2>/dev/null', { stdio: 'ignore' });
    }
  } catch {
    // Best-effort — pgrep/pkill may not find anything
  }
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
