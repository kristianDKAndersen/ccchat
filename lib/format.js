// Shared formatting utilities for ccchat output.
// Pure functions — no DB or identity dependencies.

/**
 * Word-wrap text to fit within a given width, with indent on each line.
 * Preserves existing newlines. Doesn't break URLs.
 */
export function wrapText(text, width = 78, indent = 2) {
  const prefix = ' '.repeat(indent);
  const maxLen = width - indent;
  const lines = text.split('\n');
  const result = [];

  for (const line of lines) {
    if (line.length <= maxLen) {
      result.push(prefix + line);
      continue;
    }
    const words = line.split(/( +)/);
    let current = '';
    for (const word of words) {
      if (current.length + word.length > maxLen && current.length > 0) {
        result.push(prefix + current.trimEnd());
        current = word.trimStart();
      } else {
        current += word;
      }
    }
    if (current.length > 0) {
      result.push(prefix + current.trimEnd());
    }
  }
  return result.join('\n');
}

/**
 * Extract @mentions from message text.
 * Returns deduplicated, lowercased array of mentioned names.
 */
export function parseMentions(text) {
  const matches = text.match(/@(\w[\w-]*)/g);
  if (!matches) return [];
  return [...new Set(matches.map(m => m.slice(1).toLowerCase()))];
}

/**
 * Parse metadata JSON (from DB column) into a normalized object.
 * Handles NULL, string, or already-parsed object. Always returns defaults.
 */
export function parseMetadata(raw) {
  const empty = { mentions: [], priority: 'normal', task_status: null, evidence: null, discussion_phase: null, plan_guard_bypassed: false };
  if (!raw) return empty;
  try {
    const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      mentions: m.mentions || [],
      priority: m.priority || 'normal',
      task_status: m.task_status || null,
      evidence: m.evidence || null,
      discussion_phase: m.discussion_phase || null,
      plan_guard_bypassed: m.plan_guard_bypassed === true,
    };
  } catch { return empty; }
}

/**
 * Format a single message.
 * msg: { id, type, from/from_agent, content, parent_id, created_at, metadata }
 * opts.compact: truncate content to 200 chars
 */
export function formatMessage(msg, { compact } = {}) {
  const from = msg.from || msg.from_agent;
  const time = (msg.created_at || '').slice(11, 16);
  const meta = parseMetadata(msg.metadata);
  const urgentTag = meta.priority === 'urgent' ? ' [URGENT]' : '';
  const pinnedTag = msg.pinned ? ' [PIN]' : '';
  const typeTag = msg.type === 'question' ? ' (Q)' : '';
  const taskStatus = meta.task_status ? ` [${meta.task_status.toUpperCase()}]` : '';
  const evidenceTag = meta.evidence ? ' [verified]' : '';
  const phaseTag = meta.discussion_phase ? ` [${meta.discussion_phase.toUpperCase()}]` : '';
  const riskTag = (msg.content || '').includes('[RISK') ? ' [RISK]' : '';
  let content = msg.content || '';
  if (compact && content.length > 200) {
    content = content.slice(0, 197) + '...';
  }
  const header = `#${msg.id} ${from}${pinnedTag}${urgentTag}${taskStatus}${evidenceTag}${phaseTag}${riskTag}${typeTag} (${time}):`;
  const body = wrapText(content);
  const reply = msg.parent_id ? `\n${' '.repeat(2)}[reply to #${msg.parent_id}]` : '';
  return `${header}\n${body}${reply}`;
}

export function formatSendConfirm(id, room) {
  return `Sent #${id} to [${room}]`;
}

export function formatRoomHeader(room, count) {
  return `[${room}] ${count} new message${count !== 1 ? 's' : ''}:`;
}

export function formatNoMessages(rooms) {
  return `No new messages. Listening in: ${rooms.join(', ')}`;
}

export function formatHistoryHeader(room, firstId, lastId) {
  return `--- ${room} (#${firstId}-#${lastId}) ---`;
}

export function formatHistoryFooter(hasMore, oldestId) {
  if (!hasMore) return '--- end ---';
  return `--- older: --before ${oldestId} ---`;
}
