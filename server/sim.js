// Authoritative simulation. The ONLY module allowed to mutate game state.
// Clients send commands; this sim validates and applies them on ticks, then
// the room broadcasts snapshots. Result: all players converge on the same world.

import { TICK_MS, T, NODE, NODE_DEF, WORKER, BUILDING, BUILDING_DEF, TRAIN_WORKER, START_RESOURCES, START_WORKERS, MAP_W, MAP_H, TILE, UNIT, ROLE_DEF, AGES, MAX_AGE, AGE_STEP, AGE_MULT_MAX, COMBAT } from '../shared/constants.js';
import { walkable } from '../shared/mapgen.js';

const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

export class Sim {
  constructor(world, players) {
    this.world = world;
    this.players = players; // Map pid -> { id, name, color, spawn:[x,y] }
    this.tick = 0;
    this.stocks = new Map();
    for (const pid of players.keys()) {
      this.stocks.set(pid, { ...START_RESOURCES });
    }
    this.units = new Map();
    this.nextUnitId = 1;
    this.nodeVersions = new Map(); // nodeId -> last change tick (for deltas)
    // Buildings: Map id -> { id, owner, type, x, y (tile top-left), size,
    //                         done: tick when construction finishes or 0 }
    this.buildings = new Map();
    this.nextBuildingId = 1;
    this.trainingQueues = new Map(); // pid -> { remaining: ticks } (workers)
    this.unitQueues = new Map();     // pid -> [{ role, remaining, total }]
    this.age = new Map();            // pid -> 1..4
    for (const pid of players.keys()) this.age.set(pid, 1);
    this.over = null;                // { winner, reason } once a castle falls
    this.recentDeaths = [];          // [{ id, tick }] for snapshot deltas
    this.destroyedBuildings = [];    // [{ id, tick }]
    this._blockCache = null;
    // Per-player fog memory: 0 hidden, 1 explored-no-vision, 2 visible.
    this.fog = new Map();
    for (const [pid, p] of players) {
      this.fog.set(pid, new Uint8Array(MAP_W * MAP_H));
      this.placeBuilding(pid, BUILDING.CASTLE, p.spawn[0] - 1, p.spawn[1] - 1, true);
      for (let i = 0; i < START_WORKERS; i++) this.spawnWorker(pid);
      this.stampVision(pid, p.spawn[0], p.spawn[1], 9);
    }
  }

  // ---------- ages & roles (Phase 3) ----------

  // +15% hp/dmg per age for MILITARY units, hard-capped by the GDD balance
  // ceiling: late ages unlock options, they never unlock giants.
  statMult(pid) {
    return Math.min(1 + AGE_STEP * (this.age.get(pid) - 1), AGE_MULT_MAX);
  }

  ageUp(pid) {
    if (!this.players.has(pid) || this.over) return false;
    const cur = this.age.get(pid);
    if (cur >= MAX_AGE) return false;
    const next = AGES[cur + 1];
    if (!next || !next.cost) return false;
    if (next.cost.building) {
      const req = next.cost.building;
      const has = [...this.buildings.values()].some(b => b.owner === pid && b.type === req && this.completed(b));
      if (!has) return false;
    }
    // resources only: the building requirement is a gate, never a stock check
    const cost = Object.fromEntries(Object.entries(next.cost).filter(([k]) => k !== 'building'));
    if (!this.canAfford(pid, cost)) return false;
    this.pay(pid, cost);
    this.age.set(pid, cur + 1);
    // Reaching a new age never resolves the match (GDD §5).
    return true;
  }

  trainUnit(pid, role) {
    const def = ROLE_DEF[role];
    if (!def || role === UNIT.WORKER || this.over) return false;
    const { cap, units } = this.popCap(pid);
    if (units >= cap) return false;
    if (def.from === 'barracks') {
      const hasBarracks = [...this.buildings.values()].some(b => b.owner === pid && b.type === BUILDING.BARRACKS && this.completed(b));
      if (!hasBarracks) return false;
    }
    if (!this.canAfford(pid, def.cost)) return false;
    this.pay(pid, def.cost);
    const q = this.unitQueues.get(pid) ?? [];
    q.push({ role, remaining: def.time, total: def.time });
    this.unitQueues.set(pid, q);
    return true;
  }

  // ---------- buildings ----------

