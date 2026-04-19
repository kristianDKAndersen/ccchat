#!/usr/bin/env node
/**
 * Regression test: current_room invariance across plan + claim operations.
 *
 * Guards against the bug where postSystemMessage() called upsertAgent() with
 * a currentRoom override, silently moving the agent to a different room as a
 * side-effect of posting a system message.
 *
 * Bug reference: ccchat audit 2026-04-19, tasks #232 + #233 on plan #53.
 *
 * Usage: node test/postsystemmessage-invariance.test.js
 * Exit 0 = all assertions passed.
 * Exit 1 = one or more assertions failed (details on stderr).
 */

import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

// ── Setup ─────────────────────────────────────────────────────────────────────

const testDir = mkdtempSync(join(tmpdir(), 'ccchat-test-'));
const dbPath  = join(testDir, 'ccchat.db');
const projDir = join(testDir, 'agent-project');
mkdirSync(projDir, { recursive: true });

const AGENT_NAME = 'test-invariance-agent';
const HOME_ROOM  = 'lobby';   // agent stays here throughout
const PLAN_ROOM  = 'plan-room'; // all plan/claim ops happen "in" this room

const env = {
  ...process.env,
  CCCHAT_DB_PATH: dbPath,
};

const scripts = join(import.meta.url.replace('file://', '').replace(/\/test\/.*$/, ''), 'scripts');

function run(cmd, extraEnv = {}) {
  return execSync(`node ${scripts}/${cmd}`, {
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function getCurrentRoom() {
  const db = new Database(dbPath);
  const row = db.prepare(
    "SELECT current_room FROM agents WHERE name = ? LIMIT 1"
  ).get(AGENT_NAME);
  db.close();
  return row ? row.current_room : null;
}

function getDivergenceMessages() {
  const db = new Database(dbPath);
  const rows = db.prepare(
    "SELECT content FROM messages WHERE type = 'system' AND content LIKE '%IDENTITY DIVERGENCE%'"
  ).all();
  db.close();
  return rows;
}

let passed = 0;
let failed = 0;

function assert(label, condition, actual) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label} — got: ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertRoom(after) {
  const room = getCurrentRoom();
  assert(`current_room=${HOME_ROOM} after ${after}`, room === HOME_ROOM, room);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

console.log('Setting up...');

// Create home room + agent
run(`chat-join.js --room ${HOME_ROOM} --create --name ${AGENT_NAME} --project ${projDir}`);
assertRoom('join home room');

// Create plan room
run(`chat-join.js --room ${PLAN_ROOM} --create --name ${AGENT_NAME} --project ${projDir}`);
// After creating plan-room, agent stays in lobby (join doesn't switch)
// Actually chat-join DOES switch current_room — switch back
run(`chat-join.js --room ${HOME_ROOM} --name ${AGENT_NAME} --project ${projDir}`);
assertRoom('returned to home room after creating plan room');

// ── Plan operations ───────────────────────────────────────────────────────────

console.log('\nPlan operations:');

// Create a plan in PLAN_ROOM
const planOut = run(`chat-plan.js --create --title "Invariance test plan" --room ${PLAN_ROOM} --name ${AGENT_NAME} --project ${projDir}`);
const planMatch = planOut.match(/plan #(\d+)/i);
if (!planMatch) { console.error('Could not parse plan ID from:', planOut); process.exit(1); }
const planId = planMatch[1];
assertRoom('chat-plan --create');

// Add task
const taskOut = run(`chat-plan.js --add-task ${planId} --title "Test task" --description "Desc" --verify "Verify" --name ${AGENT_NAME} --project ${projDir}`);
const taskMatch = taskOut.match(/task #(\d+)/i);
if (!taskMatch) { console.error('Could not parse task ID from:', taskOut); process.exit(1); }
const taskId = taskMatch[1];
assertRoom('chat-plan --add-task');

// Activate plan (requires setting phase to draft first — use DB directly for setup)
{
  const db = new Database(dbPath);
  db.prepare("INSERT OR IGNORE INTO room_phases (room, phase, set_by) VALUES (?, 'draft', ?)").run(PLAN_ROOM, AGENT_NAME);
  db.close();
}
run(`chat-plan.js --activate ${planId} --name ${AGENT_NAME} --project ${projDir}`);
assertRoom('chat-plan --activate');

// ── Claim operations ──────────────────────────────────────────────────────────

console.log('\nClaim operations:');

// Set phase to execute so claim works
{
  const db = new Database(dbPath);
  db.prepare("UPDATE room_phases SET phase = 'execute' WHERE room = ?").run(PLAN_ROOM);
  db.close();
}

run(`chat-claim.js --claim ${taskId} --name ${AGENT_NAME} --project ${projDir}`);
assertRoom('chat-claim --claim');

run(`chat-claim.js --release ${taskId} --name ${AGENT_NAME} --project ${projDir}`);
assertRoom('chat-claim --release');

run(`chat-claim.js --claim ${taskId} --name ${AGENT_NAME} --project ${projDir}`);
assertRoom('chat-claim --claim (re-claim)');

run(`chat-claim.js --complete ${taskId} --name ${AGENT_NAME} --project ${projDir}`);
assertRoom('chat-claim --complete');

run(`chat-plan.js --complete ${planId} --name ${AGENT_NAME} --project ${projDir}`);
assertRoom('chat-plan --complete');

// ── Identity divergence check ─────────────────────────────────────────────────

console.log('\nIdentity divergence check:');
const divMessages = getDivergenceMessages();
assert('no IDENTITY DIVERGENCE messages emitted', divMessages.length === 0, divMessages.map(m => m.content));

// ── upsertAgent guard co-test ─────────────────────────────────────────────────

console.log('\nupsertAgent guard:');
try {
  const { upsertAgent } = await import('../lib/db.js');
  try {
    upsertAgent({ name: AGENT_NAME, projectPath: projDir, rooms: ['lobby'] });
    console.error('  ✗ upsertAgent should throw on unknown param "rooms"');
    failed++;
  } catch (e) {
    assert('throws on unknown param "rooms"', e.message.includes('unknown param'), e.message);
  }
} catch (e) {
  console.error('  ✗ could not import db.js:', e.message);
  failed++;
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

rmSync(testDir, { recursive: true, force: true });

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAIL');
  process.exit(1);
} else {
  console.log('PASS');
}
