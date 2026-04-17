#!/usr/bin/env node
// Human Digest — structured snapshot of the room for quick human review.
// Format: ⚡ ACTION NEEDED / ✅ DECISIONS MADE / ❓ OPEN QUESTIONS / ▼ DETAILS
//
// Usage: node chat-digest.js [--room general] [--since-hours 24] [--json]

import { getPinnedMessages, getStaleUnansweredQuestions, getRecentMessages, closeDb } from '../lib/db.js';
import { parseMetadata } from '../lib/format.js';
import { args, getFlag } from '../lib/args.js';

const room = getFlag('room') || 'general';
const sinceHours = parseInt(getFlag('since-hours') || '24', 10);
const jsonOut = args.includes('--json');

try {
  const recent = getRecentMessages(room, 200, sinceHours);

  // ⚡ ACTION NEEDED: urgent messages or DMs to human
  const actionNeeded = recent.filter(m => {
    const meta = parseMetadata(m.metadata);
    const mentionsHuman = meta.mentions.includes('human');
    const dmToHuman = m.to_agent && m.to_agent.toLowerCase() === 'human';
    const isUrgent = meta.priority === 'urgent';
    return isUrgent || mentionsHuman || dmToHuman;
  });

  // ✅ DECISIONS MADE: pinned messages (proxy for confirmed decisions)
  const pinned = getPinnedMessages(room);

  // ❓ OPEN QUESTIONS: stale unanswered questions
  const staleQs = getStaleUnansweredQuestions(room, 15);

  if (jsonOut) {
    console.log(JSON.stringify({
      room,
      since_hours: sinceHours,
      action_needed: actionNeeded.map(m => ({
        id: m.id, from: m.from_agent, content: m.content, created_at: m.created_at,
        priority: parseMetadata(m.metadata).priority,
      })),
      decisions_made: pinned.map(m => ({
        id: m.id, from: m.from_agent, content: m.content.slice(0, 200), created_at: m.created_at,
      })),
      open_questions: staleQs.map(m => ({
        id: m.id, from: m.from_agent, content: m.content, created_at: m.created_at,
      })),
    }, null, 2));
    process.exit(0);
  }

  const lines = [];
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`╔═ ccchat DIGEST [${room}] @ ${ts} ═╗`);
  lines.push('');

  // ⚡ ACTION NEEDED
  lines.push(`⚡ ACTION NEEDED (${actionNeeded.length})`);
  if (actionNeeded.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of actionNeeded) {
      const meta = parseMetadata(m.metadata);
      const tags = [];
      if (meta.priority === 'urgent') tags.push('URGENT');
      if (m.to_agent?.toLowerCase() === 'human') tags.push('DM');
      if (meta.mentions.includes('human')) tags.push('@you');
      const tagStr = tags.length ? ` [${tags.join(', ')}]` : '';
      lines.push(`  #${m.id}${tagStr} ${m.from_agent}: ${m.content.slice(0, 120)}`);
    }
  }

  lines.push('');

  // ✅ DECISIONS MADE
  lines.push(`✅ DECISIONS MADE (${pinned.length})`);
  if (pinned.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of pinned) {
      lines.push(`  #${m.id} ${m.from_agent}: ${m.content.slice(0, 120)}`);
    }
  }

  lines.push('');

  // ❓ OPEN QUESTIONS
  lines.push(`❓ OPEN QUESTIONS (${staleQs.length} unanswered >15 min)`);
  if (staleQs.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of staleQs) {
      lines.push(`  #${m.id} ${m.from_agent} (${m.created_at.slice(11, 16)}): ${m.content.slice(0, 120)}`);
    }
  }

  lines.push('');

  // ▼ DETAILS
  lines.push(`▼ DETAILS: ${recent.length} message${recent.length !== 1 ? 's' : ''} in last ${sinceHours}h — run 'node chat-history.js --room ${room}' to read all`);

  console.log(lines.join('\n'));
} finally {
  closeDb();
}
