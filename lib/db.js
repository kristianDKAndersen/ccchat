import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';

const DB_DIR = join(homedir(), '.claude', 'ccchat');
const DB_PATH = join(DB_DIR, 'ccchat.db');

let db;

export function getDb() {
  if (db) return db;

  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT NOT NULL,
      project_hash TEXT NOT NULL,
      project_path TEXT NOT NULL,
      rooms TEXT NOT NULL DEFAULT '["lobby"]',
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      online INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (name, project_hash)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('message','question','system')),
      from_agent TEXT NOT NULL,
      from_project TEXT,
      to_agent TEXT,
      room TEXT NOT NULL DEFAULT 'general',
      content TEXT NOT NULL,
      metadata TEXT,
      parent_id INTEGER REFERENCES messages(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS read_cursors (
      agent_name TEXT NOT NULL,
      project_hash TEXT NOT NULL,
      room TEXT NOT NULL,
      last_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_name, project_hash, room)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room, id);
    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);

    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      room TEXT NOT NULL DEFAULT 'general',
      created_by TEXT NOT NULL,
      source_message_id INTEGER,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','completed','abandoned')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (source_message_id) REFERENCES messages(id)
    );

    CREATE TABLE IF NOT EXISTS plan_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      verify TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','done','blocked')),
      owner TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      blocked_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );

    CREATE TABLE IF NOT EXISTS planner_locks (
      room TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Schema migrations
  const agentCols = db.pragma('table_info(agents)').map(c => c.name);
  if (!agentCols.includes('handoff_notes')) {
    db.exec('ALTER TABLE agents ADD COLUMN handoff_notes TEXT');
  }
  if (!agentCols.includes('handoff_at')) {
    db.exec('ALTER TABLE agents ADD COLUMN handoff_at TEXT');
  }

  const msgCols = db.pragma('table_info(messages)').map(c => c.name);
  if (!msgCols.includes('pinned')) {
    db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }

  // Expand type CHECK to include 'task' — SQLite can't ALTER CHECK constraints,
  // so we rely on application-level validation in insertMessage()

  // Case-duplicate cleanup: identity.js lowercases all names, but old rows may
  // exist with mixed case (e.g., "A-Nicola" and "a-nicola" for the same project).
  // Merge duplicates: keep the lowercase row, transfer the uppercase row's online/last_seen
  // if it's more recent, then delete the uppercase row.
  try {
    const dupes = db.prepare(`
      SELECT a1.rowid AS keep_rowid, a1.name AS keep_name, a1.project_hash,
             a2.rowid AS dupe_rowid, a2.name AS dupe_name,
             a2.online AS dupe_online, a2.last_seen AS dupe_last_seen,
             a1.online AS keep_online, a1.last_seen AS keep_last_seen
      FROM agents a1
      JOIN agents a2 ON LOWER(a1.name) = LOWER(a2.name)
        AND a1.project_hash = a2.project_hash
        AND a1.name = LOWER(a1.name)
        AND a2.name != LOWER(a2.name)
    `).all();
    for (const d of dupes) {
      // If the uppercase version was more recently active, transfer its state
      if (d.dupe_last_seen > d.keep_last_seen) {
        db.prepare('UPDATE agents SET last_seen = ?, online = ? WHERE name = ? AND project_hash = ?')
          .run(d.dupe_last_seen, d.dupe_online, d.keep_name, d.project_hash);
      }
      db.prepare('DELETE FROM agents WHERE name = ? AND project_hash = ?')
        .run(d.dupe_name, d.project_hash);
    }
  } catch {
    // Migration is best-effort — don't block on legacy data issues
  }

  return db;
}

