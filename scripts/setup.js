#!/usr/bin/env node
// Setup ccchat v2 for global or per-project use.
//
// Usage:
//   node setup.js --global                    # install globally
//   node setup.js --name my-agent --room dev  # setup current project
//   node setup.js --uninstall                 # remove from project
//   node setup.js --global --uninstall        # remove globally

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CCCHAT_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  return (next && !next.startsWith('--')) ? next : true;
}

const isGlobal = args.includes('--global');
const isUninstall = args.includes('--uninstall');
const agentName = getFlag('name') || basename(process.cwd());
const room = getFlag('room') || 'general';
const projectDir = isGlobal ? null : process.cwd();

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function mergeSettings(settingsPath, pollCmd, stopCmd, leaveCmd, notifyCmd) {
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* fresh */ }
  }

  if (!settings.hooks) settings.hooks = {};

  // UserPromptSubmit
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
  if (!settings.hooks.UserPromptSubmit.some(e => e.hooks?.some(h => h.command?.includes('ccchat-improve')))) {
    settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: pollCmd }] });
  }

  // Stop
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  if (!settings.hooks.Stop.some(e => e.hooks?.some(h => h.command?.includes('ccchat-improve')))) {
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: stopCmd }] });
  }

  // SessionEnd
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];
  if (!settings.hooks.SessionEnd.some(e => e.hooks?.some(h => h.command?.includes('ccchat-improve')))) {
    settings.hooks.SessionEnd.push({ hooks: [{ type: 'command', command: leaveCmd }] });
  }

  // PostToolUse
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  if (!settings.hooks.PostToolUse.some(e => e.hooks?.some(h => h.command?.includes('ccchat-improve')))) {
    settings.hooks.PostToolUse.push({ hooks: [{ type: 'command', command: notifyCmd }] });
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

function removeFromSettings(settingsPath) {
  if (!existsSync(settingsPath)) return;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd', 'PostToolUse']) {
      if (settings.hooks?.[event]) {
        settings.hooks[event] = settings.hooks[event].filter(e =>
          !e.hooks?.some(h => h.command?.includes('ccchat-improve'))
        );
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch { /* ok */ }
}

function copyFileWithReplacements(src, dest) {
  let content = readFileSync(src, 'utf8');
  content = content.replace(/\{\{CCCHAT_ROOT\}\}/g, CCCHAT_ROOT);
  writeFileSync(dest, content);
}

// ── Global install ──────────────────────────────────────────

if (isGlobal) {
  const globalClaudeDir = join(homedir(), '.claude');
  const pollCmd = `node ${join(CCCHAT_ROOT, 'hooks', 'poll.js')}`;
  const stopCmd = `node ${join(CCCHAT_ROOT, 'hooks', 'stop.js')}`;
  const leaveCmd = `node ${join(CCCHAT_ROOT, 'hooks', 'leave.js')}`;
  const notifyCmd = `node ${join(CCCHAT_ROOT, 'hooks', 'notify.js')}`;

  if (isUninstall) {
    console.log('Removing ccchat v2 globally...\n');
    removeFromSettings(join(globalClaudeDir, 'settings.json'));
    try { rmSync(join(globalClaudeDir, 'agents', 'ccchat.md'), { force: true }); } catch {}
    try { rmSync(join(globalClaudeDir, 'skills', 'ccchat'), { recursive: true, force: true }); } catch {}
    try { rmSync(join(globalClaudeDir, 'skills', 'leavechat'), { recursive: true, force: true }); } catch {}
    console.log('Done. ccchat v2 removed from global config.');
    process.exit(0);
  }

  console.log('Installing ccchat v2 globally...\n');

  // Agent
  ensureDir(join(globalClaudeDir, 'agents'));
  copyFileWithReplacements(
    join(CCCHAT_ROOT, '.claude', 'agents', 'ccchat.md'),
    join(globalClaudeDir, 'agents', 'ccchat.md')
  );
  console.log('  + Agent:    ~/.claude/agents/ccchat.md');

  // Skills
  ensureDir(join(globalClaudeDir, 'skills', 'ccchat'));
  copyFileWithReplacements(
    join(CCCHAT_ROOT, '.claude', 'skills', 'ccchat', 'SKILL.md'),
    join(globalClaudeDir, 'skills', 'ccchat', 'SKILL.md')
  );
  // Copy CLAUDE.md as INTERNALS.md for progressive disclosure
  const claudeMdPath = join(CCCHAT_ROOT, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    copyFileWithReplacements(
      claudeMdPath,
      join(globalClaudeDir, 'skills', 'ccchat', 'INTERNALS.md')
    );
  }
  console.log('  + Skill:    ~/.claude/skills/ccchat/ (+ INTERNALS.md)');

  ensureDir(join(globalClaudeDir, 'skills', 'leavechat'));
  copyFileWithReplacements(
    join(CCCHAT_ROOT, '.claude', 'skills', 'leavechat', 'SKILL.md'),
    join(globalClaudeDir, 'skills', 'leavechat', 'SKILL.md')
  );
  console.log('  + Skill:    ~/.claude/skills/leavechat/');

  // Hooks
  mergeSettings(join(globalClaudeDir, 'settings.json'), pollCmd, stopCmd, leaveCmd, notifyCmd);
  console.log('  + Hooks:    ~/.claude/settings.json (UserPromptSubmit + Stop + SessionEnd + PostToolUse)');

  console.log('\nccchat v2 is now available in ALL Claude Code sessions.');
  console.log('Per-project setup (optional):');
  console.log(`  node ${join(CCCHAT_ROOT, 'scripts', 'setup.js')} --name "my-agent"\n`);
  process.exit(0);
}

// ── Project-level install ───────────────────────────────────

const claudeDir = join(projectDir, '.claude');
const pollCmd = `node ${join(CCCHAT_ROOT, 'hooks', 'poll.js')}`;
const stopCmd = `node ${join(CCCHAT_ROOT, 'hooks', 'stop.js')}`;
const leaveCmd = `node ${join(CCCHAT_ROOT, 'hooks', 'leave.js')}`;
const notifyCmd = `node ${join(CCCHAT_ROOT, 'hooks', 'notify.js')}`;

if (isUninstall) {
  console.log(`Removing ccchat v2 from ${projectDir}...\n`);
  removeFromSettings(join(claudeDir, 'settings.json'));
  try { rmSync(join(claudeDir, 'agents', 'ccchat.md'), { force: true }); } catch {}
  try { rmSync(join(claudeDir, 'skills', 'ccchat'), { recursive: true, force: true }); } catch {}
  try { rmSync(join(claudeDir, 'ccchat-identity.json'), { force: true }); } catch {}
  console.log('Done. ccchat v2 removed from this project.');
  process.exit(0);
}

console.log(`Setting up ccchat v2 in ${projectDir}...\n`);

// Agent
ensureDir(join(claudeDir, 'agents'));
copyFileWithReplacements(
  join(CCCHAT_ROOT, '.claude', 'agents', 'ccchat.md'),
  join(claudeDir, 'agents', 'ccchat.md')
);
console.log('  + Agent:    .claude/agents/ccchat.md');

// Skill
ensureDir(join(claudeDir, 'skills', 'ccchat'));
copyFileWithReplacements(
  join(CCCHAT_ROOT, '.claude', 'skills', 'ccchat', 'SKILL.md'),
  join(claudeDir, 'skills', 'ccchat', 'SKILL.md')
);
console.log('  + Skill:    .claude/skills/ccchat/');

// Identity file
const identityData = { name: agentName, projectPath: projectDir, rooms: [room] };
writeFileSync(join(claudeDir, 'ccchat-identity.json'), JSON.stringify(identityData, null, 2) + '\n');
console.log(`  + Identity: .claude/ccchat-identity.json (name: "${agentName}", room: "${room}")`);

// Register agent in DB
try {
  const { upsertAgent, initCursorIfNew, closeDb } = await import('../lib/db.js');
  const { projectHash } = await import('../lib/db.js');
  upsertAgent({ name: agentName, projectPath: projectDir, rooms: [room] });
  initCursorIfNew(agentName, projectDir, room);
  closeDb();
  console.log(`  + DB:       "${agentName}" registered in room "${room}"`);
} catch (e) {
  console.log(`  ~ DB registration skipped: ${e.message}`);
}

console.log('\nDone! ccchat v2 is ready in this project.\n');
