#!/usr/bin/env node
// UserPromptSubmit hook — show unread banner on stderr.
// Reads DB directly, no server needed.

import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { upsertAgent, getUnreadCountAllRooms, getUnreadMessages, initCursorIfNew, closeDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { parseMetadata } from '../lib/format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Spawn human chat-ui in a new Terminal tab if not already running (macOS only)
function spawnChatUi() {
  try {
    execSync('pgrep -f "chat-ui.js"', { stdio: 'ignore' });
    return; // already running
  } catch {
    // not running — spawn it
  }
  try {
    const chatUiPath = join(__dirname, '..', 'scripts', 'chat-ui.js');
    spawn('osascript', [
      '-e', 'tell application "Terminal"',
      '-e', 'activate',
      '-e', `do script "node ${chatUiPath} --name human --room general"`,
      '-e', 'end tell',
    ], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Not macOS or osascript unavailable — silently skip
  }
}

try {
  const identity = resolveIdentity();

  upsertAgent({ name: identity.name, projectPath: identity.projectPath, rooms: identity.rooms, setOnline: false });
  for (const room of identity.rooms) {
    initCursorIfNew(identity.name, identity.projectPath, room);
  }

  const counts = getUnreadCountAllRooms(identity.name, identity.projectPath);
  let total = 0;
  for (const c of counts.values()) total += c;

  if (total > 0) {
    spawnChatUi();
    const lines = [`CCCHAT: ${total} new message${total !== 1 ? 's' : ''}`];
    let hasQuestion = false;

    let hasUrgentOrMention = false;

    for (const [room, count] of counts) {
      const messages = getUnreadMessages(identity.name, identity.projectPath, room, 5);
      // Filter out own messages
      const filtered = messages.filter(m => m.from_agent !== identity.name);
      if (filtered.length === 0) continue;
      const last = filtered[filtered.length - 1];
      const meta = parseMetadata(last.metadata);
      const parts = [];
      if (last.type === 'question') { parts.push('QUESTION'); hasQuestion = true; }
      if (meta.priority === 'urgent') { parts.push('URGENT'); hasUrgentOrMention = true; }
      if (meta.mentions.includes(identity.name)) { parts.push('@you'); hasUrgentOrMention = true; }
      const tag = parts.length ? ` (${parts.join(', ')})` : '';
      lines.push(`  [${room}] ${last.from_agent}${tag}: ${last.content.slice(0, 120)}`);
    }

    if (hasQuestion || hasUrgentOrMention) {
      lines.push('  Use ccchat skill to read and respond.');
    }
    console.error(lines.join('\n'));
  }
} catch {
  // Hook must never fail loudly
} finally {
  closeDb();
}
