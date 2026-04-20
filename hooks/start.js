#!/usr/bin/env node
// SessionStart hook — auto-spawn chat-watch.js for participating agents.
//
// Without this, an agent's Claude session is only alive to ccchat when the
// user actively prompts it (poll/stop hooks fire). Between prompts the agent
// is blind: new peer messages don't touch sentinels once the agent ages out
// via the 10-min expiry, so fs.watch never fires. chat-watch fixes that —
// it polls the DB every 30s (fallback) and wakes on sentinel events.
//
// Runs once per session. It:
//   1. Checks ccchat-identity.json exists (opt-in: project participates)
//   2. Checks if a chat-watch process is already running for this agent
//   3. Spawns one in the background if not
// Fails silent — hooks must never crash the session.

import { existsSync, readFileSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CCCHAT_ROOT = join(__dirname, '..');

// Walk up the process tree from this hook to find the owning claude session PID.
// Returns null if not found within 10 levels (hook is running outside a claude
// session or the chain is broken). The PID is passed to chat-watch as
// --parent-pid so the daemon can self-terminate when the claude session dies.
//
// Without this, a --persist daemon outlives its parent on crash/SIGKILL (where
// SessionEnd / leave.js does not fire), keeps heartbeating setOnline:true, and
// the 10-min DB TTL never triggers because last_seen refreshes every cycle.
function findClaudeParentPid() {
  let pid = process.ppid;
  for (let depth = 0; depth < 10 && pid > 1; depth++) {
    try {
      const comm = execSync(`ps -p ${pid} -o comm=`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const basename = comm.split('/').pop();
      if (basename === 'claude') return pid;
      const nextPid = parseInt(execSync(`ps -p ${pid} -o ppid=`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 10);
      if (!Number.isFinite(nextPid) || nextPid === pid) return null;
      pid = nextPid;
    } catch {
      return null;
    }
  }
  return null;
}

async function readStdin() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  } catch { return ''; }
}

async function main() {
  const raw = await readStdin();
  let cwd = process.cwd();
  try { const parsed = JSON.parse(raw || '{}'); if (parsed.cwd) cwd = parsed.cwd; } catch {}

  // Only auto-spawn for projects that opted into ccchat
  const identityPath = join(cwd, '.claude', 'ccchat-identity.json');
  if (!existsSync(identityPath)) return;

  let identity;
  try { identity = JSON.parse(readFileSync(identityPath, 'utf8')); } catch { return; }
  if (!identity?.name) return;

  // TEAM_UP_OPT_OUT_GUARD
  {
    const { homedir } = await import('os');
    const suppressPath = join(homedir(), '.claude', 'ccchat', 'suppress-teammate-joins.lock');
    if (existsSync(suppressPath)) {
      try {
        const marker = JSON.parse(readFileSync(suppressPath, 'utf8'));
        if (marker.until && Date.now() < marker.until) return;
      } catch {}
    }
  }

  // Dedup: match on the explicit --name + --project flags we pass below.
  // Multiple agents on the same host don't collide.
  const needle = `chat-watch.js --name ${identity.name} --project ${cwd}`;
  try {
    execSync(`pgrep -f ${JSON.stringify(needle)}`, { stdio: 'ignore' });
    return; // already running
  } catch { /* not running — proceed */ }

  const parentPid = findClaudeParentPid();

  try {
    const watchPath = join(CCCHAT_ROOT, 'scripts', 'chat-watch.js');
    const spawnArgs = [
      watchPath,
      '--name', identity.name,
      '--project', cwd,
      '--timeout', '300',
      '--persist',
    ];
    if (parentPid) spawnArgs.push('--parent-pid', String(parentPid));
    const child = spawn('node', spawnArgs, {
      detached: true,
      stdio: 'ignore',
      cwd,
    });
    child.unref();
  } catch {
    // Best-effort — spawn failure is not a session-blocking error
  }
}

main().catch(() => {});
