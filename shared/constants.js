// KINGDOMS PARTY - shared constants used by server and client.

export const MAP_W = 96;
export const MAP_H = 96;
export const TILE = 32; // world px per tile

export const TICK_MS = 66; // simulation tick ~15Hz
export const SNAPSHOT_EVERY_TICKS = 2; // world diff every ~7.5Hz, client interpolates
export const RECONNECT_GRACE_MS = 60_000; // player slot kept open after drop

// Terrain tile codes.
export const T = {
  GRASS: 0,
  WATER: 1,
  SAND: 2,
  HILL: 3,
  MOUNTAIN: 4,
};

// Resource node types (harvested from the map).
export const NODE = {
  TREE: 'tree',    // wood
  STONE: 'stone',  // stone
  GOLD: 'gold',    // gold
  BERRY: 'berry',  // food
};

export const RES = {
  wood: 0,
  stone: 1,
  gold: 2,
  food: 3,
  bricks: 4,
};
export const RES_NAMES = ['wood', 'stone', 'gold', 'food', 'bricks'];

export const NODE_DEF = {
  tree:  { res: 'wood',  amount: 140 },
  stone: { res: 'stone', amount: 220 },
  gold:  { res: 'gold',  amount: 380 },
  berry: { res: 'food',  amount: 160 },
};

export const MOUNTAIN_NODE = { res: 'stone', amount: 320 }; // rocks inside mountains (Phase 2: mines)

// Units (Phase 1: workers only; Phase 3 adds combat roles).
export const UNIT = {
  WORKER: 'worker',
  GUARD: 'guard',
  DEFENDER: 'defender',
  EXPLORER: 'explorer',
  ARCHER: 'archer',
  KNIGHT: 'knight',
  ENGINEER: 'engineer',
  HEALER: 'healer',
};

export const WORKER = {
  speed: 110,          // world px / second
  gatherPerTick: 0.22, // resources per tick (~3.3/s)
  carryCap: 10,
  visionRadius: 7,     // tiles
  hp: 60,              // workers can be raided but never fight back
};

// Phase 3: unit roles. Every role has a niche (GDD balance rules):
// guard = balanced, defender = tank that beats knights, explorer = fastest
// scouting + widest vision, archer = outranges slow melee (beats defenders),
// knight = maneuver flanking unit that beats archers/explorers,
// engineer = builds/repairs under fire, healer = support aura.
// bonusVs multiplies damage against the listed role (counter triangle).
export const ROLE_DEF = {
  [UNIT.GUARD]: {
    name: 'الحارس', icon: '🛡️', from: 'barracks',
    cost: { food: 40, gold: 10 }, time: 120,
    hp: 130, speed: 110, dmg: 8, range: 0.9, attackEvery: 30, vision: 8,
    bonusVs: {},
  },
  [UNIT.DEFENDER]: {
    name: 'الحامي', icon: '🧱', from: 'barracks',
    cost: { food: 50, wood: 30 }, time: 150,
    hp: 280, speed: 80, dmg: 6, range: 0.9, attackEvery: 30, vision: 7,
    bonusVs: { knight: 2.5 },
  },
  [UNIT.EXPLORER]: {
    name: 'المستكشف', icon: '🧭', from: 'castle',
    cost: { food: 30, gold: 10 }, time: 90,
    hp: 90, speed: 155, dmg: 4, range: 0.9, attackEvery: 30, vision: 13,
    bonusVs: {}, flee: true,
  },
  [UNIT.ARCHER]: {
    name: 'الرامي', icon: '🏹', from: 'barracks',
    cost: { food: 40, wood: 30, gold: 25 }, time: 150,
    hp: 100, speed: 100, dmg: 7, range: 5, attackEvery: 30, vision: 8,
    bonusVs: { defender: 1.5 }, kite: true,
  },
  [UNIT.KNIGHT]: {
    name: 'الفارس', icon: '🐎', from: 'barracks',
    cost: { food: 60, wood: 20, gold: 70 }, time: 210,
    hp: 210, speed: 140, dmg: 14, range: 0.9, attackEvery: 30, vision: 8,
    bonusVs: { explorer: 2.2, archer: 2.2 },
  },
  [UNIT.ENGINEER]: {
    name: 'المهندس', icon: '🔧', from: 'castle',
    cost: { food: 40, gold: 20 }, time: 150,
    hp: 90, speed: 100, dmg: 0, range: 0, attackEvery: 0, vision: 7,
    bonusVs: {}, repairPerSec: 6, buildRange: 1.5,
  },
  [UNIT.HEALER]: {
    name: 'المعالج', icon: '💚', from: 'castle',
    cost: { food: 50, gold: 40 }, time: 180,
    hp: 90, speed: 105, dmg: 0, range: 0, attackEvery: 0, vision: 7,
    bonusVs: {}, healPerSec: 6, healRadius: 4,
  },
};

export const TRAINABLE_ROLES = [
  UNIT.EXPLORER, UNIT.ENGINEER, UNIT.HEALER,
  UNIT.GUARD, UNIT.DEFENDER, UNIT.ARCHER, UNIT.KNIGHT,
];

// ---------- Phase 3: ages ----------