export function projectHash(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

export function upsertAgent({ name, projectPath, rooms, setOnline = true }) {
  const d = getDb();
  const hash = projectHash(projectPath);

  // Get existing rooms and merge
  let existingRooms = ['lobby'];
  const existing = d.prepare('SELECT rooms, online FROM agents WHERE name = ? AND project_hash = ?').get(name, hash);
  if (existing) {
    try { existingRooms = JSON.parse(existing.rooms); } catch { existingRooms = ['lobby']; }
  }
  // Rooms excluded from additive merge. These can only be joined explicitly
  // via chat-join.js, not via identity file or upsertAgent calls.
  // If a second room ever needs filtering here, do the resetRoomsToIdentity()
  // refactor instead of adding another entry. See session 2026-04-09 for rationale.
  const DEPRECATED_AUTO_JOIN = ['general'];
  if (rooms) {
    for (const r of rooms) {
      if (!existingRooms.includes(r) && !DEPRECATED_AUTO_JOIN.includes(r)) existingRooms.push(r);
    }
  }

  // Only force online=1 when setOnline is true (write operations).
  // Read-only callers pass setOnline=false to preserve offline status.
  const onlineValue = setOnline ? 1 : (existing ? existing.online : 1);

  const roomsJson = JSON.stringify(existingRooms);
  if (setOnline) {
    d.prepare(`
      INSERT INTO agents (name, project_hash, project_path, rooms, online, last_seen)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name, project_hash) DO UPDATE SET
        project_path = ?,
        rooms = ?,
        online = ?,
        last_seen = datetime('now')
    `).run(name, hash, projectPath, roomsJson, onlineValue, projectPath, roomsJson, onlineValue);
  } else {
    // Read-only / hook-path upsert: DO update last_seen so hook activity
    // (UserPromptSubmit, Stop, chat-read, chat-watch) extends the heartbeat.
    // Without this, agents who only poll without sending expire after 10 min
    // via getOnlineAgents() auto-expiry and drop out silently.
    d.prepare(`
      INSERT INTO agents (name, project_hash, project_path, rooms, online, last_seen)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name, project_hash) DO UPDATE SET
        project_path = ?,
        rooms = ?,
        online = ?,
        last_seen = datetime('now')
    `).run(name, hash, projectPath, roomsJson, onlineValue, projectPath, roomsJson, onlineValue);
  }
}

// Event hook stub — no-op today, becomes real when event bus is needed.
// Trigger criteria for replacing with real event bus:
//   1. 3rd no-op stub call added, OR
//   2. Sentinel workarounds in 2+ scripts, OR
//   3. Sentinel fast-path latency drops below polling fallback baseline
function emitEvent(/* eventType, payload */) {
  // No-op stub. This is intentional — see ccchat improvement proposal #1527/#1534.
}

export function joinRoom(name, projectPath, room) {
  const d = getDb();
  const hash = projectHash(projectPath);

  const existing = d.prepare('SELECT rooms FROM agents WHERE name = ? AND project_hash = ?').get(name, hash);
  let rooms = ['lobby'];
  if (existing) {
    try { rooms = JSON.parse(existing.rooms); } catch { rooms = ['lobby']; }
  }

  if (rooms.includes(room)) {
    // Lobby rooms: reset cursor even if already a member (fresh start each session)
    if (LOBBY_ROOMS.includes(room)) resetLobbyCursor(name, projectPath);
    return;
  }

  rooms.push(room);
  const roomsJson = JSON.stringify(rooms);

  d.prepare(`
    INSERT INTO agents (name, project_hash, project_path, rooms, online, last_seen)
    VALUES (?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(name, project_hash) DO UPDATE SET
      rooms = ?,
      last_seen = datetime('now')
  `).run(name, hash, projectPath, roomsJson, roomsJson);

  // Init read cursor for the new room
  initCursorIfNew(name, projectPath, room);

  emitEvent('room:join', { agent: name, room });
}

// Rooms that agents cannot leave. Add more here if mandatory channels are needed.
export const PROTECTED_ROOMS = ['general', 'lobby'];

export function leaveRoom(name, projectPath, room) {
  if (PROTECTED_ROOMS.includes(room)) {
    throw new Error(`Cannot leave protected room '${room}'`);
  }

  const d = getDb();
  const hash = projectHash(projectPath);

  const existing = d.prepare('SELECT rooms FROM agents WHERE name = ? AND project_hash = ?').get(name, hash);
  if (!existing) return;

  let rooms;
  try { rooms = JSON.parse(existing.rooms); } catch { rooms = ['lobby']; }

  const idx = rooms.indexOf(room);
  if (idx === -1) return; // not in room

  rooms.splice(idx, 1);
  const roomsJson = JSON.stringify(rooms);

  // Atomic: update rooms + emit event (sentinel cleanup handled by caller with access to sentinel module)
  d.prepare("UPDATE agents SET rooms = ?, last_seen = datetime('now') WHERE name = ? AND project_hash = ?")
    .run(roomsJson, name, hash);

  emitEvent('room:leave', { agent: name, room });

  return { hash }; // return hash so caller can clean up sentinel
}

export function getAgentRooms(name, projectPath) {
  const d = getDb();
  const hash = projectHash(projectPath);
  const row = d.prepare('SELECT rooms FROM agents WHERE name = ? AND project_hash = ?').get(name, hash);
  if (!row) return ['lobby'];
  try { return JSON.parse(row.rooms); } catch { return ['lobby']; }
}

export function getOpenTasks(room, limit = 20) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM messages
    WHERE room = ? AND type = 'task' AND json_extract(metadata, '$.task_status') = 'open'
    ORDER BY id DESC
    LIMIT ?
  `).all(room, limit).reverse();
}

export function setAgentOffline(name, projectPath) {
  const d = getDb();
  const hash = projectHash(projectPath);
  d.prepare("UPDATE agents SET online = 0, last_seen = datetime('now') WHERE name = ? AND project_hash = ?").run(name, hash);
}

export function removeAgent(name, projectPath) {
  const d = getDb();
  const hash = projectHash(projectPath);
  d.prepare('DELETE FROM read_cursors WHERE agent_name = ? AND project_hash = ?').run(name, hash);
  d.prepare('DELETE FROM agents WHERE name = ? AND project_hash = ?').run(name, hash);
}

export function getOnlineAgents() {
  const d = getDb();
  // Auto-expire agents not seen in 10 minutes (session crashed without leave hook)
  const stale = d.prepare(`
    SELECT COUNT(*) AS cnt FROM agents
    WHERE online = 1 AND last_seen < datetime('now', '-10 minutes')
  `).get();
  if (stale.cnt > 0) {
    d.prepare(`
      UPDATE agents SET online = 0
      WHERE online = 1 AND last_seen < datetime('now', '-10 minutes')
    `).run();
  }
  return d.prepare(`
    SELECT * FROM agents
    WHERE online = 1
  `).all();
}

export function insertMessage({ type, fromAgent, fromProject, toAgent, room, content, metadata, parentId }) {
  const d = getDb();
  const validTypes = ['message', 'question', 'system', 'task'];
  if (!validTypes.includes(type)) {
    throw new Error(`Invalid message type: ${type}. Must be one of: ${validTypes.join(', ')}`);
  }
  const result = d.prepare(`
    INSERT INTO messages (type, from_agent, from_project, to_agent, room, content, metadata, parent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(type, fromAgent, fromProject || null, toAgent || null, room || 'general', content, metadata ? JSON.stringify(metadata) : null, parentId || null);
  return { id: result.lastInsertRowid };
}

export function getMessagesSince(sinceId, room, limit = 50) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM messages
    WHERE id > ? AND room = ?
    ORDER BY id ASC
    LIMIT ?
  `).all(sinceId, room, limit);
}

export function getUnreadMessages(agentName, projectPath, room, limit = 50) {
  const d = getDb();
  const hash = projectHash(projectPath);
  const cursor = d.prepare('SELECT last_id FROM read_cursors WHERE agent_name = ? AND project_hash = ? AND room = ?').get(agentName, hash, room);
  const lastId = cursor ? cursor.last_id : 0;
  return d.prepare(`
    SELECT * FROM messages
    WHERE room = ? AND id > ? AND from_agent != ?
    ORDER BY id ASC
    LIMIT ?
  `).all(room, lastId, agentName, limit);
}

export function getUnreadCount(agentName, projectPath, room) {
  const d = getDb();
  const hash = projectHash(projectPath);
  const cursor = d.prepare('SELECT last_id FROM read_cursors WHERE agent_name = ? AND project_hash = ? AND room = ?').get(agentName, hash, room);
  const lastId = cursor ? cursor.last_id : 0;
  const row = d.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE room = ? AND id > ? AND from_agent != ?').get(room, lastId, agentName);
  return row.cnt;
}

export function getUnreadCountAllRooms(agentName, projectPath) {
  const d = getDb();
  const hash = projectHash(projectPath);

  // Get all rooms this agent is in
  const agent = d.prepare('SELECT rooms FROM agents WHERE name = ? AND project_hash = ?').get(agentName, hash);
  if (!agent) return new Map();

  let rooms;
  try { rooms = JSON.parse(agent.rooms); } catch { rooms = ['lobby']; }

  if (rooms.length === 0) return new Map();

  // Single GROUP BY query instead of N+1 per-room queries
  const placeholders = rooms.map(() => '?').join(',');
  const rows = d.prepare(`
    SELECT m.room, COUNT(*) AS cnt
    FROM messages m
    LEFT JOIN read_cursors rc
      ON rc.agent_name = ? AND rc.project_hash = ? AND rc.room = m.room
    WHERE m.room IN (${placeholders})
      AND m.from_agent != ?
      AND m.id > COALESCE(rc.last_id, 0)
    GROUP BY m.room
  `).all(agentName, hash, ...rooms, agentName);

  const counts = new Map();
  for (const row of rows) {
    if (row.cnt > 0) counts.set(row.room, row.cnt);
  }

  return counts;
}

export function getMaxMessageId(room) {
  const d = getDb();
  const row = d.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room = ?').get(room);
  return row.id;
}

export function updateCursor(agentName, projectPath, room, lastId) {
  const d = getDb();
  const hash = projectHash(projectPath);
  d.prepare(`
    INSERT INTO read_cursors (agent_name, project_hash, room, last_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_name, project_hash, room) DO UPDATE SET last_id = ?
  `).run(agentName, hash, room, lastId, lastId);
}

// Lobby rooms: cursor resets to latest message on join (no backlog).
// Reset happens in joinRoom/resetLobbyCursor, NOT here — initCursorIfNew
// runs on every read and must not wipe the cursor each time.
const LOBBY_ROOMS = ['lobby'];

export function initCursorIfNew(agentName, projectPath, room) {
  const d = getDb();
  const hash = projectHash(projectPath);
  const maxId = d.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room = ?').get(room);
  d.prepare(`
    INSERT OR IGNORE INTO read_cursors (agent_name, project_hash, room, last_id)
    VALUES (?, ?, ?, ?)
  `).run(agentName, hash, room, maxId.id);
}

// Reset lobby cursor on session start with 60s lookback window.
// Messages sent in the last 60s are visible to the joining agent,
// closing the race between last agent leaving and first agent rejoining.
// Older messages are skipped (no stale backlog).
export function resetLobbyCursor(agentName, projectPath) {
  const d = getDb();
  const hash = projectHash(projectPath);
  for (const room of LOBBY_ROOMS) {
    // TTL cleanup: purge lobby messages older than 30 minutes to keep the DB tidy.
    // No race — only old messages are deleted; active conversations survive.
    // Skip rows still referenced by thread replies (messages.parent_id) or plans
    // (plans.source_message_id) to avoid FOREIGN KEY violations; they'll age out
    // next cycle once the dependents are gone. Best-effort tidying, not strict GC.
    d.prepare(`
      DELETE FROM messages
      WHERE room = ?
        AND created_at < datetime('now', '-30 minutes')
        AND id NOT IN (SELECT parent_id FROM messages WHERE parent_id IS NOT NULL)
        AND id NOT IN (SELECT source_message_id FROM plans WHERE source_message_id IS NOT NULL)
    `).run(room);

    // 60s lookback: find the earliest message in the last 60 seconds.
    // Set cursor to (that id - 1) so the agent sees it. If no recent
    // messages exist, fall back to MAX(id) (same as old hard-reset behavior).
    const lookback = d.prepare(
      "SELECT COALESCE(MIN(id) - 1, -1) AS id FROM messages WHERE room = ? AND created_at >= datetime('now', '-60 seconds')"
    ).get(room);
    const maxId = d.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room = ?').get(room);
    const cursorId = lookback.id >= 0 ? lookback.id : maxId.id;

    d.prepare(`
      INSERT INTO read_cursors (agent_name, project_hash, room, last_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_name, project_hash, room) DO UPDATE SET last_id = ?
    `).run(agentName, hash, room, cursorId, cursorId);
  }
}

export function getThreadReplies(parentId, room) {
  const d = getDb();
  return d.prepare('SELECT * FROM messages WHERE parent_id = ? AND room = ? ORDER BY id ASC').all(parentId, room);
}

export function getThreadMessages(parentId, limit = 200) {
  const d = getDb();
  // Recursive CTE: get the root message + all descendants (full subtree)
  return d.prepare(`
    WITH RECURSIVE thread(id) AS (
      SELECT id FROM messages WHERE id = ?
      UNION ALL
      SELECT m.id FROM messages m JOIN thread t ON m.parent_id = t.id
    )
    SELECT msg.* FROM messages msg
    JOIN thread t ON msg.id = t.id
    ORDER BY msg.id ASC
    LIMIT ?
  `).all(parentId, limit);
}

export function getHistory(room, last = 20, beforeId = null) {
  const d = getDb();
  const query = beforeId
    ? 'SELECT * FROM messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?'
    : 'SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?';
  const params = beforeId ? [room, beforeId, last + 1] : [room, last + 1];
  const rows = d.prepare(query).all(...params);
  const hasMore = rows.length > last;
  if (hasMore) rows.pop();
  rows.reverse();
  return { messages: rows, has_more: hasMore };
}

export function getRecentMessages(room, limit = 50, sinceHours = 24) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM messages
    WHERE room = ? AND created_at > datetime('now', '-' || ? || ' hours')
    ORDER BY id DESC
    LIMIT ?
  `).all(room, sinceHours, limit).reverse();
}

