#!/usr/bin/env node
// Show online agents and rooms.
// Usage: node status.js [--raw] [--prune]

import { getOnlineAgents, getDb, closeDb } from '../lib/db.js';

const raw = process.argv.includes('--raw');
const prune = process.argv.includes('--prune');

try {
  if (prune) {
    const d = getDb();
    const result = d.prepare("UPDATE agents SET online = 0 WHERE online = 1").run();
    console.log(`Marked ${result.changes} agent(s) offline.`);
  }

  const agents = getOnlineAgents();

  if (raw) {
    console.log(JSON.stringify({
      online_agents: agents.map(a => ({
        name: a.name,
        project_path: a.project_path,
        rooms: JSON.parse(a.rooms || '["general"]'),
        online: !!a.online,
        last_seen: a.last_seen,
      })),
    }, null, 2));
  } else {
    if (agents.length === 0) {
      console.log('No agents online.');
    } else {
      console.log(`Online agents (${agents.length}):\n`);
      for (const a of agents) {
        const rooms = JSON.parse(a.rooms || '["general"]').join(', ');
        console.log(`  ${a.name} — ${a.project_path} [${rooms}] (last seen: ${a.last_seen})`);
      }
    }
  }
} finally {
  closeDb();
}
