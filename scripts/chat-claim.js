#!/usr/bin/env node
// Atomic task claiming for collaborative plans.
// Usage:
//   node chat-claim.js --claim <task-id> --name <agent>
//   node chat-claim.js --complete <task-id> --name <agent> [--status done|blocked] [--reason '<text>']
//   node chat-claim.js --release <task-id> --name <agent>
//   node chat-claim.js --status <plan-id>

import {
  getPlanTask, getPlan, getPlanTasks, claimTask, completeTask,
  releaseTask, insertMessage, upsertAgent, initCursorIfNew,
  updateCursor, closeDb
} from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';

import { args, getFlag } from '../lib/args.js';

const jsonOut = args.includes('--json');

function out(obj) {
  if (jsonOut) console.log(JSON.stringify(obj));
  else console.log(obj._text || JSON.stringify(obj));
}

function postSystemMessage(identity, room, content) {
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: [room] });
  initCursorIfNew(identity.name, identity.projectPath, room);
  const result = insertMessage({
    type: 'system',
    fromAgent: identity.name,
    fromProject: identity.projectPath,
    room,
    content,
  });
  updateCursor(identity.name, identity.projectPath, room, Number(result.id));
  return result;
}

try {
  if (getFlag('claim')) {
    const taskId = parseInt(getFlag('claim'), 10);
    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
    const task = getPlanTask(taskId);
    if (!task) { console.error(`Task #${taskId} not found`); process.exit(1); }

    const plan = getPlan(task.plan_id);
    const success = claimTask(taskId, identity.name);

    if (success) {
      postSystemMessage(identity, plan.room,
        `${identity.name} claimed task #${taskId}: ${task.title} (plan #${plan.id})`);
      out({ ok: true, taskId, owner: identity.name,
        _text: `Claimed task #${taskId}: ${task.title} (plan #${plan.id})` });
    } else {
      const current = getPlanTask(taskId);
      console.error(`Task #${taskId} is ${current.status}${current.owner ? ` (owned by ${current.owner})` : ''} — cannot claim`);
      process.exit(1);
    }

  } else if (getFlag('complete')) {
    const taskId = parseInt(getFlag('complete'), 10);
    const status = getFlag('status') || 'done';
    const reason = getFlag('reason');
    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });

    if (!['done', 'blocked'].includes(status)) {
      console.error(`--status must be 'done' or 'blocked'`);
      process.exit(1);
    }

    const task = getPlanTask(taskId);
    if (!task) { console.error(`Task #${taskId} not found`); process.exit(1); }
    if (task.owner !== identity.name) {
      console.error(`Task #${taskId} is owned by ${task.owner || 'nobody'}, not ${identity.name}`);
      process.exit(1);
    }

    const plan = getPlan(task.plan_id);
    completeTask(taskId, identity.name, { status, reason });

    if (status === 'blocked') {
      postSystemMessage(identity, plan.room,
        `${identity.name} blocked task #${taskId}: ${task.title} — ${reason || 'no reason given'} (plan #${plan.id})`);
      out({ ok: true, taskId, status: 'blocked', reason,
        _text: `Blocked task #${taskId}: ${task.title} — ${reason || 'no reason given'} (plan #${plan.id})` });
    } else {
      postSystemMessage(identity, plan.room,
        `${identity.name} completed task #${taskId}: ${task.title} (plan #${plan.id})`);
      out({ ok: true, taskId, status: 'done',
        _text: `Completed task #${taskId}: ${task.title} (plan #${plan.id})` });
    }

  } else if (getFlag('release')) {
    const taskId = parseInt(getFlag('release'), 10);
    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
    const task = getPlanTask(taskId);
    if (!task) { console.error(`Task #${taskId} not found`); process.exit(1); }

    const plan = getPlan(task.plan_id);
    const success = releaseTask(taskId, identity.name);

    if (success) {
      postSystemMessage(identity, plan.room,
        `${identity.name} released task #${taskId}: ${task.title} back to pending (plan #${plan.id})`);
      out({ ok: true, taskId, status: 'pending',
        _text: `Released task #${taskId}: ${task.title} back to pending (plan #${plan.id})` });
    } else {
      console.error(`Cannot release task #${taskId} — not in_progress, or not owner and not stale (>2h)`);
      process.exit(1);
    }

  } else if (getFlag('status')) {
    const planId = parseInt(getFlag('status'), 10);
    const plan = getPlan(planId);
    if (!plan) { console.error(`Plan #${planId} not found`); process.exit(1); }

    const tasks = getPlanTasks(planId);
    const staleThreshold = 2 * 60 * 60 * 1000;

    if (jsonOut) {
      const taskData = tasks.map(t => {
        const stale = t.status === 'in_progress' && t.claimed_at &&
          (Date.now() - new Date(t.claimed_at + 'Z').getTime() > staleThreshold);
        return { ...t, stale };
      });
      console.log(JSON.stringify({ plan: { id: plan.id, title: plan.title, status: plan.status }, tasks: taskData }));
    } else {
      console.log(`Plan #${plan.id}: ${plan.title} [${plan.status}]`);
      console.log('');
      const pending = tasks.filter(t => t.status === 'pending');
      const inProgress = tasks.filter(t => t.status === 'in_progress');
      const done = tasks.filter(t => t.status === 'done');
      const blocked = tasks.filter(t => t.status === 'blocked');

      if (inProgress.length > 0) {
        console.log('In Progress:');
        for (const t of inProgress) {
          const stale = t.claimed_at &&
            (Date.now() - new Date(t.claimed_at + 'Z').getTime() > staleThreshold);
          const staleTag = stale ? ' [STALE >2h]' : '';
          console.log(`  ${t.seq}. ${t.title} → ${t.owner}${staleTag}`);
        }
      }
      if (pending.length > 0) {
        console.log('Pending:');
        for (const t of pending) {
          console.log(`  ${t.seq}. ${t.title}`);
        }
      }
      if (done.length > 0) {
        console.log('Done:');
        for (const t of done) {
          console.log(`  ${t.seq}. ${t.title} → ${t.owner}`);
        }
      }
      if (blocked.length > 0) {
        console.log('Blocked:');
        for (const t of blocked) {
          console.log(`  ${t.seq}. ${t.title} → ${t.owner} — ${t.blocked_reason || 'no reason'}`);
        }
      }
      console.log(`\nSummary: ${done.length} done, ${inProgress.length} in progress, ${pending.length} pending, ${blocked.length} blocked`);
    }

  } else {
    console.error(`Usage:
  chat-claim.js --claim <task-id> --name <agent>
  chat-claim.js --complete <task-id> --name <agent> [--status done|blocked] [--reason '<text>']
  chat-claim.js --release <task-id> --name <agent>
  chat-claim.js --status <plan-id>`);
    process.exit(1);
  }
} finally {
  closeDb();
}