export function setHandoffNote(name, projectPath, note) {
  const d = getDb();
  const hash = projectHash(projectPath);
  d.prepare(`
    UPDATE agents SET handoff_notes = ?, handoff_at = datetime('now')
    WHERE name = ? AND project_hash = ?
  `).run(note, name, hash);
}

export function getHandoffNote(name, projectPath) {
  const d = getDb();
  const hash = projectHash(projectPath);
  const row = d.prepare('SELECT handoff_notes, handoff_at FROM agents WHERE name = ? AND project_hash = ?').get(name, hash);
  if (!row || !row.handoff_notes || !row.handoff_at) return null;
  // 48h TTL
  // datetime('now') returns UTC; appending 'Z' is correct for JS Date parsing
  const age = Date.now() - new Date(row.handoff_at + 'Z').getTime();
  if (age > 48 * 60 * 60 * 1000) return null;
  return { note: row.handoff_notes, at: row.handoff_at };
}

export function pinMessage(messageId) {
  const d = getDb();
  d.prepare('UPDATE messages SET pinned = 1 WHERE id = ?').run(messageId);
}

export function unpinMessage(messageId) {
  const d = getDb();
  d.prepare('UPDATE messages SET pinned = 0 WHERE id = ?').run(messageId);
}

export function getPinnedMessages(room) {
  const d = getDb();
  return d.prepare('SELECT * FROM messages WHERE room = ? AND pinned = 1 ORDER BY id ASC').all(room);
}

