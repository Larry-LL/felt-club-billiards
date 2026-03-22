const path = require("path");
const crypto = require("crypto");

const express = require("express");

const PORT = Number(process.env.PORT || 3000);
const app = express();

const rooms = new Map();
const TABLE = {
  width: 960,
  height: 520,
  ballRadius: 12,
  pocketRadius: 24,
  pocketCaptureRadius: 16,
  friction: 0.996,
  minVelocity: 0.05,
  maxShotSpeed: 12,
  simulationSubsteps: 4,
  pockets: [
    { x: 22, y: 22 },
    { x: 480, y: 14 },
    { x: 938, y: 22 },
    { x: 22, y: 498 },
    { x: 480, y: 506 },
    { x: 938, y: 498 },
  ],
};

const BALLS = [
  { number: 1, suit: "solids", color: "#f7d154" },
  { number: 2, suit: "solids", color: "#4d7cff" },
  { number: 3, suit: "solids", color: "#e24b4b" },
  { number: 4, suit: "solids", color: "#7e57c2" },
  { number: 5, suit: "solids", color: "#f28a3f" },
  { number: 6, suit: "solids", color: "#2bb1a8" },
  { number: 7, suit: "solids", color: "#8d2c2c" },
  { number: 8, suit: "eight", color: "#111111" },
  { number: 9, suit: "stripes", color: "#f7d154" },
  { number: 10, suit: "stripes", color: "#4d7cff" },
  { number: 11, suit: "stripes", color: "#e24b4b" },
  { number: 12, suit: "stripes", color: "#7e57c2" },
  { number: 13, suit: "stripes", color: "#f28a3f" },
  { number: 14, suit: "stripes", color: "#2bb1a8" },
  { number: 15, suit: "stripes", color: "#8d2c2c" },
];

app.use(express.json());
app.use(express.static(__dirname));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.post("/api/rooms", (req, res) => {
  const name = sanitizeName(req.body?.name);
  const playerId = readOrCreatePlayerId(req.body?.playerId);
  const mode = ["practice", "ai"].includes(req.body?.mode) ? req.body.mode : "multiplayer";
  const room = createRoom({ playerId, name, mode });

  res.status(201).json(buildRoomPayload(room, playerId));
});

app.post("/api/rooms/:roomId/join", (req, res) => {
  const room = rooms.get(normalizeRoomId(req.params.roomId));
  if (!room) {
    return res.status(404).json({ error: "That room does not exist." });
  }

  const playerId = readOrCreatePlayerId(req.body?.playerId);
  const name = sanitizeName(req.body?.name);
  const existingPlayer = room.players.find((player) => player.id === playerId);

  if (["practice", "ai"].includes(room.mode) && !existingPlayer) {
    return res.status(409).json({
      error:
        room.mode === "practice"
          ? "That table is in solo practice mode."
          : "That table is reserved for the computer match.",
    });
  }

  if (existingPlayer) {
    existingPlayer.name = name;
    existingPlayer.connected = true;
    existingPlayer.lastSeenAt = Date.now();
    ensurePlayerGroups(room);
    broadcastRoom(room);
    return res.json(buildRoomPayload(room, playerId));
  }

  if (room.players.length >= 2) {
    return res.status(409).json({ error: "This table already has two players." });
  }

  room.players.push({
    id: playerId,
    name,
    connected: true,
    lastSeenAt: Date.now(),
    isComputer: false,
  });
  ensurePlayerGroups(room);

  room.game.statusMessage = `${room.players[1].name} joined the table. ${room.players[0].name} breaks first on an open table.`;
  room.updatedAt = Date.now();
  broadcastRoom(room);

  return res.json(buildRoomPayload(room, playerId));
});

app.get("/api/rooms/:roomId/state", (req, res) => {
  const room = rooms.get(normalizeRoomId(req.params.roomId));
  if (!room) {
    return res.status(404).json({ error: "That room does not exist." });
  }

  const playerId = req.query.playerId ? String(req.query.playerId) : null;
  if (playerId) {
    const player = room.players.find((entry) => entry.id === playerId);
    if (player) {
      player.connected = true;
      player.lastSeenAt = Date.now();
    }
  }

  res.json(buildRoomPayload(room, playerId));
});

