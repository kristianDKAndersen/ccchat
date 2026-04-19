#!/usr/bin/env node
// Consensus status — aggregate /agree and /disagree signals by topic.
// Usage: node chat-consensus.js [--room general] [--topic <name>] [--json]

import { getConsensusMessages, closeDb } from '../lib/db.js';
import { args, getFlag } from '../lib/args.js';
import { resolveIdentity } from '../lib/identity.js';

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const room = getFlag('room') || identity.currentRoom || 'lobby';
const topic = getFlag('topic') || null;
const jsonOut = args.includes('--json');

try {
  const messages = getConsensusMessages(room, topic);

  // Group by topic, then by signal
  const topics = new Map(); // topic -> { agrees: [], disagrees: [] }
  for (const m of messages) {
    let meta;
    try { meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : (m.metadata || {}); } catch { meta = {}; }
    const t = meta.topic || '(no topic)';
    if (!topics.has(t)) topics.set(t, { agrees: [], disagrees: [] });
    const entry = { id: m.id, from: m.from_agent, rationale: meta.rationale || null, created_at: m.created_at };
    if (meta.consensus_signal === 'agree') topics.get(t).agrees.push(entry);
    else if (meta.consensus_signal === 'disagree') topics.get(t).disagrees.push(entry);
  }

  if (jsonOut) {
    const result = [];
    for (const [t, { agrees, disagrees }] of topics) {
      const resolved = disagrees.length === 0;
      result.push({ topic: t, agrees, disagrees, resolved });
    }
    console.log(JSON.stringify({ room, topics: result }, null, 2));
    process.exit(0);
  }

  if (topics.size === 0) {
    console.log(`No consensus signals in [${room}]${topic ? ` for topic "${topic}"` : ''}.`);
    process.exit(0);
  }

  const lines = [`Consensus status [${room}]:`];
  lines.push('');

  for (const [t, { agrees, disagrees }] of topics) {
    const resolved = disagrees.length === 0 && agrees.length > 0;
    const contested = disagrees.length > 0;
    const status = resolved ? '✅ RESOLVED' : contested ? '⚠ CONTESTED' : '○ pending';
    lines.push(`${status} — ${t}`);
    lines.push(`  Agrees (${agrees.length}):`);
    if (agrees.length === 0) {
      lines.push('    (none)');
    } else {
      for (const a of agrees) {
        const r = a.rationale ? ` — ${a.rationale.slice(0, 80)}` : '';
        lines.push(`    #${a.id} ${a.from}${r}`);
      }
    }
    lines.push(`  Disagrees (${disagrees.length}):`);
    if (disagrees.length === 0) {
      lines.push('    (none)');
    } else {
      for (const d of disagrees) {
        const r = d.rationale ? ` — ${d.rationale.slice(0, 80)}` : '';
        lines.push(`    #${d.id} ${d.from}${r}`);
      }
    }
    lines.push('');
  }

  console.log(lines.join('\n'));
} finally {
  closeDb();
}
