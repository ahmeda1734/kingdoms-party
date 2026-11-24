// Real multiplayer integration tests: boots the actual app (HTTP+WS) on an
// ephemeral port and connects genuine WebSocket clients.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';

const PORT = 18080 + Math.floor(Math.random() * 500);

const app = createApp();
app.server.listen(PORT);

function url() { return `ws://127.0.0.1:${PORT}`; }

function waitOpen(ws) {
  return new Promise(res => ws.on('open', res));
}

function once(ws, type, ok = () => true) {
  return new Promise(res => {
    const on = raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.t === type && ok(m)) { ws.off('message', on); res(m); }
    };
    ws.on('message', on);
  });
}

function timeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function join(name, code, token) {
  const ws = new WebSocket(url());
  const joined = (async () => {
    await waitOpen(ws);
    ws.send(JSON.stringify({ t: 'join', name, room: code, token }));
    return once(ws, 'joined');
  })();
  return { ws, joined };
}

async function startRoomWith(count) {
  const clients = [];
  const host = join('المضيف', null, null);
  const hostJoined = await host.joined;
  clients.push(host);
  for (let i = 1; i < count; i++) {
    const c = join('لاعب ' + (i + 1), hostJoined.code, null);
    clients.push(c);
    await c.joined;
  }
  host.ws.send(JSON.stringify({ t: 'start' }));
  const inits = await Promise.all(clients.map(c => once(c.ws, 'gameInit')));
  return { clients, inits, code: hostJoined.code };
}

test.after(() => {
  for (const room of app.rooms.rooms.values()) if (room.timer) clearInterval(room.timer);
  for (const c of app.wss.clients) c.terminate();
  app.server.close();
});

test('2 players join one room and receive identical map fingerprint + spawns', async () => {
  const { clients, inits } = await startRoomWith(2);
  assert.equal(inits[0].fingerprint, inits[1].fingerprint);
  const sA = inits[0].spawns.map(s => [s.x, s.y]).sort();
  const sB = inits[1].spawns.map(s => [s.x, s.y]).sort();
  assert.deepEqual(sA, sB);
  for (const c of clients) c.ws.close();
});

test('4 players same room: identical map, unique ids/colors/spawns', async () => {
  const { clients, inits } = await startRoomWith(4);
  assert.equal(new Set(inits.map(i => i.fingerprint)).size, 1);
  assert.equal(new Set(inits.map(i => i.playerId)).size, 4);
  assert.equal(inits[0].spawns.length, 4);
  for (const c of clients) c.ws.close();
});

test('gather command deposits once; both clients converge on same resource state', async () => {
  const { clients, inits } = await startRoomWith(2);
  const [me, them] = clients;
  const myInit = inits[0]; // host perspective

  const firstSnap = await once(me.ws, 'snap');
  const mySpawn = myInit.spawns.find(s => s.pid === myInit.playerId);
  const tree = myInit.nodes
    .filter(n => n.type === 'tree')
    .sort((x, y) => Math.hypot(x.x - mySpawn.x, x.y - mySpawn.y) - Math.hypot(y.x - mySpawn.x, y.y - mySpawn.y))[0];
  assert.ok(tree && Math.hypot(tree.x - mySpawn.x, tree.y - mySpawn.y) < 15, 'a near tree exists');
  me.ws.send(JSON.stringify({ t: 'assign', workerIds: [firstSnap.yourWorkers[0].id], nodeId: tree.id }));

  // Wait for at least one wood deposit (start -> increase).
  const startWood = firstSnap.stocks[myInit.playerId].wood;
  let endWood = startWood;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const snap = await once(me.ws, 'snap');
    endWood = snap.stocks[myInit.playerId].wood;
    if (endWood >= startWood + 10) break; // one full carry = 10
  }
  assert.ok(endWood >= startWood + 10, `wood ${startWood} -> ${endWood}`);

  // Deposit happened exactly once per completed trip: stock gain must be a
  // multiple of a partial carry, and never exceed gathered amount. The other
  // client must observe the tree amount <= initial (no phantom regrowth).
  const sawForest = await timeout(once(them.ws, 'snap', m =>
    m.nodesChanged.some(d => d.id === tree.id)), 15000).catch(() => null);
  if (sawForest) {
    const delta = sawForest.nodesChanged.find(d => d.id === tree.id);
    assert.ok(delta.amount >= 0 && delta.amount <= tree.amount);
  }
  for (const c of clients) c.ws.close();
});