app.get("/api/rooms/:roomId/events", (req, res) => {
  const room = rooms.get(normalizeRoomId(req.params.roomId));
  if (!room) {
    res.status(404).end();
    return;
  }

  const playerId = req.query.playerId ? String(req.query.playerId) : null;
  if (playerId) {
    const player = room.players.find((entry) => entry.id === playerId);
    if (player) {
      player.connected = true;
      player.lastSeenAt = Date.now();
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const client = { id: crypto.randomUUID(), res, playerId };
  room.clients.add(client);
  pushEvent(res, buildRoomPayload(room, playerId));

  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    room.clients.delete(client);
    if (playerId) {
      const player = room.players.find((entry) => entry.id === playerId);
      if (player) {
        player.connected = false;
        player.lastSeenAt = Date.now();
        broadcastRoom(room);
      }
    }
  });
});

app.post("/api/rooms/:roomId/shots", (req, res) => {
  const room = rooms.get(normalizeRoomId(req.params.roomId));
  if (!room) {
    return res.status(404).json({ error: "That room does not exist." });
  }

  const playerId = String(req.body?.playerId || "");
  const angle = Number(req.body?.angle);
  const power = Number(req.body?.power);
  const player = room.players.find((entry) => entry.id === playerId);

  if (!player) {
    return res.status(403).json({ error: "You are not seated at this table." });
  }

  if (room.mode === "multiplayer" && room.players.length < 2) {
    return res.status(409).json({ error: "Invite a friend before taking the first shot." });
  }

  if (room.game.winnerId) {
    return res.status(409).json({ error: "The rack is already over. Start a new one." });
  }

  if (room.game.currentTurnPlayerId !== playerId) {
    return res.status(409).json({ error: "It is not your turn yet." });
  }

  if (room.game.isSimulating || room.game.isAiThinking) {
    return res.status(409).json({ error: "The current shot is still resolving." });
  }

  if (!Number.isFinite(angle) || !Number.isFinite(power) || power <= 0) {
    return res.status(400).json({ error: "That shot power was invalid." });
  }

  const cueBall = room.game.balls.find((ball) => ball.id === "cue" && !ball.pocketed);
  if (!cueBall) {
    return res.status(409).json({ error: "The cue ball is being reset. Try again in a second." });
  }

  const appliedPower = clamp(power, 0.12, 1);
  cueBall.vx = Math.cos(angle) * TABLE.maxShotSpeed * appliedPower;
  cueBall.vy = Math.sin(angle) * TABLE.maxShotSpeed * appliedPower;
  room.game.isSimulating = true;
  room.updatedAt = Date.now();

  const outcome = runSimulation(room, playerId);
  room.game.isSimulating = false;
  applyEightBallRules(room, playerId, outcome);
  room.updatedAt = Date.now();
  broadcastRoom(room);
  maybeQueueComputerTurn(room);

  return res.json(buildRoomPayload(room, playerId));
});

app.post("/api/rooms/:roomId/restart", (req, res) => {
  const room = rooms.get(normalizeRoomId(req.params.roomId));
  if (!room) {
    return res.status(404).json({ error: "That room does not exist." });
  }

  const playerId = String(req.body?.playerId || "");
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return res.status(403).json({ error: "Only seated players can restart the game." });
  }

  room.game = createInitialGame(room.players[0]?.id || null, room.mode, room.players);
  room.game.statusMessage =
    room.mode === "practice"
      ? `${player.name} reset the solo practice rack. Shoot whenever you are ready.`
      : room.mode === "ai"
        ? `${player.name} reset the rack. You break first against House Bot on an open table.`
        : `${player.name} reset the rack. ${room.players[0]?.name || "Player 1"} breaks first on an open table.`;
  room.updatedAt = Date.now();
  broadcastRoom(room);

  res.json(buildRoomPayload(room, playerId));
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 60 * 8;
  for (const [roomId, room] of rooms.entries()) {
    if (room.updatedAt < cutoff && room.clients.size === 0) {
      if (room.aiTimeout) {
        clearTimeout(room.aiTimeout);
      }
      rooms.delete(roomId);
    }
  }
}, 1000 * 60 * 30);

