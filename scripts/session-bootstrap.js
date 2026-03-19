#!/usr/bin/env node
// Session Bootstrap — fast project orientation for new Claude Code sessions.
//
// Outputs a structured JSON snapshot: file tree, git state, CLAUDE.md staleness,
// and unread ccchat summary. Designed to be piped into agent context on session start.
//
// Usage:
//   node session-bootstrap.js [--project <path>] [--name <agent>] [--format json|text]

import { execSync } from 'child_process';
import { existsSync, statSync, readdirSync, readFileSync } from 'fs';
import { join, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  return (next && !next.startsWith('--')) ? next : true;
}

const projectPath = resolve(getFlag('project') || process.cwd());
const agentName = getFlag('name') || basename(projectPath);
const format = getFlag('format') || 'json';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: projectPath, encoding: 'utf8', timeout: 5000, ...opts }).trim();
  } catch {
    return null;
  }
}

// ── File tree (top-level + depth 2, excluding common noise) ──

function getFileTree() {
  const ignore = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', '__pycache__',
    '.cache', 'coverage', '.DS_Store', '.env', 'venv', '.venv',
    'target', 'vendor', '.idea', '.vscode'
  ]);

  const tree = [];
  try {
    const entries = readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.claude') continue;

      if (entry.isDirectory()) {
        const subEntries = [];
        try {
          const children = readdirSync(join(projectPath, entry.name), { withFileTypes: true });
          for (const child of children) {
            if (ignore.has(child.name)) continue;
            subEntries.push(child.isDirectory() ? `${child.name}/` : child.name);
          }
        } catch { /* permission denied etc */ }
        tree.push({ name: `${entry.name}/`, children: subEntries });
      } else {
        tree.push({ name: entry.name });
      }
    }
  } catch { /* not a directory */ }
  return tree;
}

// ── Git state ──

function getGitState() {
  const isGit = existsSync(join(projectPath, '.git'));
  if (!isGit) return null;

  const branch = run('git rev-parse --abbrev-ref HEAD');
  const status = run('git status --porcelain');
  const recentCommits = run('git log --oneline -10');
  const branches = run('git branch --list');

  const dirty = status ? status.split('\n').filter(Boolean) : [];

  return {
    branch,
    dirty_files: dirty.length,
    dirty_summary: dirty.slice(0, 10).map(l => l.trim()),
    recent_commits: recentCommits ? recentCommits.split('\n') : [],
    local_branches: branches ? branches.split('\n').map(b => b.trim()).filter(Boolean) : []
  };
}

// ── CLAUDE.md staleness ──

function getClaudeMdStaleness() {
  const claudeMdPath = join(projectPath, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    return { exists: false, message: 'No CLAUDE.md found' };
  }

  const stat = statSync(claudeMdPath);
  const lastModified = stat.mtime;
  const daysSinceModified = Math.floor((Date.now() - lastModified.getTime()) / (1000 * 60 * 60 * 24));

  // Count files modified since CLAUDE.md was last updated
  const isoDate = lastModified.toISOString().split('T')[0];
  const filesChangedSince = run(`git log --since="${isoDate}" --name-only --pretty=format: | sort -u | grep -c .`);
  const filesChanged = filesChangedSince ? parseInt(filesChangedSince, 10) : 0;

  let staleness = 'fresh';
  if (daysSinceModified > 30 || filesChanged > 20) staleness = 'stale';
  else if (daysSinceModified > 7 || filesChanged > 10) staleness = 'aging';

  return {
    exists: true,
    last_modified: lastModified.toISOString(),
    days_since_modified: daysSinceModified,
    files_changed_since: filesChanged,
    staleness,
    message: staleness === 'fresh'
      ? `CLAUDE.md is current (${daysSinceModified}d old, ${filesChanged} files changed since)`
      : `CLAUDE.md may be stale (${daysSinceModified}d old, ${filesChanged} files changed since) — consider updating`
  };
}

// ── Unread ccchat summary ──

