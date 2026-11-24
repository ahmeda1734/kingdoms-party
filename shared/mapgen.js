// Map generation. Fully deterministic from (seed, playerCount) so every client
// builds the identical world from the init packet instead of regenerating.

import { MAP_W, MAP_H, T, NODE, NODE_DEF } from './constants.js';
import { mulberry32, hashString } from './rng.js';
import { fbm } from './noise.js';

const DIRS8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

function inBounds(x, y) { return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H; }

export function walkable(terrain, x, y) {
  if (!inBounds(x, y)) return false;
  const t = terrain[y * MAP_W + x];
  return t === T.GRASS || t === T.HILL || t === T.SAND;
}

// Two rings of spawn points around the map center keep distances equal between
// all players (FFA) or easy teaming (rings are even/odd indices opposite sides).
function spawnPoints(count) {
  const cx = MAP_W / 2, cy = MAP_H / 2;
  const pts = [];
  if (count <= 4) {
    const r = 34;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      pts.push([Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r)]);
    }
  } else {
    const r1 = 26, r2 = 40;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2 + (i % 2 === 0 ? 0 : Math.PI / count);
      const r = i % 2 === 0 ? r1 : r2;
      pts.push([Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r)]);
    }
  }
  return pts;
}

function nearestWalkable(terrain, x, y, maxR = 12) {
  if (walkable(terrain, x, y)) return [x, y];
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (walkable(terrain, nx, ny)) return [nx, ny];
      }
    }
  }
  return null;
}

export function generate(seed, playerCount) {
  const rng = mulberry32(hashString('map:' + seed + ':' + playerCount));
  const W = MAP_W, H = MAP_H;
  const terrain = new Uint8Array(W * H);
  const elevation = fbm(W, H, 4, rng);
  const moisture = fbm(W, H, 3, rng);

  // Base terrain.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Soft island falloff keeps lakes/edges away from borders.
      const dx = (x / W - 0.5), dy = (y / H - 0.5);
      const edge = 1 - Math.min(1, Math.max(0, (Math.max(Math.abs(dx), Math.abs(dy)) - 0.34) / 0.16));
      let e = elevation[y * W + x] * 0.75 + edge * 0.25 + (1 - Math.hypot(dx, dy)) * 0.12;
      const idx = y * W + x;
      if (e < 0.36) terrain[idx] = T.WATER;
      else if (e < 0.395) terrain[idx] = T.SAND;
      else if (e > 0.80) terrain[idx] = T.MOUNTAIN;
      else if (e > 0.70) terrain[idx] = T.HILL;
      else terrain[idx] = T.GRASS;
    }
  }

  // Rivers: random walks from mountain tiles to water.
  const rivers = 3 + Math.floor(rng() * 3);
  for (let r = 0; r < rivers; r++) {
    let x = Math.floor(rng() * W), y = Math.floor(rng() * H);
    let found = false;
    for (let tries = 0; tries < 200 && !found; tries++) {
      if (terrain[y * W + x] === T.MOUNTAIN) { found = true; break; }
      x = (x + 1) % W; if (tries % 20 === 19) y = (y + 1) % H;
    }
    if (!found) continue;
    let steps = 400;
    while (steps-- > 0) {
      terrain[y * W + x] = T.WATER;
      if (inBounds(x - 1, y) && terrain[y * W + x - 1] !== T.WATER) terrain[y * W + x - 1] = T.SAND;
      if (inBounds(x + 1, y) && terrain[y * W + x + 1] !== T.WATER) terrain[y * W + x + 1] = T.SAND;
      if (inBounds(x, y - 1) && terrain[(y - 1) * W + x] !== T.WATER) terrain[(y - 1) * W + x] = T.SAND;
      if (inBounds(x, y + 1) && terrain[(y + 1) * W + x] !== T.WATER) terrain[(y + 1) * W + x] = T.SAND;
      let best = null, bestE = 2;
      for (const [dx, dy] of DIRS8) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const e = elevation[ny * W + nx] + rng() * 0.25;
        if (terrain[ny * W + nx] === T.WATER) { best = null; steps = 0; break; }
        if (e < bestE) { bestE = e; best = [nx, ny]; }
      }
      if (steps === 0) break;
      if (best) { x = best[0]; y = best[1]; } else break;
    }
  }

  const tilesToNode = new Map(); // "x,y" -> node id
  const nodes = [];
  let nodeId = 1;
  const occupancy = (x, y) => {
    const t = terrain[y * W + x];
    if (t !== T.GRASS && t !== T.HILL && t !== T.SAND) return false;
    return !tilesToNode.has(x + ',' + y);
  };

  function cluster(type, cx, cy, count, radius) {
    const spots = [[cx, cy]];
    let guard = count * 30;
    while (spots.length < count && guard-- > 0) {
      const [bx, by] = spots[Math.floor(rng() * spots.length)];
      const nx = bx + Math.floor(rng() * 5) - 2, ny = by + Math.floor(rng() * 5) - 2;
      if (!inBounds(nx, ny) || !occupancy(nx, ny)) continue;
      if (Math.hypot(nx - cx, ny - cy) > radius) continue;
      spots.push([nx, ny]);
    }
    for (const [sx, sy] of spots) {
      const def = NODE_DEF[type];
      nodes.push({ id: nodeId++, type, x: sx, y: sy, amount: def.amount, max: def.amount });
      tilesToNode.set(sx + ',' + sy, nodeId - 1);
    }
  }

  // Spawn exclusivity: no neutral clusters inside the guaranteed starting zone.
  const nearSpawn = (x, y) =>
    spawnPoints(playerCount).some(([sx, sy]) => Math.hypot(x - sx, y - sy) < 9);

  // Neutral forests / rocks / mines scattered all over the map.
  const scatterCount = 16;
  for (let i = 0; i < scatterCount; i++) {
    const x = 3 + Math.floor(rng() * (W - 6));
    const y = 3 + Math.floor(rng() * (H - 6));
    if (!occupancy(x, y) || nearSpawn(x, y)) continue;
    const roll = rng();
    if (roll < 0.55) cluster(NODE.TREE, x, y, 4 + Math.floor(rng() * 6), 4);
    else if (roll < 0.8) cluster(NODE.STONE, x, y, 2 + Math.floor(rng() * 3), 3);
    else if (roll < 0.92) cluster(NODE.GOLD, x, y, 2 + Math.floor(rng() * 2), 2);
    else cluster(NODE.BERRY, x, y, 3, 2);
  }

  // Extra berry patches, restricted to non-spawn zones.
  for (let i = 0; i < 6; i++) {
    const x = 3 + Math.floor(rng() * (W - 6)), y = 3 + Math.floor(rng() * (H - 6));
    if (occupancy(x, y) && !nearSpawn(x, y)) cluster(NODE.BERRY, x, y, 3, 2);
  }

  // Player spawns: clear the base area, then give every player a guaranteed,
  // symmetric starting economy very close to their base.
  const spawns = spawnPoints(playerCount).map(([x, y]) => nearestWalkable(terrain, x, y) || [x, y]);
  for (const [sx, sy] of spawns) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const nx = sx + dx, ny = sy + dy;
        if (!inBounds(nx, ny)) continue;
        const t = terrain[ny * W + nx];
        if (t === T.WATER || t === T.MOUNTAIN) terrain[ny * W + nx] = T.GRASS;
        if (Math.hypot(nx - sx, ny - sy) < 5) tilesToNode.delete(nx + ',' + ny);
      }
    }
  }
  // Remove cleared nodes from the list.
  const removed = new Set();
  for (const [sx, sy] of spawns) {
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
      removed.add((sx + dx) + ',' + (sy + dy));
    }
  }
  const keep = nodes.filter(n => !removed.has(n.x + ',' + n.y) || n.id === -1);
  nodes.length = 0;
  nodes.push(...keep);

  for (const [sx, sy] of spawns) {
    cluster(NODE.TREE, sx + 5, sy - 2, 7, 3);
    cluster(NODE.TREE, sx - 6, sy + 1, 5, 3);
    cluster(NODE.STONE, sx + 2, sy + 6, 3, 2);
    cluster(NODE.GOLD, sx - 6, sy - 5, 3, 2);
    cluster(NODE.BERRY, sx - 1, sy + 7, 3, 2);
  }

  // Connectivity check: every spawn must reach every other spawn on foot.
  let spawnWalkable = spawns.map(([x, y]) => nearestWalkable(terrain, x, y) || [x, y]);
  if (!allSpawnsConnected(terrain, spawnWalkable)) {
    return generate(seed + '#r', playerCount); // deterministic retry
  }

  return {
    seed, playerCount,
    width: W, height: H,
    terrain,
    nodes,
    nodesById: new Map(nodes.map(n => [n.id, n])),
    spawns: spawnWalkable,
  };
}