app.listen(PORT, () => {
  console.log(`Billiards game running at http://localhost:${PORT}`);
});

function createRoom({ playerId, name, mode }) {
  const roomId = generateRoomId();
  const players = [
    {
      id: playerId,
      name,
      connected: true,
      lastSeenAt: Date.now(),
      isComputer: false,
    },
  ];

  if (mode === "ai") {
    players.push({
      id: `cpu-${roomId}`,
      name: "House Bot",
      connected: true,
      lastSeenAt: Date.now(),
      isComputer: true,
    });
  }

  const room = {
    id: roomId,
    mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    players,
    clients: new Set(),
    aiTimeout: null,
    game: createInitialGame(playerId, mode, players),
  };

  room.game.statusMessage =
    mode === "practice"
      ? `${name} opened a solo practice table. The rack is open and you can shoot anytime.`
      : mode === "ai"
        ? `${name} opened an 8-ball match against House Bot. You break first on an open table.`
        : `${name} opened an 8-ball room. Share the link and wait for a challenger.`;
  rooms.set(roomId, room);
  return room;
}

function createInitialGame(firstPlayerId, mode, players) {
  return {
    table: TABLE,
    mode,
    balls: createRack(),
    currentTurnPlayerId: firstPlayerId,
    winnerId: null,
    winnerReason: null,
    isSimulating: false,
    isAiThinking: false,
    shotId: 0,
    lastShotFrames: [],
    shotCount: 0,
    openTable: true,
    playerGroups: Object.fromEntries((players || []).map((player) => [player.id, null])),
    statusMessage: "Open table. Break and claim solids or stripes.",
  };
}

function createRack() {
  const cueX = 240;
  const cueY = TABLE.height / 2;
  const startX = 690;
  const startY = TABLE.height / 2;
  const spacing = TABLE.ballRadius * 2 + 1;
  const order = [1, 10, 3, 12, 8, 14, 7, 9, 5, 2, 15, 6, 11, 4, 13];
  const balls = [
    {
      id: "cue",
      label: "Cue",
      number: 0,
      suit: "cue",
      color: "#f8f4ea",
      x: cueX,
      y: cueY,
      vx: 0,
      vy: 0,
      pocketed: false,
      sinking: false,
      sinkProgress: 0,
      pocketTargetX: null,
      pocketTargetY: null,
      kind: "cue",
      spinAngle: 0,
    },
  ];

  let rackIndex = 0;
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col <= row; col += 1) {
      const spec = BALLS.find((ball) => ball.number === order[rackIndex]);
      balls.push({
        id: `ball-${spec.number}`,
        label: String(spec.number),
        number: spec.number,
        suit: spec.suit,
        color: spec.color,
        x: startX + row * spacing,
        y: startY - (row * spacing) / 2 + col * spacing,
        vx: 0,
        vy: 0,
        pocketed: false,
        sinking: false,
        sinkProgress: 0,
        pocketTargetX: null,
        pocketTargetY: null,
        kind: "object",
        spinAngle: 0,
      });
      rackIndex += 1;
    }
  }

  return balls;
}

