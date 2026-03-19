#!/usr/bin/env node
// Post a question and poll for replies.
// Usage: node chat-ask.js --name <agent> --project <path> --question "<text>" [--room general] [--timeout 120]

import { upsertAgent, insertMessage, getMessagesSince, getThreadReplies, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { formatMessage, formatSendConfirm, parseMentions } from '../lib/format.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const question = getFlag('question');
const room = getFlag('room') || 'general';
const timeout = parseInt(getFlag('timeout') || '120', 10);
const urgent = args.includes('--urgent');
const pretty = args.includes('--pretty');

if (!question) {
  console.error('Usage: node chat-ask.js --question "<text>" [--name agent] [--project path] [--room room] [--timeout 120]');
  process.exit(1);
}

async function main() {
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: [room] });
  initCursorIfNew(identity.name, identity.projectPath, room);

  // Post question
  const mentions = parseMentions(question);
  const priority = urgent ? 'urgent' : 'normal';
  const metadata = { mentions, priority };
  const { id: questionId } = insertMessage({
    type: 'question',
    fromAgent: identity.name,
    fromProject: identity.projectPath,
    room,
    content: question,
    metadata,
  });
  console.error(`Question posted: id=${questionId}`);

  // Poll for replies
  const deadline = Date.now() + timeout * 1000;
  const responses = [];
  let lastCheckedId = Number(questionId);

  while (Date.now() < deadline) {
    await sleep(3000);

    const replies = getThreadReplies(Number(questionId), room);
    const newReplies = replies.filter(r => r.id > lastCheckedId && r.from_agent !== identity.name);
    for (const m of newReplies) {
      lastCheckedId = Math.max(lastCheckedId, m.id);
      responses.push({
        id: m.id,
        from: m.from_agent,
        type: m.type,
        content: m.content,
        parent_id: m.parent_id,
        created_at: m.created_at,
      });
    }

    // If we have responses and no new ones came in this cycle, wait one more round then stop
    if (responses.length > 0 && newReplies.length === 0) {
      await sleep(5000);
      const finalReplies = getThreadReplies(Number(questionId), room).filter(r => r.id > lastCheckedId && r.from_agent !== identity.name);
      for (const m of finalReplies) {
        lastCheckedId = Math.max(lastCheckedId, m.id);
        responses.push({
          id: m.id,
          from: m.from_agent,
          type: m.type,
          content: m.content,
          parent_id: m.parent_id,
          created_at: m.created_at,
        });
      }
      break;
    }
  }

  closeDb();

  if (pretty) {
    console.log(formatSendConfirm(Number(questionId), room) + ' (question)');
    if (responses.length === 0) {
      console.log('No replies received.');
    } else {
      console.log(`${responses.length} repl${responses.length !== 1 ? 'ies' : 'y'}:`);
      for (const r of responses) {
        console.log(formatMessage(r));
      }
    }
  } else {
    console.log(JSON.stringify({
      question_id: Number(questionId),
      question,
      room,
      responses,
    }, null, 2));
  }

  // Exit with code 1 if timeout with no responses
  if (responses.length === 0) {
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); closeDb(); process.exit(1); });
