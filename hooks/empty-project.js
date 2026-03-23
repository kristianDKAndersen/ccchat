#!/usr/bin/env node
// UserPromptSubmit hook — nudge /summon in empty projects.
// Fires once per session (writes marker to avoid repeated banners).

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

try {
  const cwd = process.cwd();

  // Check if project has a CLAUDE.md (local setup indicator)
  const hasLocalClaude =
    existsSync(join(cwd, 'CLAUDE.md')) ||
    existsSync(join(cwd, '.claude', 'CLAUDE.md'));

  if (hasLocalClaude) process.exit(0);

  // Only nudge once per session — check for marker
  const markerDir = join(cwd, '.claude');
  const marker = join(markerDir, '.summon-nudged');

  if (existsSync(marker)) process.exit(0);

  // Write marker so we don't nudge again
  if (!existsSync(markerDir)) mkdirSync(markerDir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());

  console.error('EMPTY PROJECT: No CLAUDE.md found. You MUST run /summon before starting work — get bootstrapping help from an experienced agent. Do NOT proceed without running /summon first.');
} catch {
  // Hook must never fail loudly
}