function runSimulation(room, playerId) {
  const outcome = {
    shooterId: playerId,
    firstContactNumber: null,
    railContacts: 0,
    cueScratch: false,
    pocketedNumbers: [],
    eightBallPocketed: false,
    countsBefore: countRemainingBySuit(room.game.balls),
  };
  const frames = [captureBalls(room.game.balls)];

  for (let frame = 0; frame < 1600; frame += 1) {
    for (let step = 0; step < TABLE.simulationSubsteps; step += 1) {
      updateBallPositions(room.game.balls, 1 / TABLE.simulationSubsteps);
      resolveWallCollisions(room.game.balls, outcome);
      resolveBallCollisions(room.game.balls, outcome);
      detectPockets(room.game.balls, outcome);
    }

    frames.push(captureBalls(room.game.balls));

    if (!hasMovingBalls(room.game.balls)) {
      break;
    }
  }

  room.game.balls.forEach((ball) => {
    if (Math.abs(ball.vx) < TABLE.minVelocity) {
      ball.vx = 0;
    }
    if (Math.abs(ball.vy) < TABLE.minVelocity) {
      ball.vy = 0;
    }
  });

  if (outcome.cueScratch) {
    respotCueBall(room.game.balls);
  }

  frames.push(captureBalls(room.game.balls));
  room.game.lastShotFrames = compressFrames(frames);
  room.game.shotId += 1;

  return outcome;
}

function captureBalls(balls) {
  return balls.map((ball) => ({
    id: ball.id,
    label: ball.label,
    number: ball.number,
    suit: ball.suit,
    color: ball.color,
    x: ball.x,
    y: ball.y,
    vx: ball.vx,
    vy: ball.vy,
    pocketed: ball.pocketed,
    sinking: ball.sinking,
    sinkProgress: ball.sinkProgress,
    kind: ball.kind,
    spinAngle: ball.spinAngle || 0,
  }));
}

function compressFrames(frames) {
  if (frames.length <= 150) {
    return frames;
  }

  const stride = Math.ceil(frames.length / 150);
  const compact = [];
  for (let index = 0; index < frames.length; index += stride) {
    compact.push(frames[index]);
  }

  const finalFrame = frames[frames.length - 1];
  if (compact[compact.length - 1] !== finalFrame) {
    compact.push(finalFrame);
  }

  return compact;
}

function updateBallPositions(balls, delta) {
  for (const ball of balls) {
    if (ball.pocketed) {
      continue;
    }

    if (ball.sinking) {
      ball.sinkProgress = Math.min(ball.sinkProgress + 0.12 * TABLE.simulationSubsteps * delta, 1);
      ball.x += (ball.pocketTargetX - ball.x) * 0.38;
      ball.y += (ball.pocketTargetY - ball.y) * 0.38;
      ball.vx = 0;
      ball.vy = 0;

      if (ball.sinkProgress >= 1) {
        ball.pocketed = true;
        ball.sinking = false;
        ball.x = ball.pocketTargetX;
        ball.y = ball.pocketTargetY;
      }
      continue;
    }

    ball.x += ball.vx * delta;
    ball.y += ball.vy * delta;
    ball.vx *= Math.pow(TABLE.friction, TABLE.simulationSubsteps * delta);
    ball.vy *= Math.pow(TABLE.friction, TABLE.simulationSubsteps * delta);
    ball.spinAngle = (ball.spinAngle || 0) + Math.hypot(ball.vx, ball.vy) * delta / TABLE.ballRadius;

    if (Math.abs(ball.vx) < TABLE.minVelocity) {
      ball.vx = 0;
    }
    if (Math.abs(ball.vy) < TABLE.minVelocity) {
      ball.vy = 0;
    }
  }
}

function resolveWallCollisions(balls, outcome) {
  const minX = TABLE.ballRadius;
  const maxX = TABLE.width - TABLE.ballRadius;
  const minY = TABLE.ballRadius;
  const maxY = TABLE.height - TABLE.ballRadius;

  for (const ball of balls) {
    if (ball.pocketed || ball.sinking) {
      continue;
    }

    if (ball.x < minX) {
      ball.x = minX;
      ball.vx *= -0.94;
      outcome.railContacts += 1;
    } else if (ball.x > maxX) {
      ball.x = maxX;
      ball.vx *= -0.94;
      outcome.railContacts += 1;
    }

    if (ball.y < minY) {
      ball.y = minY;
      ball.vy *= -0.94;
      outcome.railContacts += 1;
    } else if (ball.y > maxY) {
      ball.y = maxY;
      ball.vy *= -0.94;
      outcome.railContacts += 1;
    }
  }
}

