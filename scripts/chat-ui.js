#!/usr/bin/env node
// Interactive terminal chat UI for ccchat.
// Usage: node chat-ui.js [--name <name>] [--project <path>] [--room <room>]

import * as readline from 'readline';
import {
  upsertAgent, insertMessage, getMessagesSince, getHistory, getOnlineAgents,
  updateCursor, initCursorIfNew, getMaxMessageId, pinMessage, unpinMessage,
  getPinnedMessages, searchMessages, setAgentOffline, getUnreadCountAllRooms,
  closeDb, projectHash,
} from '../lib/db.js';
import { formatMessage, parseMentions, parseMetadata } from '../lib/format.js';
import { resolveIdentity } from '../lib/identity.js';

// ── Arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const identity = resolveIdentity({ name: getFlag('name') || 'human', project: getFlag('project') });
let currentRoom = getFlag('room') || 'general';

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const INVERSE = `${ESC}7m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const GRAY = `${ESC}90m`;

const NAME_COLORS = [
  `${ESC}36m`, // cyan
  `${ESC}32m`, // green
  `${ESC}35m`, // magenta
  `${ESC}33m`, // yellow
  `${ESC}34m`, // blue
];

function nameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

// ── Colorized message formatter ──────────────────────────────────────────────

function colorMessage(msg) {
  const from = msg.from || msg.from_agent;
  const time = (msg.created_at || '').slice(11, 16);
  const meta = parseMetadata(msg.metadata);

  const nc = nameColor(from);
  const urgentTag = meta.priority === 'urgent' ? ` ${BOLD}${RED}[URGENT]${RESET}` : '';
  const pinnedTag = msg.pinned ? ` ${YELLOW}[PIN]${RESET}` : '';
  const typeTag = msg.type === 'question' ? ` ${DIM}(Q)${RESET}` : '';
  const taskStatus = meta.task_status ? ` [${meta.task_status.toUpperCase()}]` : '';
  const evidenceTag = meta.evidence ? ' [verified]' : '';

  const header = `${GRAY}#${msg.id}${RESET} ${nc}${BOLD}${from}${RESET}${pinnedTag}${urgentTag}${taskStatus}${evidenceTag}${typeTag} ${DIM}(${time})${RESET}`;
  const replyLine = msg.parent_id ? `\n  ${DIM}↳ reply to #${msg.parent_id}${RESET}` : '';
  const content = (msg.content || '').split('\n').map(l => `    ${l}`).join('\n');
  return `${header}${replyLine}\n${content}\n`;
}

// ── State ────────────────────────────────────────────────────────────────────

let lastSeenId = 0;
let pollTimer = null;
let rl = null;

// ── Output helpers (write above prompt without disrupting input) ─────────────

function writeAbove(text) {
  // Move up past separator, clear it, write message, redraw separator
  process.stdout.write(`\r${ESC}K`);       // clear current line (prompt)
  process.stdout.write(`${ESC}A${ESC}K`);  // move up, clear separator line
  process.stdout.write(text + '\n');
  process.stdout.write(separator() + '\n');
  if (rl) rl.prompt(true);
}

function systemMsg(text) {
  writeAbove(`${GRAY}${text}${RESET}`);
}

// ── Status bar ───────────────────────────────────────────────────────────────

function separator() {
  const cols = process.stdout.columns || 80;
  return `${DIM}${'─'.repeat(cols)}${RESET}`;
}

function drawStatusBar() {
  const online = getOnlineAgents();
  const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const cols = process.stdout.columns || 80;
  const bar = ` [${currentRoom}] ${online.length} online | ${identity.name}@${identity.projectPath.split('/').pop()}    ${now} `;
  process.stdout.write(`\r${ESC}K${INVERSE}${bar}${' '.repeat(Math.max(0, cols - bar.length))}${RESET}\n\n`);
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function promptStr() {
  return `${DIM}[${currentRoom}]${RESET} > `;
}

// ── Poll for new messages ────────────────────────────────────────────────────

function poll() {
  try {
    const msgs = getMessagesSince(lastSeenId, currentRoom);
    for (const msg of msgs) {
      writeAbove(colorMessage(msg));
      lastSeenId = msg.id;
    }
    if (msgs.length > 0) {
      updateCursor(identity.name, identity.projectPath, currentRoom, lastSeenId);
    }
    // Keep agent online
    upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: [currentRoom] });
  } catch (e) {
    // Silently ignore poll errors
  }
}

