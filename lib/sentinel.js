// Sentinel file helpers for fast-path message notification.
// Senders touch a sentinel after insert; pollers check mtime for near-instant detection.

import { statSync, utimesSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const NOTIFY_DIR = join(homedir(), '.claude', 'ccchat', 'notify');
let dirCreated = false;

export function sentinelDir() {
  if (!dirCreated) {
    mkdirSync(NOTIFY_DIR, { recursive: true });
    dirCreated = true;
  }
  return NOTIFY_DIR;
}

export function sentinelPath(projectHash, agentName) {
  return join(sentinelDir(), `${projectHash}-${agentName}`);
}

export function touchSentinel(projectHash, agentName) {
  try {
    const p = sentinelPath(projectHash, agentName);
    const now = new Date();
    try {
      utimesSync(p, now, now);
    } catch {
      writeFileSync(p, '');
    }
  } catch {
    // Must never crash the caller
  }
}

export function removeSentinel(projectHash, agentName) {
  try {
    unlinkSync(sentinelPath(projectHash, agentName));
  } catch {
    // File may not exist — that's fine
  }
}

export function isSentinelFresh(projectHash, agentName, maxAgeMs = 5000) {
  try {
    const st = statSync(sentinelPath(projectHash, agentName));
    return (Date.now() - st.mtimeMs) < maxAgeMs;
  } catch {
    return false;
  }
}