  popCap(pid) {
    let cap = 0;
    for (const b of this.buildings.values()) {
      if (b.owner !== pid || !this.completed(b)) continue;
      cap += BUILDING_DEF[b.type].popCap;
    }
    let units = 0;
    for (const u of this.units.values()) if (u.owner === pid) units++;
    return { cap, units };
  }

  storageCap(pid) {
    let cap = 0;
    for (const b of this.buildings.values()) {
      if (b.owner !== pid || !this.completed(b)) continue;
      cap += BUILDING_DEF[b.type].storage;
    }
    return Math.max(cap, BUILDING_DEF[BUILDING.CASTLE].storage);
  }

  completed(b) { return b.done <= this.tick; }

  canAfford(pid, cost) {
    const s = this.stocks.get(pid);
    if (!s) return false;
    return Object.entries(cost).every(([res, v]) => (s[res] ?? 0) >= v);
  }

  pay(pid, cost) {
    const s = this.stocks.get(pid);
    for (const [res, v] of Object.entries(cost)) s[res] -= v;
  }

  placeBuilding(pid, type, tx, ty, preplaced = false) {
    const def = BUILDING_DEF[type];
    if (!def) return null;
    // Validation: all footprint tiles in bounds, walkable terrain, and free of
    // map nodes and other buildings. (Auras are excluded by definition.)
    const size = def.size;
    if (tx < 0 || ty < 0 || tx + size > MAP_W || ty + size > MAP_H) return null;
    const block = this.blockedGrid();
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const x = tx + dx, y = ty + dy;
        if (!walkable(this.world.terrain, x, y)) return null;
        if (block[y * MAP_W + x]) return null;
      }
    }
    if (!preplaced && !this.canAfford(pid, def.cost)) return null;
    if (!preplaced) this.pay(pid, def.cost);
    const b = {
      id: this.nextBuildingId++, owner: pid, type,
      x: tx, y: ty, size,
      done: preplaced ? this.tick : this.tick + def.buildTime,
      hp: def.hp, maxHp: def.hp,
      lastAttacker: null,
    };
    this.buildings.set(b.id, b);
    this._blockCache = null;
    return b;
  }

  // Cells occupied by map nodes or buildings (for pathfinding + placement).
  blockedGrid() {
    if (this._blockCache) return this._blockCache;
    const b = new Uint8Array(MAP_W * MAP_H);
    for (const n of this.world.nodesById.values()) b[n.y * MAP_W + n.x] = 1;
    for (const bd of this.buildings.values()) {
      for (let dy = 0; dy < bd.size; dy++) {
        for (let dx = 0; dx < bd.size; dx++) {
          b[(bd.y + dy) * MAP_W + bd.x + dx] = 1;
        }
      }
    }
    this._blockCache = b;
    return b;
  }

  tryPlaceBuilding(pid, type, tx, ty) {
    return this.placeBuilding(pid, String(type ?? '').slice(0, 40), Number(tx) | 0, Number(ty) | 0) != null;
  }

  trainWorker(pid) {
    if (this.trainingQueues.has(pid)) return false;
    const { cap, units } = this.popCap(pid);
    if (units >= cap) return false;
    if (!this.canAfford(pid, TRAIN_WORKER.cost)) return false;
    this.pay(pid, TRAIN_WORKER.cost);
    this.trainingQueues.set(pid, { remaining: TRAIN_WORKER.time });
    return true;
  }

  nearestDepot(u) {
    let best = null, bestD = Infinity;
    for (const b of this.buildings.values()) {
      if (b.owner !== u.owner || !BUILDING_DEF[b.type].depot || !this.completed(b)) continue;
      const bx = b.x * TILE + b.size * TILE / 2, by = b.y * TILE + b.size * TILE / 2;
      const d = (bx - u.x) ** 2 + (by - u.y) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  spawnWorker(pid) {
    return this.spawnUnit(pid, UNIT.WORKER);
  }

  // Phase 3: every unit (worker or role) spawns at its kingdom's castle.
  // Military stats get the age multiplier of the owning player at spawn time.
  spawnUnit(pid, type) {
    const p = this.players.get(pid);
    const def = type === UNIT.WORKER ? null : ROLE_DEF[type];
    if (!type || (type !== UNIT.WORKER && !def)) return null;
    const id = this.nextUnitId++;
    const jitter = () => (Math.random() - 0.5) * 40;
    const mult = this.statMult(pid);
    const unit = {
      id, owner: pid, type,
      x: p.spawn[0] * 32 + 16 + jitter(),
      y: (p.spawn[1] + 3) * 32 + 16 + jitter(), // below the castle footprint
      state: 'idle',   // idle | toNode | gather | toBuilding | workFactory | toDepot | fight | flee | heal | engineer
      path: [], nodeId: null, buildingId: null, carry: 0, carryType: null,
      gatherProgress: 0,
    };
    const baseHp = type === UNIT.WORKER ? WORKER.hp : def.hp;
    unit.maxHp = Math.round(baseHp * (type === UNIT.WORKER ? 1 : mult));
    unit.hp = unit.maxHp;
    unit.cd = 0;
    unit.target = null; // { kind: 'unit'|'building', id } — military only
    // Nudge spawn position onto walkable, unblocked ground.
    const block = this.blockedGrid();
    let sx = Math.floor(unit.x / 32), sy = Math.floor(unit.y / 32);
    let tries = 20;
    while (tries-- > 0 && (!walkable(this.world.terrain, sx, sy) || block[sy * MAP_W + sx])) {
      sy += 1; sx = Math.max(1, Math.min(MAP_W - 2, sx + (tries % 2 ? 1 : -1)));
      if (!walkable(this.world.terrain, sx, sy)) continue;
      if (!block[sy * MAP_W + sx]) break;
    }
    unit.x = sx * 32 + 16; unit.y = sy * 32 + 16;
    this.units.set(id, unit);
    return unit;
  }

  // ---------- pathfinding ----------

  findPath(sx, sy, tx, ty) {
    if (sx === tx && sy === ty) return [];
    const grid = this.world.terrain;
    const blocked = this.blockedGrid();
    if (blocked[ty * MAP_W + tx]) return null;
    const start = sy * MAP_W + sx, goal = ty * MAP_W + tx;
    if (start === goal) return [];
    const open = [start];
    const gScore = new Map([[start, 0]]);
    const came = new Map();
    const fScore = new Map([[start, 0]]);
    let guard = 20000;
    while (open.length && guard-- > 0) {
      let bestI = 0, bestF = Infinity;
      for (let i = 0; i < open.length; i++) {
        const f = fScore.get(open[i]);
        if (f < bestF) { bestF = f; bestI = i; }
      }
      const cur = open.splice(bestI, 1)[0];
      if (cur === goal) {
        const path = [];
        let n = cur;
        while (n !== undefined && n !== start) {
          path.push([(n % MAP_W) * 32 + 16, Math.floor(n / MAP_W) * 32 + 16]);
          n = came.get(n);
        }
        return path.reverse();
      }
      const cx = cur % MAP_W, cy = (cur / MAP_W) | 0;
      const g = gScore.get(cur);
      for (const [dx, dy] of DIRS8) {
        const nx = cx + dx, ny = cy + dy;
        if (!walkable(grid, nx, ny)) continue;
        const nIdx = ny * MAP_W + nx;
        if (blocked[nIdx]) continue;
        const cost = g + (dx && dy ? 1.414 : 1);
        if (cost < (gScore.get(nIdx) ?? Infinity)) {
          gScore.set(nIdx, cost);
          fScore.set(nIdx, cost + Math.hypot(nx - tx, ny - ty));
          came.set(nIdx, cur);
          if (!open.includes(nIdx)) open.push(nIdx);
        }
      }
    }
    return null;
  }

  blockedOverlay(world) {
    return this.blockedGrid();
  }

  // walk target = closest walkable, non-blocked tile adjacent to a node
  dropPointFor(node, fromX, fromY) {
    const block = this.blockedGrid();
    let best = null, bestD = Infinity;
    for (const [dx, dy] of DIRS8) {
      const nx = node.x + dx, ny = node.y + dy;
      if (!walkable(this.world.terrain, nx, ny) || block[ny * MAP_W + nx]) continue;
      const d = Math.hypot(nx * 32 - fromX, ny * 32 - fromY);
      if (d < bestD) { bestD = d; best = [nx, ny]; }
    }
    return best;
  }

  // closest walkable tile adjacent to any tile of a building footprint
  dropPointForBuilding(b, fromX, fromY) {
    const block = this.blockedGrid();
    let best = null, bestD = Infinity;
    for (let dy = -1; dy <= b.size; dy++) {
      for (let dx = -1; dx <= b.size; dx++) {
        const nx = b.x + dx, ny = b.y + dy;
        const inside = dx >= 0 && dx < b.size && dy >= 0 && dy < b.size;
        if (inside || !walkable(this.world.terrain, nx, ny) || block[ny * MAP_W + nx]) continue;
        const d = Math.hypot(nx * 32 - fromX, ny * 32 - fromY);
        if (d < bestD) { bestD = d; best = [nx, ny]; }
      }
    }
    return best;
  }

  // ---------- command handlers (validated; anything invalid is ignored) ----------

  assignWorkers(pid, workerIds, nodeId) {
    const node = this.world.nodesById.get(nodeId);
    if (!node || node.amount <= 0) return;
    const ids = new Set(workerIds);
    for (const u of this.units.values()) {
      if (!ids.has(u.id) || u.owner !== pid) continue;
      if (u.type !== UNIT.WORKER) continue; // only workers gather
      const drop = this.dropPointFor(node, u.x, u.y);
      if (!drop) continue;
      const path = this.findPath(Math.floor(u.x / 32), Math.floor(u.y / 32), drop[0], drop[1]);
      if (path === null) continue;
      u.state = 'toNode'; u.nodeId = nodeId; u.buildingId = null; u.path = path; u.lastNodeType = node.type;
    }
  }

  // Assign workers to a WORKING building (Phase 2: the brick factory).
  assignToBuilding(pid, workerIds, buildingId) {
    const b = this.buildings.get(buildingId);
    if (!b || b.owner !== pid || !this.completed(b)) return;
    const def = BUILDING_DEF[b.type];
    if (!def.bricksPerTick) return;
    const ids = new Set(workerIds);
    for (const u of this.units.values()) {
      if (!ids.has(u.id) || u.owner !== pid) continue;
      if (u.type !== UNIT.WORKER) continue; // only workers man factories
      const drop = this.dropPointForBuilding(b, u.x, u.y);
      if (!drop) continue;
      const path = this.findPath(Math.floor(u.x / 32), Math.floor(u.y / 32), drop[0], drop[1]);
      if (path === null || path.length === 0 && Math.hypot(b.x * 32 - u.x, b.y * 32 - u.y) > 3 * TILE) continue;
      u.state = 'toBuilding'; u.nodeId = null; u.buildingId = buildingId;
      u.path = path; u.lastNodeType = null; u.lastBuildingId = buildingId;
    }
  }

  unassignWorkers(pid, workerIds) {
    const ids = new Set(workerIds);
    for (const u of this.units.values()) {
      if (ids.has(u.id) && u.owner === pid) {
        u.state = 'idle'; u.nodeId = null; u.buildingId = null; u.path = []; u.lastNodeType = null;
      }
    }
  }

  orderMove(pid, workerIds, wx, wy) {
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return;
    const tx = Math.floor(wx / 32), ty = Math.floor(wy / 32);
    if (!walkable(this.world.terrain, tx, ty)) return;
    const ids = new Set(workerIds);
    for (const u of this.units.values()) {
      if (!ids.has(u.id) || u.owner !== pid) continue;
      const path = this.findPath(Math.floor(u.x / 32), Math.floor(u.y / 32), tx, ty);
      if (path === null) continue;
      u.state = 'idle'; u.nodeId = null; u.buildingId = null; u.path = path; u.lastNodeType = null;
    }
  }

  autoAssign(pid, type, count) {
    const node = NODE_DEF[type] ? type : null;
    if (!node) return;
    const idle = [...this.units.values()].filter(u => u.owner === pid && u.state === 'idle');
    const targets = [...this.world.nodesById.values()].filter(n => n.type === type && n.amount > 0);
    for (const u of idle.slice(0, Math.max(0, count))) {
      let best = null, bestD = Infinity;
      for (const n of targets) {
        if (n.amount <= 0) continue;
        const d = Math.hypot(n.x * 32 - u.x, n.y * 32 - u.y);
        if (d < bestD) { bestD = d; best = n; }
      }
      if (best) this.assignWorkers(pid, [u.id], best.id);
    }
  }

  // ---------- vision ----------

  stampVision(pid, tx, ty, radius) {
    const f = this.fog.get(pid);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
        f[y * MAP_W + x] = 2;
      }
    }
  }

  decayVisible() {
    for (const f of this.fog.values()) {
      for (let i = 0; i < f.length; i++) if (f[i] === 2) f[i] = 1;
    }
  }

  updateVision() {
    this.decayVisible();
    for (const [pid, p] of this.players) {
      this.stampVision(pid, p.spawn[0], p.spawn[1], 9); // castle vision
      for (const b of this.buildings.values()) {
        if (b.owner === pid && BUILDING_DEF[b.type].vision && this.completed(b)) {
          this.stampVision(pid, b.x + 1, b.y + 1, BUILDING_DEF[b.type].vision); // watchtower
        }
      }
      for (const u of this.units.values()) {
        if (u.owner === pid) {
          const r = ROLE_DEF[u.type]?.vision ?? WORKER.visionRadius;
          this.stampVision(pid, Math.floor(u.x / 32), Math.floor(u.y / 32), r);
        }
      }
    }
  }

  // ---------- Phase 3: combat, healing, repairs, towers ----------

  // Two-phase resolution: every valid attack is collected first, then applied.
  // Simultaneous kills settle as true draws - no RNG, no map-order bias.
  combatTick(dt) {
    if (this.over) return;
    const attacks = [];
    for (const u of this.units.values()) {
      if (u.type === UNIT.WORKER) continue;
      const def = ROLE_DEF[u.type];
      if (!def) continue;
      if (u.cd > 0) u.cd--;
      const tx = Math.floor(u.x / TILE), ty = Math.floor(u.y / TILE);

      if (def.flee) {
        const threat = this.nearestEnemyUnit(u, COMBAT.fleeRadius,
          e => (ROLE_DEF[e.type]?.dmg ?? 0) > 0);
        if (threat) {
          u.state = 'flee';
          u.repathT = (u.repathT ?? 0) - 1;
          if (u.path.length === 0 || u.repathT <= 0) {
            u.repathT = COMBAT.chaseRepathEvery;
            const home = this.players.get(u.owner).spawn;
            const path = this.findPath(tx, ty, home[0], home[1]);
            u.path = path === null ? this.stepAway(u, threat) : path;
          }
          continue; // fleeing scouts never swing back
        }
      }

      if (def.dmg > 0) {
        let enemy = null;
        if (u.target) {
          enemy = u.target.kind === 'building'
            ? this.buildings.get(u.target.id) : this.units.get(u.target.id);
          if (enemy && enemy.owner === u.owner) enemy = null;
        }
        if (!enemy) {
          enemy = this.nearestTarget(u);
          u.target = enemy
            ? { kind: enemy.size !== undefined ? 'building' : 'unit', id: enemy.id }
            : null;
        }
        if (!enemy) {
          if (u.state === 'fight') u.state = 'idle';
          continue;
        }
        const isBuilding = enemy.size !== undefined;
        const d = isBuilding ? this.edgeDistTiles(enemy, u.x, u.y)
          : Math.hypot(enemy.x - u.x, enemy.y - u.y) / TILE;
        u.state = 'fight';
        if (d <= def.range + 0.35) {
          if (u.cd <= 0) {
            u.cd = def.attackEvery;
            let dmg = def.dmg * this.statMult(u.owner);
            if (!isBuilding) dmg *= def.bonusVs?.[enemy.type] ?? 1;
            attacks.push({ from: u, enemy,
              dmg: isBuilding ? dmg * COMBAT.buildingDmgMult : dmg });
          }
          if (def.kite && !isBuilding) {
            const foe = this.nearestEnemyUnit(u, COMBAT.kiteRadius);
            if (foe && u.path.length === 0) u.path = this.stepAway(u, foe);
          }
        } else {
          u.repathT = (u.repathT ?? 0) - 1;
          if (u.path.length === 0 || u.repathT <= 0) {
            u.repathT = COMBAT.chaseRepathEvery;
            if (isBuilding) {
              const drop = this.dropPointForBuilding(enemy, u.x, u.y);
              if (drop) {
                const path = this.findPath(tx, ty, drop[0], drop[1]);
                if (path !== null) u.path = path;
              }
            } else {
              const path = this.findPath(tx, ty,
                Math.floor(enemy.x / TILE), Math.floor(enemy.y / TILE));
              if (path !== null) u.path = path;
            }
          }
        }
      } else if (def.repairPerSec) {
        const b = this.nearestDamagedBuilding(u);
        if (!b) {
          if (u.state === 'engineer') u.state = 'idle';
          continue;
        }
        u.state = 'engineer';
        const d = this.edgeDistTiles(b, u.x, u.y);
        if (d <= def.buildRange) {
          u.path = [];
          if (this.completed(b)) {
            b.hp = Math.min(b.maxHp, b.hp + def.repairPerSec * dt);
          }
        } else {
          u.repathT = (u.repathT ?? 0) - 1;
          if (u.path.length === 0 || u.repathT <= 0) {
            u.repathT = COMBAT.chaseRepathEvery;
            const drop = this.dropPointForBuilding(b, u.x, u.y);
            if (drop) {
              const path = this.findPath(tx, ty, drop[0], drop[1]);
              if (path !== null) u.path = path;
            }
          }
        }
      } else if (def.healPerSec) {
        const ally = this.lowestHpAlly(u);
        if (!ally) {
          if (u.state === 'heal') u.state = 'idle';
          continue;
        }
        u.state = 'heal';
        const d = Math.hypot(ally.x - u.x, ally.y - u.y) / TILE;
        if (d <= def.healRadius) {
          u.path = [];
          ally.hp = Math.min(ally.maxHp, ally.hp + def.healPerSec * dt);
        } else {
          u.repathT = (u.repathT ?? 0) - 1;
          if (u.path.length === 0 || u.repathT <= 0) {
            u.repathT = COMBAT.chaseRepathEvery;
            const path = this.findPath(tx, ty,
              Math.floor(ally.x / TILE), Math.floor(ally.y / TILE));
            if (path !== null) u.path = path;
          }
        }
      }
    }

    // Watchtowers return fire at the nearest enemy in range.
    for (const b of this.buildings.values()) {
      const def = BUILDING_DEF[b.type];
      if (!def.dmg || !this.completed(b)) continue;
      if ((b.cd ?? 0) > 0) { b.cd--; continue; }
      const cx = (b.x + b.size / 2) * TILE, cy = (b.y + b.size / 2) * TILE;
      let best = null, bd = def.range * TILE;
      for (const e of this.units.values()) {
        if (e.owner === b.owner) continue;
        const d = Math.hypot(e.x - cx, e.y - cy);
        if (d <= bd) { bd = d; best = e; }
      }
      if (best) {
        b.cd = def.attackEvery;
        attacks.push({ from: b, enemy: best, dmg: def.dmg * this.statMult(b.owner) });
      }
    }

    for (const a of attacks) {
      const tgt = a.enemy;
      if (tgt.size !== undefined) {
        if (!this.buildings.has(tgt.id)) continue;
        tgt.hp -= a.dmg;
        tgt.lastAttacker = a.from.owner;
        if (tgt.hp <= 0) this.destroyBuilding(tgt);
      } else {
        if (!this.units.has(tgt.id)) continue;
        tgt.hp -= a.dmg;
        tgt.lastAttacker = a.from.owner;
        if (tgt.hp <= 0) this.killUnit(tgt);
      }
    }
  }

  // distance in tiles from a point to the closest edge of a building footprint
  edgeDistTiles(b, x, y) {
    const ux = x / TILE, uy = y / TILE;
    const dx = Math.max(b.x - ux, 0, ux - (b.x + b.size));
    const dy = Math.max(b.y - uy, 0, uy - (b.y + b.size));
    return Math.hypot(dx, dy);
  }

  nearestEnemyUnit(u, radiusTiles, filter) {
    let best = null, bd = radiusTiles * TILE;
    for (const e of this.units.values()) {
      if (e.owner === u.owner) continue;
      if (filter && !filter(e)) continue;
      const d = Math.hypot(e.x - u.x, e.y - u.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  // Auto-aggro: enemy units first, then enemy buildings (castles, towers...).
  nearestTarget(u) {
    const unit = this.nearestEnemyUnit(u, COMBAT.aggroRadius);
    if (unit) return unit;
    let best = null, bd = Infinity;
    for (const b of this.buildings.values()) {
      if (b.owner === u.owner) continue;
      const d = this.edgeDistTiles(b, u.x, u.y);
      if (d <= COMBAT.aggroRadius + 0.5 && d < bd) { bd = d; best = b; }
    }
    return best;
  }

  // Deterministic retreat: the DIRS8 step with the best dot product away from
  // the threat, onto walkable unblocked ground (no pathfinding needed).
  stepAway(u, foe) {
    let dx = u.x - foe.x, dy = u.y - foe.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const block = this.blockedGrid();
    let best = null, bestDot = -Infinity;
    for (const [cx, cy] of DIRS8) {
      const gx = Math.floor(u.x / TILE) + cx, gy = Math.floor(u.y / TILE) + cy;
      if (!walkable(this.world.terrain, gx, gy) || block[gy * MAP_W + gx]) continue;
      const dot = (cx * dx + cy * dy) / Math.hypot(cx, cy);
      if (dot > bestDot) { bestDot = dot; best = [gx, gy]; }
    }
    return best ? [best[0] * TILE + 16, best[1] * TILE + 16] : [];
  }

  nearestDamagedBuilding(u) {
    let best = null, bd = Infinity;
    for (const b of this.buildings.values()) {
      if (b.owner !== u.owner || b.hp >= b.maxHp) continue;
      const d = Math.hypot((b.x + b.size / 2) * TILE - u.x,
        (b.y + b.size / 2) * TILE - u.y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  lowestHpAlly(u) {
    let best = null, bestFrac = 1;
    for (const a of this.units.values()) {
      if (a.owner !== u.owner || a.id === u.id || a.hp >= a.maxHp) continue;
      const frac = a.hp / a.maxHp;
      if (frac < bestFrac) { bestFrac = frac; best = a; }
    }
    return best;
  }

  killUnit(u) {
    this.units.delete(u.id);
    this.recentDeaths.push({ id: u.id, tick: this.tick });
    if (this.recentDeaths.length > 500) this.recentDeaths.splice(0, 200);
  }

  destroyBuilding(b) {
    this.buildings.delete(b.id);
    this._blockCache = null;
    this.destroyedBuildings.push({ id: b.id, tick: this.tick });
    if (b.type === BUILDING.CASTLE) {
      const rivals = [...this.players.keys()].filter(p => p !== b.owner);
      // Only a destroyed castle ends the match - never a reached age (GDD 5).
      this.over = { winner: b.lastAttacker ?? rivals[0] ?? null, reason: 'castle_destroyed' };
    }
  }

  // Gather rate multiplier from a completed aura building near the node.
  gatherMult(node) {
    let mult = 1;
    for (const b of this.buildings.values()) {
      const def = BUILDING_DEF[b.type];
      if (!def.auraMult || !this.completed(b)) continue;
      if (def.auraNode !== node.type) continue;
      const cx = b.x + b.size / 2 - 0.5, cy = b.y + b.size / 2 - 0.5;
      if (Math.hypot(cx - node.x, cy - node.y) <= def.auraRadius) mult = Math.max(mult, def.auraMult);
    }
    return Math.min(mult, 1.5); // hard aura cap
  }

  // ---------- main tick ----------

  update() {
    this.tick++;
    const dt = TICK_MS / 1000;

    // Training queues (workers + Phase 3 roles).
    for (const [pid, q] of [...this.trainingQueues]) {
      q.remaining--;
      if (q.remaining <= 0) {
        this.trainingQueues.delete(pid);
        const { cap, units } = this.popCap(pid);
        if (units < cap) this.spawnWorker(pid);
        // if the cap was lost meanwhile, the food is already spent — lesson not bug
      }
    }
    for (const [pid, queue] of [...this.unitQueues]) {
      for (const item of queue) item.remaining--;
      const done = queue.filter(q => q.remaining <= 0);
      const rest = queue.filter(q => q.remaining > 0);
      for (const item of done) {
        const { cap, units } = this.popCap(pid);
        if (units < cap) this.spawnUnit(pid, item.role);
        else rest.push(item); // pop cap lost meanwhile: wait, don't waste the unit
      }
      if (rest.length) this.unitQueues.set(pid, rest);
      else this.unitQueues.delete(pid);
    }

    // Farms: passive food production, clamped by the storage cap.
    for (const b of this.buildings.values()) {
      const def = BUILDING_DEF[b.type];
      if (def.foodPerTick && this.completed(b)) {
        const s = this.stocks.get(b.owner);
        s.food = Math.min(this.storageCap(b.owner), s.food + def.foodPerTick);
      }
    }

    // Movement along waypoint path (speed by role).
    for (const u of this.units.values()) {
      if (u.path.length === 0) continue;
      let speed = (u.type === UNIT.WORKER ? WORKER.speed : ROLE_DEF[u.type].speed) * dt;
      while (speed > 0 && u.path.length > 0) {
        const [tx, ty] = u.path[0];
        const dist = Math.hypot(tx - u.x, ty - u.y);
        if (dist > speed) {
          u.x += ((tx - u.x) / dist) * speed;
          u.y += ((ty - u.y) / dist) * speed;
          speed = 0;
        } else {
          u.x = tx; u.y = ty;
          speed -= dist;
          u.path.shift();
        }
      }
    }

    // Phase 3: combat, healing, repairs, towers — after movement so retargeted
    // units act from where they stand; then worker economy as before.
    this.combatTick(dt);

    // Gather / build-work / deposit state machine.
    for (const u of this.units.values()) {
      if (u.state === 'toNode') {
        const node = this.world.nodesById.get(u.nodeId);
        if (!node || node.amount <= 0) { this.retarget(u); continue; }
        if (u.path.length === 0) {
          u.state = 'gather';
          if (!u.carryType) u.carryType = NODE_DEF[node.type].res;
        }
      } else if (u.state === 'gather') {
        const node = this.world.nodesById.get(u.nodeId);
        if (!node || node.amount <= 0) { this.retarget(u); continue; }
        const take = Math.min(
          WORKER.gatherPerTick * this.gatherMult(node),
          WORKER.carryCap - u.carry,
          node.amount
        );
        u.carry += take;
        u.carryType = NODE_DEF[node.type].res;
        node.amount -= take;
        u.lastNodeType = node.type;
        if (node.amount <= 0) this.removeNode(node.id);
        if (u.carry >= WORKER.carryCap - 0.0001) this.sendToDepot(u);
      } else if (u.state === 'toBuilding') {
        const b = this.buildings.get(u.buildingId);
        if (!b || !this.completed(b)) { u.state = 'idle'; u.buildingId = null; continue; }
        if (u.path.length === 0) u.state = 'workFactory';
      } else if (u.state === 'workFactory') {
        const b = this.buildings.get(u.buildingId);
        const def = BUILDING_DEF[b?.type];
        if (!b || !def?.bricksPerTick || !this.completed(b)) {
          u.state = 'idle'; u.buildingId = null; continue;
        }
        const stock = this.stocks.get(u.owner);
        const stoneAvailable = stock.stone / def.stonePerBrick;
        const make = Math.min(def.bricksPerTick, WORKER.carryCap - u.carry, stoneAvailable);
        if (make <= 0) {
          // No stone to transform: wait here (player sees the brick progress).
        } else {
          u.carry += make;
          u.carryType = 'bricks';
          stock.stone -= make * def.stonePerBrick;
        }
        if (u.carry >= WORKER.carryCap - 0.0001) this.sendToDepot(u);
      } else if (u.state === 'toDepot') {
        if (u.path.length === 0) this.deposit(u);
      }
    }

    this.updateVision();
  }

  sendToDepot(u) {
    u.state = 'toDepot';
    const fallback = (() => {
      const spawn = this.players.get(u.owner).spawn;
      return { x: spawn[0] - 1, y: spawn[1] - 1, size: 2, id: -1, owner: u.owner, type: BUILDING.CASTLE };
    })();
    const depot = this.nearestDepot(u) ?? fallback;
    const target = this.dropPointForBuilding(depot, u.x, u.y);
    u.depotId = depot.id;
    if (!target) { u.path = []; return; }
    const path = this.findPath(Math.floor(u.x / 32), Math.floor(u.y / 32), target[0], target[1]);
    u.path = path ?? [];
  }

  deposit(u) {
    if (u.carry > 0 && u.carryType) {
      const stock = this.stocks.get(u.owner);
      const space = Math.max(0, this.storageCap(u.owner) - stock[u.carryType]);
      stock[u.carryType] += Math.min(u.carry, space); // overflow above cap is lost
    }
    u.carry = 0; u.carryType = null;
    this.retarget(u);
  }

  removeNode(nodeId) {
    this.world.nodesById.delete(nodeId);
    this.depleted = this.depleted || [];
    this.depleted.push(nodeId);
    this._blockCache = null;
  }

  retarget(u) {
    // After a deposit: back to the factory job first, then the resource duty.
    if (u.lastBuildingId) {
      const b = this.buildings.get(u.lastBuildingId);
      if (b && b.owner === u.owner && this.completed(b)) {
        this.assignToBuilding(u.owner, [u.id], u.lastBuildingId);
        return;
      }
      u.lastBuildingId = null;
    }
    // Auto-return to the nearest remaining node of the same type, so the
    // economy keeps flowing without per-trip micromanagement.
    if (u.lastNodeType) {
      let best = null, bestD = Infinity;
      for (const n of this.world.nodesById.values()) {
        if (n.type !== u.lastNodeType || n.amount <= 0) continue;
        const d = Math.hypot(n.x * 32 - u.x, n.y * 32 - u.y);
        if (d < bestD) { bestD = d; best = n; }
      }
      if (best && bestD < 800) {
        this.assignWorkers(u.owner, [u.id], best.id);
        return;
      }
    }
    u.state = 'idle'; u.nodeId = null; u.path = [];
  }
}