// ── Tab completer ────────────────────────────────────────────────────────────

const COMMANDS = [
  '/reply', '/r', '/room', '/rooms', '/who', '/history', '/search',
  '/pin', '/unpin', '/pins', '/dm', '/urgent', '/ask', '/clear', '/help', '/quit', '/q',
];

function completer(line) {
  if (line.startsWith('/')) {
    const hits = COMMANDS.filter(c => c.startsWith(line));
    return [hits.length ? hits : COMMANDS, line];
  }
  if (line.includes('@')) {
    const atIdx = line.lastIndexOf('@');
    const partial = line.slice(atIdx + 1).toLowerCase();
    try {
      const agents = getOnlineAgents().map(a => a.name);
      const matches = agents.filter(n => n.startsWith(partial));
      const completions = matches.map(n => line.slice(0, atIdx + 1) + n);
      return [completions.length ? completions : [], line];
    } catch { return [[], line]; }
  }
  return [[], line];
}

// ── Send message helper ──────────────────────────────────────────────────────

function sendMessage({ content, room, type = 'message', toAgent, parentId, urgent = false }) {
  const mentions = parseMentions(content);
  const metadata = {};
  if (mentions.length) metadata.mentions = mentions;
  if (urgent) metadata.priority = 'urgent';

  const result = insertMessage({
    type,
    fromAgent: identity.name,
    fromProject: identity.projectPath,
    toAgent,
    room: room || currentRoom,
    content,
    metadata: Object.keys(metadata).length ? metadata : undefined,
    parentId,
  });

  // Advance cursor past own message
  updateCursor(identity.name, identity.projectPath, room || currentRoom, result.id);
  lastSeenId = Math.max(lastSeenId, result.id);
}

// ── Command handlers ─────────────────────────────────────────────────────────

