// Renderer. Terrain is baked once into chunk canvases; entities and fog are
// drawn per frame only within the visible area. Zero image assets: everything
// is drawn vector-cartoon style, so it scales cleanly on zoom.

import { MAP_W, MAP_H, TILE, T, NODE, BUILDING, BUILDING_DEF, UNIT, ROLE_DEF } from '../../shared/constants.js';

const CHUNK = 16; // tiles per chunk side
const CHUNK_PX = CHUNK * TILE;

const TERRAIN_COLORS = {
  [T.GRASS]: ['#79c34f', '#84cc56', '#70b848'],
  [T.HILL]: ['#63a53f', '#6cb046'],
  [T.SAND]: ['#e7d79f', '#efe2b0'],
  [T.WATER]: ['#3f97d6', '#4aa3dd', '#378ccb'],
  [T.MOUNTAIN]: ['#8f98a1', '#7d868f'],
};

export class Renderer {
  constructor(canvas, world, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = world;
    this.cam = camera;
    this.chunks = new Map(); // "cx,cy" -> canvas
    this.fogCanvas = this.makeFogCanvas();
    this.fogImg = this.fogCanvas.createImageData(MAP_W, MAP_H);
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    this.dpr = dpr;
  }

  makeFogCanvas() {
    const c = document.createElement('canvas');
    c.width = MAP_W; c.height = MAP_H;
    return c;
  }

  refreshFogImage() {
    const fog = this.world.fog;
    const d = this.fogImg.data;
    for (let i = 0; i < fog.length; i++) {
      const o = i * 4;
      const v = fog[i];
      d[o] = 8; d[o + 1] = 14; d[o + 2] = 30;
      d[o + 3] = v === 2 ? 0 : v === 1 ? 110 : 235;
    }
    this.fogCanvas.getContext('2d').putImageData(this.fogImg, 0, 0);
  }

