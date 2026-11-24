// HUD: top resource bar, minimap, player list, selection info, stats panel,
// build menu and building panel.

import { MAP_W, MAP_H, T, TILE, RES_NAMES, BUILDING_DEF, BUILDING, UNIT, ROLE_DEF, TRAINABLE_ROLES, AGES, MAX_AGE } from '../../shared/constants.js';

const TERRAIN_MINI = {
  [T.GRASS]: '#79c34f', [T.HILL]: '#63a53f', [T.SAND]: '#e7d79f',
  [T.WATER]: '#3f97d6', [T.MOUNTAIN]: '#8f98a1',
};
const RES_ICON = { food: '🍎', wood: '🪵', stone: '🪨', gold: '💰', bricks: '🧱' };
const RES_AR = { food: 'طعام', wood: 'خشب', stone: 'حجر', gold: 'ذهب', bricks: 'طابوق' };
const NODE_AR = { tree: 'الخشب', stone: 'الحجر', gold: 'الذهب', berry: 'الطعام' };

export class UI {
  constructor(world, camera) {
    this.world = world;
    this.cam = camera;
    this.el = {
      hud: document.getElementById('hud'),
      food: document.getElementById('res-food'),
      wood: document.getElementById('res-wood'),
      stone: document.getElementById('res-stone'),
      gold: document.getElementById('res-gold'),
      bricks: document.getElementById('res-bricks'),
      pop: document.getElementById('res-pop'),
      cap: document.getElementById('res-cap'),
      players: document.getElementById('players-list'),
      selection: document.getElementById('selection-info'),
      minimap: document.getElementById('minimap'),
      statsPanel: document.getElementById('stats-panel'),
      statsBody: document.getElementById('stats-body'),
      banner: document.getElementById('connection-banner'),
      buildMenu: document.getElementById('build-menu'),
      buildButtons: document.getElementById('build-buttons'),
      btnBuildMenu: document.getElementById('btn-build-menu'),
      btnCancelBuild: document.getElementById('btn-cancel-build'),
      bp: document.getElementById('building-panel'),
      bpTitle: document.getElementById('bp-title'),
      bpBody: document.getElementById('bp-body'),
      bpTrain: document.getElementById('bp-train'),
      bpClose: document.getElementById('bp-close'),
      milMenu: document.getElementById('military-menu'),
      milButtons: document.getElementById('military-buttons'),
      btnMilMenu: document.getElementById('btn-mil-menu'),
      btnCloseMil: document.getElementById('btn-close-mil'),
      ageBadge: document.getElementById('age-badge'),
      btnAgeUp: document.getElementById('btn-age-up'),
    };
    this.bstate = { selectedBuilding: null };
    this.toast = null;
    this.trainOk = false;
    this.buildMilitaryMenu();
    this.mctx = this.el.minimap.getContext('2d');
    this.miniBase = document.createElement('canvas');
    this.miniBase.width = MAP_W; this.miniBase.height = MAP_H;
    this.buildBuildMenu();
  }

  showHud(on) { this.el.hud.classList.toggle('hidden', !on); }

  // ---------- build menu ----------

  buildBuildMenu() {
    const order = [
      BUILDING.HOUSE, BUILDING.FARM, BUILDING.WAREHOUSE,
      BUILDING.LUMBERMILL, BUILDING.QUARRY, BUILDING.GOLDMINE_B, BUILDING.BRICKFACTORY,
      BUILDING.BARRACKS, BUILDING.WATCHTOWER,
    ];
    const ICONS = {
      [BUILDING.HOUSE]: '🏠', [BUILDING.FARM]: '🌾', [BUILDING.WAREHOUSE]: '📦',
      [BUILDING.LUMBERMILL]: '🪚', [BUILDING.QUARRY]: '⛏️', [BUILDING.GOLDMINE_B]: '⛏️',
      [BUILDING.BRICKFACTORY]: '🧱',
      [BUILDING.BARRACKS]: '⚔️', [BUILDING.WATCHTOWER]: '🗼',
    };
    const SHORT = { food: '🍎', wood: '🪵', stone: '🪨', gold: '💰', bricks: '🧱' };
    this.el.buildButtons.innerHTML = order.map(type => {
      const def = BUILDING_DEF[type];
      const cost = Object.entries(def.cost).map(([r, v]) => `${SHORT[r]}${v}`).join(' ');
      return `<button class="bbtn" data-btype="${type}">
        <span class="bi">${ICONS[type]}</span><span class="bn">${def.name}</span>
        <span class="bc">${cost}</span></button>`;
    }).join('');
    this.el.buildButtons.querySelectorAll('[data-btype]').forEach(b => {
      b.addEventListener('click', () => this.onBuildSelect?.(b.dataset.btype));
    });
  }