function resolveBallCollisions(balls, outcome) {
  for (let i = 0; i < balls.length; i += 1) {
    for (let j = i + 1; j < balls.length; j += 1) {
      const a = balls[i];
      const b = balls[j];

      if (a.pocketed || b.pocketed || a.sinking || b.sinking) {
        continue;
      }

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      const minDistance = TABLE.ballRadius * 2;
      if (distance === 0 || distance >= minDistance) {
        continue;
      }

      if (!outcome.firstContactNumber) {
        if (a.id === "cue" && b.kind === "object") {
          outcome.firstContactNumber = b.number;
        } else if (b.id === "cue" && a.kind === "object") {
          outcome.firstContactNumber = a.number;
        }
      }

      const nx = dx / distance;
      const ny = dy / distance;
      const overlap = minDistance - distance;
      const adjustment = overlap / 2;

      a.x -= nx * adjustment;
      a.y -= ny * adjustment;
      b.x += nx * adjustment;
      b.y += ny * adjustment;

      const dvx = b.vx - a.vx;
      const dvy = b.vy - a.vy;
      const velocityAlongNormal = dvx * nx + dvy * ny;
      if (velocityAlongNormal > 0) {
        continue;
      }

      const impulse = -velocityAlongNormal;
      a.vx += -impulse * nx;
      a.vy += -impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;
    }
  }
}

function detectPockets(balls, outcome) {
  for (const ball of balls) {
    if (ball.pocketed || ball.sinking) {
      continue;
    }

    for (const pocket of TABLE.pockets) {
      if (Math.hypot(ball.x - pocket.x, ball.y - pocket.y) > TABLE.pocketCaptureRadius) {
        continue;
      }

      ball.sinking = true;
      ball.sinkProgress = 0;
      const sinkTarget = getPocketSinkTarget(pocket);
      ball.pocketTargetX = sinkTarget.x;
      ball.pocketTargetY = sinkTarget.y;
      ball.vx = 0;
      ball.vy = 0;

      if (ball.kind === "cue") {
        outcome.cueScratch = true;
      } else {
        outcome.pocketedNumbers.push(ball.number);
        if (ball.number === 8) {
          outcome.eightBallPocketed = true;
        }
      }

      break;
    }
  }
}

function getPocketSinkTarget(pocket) {
  const centerX = TABLE.width / 2;
  const centerY = TABLE.height / 2;
  const dx = centerX - pocket.x;
  const dy = centerY - pocket.y;
  const distance = Math.hypot(dx, dy) || 1;
  const inset = TABLE.ballRadius * 0.9;

  return {
    x: pocket.x + (dx / distance) * inset,
    y: pocket.y + (dy / distance) * inset,
  };
}

function respotCueBall(balls) {
  const cueBall = balls.find((ball) => ball.id === "cue");
  if (!cueBall) {
    return;
  }

  cueBall.x = 240;
  cueBall.y = TABLE.height / 2;
  cueBall.vx = 0;
  cueBall.vy = 0;
  cueBall.pocketed = false;
  cueBall.sinking = false;
  cueBall.sinkProgress = 0;
  cueBall.pocketTargetX = null;
  cueBall.pocketTargetY = null;
}

function hasMovingBalls(balls) {
  return balls.some(
    (ball) =>
      !ball.pocketed &&
      (ball.sinking || Math.abs(ball.vx) > 0 || Math.abs(ball.vy) > 0)
  );
}

