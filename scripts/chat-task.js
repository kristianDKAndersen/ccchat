#!/usr/bin/env node
// Create or update task messages. Tasks are regular messages with task metadata.
// Usage:
//   node chat-task.js --name <agent> --project <path> --message "Do X" --room general [--assign bob] [--urgent]
//   node chat-task.js --update <id> --status done|open|in-progress|blocked [--evidence "proof"]

import { upsertAgent, insertMessage, getMessage, getDb, initCursorIfNew, updateCursor, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { formatSendConfirm, parseMentions, parseMetadata } from '../lib/format.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const updateId = getFlag('update');
const jsonOut = args.includes('--json');

try {
  if (updateId) {
    // Update task status
    const id = parseInt(updateId, 10);
    const status = getFlag('status');
    const evidence = getFlag('evidence');

    if (!status) {
      console.error('Usage: node chat-task.js --update <id> --status done|open|in-progress|blocked [--evidence "proof"]');
      process.exit(1);
    }

    const validStatuses = ['open', 'in-progress', 'done', 'blocked'];
    if (!validStatuses.includes(status)) {
      console.error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
      process.exit(1);
    }

    const msg = getMessage(id);
    if (!msg) {
      console.error(`Message #${id} not found`);
      process.exit(1);
    }

    const meta = parseMetadata(msg.metadata);
    meta.task_status = status;
    if (evidence) meta.evidence = evidence;

    const d = getDb();
    d.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), id);

    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, id, status, evidence: evidence || null }));
    } else {
      const evidenceNote = evidence ? ` (evidence: ${evidence})` : '';
      console.log(`Task #${id} → ${status}${evidenceNote}`);
    }
  } else {
    // Create new task
    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
    const room = getFlag('room') || 'general';
    const message = getFlag('message');
    const assign = getFlag('assign');
    const urgent = args.includes('--urgent');

    if (!message) {
      console.error('Usage: node chat-task.js --message "task description" [--name agent] [--project path] [--room room] [--assign agent] [--urgent]');
      process.exit(1);
    }

    const mentions = parseMentions(message);
    if (assign && !mentions.includes(assign.toLowerCase())) {
      mentions.push(assign.toLowerCase());
    }
    const priority = urgent ? 'urgent' : 'normal';
    const metadata = { mentions, priority, task_status: 'open', assigned: assign || null };

    upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: [room] });
    initCursorIfNew(identity.name, identity.projectPath, room);

    const result = insertMessage({
      type: 'task',
      fromAgent: identity.name,
      fromProject: identity.projectPath,
      room,
      content: message,
      metadata,
    });

    updateCursor(identity.name, identity.projectPath, room, Number(result.id));

    if (jsonOut) {
      console.log(JSON.stringify({ ok: true, id: Number(result.id), from: identity.name, room, task_status: 'open', assigned: assign || null, mentions, priority }));
    } else {
      console.log(formatSendConfirm(Number(result.id), room) + ' (task)');
    }
  }
} finally {
  closeDb();
}