  refreshAffordability(stock) {
    this.el.buildButtons.querySelectorAll('[data-btype]').forEach(b => {
      const def = BUILDING_DEF[b.dataset.btype] ?? BUILDING_DEF[BUILDING.CASTLE];
      const ok = Object.entries(def.cost).every(([r, v]) => (stock[r] ?? 0) >= v);
      b.classList.toggle('cant', !ok);
    });
  }

  // replaced by main.js
  onBuildSelect(type) {}

  setBuildModeActive(type) {
    this.el.buildButtons.querySelectorAll('[data-btype]').forEach(b =>
      b.classList.toggle('active', b.dataset.btype === type));
  }

  setBuildMenuVisible(on) {
    this.el.buildMenu.classList.toggle('hidden', !on);
  }

  setTrainButton(ok, reason) {
    this.trainOk = ok;
    this.el.bpTrain.disabled = !ok;
    this.el.bpTrain.classList.toggle('cant', !ok);
    this.el.bpTrain.title = reason || '';
  }

  trainButtonState() { return this.trainOk; }

  // ---------- Phase 3: military training + ages ----------

  buildMilitaryMenu() {
    const SHORT = { food: '🍏', wood: '🪵', stone: '🧨', gold: '💰', bricks: '🧱' };
    this.el.milButtons.innerHTML = TRAINABLE_ROLES.map(role => {
      const def = ROLE_DEF[role];
      const cost = Object.entries(def.cost).map(([r, v]) => `${SHORT[r]}${v}`).join(' ');
      return `<button class="bbtn" data-role="${role}">
        <span class="bi">${def.icon}</span><span class="bn">${def.name}</span>
        <span class="bc">${cost}</span></button>`;
    }).join('');
    this.el.milButtons.querySelectorAll('[data-role]').forEach(b => {
      b.addEventListener('click', () => this.onMilSelect?.(b.dataset.role));
    });
  }

  // replaced by main.js
  onMilSelect(role) {}

  refreshRoleAffordability(stock, world) {
    const pop = world.myPop();
    this.el.milButtons.querySelectorAll('[data-role]').forEach(b => {
      const def = ROLE_DEF[b.dataset.role];
      const afford = Object.entries(def.cost).every(([r, v]) => (stock[r] ?? 0) >= v);
      const from = def.from === 'barracks'
        ? [...world.buildings.values()].some(x => x.owner === world.myPid
            && x.type === BUILDING.BARRACKS && x.done <= x.now)
        : true;
      b.classList.toggle('cant', !afford || pop.units >= pop.cap || !from);
    });
  }

  updateAgeUI() {
    const age = Math.min(MAX_AGE, this.world.myAge ?? 1);
    const cur = AGES[age];
    const next = AGES[age + 1];
    this.el.ageBadge.textContent = `${cur.icon} ${cur.name}`;
    const btn = this.el.btnAgeUp;
    if (!next) {
      btn.textContent = '👑 أعلى عصر';
      btn.disabled = true;
      return;
    }
    const s = this.world.stockFor(this.world.myPid) ?? {};
    const TERMS = { food: '🍏', wood: '🪵', gold: '💰' };
    const cost = Object.entries(next.cost).filter(([r]) => r !== 'building')
      .map(([r, v]) => `${TERMS[r] ?? ''}${v}`).join(' ');
    btn.textContent = `⬆️ العصر التالي ${next.icon} (${cost})`;
    const afford = Object.entries(next.cost).every(([r, v]) =>
      r === 'building' ? true : (s[r] ?? 0) >= v);
    const buildingOk = next.cost.building
      ? [...this.world.buildings.values()].some(b => b.owner === this.world.myPid
          && b.type === BUILDING.WATCHTOWER && b.done <= b.now)
      : true;
    btn.disabled = !(afford && buildingOk);
    btn.title = next.cost.building && !buildingOk
      ? 'يلزم فنا مراقبة مبنية' : '';
  }

  // ---------- building panel ----------