function applyEightBallRules(room, playerId, outcome) {
  room.game.shotCount += 1;
  ensurePlayerGroups(room);

  const shooter = room.players.find((player) => player.id === playerId);
  const opponent = room.players.find((player) => player.id !== playerId) || null;
  const shooterGroup = room.game.playerGroups[shooter.id];
  const opponentGroup = opponent ? room.game.playerGroups[opponent.id] : null;
  const madeAnyBall = outcome.pocketedNumbers.length > 0;
  const firstHitBall = getNumberBall(outcome.firstContactNumber);
  const legalTarget = determineLegalTarget(room, shooter.id, outcome.countsBefore);
  const legalFirstContact =
    room.mode === "practice"
      ? Boolean(firstHitBall)
      : legalTarget === "any-non-eight"
        ? Boolean(firstHitBall) && firstHitBall.suit !== "eight"
        : legalTarget === "eight"
          ? outcome.firstContactNumber === 8
          : Boolean(firstHitBall) && firstHitBall.suit === legalTarget;
  const legalShot = legalFirstContact && (madeAnyBall || outcome.railContacts > 0);
  const pocketedSuits = outcome.pocketedNumbers
    .map(getNumberBall)
    .filter(Boolean)
    .map((ball) => ball.suit);

  if (room.mode === "practice") {
    room.game.currentTurnPlayerId = shooter.id;
    room.game.statusMessage =
      outcome.cueScratch
        ? `${shooter.name} scratched. Cue ball respotted for the next practice shot.`
        : madeAnyBall
          ? `${shooter.name} pocketed ${madeAnyBall ? outcome.pocketedNumbers.length : 0} ball${
              outcome.pocketedNumbers.length === 1 ? "" : "s"
            }. Practice continues.`
          : `${shooter.name} missed. Reset your angle and try another practice shot.`;
    return;
  }

  if (outcome.eightBallPocketed) {
    const canShootEight = legalTarget === "eight";
    const winsRack = canShootEight && legalShot && !outcome.cueScratch;
    const winner = winsRack ? shooter : opponent;

    room.game.winnerId = winner?.id || null;
    room.game.winnerReason = winsRack
      ? `${shooter.name} legally pocketed the 8-ball.`
      : `${shooter.name} lost by pocketing the 8-ball early or scratching on it.`;
    room.game.statusMessage = winsRack
      ? `${shooter.name} wins by sinking the 8-ball.`
      : `${winner?.name || "Opponent"} wins after an illegal 8-ball result.`;
    return;
  }

  let assignedThisShot = false;
  if (room.game.openTable && legalShot) {
    const claimSuit = pocketedSuits.find((suit) => suit === "solids" || suit === "stripes") || null;
    if (claimSuit && opponent) {
      room.game.playerGroups[shooter.id] = claimSuit;
      room.game.playerGroups[opponent.id] = claimSuit === "solids" ? "stripes" : "solids";
      room.game.openTable = false;
      assignedThisShot = true;
    }
  }

  const effectiveShooterGroup = room.game.playerGroups[shooter.id];
  const madeOwnBall = effectiveShooterGroup
    ? pocketedSuits.some((suit) => suit === effectiveShooterGroup)
    : false;

  if (outcome.cueScratch || !legalShot) {
    room.game.currentTurnPlayerId = opponent?.id || shooter.id;
    room.game.statusMessage = outcome.cueScratch
      ? `${shooter.name} scratched. ${opponent?.name || "Opponent"} takes ball-in-hand style advantage.`
      : `${shooter.name} committed a foul. ${opponent?.name || "Opponent"} is up next.`;
    return;
  }

  if (assignedThisShot && opponent) {
    room.game.currentTurnPlayerId = shooter.id;
    room.game.statusMessage = `${shooter.name} claims ${room.game.playerGroups[shooter.id]} and keeps shooting.`;
    return;
  }

  if (madeOwnBall) {
    room.game.currentTurnPlayerId = shooter.id;
    room.game.statusMessage = `${shooter.name} pocketed a ${effectiveShooterGroup.slice(0, -1)} ball and stays at the table.`;
    return;
  }

  room.game.currentTurnPlayerId = opponent?.id || shooter.id;
  room.game.statusMessage = room.game.openTable
    ? `${shooter.name} leaves the table open. ${opponent?.name || "Opponent"} shoots next.`
    : `${shooter.name} did not pocket a scoring ball. ${opponent?.name || "Opponent"} is up.`;
}

