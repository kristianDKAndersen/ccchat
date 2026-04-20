#!/usr/bin/env node
// TaskCompleted hook — auto-post teammate evidence to ccchat.
// Fires when a Claude Code agent team teammate finishes their assigned task.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const SCRIPTS = '/Users/awesome/dev/devtest/ccchat-improve/scripts';

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();

  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { return; }

  // Guard: only handle TaskCompleted events
  if (input.hook_event_name && input.hook_event_name !== 'TaskCompleted') return;

  // Log raw payload to stderr for schema discovery (remove once field names are verified)
  process.stderr.write('[task-complete hook] raw payload: ' + JSON.stringify(input) + '\n');

  const cwd = input.cwd || process.cwd();
  const identityPath = join(cwd, '.claude', 'ccchat-identity.json');
  if (!existsSync(identityPath)) return;

  let identity;
  try { identity = JSON.parse(readFileSync(identityPath, 'utf8')); } catch { return; }
  if (!identity?.name) return;

  // Extract task info — try multiple field name conventions (schema unverified)
  const taskId = input.task_id || input.taskId || input.id || '';
  const taskName = input.task_name || input.taskName || input.title || input.name || '';
  const result = input.result || input.output || input.summary || input.tool_result || '';
  const teammate = input.session_id || input.agent_name || input.teammate || 'teammate';

  const label = taskName || taskId || teammate;
  const msg = 'TaskCompleted: ' + label;
  const evidence = (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 400);

  // Use spawnSync with argv array — no shell injection surface
  const args = [
    join(SCRIPTS, 'chat-send.js'),
    '--message', msg,
    '--evidence', evidence || '(no evidence in payload)',
  ];
  const out = spawnSync('node', args, { cwd, timeout: 8000 });
  if (out.status !== 0) {
    process.stderr.write('[task-complete hook] chat-send failed: ' + (out.stderr?.toString() || '') + '\n');
  }
}

main().catch(e => process.stderr.write('[task-complete hook] error: ' + e.message + '\n'));
