#!/usr/bin/env node
// Session Bootstrap v2 — gap detector for Claude Code sessions.
//
// Only surfaces what ISN'T already in context (CLAUDE.md, gitStatus, memory).
// Drops file tree and git state (always redundant with Claude Code's built-in context).
// Adds session diff: changes since last bootstrap via stored SHA.
//
// Usage:
//   node session-bootstrap.js [--project <path>] [--name <agent>] [--format json|text]

import { execSync } from 'child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { resolve } from 'path';

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
const shaFile = join(projectPath, '.claude', '.last-bootstrap-sha');

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: projectPath, encoding: 'utf8', timeout: 5000, ...opts }).trim();
  } catch {
    return null;
  }
}

// ── CLAUDE.md staleness ──

function getClaudeMdStaleness() {
  const claudeMdPath = join(projectPath, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    return { exists: false, staleness: 'missing', message: 'No CLAUDE.md found' };
  }

  const stat = statSync(claudeMdPath);
  const lastModified = stat.mtime;
  const daysSinceModified = Math.floor((Date.now() - lastModified.getTime()) / (1000 * 60 * 60 * 24));

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

// ── Session diff (changes since last bootstrap) ──

function getSessionDiff() {
  const isGit = existsSync(join(projectPath, '.git'));
  if (!isGit) return null;

  let lastSha = null;
  if (existsSync(shaFile)) {
    lastSha = readFileSync(shaFile, 'utf8').trim();
    // Validate the SHA still exists in the repo
    const valid = run(`git rev-parse --verify ${lastSha}^{commit}`);
    if (!valid) lastSha = null;
  }

  if (!lastSha) {
    // No valid previous SHA — fall back to last 24h of commits
    const diffStat = run('git log --since="24 hours ago" --oneline');
    if (!diffStat) return { source: 'time_fallback', period: '24h', changes: [], message: 'No commits in last 24h' };

    const commits = diffStat.split('\n').filter(Boolean);
    const fileStat = run('git diff --stat HEAD~' + Math.min(commits.length, 20) + '..HEAD 2>/dev/null') ||
                     run('git log --since="24 hours ago" --name-only --pretty=format: | sort -u');
    const files = fileStat ? fileStat.split('\n').filter(Boolean).slice(0, 15) : [];
    const totalFiles = fileStat ? fileStat.split('\n').filter(Boolean).length : 0;

    return {
      source: 'time_fallback',
      period: '24h',
      commit_count: commits.length,
      changes: files,
      has_more: totalFiles > 15,
      total_files: totalFiles,
      message: `${commits.length} commits in last 24h affecting ${totalFiles} files (first bootstrap — no previous SHA)`
    };
  }

  // Diff from stored SHA to HEAD
  const currentHead = run('git rev-parse HEAD');
  if (currentHead === lastSha) {
    return { source: 'sha', from: lastSha.slice(0, 8), changes: [], message: 'No changes since last session' };
  }

  const diffStat = run(`git diff --stat ${lastSha}..HEAD`);
  const logOneline = run(`git log --oneline ${lastSha}..HEAD`);
  const commits = logOneline ? logOneline.split('\n').filter(Boolean) : [];

  // Get file list capped at 15
  const nameOnly = run(`git diff --name-only ${lastSha}..HEAD`);
  const allFiles = nameOnly ? nameOnly.split('\n').filter(Boolean) : [];
  const files = allFiles.slice(0, 15);

  return {
    source: 'sha',
    from: lastSha.slice(0, 8),
    to: currentHead.slice(0, 8),
    commit_count: commits.length,
    commits: commits.slice(0, 10),
    changes: files,
    has_more: allFiles.length > 15,
    total_files: allFiles.length,
    summary: diffStat,
    message: `${commits.length} commits, ${allFiles.length} files changed since last session (${lastSha.slice(0, 8)}..${currentHead.slice(0, 8)})`
  };
}

// ── Decision log ──

function getDecisionLog() {
  const logPath = join(projectPath, '.decisions', 'log.yaml');
  if (!existsSync(logPath)) {
    return { exists: false, entries: [] };
  }

  try {
    const content = readFileSync(logPath, 'utf8');
    const entries = [];
    let current = null;

    function extractValue(raw) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
      return trimmed;
    }

    for (const line of content.split('\n')) {
      const entryMatch = line.match(/^- approach:\s*(.+)$/);
      if (entryMatch) {
        if (current) entries.push(current);
        current = { approach: extractValue(entryMatch[1]) };
        continue;
      }
      if (!current) continue;

      const fieldMatch = line.match(/^\s+(rejected|date|agent|context):\s*(.+)$/);
      if (fieldMatch) {
        current[fieldMatch[1]] = extractValue(fieldMatch[2]);
      }
    }
    if (current) entries.push(current);

    return {
      exists: true,
      total: entries.length,
      recent: entries.slice(-5)
    };
  } catch {
    return { exists: true, entries: [], note: 'Failed to parse decision log' };
  }
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

// ── Persist current HEAD for next session ──

function persistSha() {
  const isGit = existsSync(join(projectPath, '.git'));
  if (!isGit) return;

  const head = run('git rev-parse HEAD');
  if (!head) return;

  const claudeDir = join(projectPath, '.claude');
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
  writeFileSync(shaFile, head + '\n');
}

// ── Assemble ──

async function main() {
  const claudeMd = getClaudeMdStaleness();
  const sessionDiff = getSessionDiff();
  const decisionLog = getDecisionLog();
  const ccchat = await getCchatSummary();

  // Check if there's anything to report
  const hasGaps =
    claudeMd.staleness !== 'fresh' ||
    (sessionDiff && sessionDiff.changes && sessionDiff.changes.length > 0) ||
    (decisionLog.exists && decisionLog.recent?.length > 0) ||
    ccchat.total_unread > 0;

  const snapshot = {
    project: basename(projectPath),
    project_path: projectPath,
    timestamp: new Date().toISOString(),
    context_current: !hasGaps,
    ...(claudeMd.staleness !== 'fresh' && { claude_md: claudeMd }),
    ...(claudeMd.staleness === 'fresh' && { claude_md: { staleness: 'fresh', message: claudeMd.message } }),
    ...(sessionDiff && sessionDiff.changes?.length > 0 && { session_diff: sessionDiff }),
    ...(decisionLog.exists && decisionLog.recent?.length > 0 && { decision_log: decisionLog }),
    ...(ccchat.total_unread > 0 && { ccchat }),
  };

  if (format === 'text') {
    printText(snapshot, { claudeMd, sessionDiff, decisionLog, ccchat, hasGaps });
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
  }

  // Write current HEAD SHA for next session (write at end = read-then-write)
  persistSha();
}

function printText(s, { claudeMd, sessionDiff, decisionLog, ccchat, hasGaps }) {
  if (!hasGaps) {
    console.log(`Context is current. ${claudeMd.message}`);
    return;
  }

  console.log(`# Session Bootstrap: ${s.project}\n`);

  // CLAUDE.md staleness
  console.log('## CLAUDE.md');
  console.log(`  ${claudeMd.message}`);
  console.log();

  // Session diff
  if (sessionDiff && sessionDiff.changes?.length > 0) {
    console.log('## Changes Since Last Session');
    console.log(`  ${sessionDiff.message}`);
    if (sessionDiff.commits?.length > 0) {
      console.log('  Commits:');
      for (const c of sessionDiff.commits) console.log(`    ${c}`);
    }
    console.log('  Files:');
    for (const f of sessionDiff.changes) console.log(`    ${f}`);
    if (sessionDiff.has_more) {
      console.log(`    ... and ${sessionDiff.total_files - 15} more`);
    }
    console.log();
  }

  // Decision log
  if (decisionLog.exists && decisionLog.recent?.length > 0) {
    console.log('## Decision Log (recent dead ends)');
    for (const e of decisionLog.recent) {
      console.log(`  - ${e.approach} → rejected: ${e.rejected} (${e.date || 'no date'})`);
    }
    if (decisionLog.total > 5) {
      console.log(`  ... and ${decisionLog.total - 5} more`);
    }
    console.log();
  }

  // ccchat
  if (ccchat.total_unread > 0) {
    console.log('## ccchat');
    console.log(`  Unread: ${ccchat.total_unread}`);
    if (ccchat.online_count > 0) {
      console.log(`  Online: ${ccchat.online_agents.join(', ')}`);
    }
  }
}

main().catch(e => {
  console.error(`Bootstrap error: ${e.message}`);
  process.exit(1);
});
