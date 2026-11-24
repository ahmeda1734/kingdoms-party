// Wire protocol. Plain JSON over WebSocket for now; message shapes are the
// contract between server and client for every phase.

export const C2S = {
  JOIN: 'join',               // { name, room, token? }
  LEAVE: 'leave',
  START: 'start',             // host requests game start
  CHAT: 'chat',               // { text }
  ASSIGN_WORKERS: 'assign',   // { workerIds, nodeId }  gather command
  UNASSIGN: 'unassign',       // { workerIds }          go idle
  ORDER_MOVE: 'move',         // { workerIds, x, y }    world px (any own unit)
  AUTO_ASSIGN: 'auto',        // { type, count }        smart idle-worker dispatch
  BUILD: 'build',             // { type, x, y }         tile coords of top-left corner
  ASSIGN_TO_BUILDING: 'assignBuilding', // { workerIds, buildingId } (brickfactory)
  TRAIN_WORKER: 'trainWorker', // { }                  from the selected castle
  TRAIN_UNIT: 'trainUnit',    // { role }               Phase 3 combat/support roles
  AGE_UP: 'ageUp',            // { }                    Phase 3 advance one age
};

export const S2C = {
  JOINED: 'joined',           // { playerId, token, room, roomState }
  ROOM_UPDATE: 'roomUpdate',  // { players:[{id,name,ready,connected,host}] }
  GAME_INIT: 'gameInit',      // { playerId, seed, mapFingerprint, terrainRLE, nodes, spawns, workers, colors, tickMs }
  SNAPSHOT: 'snap',           // { tick, stocks:{pid:{...}}, yourWorkers, others:[{id,owner,x,y}], nodeDeltas, buildings }
  READY: 'ready',             // client ack -> { playerId, ready }
  CHAT_MSG: 'chatMsg',        // { pid, name, text }
  ERROR: 'error',             // { code, message }
  STARTED: 'started',
  GAME_OVER: 'gameOver',      // { winner, reason }     Phase 3 castle destroyed
};

export function msg(type, data = {}) { return { t: type, ...data }; }
