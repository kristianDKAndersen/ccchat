#!/usr/bin/env node
// Setup ccchat v2 for global or per-project use.
//
// Usage:
//   node setup.js --global                    # install globally
//   node setup.js --name my-agent --room dev  # setup current project
//   node setup.js --uninstall                 # remove from project
//   node setup.js --global --uninstall        # remove globally

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
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

const isGlobal   = args.includes('--global');
const isUninstall = args.includes('--uninstall');
const agentName  = getFlag('name') || basename(process.cwd());
const room       = getFlag('room') || 'general';
const projectDir = isGlobal ? null : process.cwd();

const HOOK_FILES = ['poll.js', 'stop.js', 'leave.js', 'notify.js', 'empty-project.js', 'start.js'];

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function mergeSettings(settingsPath, cmds) {
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* fresh */ }
  }

  if (!settings.hooks) settings.hooks = {};

  function hasHook(arr, hookFile) {
    return arr.some(e => e.hooks?.some(h => h.command?.includes(hookFile)));
  }

  // UserPromptSubmit — poll
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
  if (!hasHook(settings.hooks.UserPromptSubmit, 'poll.js')) {
    settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: cmds.poll }] });
  }

  // Stop
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  if (!hasHook(settings.hooks.Stop, 'stop.js')) {
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: cmds.stop }] });
  }

  // SessionStart — auto-spawn chat-watch for participating agents
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  if (!hasHook(settings.hooks.SessionStart, 'start.js')) {
    settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: cmds.start }] });
  }

  // SessionEnd
  if (!settings.hooks.SessionEnd) settings.hooks.SessionEnd = [];
  if (!hasHook(settings.hooks.SessionEnd, 'leave.js')) {
    settings.hooks.SessionEnd.push({ hooks: [{ type: 'command', command: cmds.leave }] });
  }

  // PostToolUse — notify
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  if (!hasHook(settings.hooks.PostToolUse, 'notify.js')) {
    settings.hooks.PostToolUse.push({ hooks: [{ type: 'command', command: cmds.notify }] });
  }

  // UserPromptSubmit — empty-project nudge
  if (!hasHook(settings.hooks.UserPromptSubmit, 'empty-project.js')) {
    // Add to existing UserPromptSubmit entry's hooks array
    const existing = settings.hooks.UserPromptSubmit.find(e => e.hooks?.some(h => h.command?.includes('poll.js')));
    if (existing) {
      existing.hooks.push({ type: 'command', command: cmds.emptyProject });
    } else {
      settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: cmds.emptyProject }] });
    }
  }

  // Permissions — ensure ccchat scripts are allowed
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  const scriptPerms = [
    'chat-send.js', 'chat-read.js', 'chat-ask.js', 'chat-history.js',
    'chat-search.js', 'chat-join.js', 'chat-leave.js', 'chat-pin.js',
    'chat-plan.js', 'chat-claim.js', 'chat-task.js', 'chat-catchup.js',
    'chat-watch.js', 'chat-dashboard.js', 'status.js', 'session-bootstrap.js',
    'chat-digest.js', 'setup.js',
  ].map(s => `Bash(node ${cmds.root}/scripts/${s}:*)`);
  const miscPerms = ['Bash(pgrep -f:*)', 'Bash(pkill -f "chat-watch.js:*)'];
  for (const perm of [...scriptPerms, ...miscPerms]) {
    if (!settings.permissions.allow.includes(perm)) {
      settings.permissions.allow.push(perm);
    }
  }

  // StatusLine — only add if not already set
  if (!settings.statusLine) {
    settings.statusLine = { type: 'command', command: cmds.statusline };
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

function removeFromSettings(settingsPath) {
  if (!existsSync(settingsPath)) return;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'PostToolUse']) {
      if (settings.hooks?.[event]) {
        settings.hooks[event] = settings.hooks[event].filter(e =>
          !e.hooks?.some(h => HOOK_FILES.some(f => h.command?.includes(f)))
        );
        if (settings.hooks[event].length === 0) delete settings.hooks[event];
      }
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    // Remove statusLine only if it points to our statusline.js
    if (settings.statusLine?.command?.includes('statusline.js')) {
      delete settings.statusLine;
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  } catch { /* ok */ }
}

function copyFileWithReplacements(src, dest) {
  let content = readFileSync(src, 'utf8');
  content = content.replace(/\{\{CCCHAT_ROOT\}\}/g, CCCHAT_ROOT);
  writeFileSync(dest, content);
}

function copyDirWithReplacements(srcDir, destDir) {
  if (!existsSync(srcDir)) return;
  ensureDir(destDir);
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirWithReplacements(srcPath, destPath);
    } else {
      copyFileWithReplacements(srcPath, destPath);
    }
  }
}

function buildCmds(root) {
  return {
    root,
    poll:         `node ${join(root, 'hooks', 'poll.js')}`,
    stop:         `node ${join(root, 'hooks', 'stop.js')}`,
    leave:        `node ${join(root, 'hooks', 'leave.js')}`,
    notify:       `node ${join(root, 'hooks', 'notify.js')}`,
    start:        `node ${join(root, 'hooks', 'start.js')}`,
    emptyProject: `node ${join(root, 'hooks', 'empty-project.js')}`,
    statusline:   `bash ${join(root, 'scripts', 'statusline.sh')}`,
  };
}

// ── Global install ──────────────────────────────────────────

