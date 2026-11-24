// KINGDOMS PARTY client entry: lobby flow, connection, game bootstrap, loop.

import { Net } from './net.js';
import { World } from './world.js';
import { Camera } from './camera.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { S2C, C2S } from '../../shared/protocol.js';
import { MAP_W, TILE, TRAIN_WORKER } from '../../shared/constants.js';

const $ = id => document.getElementById(id);
const lobby = $('lobby');
const roomScreen = $('room-screen');
const gameCanvas = $('game');

const world = new World();
const cam = new Camera(gameCanvas);
const renderer = new Renderer(gameCanvas, world, cam);
const ui = new UI(world, cam);
let net = null;
let myName = sessionStorage.getItem('kp.name') || '';
let myPid = null;
let myToken = sessionStorage.getItem('kp.token');
let roomCode = sessionStorage.getItem('kp.room');
let isHost = false;
let beat = 0;
let roomPlayers = [];

// ---------- lobby ----------
$('player-name').value = myName;

$('btn-create').addEventListener('click', () => tryJoin(null));
$('btn-join').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (code) tryJoin(code);
});
$('btn-howto').addEventListener('click', () => $('howto-modal').classList.remove('hidden'));
$('btn-close-howto').addEventListener('click', () => $('howto-modal').classList.add('hidden'));

// deep link /room/CODE
const pathRoom = location.pathname.match(/room\/([A-Z2-9]+)/i);
if (pathRoom && !sessionStorage.getItem('kp.autojoin.' + pathRoom[1])) {
  sessionStorage.setItem('kp.autojoin.' + pathRoom[1], '1');
  roomCode = pathRoom[1].toUpperCase();
  tryJoin(roomCode);
}

function showError(msg) {
  const el = $('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function tryJoin(joinCode) {
  myName = $('player-name').value.trim() || 'مملكة ' + (Math.floor(Math.random() * 999) + 1);
  sessionStorage.setItem('kp.name', myName);
  if (joinCode) { roomCode = joinCode; sessionStorage.setItem('kp.room', joinCode); }
  if (!net) {
    net = new Net({ onMessage, onClose });
    net.connect();
  } else if (net.ws.readyState === 1) {
    net.send({ t: C2S.JOIN, name: myName, room: roomCode, token: myToken });
  } else {
    const wait = setInterval(() => {
      clearInterval(wait);
      net?.ws.readyState === 1 && net.send({ t: C2S.JOIN, name: myName, room: roomCode, token: myToken });
    }, 250);
  }
}

// ---------- networking flow ----------
let reconnectTimer = null;

function onClose() {
  if (world.ready) {
    $('connection-banner').classList.remove('hidden');
    reconnectTimer = setTimeout(() => net.connect(), 1200);
  } else {
    reconnectTimer = setTimeout(() => net.connect(), 1200);
  }
}

function onMessage(m) {
  switch (m.t) {
    case S2C.JOINED: {
      myPid = m.playerId;
      myToken = m.token;
      roomCode = m.room;
      sessionStorage.setItem('kp.token', m.token);
      sessionStorage.setItem('kp.room', m.code);
      $('room-code-display').textContent = m.code;
      lobby.classList.remove('hidden');
      roomScreen.classList.remove('hidden');
      $('lobby-error')?.classList.add('hidden');
      roomPlayers = m.players;
      updateRoomPlayers(m.players);
      break;
    }
    case S2C.ROOM_UPDATE: {
      roomPlayers = m.players;
      updateRoomPlayers(m.players);
      isHost = m.players.some(p => p.pid === myPid && p.host);
      $('btn-start').classList.toggle('hidden', !isHost);
      const me = m.players.find(p => p.pid === myPid);
      $('btn-ready').textContent = me?.ready ? '✅ جاهز' : 'أنا جاهز';
      $('btn-ready').classList.toggle('ready', !!me?.ready);
      break;
    }
    case S2C.GAME_INIT: {
      world.loadGameInit(m);
      // verify identical world reception
      if (m.fingerprint === undefined) break;
      lobby.classList.add('hidden');
      ui.showHud(true);
      if (world.spawn) cam.centerOn(world.spawn.x * TILE + 16, world.spawn.y * TILE + 16);
      ui.updateSelection();
      break;
    }
    case S2C.SNAPSHOT:
      if (world.ready) world.applySnapshot(m);
      break;
    case S2C.CHAT_MSG: {
      const box = $('room-chat');
      const line = document.createElement('div');
      line.innerHTML = `<b>${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}`;
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
      break;
    }
    case S2C.ERROR:
      clearTimeout(reconnectTimer);
      if (!world.ready) showError('⚠️ ' + (m.message ?? m.code));
      break;
  }
}

function updateRoomPlayers(players) {
  const box = $('room-players');
  box.innerHTML = players.map(p => `
    <div class="player-row ${p.connected ? '' : 'off'}">
      <span class="dot" style="background:${p.color}"></span>
      <span>${escapeHtml(p.name)}</span>
      <span class="tag">${p.host ? '👑 المضيف' : ''} ${p.connected ? (p.ready ? 'جاهز ✔' : '') : 'غير متصل'}</span>
    </div>`).join('');
}

$('btn-ready').addEventListener('click', () => net?.send({ t: C2S.READY, ready: !isLoadedReadyFlag() }));
function isLoadedReadyFlag() {
  // toggle is server-authoritative; we just send the inverse of the button state
  return $('btn-ready').classList.contains('ready');
}
$('btn-start').addEventListener('click', () => net?.send({ t: C2S.START }));
$('btn-leave-room').addEventListener('click', () => {
  sessionStorage.removeItem('kp.token');
  location.reload();
});
$('btn-copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(roomCode ?? ''); $('btn-copy-code').textContent = '✔'; } catch {}
  setTimeout(() => ($('btn-copy-code').textContent = '📋 نسخ'), 1200);
});
$('btn-chat-send').addEventListener('click', sendChat);
$('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const v = $('chat-input').value.trim();
  if (v) net?.send({ t: C2S.CHAT, text: v });
  $('chat-input').value = '';
}

