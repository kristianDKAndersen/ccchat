#!/usr/bin/env node
// Compact room history into an LLM-generated digest.
// Usage: node chat-compact.js --room <room> [--hot 20] [--limit 200] [--dry-run] [--json] [--name agent] [--project path]

import { spawnSync } from 'child_process';
import { getHistory, getMessageCount, insertMessage, pinMessage, getPinnedMessages, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { parseMetadata, formatMessage } from '../lib/format.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const room = getFlag('room') || 'general';
const hotCount = parseInt(getFlag('hot') || '20', 10);
const limit = parseInt(getFlag('limit') || '200', 10);
const dryRun = args.includes('--dry-run');
const jsonOut = args.includes('--json');

try {
  const totalMessages = getMessageCount(room);

  if (totalMessages <= hotCount) {
    const msg = `Room [${room}] has ${totalMessages} message(s) — nothing to compact (hot threshold: ${hotCount}).`;
    if (jsonOut) console.log(JSON.stringify({ status: 'skipped', reason: 'below_threshold', total: totalMessages, hot: hotCount }));
    else console.log(msg);
    process.exit(0);
  }

  // Fetch working set: hot + limit messages from the tail
  const fetchCount = Math.min(hotCount + limit, totalMessages);
  const { messages } = getHistory(room, fetchCount);

  // Partition: HOT = last hotCount, WARM = the rest
  const hot = messages.slice(-hotCount);
  const warm = messages.slice(0, messages.length - hotCount);

  if (warm.length === 0) {
    const msg = `Room [${room}] has ${messages.length} message(s) — all within hot threshold (${hotCount}). Nothing to compact.`;
    if (jsonOut) console.log(JSON.stringify({ status: 'skipped', reason: 'all_hot', total: messages.length, hot: hotCount }));
    else console.log(msg);
    process.exit(0);
  }

  const warmMinId = warm[0].id;
  const warmMaxId = warm[warm.length - 1].id;

  // Check for existing digest covering this range
  const pinned = getPinnedMessages(room);
  const existingDigest = pinned.find(m => {
    const meta = parseMetadata(m.metadata);
    if (!meta.compact) return false;
    const [covMin, covMax] = meta.covers_ids || [];
    // Overlap: existing digest covers some of the same messages
    return covMin <= warmMaxId && covMax >= warmMinId;
  });

  if (existingDigest) {
    const meta = parseMetadata(existingDigest.metadata);
    const msg = `Existing digest #${existingDigest.id} already covers IDs ${meta.covers_ids[0]}-${meta.covers_ids[1]} (overlaps with ${warmMinId}-${warmMaxId}). Use --force to compact anyway.`;
    if (!args.includes('--force')) {
      if (jsonOut) console.log(JSON.stringify({ status: 'skipped', reason: 'existing_digest', digest_id: existingDigest.id, covers: meta.covers_ids }));
      else console.log(msg);
      process.exit(0);
    }
  }

  // Time range
  const warmStart = warm[0].created_at;
  const warmEnd = warm[warm.length - 1].created_at;

  // Dry-run output
  if (dryRun) {
    const stats = {
      room,
      total_messages: totalMessages,
      hot: { count: hot.length, ids: `${hot[0].id}-${hot[hot.length - 1].id}` },
      warm: { count: warm.length, ids: `${warmMinId}-${warmMaxId}`, time_range: `${warmStart} — ${warmEnd}` },
      agents: [...new Set(warm.map(m => m.from_agent))],
    };
    if (jsonOut) {
      console.log(JSON.stringify({ status: 'dry_run', ...stats }));
    } else {
      console.log(`Compact dry-run for [${room}]:`);
      console.log(`  Total messages: ${stats.total_messages}`);
      console.log(`  HOT (preserved): ${stats.hot.count} messages (#${stats.hot.ids})`);
      console.log(`  WARM (to summarize): ${stats.warm.count} messages (#${stats.warm.ids})`);
      console.log(`  Time range: ${stats.warm.time_range}`);
      console.log(`  Agents: ${stats.agents.join(', ')}`);
    }
    process.exit(0);
  }

  // Build prompt for Claude CLI
  const formattedMessages = warm.map(m => {
    const meta = parseMetadata(m.metadata);
    const tags = [];
    if (meta.priority === 'urgent') tags.push('[URGENT]');
    if (meta.task_status) tags.push(`[${meta.task_status.toUpperCase()}]`);
    if (meta.evidence) tags.push('[verified]');
    if (m.pinned) tags.push('[PIN]');
    const tagStr = tags.length ? ' ' + tags.join(' ') : '';
    const reply = m.parent_id ? ` (reply to #${m.parent_id})` : '';
    return `#${m.id} ${m.from_agent}${tagStr} (${m.created_at})${reply}:\n${m.content}`;
  }).join('\n\n');

  // Truncate if too large (>80K chars)
  let promptMessages = formattedMessages;
  if (promptMessages.length > 80000) {
    // Drop oldest messages until under limit
    const truncated = [];
    let charCount = 0;
    for (let i = warm.length - 1; i >= 0; i--) {
      const entry = `#${warm[i].id} ${warm[i].from_agent} (${warm[i].created_at}):\n${warm[i].content}`;
      if (charCount + entry.length > 78000) break;
      truncated.unshift(entry);
      charCount += entry.length;
    }
    promptMessages = truncated.join('\n\n');
  }

  const prompt = `You are summarizing a chat room's message history into a concise digest.

Room: ${room}
Messages: ${warm.length} messages from IDs #${warmMinId} to #${warmMaxId}
Time range: ${warmStart} to ${warmEnd}
Agents: ${[...new Set(warm.map(m => m.from_agent))].join(', ')}

Produce a structured summary with these sections:
## Key Decisions
## Action Items
## Open Questions
## Context & Background

Rules:
- Preserve agent names, specific technical details, URLs, code references, file paths.
- Note who decided or proposed what.
- Drop greetings, acknowledgments, off-topic chatter.
- Keep the digest under 2000 characters.
- If there are no items for a section, write "None."

--- MESSAGES ---
${promptMessages}`;

  // Invoke Claude CLI
  const result = spawnSync('claude', ['-p'], {
    input: prompt,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Error: `claude` CLI not found in PATH. Install it first: https://docs.anthropic.com/en/docs/claude-code');
    } else {
      console.error(`Error invoking claude: ${result.error.message}`);
    }
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`claude exited with code ${result.status}`);
    if (result.stderr) console.error(result.stderr);
    process.exit(1);
  }

  const digest = result.stdout.trim();
  if (!digest) {
    console.error('Claude returned an empty response.');
    process.exit(1);
  }

  // Insert digest as pinned system message
  const metadata = {
    compact: true,
    covers_ids: [warmMinId, warmMaxId],
    message_count: warm.length,
    hot_threshold: hotCount,
  };

  const { id } = insertMessage({
    type: 'system',
    fromAgent: identity.name,
    fromProject: identity.projectPath,
    room,
    content: `[DIGEST] Room compaction — ${warm.length} messages (#${warmMinId}-#${warmMaxId})\n\n${digest}`,
    metadata,
  });

  pinMessage(id);

  if (jsonOut) {
    console.log(JSON.stringify({
      status: 'compacted',
      digest_id: id,
      room,
      summarized: warm.length,
      covers_ids: [warmMinId, warmMaxId],
      hot_preserved: hot.length,
    }));
  } else {
    console.log(`Compacted ${warm.length} messages in [${room}] → digest #${id} (pinned)`);
    console.log(`  Covers: #${warmMinId}-#${warmMaxId} (${warmStart} — ${warmEnd})`);
    console.log(`  HOT preserved: ${hot.length} messages`);
  }
} finally {
  closeDb();
}