  showBuildingPanel(b) {
    this.bstate.selectedBuilding = { ...b };
    const def = BUILDING_DEF[b.type];
    this.el.bpTitle.textContent = def.name;
    if (b.done > b.now) {
      const frac = Math.min(1, Math.max(0, 1 - (b.done - b.now) / def.buildTime));
      this.el.bpBody.textContent = `🚧 قيد البناء — ${Math.round(frac * 100)}%`;
      this.el.bpTrain.classList.add('hidden');
    } else if (b.type === BUILDING.CASTLE) {
      this.el.bpBody.textContent = 'نقطة الإيداع وتدريب العمال';
      this.el.bpTrain.classList.remove('hidden');
    } else {
      this.el.bpBody.textContent = def.foodPerTick ? '🌟 تعمل: إنتاج طعام مستمر'
        : def.auraMult ? `🌟 تعمل: +${Math.round((def.auraMult - 1) * 100)}% جمع ${NODE_AR[def.auraNode] ?? ''} ضمن ${def.auraRadius} بلاطات`
        : b.type === BUILDING.BARRACKS ? '⚔️ درّب الأدوار من قائمة «⚔️ قوات» السفلية'
        : def.dmg ? '🎯 مرادف مدافع: يرصد بواسع ويقذف كل عدو في مداه'
        : def.bricksPerTick ? '🌟 اعمل العمال عليها لإنتاج الطابوق (يستهلك الحجر)'
        : def.depot ? '🌟 نقطة إيداع للموارد' : '';
      this.el.bpTrain.classList.add('hidden');
    }
    this.el.bp.classList.remove('hidden');
  }

  refreshBuildingPanel(world) {
    const b = this.bstate.selectedBuilding;
    if (!b) return;
    const live = world.buildings.get(b.id);
    if (!live) {
      this.el.bp.classList.add('hidden');
      this.bstate.selectedBuilding = null;
      return;
    }
    Object.assign(b, live);
    const def = BUILDING_DEF[b.type];
    if (b.done > b.now) {
      const frac = Math.min(1, Math.max(0, 1 - (b.done - b.now) / def.buildTime));
      this.el.bpBody.textContent = `🚧 قيد البناء — ${Math.round(frac * 100)}%`;
    }
  }

  hideBuildingPanel() {
    this.el.bp.classList.add('hidden');
    this.bstate.selectedBuilding = null;
  }

  // ---------- resources ----------

  updateResources(myPid) {
    const s = this.world.stockFor(myPid);
    if (!s) return;
    this.el.food.textContent = Math.floor(s.food);
    this.el.wood.textContent = Math.floor(s.wood);
    this.el.stone.textContent = Math.floor(s.stone);
    this.el.gold.textContent = Math.floor(s.gold);
    this.el.bricks.textContent = Math.floor(s.bricks);
    const pop = this.world.myPop();
    this.el.pop.textContent = `${pop.units}/${pop.cap}`;
    const cap = this.world.myStorage();
    const total = RES_NAMES.reduce((a, r) => a + (s[r] ?? 0), 0);
    this.el.cap.textContent = `${Math.floor(total)}/${cap}`;
    this.el.cap.parentElement.classList.toggle('storage-full', total >= cap);
    this.refreshAffordability(s);
    this.refreshRoleAffordability(s, this.world);
    this.updateAgeUI();
    this.refreshBuildingPanel(this.world);
  }

  updatePlayers(roomPlayers, myPid) {
    this.el.players.innerHTML = roomPlayers.map(p =>
      `<div class="prow ${p.connected ? '' : 'off'}">
        <span class="dot" style="background:${p.color}"></span>
        <span>${escapeHtml(p.name)}</span>
        <span class="tag">${p.pid === myPid ? 'أنت' : p.connected ? 'متصل' : '✕ منقطع'}</span>
      </div>`).join('');
  }

  updateSelection() {
    const sel = this.world.selection;
    if (sel.size === 0) { this.el.selection.textContent = 'اختر عاملاً… (اسحب للتجول، انقر على مورد لتكليف العمال)'; return; }
    const tasks = {};
    const roles = {};
    let military = 0;
    for (const id of sel) {
      const w = this.world.myWorkers.get(id);
      if (!w) continue;
      if (w.type && w.type !== UNIT.WORKER) {
        military++;
        const nm = ROLE_DEF[w.type]?.name ?? w.type;
        roles[nm] = (roles[nm] ?? 0) + 1;
        continue;
      }
      const task = w.state === 'gather' ? ('يجمع ' + (RES_AR[w.carryType] ?? 'مورداً'))
        : w.state === 'toNode' ? 'يتجه للمورد'
        : w.state === 'toBuilding' ? 'يتجه إلى المعمل'
        : w.state === 'workFactory' ? 'يصنع الطابوق'
        : w.state === 'toDepot' ? 'يعيد الحمولة للمخزن'
        : w.state === 'fight' ? 'يقاتل'
        : w.state === 'flee' ? 'يهرب'
        : 'خامل';
      tasks[task] = (tasks[task] ?? 0) + 1;
    }
    const breakdown = Object.entries(tasks).map(([t, n]) => `${n} ${t}`).join(' · ');
    const roleBreak = Object.entries(roles).map(([r, n]) => `${n} ${r}`).join(' · ');
    this.el.selection.textContent = military > 0
      ? `⚔️ محددون: ${sel.size}${military < sel.size ? ' (' + (sel.size - military) + ' عمال)' : ''} — ` + roleBreak
      : `👷 عمال محددون: ${sel.size} — ` + breakdown;
  }

