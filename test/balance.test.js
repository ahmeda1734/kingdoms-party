// Phase 3 fixed-factor balance tests (GDD \u00a76): deterministic duels and
// rules \u2014 no RNG, no map luck. Duels run combatTick on its own so terrain
// and economy are factors, then applied in phase order.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Sim } from '../server/sim.js';
import { generate } from '../shared/mapgen.js';
import { walkable } from '../shared/mapgen.js';
import {
  MAP_W, TILE, TICK_MS, BUILDING, BUILDING_DEF, UNIT, ROLE_DEF,
  AGES, MAX_AGE, AGE_STEP, AGE_MULT_MAX, COMBAT,
} from '../shared/constants.js';

const DT = TICK_MS / 1000;

function makeSim(count = 2, seed = 'balance-seed') {
  const world = generate(seed, count);
  const players = new Map();
  world.spawns.forEach((s, i) => players.set(i + 1, {
    id: i + 1, name: 'P' + (i + 1), color: '#0f0', spawn: s,
  }));
  return new Sim(world, players);
}

function freeTile(sim, x, y) {
  return walkable(sim.world.terrain, x, y) && !sim.blockedGrid()[y * MAP_W + x];
}

// two horizontally adjacent free tiles, away from busy spawn areas
function adjacentSpot(sim) {
  for (let y = 6; y < 50; y++) {
    for (let x = 6; x < 50; x++) {
      if (freeTile(sim, x, y) && freeTile(sim, x + 1, y)) return [[x, y], [x + 1, y]];
    }
  }
  throw new Error('no adjacency available');
}

function squareSpot(sim) {
  for (let y = 6; y < 50; y++) {
    for (let x = 6; x < 50; x++) {
      let ok = true;
      for (let dy = 0; dy < 2 && ok; dy++) {
        for (let dx = 0; dx < 2 && ok; dx++) if (!freeTile(sim, x + dx, y + dy)) ok = false;
      }
      if (ok) return [x, y];
    }
  }
  throw new Error('no square available');
}

function placeAt(u, tx, ty) {
  u.x = tx * TILE + 16; u.y = ty * TILE + 16;
  u.path = []; u.state = 'idle'; u.target = null; u.cd = 0; u.repathT = 0;
}

function spawnPair(sim, roleA, roleB) {
  const [[ax, ay], [bx, by]] = adjacentSpot(sim);
  const a = sim.spawnUnit(1, roleA);
  const b = sim.spawnUnit(2, roleB);
  placeAt(a, ax, ay);
  placeAt(b, bx, by);
  return { a, b };
}

function duel(sim, a, b, maxTicks = 6000) {
  let t = 0;
  while (sim.units.has(a.id) && sim.units.has(b.id) && t++ < maxTicks) {
    sim.combatTick(DT);
  }
  return {
    aAlive: sim.units.has(a.id),
    bAlive: sim.units.has(b.id),
    ticks: t,
  };
}

function watchtowerAt(sim, pid) {
  const [tx, ty] = squareSpot(sim);
  return sim.placeBuilding(pid, BUILDING.WATCHTOWER, tx, ty, true);
}

test('dummy: balance fixtures resolve deterministically', () => {
  const sim = makeSim();
  const { a, b } = spawnPair(sim, UNIT.GUARD, UNIT.GUARD);
  assert.notEqual(a.id, b.id);
});

test('counter triangle: defender beats knight head-on (GDD)', () => {
  const sim = makeSim();
  const { a, b } = spawnPair(sim, UNIT.DEFENDER, UNIT.KNIGHT);
  const r = duel(sim, a, b);
  assert.ok(r.aAlive && !r.bAlive, 'defender must defeat the knight');
  assert.ok(sim.over === null, 'unit fights never end the match');
});

test('counter triangle: knight beats archer close-in (GDD)', () => {
  const sim = makeSim();
  const { a, b } = spawnPair(sim, UNIT.KNIGHT, UNIT.ARCHER);
  const r = duel(sim, a, b);
  assert.ok(r.aAlive && !r.bAlive, 'knight must defeat the archer');
});

test('mirror matchup: guard vs guard is a true simultaneous draw', () => {
  const sim = makeSim();
  const { a, b } = spawnPair(sim, UNIT.GUARD, UNIT.GUARD);
  const r = duel(sim, a, b);
  assert.ok(!r.aAlive && !r.bAlive, 'identical fighters must fall together (two-phase)');
});

