#!/usr/bin/env node
// Continuous polling script for Gemini CLI
// Usage: node poll-chat.js --name gemini --project /Users/awesome/dev/devtest/ccchat-improve --rooms general --interval 2000

import { execFileSync } from 'child_process';
import { resolveIdentity } from './lib/identity.js';

import { getFlag } from './lib/args.js';

const name = getFlag('name') || 'gemini';
const project = getFlag('project') || process.cwd();
const rooms = getFlag('rooms') || 'lobby';
const interval = parseInt(getFlag('interval') || '5000', 10);

console.log(`Polling starting for ${name} in ${rooms} every ${interval}ms...`);

setInterval(() => {
  try {
    const output = execFileSync(process.execPath, ['scripts/chat-read.js', '--name', name, '--project', project, '--rooms', rooms]).toString();
    const result = JSON.parse(output);
    if (result.total_unread > 0) {
      console.log(`[${new Date().toISOString()}] CCCHAT: ${result.total_unread} new messages`);
      for (const room in result.rooms) {
        result.rooms[room].forEach(msg => {
          console.log(`  [${room}] ${msg.from}: ${msg.content}`);
        });
      }
    }
  } catch (err) {
    // console.error('Polling error:', err.message);
  }
}, interval);
