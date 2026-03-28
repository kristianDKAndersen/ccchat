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
      rooms TEXT NOT NULL DEFAULT '["general"]',
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
  `);

  // Schema migrations
  const agentCols = db.pragma('table_info(agents)').map(c => c.name);
  if (!agentCols.includes('handoff_notes')) {
    db.exec('ALTER TABLE agents ADD COLUMN handoff_notes TEXT');
    db.exec('ALTER TABLE agents ADD COLUMN handoff_at TEXT');
  }

  const msgCols = db.pragma('table_info(messages)').map(c => c.name);
  if (!msgCols.includes('pinned')) {
    db.exec('ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }

  // Expand type CHECK to include 'task' — SQLite can't ALTER CHECK constraints,
  // so we rely on application-level validation in insertMessage()
  // and create content search index
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_content ON messages(room, content)');

  return db;
}

export function projectHash(path) {
  return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

export function upsertAgent({ name, projectPath, rooms, setOnline = true }) {
  const d = getDb();
  const hash = projectHash(projectPath);

  // Get existing rooms and merge
  let existingRooms = ['general'];
  const existing = d.prepare('SELECT rooms, online FROM agents WHERE name = ? AND project_hash = ?').get(name, hash);
  if (existing) {
    try { existingRooms = JSON.parse(existing.rooms); } catch { existingRooms = ['general']; }
  }
  if (rooms) {
    for (const r of rooms) {
      if (!existingRooms.includes(r)) existingRooms.push(r);
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
    d.prepare(`
      INSERT INTO agents (name, project_hash, project_path, rooms, online, last_seen)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(name, project_hash) DO UPDATE SET
        project_path = ?,
        rooms = ?,
        online = ?
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
  let rooms = ['general'];
  if (existing) {
    try { rooms = JSON.parse(existing.rooms); } catch { rooms = ['general']; }
  }

  if (rooms.includes(room)) return; // already in room

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
const PROTECTED_ROOMS = ['general'];

export function leaveRoom(name, projectPath, room) {
  if (PROTECTED_ROOMS.includes(room)) {
    throw new Error(`Cannot leave protected room '${room}'`);
  }

  const d = getDb();
  const hash = projectHash(projectPath);

  const existing = d.prepare('SELECT rooms FROM agents WHERE name = ? AND project_hash = ?').get(name, hash);
  if (!existing) return;

  let rooms;
  try { rooms = JSON.parse(existing.rooms); } catch { rooms = ['general']; }

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
  if (!row) return ['general'];
  try { return JSON.parse(row.rooms); } catch { return ['general']; }
}

export function getOpenTasks(room, limit = 20) {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM messages
    WHERE room = ? AND type = 'task' AND metadata LIKE '%"task_status":"open"%'
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
  d.prepare(`
    UPDATE agents SET online = 0
    WHERE online = 1 AND last_seen < datetime('now', '-10 minutes')
  `).run();
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
  try { rooms = JSON.parse(agent.rooms); } catch { rooms = ['general']; }

  // Fetch all cursors for this agent in one query
  const cursors = d.prepare(
    'SELECT room, last_id FROM read_cursors WHERE agent_name = ? AND project_hash = ?'
  ).all(agentName, hash);
  const cursorMap = new Map(cursors.map(c => [c.room, c.last_id]));

  const counts = new Map();
  const countStmt = d.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE room = ? AND id > ? AND from_agent != ?');

  for (const room of rooms) {
    const lastId = cursorMap.get(room) || 0;
    const row = countStmt.get(room, lastId, agentName);
    if (row.cnt > 0) counts.set(room, row.cnt);
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

export function initCursorIfNew(agentName, projectPath, room) {
  const d = getDb();
  const hash = projectHash(projectPath);
  const maxId = d.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room = ?').get(room);
  d.prepare(`
    INSERT OR IGNORE INTO read_cursors (agent_name, project_hash, room, last_id)
    VALUES (?, ?, ?, ?)
  `).run(agentName, hash, room, maxId.id);
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

export function getMessagesSinceGlobal(sinceId, limit = 100) {
  const d = getDb();
  return d.prepare('SELECT * FROM messages WHERE id > ? ORDER BY id ASC LIMIT ?').all(sinceId, limit);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
