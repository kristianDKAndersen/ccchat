#!/usr/bin/env node
// Collaborative planning system.
// Usage:
//   node chat-plan.js --create --title 'Plan title' --room general --name agent [--source <msg-id>]
//   node chat-plan.js --activate <plan-id> --name agent
//   node chat-plan.js --add-task <plan-id> --title 'Task title' [--description '...'] [--verify '...']
//   node chat-plan.js --show <plan-id>
//   node chat-plan.js --list [--status active]
//   node chat-plan.js --complete <plan-id> --name agent
//   node chat-plan.js --cancel <plan-id> --name agent

import {
  createPlan, getPlan, listPlans, updatePlanStatus,
  addPlanTask, getPlanTasks, claimTask, releaseTask, closeDb,
  claimPlanner, releasePlanner, checkPhaseAllowed
} from '../lib/db.js';
import { postSystemMessage } from '../lib/system-message.js';
import { resolveIdentity } from '../lib/identity.js';

import { args, getFlag, hasFlag } from '../lib/args.js';

const jsonOut = args.includes('--json');

function out(obj) {
  if (jsonOut) console.log(JSON.stringify(obj));
  else console.log(obj._text || JSON.stringify(obj));
}

// postSystemMessage moved to lib/system-message.js (plan #53, task #233).
// Previous local copy called upsertAgent() with a currentRoom override,
// silently moving the caller into the target room as a side effect.