function determineLegalTarget(room, playerId, countsBefore) {
  if (room.mode === "practice") {
    return "any-non-eight";
  }

  const assignedGroup = room.game.playerGroups[playerId];
  if (!assignedGroup || room.game.openTable) {
    return "any-non-eight";
  }

  return countsBefore[assignedGroup] === 0 ? "eight" : assignedGroup;
}

function countRemainingBySuit(balls) {
  return {
    solids: balls.filter((ball) => ball.suit === "solids" && !ball.pocketed).length,
    stripes: balls.filter((ball) => ball.suit === "stripes" && !ball.pocketed).length,
  };
}

function getNumberBall(number) {
  return BALLS.find((ball) => ball.number === number) || null;
}

function ensurePlayerGroups(room) {
  const groups = room.game.playerGroups || {};
  room.players.forEach((player) => {
    if (!(player.id in groups)) {
      groups[player.id] = null;
    }
  });
  room.game.playerGroups = groups;
}

function maybeQueueComputerTurn(room) {
  const computer = room.players.find((player) => player.isComputer);
  if (
    room.mode !== "ai" ||
    !computer ||
    room.game.winnerId ||
    room.game.currentTurnPlayerId !== computer.id
  ) {
    return;
  }

  if (room.aiTimeout) {
    clearTimeout(room.aiTimeout);
  }

  room.game.isAiThinking = true;
  broadcastRoom(room);

  // Wait for the client animation to finish before firing the CPU shot.
  // Animation duration = frames * 16 ms; add 600 ms buffer.
  const animDuration = room.game.lastShotFrames.length * 16;
  const delay = Math.max(1400, animDuration + 600);

  room.aiTimeout = setTimeout(() => {
    room.aiTimeout = null;
    runComputerTurn(room, computer);
  }, delay);
}

function runComputerTurn(room, computer) {
  const cueBall = room.game.balls.find((ball) => ball.id === "cue" && !ball.pocketed);
  if (!cueBall || room.game.winnerId || room.game.currentTurnPlayerId !== computer.id) {
    room.game.isAiThinking = false;
    broadcastRoom(room);
    return;
  }

  const shot = chooseComputerShot(room, cueBall, computer.id);
  cueBall.vx = Math.cos(shot.angle) * TABLE.maxShotSpeed * shot.power;
  cueBall.vy = Math.sin(shot.angle) * TABLE.maxShotSpeed * shot.power;
  room.game.isAiThinking = false;
  room.game.isSimulating = true;

  const outcome = runSimulation(room, computer.id);
  room.game.isSimulating = false;
  applyEightBallRules(room, computer.id, outcome);
  room.updatedAt = Date.now();
  broadcastRoom(room);
  maybeQueueComputerTurn(room);
}