export const AGES = {
  1: { name: 'عصر القرية', icon: '☀️', cost: null },
  2: { name: 'عصر المملكة', icon: '🏰', cost: { food: 800, wood: 600 } },
  3: { name: 'عصر الازدهار', icon: '💎', cost: { food: 1200, gold: 1000 } },
  4: { name: 'عصر الحضارة', icon: '👑', cost: { food: 2000, gold: 1500, building: 'watchtower' } },
};
export const MAX_AGE = 4;
// +15% hp/dmg per age for MILITARY units, hard-capped below the 65% balance
// ceiling from the GDD (العصر 4 يفتح خيارات فقط — لا عمالقة).
export const AGE_STEP = 0.15;
export const AGE_MULT_MAX = 1.45;

// Phase 3: combat tuning (cartoon fights, deterministic on server ticks).
export const COMBAT = {
  aggroRadius: 6,        // tiles: military auto-engages enemies within
  buildingDmgMult: 0.6,  // units damage buildings at reduced rate
  chaseRepathEvery: 15,  // ticks between pursuit path recomputes
  fleeRadius: 4,         // tiles: explorers break off when enemies close
  kiteRadius: 2,         // tiles: archers step back when pressed
};

// Buildings (Phase 2). size is in tiles (w == h). buildTime in ticks.
// A building only WORKS once construction completes.
export const BUILDING = {
  CASTLE: 'castle',           // preplaced; depot + train + base caps
  HOUSE: 'house',
  WAREHOUSE: 'warehouse',
  FARM: 'farm',
  LUMBERMILL: 'lumbermill',   // +25% wood gather for trees within radius
  QUARRY: 'quarry',           // +25% stone
  GOLDMINE_B: 'goldmineBuilding',
  BRICKFACTORY: 'brickfactory',
  BARRACKS: 'barracks',       // Phase 3: trains combat units
  WATCHTOWER: 'watchtower',   // Phase 3: vision + defense, required for age 4
};

export const BUILDING_DEF = {
  [BUILDING.CASTLE]: {
    name: 'القلعة', size: 2, cost: {}, buildTime: 0,
    popCap: 10, storage: 500, depot: true, auraRadius: 0, hp: 1200,
  },
  [BUILDING.HOUSE]: {
    name: 'بيت سكان', size: 1, cost: { wood: 60 }, buildTime: 75, // 5s
    popCap: 4, storage: 0, auraRadius: 0, hp: 260,
  },
  [BUILDING.WAREHOUSE]: {
    name: 'المخزن', size: 2, cost: { wood: 120, stone: 40 }, buildTime: 225, // 15s
    popCap: 0, storage: 250, depot: true, auraRadius: 0, hp: 420,
  },
  [BUILDING.FARM]: {
    name: 'المزرعة', size: 2, cost: { wood: 45 }, buildTime: 150, // 10s
    popCap: 0, storage: 0, foodPerTick: 0.30, auraRadius: 0, hp: 260,
  },
  [BUILDING.LUMBERMILL]: {
    name: 'منشرة الخشب', size: 2, cost: { wood: 100, stone: 30 }, buildTime: 300, // 20s
    popCap: 0, storage: 0, auraRadius: 6, auraNode: 'tree', auraMult: 1.25, hp: 380,
  },
  [BUILDING.QUARRY]: {
    name: 'المحجر', size: 2, cost: { wood: 90, stone: 50 }, buildTime: 300,
    popCap: 0, storage: 0, auraRadius: 6, auraNode: 'stone', auraMult: 1.25, hp: 380,
  },
  [BUILDING.GOLDMINE_B]: {
    name: 'منجم الذهب', size: 2, cost: { wood: 110, stone: 60 }, buildTime: 300,
    popCap: 0, storage: 0, auraRadius: 6, auraNode: 'gold', auraMult: 1.25, hp: 380,
  },
  [BUILDING.BRICKFACTORY]: {
    name: 'معمل الطابوق', size: 2, cost: { wood: 120, stone: 80 }, buildTime: 375, // 25s
    popCap: 0, storage: 0, auraRadius: 0,
    // worker assigned here makes bricks at bricksPerTick while consuming
    // stonePerBrick stone from the kingdom stock.
    bricksPerTick: 0.22, stonePerBrick: 0.1, boostRes: null, hp: 450,
  },
  [BUILDING.BARRACKS]: {
    name: 'الثكنة', size: 2, cost: { wood: 150, stone: 50 }, buildTime: 300, // 20s
    popCap: 0, storage: 0, auraRadius: 0, hp: 500,
  },
  [BUILDING.WATCHTOWER]: {
    name: 'برج المراقبة', size: 2, cost: { wood: 100, stone: 80 }, buildTime: 300,
    popCap: 0, storage: 0, auraRadius: 0,
    // shoots arrows at enemies in range; widest vision on the map.
    hp: 420, dmg: 9, range: 6, attackEvery: 30, vision: 12,
  },
};

export const TRAIN_WORKER = {
  cost: { food: 50 },
  time: 150, // ticks = 10s
};

// Starting stockpile for every kingdom.
export const START_RESOURCES = { wood: 200, stone: 120, gold: 80, food: 150, bricks: 0 };
export const START_WORKERS = 5;

// Camera / zoom limits for the client.
export const MIN_ZOOM = 0.45;
export const MAX_ZOOM = 2.2;

export const PLAYER_COLORS = [
  '#2f7de1', '#e63b3b', '#38b24a', '#f2b627',
  '#9b51e0', '#13b8a6', '#f472b6', '#f97316',
];

export const MAX_PLAYERS = 8;
export const MIN_PLAYERS = 2;
