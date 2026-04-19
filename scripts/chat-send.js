#!/usr/bin/env node
// Send a message to a room.
// Usage: node chat-send.js --name <agent> --project <path> --room <room> --message "<text>" [--to <agent>] [--type message|question]

import { upsertAgent, insertMessage, initCursorIfNew, updateCursor, getMessage, getOnlineAgents, projectHash, closeDb, getAllRooms, PROTECTED_ROOMS, checkPhaseAllowed, getActivePlanInRoom, getPhase, claimTask, getPlanTask } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { formatSendConfirm, parseMentions } from '../lib/format.js';
import { touchSentinel } from '../lib/sentinel.js';


import { args, getFlag } from '../lib/args.js';

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const room = getFlag('room') || identity.currentRoom || 'lobby';
const message = getFlag('message');
const toAgent = getFlag('to');
const type = getFlag('type') || 'message';
const replyTo = getFlag('reply-to');
const parentId = replyTo ? parseInt(replyTo, 10) : undefined;
const urgent = args.includes('--urgent');
const evidence = getFlag('evidence');
const jsonOut = args.includes('--json');
const agreeFlag = args.includes('--agree');
const disagreeFlag = args.includes('--disagree');
const topicFlag = getFlag('topic');
const rationaleFlag = getFlag('rationale');
const discussionPhase = getFlag('discussion-phase');
const VALID_PHASES = ['brainstorming', 'converging', 'decided'];

if (discussionPhase && !VALID_PHASES.includes(discussionPhase)) {
  console.error(`Error: --discussion-phase must be one of: ${VALID_PHASES.join(', ')}`);
  process.exit(1);
}

if (!message) {
  console.error('Usage: node chat-send.js --message "<text>" [--name agent] [--project path] [--room room] [--to agent] [--type message|question] [--reply-to <id>] [--urgent] [--evidence "<proof>"] [--agree|--disagree --topic <topic> [--rationale <text>]] [--discussion-phase <brainstorming|converging|decided>] [--json]');
  process.exit(1);
}

if (agreeFlag && disagreeFlag) {
  console.error('Error: --agree and --disagree are mutually exclusive.');
  process.exit(1);
}

if (agreeFlag && !rationaleFlag) {
  console.error('Error: --agree requires --rationale. Every agreement must state what was examined.');
  process.exit(1);
}

