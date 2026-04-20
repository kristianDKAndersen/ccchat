#!/usr/bin/env node
// SessionEnd hook — mark agent offline, optionally save handoff note.
// Also usable standalone: node leave.js --handoff "Was working on X"

import { execSync } from 'child_process';
import { setAgentOffline, setHandoffNote, releaseAgentTasks, insertMessage, getDb, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';

import { getFlag } from '../lib/args.js';

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

  // Kill the --persist presence daemon for this exact agent+project.
  // Without this, the daemon keeps heartbeating and re-asserts online=1
  // after leave.js marks it offline. Exact match (name + projectPath) —
  // safe for concurrent runs with the same agent name in different projects.
  try {
    const daemonNeedle = `chat-watch.js --name ${identity.name} --project ${identity.projectPath}`;
    execSync(`pkill -f ${JSON.stringify(daemonNeedle)}`, { stdio: 'ignore' });
  } catch { /* none running */ }

  // Kill dashboard server if no agents remain online
  try {
    const d = getDb();
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
