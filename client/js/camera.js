// Camera: pan / zoom for mouse, wheel, keyboard and touch (pinch).

import { MAP_W, MAP_H, TILE, MIN_ZOOM, MAX_ZOOM } from '../../shared/constants.js';

export class Camera {
  constructor(canvas) {
    this.canvas = canvas;
    this.x = MAP_W * TILE / 2; // world center
    this.y = MAP_H * TILE / 2;
    this.zoom = 1;
    this.keys = new Set();
    addEventListener('keydown', e => this.keys.add(e.key));
    addEventListener('keyup', e => this.keys.delete(e.key));
  }

  get viewW() { return this.canvas.width / this.zoom; }
  get viewH() { return this.canvas.height / this.zoom; }

  centerOn(wx, wy) { this.x = wx; this.y = wy; }
  clamp() {
    const halfW = this.viewW / 2, halfH = this.viewH / 2;
    const margin = 4 * TILE;
    this.x = Math.min(Math.max(this.x, halfW - margin), MAP_W * TILE - halfW + margin);
    this.y = Math.min(Math.max(this.y, halfH - margin), MAP_H * TILE - halfH + margin);
  }

  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.canvas.width / 2) / this.zoom + this.x,
      y: (sy - this.canvas.height / 2) / this.zoom + this.y,
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.canvas.width / 2,
      y: (wy - this.y) * this.zoom + this.canvas.height / 2,
    };
  }

  update(dt) {
    const speed = 600 * dt / this.zoom;
    if (this.keys.has('ArrowLeft') || this.keys.has('a') || this.keys.has('A')) this.x -= speed;
    if (this.keys.has('ArrowRight') || this.keys.has('d') || this.keys.has('D')) this.x += speed;
    if (this.keys.has('ArrowUp') || this.keys.has('w') || this.keys.has('W')) this.y -= speed;
    if (this.keys.has('ArrowDown') || this.keys.has('s') || this.keys.has('S')) this.y += speed;
    this.clamp();
  }
}