function chooseComputerShot(room, cueBall, playerId) {
  const legalTarget = determineLegalTarget(room, playerId, countRemainingBySuit(room.game.balls));
  const targets = room.game.balls.filter((ball) => {
    if (ball.kind !== "object" || ball.pocketed) return false;
    if (legalTarget === "any-non-eight") return ball.number !== 8;
    if (legalTarget === "eight") return ball.number === 8;
    return ball.suit === legalTarget;
  });

  if (targets.length === 0) {
    return { angle: Math.random() * Math.PI * 2, power: 0.4 };
  }

  let bestShot = null;
  let bestScore = -Infinity;

  for (const target of targets) {
    for (const pocket of TABLE.pockets) {
      // Vector from target ball to pocket
      const tpx = pocket.x - target.x;
      const tpy = pocket.y - target.y;
      const tpDist = Math.hypot(tpx, tpy);
      if (tpDist === 0) continue;

      // Ghost ball: where the cue ball center must sit to send target into this pocket
      const ghostX = target.x - (tpx / tpDist) * TABLE.ballRadius * 2;
      const ghostY = target.y - (tpy / tpDist) * TABLE.ballRadius * 2;

      // Reject ghost balls outside the table
      if (
        ghostX < TABLE.ballRadius || ghostX > TABLE.width - TABLE.ballRadius ||
        ghostY < TABLE.ballRadius || ghostY > TABLE.height - TABLE.ballRadius
      ) {
        continue;
      }

      // Vector from cue ball to ghost ball
      const cgx = ghostX - cueBall.x;
      const cgy = ghostY - cueBall.y;
      const cgDist = Math.hypot(cgx, cgy);
      if (cgDist < TABLE.ballRadius * 2) continue;

      // Cut angle: between (cue→target) and (target→pocket)
      const ctx2 = target.x - cueBall.x;
      const cty2 = target.y - cueBall.y;
      const ctDist = Math.hypot(ctx2, cty2);
      const dot = (ctx2 * tpx + cty2 * tpy) / (ctDist * tpDist);
      const cutAngle = Math.acos(clamp(dot, -1, 1));

      // Skip cuts harder than 70°
      if (cutAngle > (Math.PI * 7) / 18) continue;

      // Score: reward easy cut angles and short cue-to-ghost distance
      const cutScore = 1 - cutAngle / (Math.PI / 2);
      const distScore = 1 - Math.min(cgDist / 700, 1);
      const score = cutScore * 0.65 + distScore * 0.35;

      if (score > bestScore) {
        bestScore = score;
        const aimErr = (Math.random() - 0.5) * 0.07;
        bestShot = {
          angle: Math.atan2(cgy, cgx) + aimErr,
          power: clamp(cgDist / 350 + 0.3, 0.3, 0.92),
        };
      }
    }
  }

  // Fallback: aim directly at nearest target
  if (!bestShot) {
    const nearest = targets.reduce((a, b) =>
      Math.hypot(a.x - cueBall.x, a.y - cueBall.y) <= Math.hypot(b.x - cueBall.x, b.y - cueBall.y) ? a : b
    );
    const distance = Math.hypot(nearest.x - cueBall.x, nearest.y - cueBall.y);
    bestShot = {
      angle: Math.atan2(nearest.y - cueBall.y, nearest.x - cueBall.x) + (Math.random() - 0.5) * 0.15,
      power: clamp(distance / 280 + 0.22, 0.28, 0.88),
    };
  }

  return bestShot;
}

function buildRoomPayload(room, playerId) {
  ensurePlayerGroups(room);
  return {
    roomId: room.id,
    mode: room.mode,
    you: playerId ? room.players.find((player) => player.id === playerId) || null : null,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      connected: player.connected,
      isComputer: Boolean(player.isComputer),
      group: room.game.playerGroups[player.id],
    })),
    game: {
      table: room.game.table,
      mode: room.game.mode,
      balls: room.game.balls,
      openTable: room.game.openTable,
      playerGroups: room.game.playerGroups,
      currentTurnPlayerId: room.game.currentTurnPlayerId,
      winnerId: room.game.winnerId,
      winnerReason: room.game.winnerReason,
      isSimulating: room.game.isSimulating,
      isAiThinking: room.game.isAiThinking,
      shotId: room.game.shotId,
      lastShotFrames: room.game.lastShotFrames,
      shotCount: room.game.shotCount,
      statusMessage: room.game.statusMessage,
    },
  };
}

function broadcastRoom(room) {
  const payload = JSON.stringify(buildRoomPayload(room, null));
  for (const client of room.clients) {
    client.res.write(`data: ${payload}\n\n`);
  }
}

function pushEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function generateRoomId() {
  let roomId = "";
  do {
    roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (rooms.has(roomId));
  return roomId;
}

function normalizeRoomId(roomId) {
  return String(roomId || "").trim().toUpperCase();
}

function sanitizeName(value) {
  const name = String(value || "").trim().slice(0, 24);
  return name || "Player";
}

function readOrCreatePlayerId(value) {
  return String(value || crypto.randomUUID());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