  flashMsg(text) {
    this.el.selection.textContent = text;
    clearTimeout(this.toast);
    this.toast = setTimeout(() => this.updateSelection(), 1600);
  }

  drawMinimap() {
    const w = this.world;
    if (!w.ready || !w.terrain) return;
    const g = this.mctx;
    const sx = this.el.minimap.width / MAP_W, sy = this.el.minimap.height / MAP_H;
    if (this.minimapDirty === undefined) this.minimapBase.getContext('2d').putImageData(this.minimapImage(), 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.miniBase, 0, 0, MAP_W, MAP_H, 0, 0, this.el.minimap.width, this.el.minimap.height);
    g.globalAlpha = 0.75;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (w.fog[y * MAP_W + x] === 2) continue;
        g.fillStyle = w.fog[y * MAP_W + x] === 1 ? 'rgba(20,25,40,.5)' : 'rgba(10,12,25,.92)';
        g.fillRect(x * sx, y * sy, sx, sy);
      }
    }
    g.globalAlpha = 1;
    for (const u of w.remoteUnits.values()) {
      g.fillStyle = w.players.get(u.owner)?.color ?? '#fff';
      g.fillRect(u.x / TILE * sx - 1, u.y / TILE * sy - 1, 3, 3);
    }
    for (const u of w.myWorkers.values()) {
      g.fillStyle = '#fff';
      g.fillRect(u.x / TILE * sx - 1, u.y / TILE * sy - 1, 3, 3);
    }
    g.strokeStyle = 'rgba(255,255,255,.8)';
    g.strokeRect(
      (this.cam.x - this.cam.viewW / 2) / TILE * sx, (this.cam.y - this.cam.viewH / 2) / TILE * sy,
      this.cam.viewW / TILE * sx, this.cam.viewH / TILE * sy);
  }

  minimapImage() {
    const img = this.miniBase.getContext('2d').createImageData(MAP_W, MAP_H);
    const d = img.data, t = this.world.terrain;
    for (let i = 0; i < t.length; i++) {
      const c = TERRAIN_MINI[t[i]];
      const n = parseInt(c.slice(1), 16);
      d[i * 4] = (n >> 16) & 255; d[i * 4 + 1] = (n >> 8) & 255; d[i * 4 + 2] = n & 255; d[i * 4 + 3] = 255;
    }
    return img;
  }

  statsPerMinute(myPid) {
    const hist = this.world.stockHistory;
    const out = {};
    const oldest = hist.length > 1 ? hist[Math.max(0, hist.length - 120)] : null;
    const now = hist.length > 1 ? hist[hist.length - 1] : null;
    for (const r of RES_NAMES) {
      const o = oldest?.stocks[myPid]?.[r] ?? 0;
      const n = now?.stocks[myPid]?.[r] ?? 0;
      const mins = (now && oldest && oldest.t !== now.t) ? (now.t - oldest.t) / 60000 : 0;
      out[r] = mins > 0 ? Math.round((n - o) / mins) : 0;
    }
    const byRes = { wood: 0, stone: 0, gold: 0, food: 0, none: 0 };
    for (const w of this.world.myWorkers.values()) {
      const t = this.world.nodeTypes?.[w.nodeId];
      if (w.state === 'workFactory') { byRes.none++; continue; }
      if (w.state === 'idle' || !w.nodeId) byRes.none++;
      else if (t === 'tree') byRes.wood++;
      else if (t === 'stone') byRes.stone++;
      else if (t === 'gold') byRes.gold++;
      else if (t === 'berry') byRes.food++;
    }
    return { rates: out, byRes };
  }

  renderStats(myPid) {
    const { rates, byRes } = this.statsPerMinute(myPid);
    const s = this.world.stockFor(myPid) ?? {};
    const pop = this.world.myPop();
    const cap = this.world.myStorage();
    this.el.statsBody.innerHTML = `<table>
      <tr><th>المورد</th><th>الرصيد</th><th>إنتاج/دقيقة</th><th>عمال</th></tr>
      ${RES_NAMES.map(r =>
        `<tr><td>${RES_ICON[r]} ${RES_AR[r]}</td><td>${Math.floor(s[r] ?? 0)}</td><td>+${rates[r]}</td><td>${byRes[r] ?? 0}</td></tr>`
      ).join('')}
      <tr><td>👷 خاملون</td><td>—</td><td>—</td><td>${byRes.none}</td></tr>
      <tr><td>👥 سكان</td><td colspan="3">${pop.units}/${pop.cap}</td></tr>
      <tr><td>🏬 سعة التخزين</td><td colspan="3">${cap}</td></tr>
    </table>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
