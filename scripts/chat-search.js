#!/usr/bin/env node
// Search messages by content with optional filters.
// Usage: node chat-search.js [--query "<text>"] [--room <room>] [--limit 20] [--pinned] [--verified] [--by <agent>] [--risk] [--json]
// --query is optional when --pinned, --verified, --by, or --risk is set (browse mode).
// --room defaults to the agent's primary room (from identity), fallback 'lobby'.

import { searchMessages, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { formatMessage, parseMetadata } from '../lib/format.js';

import { args, getFlag } from '../lib/args.js';

const riskOnly = args.includes('--risk');
const pinnedOnly = args.includes('--pinned');
const verifiedOnly = args.includes('--verified');
const bypassedOnly = args.includes('--bypassed');
const byAgent = getFlag('by');
const filterActive = riskOnly || pinnedOnly || verifiedOnly || bypassedOnly || byAgent;

// --query is optional when a filter flag is set (empty query = match all in room)
const query = getFlag('query') || (riskOnly ? '[RISK' : (filterActive ? '' : null));

// Default room: agent's primary room from identity, fallback 'lobby'
const identity = resolveIdentity({ name: getFlag('name'), project: getFlag('project') });
const defaultRoom = identity.currentRoom || 'lobby';
const room = getFlag('room') || defaultRoom;

const limit = parseInt(getFlag('limit') || '20', 10);
const jsonOut = args.includes('--json');

if (query === null) {
  console.error('Usage: node chat-search.js --query "<text>" [--room <room>] [--limit 20] [--pinned] [--verified] [--risk] [--bypassed] [--by <agent>] [--json]');
  console.error('Tip: --query is optional when --pinned, --verified, --risk, --bypassed, or --by is set.');
  process.exit(1);
}

try {
  // Fetch more than limit to account for post-query filtering
  const fetchLimit = (pinnedOnly || verifiedOnly || riskOnly || bypassedOnly || byAgent) ? limit * 5 : limit;
  let results = searchMessages(room, query, fetchLimit);

  // Apply filters in JS (small result sets, avoids coupling to SQLite JSON functions)
  if (pinnedOnly) {
    results = results.filter(m => m.pinned);
  }
  if (verifiedOnly) {
    results = results.filter(m => {
      const meta = parseMetadata(m.metadata);
      return !!meta.evidence;
    });
  }
  if (riskOnly) {
    results = results.filter(m => m.content.includes('[RISK'));
  }
  if (bypassedOnly) {
    results = results.filter(m => {
      const meta = parseMetadata(m.metadata);
      return meta.plan_guard_bypassed === true;
    });
  }
  if (byAgent) {
    const agent = byAgent.toLowerCase();
    results = results.filter(m => m.from_agent.toLowerCase() === agent);
  }

  // Trim to requested limit
  results = results.slice(0, limit);

  // Build filter description for output
  const filters = [];
  if (pinnedOnly) filters.push('pinned');
  if (verifiedOnly) filters.push('verified');
  if (riskOnly) filters.push('risk');
  if (bypassedOnly) filters.push('bypassed');
  if (byAgent) filters.push(`by:${byAgent}`);
  const filterDesc = filters.length ? ` [${filters.join(', ')}]` : '';

  if (jsonOut) {
    const formatted = results.map(m => {
      const meta = parseMetadata(m.metadata);
      return {
        id: m.id, type: m.type, from: m.from_agent,
        content: m.parent_id ? `[reply to #${m.parent_id}] ${m.content}` : m.content,
        parent_id: m.parent_id, priority: meta.priority, mentions: meta.mentions,
        task_status: meta.task_status, evidence: meta.evidence,
        pinned: !!m.pinned, created_at: m.created_at,
      };
    });
    console.log(JSON.stringify({ room, query, filters, count: formatted.length, results: formatted }, null, 2));
  } else {
    if (results.length === 0) {
      console.log(`No messages matching "${query}"${filterDesc} in [${room}]`);
    } else {
      console.log(`[${room}] ${results.length} result${results.length !== 1 ? 's' : ''} for "${query}"${filterDesc}:`);
      for (const m of results) {
        console.log(formatMessage(m, { compact: true }));
      }
    }
  }
} finally {
  closeDb();
}