export function getMessage(messageId) {
  const d = getDb();
  return d.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
}

export function searchMessages(room, query, limit = 20) {
  const d = getDb();
  const escaped = query.replace(/[%_]/g, '\\$&');
  const pattern = `%${escaped}%`;
  return d.prepare(`
    SELECT * FROM messages
    WHERE room = ? AND content LIKE ? ESCAPE '\\'
    ORDER BY id DESC
    LIMIT ?
  `).all(room, pattern, limit).reverse();
}

export function getHandoffNotes() {
  const d = getDb();
  return d.prepare(`
    SELECT name, project_path, handoff_notes, handoff_at FROM agents
    WHERE handoff_notes IS NOT NULL AND handoff_at > datetime('now', '-48 hours')
  `).all();
}

export function getMessageCount(room) {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE room = ?').get(room);
  return row.cnt;
}

export function getAllRooms() {
  const d = getDb();
  return d.prepare('SELECT DISTINCT room FROM messages ORDER BY room').all().map(r => r.room);
}

export function claimPlanner(room, agentName) {
  // One plan per room is a current system constraint.
  // If parallel plans are ever needed, migrate this to a per-(room, scope) table.
  const d = getDb();
  const TTL_MS = 15 * 60 * 1000; // 15 minutes

  // Try to insert atomically. INSERT OR IGNORE means only the first caller wins.
  d.prepare('INSERT OR IGNORE INTO planner_locks (room, agent_name) VALUES (?, ?)').run(room, agentName);

  // Check who owns the lock now.
  const lock = d.prepare('SELECT agent_name, claimed_at FROM planner_locks WHERE room = ?').get(room);

  if (!lock) return { success: false, claimant: null }; // shouldn't happen

  if (lock.agent_name === agentName) {
    return { success: true };
  }

  // Someone else holds the lock — check TTL.
  const age = Date.now() - new Date(lock.claimed_at + 'Z').getTime();
  if (age > TTL_MS) {
    // Stale lock — override it.
    d.prepare('DELETE FROM planner_locks WHERE room = ?').run(room);
    d.prepare('INSERT INTO planner_locks (room, agent_name) VALUES (?, ?)').run(room, agentName);
    return { success: true };
  }

  return { success: false, claimant: lock.agent_name };
}

