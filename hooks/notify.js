#!/usr/bin/env node
// PostToolUse hook — show urgent/@mention banner between tool calls.
// Lightweight, non-blocking. Rate-limits repeated banners per message_id.

import { getDb, projectHash, getMaxMessageId, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { parseMetadata } from '../lib/format.js';
import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SUPPRESS_SECONDS = 30;

function getRateLimitPath(name, hash) {
  return join(tmpdir(), `ccchat-notify-${name}-${hash}.json`);
}

function loadRateLimit(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function saveRateLimit(path, data) {
  try { writeFileSync(path, JSON.stringify(data)); } catch { /* best effort */ }
}

try {
  const identity = resolveIdentity();
  const hash = projectHash(identity.projectPath);
  const d = getDb();

  // Fast path: check if any room has new messages beyond our read cursor
  const agent = d.prepare('SELECT rooms FROM agents WHERE name = ? AND project_hash = ?').get(identity.name, hash);
  if (!agent) { closeDb(); process.exit(0); }

  let rooms;
  try { rooms = JSON.parse(agent.rooms); } catch { rooms = ['general']; }

  const cursorStmt = d.prepare('SELECT last_id FROM read_cursors WHERE agent_name = ? AND project_hash = ? AND room = ?');
  const msgStmt = d.prepare(`
    SELECT * FROM messages
    WHERE room = ? AND id > ? AND from_agent != ?
    ORDER BY id ASC
    LIMIT 10
  `);

  const now = Date.now();
  const rlPath = getRateLimitPath(identity.name, hash);
  const rateLimit = loadRateLimit(rlPath);
  let rlChanged = false;

  // Prune expired entries
  for (const [id, ts] of Object.entries(rateLimit)) {
    if (now - ts > SUPPRESS_SECONDS * 1000) {
      delete rateLimit[id];
      rlChanged = true;
    }
  }

  const alerts = [];

  for (const room of rooms) {
    const cursor = cursorStmt.get(identity.name, hash, room);
    const lastId = cursor ? cursor.last_id : 0;

    // Fast path: skip room if no new messages at all
    const maxId = getMaxMessageId(room);
    if (maxId <= lastId) continue;

    const messages = msgStmt.all(room, lastId, identity.name);
    for (const m of messages) {
      const meta = parseMetadata(m.metadata);
      const isUrgent = meta.priority === 'urgent';
      const mentionsMe = meta.mentions.includes(identity.name);

      if (!isUrgent && !mentionsMe) continue;

      // Rate limit: skip if already shown within SUPPRESS_SECONDS
      const key = String(m.id);
      if (rateLimit[key]) continue;

      rateLimit[key] = now;
      rlChanged = true;

      const tags = [];
      if (isUrgent) tags.push('URGENT');
      if (mentionsMe) tags.push('@you');
      alerts.push(`  [${room}] ${m.from_agent} (${tags.join(', ')}): ${m.content.slice(0, 120)}`);
    }
  }

  if (rlChanged) saveRateLimit(rlPath, rateLimit);

  if (alerts.length > 0) {
    alerts.unshift('CCCHAT: Urgent / mentioned');
    alerts.push('  Use ccchat skill to read and respond.');
    console.error(alerts.join('\n'));
  }
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