// ---------- game HUD wiring ----------
$('btn-stats').addEventListener('click', () => {
  $('stats-panel').classList.toggle('hidden');
  ui.renderStats(myPid);
});
$('btn-close-stats').addEventListener('click', () => $('stats-panel').classList.add('hidden'));
$('btn-sel-all').addEventListener('click', () => {
  world.selection.clear();
  for (const id of world.myWorkers.keys()) world.selection.add(id);
  ui.updateSelection();
});
$('btn-unassign').addEventListener('click', () => {
  if (world.selection.size === 0) return;
  net?.send({ t: 'unassign', workerIds: [...world.selection] });
  world.selection.clear();
  ui.updateSelection();
});
document.querySelectorAll('[data-auto]').forEach(b => {
  b.addEventListener('click', () => {
    net?.send({ t: 'auto', type: b.dataset.auto, count: 99 });
    ui.flashMsg('🎲 وُزّع العمال الخاملون على ' + b.textContent.trim());
  });
});

// ---------- build menu / training wiring ----------
ui.el.btnBuildMenu.addEventListener('click', () => {
  ui.setBuildMenuVisible(ui.el.buildMenu.classList.contains('hidden'));
});
ui.el.btnCancelBuild.addEventListener('click', cancelBuildMode);
ui.el.bpClose.addEventListener('click', () => ui.hideBuildingPanel());
ui.el.bpTrain.addEventListener('click', () => {
  if (!ui.trainButtonState()) return;
  net?.send({ t: C2S.TRAIN_WORKER });
  ui.flashMsg('⏳ جارٍ تدريب عامل جديد…');
});
ui.onBuildSelect = type => {
  world.buildMode = world.buildMode === type ? null : type;
  ui.setBuildModeActive(world.buildMode);
  ui.hideBuildingPanel();
  if (world.buildMode) ui.flashMsg('🏗️ انقر على الأرض لوضع المبنى (ESC للإلغاء)');
};

function cancelBuildMode() {
  world.buildMode = null;
  ui.setBuildModeActive(null);
}

// minimap navigation
ui.el.minimap.addEventListener('pointerdown', e => {
  const r = ui.el.minimap.getBoundingClientRect();
  cam.centerOn((e.clientX - r.left) / r.width * MAP_W * TILE, (e.clientY - r.top) / r.height * MAP_H * TILE);
});

const input = new Input(gameCanvas, cam, world, { send: o => net?.send(o) }, ui);

// ---------- main loop ----------
let lastTime = performance.now();
function frame(now) {
  const dt = Math.min(100, now - lastTime);
  lastTime = now;
  cam.update(dt / 1000);
  renderer.render(now, now);
  if (world.ready && beat % 7 === 0) {
    ui.updateResources(myPid);
    ui.updatePlayers(roomPlayers, myPid);
    updateTrainButton();
  }
  if (world.ready && beat % 15 === 0) {
    ui.drawMinimap();
  }
  if (world.ready && !$('stats-panel').classList.contains('hidden') && beat % 30 === 0) {
    ui.renderStats(myPid);
  }
  beat++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function updateTrainButton() {
  if (!ui.trainButtonState() || ui.el.bp.classList.contains('hidden')) return;
  const s = world.stockFor(myPid) ?? {};
  const pop = world.myPop();
  const busy = !!world.training;
  const canFood = (s.food ?? 0) >= TRAIN_WORKER.cost.food;
  const canPop = pop.units < pop.cap;
  ui.setTrainButton(!busy && canFood && canPop,
    busy ? 'يوجد تدريب جارٌ'
      : !canPop ? 'السكان ممتلئون — ابنِ بيتاً'
      : !canFood ? 'تحتاج ' + TRAIN_WORKER.cost.food + ' طعاماً' : '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// resume an interrupted session right away
if (myToken && roomCode) {
  // reconnect banner appears in-game; lobby auto-join handled on button/deep link only
}
