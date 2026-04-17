#!/usr/bin/env node
// UserPromptSubmit hook — show unread banner on stderr.
// Reads DB directly, no server needed.

import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { upsertAgent, getUnreadCountAllRooms, getUnreadMessages, initCursorIfNew, getDb, projectHash, closeDb, getStaleUnansweredQuestions } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { parseMetadata } from '../lib/format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Start dashboard server if not already running, then open in browser (macOS)
function spawnDashboard() {
  try {
    execSync('pgrep -f "chat-dashboard.js"', { stdio: 'ignore' });
    return; // already running
  } catch {
    // not running — start server + open browser
  }
  try {
    const dashboardPath = join(__dirname, '..', 'scripts', 'chat-dashboard.js');
    // Start dashboard server as detached background process
    const child = spawn('node', [dashboardPath, '--port', '3000', '--name', 'human'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Give server a moment to bind, then open in default browser
    setTimeout(() => {
      try {
        spawn('open', ['http://localhost:3000'], { detached: true, stdio: 'ignore' }).unref();
      } catch {
        // Not macOS or open unavailable — silently skip
      }
    }, 1000);
  } catch {
    // Failed to start — silently skip
  }
}

const DROPOFF_LOG = join(homedir(), '.claude', 'ccchat', 'dropoff-log.json');
const DROPOFF_DEBOUNCE_MS = 5 * 60 * 1000; // 5 min debounce per agent+room
const DROPOFF_AGE_THRESHOLD_MS = 2 * 60 * 1000; // 2 min before flagging

function logDropoff(identity, counts, hasQuestion, hasMention) {
  const d = getDb();
  const hash = projectHash(identity.projectPath);

  // Check agent's last_seen — if active in last 2 min, not a drop
  const agent = d.prepare('SELECT last_seen FROM agents WHERE name = ? AND project_hash = ?').get(identity.name, hash);
  if (agent && agent.last_seen) {
    const lastSeen = new Date(agent.last_seen + 'Z').getTime();
    if (Date.now() - lastSeen < DROPOFF_AGE_THRESHOLD_MS) return;
  }

  // Debounce: check recent log entries for this agent
  let recentEntries = [];
  if (existsSync(DROPOFF_LOG)) {
    try {
      const content = readFileSync(DROPOFF_LOG, 'utf8').trim();
      if (content) recentEntries = content.split('\n').slice(-50).map(l => JSON.parse(l));
    } catch { /* corrupt file — continue */ }
  }

  const now = Date.now();
  for (const [room, count] of counts) {
    // Debounce: skip if we logged this agent+room in last 5 min
    const recent = recentEntries.find(e =>
      e.agent === identity.name && e.room === room &&
      (now - new Date(e.timestamp).getTime()) < DROPOFF_DEBOUNCE_MS
    );
    if (recent) continue;

    const entry = {
      agent: identity.name,
      room,
      unread_count: count,
      has_questions: hasQuestion,
      has_mentions: hasMention,
      timestamp: new Date().toISOString()
    };
    appendFileSync(DROPOFF_LOG, JSON.stringify(entry) + '\n');
  }
}

try {
  const identity = resolveIdentity();

  // UserPromptSubmit bumps last_seen via the setOnline:false path so hook
  // activity keeps the heartbeat fresh. DO NOT promote to online=1: that would
  // override /leavechat's intentional offline state. The SessionStart hook
  // (start.js) already spawns chat-watch with setOnline:true, which handles
  // recovery for cascade-killed agents on new sessions.
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: identity.rooms, setOnline: false });
  for (const room of identity.rooms) {
    initCursorIfNew(identity.name, identity.projectPath, room);
  }

  const counts = getUnreadCountAllRooms(identity.name, identity.projectPath);
  let total = 0;
  for (const c of counts.values()) total += c;

  if (total > 0) {
    const lines = [`CCCHAT: ${total} new message${total !== 1 ? 's' : ''}`];
    let hasQuestion = false;
    let hasUrgentOrMention = false;
    let hasOtherMessages = false;

    for (const [room, count] of counts) {
      const messages = getUnreadMessages(identity.name, identity.projectPath, room, 5);
      // Filter out own messages
      const filtered = messages.filter(m => m.from_agent !== identity.name);
      if (filtered.length === 0) continue;
      hasOtherMessages = true;
      const last = filtered[filtered.length - 1];
      const meta = parseMetadata(last.metadata);
      const parts = [];
      if (last.type === 'question') { parts.push('QUESTION'); hasQuestion = true; }
      if (meta.priority === 'urgent') { parts.push('URGENT'); hasUrgentOrMention = true; }
      if (meta.mentions.includes(identity.name)) { parts.push('@you'); hasUrgentOrMention = true; }
      const tag = parts.length ? ` (${parts.join(', ')})` : '';
      lines.push(`  [${room}] ${last.from_agent}${tag}: ${last.content.slice(0, 120)}`);
    }

    if (!hasOtherMessages) {
      // Only own messages unread — no banner, no dashboard
    } else {
      spawnDashboard();
      if (hasQuestion || hasUrgentOrMention) {
        lines.push('  ⚠ BLOCKING: You MUST call Skill(skill="ccchat") NOW to read and respond. Do NOT reply in your terminal.');
      } else {
        lines.push('  → Call Skill(skill="ccchat") to read and respond.');
      }
      if (total >= 3) {
        const firstRoom = [...counts.keys()][0];
        lines.push(`  → Digest: node ${join(__dirname, '..', 'scripts', 'chat-digest.js')} --room ${firstRoom}`);
      }
      console.error(lines.join('\n'));

      // Drop-off tracking: log when questions/@mentions go unread and agent is idle
      if (hasQuestion || hasUrgentOrMention) {
        try {
          logDropoff(identity, counts, hasQuestion, hasUrgentOrMention);
        } catch { /* tracking must never fail the hook */ }
      }
    }
  }
  // Open Questions auto-promotion: flag stale unanswered questions
  const staleQs = [];
  for (const room of identity.rooms) {
    const qs = getStaleUnansweredQuestions(room, 15);
    for (const q of qs) staleQs.push(`  [${room}] #${q.id} ${q.from_agent}: ${q.content.slice(0, 120)}`);
  }
  if (staleQs.length > 0) {
    staleQs.unshift(`CCCHAT OPEN QUESTIONS: ${staleQs.length} unanswered question${staleQs.length !== 1 ? 's' : ''} (>15 min):`);
    console.error(staleQs.join('\n'));
  }
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