  getChunk(cx, cy) {
    const key = cx + ',' + cy;
    let c = this.chunks.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = CHUNK_PX; c.height = CHUNK_PX;
    const g = c.getContext('2d');
    const world = this.world;
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        const mx = cx * CHUNK + tx, my = cy * CHUNK + ty;
        if (mx >= MAP_W || my >= MAP_H) continue;
        const t = world.terrain[my * MAP_W + mx];
        const pal = TERRAIN_COLORS[t] ?? TERRAIN_COLORS[T.GRASS];
        const n = ((mx * 7 + my * 13) % 97) / 97;
        g.fillStyle = pal[Math.floor(n * pal.length)];
        g.fillRect(tx * TILE, ty * TILE, TILE, TILE);
        if (t === T.WATER) {
          g.strokeStyle = 'rgba(255,255,255,.25)';
          g.beginPath();
          const yy = ty * TILE + 10 + n * 12;
          g.moveTo(tx * TILE + 4, yy);
          g.quadraticCurveTo(tx * TILE + 12, yy - 3, tx * TILE + 22, yy);
          g.stroke();
        } else if (t === T.MOUNTAIN && n > 0.35) {
          g.fillStyle = '#6b7480';
          g.beginPath();
          g.moveTo(tx * TILE + 6, ty * TILE + 26);
          g.lineTo(tx * TILE + 16, ty * TILE + 8);
          g.lineTo(tx * TILE + 26, ty * TILE + 26);
          g.closePath(); g.fill();
          g.fillStyle = '#fff';
          g.beginPath();
          g.moveTo(tx * TILE + 13, ty * TILE + 15);
          g.lineTo(tx * TILE + 16, ty * TILE + 8);
          g.lineTo(tx * TILE + 19, ty * TILE + 15);
          g.closePath(); g.fill();
        }
      }
    }
    this.chunks.set(key, c);
    return c;
  }

  dropChunkForNode(node) {
    const cx = Math.floor(node.x / CHUNK), cy = Math.floor(node.y / CHUNK);
    this.chunks.delete(cx + ',' + cy);
  }

  render(time, now) {
    const ctx = this.ctx, cam = this.cam, world = this.world;
    const scale = cam.zoom * this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#25406a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!world.ready) return;

    ctx.save();
    ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cam.x, -cam.y);

    // --- terrain chunks in view ---
    const x0 = Math.max(0, Math.floor((cam.x - cam.viewW / 2) / CHUNK_PX));
    const x1 = Math.min(Math.ceil(MAP_W / CHUNK) - 1, Math.floor((cam.x + cam.viewW / 2) / CHUNK_PX));
    const y0 = Math.max(0, Math.floor((cam.y - cam.viewH / 2) / CHUNK_PX));
    const y1 = Math.min(Math.ceil(MAP_H / CHUNK) - 1, Math.floor((cam.y + cam.viewH / 2) / CHUNK_PX));
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        ctx.drawImage(this.getChunk(cx, cy), cx * CHUNK_PX, cy * CHUNK_PX);
      }
    }

    // --- visible tile range for culling ---
    const vtx0 = Math.max(0, Math.floor((cam.x - cam.viewW / 2) / TILE) - 2);
    const vty0 = Math.max(0, Math.floor((cam.y - cam.viewH / 2) / TILE) - 2);
    const vtx1 = Math.min(MAP_W, Math.ceil((cam.x + cam.viewW / 2) / TILE) + 2);
    const vty1 = Math.min(MAP_H, Math.ceil((cam.y + cam.viewH / 2) / TILE) + 2);

    for (const n of world.nodes.values()) {
      if (n.x < vtx0 || n.x >= vtx1 || n.y < vty0 || n.y >= vty1) continue;
      drawNode(ctx, n, time);
    }

    // buildings (beneath units) — castles render via drawCastle(spawn)
    for (const b of world.buildings.values()) {
      if (b.type === BUILDING.CASTLE) continue;
      if (b.x >= vtx1 || b.y >= vty1 || b.x + b.size <= vtx0 || b.y + b.size <= vty0) continue;
      drawBuilding(ctx, b, world, time);
    }

    // placement ghost
    if (world.buildMode && world.mouseWorld) {
      const tx = Math.floor(world.mouseWorld.x / TILE), ty = Math.floor(world.mouseWorld.y / TILE);
      const def = BUILDING_DEF[world.buildMode];
      const ok = world.canPlace(world.buildMode, tx, ty);
      ctx.globalAlpha = 0.55;
      drawFinishedBuilding(ctx, world.buildMode, tx * TILE, ty * TILE, def.size,
        world.players.get(world.myPid)?.color ?? '#2f7de1');
      ctx.globalAlpha = 1;
      for (let dy = 0; dy < def.size; dy++) for (let dx = 0; dx < def.size; dx++) {
        ctx.strokeStyle = ok ? 'rgba(70,180,70,.9)' : 'rgba(220,60,60,.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect((tx + dx) * TILE + 1, (ty + dy) * TILE + 1, TILE - 2, TILE - 2);
      }
    }

    for (const s of world.spawns ?? []) {
      if (s.x < vtx0 || s.x >= vtx1 || s.y < vty0 || s.y >= vty1) continue;
      drawCastle(ctx, s, time);
    }

    // own workers
    for (const w of world.myWorkers.values()) {
      const sel = world.selection.has(w.id);
      drawWorker(ctx, w.x, w.y, world.players.get(world.myPid)?.color ?? '#2f7de1', time, w.state, sel, w.carry, w.carryType, w);
    }
    // other players' visible units
    for (const r of world.remoteUnits.values()) {
      const p = world.remotePos(r, now);
      if (p.x / TILE < vtx0 - 2 || p.x / TILE > vtx1 + 2 || p.y / TILE < vty0 - 2 || p.y / TILE > vty1 + 2) continue;
      drawWorker(ctx, p.x, p.y, world.players.get(r.owner)?.color ?? '#999', time, 'remote', false, 0, null, r);
    }

    // selection rectangle
    if (this.world.dragRect) {
      const r = this.world.dragRect;
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
      ctx.setLineDash([]);
    }

    // --- fog of war overlay (bilinear-scaled pixel map) ---
    this.refreshFogImage();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fogCanvas, 0, 0, MAP_W, MAP_H, -TILE / 2, -TILE / 2, MAP_W * TILE, MAP_H * TILE);

    ctx.restore();
  }
}

