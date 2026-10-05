import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'statusline.sh');

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function runStatusline(fixture) {
  const res = spawnSync('bash', [SCRIPT], {
    input: JSON.stringify(fixture),
    encoding: 'utf8',
  });
  return res;
}

const DOCS_EXAMPLE = {
  cwd: '/current/working/directory',
  session_id: 'abc123',
  session_name: 'my-session',
  prompt_id: '550e8400-e29b-41d4-a716-446655440000',
  transcript_path: '/path/to/transcript.jsonl',
  model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  workspace: {
    current_dir: '/current/working/directory',
    project_dir: '/original/project/directory',
    added_dirs: [],
    git_worktree: 'feature-xyz',
    repo: { host: 'github.com', owner: 'anthropics', name: 'claude-code' },
  },
  version: '2.1.90',
  output_style: { name: 'default' },
  cost: {
    total_cost_usd: 0.01234,
    total_duration_ms: 45000,
    total_api_duration_ms: 2300,
    total_lines_added: 156,
    total_lines_removed: 23,
  },
  context_window: {
    total_input_tokens: 15500,
    total_output_tokens: 1200,
    context_window_size: 200000,
    used_percentage: 8,
    remaining_percentage: 92,
    current_usage: {
      input_tokens: 8500,
      output_tokens: 1200,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 2000,
    },
  },
  exceeds_200k_tokens: false,
  prompt_cache: {
    warm: true,
    caching_observed: true,
    ttl: '1h',
    expires_at: 1738429200,
    requests: 14,
    misses: 2,
    expected_rebuilds: 1,
    hit_ratio: 0.91,
    cache_write_tokens: 352000,
    miss_recache_tokens: 310200,
    last_miss_at: 1738425230,
    recache_tokens_if_cold: 45000,
  },
  fast_mode: false,
  effort: { level: 'high' },
  thinking: { enabled: true },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: Math.floor(Date.now() / 1000) + 2 * 3600 + 10 * 60 },
    seven_day: { used_percentage: 41.2, resets_at: Math.floor(Date.now() / 1000) + 3 * 86400 + 4 * 3600 },
  },
  vim: { mode: 'NORMAL' },
  agent: { name: 'security-reviewer' },
  pr: { number: 1234, url: 'https://github.com/anthropics/claude-code/pull/1234', review_state: 'pending' },
  worktree: {
    name: 'my-feature',
    path: '/path/to/.claude/worktrees/my-feature',
    branch: 'worktree-my-feature',
    original_cwd: '/path/to/project',
    original_branch: 'main',
  },
};

test('docs example fixture: shows token label, project, effort, reset countdowns, no null', () => {
  const res = runStatusline(DOCS_EXAMPLE);
  assert.equal(res.status, 0, `exit code should be 0, stderr: ${res.stderr}`);
  const out = stripAnsi(res.stdout);
  assert.ok(!/null/i.test(out), `output must not contain "null": ${out}`);
  assert.match(out, /15k\/200k/, `expected token label, got: ${out}`);
  assert.match(out, /directory/, `expected project basename, got: ${out}`);
  assert.match(out, /Opus·high/, `expected model+effort, got: ${out}`);
  assert.match(out, /↻2h10m/, `expected 5h reset countdown, got: ${out}`);
  assert.match(out, /↻3d4h/, `expected 7d reset countdown, got: ${out}`);
  assert.match(out, /worktree-my-feature/, `expected worktree branch, got: ${out}`);
});

test('empty fixture ({}) prints a line without null/errors and exits 0', () => {
  const res = runStatusline({});
  assert.equal(res.status, 0, `exit code should be 0, stderr: ${res.stderr}`);
  const out = stripAnsi(res.stdout);
  assert.ok(out.trim().length > 0, 'expected non-empty output');
  assert.ok(!/null/i.test(out), `output must not contain "null": ${out}`);
});

test('fixture with only model prints a line without null/errors and exits 0', () => {
  const res = runStatusline({ model: { display_name: 'Sonnet' } });
  assert.equal(res.status, 0, `exit code should be 0, stderr: ${res.stderr}`);
  const out = stripAnsi(res.stdout);
  assert.match(out, /Sonnet/, `expected model name, got: ${out}`);
  assert.ok(!/null/i.test(out), `output must not contain "null": ${out}`);
});

test('agent fallback reads ccchat-identity.json in project_dir/.claude', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'statusline-test-'));
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(
    join(projectDir, '.claude', 'ccchat-identity.json'),
    JSON.stringify({ name: 'identity-agent-name' })
  );
  try {
    const fixture = {
      model: { display_name: 'Sonnet' },
      workspace: { project_dir: projectDir, current_dir: projectDir },
    };
    const res = runStatusline(fixture);
    assert.equal(res.status, 0, `exit code should be 0, stderr: ${res.stderr}`);
    const out = stripAnsi(res.stdout);
    assert.match(out, /identity-agent-name/, `expected identity fallback name, got: ${out}`);
    assert.ok(!/null/i.test(out), `output must not contain "null": ${out}`);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