try {
  if (hasFlag('claim-planner')) {
    const room = getFlag('room') || 'general';
    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
    const result = claimPlanner(room, identity.name);
    if (result.success) {
      out({ ok: true, room, agent: identity.name, _text: `Planner role claimed for #${room} by ${identity.name}` });
    } else {
      console.error(`Planner role for room '${room}' already held by ${result.claimant}. Try again in 15 minutes or wait for them to start the plan.`);
      process.exit(1);
    }

  } else if (hasFlag('create')) {
    const title = getFlag('title');
    const room = getFlag('room') || 'general';
    const source = getFlag('source') ? parseInt(getFlag('source'), 10) : null;
    if (!title) { console.error('--title is required'); process.exit(1); }

    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });

    const phaseCheck = checkPhaseAllowed(room, 'plan:create');
    if (!phaseCheck.allowed) {
      console.error(`Error: Cannot create plan in phase '${phaseCheck.current}'. Plan creation requires brainstorm or draft phase.`);
      process.exit(1);
    }

    // Option B safety net: reject if an active or draft plan already exists for this room.
    // Prevents duplicate plans even if the planner-claim step (Option C) is skipped.
    const existing = listPlans({ room }).filter(p => p.status === 'draft' || p.status === 'active');
    if (existing.length > 0) {
      const p = existing[0];
      console.error(`Error: Room '${room}' already has an ${p.status} plan: #${p.id} "${p.title}" (by ${p.created_by}). Complete or abandon it before creating a new one.`);
      process.exit(1);
    }

    const { id } = createPlan({ title, room, createdBy: identity.name, sourceMessageId: source });
    releasePlanner(room); // Release the planner lock now that the plan exists
    postSystemMessage(identity, room, `${identity.name} created draft plan #${id}: ${title}`);

    out({ ok: true, id, title, status: 'draft', _text: `Created draft plan #${id}: ${title}` });

  } else if (getFlag('activate')) {
    const planId = parseInt(getFlag('activate'), 10);
    const plan = getPlan(planId);
    if (!plan) { console.error(`Plan #${planId} not found`); process.exit(1); }
    if (plan.status !== 'draft') { console.error(`Plan #${planId} is ${plan.status}, not draft`); process.exit(1); }

    const activatePhaseCheck = checkPhaseAllowed(plan.room, 'plan:activate');
    if (!activatePhaseCheck.allowed) {
      console.error(`Error: Cannot activate plan in phase '${activatePhaseCheck.current}'. Plan activation requires draft phase.`);
      process.exit(1);
    }

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

  } else if (hasFlag('quick')) {
    const title = getFlag('quick');
    const room = getFlag('room') || 'general';
    if (!title) { console.error("--quick requires a title (e.g. --quick 'write doc')"); process.exit(1); }

    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });

    const existing = listPlans({ room }).filter(p => p.status === 'draft' || p.status === 'active');
    if (existing.length > 0) {
      const p = existing[0];
      console.error(`Error: Room '${room}' already has an ${p.status} plan: #${p.id} "${p.title}" (by ${p.created_by}). Complete or abandon it before creating a new one.`);
      process.exit(1);
    }

    const quickPhaseCheck = checkPhaseAllowed(room, 'task:claim');
    if (!quickPhaseCheck.allowed) {
      console.error(`Error: Cannot use --quick in phase '${quickPhaseCheck.current}'. Use --quick only in execute phase.`);
      process.exit(1);
    }

    // Create plan
    const { id: planId } = createPlan({ title, room, createdBy: identity.name, sourceMessageId: null });

    // Add single task with same title
    const { id: taskId } = addPlanTask({ planId, title, description: 'Quick-plan task', verify: null });

    // Activate plan
    updatePlanStatus(planId, 'active');

    // Claim task atomically — first writer wins
    const claimed = claimTask(taskId, identity.name);
    if (!claimed) {
      console.error(`Unexpected: failed to claim task #${taskId} after creation`);
      process.exit(1);
    }

    postSystemMessage(identity, room,
      `${identity.name} quick-plan: created plan #${planId} + claimed task #${taskId}: ${title}`);

    out({ ok: true, planId, taskId, owner: identity.name,
      _text: `Quick plan #${planId} created. Task #${taskId} claimed by ${identity.name}: ${title}` });

  } else if (getFlag('cancel')) {
    const planId = parseInt(getFlag('cancel'), 10);
    const plan = getPlan(planId);
    if (!plan) { console.error(`Plan #${planId} not found`); process.exit(1); }
    if (plan.status === 'abandoned' || plan.status === 'completed') {
      console.error(`Plan #${planId} is already ${plan.status}`); process.exit(1);
    }

    // Release any in_progress tasks before cancelling.
    // Warn loudly so the action is visible — silent task release is destructive.
    const tasks = getPlanTasks(planId);
    const active = tasks.filter(t => t.status === 'in_progress' && t.owner);
    if (active.length > 0) {
      console.error(`Warning: releasing ${active.length} in-progress task(s) before abandoning plan #${planId}:`);
      for (const t of active) {
        console.error(`  - Task #${t.id}: ${t.title} (owned by ${t.owner})`);
        releaseTask(t.id, t.owner);
      }
    }

    const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
    updatePlanStatus(planId, 'abandoned');
    postSystemMessage(identity, plan.room,
      `${identity.name} abandoned plan #${planId}: ${plan.title}${active.length ? ` (${active.length} in-progress task(s) released)` : ''}`);

    out({ ok: true, id: planId, status: 'abandoned', tasksReleased: active.length,
      _text: `Abandoned plan #${planId}: ${plan.title}` + (active.length ? ` (${active.length} task(s) released)` : '') });

    } else {
    console.error(`Usage:
  chat-plan.js --create --title '<title>' --room <room> --name <agent> [--source <msg-id>]
  chat-plan.js --activate <plan-id> --name <agent>
  chat-plan.js --add-task <plan-id> --title '<title>' [--description '...'] [--verify '...']
  chat-plan.js --show <plan-id>
  chat-plan.js --list [--status active] [--room <room>]
  chat-plan.js --complete <plan-id> --name <agent>
  chat-plan.js --quick '<title>' --room <room> --name <agent>
  chat-plan.js --cancel <plan-id> --name <agent>`);
    process.exit(1);
  }
} finally {
  closeDb();
}
