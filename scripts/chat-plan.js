#!/usr/bin/env node
// Collaborative planning system.
// Usage:
//   node chat-plan.js --create --title 'Plan title' --room general --name agent [--source <msg-id>]
//   node chat-plan.js --activate <plan-id> --name agent
//   node chat-plan.js --add-task <plan-id> --title 'Task title' [--description '...'] [--verify '...']
//   node chat-plan.js --show <plan-id>
//   node chat-plan.js --list [--status active]
//   node chat-plan.js --complete <plan-id> --name agent

import {
  createPlan, getPlan, listPlans, updatePlanStatus,
  addPlanTask, getPlanTasks, insertMessage, upsertAgent,
  initCursorIfNew, updateCursor, closeDb
} from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}
function hasFlag(name) { return args.includes(`--${name}`); }

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
  if (hasFlag('create')) {
    const title = getFlag('title');
    const room = getFlag('room') || 'general';
    const source = getFlag('source') ? parseInt(getFlag('source'), 10) : null;
    if (!title) { console.error('--title is required'); process.exit(1); }

    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
    const { id } = createPlan({ title, room, createdBy: identity.name, sourceMessageId: source });
    postSystemMessage(identity, room, `${identity.name} created draft plan #${id}: ${title}`);

    out({ ok: true, id, title, status: 'draft', _text: `Created draft plan #${id}: ${title}` });

  } else if (getFlag('activate')) {
    const planId = parseInt(getFlag('activate'), 10);
    const plan = getPlan(planId);
    if (!plan) { console.error(`Plan #${planId} not found`); process.exit(1); }
    if (plan.status !== 'draft') { console.error(`Plan #${planId} is ${plan.status}, not draft`); process.exit(1); }

    const tasks = getPlanTasks(planId);
    if (tasks.length === 0) { console.error(`Plan #${planId} has no tasks. Add tasks before activating.`); process.exit(1); }

    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
    updatePlanStatus(planId, 'active');

    const taskList = tasks.map(t => `  ${t.seq}. ${t.title}`).join('\n');
    postSystemMessage(identity, plan.room,
      `${identity.name} activated plan #${planId}: ${plan.title}\nTasks:\n${taskList}`);

    out({ ok: true, id: planId, status: 'active', tasks: tasks.length,
      _text: `Activated plan #${planId}: ${plan.title} (${tasks.length} tasks)` });

  } else if (getFlag('add-task')) {
    const planId = parseInt(getFlag('add-task'), 10);
    const title = getFlag('title');
    if (!title) { console.error('--title is required'); process.exit(1); }

    const plan = getPlan(planId);
    if (!plan) { console.error(`Plan #${planId} not found`); process.exit(1); }
    if (plan.status !== 'draft') { console.error(`Can only add tasks to draft plans (plan #${planId} is ${plan.status})`); process.exit(1); }

    const description = getFlag('description');
    const verify = getFlag('verify');
    const { id, seq } = addPlanTask({ planId, title, description, verify });

    out({ ok: true, id, planId, seq, title,
      _text: `Added task #${id} (seq ${seq}) to plan #${planId}: ${title}` });

  } else if (getFlag('show')) {
    const planId = parseInt(getFlag('show'), 10);
    const plan = getPlan(planId);
    if (!plan) { console.error(`Plan #${planId} not found`); process.exit(1); }

    const tasks = getPlanTasks(planId);

    if (jsonOut) {
      console.log(JSON.stringify({ ...plan, tasks }));
    } else {
      console.log(`Plan #${plan.id}: ${plan.title} [${plan.status}]`);
      console.log(`  Room: ${plan.room} | Created by: ${plan.created_by} | ${plan.created_at}`);
      if (plan.source_message_id) console.log(`  Source: message #${plan.source_message_id}`);
      console.log('');
      if (tasks.length === 0) {
        console.log('  (no tasks)');
      } else {
        for (const t of tasks) {
          const owner = t.owner ? ` → ${t.owner}` : '';
          const blocked = t.blocked_reason ? ` — ${t.blocked_reason}` : '';
          console.log(`  ${t.seq}. [${t.status}] ${t.title}${owner}${blocked}`);
          if (t.description) console.log(`     ${t.description}`);
          if (t.verify) console.log(`     Verify: ${t.verify}`);
        }
      }
    }

  } else if (hasFlag('list')) {
    const status = getFlag('status');
    const room = getFlag('room');
    const plans = listPlans({ status, room });

    if (jsonOut) {
      console.log(JSON.stringify(plans));
    } else if (plans.length === 0) {
      console.log('No plans found.');
    } else {
      for (const p of plans) {
        console.log(`#${p.id} [${p.status}] ${p.title} (${p.room}, by ${p.created_by})`);
      }
    }

  } else if (getFlag('complete')) {
    const planId = parseInt(getFlag('complete'), 10);
    const plan = getPlan(planId);
    if (!plan) { console.error(`Plan #${planId} not found`); process.exit(1); }
    if (plan.status !== 'active') { console.error(`Plan #${planId} is ${plan.status}, not active`); process.exit(1); }

    const tasks = getPlanTasks(planId);
    const pending = tasks.filter(t => t.status === 'pending' || t.status === 'in_progress');
    if (pending.length > 0) {
      console.error(`Cannot complete plan #${planId}: ${pending.length} task(s) still pending/in-progress`);
      process.exit(1);
    }

    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
    updatePlanStatus(planId, 'completed');
    postSystemMessage(identity, plan.room, `${identity.name} completed plan #${planId}: ${plan.title}`);

    out({ ok: true, id: planId, status: 'completed',
      _text: `Completed plan #${planId}: ${plan.title}` });

  } else {
    console.error(`Usage:
  chat-plan.js --create --title '<title>' --room <room> --name <agent> [--source <msg-id>]
  chat-plan.js --activate <plan-id> --name <agent>
  chat-plan.js --add-task <plan-id> --title '<title>' [--description '...'] [--verify '...']
  chat-plan.js --show <plan-id>
  chat-plan.js --list [--status active] [--room <room>]
  chat-plan.js --complete <plan-id> --name <agent>`);
    process.exit(1);
  }
} finally {
  closeDb();
}
