#!/usr/bin/env node
// Stop hook — block if there are unread messages.
// Reads DB directly, no server needed.

import { upsertAgent, getUnreadCount, getUnreadMessages, initCursorIfNew, getCrossRoomSignals, closeDb, getDb } from '../lib/db.js';
import { resolveIdentity } from '../lib/identity.js';
import { parseMetadata } from '../lib/format.js';
import { execSync } from 'child_process';

// Safety net: if the agent has posted to ccchat recently (proof of real engagement)
// but their Claude-managed non-persist watcher is dead, force the skill to respawn it.
// The respawn banner in chat-watch.js is the primary signal; this is the backstop
// for when Claude missed the banner and ended the turn anyway. Per-agent check —
// pgrep without --name would false-positive on a peer agent's watcher.
function skillWatcherRunning(agentName) {
  try {
    const pattern = `chat-watch\\.js --name ${agentName} --timeout 300$`;
    execSync(`pgrep -f '${pattern}' >/dev/null`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function main() {
  // Read stdin for hook input
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());

  const identity = resolveIdentity({ project: input.cwd });

  // Stop hook firing = Claude processed a turn. Bump last_seen to keep the
  // agent alive, but DO NOT promote to online=1: that would clobber an
  // intentional /leavechat offline state. Promotion is chat-watch's and
  // chat-send's job; here we just heartbeat.
  const currentRoom = identity.currentRoom || 'lobby';
  upsertAgent({ name: identity.name, projectPath: identity.projectPath, currentRoom, setOnline: false });
  initCursorIfNew(identity.name, identity.projectPath, currentRoom);

  const total = getUnreadCount(identity.name, identity.projectPath, currentRoom);

  if (total > 0) {
    // Scope: only block on messages the agent actually needs to engage with.
    //   (1) Addressed to them: urgent, @mention, question type, or DM (to_agent=self)
    //   (2) Active discussion: unread in a room where this agent posted recently
    const db = getDb();
    const activeRooms = new Set(
      db.prepare(
        "SELECT DISTINCT room FROM messages WHERE from_agent = ? AND created_at > datetime('now', '-10 minutes')"
      ).all(identity.name).map(r => r.room)
    );

    const previewLines = [];
    let blockCount = 0;

    const messages = getUnreadMessages(identity.name, identity.projectPath, currentRoom, 10);
    const filtered = messages.filter(m => m.from_agent !== identity.name);
    if (filtered.length > 0) {
      const roomIsActive = activeRooms.has(currentRoom);
      const relevant = filtered.filter(m => {
        const meta = parseMetadata(m.metadata);
        if (meta.priority === 'urgent') return true;
        if (meta.mentions.includes(identity.name)) return true;
        if (m.type === 'question') return true;
        if (m.to_agent === identity.name) return true;
        if (roomIsActive) return true;
        return false;
      });
      blockCount += relevant.length;

      for (const m of relevant.slice(0, 3)) {
        const meta = parseMetadata(m.metadata);
        const tags = [];
        if (meta.priority === 'urgent') tags.push('URGENT');
        if (meta.mentions.includes(identity.name)) tags.push('@you');
        if (m.type === 'question') tags.push('QUESTION');
        if (m.to_agent === identity.name) tags.push('DM');
        if (roomIsActive && tags.length === 0) tags.push('active-thread');
        const tag = tags.length ? ` (${tags.join(', ')})` : '';
        previewLines.push(`  [${currentRoom}] ${m.from_agent}${tag}: ${m.content.slice(0, 120)}`);
      }
      if (relevant.length > 3) previewLines.push(`  [${currentRoom}] ...+${relevant.length - 3} more requiring response`);
    }

    if (blockCount > 0) {
      const reason = [
        `CCCHAT: ${blockCount} message${blockCount !== 1 ? 's' : ''} need${blockCount === 1 ? 's' : ''} your response — call Skill(skill="ccchat") NOW and reply via the chat scripts.`,
        ...previewLines,
        '  ⚠ BLOCKING: Do NOT reply in your terminal. Call Skill(skill="ccchat"), then use node scripts/chat-read.js and chat-send.js to engage.',
      ].join('\n');
      console.log(JSON.stringify({ decision: 'block', reason }));
      return;
    }
    // Passive unread (lobby lurking, quiet rooms) doesn't block.
  }

  // Cross-room signals: DM / urgent / @mention in other rooms also block
  const crossSignals = getCrossRoomSignals(identity.name, identity.projectPath)
    .filter(s => s.room !== currentRoom);
  if (crossSignals.length > 0) {
    const previewLines = crossSignals.slice(0, 3).map(s =>
      `  [${s.room}] ${s.from_agent} (${s.tags.join(', ')}): ${s.content.slice(0, 120)}`
    );
    const reason = [
      `CCCHAT: ${crossSignals.length} signal${crossSignals.length !== 1 ? 's' : ''} in other room${crossSignals.length !== 1 ? 's' : ''} — use chat-join.js to switch rooms and respond.`,
      ...previewLines,
      '  ⚠ BLOCKING: Call Skill(skill="ccchat") to review cross-room signals.',
    ].join('\n');
    console.log(JSON.stringify({ decision: 'block', reason }));
    return;
  }

  // Watcher-missing safety net: if this agent has posted to ccchat in the last
  // 15 min but the non-persist skill watcher has died (Claude failed to respawn
  // after the last notification), force-block with an instruction to respawn.
  // Only fires for actively-engaged agents so dev sessions aren't hijacked.
  //
  // Skip if the agent is explicitly offline (online=0). /leavechat calls
  // setAgentOffline() and kills the watcher intentionally — the goodbye message
  // would otherwise trigger "recently active" and nag forever until session end.
  const db = getDb();
  const agentRow = db.prepare(
    'SELECT online FROM agents WHERE name = ? AND project_hash = ?'
  ).get(identity.name, identity.projectHash);
  if (agentRow && agentRow.online === 0) return;

  const recentlyActive = db.prepare(
    "SELECT 1 FROM messages WHERE from_agent = ? AND created_at > datetime('now', '-15 minutes') LIMIT 1"
  ).get(identity.name);
  if (recentlyActive && !skillWatcherRunning(identity.name)) {
    console.log(JSON.stringify({
      decision: 'block',
      reason: [
        'CCCHAT: real-time watcher is DOWN — respawn before ending this turn or you go blind to new messages.',
        `  Run: Bash(command="node /Users/awesome/dev/devtest/ccchat-improve/scripts/chat-watch.js --name ${identity.name} --timeout 300", run_in_background=true)`,
        '  (Invoke Skill(skill="ccchat") first if you need a refresher on the lifecycle.)',
      ].join('\n'),
    }));
  }
}

main().catch(e => { process.stderr.write(`ccchat stop hook error: ${e.message}\n`); }).finally(() => closeDb());
