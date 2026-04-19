#!/usr/bin/env node
// One-time migration: convert old identity files from {rooms: [...]} to {currentRoom: 'lobby'}.
// Safe to run multiple times — files already migrated are skipped.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getDb, closeDb } from '../lib/db.js';

let migrated = 0;
let skipped = 0;

try {
  const d = getDb();
  const rows = d.prepare('SELECT DISTINCT project_path FROM agents').all();

  for (const row of rows) {
    const identityPath = join(row.project_path, '.claude', 'ccchat-identity.json');
    if (!existsSync(identityPath)) { skipped++; continue; }

    let data;
    try {
      data = JSON.parse(readFileSync(identityPath, 'utf8'));
    } catch {
      skipped++;
      continue;
    }

    if (!data.rooms) { skipped++; continue; } // already migrated or no rooms field

    // Migrate: replace rooms array with currentRoom string
    const currentRoom = 'lobby';
    const { rooms: _removed, ...rest } = data;
    const updated = { ...rest, currentRoom };
    writeFileSync(identityPath, JSON.stringify(updated, null, 2) + '\n');
    migrated++;
  }

  console.log(`Migrated ${migrated}; skipped ${skipped}`);
} finally {
  closeDb();
}