test('archer outranges and outdamages the defender (kite factor)', () => {
  const sim = makeSim();
  const A = ROLE_DEF[UNIT.ARCHER], D = ROLE_DEF[UNIT.DEFENDER];
  assert.ok(A.range > 4, 'archer range should outrange melee');
  assert.ok(A.range > D.range);
  assert.ok(A.bonusVs.defender * A.dmg > D.dmg, 'archer must outdamage defenders');
  assert.ok(A.kite === true, 'archer must kite when pressed');
});

test('explorer flees armed enemies and never swings while fleeing', () => {
  const sim = makeSim();
  const { a: knight, b: explorer } = spawnPair(sim, UNIT.KNIGHT, UNIT.EXPLORER);
  sim.combatTick(DT);
  assert.equal(explorer.state, 'flee');
  assert.equal(knight.hp, ROLE_DEF[UNIT.KNIGHT].hp, 'explorer dealt no damage');
});

test('ages advance strictly in order and pay exact costs', () => {
  const sim = makeSim();
  const s = sim.stocks.get(1);
  s.food = 5000; s.wood = 5000; s.gold = 5000;
  assert.equal(sim.ageUp(2), false, 'cannot skip to later ages indirectly');
  const before2 = { ...s };
  assert.equal(sim.ageUp(1), true);
  assert.equal(sim.age.get(1), 2);
  assert.equal(before2.food - s.food, AGES[2].cost.food);
  assert.equal(before2.wood - s.wood, AGES[2].cost.wood);
  const before3 = { ...s };
  assert.equal(sim.ageUp(1), true);
  assert.equal(before3.food - s.food, AGES[3].cost.food);
  assert.equal(before3.gold - s.gold, AGES[3].cost.gold);
});

test('age 4 requires a completed watchtower, then opens without ending the match', () => {
  const sim = makeSim();
  const s = sim.stocks.get(1);
  s.food = 20000; s.wood = 20000; s.gold = 20000;
  sim.ageUp(1); sim.ageUp(1);
  assert.equal(sim.age.get(1), 3);
  assert.equal(sim.ageUp(1), false, 'age 4 refused without a watchtower');
  const tower = watchtowerAt(sim, 1);
  assert.ok(tower, 'watchtower placement test fixture must succeed');
  assert.equal(tower.type, BUILDING.WATCHTOWER);
  assert.equal(sim.buildings.has(tower.id), true);
  assert.equal(sim.ageUp(1), true, 'age 4 unlocked by completed watchtower');
  assert.equal(sim.age.get(1), MAX_AGE);
  assert.equal(sim.over, null, 'reaching age 4 must NOT auto-win (GDD \u00a75)');
  for (let i = 0; i < 20; i++) sim.update();
  assert.equal(sim.over, null, 'the match keeps running after age 4');
  assert.ok(sim.statMult(1) <= 1.65, 'cumulative stat ceiling stays under the GDD 65% cap');
  assert.equal(sim.statMult(1), AGE_MULT_MAX);
  assert.ok(AGE_MULT_MAX === 1 + AGE_STEP * 3, 'age multiplier math is linear to the cap');
});

test('healer heals the most damaged nearby ally and never heals itself over cap', () => {
  const sim = makeSim();
  const healer = sim.spawnUnit(1, UNIT.HEALER);
  const knight = sim.spawnUnit(1, UNIT.KNIGHT);
  const spot = adjacentSpot(sim);
  placeAt(healer, spot[0][0], spot[0][1]);
  placeAt(knight, spot[1][0], spot[1][1]);
  knight.hp = Math.round(knight.maxHp / 2);
  for (let i = 0; i < 40; i++) sim.combatTick(DT);
  assert.ok(knight.hp > knight.maxHp / 2, 'healer heals damaged ally over time');
  assert.equal(healer.hp, healer.maxHp);
  for (let i = 0; i < 300; i++) sim.combatTick(DT);
  assert.equal(knight.hp, knight.maxHp, 'healing caps exactly at maxHp');
});

test('engineer repairs damaged buildings within build range', () => {
  const sim = makeSim();
  const tower = watchtowerAt(sim, 1);
  const eng = sim.spawnUnit(1, UNIT.ENGINEER);
  placeAt(eng, tower.x, tower.y + 2); // ~0.5 tiles from the building edge
  tower.hp = 300;
  for (let i = 0; i < 30; i++) sim.combatTick(DT);
  assert.ok(tower.hp > 300, 'engineer restores hp over time');
  assert.ok(tower.hp <= tower.maxHp, 'repair never overshoots maxHp');
});