export function releasePlanner(room) {
  const d = getDb();
  d.prepare('DELETE FROM planner_locks WHERE room = ?').run(room);
}

export function deleteRoom(room) {
  if (PROTECTED_ROOMS.includes(room)) throw new Error(`Cannot delete protected room '${room}'`);
  const d = getDb();
  d.transaction(() => {
    d.prepare('DELETE FROM messages WHERE room = ?').run(room);
    d.prepare('DELETE FROM read_cursors WHERE room = ?').run(room);
    // Remove room from agents' room lists
    const agents = d.prepare('SELECT name, project_hash, rooms FROM agents').all();
    for (const a of agents) {
      let rooms;
      try { rooms = JSON.parse(a.rooms || '["lobby"]'); } catch { rooms = [a.rooms || 'lobby']; }
      const filtered = rooms.filter(r => r !== room);
      if (filtered.length !== rooms.length) {
        d.prepare('UPDATE agents SET rooms = ? WHERE name = ? AND project_hash = ?')
          .run(JSON.stringify(filtered), a.name, a.project_hash);
      }
    }
  })();
}

export function getMessagesSinceGlobal(sinceId, limit = 100) {
  const d = getDb();
  return d.prepare('SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?').all(sinceId, limit);
}

// ── Plan/task functions ──────────────────────────────────────────────────

