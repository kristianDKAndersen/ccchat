#!/usr/bin/env node
// PostToolUse hook — show urgent/@mention banner between tool calls.
// Lightweight, non-blocking. Rate-limits repeated banners per message_id.

import { getDb, projectHash, getMaxMessageId, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { parseMetadata } from '../lib/format.js';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  const tmp = path + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
  } catch { /* best effort */ }
}

try {
  const identity = resolveIdentity();
  const hash = projectHash(identity.projectPath);
  const d = getDb();

  // Fast path: check if any room has new messages beyond our read cursor
  const agent = d.prepare('SELECT rooms FROM agents WHERE name = ? AND project_hash = ?').get(identity.name, hash);
  if (!agent) { closeDb(); process.exit(0); }

  let rooms;
  try { rooms = JSON.parse(agent.rooms); } catch { rooms = ['lobby']; }

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
      const isQuestion = m.type === 'question';

      if (!isUrgent && !mentionsMe && !isQuestion) continue;

      // Rate limit: skip if already shown within SUPPRESS_SECONDS
      const key = String(m.id);
      if (rateLimit[key]) continue;

      rateLimit[key] = now;
      rlChanged = true;

      const tags = [];
      if (isUrgent) tags.push('URGENT');
      if (mentionsMe) tags.push('@you');
      if (isQuestion) tags.push('QUESTION');
      alerts.push(`  [${room}] ${m.from_agent} (${tags.join(', ')}): ${m.content.slice(0, 120)}`);
    }
  }

  if (rlChanged) saveRateLimit(rlPath, rateLimit);

  if (alerts.length > 0) {
    alerts.unshift('CCCHAT: Needs response — you MUST call Skill(skill="ccchat") NOW');
    alerts.push('  ⚠ BLOCKING: Call Skill(skill="ccchat") to read and respond. Do NOT reply in your terminal.');
    console.error(alerts.join('\n'));
  }

  // [DECISION] auto-capture: scan recent messages and log any not yet in decisions.md
  try {
    const canonicalProject = dirname(__dirname);
    const decisionsPath = join(canonicalProject, 'docs', 'decisions.md');
    const loggedIds = new Set();
    if (existsSync(decisionsPath)) {
      const content = readFileSync(decisionsPath, 'utf8');
      for (const m of content.matchAll(/^session_id:\s*(\d+)/gm)) loggedIds.add(m[1]);
    }
    const recent = d.prepare(
      "SELECT * FROM messages WHERE created_at > datetime('now', '-24 hours') AND content LIKE '%[DECISION]%' ORDER BY id ASC LIMIT 20"
    ).all();
    if (recent.length > 0) {
      const { adrLogDecision } = await import(join(__dirname, '..', 'scripts', 'adr-logger.js'));
      for (const msg of recent) {
        if (!loggedIds.has(String(msg.id))) {
          adrLogDecision(
            { content: msg.content, id: msg.id, created_at: msg.created_at, from_agent: msg.from_agent },
            canonicalProject,
            msg.room
          );
        }
      }
    }
  } catch { /* ADR auto-capture is best-effort */ }
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
