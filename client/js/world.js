// Client-side mirror of the authoritative world. Holds terrain, nodes, units,
// fog, and interpolates remote unit movement between snapshots.

import { MAP_W, MAP_H, T, BUILDING, BUILDING_DEF } from '../../shared/constants.js';

export class World {
  constructor() {
    this.ready = false;
    this.myPid = null;
    this.players = new Map(); // pid -> {id,name,color}
    this.terrain = null;      // Uint8Array W*H
    this.nodes = new Map();   // id -> {id,type,x,y,amount,max}
    this.myWorkers = new Map(); // id -> full state from snapshots
    this.remoteUnits = new Map(); // id -> {owner, x,y, prevX,prevY, tPrev,tNow}
    this.fog = new Uint8Array(MAP_W * MAP_H); // 0 hidden 1 explored 2 visible
    this.selection = new Set();
    this.fingerprint = 0;
    this.spawn = null;
    this.nodeHistory = []; // stock samples for per-minute rates
    this.ages = new Map();     // pid -> 1..4
    this.myAge = 1;
    this.roleQueue = [];       // [{role, remaining, total}]
    this.stockHistory = []; // [{t, stocks}]
    this.buildings = new Map(); // id -> {id,owner,type,x,y,size,done,now}
    this.buildMode = null;      // building type string during placement
    this.mouseWorld = null;     // ghost position in world px
  }

  applyBuildings(list) {
    this.buildings.clear();
    for (const b of list) this.buildings.set(b.id, b);
  }

  buildingAt(tx, ty) {
    for (const b of this.buildings.values()) {
      if (tx >= b.x && tx < b.x + b.size && ty >= b.y && ty < b.y + b.size) return b;
    }
    return null;
  }

  canPlace(type, tx, ty) {
    const def = BUILDING_DEF[type];
    if (!def || !this.terrain) return false;
    if (tx < 0 || ty < 0 || tx + def.size > MAP_W || ty + def.size > MAP_H) return false;
    for (let dy = 0; dy < def.size; dy++) {
      for (let dx = 0; dx < def.size; dx++) {
        const x = tx + dx, y = ty + dy;
        const t = this.terrain[y * MAP_W + x];
        if (!(t === T.GRASS || t === T.HILL || t === T.SAND)) return false;
        for (const n of this.nodes.values()) if (n.x === x && n.y === y) return false;
        if (this.buildingAt(x, y)) return false;
      }
    }
    return true;
  }

  myPop() {
    let cap = 0;
    for (const b of this.buildings.values()) {
      if (b.owner !== this.myPid || b.done > b.now) continue;
      cap += BUILDING_DEF[b.type]?.popCap ?? 0;
    }
    return { units: this.myWorkers.size, cap: Math.max(cap, BUILDING_DEF[BUILDING.CASTLE]?.popCap ?? 10) };
  }

  myStorage() {
    let cap = 0;
    for (const b of this.buildings.values()) {
      if (b.owner !== this.myPid || b.done > b.now) continue;
      cap += BUILDING_DEF[b.type]?.storage ?? 0;
    }
    return Math.max(cap, BUILDING_DEF[BUILDING.CASTLE]?.storage ?? 500);
  }

  loadGameInit(p) {
    this.ready = true;
    this.myPid = p.playerId;
    this.fingerprint = p.fingerprint;
    this.terrain = rleDecode(p.terrain, MAP_W * MAP_H);
    this.nodes.clear(); this.myWorkers.clear(); this.remoteUnits.clear();
    for (const n of p.nodes) this.nodes.set(n.id, { ...n });
    this.players.clear();
    this.ages.clear(); this.myAge = 1; this.roleQueue = [];
    for (const pl of p.players) this.players.set(pl.id, pl);
    const spawn = p.spawns.find(s => s.pid === p.playerId);
    this.spawn = spawn ? { x: spawn.x, y: spawn.y } : null;
    this.spawns = p.spawns;
    this.nodeTypes = p.nodes.reduce((m, n) => (m[n.id] = n.type, m), {});
  }

  applySnapshot(s) {
    // Own workers: server state is truth, smoothly override target.
    for (const w of s.yourWorkers) {
      const cur = this.myWorkers.get(w.id);
      if (!cur) this.myWorkers.set(w.id, { ...w, lx: w.x, ly: w.y });
      else {
        cur.lx = cur.x; cur.ly = cur.y; // lerp start
        Object.assign(cur, w);
        cur.lerpT = 0;
      }
    }
    const seen = new Set(s.yourWorkers.map(w => w.id));
    for (const id of [...this.myWorkers.keys()]) if (!seen.has(id)) this.myWorkers.delete(id);

    for (const u of s.others) {
      const cur = this.remoteUnits.get(u.id) ?? { x: u.x, y: u.y };
      cur.prevX = cur.x; cur.prevY = cur.y;
      cur.x = u.x; cur.y = u.y;
      cur.owner = u.owner;
      cur.type = u.type;
      cur.hp = u.hp; cur.maxHp = u.maxHp;
      cur.tPrev = cur.tNow ?? performance.now();
      cur.tNow = performance.now();
      this.remoteUnits.set(u.id, cur);
    }

    for (const d of s.nodesChanged) {
      const n = this.nodes.get(d.id);
      if (n) n.amount = d.amount;
    }
    for (const id of s.nodesDepleted) this.nodes.delete(id);

    if (s.buildings) this.applyBuildings(s.buildings);
    this.training = s.training ?? null;
    this.roleQueue = s.roleQueue ?? [];
    for (const id of s.unitsGone ?? []) {
      this.myWorkers.delete(id);
      this.remoteUnits.delete(id);
    }
    if (s.ages) this.ages = new Map(Object.entries(s.ages).map(([k, v]) => [Number(k), v]));
    this.myAge = s.yourAge ?? this.ages.get(this.myPid) ?? 1;

    if (s.fog) rleInto(this.fog, s.fog);

    this.stockHistory.push({ t: Date.now(), stocks: s.stocks });
    if (this.stockHistory.length > 400) this.stockHistory.shift();
  }

  // positions after client-side interpolation
  workerPos(w, tsec) { return { x: w.x, y: w.y }; }
  remotePos(u, now) {
    if (!u.tNow || u.tNow === u.tPrev) return { x: u.x, y: u.y };
    const a = Math.min(1, (now - u.tNow) / (u.tNow - u.tPrev + 1));
    // extrapolate along last motion for smoothness
    const vx = u.x - u.prevX, vy = u.y - u.prevY;
    return { x: u.x + vx * (a - 1), y: u.y + vy * (a - 1) };
  }

  stockFor(pid) {
    for (let i = this.stockHistory.length - 1; i >= 0; i--) {
      const s = this.stockHistory[i].stocks[pid];
      if (s) return s;
    }
    return null;
  }

  myStock() { return this.stockFor(this.myPid) ?? { wood: 0, stone: 0, gold: 0, food: 0, bricks: 0 }; }
}

export function rleDecode(pairs, length) {
  const out = new Uint8Array(length);
  let p = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    out.fill(pairs[i], p, Math.min(length, p + pairs[i + 1]));
    p += pairs[i + 1];
  }
  return out;
}

export function rleInto(target, pairs) {
  let p = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    target.fill(pairs[i], p, Math.min(target.length, p + pairs[i + 1]));
    p += pairs[i + 1];
  }
}
