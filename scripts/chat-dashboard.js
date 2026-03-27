#!/usr/bin/env node
// Real-time web dashboard for ccchat.
// Usage: node chat-dashboard.js [--port 3000] [--host localhost]

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getHistory, getOnlineAgents, getPinnedMessages, searchMessages,
  getThreadMessages, getAllRooms, getMessagesSinceGlobal, getMessageCount,
  closeDb
} from '../lib/db.js';
import { parseMetadata } from '../lib/format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
function getFlag(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const PORT = parseInt(getFlag('port') || '3000', 10);
const HOST = getFlag('host') || 'localhost';

// Cache HTML at startup
let html;
try {
  html = readFileSync(join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
} catch {
  console.error('Error: dashboard/index.html not found.');
  process.exit(1);
}

// ── API helpers ─────────────────────────────────────────────────────────────

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function parseQuery(url) {
  const q = new URL(url, 'http://localhost');
  return q.searchParams;
}

function formatMsg(m) {
  const meta = parseMetadata(m.metadata);
  return {
    id: m.id,
    type: m.type,
    from: m.from_agent,
    from_project: m.from_project,
    to: m.to_agent,
    room: m.room,
    content: m.content,
    parent_id: m.parent_id,
    pinned: m.pinned === 1,
    created_at: m.created_at,
    mentions: meta.mentions || [],
    priority: meta.priority || 'normal',
    task_status: meta.task_status || null,
    evidence: meta.evidence || null,
    compact: meta.compact || false,
  };
}

// ── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Set();
let globalLastId = 0;
let lastAgentSnapshot = '';

// Initialize globalLastId from DB
try {
  const rooms = getAllRooms();
  for (const room of rooms) {
    const { messages } = getHistory(room, 1);
    if (messages.length && messages[0].id > globalLastId) {
      globalLastId = messages[0].id;
    }
  }
} catch { /* empty db is fine */ }

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// Poll for new messages every 1.5s
const pollInterval = setInterval(() => {
  try {
    const messages = getMessagesSinceGlobal(globalLastId);
    if (messages.length > 0) {
      globalLastId = messages[messages.length - 1].id;
      broadcast('messages', messages.map(formatMsg));
    }

    // Agent status changes
    const agents = getOnlineAgents().map(a => ({
      name: a.name,
      project: a.project_path,
      rooms: JSON.parse(a.rooms || '["general"]'),
      last_seen: a.last_seen,
    }));
    const snap = JSON.stringify(agents);
    if (snap !== lastAgentSnapshot) {
      lastAgentSnapshot = snap;
      broadcast('agents', agents);
    }
  } catch { /* db might be locked briefly */ }
}, 1500);

// Keepalive every 15s
const keepaliveInterval = setInterval(() => {
  broadcast('ping', { time: new Date().toISOString() });
}, 15000);

// ── HTTP Server ─────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = req.url;
  const path = url.split('?')[0];

  // Serve dashboard HTML
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // SSE endpoint
  if (path === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // REST API
  try {
    const params = parseQuery(url);

    if (path === '/api/rooms') {
      const rooms = getAllRooms();
      const data = rooms.map(r => ({ name: r, count: getMessageCount(r) }));
      jsonResponse(res, data);
      return;
    }

    if (path === '/api/agents') {
      const agents = getOnlineAgents().map(a => ({
        name: a.name,
        project: a.project_path,
        rooms: JSON.parse(a.rooms || '["general"]'),
        last_seen: a.last_seen,
      }));
      jsonResponse(res, agents);
      return;
    }

    if (path === '/api/history') {
      const room = params.get('room') || 'general';
      const last = parseInt(params.get('last') || '50', 10);
      const beforeId = params.get('before') ? parseInt(params.get('before'), 10) : null;
      const { messages, has_more } = getHistory(room, last, beforeId);
      jsonResponse(res, { messages: messages.map(formatMsg), has_more });
      return;
    }

    if (path === '/api/pinned') {
      const room = params.get('room') || 'general';
      jsonResponse(res, getPinnedMessages(room).map(formatMsg));
      return;
    }

    if (path === '/api/search') {
      const room = params.get('room') || 'general';
      const query = params.get('q') || '';
      if (!query) { jsonResponse(res, []); return; }
      jsonResponse(res, searchMessages(room, query, 30).map(formatMsg));
      return;
    }

    if (path === '/api/thread') {
      const id = parseInt(params.get('id') || '0', 10);
      if (!id) { jsonResponse(res, [], 400); return; }
      jsonResponse(res, getThreadMessages(id).map(formatMsg));
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ccchat dashboard → http://${HOST}:${PORT}`);
});

// Cleanup
function shutdown() {
  clearInterval(pollInterval);
  clearInterval(keepaliveInterval);
  for (const client of sseClients) {
    try { client.end(); } catch {}
  }
  server.close();
  closeDb();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
