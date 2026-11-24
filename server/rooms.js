// Room management: join codes, host, ready flags, start, snapshots, reconnect.
// One Sim per room; snapshots are per-player (fog of war + per-client deltas).

import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { TICK_MS, SNAPSHOT_EVERY_TICKS, RECONNECT_GRACE_MS, MAP_W, MAP_H, T, WORKER, PLAYER_COLORS, MAX_PLAYERS, UNIT } from '../shared/constants.js';
import { generate, mapFingerprint, rleEncode } from '../shared/mapgen.js';
import { Sim } from './sim.js';
import { msg, S2C, C2S } from '../shared/protocol.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export class Rooms {
  constructor() {
    this.rooms = new Map();
    setInterval(() => this.sweep(), 5000).unref();
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      // Delete long-empty lobbies and long-forgotten finished rooms.
      const anyLive = [...room.players.values()].some(p => p.connected || now - p.lastSeen < RECONNECT_GRACE_MS * 3);
      if (!anyLive && now - room.createdAt > RECONNECT_GRACE_MS) {
        this.rooms.delete(code);
        if (room.timer) { clearInterval(room.timer); room.timer = null; }
      } else if (room.state === 'playing' && !room.players.size && room.timer) {
        clearInterval(room.timer); room.timer = null; room.state = 'finished';
      }
      for (const p of room.players.values()) {
        if (p.connected && p.ws && now - p.lastSeen > 15000) {
          p.connected = false; p.ws = null;
          this.broadcastRoomUpdate(room);
        }
      }
    }
  }

  createRoom(hostWs, name) {
    let code = '';
    do { code = randomBytes(4).toString('hex').toUpperCase().split('').map(c => CODE_CHARS[parseInt(c, 16) % CODE_CHARS.length]).join(''); } while (this.rooms.has(code));
    const room = {
      code, players: new Map(), nextPid: 1, hostPid: null,
      state: 'lobby', sim: null, world: null,
      createdAt: Date.now(), chat: [], timer: null,
    };
    this.rooms.set(code, room);
    return this.joinRoom(room, hostWs, name, null);
  }

  joinRoom(room, ws, name, token) {
    // Reconnect path: token matches an existing (dropped) player.
    if (token) {
      for (const p of room.players.values()) {
        if (p.token === token) {
          p.ws = ws; p.connected = true; p.lastSeen = Date.now(); p.name = name || p.name;
          return { room, player: p, rejoined: true };
        }
      }
    }
    if (room.players.size >= MAX_PLAYERS) return { error: 'room_full' };
    const pid = room.nextPid++;
    const player = {
      pid, name: (name || 'Kingdom').slice(0, 20), token: randomBytes(12).toString('hex'),
      ws, connected: true, ready: false, lastSeen: Date.now(),
      lastNodeAmounts: new Map(), lastFog: null,
      color: PLAYER_COLORS[(pid - 1) % PLAYER_COLORS.length],
    };
    room.players.set(pid, player);
    if (room.hostPid === null) room.hostPid = pid;
    return { room, player, rejoined: false };
  }

  startGame(room) {
    const present = [...room.players.values()].filter(p => p.connected);
    if (present.length === 0) return;
    room.state = 'playing';
    const playerCount = present.length;
    room.world = generate(room.code + '-seed1', playerCount);
    const playersMap = new Map();
    const ordered = [...room.players.values()].filter(p => p.connected);
    ordered.forEach((p, i) => {
      playersMap.set(p.pid, {
        id: p.pid, name: p.name, color: p.color, spawn: room.world.spawns[i],
      });
    });
    room.sim = new Sim(room.world, playersMap);
    room.sim.tick = 0;

    for (const p of ordered) this.sendGameInit(room, p, ordered);

    room.timer = setInterval(() => this.gameTick(room), TICK_MS);
    if (room.timer.unref) room.timer.unref();
  }

  sendGameInit(room, player, allPlayers) {
    const world = room.world;
    player.lastNodeAmounts.clear();
    for (const n of world.nodesById.values()) player.lastNodeAmounts.set(n.id, n.amount);
    player.lastFog = new Uint8Array(room.sim.fog.get(player.pid));

    const simPlayer = room.sim.players.get(player.pid);
    const payload = {
      t: S2C.GAME_INIT,
      playerId: player.pid, token: player.token,
      seed: world.seed, fingerprint: mapFingerprint(world),
      mapW: MAP_W, mapH: MAP_H, tile: 32,
      terrain: rleEncode(world.terrain),
      nodes: world.nodes.map(n => ({ id: n.id, type: n.type, x: n.x, y: n.y, amount: n.amount, max: n.max })),
      spawns: allPlayers.map((p, i) => ({ pid: p.pid, x: world.spawns[i][0], y: world.spawns[i][1], color: p.color, name: p.name })),
      workers: room.sim.units.size,
      players: [...room.sim.players.values()].map(sp => ({ id: sp.id, name: sp.name, color: sp.color })),
      yourSpawn: simPlayer ? simPlayer.spawn : null,
      tickMs: TICK_MS,
    };
    player.ws.send(JSON.stringify(payload));
  }

  gameTick(room) {
    const sim = room.sim;
    if (!sim) return;
    sim.update();
    if (sim.tick % SNAPSHOT_EVERY_TICKS !== 0) return;
    for (const p of room.players.values()) {
      if (p.connected && p.ws) this.sendSnapshot(room, p);
    }
  }

  sendSnapshot(room, p) {
    const sim = room.sim;
    const stocks = {};
    for (const [pid, s] of sim.stocks) stocks[pid] = s;

    const yourWorkers = [];
    const others = [];
    const fog = sim.fog.get(p.pid);
    // Buildings: all completed/under-construction buildings siting inside the
    // player's explored fog (>=1) stay visible once discovered.
    const buildings = [];
    for (const b of sim.buildings.values()) {
      if (fog[b.y * MAP_W + b.x] >= 1) {
        buildings.push({
          id: b.id, owner: b.owner, type: b.type, x: b.x, y: b.y, size: b.size,
          done: b.done, now: sim.tick,
        });
      }
    }
    const trainingQ = sim.trainingQueues.get(p.pid);
    for (const u of sim.units.values()) {
      if (u.owner === p.pid) {
        yourWorkers.push({
          id: u.id, x: Math.round(u.x * 10) / 10, y: Math.round(u.y * 10) / 10,
          state: u.state, nodeId: u.nodeId, carry: Math.round(u.carry * 10) / 10,
          carryType: u.carryType,
        });
      } else {
        const tx = Math.floor(u.x / 32), ty = Math.floor(u.y / 32);
        if (fog[ty * MAP_W + tx] === 2) {
          others.push({ id: u.id, owner: u.owner, x: Math.round(u.x), y: Math.round(u.y) });
        }
      }
    }

    // Resource deltas vs last snapshot sent to THIS client.
    const changed = [], depleted = [];
    for (const n of room.world.nodesById.values()) {
      const last = p.lastNodeAmounts.get(n.id);
      if (last === n.amount) continue;
      changed.push({ id: n.id, amount: Math.round(n.amount * 10) / 10 });
      p.lastNodeAmounts.set(n.id, n.amount);
    }
    for (const [id, amt] of p.lastNodeAmounts) {
      if (amt > 0 && !room.world.nodesById.has(id)) {
        depleted.push(id);
        p.lastNodeAmounts.delete(id);
      }
    }
    // Fog deltas (RLE of the fog byte array) when the memory changed.
    const prevFog = p.lastFog;
    let fogPairs = null;
    if (prevFog) {
      let diff = false;
      for (let i = 0; i < fog.length; i++) if (fog[i] !== prevFog[i]) { diff = true; break; }
      if (diff) {
        fogPairs = rleEncode(fog);
        p.lastFog = new Uint8Array(fog);
      }
    } else {
      fogPairs = rleEncode(fog);
      p.lastFog = new Uint8Array(fog);
    }

    p.ws.send(JSON.stringify({
      t: S2C.SNAPSHOT,
      tick: sim.tick,
      stocks, yourWorkers, others, buildings,
      training: trainingQ ? { remaining: trainingQ.remaining, total: 150 } : null,
      nodesChanged: changed, nodesDepleted: depleted,
      fog: fogPairs,
    }));
  }

  handleCommand(room, player, m) {
    const sim = room.sim;
    if (!sim) return;
    switch (m.t) {
      case C2S.ASSIGN_WORKERS: sim.assignWorkers(player.pid, m.workerIds ?? [], m.nodeId ?? 0); break;
      case C2S.UNASSIGN: sim.unassignWorkers(player.pid, m.workerIds ?? []); break;
      case C2S.ORDER_MOVE: sim.orderMove(player.pid, m.workerIds ?? [], m.x, m.y); break;
      case C2S.AUTO_ASSIGN: sim.autoAssign(player.pid, m.type, Number(m.count) || 0); break;
      case C2S.BUILD: sim.tryPlaceBuilding(player.pid, m.type, m.x, m.y); break;
      case C2S.ASSIGN_TO_BUILDING: sim.assignToBuilding(player.pid, m.workerIds ?? [], m.buildingId ?? 0); break;
      case C2S.TRAIN_WORKER: sim.trainWorker(player.pid); break;
      default: break;
    }
  }

  broadcastRoomUpdate(room) {
    const players = [...room.players.values()].map(p => ({
      pid: p.pid, name: p.name, connected: p.connected, ready: p.ready, host: p.pid === room.hostPid,
      color: p.color,
    }));
    for (const p of room.players.values()) {
      if (p.ws && p.connected) {
        p.ws.send(JSON.stringify(msg(S2C.ROOM_UPDATE, { players, state: room.state, code: room.code })));
      }
    }
  }

  broadcastChat(room, from, text) {
    for (const p of room.players.values()) {
      if (p.ws && p.connected) {
        p.ws.send(JSON.stringify(msg(S2C.CHAT_MSG, { pid: from.pid, name: from.name, text: String(text).slice(0, 300) })));
      }
    }
  }
}