if (isGlobal) {
  const globalClaudeDir = join(homedir(), '.claude');
  const cmds = buildCmds(CCCHAT_ROOT);

  if (isUninstall) {
    console.log('Removing ccchat v2 globally...\n');
    removeFromSettings(join(globalClaudeDir, 'settings.json'));
    try { rmSync(join(globalClaudeDir, 'agents', 'ccchat.md'), { force: true }); } catch {}
    try { rmSync(join(globalClaudeDir, 'skills', 'ccchat'), { recursive: true, force: true }); } catch {}
    try { rmSync(join(globalClaudeDir, 'skills', 'leavechat'), { recursive: true, force: true }); } catch {}
    try { rmSync(join(globalClaudeDir, 'skills', 'bootstrap'), { recursive: true, force: true }); } catch {}
    try { rmSync(join(globalClaudeDir, 'skills', 'digest'), { recursive: true, force: true }); } catch {}
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
  console.log('  + Agent:      ~/.claude/agents/ccchat.md');

  // Skills
  ensureDir(join(globalClaudeDir, 'skills', 'ccchat'));
  copyFileWithReplacements(
    join(CCCHAT_ROOT, '.claude', 'skills', 'ccchat', 'SKILL.md'),
    join(globalClaudeDir, 'skills', 'ccchat', 'SKILL.md')
  );
  copyDirWithReplacements(
    join(CCCHAT_ROOT, '.claude', 'skills', 'ccchat', 'references'),
    join(globalClaudeDir, 'skills', 'ccchat', 'references')
  );
  const claudeMdPath = join(CCCHAT_ROOT, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    copyFileWithReplacements(claudeMdPath, join(globalClaudeDir, 'skills', 'ccchat', 'INTERNALS.md'));
  }
  console.log('  + Skill:      ~/.claude/skills/ccchat/ (+ references/ + INTERNALS.md)');

  ensureDir(join(globalClaudeDir, 'skills', 'leavechat'));
  copyFileWithReplacements(
    join(CCCHAT_ROOT, '.claude', 'skills', 'leavechat', 'SKILL.md'),
    join(globalClaudeDir, 'skills', 'leavechat', 'SKILL.md')
  );
  console.log('  + Skill:      ~/.claude/skills/leavechat/');

  ensureDir(join(globalClaudeDir, 'skills', 'bootstrap'));
  copyFileWithReplacements(
    join(CCCHAT_ROOT, '.claude', 'skills', 'bootstrap', 'SKILL.md'),
    join(globalClaudeDir, 'skills', 'bootstrap', 'SKILL.md')
  );
  console.log('  + Skill:      ~/.claude/skills/bootstrap/');

  ensureDir(join(globalClaudeDir, 'skills', 'digest'));
  copyFileWithReplacements(
    join(CCCHAT_ROOT, '.claude', 'skills', 'digest', 'SKILL.md'),
    join(globalClaudeDir, 'skills', 'digest', 'SKILL.md')
  );
  console.log('  + Skill:      ~/.claude/skills/digest/');

  // Hooks + statusline
  mergeSettings(join(globalClaudeDir, 'settings.json'), cmds);
  console.log('  + Hooks:      ~/.claude/settings.json');
  console.log('                UserPromptSubmit: poll');
  console.log('                SessionStart: auto-spawn chat-watch');
  console.log('                Stop, SessionEnd, PostToolUse');
  console.log('  + StatusLine: context bar (🟢🟡🔴 at 60%/80%)');

  console.log('\nccchat v2 is now available in ALL Claude Code sessions.');
  console.log('Per-project setup (optional):');
  console.log(`  node ${join(CCCHAT_ROOT, 'scripts', 'setup.js')} --name "my-agent"\n`);
  process.exit(0);
}

// ── Project-level install ───────────────────────────────────

const claudeDir = join(projectDir, '.claude');
const cmds = buildCmds(CCCHAT_ROOT);

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
console.log('  + Agent:      .claude/agents/ccchat.md');

// Skill
ensureDir(join(claudeDir, 'skills', 'ccchat'));
copyFileWithReplacements(
  join(CCCHAT_ROOT, '.claude', 'skills', 'ccchat', 'SKILL.md'),
  join(claudeDir, 'skills', 'ccchat', 'SKILL.md')
);
copyDirWithReplacements(
  join(CCCHAT_ROOT, '.claude', 'skills', 'ccchat', 'references'),
  join(claudeDir, 'skills', 'ccchat', 'references')
);
console.log('  + Skill:      .claude/skills/ccchat/ (+ references/)');

// Identity file
const identityData = { name: agentName, projectPath: projectDir, rooms: [room] };
writeFileSync(join(claudeDir, 'ccchat-identity.json'), JSON.stringify(identityData, null, 2) + '\n');
console.log(`  + Identity:   .claude/ccchat-identity.json (name: "${agentName}", room: "${room}")`);

// Hooks + statusline
mergeSettings(join(claudeDir, 'settings.json'), cmds);
console.log('  + Hooks:      .claude/settings.json');
console.log('                UserPromptSubmit: poll');
console.log('                Stop, SessionEnd, PostToolUse');
console.log('  + StatusLine: context bar (🟢🟡🔴 at 60%/80%)');

// Register agent in DB
try {
  const { upsertAgent, initCursorIfNew, closeDb } = await import('../lib/db.js');
  upsertAgent({ name: agentName, projectPath: projectDir, rooms: [room] });
  initCursorIfNew(agentName, projectDir, room);
  closeDb();
  console.log(`  + DB:         "${agentName}" registered in room "${room}"`);
} catch (e) {
  console.log(`  ~ DB registration skipped: ${e.message}`);
}

console.log('\nDone! ccchat v2 is ready in this project.\n');