export function createPlan({ title, room, createdBy, sourceMessageId }) {
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO plans (title, room, created_by, source_message_id)
    VALUES (?, ?, ?, ?)
  `).run(title, room || 'general', createdBy, sourceMessageId || null);
  return { id: Number(result.lastInsertRowid) };
}

export function getPlan(planId) {
  const d = getDb();
  return d.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
}

export function listPlans({ status, room } = {}) {
  const d = getDb();
  let sql = 'SELECT * FROM plans WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (room) { sql += ' AND room = ?'; params.push(room); }
  sql += ' ORDER BY id DESC';
  return d.prepare(sql).all(...params);
}

export function updatePlanStatus(planId, status) {
  const d = getDb();
  d.prepare("UPDATE plans SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, planId);
}

export function addPlanTask({ planId, title, description, verify }) {
  const d = getDb();
  const maxSeq = d.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM plan_tasks WHERE plan_id = ?').get(planId);
  const seq = maxSeq.seq + 1;
  const result = d.prepare(`
    INSERT INTO plan_tasks (plan_id, seq, title, description, verify)
    VALUES (?, ?, ?, ?, ?)
  `).run(planId, seq, title, description || null, verify || null);
  return { id: Number(result.lastInsertRowid), seq };
}

export function getPlanTasks(planId) {
  const d = getDb();
  return d.prepare('SELECT * FROM plan_tasks WHERE plan_id = ? ORDER BY seq ASC').all(planId);
}

export function getPlanTask(taskId) {
  const d = getDb();
  return d.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(taskId);
}

export function claimTask(taskId, agentName) {
  const d = getDb();
  const result = d.prepare(`
    UPDATE plan_tasks SET status = 'in_progress', owner = ?, claimed_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(agentName, taskId);
  return result.changes > 0;
}

