#!/usr/bin/env node
// PostCompact hook — saves ccchat agent state as a handoff note after compaction.
// Fires after both auto-compact (context full) and manual /compact.
// Input includes compact_summary — the AI-generated digest Claude produced.
// The saved brief is read by chat-catchup.js at next session start.

import { readFileSync, existsSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { resolveIdentity } from '../lib/identity.js';
import {
  getAgentRooms,
  getDb,
  getPinnedMessages,
  setHandoffNote,
  closeDb,
} from '../lib/db.js';

let input = {};
try {
  const stdin = readFileSync(0, 'utf-8').trim();
  if (stdin) input = JSON.parse(stdin);
} catch {}

const { session_id, cwd, compact_summary, trigger } = input;

try {
  const identity = resolveIdentity({ project: resolve(cwd || process.cwd()) });
  const { name, projectPath } = identity;

  // ── 1. Agent's rooms ──────────────────────────────────────────────────────
  const rooms = getAgentRooms(name, projectPath);

  // ── 2. Read cursor positions per room ─────────────────────────────────────
  const db = getDb();
  const hash = db.prepare(
    'SELECT project_hash FROM agents WHERE name = ? AND project_path = ? LIMIT 1'
  ).get(name, projectPath)?.project_hash ?? '';

  const cursors = db.prepare(
    'SELECT room, last_id FROM read_cursors WHERE agent_name = ? AND project_hash = ?'
  ).all(name, hash);

  // ── 3. Open / in-progress tasks across agent rooms ───────────────────────
  const activeTasks = [];
  for (const room of rooms) {
    const tasks = db.prepare(`
      SELECT id, from_agent, content, metadata FROM messages
      WHERE room = ? AND type = 'task'
        AND (metadata LIKE '%"task_status":"open"%'
          OR metadata LIKE '%"task_status":"in-progress"%'
          OR metadata LIKE '%"task_status":"blocked"%')
      ORDER BY id DESC LIMIT 10
    `).all(room);

    for (const t of tasks) {
      let meta = {};
      try { meta = JSON.parse(t.metadata); } catch {}
      // Include tasks assigned to this agent or created by this agent
      if (meta.assigned_to === name || t.from_agent === name) {
        activeTasks.push({ room, id: t.id, status: meta.task_status || 'open', content: t.content });
      }
    }
  }

  // ── 4. Build continuation brief ───────────────────────────────────────────
  const lines = [
    `# ccchat Continuation Brief`,
    `Saved: ${new Date().toISOString()} | trigger: ${trigger ?? 'unknown'}`,
    `Agent: ${name}`,
    ``,
    `## Rooms & Cursors`,
  ];

  for (const room of rooms) {
    const cursor = cursors.find(c => c.room === room);
    lines.push(`- ${room}  (last read: #${cursor?.last_id ?? 0})`);
  }

  if (activeTasks.length > 0) {
    lines.push(``, `## Active Tasks`);
    for (const t of activeTasks) {
      const preview = t.content.replace(/\n/g, ' ').slice(0, 120);
      lines.push(`- [${t.status}] #${t.id} (${t.room}) ${preview}`);
    }
  }

  if (compact_summary?.trim()) {
    lines.push(``, `## Session Summary`);
    // Cap to keep handoff note reasonable — 48h TTL anyway
    lines.push(compact_summary.trim().slice(0, 2000));
  }

  lines.push(
    ``,
    `## On Resume`,
    `Run chat-catchup to reload room state and this brief before continuing.`,
  );

  setHandoffNote(name, projectPath, lines.join('\n'));

  // ── 5. Clean up signal files ──────────────────────────────────────────────
  for (const f of [
    `/tmp/ccchat-compact-${session_id}`,
    `/tmp/ccchat-nudged-${session_id}`,
  ]) {
    try { if (existsSync(f)) unlinkSync(f); } catch {}
  }

  const taskNote = activeTasks.length ? `, ${activeTasks.length} task(s)` : '';
  console.error(`[ccchat] ✓ Compacted — state saved for ${name} (${rooms.length} room(s)${taskNote})`);

} catch (err) {
  // Hooks must never fail loudly
  console.error(`[ccchat] post-compact warning: ${err.message}`);
} finally {
  try { closeDb(); } catch {}
}
