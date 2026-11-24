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

// Units (Phase 1: workers only; combat roles arrive in Phase 3).
export const UNIT = {
  WORKER: 'worker',
};

export const WORKER = {
  speed: 110,          // world px / second
  gatherPerTick: 0.22, // resources per tick (~3.3/s)
  carryCap: 10,
  visionRadius: 7,     // tiles
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
};

export const BUILDING_DEF = {
  [BUILDING.CASTLE]: {
    name: 'القلعة', size: 2, cost: {}, buildTime: 0,
    popCap: 10, storage: 500, depot: true, auraRadius: 0,
  },
  [BUILDING.HOUSE]: {
    name: 'بيت سكان', size: 1, cost: { wood: 60 }, buildTime: 75, // 5s
    popCap: 4, storage: 0, auraRadius: 0,
  },
  [BUILDING.WAREHOUSE]: {
    name: 'المخزن', size: 2, cost: { wood: 120, stone: 40 }, buildTime: 225, // 15s
    popCap: 0, storage: 250, depot: true, auraRadius: 0,
  },
  [BUILDING.FARM]: {
    name: 'المزرعة', size: 2, cost: { wood: 45 }, buildTime: 150, // 10s
    popCap: 0, storage: 0, foodPerTick: 0.30, auraRadius: 0,
  },
  [BUILDING.LUMBERMILL]: {
    name: 'منشرة الخشب', size: 2, cost: { wood: 100, stone: 30 }, buildTime: 300, // 20s
    popCap: 0, storage: 0, auraRadius: 6, auraNode: 'tree', auraMult: 1.25,
  },
  [BUILDING.QUARRY]: {
    name: 'المحجر', size: 2, cost: { wood: 90, stone: 50 }, buildTime: 300,
    popCap: 0, storage: 0, auraRadius: 6, auraNode: 'stone', auraMult: 1.25,
  },
  [BUILDING.GOLDMINE_B]: {
    name: 'منجم الذهب', size: 2, cost: { wood: 110, stone: 60 }, buildTime: 300,
    popCap: 0, storage: 0, auraRadius: 6, auraNode: 'gold', auraMult: 1.25,
  },
  [BUILDING.BRICKFACTORY]: {
    name: 'معمل الطابوق', size: 2, cost: { wood: 120, stone: 80 }, buildTime: 375, // 25s
    popCap: 0, storage: 0, auraRadius: 0,
    // worker assigned here makes bricks at bricksPerTick while consuming
    // stonePerBrick stone from the kingdom stock.
    bricksPerTick: 0.22, stonePerBrick: 0.1, boostRes: null,
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
