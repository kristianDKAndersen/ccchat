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

  // Kill stale --persist daemons for the same agent name from old project paths.
  // These accumulate when a project (e.g. an advisor run workspace) ends without
  // explicitly stopping the daemon. We evict any orphan before spawning a fresh one.
  // Safe: we only reach here if the exact --name+--project match is NOT running.
  try {
    const stalePattern = `chat-watch.js --name ${identity.name} --project`;
    execSync(`pkill -f ${JSON.stringify(stalePattern)}`, { stdio: 'ignore' });
  } catch { /* none to kill — proceed */ }

  try {
    const watchPath = join(CCCHAT_ROOT, 'scripts', 'chat-watch.js');
    const child = spawn('node', [
      watchPath,
      '--name', identity.name,
      '--project', cwd,
      '--timeout', '300',
      '--persist',
    ], {
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
