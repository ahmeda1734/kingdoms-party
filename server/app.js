// Builds the KINGDOMS PARTY app: HTTP static server + WS rooms.
// Exported separately from index.js so tests can spawn isolated instances.


import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Rooms } from './rooms.js';
import { C2S, S2C, msg } from '../shared/protocol.js';
import { MAX_PLAYERS } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '../client');
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // /shared/* serves the shared sim code consumed by the client via ESM imports.
  const ROOT = path.resolve(__dirname, '..');
  const baseDir = urlPath.startsWith('/shared/') ? ROOT : CLIENT_DIR;
  // Lobby deep links (e.g. /room/AB12CD) serve the SPA shell.
  const filePath = path.join(baseDir, path.normalize(urlPath).replace(/^([/.\\])+/, ''));
  if (!filePath.startsWith(baseDir)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(CLIENT_DIR, 'index.html'), (err2, shell) => {
        if (err2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(shell);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Rooms();

wss.on('connection', (ws) => {
  let bound = null; // { room, player }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (typeof m.t !== 'string') return;

    // ---- pre-join messages: JOIN opens or restores a player slot ----
    if (m.t === C2S.JOIN) {
      if (bound) return;
      const name = String(m.name || 'Kingdom').slice(0, 20);
      let room = null;
      if (m.room) {
        room = rooms.rooms.get(String(m.room).toUpperCase());
        if (!room) { ws.send(JSON.stringify(msg(S2C.ERROR, { code: 'room_not_found', message: 'الغرفة غير موجودة' }))); return; }
      }
      const restoring = room && m.token && [...room.players.values()].some(p => p.token === m.token);
      if (room && !restoring && room.state !== 'lobby') {
        ws.send(JSON.stringify(msg(S2C.ERROR, { code: 'game_running', message: 'المباراة بدأت فعلاً' })));
        return;
      }
      const result = room ? rooms.joinRoom(room, ws, name, m.token) : rooms.createRoom(ws, name);
      if (result.error) { ws.send(JSON.stringify(msg(S2C.ERROR, { code: result.error, message: 'الغرفة ممتلئة' }))); return; }
      const { player } = result;
      room = result.room; // for a new room this is the room we just created
      bound = { room, player };
      ws.send(JSON.stringify(msg(S2C.JOINED, {
        playerId: player.pid, token: player.token, room: room.code, code: room.code,
        state: room.state, rejoined: !!result.rejoined,
        players: [...room.players.values()].map(p => ({ pid: p.pid, name: p.name, color: p.color, host: p.pid === room.hostPid, connected: p.connected })),
      })));
      if (room.state === 'playing') {
        rooms.sendGameInit(room, player, [...room.players.values()].filter(p => p.connected));
      }
      rooms.broadcastRoomUpdate(room);
      return;
    }

    if (!bound) return;
    const { room, player } = bound;
    // Only from the bound socket: commands bound to the bound player token.
    if (m.token && m.token !== player.token) return;

    player.lastSeen = Date.now();
    switch (m.t) {
      case C2S.START: {
        if (player.pid !== room.hostPid) return;
        rooms.startGame(room);
        rooms.broadcastRoomUpdate(room);
        break;
      }
      case C2S.READY:
        player.ready = !!m.ready;
        rooms.broadcastRoomUpdate(room);
        break;
      case C2S.CHAT:
        rooms.broadcastChat(room, player, m.text ?? '');
        break;
      default:
        rooms.handleCommand(room, player, m);
    }
  });

  ws.on('close', () => {
    if (!bound) return;
    const { room, player } = bound;
    if (player.ws === ws) { player.ws = null; player.connected = false; player.lastSeen = Date.now(); }
    rooms.broadcastRoomUpdate(room);
  });

  ws.on('pong', () => { if (bound) bound.player.lastSeen = Date.now(); });
});

// Liveness pings.
setInterval(() => {
  for (const c of wss.clients) {
    if (c.isAlive === false) { c.terminate(); continue; }
    c.isAlive = false; c.ping();
    c.once('pong', () => { c.isAlive = true; });
  }
}, 10000).unref();


export function createApp() {
  return { server, wss, rooms };
}
