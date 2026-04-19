#!/usr/bin/env node
// Self-contained test runner for single-room-at-a-time refactor.
// Tests T1-T18. Uses a fresh temp SQLite DB per test; no framework required.

import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import Database from 'better-sqlite3';

const SCRIPTS_DIR = join(import.meta.dirname, '..', 'scripts');
const LIB_DIR = join(import.meta.dirname, '..', 'lib');

// ─── Harness ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function run(name, fn) {
  // Fresh temp DB per test
  const dbPath = join(tmpdir(), `ccchat-test-${randomBytes(8).toString('hex')}.db`);
  process.env.CCCHAT_DB_PATH = dbPath;

  // Reset module singleton between tests by closing any open DB
  const { closeDb } = await import('../lib/db.js');
  closeDb();

  try {
    await fn(dbPath);
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failures.push({ name, error: e.message });
    failed++;
  } finally {
    closeDb();
    if (existsSync(dbPath)) rmSync(dbPath);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// Fresh import of db functions (re-imported each test via dynamic import isn't
// needed — all functions use the module-level `db` singleton which closeDb resets)
async function db() {
  return import('../lib/db.js');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// T1: New agent → getAgentRoom() returns 'lobby'; identity file has currentRoom: 'lobby'
await run('T1: New agent defaults to lobby', async () => {
  const { upsertAgent, getAgentRoom, closeDb } = await db();
  const pp = '/tmp/test-proj-t1';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  assert(getAgentRoom('alice', pp) === 'lobby', 'getAgentRoom should return lobby');
});

// T2: setCurrentRoom → DB shows current_room='dev'; initCursorIfNew created cursor
await run('T2: setCurrentRoom switches to dev', async () => {
  const { upsertAgent, setCurrentRoom, getAgentRoom, getDb, projectHash, closeDb } = await db();
  const pp = '/tmp/test-proj-t2';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  // Create dev room by inserting a message
  const d = getDb();
  d.prepare("INSERT INTO messages (type, from_agent, room, content) VALUES ('message','bot','dev','hello')").run();
  setCurrentRoom('alice', pp, 'dev');
  assert(getAgentRoom('alice', pp) === 'dev', 'should be in dev');
  // Cursor should exist
  const hash = projectHash(pp);
  const cursor = d.prepare('SELECT * FROM read_cursors WHERE agent_name=? AND project_hash=? AND room=?').get('alice', hash, 'dev');
  assert(cursor, 'cursor should exist for dev');
});

// T3: Join dev, then staging → current_room='staging'; dev cursor row preserved
await run('T3: Switching rooms preserves cursors', async () => {
  const { upsertAgent, setCurrentRoom, getAgentRoom, getDb, projectHash } = await db();
  const pp = '/tmp/test-proj-t3';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  const d = getDb();
  d.prepare("INSERT INTO messages (type, from_agent, room, content) VALUES ('message','bot','dev','hi'),('message','bot','staging','yo')").run();
  setCurrentRoom('alice', pp, 'dev');
  const hash = projectHash(pp);
  // Advance cursor in dev
  d.prepare('UPDATE read_cursors SET last_id=5 WHERE agent_name=? AND project_hash=? AND room=?').run('alice', hash, 'dev');
  setCurrentRoom('alice', pp, 'staging');
  assert(getAgentRoom('alice', pp) === 'staging', 'should be in staging');
  // dev cursor should still exist with value 5
  const devCursor = d.prepare('SELECT last_id FROM read_cursors WHERE agent_name=? AND project_hash=? AND room=?').get('alice', hash, 'dev');
  assert(devCursor && devCursor.last_id === 5, `dev cursor should be preserved (got ${devCursor?.last_id})`);
});

// T4: leaveCurrentRoom from non-lobby → current_room='lobby'; lobby cursor reset
await run('T4: leaveCurrentRoom returns to lobby', async () => {
  const { upsertAgent, setCurrentRoom, leaveCurrentRoom, getAgentRoom, getDb, projectHash } = await db();
  const pp = '/tmp/test-proj-t4';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  const d = getDb();
  d.prepare("INSERT INTO messages (type, from_agent, room, content) VALUES ('message','bot','dev','hi')").run();
  setCurrentRoom('alice', pp, 'dev');
  const result = leaveCurrentRoom('alice', pp);
  assert(result.room === 'dev', `should have left dev (got ${result.room})`);
  assert(getAgentRoom('alice', pp) === 'lobby', 'should be back in lobby');
});

// T5: leaveCurrentRoom when already lobby → { alreadyInLobby: true }
await run('T5: leaveCurrentRoom from lobby returns alreadyInLobby', async () => {
  const { upsertAgent, leaveCurrentRoom } = await db();
  const pp = '/tmp/test-proj-t5';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  const result = leaveCurrentRoom('alice', pp);
  assert(result.alreadyInLobby === true, `expected alreadyInLobby (got ${JSON.stringify(result)})`);
});

// T6: getUnreadMessages with current_room scope only — no bleed from other rooms
await run('T6: No room bleed in unread count', async () => {
  const { upsertAgent, initCursorIfNew, getUnreadCount, getDb } = await db();
  const pp = '/tmp/test-proj-t6';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  initCursorIfNew('alice', pp, 'lobby');
  const d = getDb();
  // Message in dev, not lobby
  d.prepare("INSERT INTO messages (type, from_agent, room, content) VALUES ('message','bot','dev','hi')").run();
  const lobbyCount = getUnreadCount('alice', pp, 'lobby');
  assert(lobbyCount === 0, `lobby should have 0 unread (got ${lobbyCount})`);
});

// T7: upsertAgent({ currentRoom: 'lobby' }) + send to lobby → cursor advances in lobby only
await run('T7: Cursor advances only in current room', async () => {
  const { upsertAgent, initCursorIfNew, updateCursor, getUnreadCount, getDb, projectHash } = await db();
  const pp = '/tmp/test-proj-t7';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  initCursorIfNew('alice', pp, 'lobby');
  const d = getDb();
  d.prepare("INSERT INTO messages (type, from_agent, room, content) VALUES ('message','bot','lobby','hi'),('message','bot','dev','yo')").run();
  // Advance cursor in lobby only
  updateCursor('alice', pp, 'lobby', 1);
  // dev cursor doesn't exist → unread count for dev is NOT zero (no cursor = lastId=0)
  const devCount = getUnreadCount('alice', pp, 'dev');
  assert(devCount > 0, 'dev should still have unread (cursor not advanced)');
});

// T8: Agent in lobby; urgent message in dev → getCrossRoomSignals returns {room:'dev', tags:['URGENT']}
await run('T8: getCrossRoomSignals returns urgent from other room', async () => {
  const { upsertAgent, initCursorIfNew, getCrossRoomSignals, getDb } = await db();
  const pp = '/tmp/test-proj-t8';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  initCursorIfNew('alice', pp, 'lobby');
  const d = getDb();
  d.prepare("INSERT INTO messages (type, from_agent, room, content, metadata) VALUES ('message','bot','dev','urgent!','{\"priority\":\"urgent\",\"mentions\":[]}')").run();
  const signals = getCrossRoomSignals('alice', pp);
  assert(signals.length > 0, 'should have at least one signal');
  const devSignal = signals.find(s => s.room === 'dev');
  assert(devSignal, 'should have signal from dev');
  assert(devSignal.tags.includes('URGENT'), `should be URGENT (got ${devSignal.tags})`);
});

// T9: Agent in lobby; urgent message in staging → getCrossRoomSignals returns it
await run('T9: getCrossRoomSignals returns urgent from staging', async () => {
  const { upsertAgent, initCursorIfNew, getCrossRoomSignals, getDb } = await db();
  const pp = '/tmp/test-proj-t9';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  initCursorIfNew('alice', pp, 'lobby');
  const d = getDb();
  d.prepare("INSERT INTO messages (type, from_agent, room, content, metadata) VALUES ('message','bot','staging','critical!','{\"priority\":\"urgent\",\"mentions\":[]}')").run();
  const signals = getCrossRoomSignals('alice', pp);
  const stagingSignal = signals.find(s => s.room === 'staging');
  assert(stagingSignal, 'should have signal from staging');
  assert(stagingSignal.tags.includes('URGENT'), 'should be URGENT');
});

// T10: Agent in lobby; DM (to_agent=self) in any room → getCrossRoomSignals includes it
await run('T10: getCrossRoomSignals returns DMs', async () => {
  const { upsertAgent, initCursorIfNew, getCrossRoomSignals, getDb } = await db();
  const pp = '/tmp/test-proj-t10';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  initCursorIfNew('alice', pp, 'lobby');
  const d = getDb();
  d.prepare("INSERT INTO messages (type, from_agent, to_agent, room, content, metadata) VALUES ('message','bot','alice','dev','hey alice','{\"priority\":\"normal\",\"mentions\":[]}')").run();
  const signals = getCrossRoomSignals('alice', pp);
  const dm = signals.find(s => s.tags.includes('DM'));
  assert(dm, 'should have a DM signal');
});

// T11: getCrossRoomSignals does NOT advance any cursor for the signal room
await run('T11: getCrossRoomSignals does not advance cursors', async () => {
  const { upsertAgent, initCursorIfNew, getCrossRoomSignals, getDb, projectHash } = await db();
  const pp = '/tmp/test-proj-t11';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  initCursorIfNew('alice', pp, 'lobby');
  const d = getDb();
  const hash = projectHash(pp);
  d.prepare("INSERT INTO messages (type, from_agent, room, content, metadata) VALUES ('message','bot','dev','urgent!','{\"priority\":\"urgent\",\"mentions\":[]}')").run();
  const beforeCursor = d.prepare('SELECT last_id FROM read_cursors WHERE agent_name=? AND project_hash=? AND room=?').get('alice', hash, 'dev');
  getCrossRoomSignals('alice', pp);
  const afterCursor = d.prepare('SELECT last_id FROM read_cursors WHERE agent_name=? AND project_hash=? AND room=?').get('alice', hash, 'dev');
  // Both should be null/undefined (no dev cursor created) OR same value if it existed
  assert(
    JSON.stringify(beforeCursor) === JSON.stringify(afterCursor),
    `cursor should not advance: before=${JSON.stringify(beforeCursor)}, after=${JSON.stringify(afterCursor)}`
  );
});

// T12: chat-catchup.js output: total_unread ≤ 30, total_backfill ≤ 10, room = current_room only
await run('T12: catchup respects budget and single-room scope', async () => {
  const { upsertAgent, insertMessage, initCursorIfNew, closeDb: cdb } = await db();
  const pp = '/tmp/test-proj-t12';
  upsertAgent({ name: 't12agent', projectPath: pp, currentRoom: 'lobby' });
  initCursorIfNew('t12agent', pp, 'lobby');
  // Insert 5 lobby messages
  for (let i = 0; i < 5; i++) {
    insertMessage({ type: 'message', fromAgent: 'other', room: 'lobby', content: `msg ${i}` });
  }
  cdb();
  const r = spawnSync('node', [join(SCRIPTS_DIR, 'chat-catchup.js'), '--json'], {
    env: { ...process.env, CCCHAT_DB_PATH: process.env.CCCHAT_DB_PATH, CCCHAT_AGENT: 't12agent', CCCHAT_PROJECT: pp },
    encoding: 'utf8',
  });
  assert(r.status === 0, `catchup exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.total_unread <= 30, `total_unread=${out.total_unread} should be ≤30`);
  assert(out.total_backfill <= 10, `total_backfill=${out.total_backfill} should be ≤10`);
  // Only lobby room in unread/backfill
  assert(!out.unread.dev, 'dev should not appear in unread');
});

// T13: When unread = 30, backfill = 0
await run('T13: No backfill when unread saturates budget', async () => {
  const { upsertAgent, insertMessage, initCursorIfNew, updateCursor, getDb, projectHash, closeDb: cdb } = await db();
  const pp = '/tmp/test-proj-t13';
  upsertAgent({ name: 't13agent', projectPath: pp, currentRoom: 'lobby' });
  initCursorIfNew('t13agent', pp, 'lobby');
  // Set cursor to 0 to see all messages
  const d = getDb();
  const hash = projectHash(pp);
  d.prepare('UPDATE read_cursors SET last_id=0 WHERE agent_name=? AND project_hash=? AND room=?').run('t13agent', hash, 'lobby');
  // Insert 35 messages from another agent
  for (let i = 0; i < 35; i++) {
    insertMessage({ type: 'message', fromAgent: 'other', room: 'lobby', content: `msg ${i}` });
  }
  cdb();
  const r = spawnSync('node', [join(SCRIPTS_DIR, 'chat-catchup.js'), '--json'], {
    env: { ...process.env, CCCHAT_DB_PATH: process.env.CCCHAT_DB_PATH, CCCHAT_AGENT: 't13agent', CCCHAT_PROJECT: pp },
    encoding: 'utf8',
  });
  assert(r.status === 0, `catchup exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.total_unread === 30, `total_unread=${out.total_unread} should be 30 (budget cap)`);
  assert(out.total_backfill === 0, `total_backfill=${out.total_backfill} should be 0 when unread saturates budget`);
});

// T14: Migration SQL: agent with rooms JSON in old DB → after migration block runs, current_room='lobby'
await run('T14: Schema migration adds current_room=lobby to existing agents', async () => {
  const dbPath = process.env.CCCHAT_DB_PATH;
  // Build old-schema DB directly with better-sqlite3
  const oldDb = new Database(dbPath);
  oldDb.exec(`
    CREATE TABLE agents (
      name TEXT NOT NULL,
      project_hash TEXT NOT NULL,
      project_path TEXT NOT NULL,
      rooms TEXT NOT NULL DEFAULT '["lobby"]',
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      online INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (name, project_hash)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      room TEXT NOT NULL DEFAULT 'lobby',
      content TEXT NOT NULL,
      metadata TEXT,
      parent_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE read_cursors (
      agent_name TEXT NOT NULL,
      project_hash TEXT NOT NULL,
      room TEXT NOT NULL,
      last_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_name, project_hash, room)
    );
  `);
  // Insert agent with 8 rooms (old schema)
  oldDb.prepare("INSERT INTO agents (name, project_hash, project_path, rooms) VALUES ('oldagent','abc123','/old','[\"lobby\",\"dev\",\"staging\",\"a\",\"b\",\"c\",\"d\",\"e\"]')").run();
  oldDb.close();

  // Now open with getDb() which will run migrations
  const { getDb } = await import('../lib/db.js');
  const d = getDb();
  const agent = d.prepare("SELECT current_room FROM agents WHERE name='oldagent'").get();
  assert(agent, 'agent should exist');
  assert(agent.current_room === 'lobby', `current_room should be 'lobby' (got '${agent.current_room}')`);
});

// T15: migrate-identity.js: identity file with rooms array → replaced with currentRoom: 'lobby'
await run('T15: migrate-identity.js converts rooms array to currentRoom', async () => {
  const { upsertAgent } = await db();
  // Create temp project dir with old identity file
  const projDir = join(tmpdir(), `ccchat-test-proj-${randomBytes(4).toString('hex')}`);
  mkdirSync(join(projDir, '.claude'), { recursive: true });
  const identityPath = join(projDir, '.claude', 'ccchat-identity.json');
  writeFileSync(identityPath, JSON.stringify({ name: 'testbot', projectPath: projDir, rooms: ['lobby', 'dev', 'staging'] }, null, 2));
  upsertAgent({ name: 'testbot', projectPath: projDir, currentRoom: 'lobby' });

  const r = spawnSync('node', [join(SCRIPTS_DIR, 'migrate-identity.js')], {
    env: { ...process.env, CCCHAT_DB_PATH: process.env.CCCHAT_DB_PATH },
    encoding: 'utf8',
  });
  assert(r.status === 0, `migrate-identity exited ${r.status}: ${r.stderr}`);

  const updated = JSON.parse(readFileSync(identityPath, 'utf8'));
  assert(!updated.rooms, `rooms should be gone (got ${JSON.stringify(updated.rooms)})`);
  assert(updated.currentRoom === 'lobby', `currentRoom should be 'lobby' (got '${updated.currentRoom}')`);

  rmSync(projDir, { recursive: true });
});

// T16: Rejoin previously-left room → cursor INSERT OR IGNORE preserves old value
await run('T16: Rejoining preserves cursor from previous session', async () => {
  const { upsertAgent, setCurrentRoom, leaveCurrentRoom, getDb, projectHash } = await db();
  const pp = '/tmp/test-proj-t16';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  const d = getDb();
  d.prepare("INSERT INTO messages (type, from_agent, room, content) VALUES ('message','bot','dev','hi')").run();
  setCurrentRoom('alice', pp, 'dev');
  const hash = projectHash(pp);
  // Advance cursor to 5
  d.prepare('UPDATE read_cursors SET last_id=5 WHERE agent_name=? AND project_hash=? AND room=?').run('alice', hash, 'dev');
  // Leave
  leaveCurrentRoom('alice', pp);
  // Rejoin
  setCurrentRoom('alice', pp, 'dev');
  const cursor = d.prepare('SELECT last_id FROM read_cursors WHERE agent_name=? AND project_hash=? AND room=?').get('alice', hash, 'dev');
  assert(cursor && cursor.last_id === 5, `cursor should be preserved at 5 (got ${cursor?.last_id})`);
});

// T17: setCurrentRoom with unknown room → throws error matching "does not exist"
await run('T17: setCurrentRoom throws on unknown room', async () => {
  const { upsertAgent, setCurrentRoom } = await db();
  const pp = '/tmp/test-proj-t17';
  upsertAgent({ name: 'alice', projectPath: pp, currentRoom: 'lobby' });
  let threw = false;
  try {
    setCurrentRoom('alice', pp, 'nonexistent-room-xyz');
  } catch (e) {
    threw = true;
    assert(e.message.includes('does not exist'), `error should mention "does not exist" (got: ${e.message})`);
  }
  assert(threw, 'setCurrentRoom should throw for unknown room');
});

// T18: status.js --raw JSON output: has currentRoom string field, no rooms array
await run('T18: status.js --raw shows currentRoom string, not rooms array', async () => {
  const { upsertAgent, closeDb: cdb } = await db();
  const pp = '/tmp/test-proj-t18';
  upsertAgent({ name: 't18agent', projectPath: pp, currentRoom: 'lobby' });
  cdb();
  const r = spawnSync('node', [join(SCRIPTS_DIR, 'status.js'), '--raw'], {
    env: { ...process.env, CCCHAT_DB_PATH: process.env.CCCHAT_DB_PATH, CCCHAT_PROJECT: pp },
    encoding: 'utf8',
  });
  assert(r.status === 0, `status exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.online_agents, 'should have online_agents');
  const agent = out.online_agents.find(a => a.name === 't18agent');
  assert(agent, 't18agent should be in online_agents');
  assert(typeof agent.currentRoom === 'string', `currentRoom should be a string (got ${typeof agent.currentRoom})`);
  assert(!agent.rooms, `rooms array should not exist (got ${JSON.stringify(agent.rooms)})`);
  assert(agent.currentRoom === 'lobby', `currentRoom should be 'lobby' (got '${agent.currentRoom}')`);
});

// T19: setup.js subprocess → identity file has currentRoom key, no rooms key
await run('T19: setup.js writes currentRoom, not rooms', async () => {
  const projDir = join(tmpdir(), `ccchat-test-t19-${randomBytes(4).toString('hex')}`);
  mkdirSync(projDir, { recursive: true });

  const r = spawnSync('node', [join(SCRIPTS_DIR, 'setup.js'), '--name', 't19agent', '--room', 'lobby'], {
    cwd: projDir,
    env: { ...process.env, CCCHAT_DB_PATH: process.env.CCCHAT_DB_PATH },
    encoding: 'utf8',
  });
  assert(r.status === 0, `setup.js exited ${r.status}: ${r.stderr}`);

  const identityPath = join(projDir, '.claude', 'ccchat-identity.json');
  assert(existsSync(identityPath), 'identity file should exist');
  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  assert(identity.currentRoom, `should have currentRoom (got ${JSON.stringify(identity)})`);
  assert(!identity.rooms, `should NOT have rooms (got ${JSON.stringify(identity.rooms)})`);

  rmSync(projDir, { recursive: true, force: true });
});

// T20: chat-search.js uses identity.currentRoom as default room
await run('T20: chat-search uses currentRoom as default room', async () => {
  const { upsertAgent, insertMessage, closeDb: cdb } = await db();
  const pp = join(tmpdir(), `ccchat-test-t20-${randomBytes(4).toString('hex')}`);
  mkdirSync(join(pp, '.claude'), { recursive: true });
  upsertAgent({ name: 't20agent', projectPath: pp, currentRoom: 'dev' });
  insertMessage({ type: 'message', fromAgent: 'other', room: 'dev', content: 'zxq-unique-dev-keyword' });
  cdb();

  writeFileSync(join(pp, '.claude', 'ccchat-identity.json'),
    JSON.stringify({ name: 't20agent', projectPath: pp, currentRoom: 'dev' }, null, 2));

  const r = spawnSync('node', [join(SCRIPTS_DIR, 'chat-search.js'), '--query', 'zxq-unique-dev-keyword', '--json'], {
    env: { ...process.env, CCCHAT_DB_PATH: process.env.CCCHAT_DB_PATH, CCCHAT_PROJECT: pp },
    encoding: 'utf8',
    cwd: pp,
  });
  assert(r.status === 0, `chat-search exited ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert(out.room === 'dev', `should search in dev (got '${out.room}')`);
  assert(out.count > 0, `should find results (got count=${out.count})`);

  rmSync(pp, { recursive: true, force: true });
});

// T21: chat-ask.js touches sentinel only for agents in the target room
await run('T21: chat-ask sentinel respects current_room', async () => {
  const { upsertAgent, closeDb: cdb, projectHash: ph } = await db();
  const pp = join(tmpdir(), `ccchat-test-t21-asker-${randomBytes(4).toString('hex')}`);
  const lobbyPp = join(tmpdir(), `ccchat-test-t21-lobby-${randomBytes(4).toString('hex')}`);
  const devPp = join(tmpdir(), `ccchat-test-t21-dev-${randomBytes(4).toString('hex')}`);
  mkdirSync(join(pp, '.claude'), { recursive: true });

  upsertAgent({ name: 't21asker', projectPath: pp, currentRoom: 'lobby' });
  upsertAgent({ name: 't21lobby', projectPath: lobbyPp, currentRoom: 'lobby' });
  upsertAgent({ name: 't21dev', projectPath: devPp, currentRoom: 'dev' });
  cdb();

  writeFileSync(join(pp, '.claude', 'ccchat-identity.json'),
    JSON.stringify({ name: 't21asker', projectPath: pp, currentRoom: 'lobby' }, null, 2));

  const { sentinelPath: sp, sentinelDir: sdir } = await import('../lib/sentinel.js');
  sdir();
  const lobbyHash = ph(lobbyPp);
  const devHash = ph(devPp);
  const lobbysentinel = sp(lobbyHash, 't21lobby');
  const devSentinel = sp(devHash, 't21dev');

  // Remove sentinel files if they exist from a previous test run
  try { rmSync(lobbysentinel, { force: true }); } catch {}
  try { rmSync(devSentinel, { force: true }); } catch {}

  spawnSync('node', [
    join(SCRIPTS_DIR, 'chat-ask.js'),
    '--question', 'hello lobby',
    '--room', 'lobby',
    '--timeout', '1',
  ], {
    env: { ...process.env, CCCHAT_DB_PATH: process.env.CCCHAT_DB_PATH, CCCHAT_PROJECT: pp },
    encoding: 'utf8',
    timeout: 8000,
  });

  assert(existsSync(lobbysentinel), 'lobby agent sentinel should have been touched');
  assert(!existsSync(devSentinel), 'dev agent sentinel should NOT have been touched');

  rmSync(pp, { recursive: true, force: true });
});

// T22: chat-watch.js outputs single-room JSON shape (room string, messages array)
await run('T22: chat-watch outputs room string and messages array', async () => {
  const { upsertAgent, closeDb: cdb } = await db();
  const pp = join(tmpdir(), `ccchat-test-t22-${randomBytes(4).toString('hex')}`);
  mkdirSync(join(pp, '.claude'), { recursive: true });
  upsertAgent({ name: 't22agent', projectPath: pp, currentRoom: 'lobby' });
  cdb();

  writeFileSync(join(pp, '.claude', 'ccchat-identity.json'),
    JSON.stringify({ name: 't22agent', projectPath: pp, currentRoom: 'lobby' }, null, 2));

  const r = spawnSync('node', [join(SCRIPTS_DIR, 'chat-watch.js'), '--timeout', '1'], {
    env: { ...process.env, CCCHAT_DB_PATH: process.env.CCCHAT_DB_PATH, CCCHAT_PROJECT: pp },
    encoding: 'utf8',
    timeout: 10000,
  });

  const lines = r.stdout.split('\n').filter(l => l.trim().startsWith('{'));
  assert(lines.length > 0, `no JSON line found in output: ${r.stdout.slice(0, 200)}`);
  const out = JSON.parse(lines[0]);
  assert(typeof out.room === 'string', `room should be a string (got ${typeof out.room}: ${out.room})`);
  assert(Array.isArray(out.messages), `messages should be an array (got ${typeof out.messages})`);
  assert(!out.rooms, `rooms object should not exist`);

  rmSync(pp, { recursive: true, force: true });
});

// T23: upsertAgent with rooms param but no currentRoom → current_room stays lobby (shim removed)
await run('T23: upsertAgent ignores rooms param after shim removal', async () => {
  const { upsertAgent, getDb, projectHash: ph } = await db();
  const pp = '/tmp/test-proj-t23';
  upsertAgent({ name: 't23agent', projectPath: pp, currentRoom: 'lobby' });
  // Pass rooms but no currentRoom — after shim removal, rooms is ignored by destructuring
  upsertAgent({ name: 't23agent', projectPath: pp, rooms: ['dev'] });
  const d = getDb();
  const hash = ph(pp);
  const row = d.prepare('SELECT current_room FROM agents WHERE name=? AND project_hash=?').get('t23agent', hash);
  assert(row.current_room === 'lobby', `current_room should remain 'lobby' (got '${row.current_room}')`);
});

// T24: identity.rooms getter removed → resolveIdentity result has no rooms property
await run('T24: identity.rooms getter removed', async () => {
  const { resolveIdentity } = await import('../lib/identity.js');
  const identity = resolveIdentity({ name: 't24agent', project: '/tmp/test-proj-t24' });
  assert(identity.rooms === undefined, `rooms should be undefined (got ${JSON.stringify(identity.rooms)})`);
  assert(typeof identity.currentRoom === 'string', `currentRoom should be a string (got ${typeof identity.currentRoom})`);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
