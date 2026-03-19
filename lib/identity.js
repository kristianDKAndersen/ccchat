import { existsSync, readFileSync, realpathSync } from 'fs';
import { join, basename } from 'path';
import { projectHash } from './db.js';

function realpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * Resolve agent identity from (in priority order):
 * 1. CLI flags (--name, --project)
 * 2. Environment variables (CCCHAT_AGENT, CCCHAT_PROJECT)
 * 3. .claude/ccchat-identity.json in project dir
 * 4. Fallback: directory basename as name, cwd as project
 */
export function resolveIdentity({ name, project, rooms } = {}) {
  const projectPath = realpath(project || process.env.CCCHAT_PROJECT || findProjectPath() || process.cwd());
  const agentName = name || process.env.CCCHAT_AGENT || loadIdentityFile(projectPath)?.name || basename(projectPath);
  const agentRooms = rooms || loadIdentityFile(projectPath)?.rooms || ['general'];

  return {
    name: agentName.toLowerCase(),
    projectPath,
    projectHash: projectHash(projectPath),
    rooms: agentRooms,
  };
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