/* ================= entity drawing (cartoon vector) ================= */

function drawNode(ctx, n, time) {
  const x = n.x * TILE + TILE / 2, y = n.y * TILE + TILE / 2;
  const h = Math.sin(time * 0.002 + n.id * 7) * 1.2;
  ctx.save();
  ctx.translate(x, y + h);
  // soft shadow
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath(); ctx.ellipse(0, 9, 11, 5, 0, 0, Math.PI * 2); ctx.fill();

  if (n.type === NODE.TREE) {
    const s = 0.85 + ((n.id * 13) % 5) / 12;
    ctx.fillStyle = '#7a5230';
    ctx.fillRect(-3, 2, 6, 9);
    ctx.fillStyle = '#3e8c3a';
    ctx.beginPath(); ctx.arc(0, -6 * s, 11 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#57ab4a';
    ctx.beginPath(); ctx.arc(-4 * s, -9 * s, 8 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#71c25d';
    ctx.beginPath(); ctx.arc(3 * s, -11 * s, 6 * s, 0, Math.PI * 2); ctx.fill();
  } else if (n.type === NODE.STONE) {
    ctx.fillStyle = '#9aa3ab';
    roundRock(ctx, 0, 2, 12);
    ctx.fillStyle = '#b7bfc7';
    roundRock(ctx, 2, -1, 7);
  } else if (n.type === NODE.GOLD) {
    ctx.fillStyle = '#8b8f96';
    roundRock(ctx, 0, 3, 13);
    ctx.fillStyle = '#f2c33b';
    for (let i = 0; i < 3; i++) {
      const a = n.id * 40 + i * 2.1;
      ctx.beginPath(); ctx.arc(Math.cos(a) * 6, Math.sin(a) * 4 - 1, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,200,.85)';
    ctx.beginPath(); ctx.arc(0, -3, 1.8, 0, Math.PI * 2); ctx.fill();
  } else if (n.type === NODE.BERRY) {
    ctx.fillStyle = '#4c9c40';
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#e0464a';
    for (let i = 0; i < 4; i++) {
      const a = n.id + i * 1.7;
      ctx.beginPath(); ctx.arc(Math.cos(a) * 5, Math.sin(a) * 4, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();

  // depletion arc
  if (n.amount < n.max) {
    const frac = Math.max(0, n.amount / n.max);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(x - 12, y - 22, 24, 4);
    ctx.fillStyle = '#ffd25e';
    ctx.fillRect(x - 12, y - 22, 24 * frac, 4);
  }
}

function roundRock(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.quadraticCurveTo(x - r, y - r, x, y - r);
  ctx.quadraticCurveTo(x + r, y - r, x + r, y);
  ctx.closePath(); ctx.fill();
}

export function drawWorker(ctx, x, y, color, time, state, selected, carry, carryType, unit) {
  const moving = state === 'toNode' || state === 'toDepot' || state === 'move' || state === 'fight' || state === 'flee';
  const bob = moving ? Math.abs(Math.sin(time * 0.012)) * 3 : Math.sin(time * 0.003) * 0.8;
  ctx.save();
  ctx.translate(x, y - bob);
  if (selected) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(0, 9, 12, 6, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.beginPath(); ctx.ellipse(0, 9, 16, 8, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.beginPath(); ctx.ellipse(0, 9, 9, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  // body
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(0, -2, 8, 0, Math.PI * 2); ctx.fill();
  // head
  ctx.fillStyle = '#ffe0b8';
  ctx.beginPath(); ctx.arc(0, -12, 6, 0, Math.PI * 2); ctx.fill();
  // eyes
  ctx.fillStyle = '#333';
  ctx.beginPath(); ctx.arc(-2, -13, 1.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(2, -13, 1.1, 0, Math.PI * 2); ctx.fill();
  // carry icon
  if (carry > 0 && carryType) {
    const icons = { wood: '🪵', stone: '🪨', gold: '💰', food: '🍎', bricks: '🧱' };
    ctx.font = '9px serif';
    ctx.fillText(icons[carryType] ?? '📦', -5, -19);
  }
  // Phase 3: role badge above military units + hp bar when wounded
  if (unit?.type && unit.type !== UNIT.WORKER) {
    ctx.font = '10px serif';
    ctx.textAlign = 'center';
    ctx.fillText(ROLE_DEF[unit.type]?.icon ?? '\u2694\ufe0f', 0, -21);
  }
  if (unit && typeof unit.hp === 'number' && unit.maxHp > 0 && unit.hp < unit.maxHp - 0.5) {
    const frac = Math.max(0, unit.hp / unit.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fillRect(-9, -18, 18, 3);
    ctx.fillStyle = frac > 0.35 ? '#62d26f' : '#e3543f';
    ctx.fillRect(-9, -18, 18 * frac, 3);
  }
  ctx.restore();
}

const BUILDING_ICON = {
  [BUILDING.HOUSE]: { c: '#e8b169' },
  [BUILDING.WAREHOUSE]: { c: '#a9825f' },
  [BUILDING.FARM]: { c: '#84cc56' },
  [BUILDING.LUMBERMILL]: { c: '#7a5230' },
  [BUILDING.QUARRY]: { c: '#9aa3ab' },
  [BUILDING.GOLDMINE_B]: { c: '#f2c33b' },
  [BUILDING.BRICKFACTORY]: { c: '#c25b3a' },
  [BUILDING.BARRACKS]: { c: '#8a5a33' },
  [BUILDING.WATCHTOWER]: { c: '#7d868f' },
};

export function drawBuilding(ctx, b, world, time) {
  const done = b.done <= b.now;
  const px = b.x * TILE, py = b.y * TILE, s = b.size * TILE;
  const color = world.players.get(b.owner)?.color ?? '#999';
  if (!done) {
    // construction: ground + scaffold frame + progress
    ctx.fillStyle = 'rgba(0,0,0,.15)';
    ctx.fillRect(px + 3, py + 3, s - 6, s - 6);
    ctx.strokeStyle = '#a9825f'; ctx.lineWidth = 4;
    ctx.strokeRect(px + 6, py + 6, s - 12, s - 12);
    ctx.beginPath();
    ctx.moveTo(px + 6, py + 6); ctx.lineTo(px + s - 6, py + s - 6);
    ctx.moveTo(px + s - 6, py + 6); ctx.lineTo(px + 6, py + s - 6);
    ctx.stroke();
    const def = BUILDING_DEF[b.type];
    const frac = Math.max(0, Math.min(1, 1 - (b.done - b.now) / def.buildTime));
    ctx.fillStyle = 'rgba(0,0,0,.4)';
    ctx.fillRect(px + 4, py - 6, s - 8, 6);
    ctx.fillStyle = '#ffd25e';
    ctx.fillRect(px + 4, py - 6, (s - 8) * frac, 6);
    return;
  }
  drawFinishedBuilding(ctx, b.type, px, py, b.size, color);
}

function drawFinishedBuilding(ctx, type, px, py, size, color) {
  const s = size * TILE;
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.beginPath(); ctx.ellipse(px + s / 2, py + s - 4, s * 0.48, 8, 0, 0, Math.PI * 2); ctx.fill();
  if (type === BUILDING.CASTLE) {
    ctx.fillStyle = '#cbb394'; ctx.fillRect(px + 4, py + 8, s - 8, s - 14);
    ctx.fillStyle = '#b39a76'; ctx.fillRect(px + 4, py + 8, s - 8, 6);
    for (let i = 0; i < 4; i++) ctx.fillRect(px + 4 + i * (s - 12) / 3 - 2, py + 2, 6, 8);
    ctx.fillStyle = '#5a4430';
    ctx.beginPath(); ctx.moveTo(px + s / 2 - 7, py + s - 4); ctx.lineTo(px + s / 2 - 7, py + s - 18);
    ctx.quadraticCurveTo(px + s / 2, py + s - 26, px + s / 2 + 7, py + s - 18);
    ctx.lineTo(px + s / 2 + 7, py + s - 4); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#5a4430'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px + s / 2, py + 2); ctx.lineTo(px + s / 2, py - 8); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(px + s / 2, py - 8); ctx.lineTo(px + s / 2 + 12, py - 5); ctx.lineTo(px + s / 2, py - 2); ctx.closePath(); ctx.fill();
  } else if (type === BUILDING.HOUSE) {
    ctx.fillStyle = BUILDING_ICON[type].c;
    ctx.fillRect(px + 7, py + 15, s - 14, s - 22);
    ctx.fillStyle = '#b5451f';
    ctx.beginPath(); ctx.moveTo(px + 3, py + 15); ctx.lineTo(px + s / 2, py + 3); ctx.lineTo(px + s - 3, py + 15); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#5a4430'; ctx.fillRect(px + s - 14, py + s - 14, 7, 7);
    ctx.fillStyle = '#fdf6e3'; ctx.fillRect(px + 10, py + 18, 6, 6);
  } else if (type === BUILDING.FARM) {
    ctx.fillStyle = '#8b6a3f'; ctx.fillRect(px + 2, py + 2, s - 4, s - 4);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i % 2 ? '#79c34f' : '#89d35b';
      ctx.fillRect(px + 5 + i * ((s - 10) / 3) + 1, py + 5, (s - 10) / 3 - 2, s - 10);
    }
    ctx.fillStyle = '#f2c33b';
    for (let i = 0; i < 6; i++) ctx.fillRect(px + 8 + (i % 3) * 9, py + 8 + ((i / 3) | 0) * 12, 3, 7);
  } else if (type === BUILDING.WAREHOUSE) {
    ctx.fillStyle = BUILDING_ICON[type].c; ctx.fillRect(px + 4, py + 10, s - 8, s - 16);
    ctx.fillStyle = '#8a6a4a'; ctx.fillRect(px + 2, py + 6, s - 4, 8);
    ctx.fillStyle = '#5a4430'; ctx.fillRect(px + s - 18, py + s - 18, 12, 12);
    ctx.fillStyle = '#f2c33b'; ctx.fillRect(px + 10, py + 16, 6, 6);
    ctx.fillStyle = '#fdf6e3'; ctx.fillRect(px + 18, py + 16, 6, 6);
  } else if (type === BUILDING.BRICKFACTORY) {
    ctx.fillStyle = BUILDING_ICON[type].c; ctx.fillRect(px + 4, py + 8, s - 8, s - 14);
    ctx.fillStyle = '#8a3d24'; ctx.fillRect(px + 10, py - 2, 10, 14);
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.beginPath(); ctx.arc(px + 15, py - 6 + Math.sin(time * 0.004) * 2, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 1;
    for (let r = 0; r < 4; r++) {
      ctx.beginPath(); ctx.moveTo(px + 6, py + 14 + r * 6); ctx.lineTo(px + s - 6, py + 14 + r * 6); ctx.stroke();
    }
  } else if (type === BUILDING.BARRACKS) {
    // wooden fort with a war banner
    ctx.fillStyle = BUILDING_ICON[type].c;
    ctx.fillRect(px + 4, py + 12, s - 8, s - 18);
    ctx.fillStyle = '#6e4626';
    ctx.fillRect(px + 4, py + 12, s - 8, 7);
    ctx.fillStyle = '#5a4430';
    ctx.fillRect(px + 10, py + s - 18, 12, 12);
    ctx.fillStyle = '#fdf6e3';
    ctx.fillRect(px + 10, py + 18, 7, 7);
    ctx.fillRect(px + s - 18, py + 18, 7, 7);
    ctx.strokeStyle = '#5a4430'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px + s / 2, py + 12); ctx.lineTo(px + s / 2, py - 4); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.3)';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(px + 12 + i * (s - 24) / 2, py + 22); ctx.lineTo(px + 20 + i * (s - 24) / 2, py + s - 18); ctx.stroke();
    }
  } else if (type === BUILDING.WATCHTOWER) {
    // grey stone tower, arrow slits + signal flame
    ctx.fillStyle = '#7d868f';
    ctx.fillRect(px + 10, py + 6, s - 20, s - 10);
    ctx.fillStyle = '#666e77';
    ctx.fillRect(px + 10, py + 6, s - 20, 6);
    ctx.fillStyle = '#9aa3ab';
    ctx.fillRect(px + 6, py + 2, s - 12, 8);
    ctx.fillStyle = '#3a4048';
    ctx.fillRect(px + s / 2 - 2, py + 14, 4, 8);
    ctx.fillRect(px + s / 2 - 2, py + s - 18, 4, 8);
    ctx.fillStyle = '#f2a33b';
    ctx.beginPath(); ctx.arc(px + s / 2, py - 2 + Math.sin(time * 0.004) * 1.5, 3.5, 0, Math.PI * 2); ctx.fill();
  } else {
    // aura buildings: lumbermill / quarry / goldmine
    ctx.fillStyle = BUILDING_ICON[type]?.c ?? '#a9825f';
    ctx.fillRect(px + 4, py + 10, s - 8, s - 16);
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(px + 2, py + 6, s - 4, 8);
    if (type === BUILDING.LUMBERMILL) {
      ctx.strokeStyle = '#5a4430'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(px + s / 2, py + s / 2, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px + s / 2, py + s / 2); ctx.lineTo(px + s / 2 + 8, py + s / 2 - 8); ctx.stroke();
    } else if (type === BUILDING.QUARRY) {
      ctx.fillStyle = '#9aa3ab';
      ctx.beginPath(); ctx.arc(px + s / 2, py + s / 2, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#b7bfc7'; ctx.fillRect(px + s / 2 - 3, py + s / 2 - 6, 6, 6);
    } else {
      ctx.fillStyle = '#f2c33b';
      ctx.beginPath(); ctx.moveTo(px + s / 2, py + 8); ctx.lineTo(px + s / 2 + 9, py + s / 2); ctx.lineTo(px + s / 2, py + s - 8); ctx.lineTo(px + s / 2 - 9, py + s / 2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fdf6e3'; ctx.fillRect(px + s / 2 - 2, py + s / 2 - 2, 4, 4);
    }
  }
}

function drawCastle(ctx, s, time) {
  const x = s.x * TILE + TILE / 2, y = s.y * TILE + TILE / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,.2)';
  ctx.beginPath(); ctx.ellipse(0, 12, 20, 8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#cbb394';
  ctx.fillRect(-16, -14, 32, 26);
  ctx.fillStyle = '#b39a76';
  ctx.fillRect(-16, -14, 32, 5);
  for (let i = -2; i <= 2; i++) ctx.fillRect(i * 7 - 2, -19, 4, 6);
  ctx.fillStyle = '#5a4430';
  ctx.beginPath(); ctx.moveTo(-4, 12); ctx.lineTo(-4, 0); ctx.quadraticCurveTo(0, -6, 4, 0); ctx.lineTo(4, 12); ctx.closePath(); ctx.fill();
  // flag in the kingdom color
  ctx.strokeStyle = '#5a4430'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -19); ctx.lineTo(0, -30); ctx.stroke();
  ctx.fillStyle = s.color ?? '#2f7de1';
  ctx.beginPath(); ctx.moveTo(0, -30); ctx.lineTo(11 + Math.sin(time * 0.004) * 2, -27); ctx.lineTo(0, -24); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(s.name ?? '', 0, 22);
  ctx.restore();
}
