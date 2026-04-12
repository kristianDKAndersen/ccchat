#!/usr/bin/env node
// Pre-claim enforcement gate for plan tasks.
// Checks if a task can be claimed, claims it atomically, or blocks with a clear error.
//
// Usage:
//   node chat-preclaim.js --task <task-id> --name <agent>
//
// Exits 0 on success (task claimed).
// Exits 1 on failure (task already claimed or not pending).

import { getPlanTask, claimTask, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

try {
  const taskIdRaw = getFlag('task');
  if (!taskIdRaw) {
    console.error('Usage: chat-preclaim.js --task <task-id> --name <agent>');
    process.exit(1);
  }

  const taskId = parseInt(taskIdRaw, 10);
  if (isNaN(taskId)) {
    console.error(`Invalid task ID: ${taskIdRaw}`);
    process.exit(1);
  }

  const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });

  const task = getPlanTask(taskId);
  if (!task) {
    console.error(`Task #${taskId} not found.`);
    process.exit(1);
  }

  // Already claimed by this agent — idempotent success
  if (task.status === 'in_progress' && task.owner === identity.name) {
    console.log(`Task #${taskId} already claimed by you. Proceeding.`);
    process.exit(0);
  }

  // Already claimed by someone else — block
  if (task.status === 'in_progress') {
    console.error(`Task #${taskId} already claimed by ${task.owner}. Aborting.`);
    process.exit(1);
  }

  // Not pending — done, blocked, or unknown state
  if (task.status !== 'pending') {
    console.error(`Task #${taskId} is ${task.status}. Cannot claim.`);
    process.exit(1);
  }

  // Attempt atomic claim
  const success = claimTask(taskId, identity.name);
  if (success) {
    console.log(`Claimed task #${taskId}: ${task.title}`);
    process.exit(0);
  } else {
    // Race lost — someone claimed between our check and the UPDATE
    const updated = getPlanTask(taskId);
    console.error(`Task #${taskId} already claimed by ${updated.owner || 'unknown'}. Aborting.`);
    process.exit(1);
  }
} finally {
  closeDb();
}