export function completeTask(taskId, agentName, { status = 'done', reason } = {}) {
  const d = getDb();
  if (status === 'blocked') {
    d.prepare(`
      UPDATE plan_tasks SET status = 'blocked', blocked_reason = ?, completed_at = datetime('now')
      WHERE id = ? AND owner = ?
    `).run(reason || null, taskId, agentName);
  } else {
    d.prepare(`
      UPDATE plan_tasks SET status = 'done', completed_at = datetime('now')
      WHERE id = ? AND owner = ?
    `).run(taskId, agentName);
  }
}

export function releaseTask(taskId, agentName) {
  const d = getDb();
  const task = d.prepare('SELECT * FROM plan_tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'in_progress') return false;

  // Owner can always release; anyone can release if claimed > 2 hours ago
  const isOwner = task.owner === agentName;
  const isStale = task.claimed_at && (Date.now() - new Date(task.claimed_at + 'Z').getTime() > 2 * 60 * 60 * 1000);
  if (!isOwner && !isStale) return false;

  d.prepare(`
    UPDATE plan_tasks SET status = 'pending', owner = NULL, claimed_at = NULL
    WHERE id = ?
  `).run(taskId);
  return true;
}

export function releaseAgentTasks(agentName) {
  const d = getDb();
  const tasks = d.prepare(`
    SELECT pt.*, p.room FROM plan_tasks pt
    JOIN plans p ON pt.plan_id = p.id
    WHERE pt.owner = ? AND pt.status = 'in_progress'
  `).all(agentName);

  for (const task of tasks) {
    d.prepare(`
      UPDATE plan_tasks SET status = 'pending', owner = NULL, claimed_at = NULL
      WHERE id = ?
    `).run(task.id);
  }
  return tasks;
}

export function getActivePlansWithUnclaimedTasks() {
  const d = getDb();
  return d.prepare(`
    SELECT p.id, p.title,
      COUNT(*) as total_tasks,
      COUNT(CASE WHEN pt.status = 'pending' THEN 1 END) as unclaimed
    FROM plans p
    JOIN plan_tasks pt ON p.id = pt.plan_id
    WHERE p.status = 'active'
    GROUP BY p.id
    HAVING unclaimed > 0
  `).all();
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