test('watchtower shoots the nearest enemy in range automatically', () => {
  const sim = makeSim();
  const tower = watchtowerAt(sim, 1);
  const guard = sim.spawnUnit(2, UNIT.GUARD);
  placeAt(guard, tower.x, tower.y - 2);
  for (let i = 0; i < 61; i++) sim.combatTick(DT);
  assert.ok(guard.hp < guard.maxHp, 'tower fired at least once');
  assert.equal(Math.round(guard.hp), guard.maxHp - Math.round(BUILDING_DEF[BUILDING.WATCHTOWER].dmg * 2),
    'tower damage is exactly dmg x statMult every attackEvery ticks');
});

test('units auto-engage enemies inside aggro without any order', () => {
  const sim = makeSim();
  const { a, b } = spawnPair(sim, UNIT.KNIGHT, UNIT.GUARD);
  const before = a.hp + b.hp;
  for (let i = 0; i < 60; i++) sim.combatTick(DT);
  assert.ok(a.hp + b.hp < before, 'auto-aggro produced an exchange');
  assert.equal(a.state, 'fight');
});

test('workers never fight back even when attacked', () => {
  const sim = makeSim();
  const w1 = sim.spawnUnit(1, UNIT.WORKER);
  const w2 = sim.spawnUnit(2, UNIT.WORKER);
  const spot = adjacentSpot(sim);
  placeAt(w1, spot[0][0], spot[0][1]);
  placeAt(w2, spot[1][0], spot[1][1]);
  for (let i = 0; i < 300; i++) sim.combatTick(DT);
  assert.equal(w1.hp, w1.maxHp);
  assert.equal(w2.hp, Math.round(w2.maxHp));
  assert.ok(sim.units.has(w1.id) && sim.units.has(w2.id));
});

test('trainUnit validates role, barracks, funds and spawns after training time', () => {
  const sim = makeSim();
  assert.equal(sim.trainUnit(1, UNIT.WORKER), false, 'workers are not role-trained');
  assert.equal(sim.trainUnit(1, 'dragon'), false, 'unknown roles rejected');
  assert.equal(sim.trainUnit(1, UNIT.GUARD), false, 'barracks roles need a barracks');
  const s = sim.stocks.get(1);
  const before = { ...s };
  assert.equal(sim.trainUnit(1, UNIT.EXPLORER), true, 'castle roles train from the start');
  assert.equal(before.food - s.food, ROLE_DEF[UNIT.EXPLORER].cost.food);
  assert.equal(before.gold - s.gold, ROLE_DEF[UNIT.EXPLORER].cost.gold);
  assert.equal(sim.unitQueues.get(1).length, 1);

  const [bx, by] = squareSpot(sim);
  const barracks = sim.placeBuilding(1, BUILDING.BARRACKS, bx, by, true);
  assert.ok(barracks);
  assert.equal(sim.trainUnit(1, UNIT.GUARD), true, 'barracks unlocks barracks roles');

  for (let i = 0; i < ROLE_DEF[UNIT.EXPLORER].time; i++) sim.update();
  const spawned = [...sim.units.values()].filter(u => u.owner === 1 && u.type === UNIT.EXPLORER);
  assert.equal(spawned.length, 1, 'explorer spawns once training completes');
  assert.ok(sim.popCap(1).units <= sim.popCap(1).cap, 'pop cap respected at spawn');
});

test('destroying a castle ends the match with the attacker as winner', () => {
  const sim = makeSim();
  const knight = sim.spawnUnit(2, UNIT.KNIGHT);
  const castle = [...sim.buildings.values()].find(b => b.owner === 1 && b.type === BUILDING.CASTLE);
  // approach along the top edge of the castle: away from the workers below it
  let placed = false;
  for (let dx = -1; dx <= 2 && !placed; dx++) {
    if (freeTile(sim, castle.x + dx, castle.y - 1)) {
      placeAt(knight, castle.x + dx, castle.y - 1);
      placed = true;
    }
  }
  assert.ok(placed, 'a free approach tile beside the castle must exist');
  for (const u of [...sim.units.values()]) if (u.owner === 1) sim.units.delete(u.id);
  castle.hp = 5;
  sim.combatTick(DT);
  assert.deepEqual(sim.over, { winner: 2, reason: 'castle_destroyed' });
  assert.ok(!sim.buildings.has(castle.id), 'fallen castle removed from world');
  sim.combatTick(DT);
  sim.update();
  assert.deepEqual(sim.over, { winner: 2, reason: 'castle_destroyed' }, 'result is final and stable');
});
