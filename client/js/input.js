// Pointer input: unified mouse + touch.
// drag = pan, two-finger pinch = zoom, tap = select/assign,
// RMB tap = assign/force-move, Shift+drag = box select (desktop).

import { TILE } from '../../shared/constants.js';

export class Input {
  constructor(canvas, cam, world, net, ui) {
    this.cam = cam; this.world = world; this.net = net; this.ui = ui;
    this.canvas = canvas;
    this.pointers = new Map();
    this.pinchDist = 0;
    this.pinchZoom = null;
    this.downPos = null;
    this.dragged = false;
    this.shiftDrag = false;

    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', e => this.pointers.delete(e.pointerId));
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      cam.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.12 : 0.89);
    }, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    addEventListener('keydown', e => {
      if (e.key === 'Escape' && world.buildMode) { world.buildMode = null; ui.setBuildModeActive(null); }
    });
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.pos(e));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      this.pinchZoom = this.cam.zoom;
      this.downPos = null;
      return;
    }
    this.downPos = this.pos(e);
    this.dragged = false;
    this.lastP = this.downPos;
    this.shiftDrag = e.shiftKey;
    if (this.shiftDrag) this.world.dragRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  }

  onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, this.pos(e));

    // placement ghost follows any pointer move
    if (this.world.buildMode) {
      const p = this.pos(e);
      this.world.mouseWorld = this.cam.screenToWorld(p.x, p.y);
    }

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDist > 0 && this.pinchZoom) {
        this.cam.zoomAt(this.canvas.width / 2, this.canvas.height / 2,
          (this.pinchZoom * (d / this.pinchDist)) / this.cam.zoom);
      }
      return;
    }

    const p = this.pos(e);
    if (!this.downPos) return;
    const dx = Math.abs(p.x - this.downPos.x), dy = Math.abs(p.y - this.downPos.y);
    if (dx < 6 && dy < 6 && !this.dragged) return;

    if (this.shiftDrag) {
      const c = this.cam.screenToWorld(this.downPos.x, this.downPos.y);
      const q = this.cam.screenToWorld(p.x, p.y);
      this.world.dragRect = { x0: c.x, y0: c.y, x1: q.x, y1: q.y };
    } else {
      this.cam.x -= (p.x - this.lastP.x) / this.cam.zoom;
      this.cam.y -= (p.y - this.lastP.y) / this.cam.zoom;
      this.cam.clamp();
    }
    this.dragged = true;
    this.lastP = p;
  }

  onUp(e) {
    const p = this.pos(e);
    const isRMB = e.button === 2;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchDist = 0, this.pinchZoom = null;

    if (this.shiftDrag && this.world.dragRect && this.dragged) {
      this.boxSelect();
      this.world.dragRect = null; this.downPos = null; this.lastP = null;
      return;
    }
    if (!this.downPos) { this.world.dragRect = null; return; }

    const w = this.cam.screenToWorld(p.x, p.y);
    if (this.dragged) {
      this.world.dragRect = null; this.downPos = null; this.lastP = null;
      return;
    }
    if (isRMB) this.assignAt(w);
    else this.tapAt(w);
    this.world.dragRect = null; this.downPos = null; this.lastP = null;
  }

  tapAt(w) {
    const world = this.world;

    // placement mode: try placing and leave mode (keeps it simple on touch)
    if (world.buildMode) {
      const tx = Math.floor(w.x / TILE), ty = Math.floor(w.y / TILE);
      if (world.canPlace(world.buildMode, tx, ty)) {
        this.net.send({ t: 'build', type: world.buildMode, x: tx, y: ty });
        this.ui.flashMsg('🏗️ جاري البناء…');
        world.buildMode = null;
        this.ui.setBuildModeActive(null);
      } else {
        this.ui.flashMsg('✕ مكان غير صالح');
      }
      return;
    }

    // building click?
    const tx = Math.floor(w.x / TILE), ty = Math.floor(w.y / TILE);
    const building = world.buildingAt(tx, ty);
    if (building) {
      // brickfactory with a worker selection = assign the factory job
      if (building.owner === world.myPid && world.selection.size > 0) {
        this.net.send({ t: 'assignBuilding', workerIds: [...world.selection], buildingId: building.id });
        this.ui.flashMsg('🧱 تكليف العمال بالمعمل');
      }
      this.ui.showBuildingPanel(building);
      return;
    }

    let best = null, bestD = 22;
    for (const u of world.myWorkers.values()) {
      const d = Math.hypot(u.x - w.x, u.y - w.y);
      if (d < bestD) { bestD = d; best = u; }
    }
    if (best) {
      world.selection.clear();
      world.selection.add(best.id);
      this.ui.updateSelection();
      return;
    }
    const node = this.nodeAt(w);
    if (node && world.selection.size > 0) {
      this.net.send({ t: 'assign', workerIds: [...world.selection], nodeId: node.id });
      this.ui.flashMsg(`👷 ${world.selection.size} عمال → ${nodeTypeName(node.type)}`);
      return;
    }
    world.selection.clear();
    this.ui.updateSelection();
  }

  assignAt(w) {
    if (this.world.selection.size === 0) return;
    const node = this.nodeAt(w);
    if (node) {
      this.net.send({ t: 'assign', workerIds: [...this.world.selection], nodeId: node.id });
    } else {
      this.net.send({ t: 'move', workerIds: [...this.world.selection], x: w.x, y: w.y });
    }
  }

  boxSelect() {
    const r = this.world.dragRect;
    if (!r) return;
    const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1);
    const y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
    for (const u of this.world.myWorkers.values()) {
      if (u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) this.world.selection.add(u.id);
    }
    this.ui.updateSelection();
  }

  nodeAt(w) {
    const tx = Math.floor(w.x / TILE), ty = Math.floor(w.y / TILE);
    for (const n of this.world.nodes.values()) {
      if (n.x === tx && n.y === ty) return n;
    }
    return null;
  }
}

function nodeTypeName(type) {
  return { tree: 'الخشب', stone: 'الحجر', gold: 'الذهب', berry: 'الطعام' }[type] ?? type;
}