async function getCchatSummary() {
  try {
    const { getUnreadCountAllRooms, getOnlineAgents, closeDb } = await import('../lib/db.js');
    const counts = getUnreadCountAllRooms(agentName, projectPath);
    const online = getOnlineAgents();
    closeDb();

    const totalUnread = [...counts.values()].reduce((a, b) => a + b, 0);
    const roomCounts = Object.fromEntries(counts);

    return {
      total_unread: totalUnread,
      unread_by_room: roomCounts,
      online_agents: online.map(a => a.name),
      online_count: online.length
    };
  } catch {
    return { total_unread: 0, unread_by_room: {}, online_agents: [], online_count: 0, note: 'ccchat DB not available' };
  }
}

// ── Decision log ──

function getDecisionLog() {
  const logPath = join(projectPath, '.decisions', 'log.yaml');
  if (!existsSync(logPath)) {
    return { exists: false, entries: [] };
  }

  try {
    const content = readFileSync(logPath, 'utf8');
    // Simple YAML list parser for the strict schema:
    // - approach: '...'
    //   rejected: '...'
    //   date: '...'
    //   agent: '...'
    //   context: '...'
    const entries = [];
    let current = null;

    for (const line of content.split('\n')) {
      const entryMatch = line.match(/^- approach:\s*'(.+)'$/);
      if (entryMatch) {
        if (current) entries.push(current);
        current = { approach: entryMatch[1] };
        continue;
      }
      if (!current) continue;

      const fieldMatch = line.match(/^\s+(rejected|date|agent|context):\s*'(.+)'$/);
      if (fieldMatch) {
        current[fieldMatch[1]] = fieldMatch[2];
      }
    }
    if (current) entries.push(current);

    // Return last 5 entries (most recent)
    return {
      exists: true,
      total: entries.length,
      recent: entries.slice(-5)
    };
  } catch {
    return { exists: true, entries: [], note: 'Failed to parse decision log' };
  }
}

// ── Assemble ──

async function main() {
  const snapshot = {
    project: basename(projectPath),
    project_path: projectPath,
    timestamp: new Date().toISOString(),
    file_tree: getFileTree(),
    git: getGitState(),
    claude_md: getClaudeMdStaleness(),
    decision_log: getDecisionLog(),
    ccchat: await getCchatSummary()
  };

  if (format === 'text') {
    printText(snapshot);
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
  }
}

function printText(s) {
  console.log(`# Session Bootstrap: ${s.project}`);
  console.log(`Path: ${s.project_path}`);
  console.log(`Time: ${s.timestamp}\n`);

  // File tree
  console.log('## File Tree');
  for (const entry of s.file_tree) {
    if (entry.children) {
      console.log(`  ${entry.name} (${entry.children.length} items)`);
    } else {
      console.log(`  ${entry.name}`);
    }
  }
  console.log();

  // Git
  if (s.git) {
    console.log('## Git State');
    console.log(`  Branch: ${s.git.branch}`);
    console.log(`  Dirty files: ${s.git.dirty_files}`);
    if (s.git.dirty_summary.length > 0) {
      for (const f of s.git.dirty_summary) console.log(`    ${f}`);
    }
    console.log(`  Recent commits:`);
    for (const c of s.git.recent_commits.slice(0, 5)) console.log(`    ${c}`);
    console.log(`  Branches: ${s.git.local_branches.join(', ')}`);
    console.log();
  }

  // CLAUDE.md
  console.log('## CLAUDE.md');
  console.log(`  ${s.claude_md.message}`);
  console.log();

  // Decision log
  if (s.decision_log.exists && s.decision_log.recent?.length > 0) {
    console.log('## Decision Log (recent dead ends)');
    for (const e of s.decision_log.recent) {
      console.log(`  - ${e.approach} → rejected: ${e.rejected} (${e.date || 'no date'})`);
    }
    if (s.decision_log.total > 5) {
      console.log(`  ... and ${s.decision_log.total - 5} more`);
    }
    console.log();
  }

  // ccchat
  console.log('## ccchat');
  console.log(`  Unread: ${s.ccchat.total_unread}`);
  if (s.ccchat.online_count > 0) {
    console.log(`  Online: ${s.ccchat.online_agents.join(', ')}`);
  }
}

main().catch(e => {
  console.error(`Bootstrap error: ${e.message}`);
  process.exit(1);
});