function handleCommand(line) {
  const parts = line.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const rest = line.trim().slice(parts[0].length).trim();

  switch (cmd) {
    case '/help':
      systemMsg([
        'Commands:',
        '  /reply <id> <text>  (or /r)  Reply to a message',
        '  /room <name>                 Switch room',
        '  /rooms                       List rooms with unread counts',
        '  /who                         Show online agents',
        '  /history [N]                 Show last N messages (default 30)',
        '  /search <query>              Search current room',
        '  /pin <id>                    Pin a message',
        '  /unpin <id>                  Unpin a message',
        '  /pins                        List pinned messages',
        '  /dm <agent> <text>           Direct message',
        '  /urgent <text>               Send urgent message',
        '  /ask <text>                  Send as question',
        '  /clear                       Clear screen',
        '  /quit (or /q)                Exit',
      ].join('\n'));
      break;

    case '/r':
    case '/reply': {
      const id = parseInt(parts[1], 10);
      const text = parts.slice(2).join(' ');
      if (!id || !text) { systemMsg('Usage: /reply <id> <text>'); break; }
      sendMessage({ content: text, room: currentRoom, parentId: id });
      break;
    }

    case '/room': {
      const newRoom = parts[1];
      if (!newRoom) { systemMsg('Usage: /room <name>'); break; }
      currentRoom = newRoom;
      upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: [currentRoom] });
      initCursorIfNew(identity.name, identity.projectPath, currentRoom);
      // Clear and show backfill
      process.stdout.write(`${ESC}2J${ESC}H`);
      drawStatusBar();
      const { messages } = getHistory(currentRoom, 30);
      for (const msg of messages) {
        process.stdout.write(colorMessage(msg) + '\n');
      }
      lastSeenId = messages.length ? messages[messages.length - 1].id : getMaxMessageId(currentRoom);
      updateCursor(identity.name, identity.projectPath, currentRoom, lastSeenId);
      process.stdout.write(separator() + '\n');
      rl.setPrompt(promptStr());
      rl.prompt();
      break;
    }

    case '/rooms': {
      const counts = getUnreadCountAllRooms(identity.name, identity.projectPath);
      if (counts.size === 0) {
        systemMsg('No rooms with unread messages.');
      } else {
        const lines = [];
        for (const [room, count] of counts) {
          lines.push(`  ${room}: ${count} unread${room === currentRoom ? ' (current)' : ''}`);
        }
        systemMsg('Rooms:\n' + lines.join('\n'));
      }
      // Always show current room
      if (!counts.has(currentRoom)) {
        systemMsg(`  ${currentRoom}: 0 unread (current)`);
      }
      break;
    }

    case '/who': {
      const agents = getOnlineAgents();
      if (agents.length === 0) {
        systemMsg('No agents online.');
      } else {
        const lines = agents.map(a => {
          const color = nameColor(a.name);
          return `  ${color}${a.name}${RESET} (${a.project_path.split('/').pop()})`;
        });
        systemMsg('Online agents:\n' + lines.join('\n'));
      }
      break;
    }

    case '/history': {
      const n = parseInt(parts[1], 10) || 30;
      const { messages } = getHistory(currentRoom, n);
      if (messages.length === 0) {
        systemMsg('No messages in this room.');
      } else {
        for (const msg of messages) writeAbove(colorMessage(msg));
      }
      break;
    }

    case '/search': {
      if (!rest) { systemMsg('Usage: /search <query>'); break; }
      const results = searchMessages(currentRoom, rest);
      if (results.length === 0) {
        systemMsg('No results.');
      } else {
        for (const msg of results) writeAbove(colorMessage(msg));
      }
      break;
    }

    case '/pin': {
      const id = parseInt(parts[1], 10);
      if (!id) { systemMsg('Usage: /pin <id>'); break; }
      pinMessage(id);
      systemMsg(`Pinned #${id}`);
      break;
    }

    case '/unpin': {
      const id = parseInt(parts[1], 10);
      if (!id) { systemMsg('Usage: /unpin <id>'); break; }
      unpinMessage(id);
      systemMsg(`Unpinned #${id}`);
      break;
    }

    case '/pins': {
      const pinned = getPinnedMessages(currentRoom);
      if (pinned.length === 0) {
        systemMsg('No pinned messages.');
      } else {
        for (const msg of pinned) writeAbove(colorMessage(msg));
      }
      break;
    }

    case '/dm': {
      const target = parts[1];
      const text = parts.slice(2).join(' ');
      if (!target || !text) { systemMsg('Usage: /dm <agent> <text>'); break; }
      sendMessage({ content: text, room: currentRoom, toAgent: target });
      systemMsg(`DM sent to ${target}`);
      break;
    }

    case '/urgent': {
      if (!rest) { systemMsg('Usage: /urgent <text>'); break; }
      sendMessage({ content: rest, room: currentRoom, urgent: true });
      break;
    }

    case '/ask': {
      if (!rest) { systemMsg('Usage: /ask <text>'); break; }
      sendMessage({ content: rest, room: currentRoom, type: 'question' });
      break;
    }

    case '/clear':
      process.stdout.write(`${ESC}2J${ESC}H`);
      drawStatusBar();
      process.stdout.write(separator() + '\n');
      rl.prompt();
      break;

    case '/q':
    case '/quit':
      cleanup();
      break;

    default:
      systemMsg(`Unknown command: ${cmd}. Type /help for commands.`);
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

function cleanup() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  try {
    setAgentOffline(identity.name, identity.projectPath);
    closeDb();
  } catch { /* ignore */ }
  systemMsg('Goodbye!');
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  // Register agent
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: [currentRoom] });
  initCursorIfNew(identity.name, identity.projectPath, currentRoom);

  // Clear screen and draw status bar
  process.stdout.write(`${ESC}2J${ESC}H`);
  drawStatusBar();

  // Backfill last 30 messages
  const { messages: backfill } = getHistory(currentRoom, 30);
  for (const msg of backfill) {
    process.stdout.write(colorMessage(msg) + '\n');
  }
  lastSeenId = backfill.length ? backfill[backfill.length - 1].id : getMaxMessageId(currentRoom);
  updateCursor(identity.name, identity.projectPath, currentRoom, lastSeenId);

  // Draw separator between messages and input
  process.stdout.write(separator() + '\n');

  // Setup readline
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptStr(),
    completer,
    terminal: true,
  });

  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    if (trimmed.startsWith('/')) {
      handleCommand(trimmed);
    } else {
      sendMessage({ content: trimmed, room: currentRoom });
    }
    rl.prompt();
  });

  rl.on('close', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Start polling
  pollTimer = setInterval(poll, 1500);

  // Refresh status bar every 30s
  setInterval(() => {
    // Save cursor, move to top, draw status, restore cursor
    process.stdout.write(`${ESC}s${ESC}H`);
    drawStatusBar();
    process.stdout.write(`${ESC}u`);
  }, 30000);

  systemMsg(`Joined [${currentRoom}] as ${identity.name}. Type /help for commands.`);
}

main();