try {
  const mentions = parseMentions(message);
  const priority = urgent ? 'urgent' : 'normal';
  const metadata = { mentions, priority };
  if (evidence) metadata.evidence = evidence;
  if (agreeFlag) {
    metadata.consensus_signal = 'agree';
    if (topicFlag) metadata.topic = topicFlag;
    metadata.rationale = rationaleFlag;
  } else if (disagreeFlag) {
    metadata.consensus_signal = 'disagree';
    if (topicFlag) metadata.topic = topicFlag;
    if (rationaleFlag) metadata.rationale = rationaleFlag;
  }
  if (discussionPhase) metadata.discussion_phase = discussionPhase;

  if (agreeFlag || disagreeFlag) {
    const op = agreeFlag ? 'send:agree' : 'send:disagree';
    const phaseCheck = checkPhaseAllowed(room, op);
    if (!phaseCheck.allowed) {
      const signal = agreeFlag ? '/agree' : '/disagree';
      console.warn(`Warning: ${signal} signals are most meaningful in peer_review or review phase. Current phase: ${phaseCheck.current || 'none'}.`);
    }
  }

  // Validate room exists before sending
  const knownRooms = new Set([...getAllRooms(), ...PROTECTED_ROOMS]);
  if (!knownRooms.has(room)) {
    console.error(`Error: Room '${room}' does not exist. Check the room name and try again.`);
    process.exit(1);
  }

  // Plan guard: block top-level messages when a plan is active and room is in execute phase,
  // unless the sender provides an explicit escape hatch (--reply-to / --task / --claim / --no-plan-guard).
  const taskFlag = getFlag('task');
  const claimFlag = getFlag('claim');
  const bypassGuard = args.includes('--no-plan-guard');
  const hasEscape = parentId || taskFlag || claimFlag || bypassGuard;
  if (!hasEscape) {
    const activePlan = getActivePlanInRoom(room);
    const phaseRecord = getPhase(room);
    const inExecute = phaseRecord && phaseRecord.phase === 'execute';
    if (activePlan && inExecute) {
      console.error(
        `Error: plan #${activePlan.id} active in [${room}] (phase=execute). New top-level message requires an escape hatch.\n` +
        `  Claim:  add --claim <task-id>  (runs preclaim + sets [DOING])\n` +
        `  Task:   add --task <task-id>   (explicit reference, no claim)\n` +
        `  Reply:  add --reply-to <msg-id>\n` +
        `  Skip:   add --no-plan-guard    (written to metadata.plan_guard_bypassed for audit)`
      );
      process.exit(1);
    }
  }

  // --claim sugar: atomically claim the task, then append [DOING] tag to content.
  let finalContent = message;
  if (claimFlag) {
    const claimTaskId = parseInt(claimFlag, 10);
    if (isNaN(claimTaskId)) {
      console.error(`Error: --claim requires a numeric task id (got '${claimFlag}').`);
      process.exit(1);
    }
    const preTask = getPlanTask(claimTaskId);
    if (!preTask) { console.error(`Error: Task #${claimTaskId} not found.`); process.exit(1); }
    const alreadyMine = preTask.status === 'in_progress' && preTask.owner === identity.name;
    if (!alreadyMine && preTask.status !== 'pending') {
      console.error(`Error: Task #${claimTaskId} is ${preTask.status}${preTask.owner ? ` (owned by ${preTask.owner})` : ''}. Aborting send.`);
      process.exit(1);
    }
    if (!alreadyMine) {
      const claimed = claimTask(claimTaskId, identity.name);
      if (!claimed) {
        const post = getPlanTask(claimTaskId);
        console.error(`Error: Task #${claimTaskId} already claimed by ${post.owner || 'unknown'} (race lost). Aborting send.`);
        process.exit(1);
      }
    }
    if (!/\[DOING\]/i.test(finalContent)) {
      finalContent = `${finalContent} [DOING]`;
    }
  }

  // --no-plan-guard: audit the bypass in message metadata so reviewers can find it.
  if (bypassGuard) {
    metadata.plan_guard_bypassed = true;
    console.error('[plan guard bypassed — logged to metadata.plan_guard_bypassed]');
  }

  // Warn if sending to a room different from the agent's current room
  if (getFlag('room') && room !== identity.currentRoom) {
    process.stderr.write(`Note: sent to [${room}] (your current room is [${identity.currentRoom}]).\n`);
  }

  upsertAgent({ name: identity.name, projectPath: identity.projectPath, currentRoom: identity.currentRoom });
  initCursorIfNew(identity.name, identity.projectPath, room);
  const result = insertMessage({
    type,
    fromAgent: identity.name,
    fromProject: identity.projectPath,
    toAgent,
    room,
    content: finalContent,
    metadata,
    parentId,
  });
  // Advance cursor past own message so hooks don't false-trigger
  updateCursor(identity.name, identity.projectPath, room, Number(result.id));

  // Touch sentinel files for fast-path notification
  try {
    if (parentId) {
      // Reply: touch only the parent message author's sentinel
      const parent = getMessage(parentId);
      if (parent && parent.from_agent !== identity.name) {
        touchSentinel(projectHash(parent.from_project), parent.from_agent);
      }
    } else {
      // Broadcast (or DM): touch sentinels for target agents
      const agents = getOnlineAgents();
      for (const a of agents) {
        if (a.name === identity.name && a.project_hash === projectHash(identity.projectPath)) continue;
        if (toAgent && a.name !== toAgent) continue;
        if (!toAgent && a.current_room !== room) continue;
        touchSentinel(a.project_hash, a.name);
      }
    }
  } catch {
    // Sentinel touching is best-effort
  }


  // --- ADR Logger: auto-capture [DECISION] tagged messages ---
  if (/(?:^|\n)[ \t*_>]*\[DECISION\]/i.test(message)) {
    try {
      const { adrLogDecision, CANONICAL_PROJECT } = await import('./adr-logger.js');
      adrLogDecision({ content: message, id: Number(result.id), created_at: new Date().toISOString(), from_agent: identity.name }, CANONICAL_PROJECT, room);
    } catch {
      // ADR logging is best-effort — never block message delivery
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, id: Number(result.id), from: identity.name, room, type, parent_id: parentId || null, mentions, priority }));
  } else {
    console.log(formatSendConfirm(Number(result.id), room));
  }
} finally {
  closeDb();
}
