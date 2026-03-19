#!/usr/bin/env node
// Search messages by content with optional filters.
// Usage: node chat-search.js --query "<text>" [--room general] [--limit 20] [--pinned] [--verified] [--by <agent>] [--json]

import { searchMessages, closeDb } from '../lib/db.js';
import { formatMessage, parseMetadata } from '../lib/format.js';

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const query = getFlag('query');
const room = getFlag('room') || 'general';
const limit = parseInt(getFlag('limit') || '20', 10);
const pinnedOnly = args.includes('--pinned');
const verifiedOnly = args.includes('--verified');
const byAgent = getFlag('by');
const jsonOut = args.includes('--json');

if (!query) {
  console.error('Usage: node chat-search.js --query "<text>" [--room general] [--limit 20] [--pinned] [--verified] [--by <agent>] [--json]');
  process.exit(1);
}

try {
  // Fetch more than limit to account for post-query filtering
  const fetchLimit = (pinnedOnly || verifiedOnly || byAgent) ? limit * 5 : limit;
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