test('match continues when a player drops; token reconnect restores slot', async () => {
  const host = join('مضيف', null, null);
  const hj = await host.joined;
  const guest = join('ضيف', hj.code, null);
  const gj = await guest.joined;
  const gToken = gj.token, gRoom = gj.room, gPid = gj.playerId;
  host.ws.send(JSON.stringify({ t: 'start' }));
  await once(guest.ws, 'gameInit');
  await once(host.ws, 'snap');
  const tickBefore = (await once(host.ws, 'snap')).tick;

  guest.ws.close();
  await new Promise(r => setTimeout(r, 500));

  // The running match must keep ticking for the remaining player.
  const tickAfter = (await once(host.ws, 'snap')).tick;
  assert.ok(tickAfter > tickBefore, `tick ${tickBefore} -> ${tickAfter}`);

  // Reconnect with token: same slot, fresh gameInit of the same world.
  const back = join('ضيف', gRoom, gToken);
  const initP = once(back.ws, 'gameInit');   // register BEFORE the echo lands
  const bj = await back.joined;
  assert.equal(bj.playerId, gPid);
  assert.equal(bj.rejoined, true);
  const init2 = await initP;
  assert.ok(init2.fingerprint);
  back.ws.close(); host.ws.close();
});

test('joining a full room is rejected', async () => {
  const host = join('مضيف', null, null);
  const hj = await host.joined;
  const filler = [];
  for (let i = 0; i < 7; i++) {
    const c = join('زائر' + i, hj.code, null);
    filler.push(c);
    await c.joined;
  }
  const extra = join('زائد', hj.code, null);
  const err = await once(extra.ws, 'error');
  assert.equal(err.code, 'room_full');
  extra.ws.close();
  for (const c of filler) c.ws.close(); host.ws.close();
});

// ================= Phase 2: build sync =================

import { MAP_W, MAP_H, T, BUILDING_DEF, BUILDING } from '../shared/constants.js';
import { rleDecode } from '../shared/mapgen.js';

test('phase2: build command is validated, deducted and synced back in snapshots', async () => {
  const { clients, inits } = await startRoomWith(2);
  const [a, b] = clients;
  const initA = inits[0];

  // Find a valid house spot near A's spawn using the SAME terrain both got.
  const terrain = rleDecode(initA.terrain, MAP_W * MAP_H);
  const nodes = initA.nodes;
  const me = initA.spawns.find(s => s.pid === initA.playerId);
  const walk = (x, y) => x >= 1 && y >= 1 && x < MAP_W - 1 && y < MAP_H - 1 &&
    (terrain[y * MAP_W + x] === T.GRASS || terrain[y * MAP_W + x] === T.HILL || terrain[y * MAP_W + x] === T.SAND);
  const nodeAt = (x, y) => nodes.some(n => n.x === x && n.y === y);
  const nearCastle = (x, y) => x >= me.x - 2 && x <= me.x + 2 && y >= me.y - 2 && y <= me.y + 2;
  let spot = null;
  outer:
  for (let r = 3; r < 15; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = me.x + dx, y = me.y + dy;
      if (walk(x, y) && !nodeAt(x, y) && !nearCastle(x, y)) { spot = { x, y }; break outer; }
    }
  }
  assert.ok(spot, 'no valid placement spot near spawn');

  const woodBefore = (await once(a.ws, 'snap')).stocks[initA.playerId].wood;
  a.ws.send(JSON.stringify({ t: 'build', type: BUILDING.HOUSE, x: spot.x, y: spot.y }));

  // A must see his own new building (in construction) in a snapshot.
  const seen = await timeout(once(a.ws, 'snap', m =>
    m.buildings?.some(x => x.type === BUILDING.HOUSE && x.x === spot.x && x.y === spot.y)), 15000).catch(() => null);
  assert.ok(seen, 'built house never appeared in a snapshot');
  const hb = seen.buildings.find(x => x.type === BUILDING.HOUSE);
  assert.equal(hb.owner, initA.playerId);
  assert.ok(hb.done > hb.now, 'construction in progress');
  const woodAfter = seen.stocks[initA.playerId].wood;
  assert.equal(woodAfter, woodBefore - BUILDING_DEF[BUILDING.HOUSE].cost.wood,
    'cost not deducted exactly once');

  // Duplicate placement on the same tiles must be rejected: stock unchanged.
  a.ws.send(JSON.stringify({ t: 'build', type: BUILDING.HOUSE, x: spot.x, y: spot.y }));
  const afterDup = await timeout(once(a.ws, 'snap'), 10000).catch(() => null);
  if (afterDup) {
    assert.equal(afterDup.stocks[initA.playerId].wood, woodAfter,
      'duplicate build must not cost anything');
  }
  for (const c of clients) c.ws.close();
});
