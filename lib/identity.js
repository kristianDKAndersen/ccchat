import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, basename } from 'path';
import { projectHash, getDb, insertMessage, searchMessages } from './db.js';

const DIVERGENCE_PREFIX = '[IDENTITY DIVERGENCE]';

function realpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Resolve agent identity from (in priority order):
 * 1. CLI flags (--name, --project)
 * 2. Environment variables (CCCHAT_AGENT, CCCHAT_PROJECT)
 * 3. .claude/ccchat-identity.json in project dir
 * 4. Fallback: directory basename as name, cwd as project
 *
 * After resolution, validates against the DB (authoritative source).
 * Divergence emits a stderr warning — the DB wins.
 */
export function resolveIdentity({ name, project, rooms } = {}) {
  const projectPath = realpath(project || process.env.CCCHAT_PROJECT || findProjectPath() || process.cwd());
  const identityFile = loadIdentityFile(projectPath);
  const agentName = name || process.env.CCCHAT_AGENT || identityFile?.name || basename(projectPath);
  const agentRooms = rooms || identityFile?.rooms || ['general'];

  const resolved = {
    name: agentName.toLowerCase(),
    projectPath,
    projectHash: projectHash(projectPath),
    rooms: agentRooms,
  };

  // Validate identity file against DB (DB is authoritative)
  if (identityFile && !name && !process.env.CCCHAT_AGENT) {
    validateIdentity(resolved, identityFile);
  }

  return resolved;
}

/**
 * Cross-check identity file against the DB. Warn on divergence.
 * DB is the source of truth — identity file is a bootstrap artifact.
 */
function validateIdentity(resolved, identityFile) {
  try {
    const d = getDb();
    const hash = projectHash(resolved.projectPath);
    const dbAgent = d.prepare('SELECT name, rooms FROM agents WHERE name = ? AND project_hash = ?')
      .get(resolved.name, hash);

    if (!dbAgent) return; // Agent not in DB yet — first run, no divergence possible

    const divergences = [];

    // Check name divergence
    if (identityFile.name && identityFile.name.toLowerCase() !== dbAgent.name) {
      divergences.push(`Name: file="${identityFile.name}", DB="${dbAgent.name}"`);
      resolved.name = dbAgent.name;
    }

    // Check room divergence
    let dbRooms;
    try { dbRooms = JSON.parse(dbAgent.rooms); } catch { dbRooms = ['general']; }
    const fileRooms = identityFile.rooms || ['general'];
    const fileMissing = dbRooms.filter(r => !fileRooms.includes(r));
    const fileExtra = fileRooms.filter(r => !dbRooms.includes(r));

    if (fileMissing.length > 0 || fileExtra.length > 0) {
      divergences.push(`Rooms: DB=[${dbRooms.join(',')}], file=[${fileRooms.join(',')}]`);
      resolved.rooms = dbRooms;
    }

    if (divergences.length > 0) {
      const msg = `${DIVERGENCE_PREFIX} Agent "${resolved.name}" (project ${hash}): ${divergences.join('; ')}. DB is authoritative. Update .claude/ccchat-identity.json to match.`;
      process.stderr.write(`ccchat: ${msg}\n`);
      persistDivergenceWarning(resolved.name, hash, msg);
    }
  } catch {
    // Validation is best-effort — don't crash on DB errors
  }
}

/**
 * Persist identity divergence as a system message in general room.
 * 24h dedup: skip if a matching warning was already posted recently.
 */
function persistDivergenceWarning(agentName, hash, message) {
  try {
    const d = getDb();
    // Dedup: check for existing divergence warning from this agent in last 24h
    const recent = d.prepare(`
      SELECT id FROM messages
      WHERE type = 'system' AND from_agent = ? AND room = 'general'
        AND content LIKE ? AND created_at > datetime('now', '-24 hours')
      LIMIT 1
    `).get(agentName, `${DIVERGENCE_PREFIX}%`);

    if (recent) return; // Already warned recently

    insertMessage({
      type: 'system',
      fromAgent: agentName,
      fromProject: null,
      room: 'general',
      content: message,
    });
  } catch {
    // Best-effort — don't crash if DB insert fails
  }
}

function findProjectPath() {
  const identityFile = loadIdentityFile(process.cwd());
  return identityFile?.projectPath || null;
}

function loadIdentityFile(dir) {
  const p = join(dir, '.claude', 'ccchat-identity.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