function allSpawnsConnected(terrain, spawns) {
  const total = MAP_W * MAP_H;
  const seen = new Uint8Array(total);
  const q = [spawns[0][1] * MAP_W + spawns[0][0]];
  seen[q[0]] = 1;
  while (q.length) {
    const idx = q.pop();
    const x = idx % MAP_W, y = (idx / MAP_W) | 0;
    for (const [dx, dy] of DIRS8) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const nIdx = ny * MAP_W + nx;
      if (seen[nIdx] || !walkable(terrain, nx, ny)) continue;
      seen[nIdx] = 1;
      q.push(nIdx);
    }
  }
  return spawns.every(([x, y]) => seen[y * MAP_W + x]);
}

export function mapFingerprint(world) {
  // 32-bit checksum over terrain+nodes, used by tests and by clients to verify
  // they loaded the exact same world.
  let h = 2166136261 >>> 0;
  const step = Math.max(1, Math.floor(world.terrain.length / 512));
  for (let i = 0; i < world.terrain.length; i += step) {
    h = (Math.imul(h ^ world.terrain[i], 16777619)) >>> 0;
  }
  for (const n of world.nodes) {
    h = (Math.imul(h ^ n.id, 16777619)) >>> 0;
    h = (Math.imul(h ^ n.x, 40503)) >>> 0;
    h = (Math.imul(h ^ n.y, 911)) >>> 0;
    h = (Math.imul(h ^ Math.max(0, Math.round(n.amount * 10)), 7907)) >>> 0;
  }
  return h >>> 0;
}

export function rleEncode(arr) {
  const out = [];
  let run = 1;
  for (let i = 1; i <= arr.length; i++) {
    if (i < arr.length && arr[i] === arr[i - 1]) { run++; continue; }
    out.push(arr[i - 1], run);
    run = 1;
  }
  return out;
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
