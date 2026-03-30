const STORAGE_KEYS = {
  name: "felt-club-name",
  playerId: "felt-club-player-id",
  roomId: "felt-club-room-id",
};

// Lobby elements
const lobbyScreen = document.getElementById("lobbyScreen");
const gameScreen = document.getElementById("gameScreen");
const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const quickMatchButton = document.getElementById("quickMatchButton");
const computerButton = document.getElementById("computerButton");
const createPrivateButton = document.getElementById("createPrivateButton");
const joinRoomButton = document.getElementById("joinRoomButton");
const joinSection = document.getElementById("joinSection");
const statsOnline = document.getElementById("statsOnline");
const statsGames = document.getElementById("statsGames");
const openRoomsDiv = document.getElementById("openRooms");
const openRoomsList = document.getElementById("openRoomsList");
const lobbyMessage = document.getElementById("lobbyMessage");

// Game elements
const leaveButton = document.getElementById("leaveButton");
const restartButton = document.getElementById("restartButton");
const copyInviteButton = document.getElementById("copyInviteButton");
const invitePanelDiv = document.getElementById("invitePanel");
const waitingPanel = document.getElementById("waitingPanel");
const statusBar = document.getElementById("statusBar");
const turnText = document.getElementById("turnText");
const tableStateText = document.getElementById("tableStateText");
const scoreboard = document.getElementById("scoreboard");
const messageBox = document.getElementById("message");
const powerBarDiv = document.getElementById("powerBar");
const powerFill = document.getElementById("powerFill");
const powerValue = document.getElementById("powerValue");
const canvas = document.getElementById("tableCanvas");
const ctx = canvas.getContext("2d");

const DEFAULT_POCKETS = [
  { x: 22, y: 22 },
  { x: 480, y: 14 },
  { x: 938, y: 22 },
  { x: 22, y: 498 },
  { x: 480, y: 506 },
  { x: 938, y: 498 },
];

let roomState = null;
let playerId = localStorage.getItem(STORAGE_KEYS.playerId) || "";
let eventSource = null;
let displayedBalls = null;
let animatedShotId = 0;
let animationTimer = 0;
let aimAngle = 0;
let isCharging = false;
let chargeStartTime = 0;
let currentPower = 0;
let shotInFlight = false;
let placementPos = null;
let keysDown = new Set();
let gameLoopId = 0;
let lastFiredShotId = 0;

let lobbyPollTimer = 0;

initialize();

function initialize() {
  const roomIdFromUrl = new URL(window.location.href).searchParams.get("room");
  nameInput.value = localStorage.getItem(STORAGE_KEYS.name) || "";

  // Lobby buttons
  quickMatchButton.addEventListener("click", quickMatch);
  computerButton.addEventListener("click", () => createRoom("ai"));
  createPrivateButton.addEventListener("click", () => createRoom("multiplayer"));
  joinRoomButton.addEventListener("click", joinRoom);
  leaveButton.addEventListener("click", leaveGame);
  restartButton.addEventListener("click", restartRack);
  copyInviteButton.addEventListener("click", copyInviteLink);

  // Show join section when room code exists
  roomInput.addEventListener("input", () => {
    if (roomInput.value.trim()) {
      joinSection.classList.remove("hidden");
    }
  });

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("keyup", handleKeyUp);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerdown", handleCanvasClick);
  window.addEventListener("beforeunload", closeEventStream);

  if (roomIdFromUrl) {
    // Direct invite link — go straight to game
    roomInput.value = roomIdFromUrl.toUpperCase();
    joinSection.classList.remove("hidden");
    reconnectToRoom(roomIdFromUrl.toUpperCase());
  } else {
    showLobby();
  }
}

function showLobby() {
  lobbyScreen.classList.remove("hidden");
  gameScreen.classList.add("hidden");
  roomState = null;
  closeEventStream();
  stopGameLoop();
  pollLobby();
  lobbyPollTimer = setInterval(pollLobby, 5000);
}

function showGame() {
  lobbyScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  clearInterval(lobbyPollTimer);
  lobbyPollTimer = 0;
  render();
}

async function pollLobby() {
  try {
    const data = await request("/api/rooms");
    statsOnline.textContent = `${data.onlinePlayers} online`;
    statsGames.textContent = `${data.activeGames} game${data.activeGames !== 1 ? "s" : ""}`;

    if (data.openRooms.length > 0) {
      openRoomsDiv.classList.remove("hidden");
      openRoomsList.innerHTML = data.openRooms
        .slice(0, 5)
        .map(
          (r) =>
            `<div class="open-room-card" data-room="${r.roomId}">
              <span class="open-room-host">${escapeHtml(r.host)}'s table</span>
              <span class="open-room-join">Join</span>
            </div>`
        )
        .join("");
      openRoomsList.querySelectorAll(".open-room-card").forEach((card) => {
        card.addEventListener("click", () => {
          roomInput.value = card.dataset.room;
          joinRoom();
        });
      });
    } else {
      openRoomsDiv.classList.add("hidden");
    }
  } catch (_e) {
    // Lobby poll failed, ignore
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function leaveGame() {
  closeEventStream();
  stopGameLoop();
  roomState = null;
  displayedBalls = null;
  animatedShotId = 0;
  localStorage.removeItem(STORAGE_KEYS.roomId);
  updateUrl(null);
  invitePanelDiv.classList.add("hidden");
  waitingPanel.classList.add("hidden");
  statusBar.classList.add("hidden");
  messageBox.classList.add("hidden");
  showLobby();
}

function stopGameLoop() {
  if (gameLoopId) {
    cancelAnimationFrame(gameLoopId);
    gameLoopId = 0;
  }
}

async function quickMatch() {
  const name = getPlayerName();
  if (!name || name === "Player") {
    showLobbyMessage("Enter your name first.", "error");
    nameInput.focus();
    return;
  }
  quickMatchButton.disabled = true;
  quickMatchButton.textContent = "Finding match...";
  try {
    const data = await request("/api/quickmatch", {
      method: "POST",
      body: JSON.stringify({ name, playerId }),
    });
    handleJoinedRoom(data);
    if (data.players.length < 2) {
      showMessage("Waiting for an opponent. Share the link or sit tight.", "info");
    } else {
      showMessage("Matched! Game is on.", "success");
    }
  } catch (error) {
    showLobbyMessage(error.message, "error");
  } finally {
    quickMatchButton.disabled = false;
    quickMatchButton.textContent = "Quick Match";
  }
}

function showLobbyMessage(text, tone = "info") {
  lobbyMessage.className = `message ${tone}`;
  lobbyMessage.textContent = text;
  lobbyMessage.classList.remove("hidden");
  setTimeout(() => lobbyMessage.classList.add("hidden"), 4000);
}

async function createRoom(mode) {
  const name = getPlayerName();
  if (!name || name === "Player") {
    showLobbyMessage("Enter your name first.", "error");
    nameInput.focus();
    return;
  }
  toggleBusy(true);
  try {
    const data = await request("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name, playerId, mode }),
    });
    handleJoinedRoom(data);
    showMessage(
      mode === "ai"
        ? "House Bot is ready. You break first."
        : "Room created. Share the link to invite a friend.",
      "success"
    );
  } catch (error) {
    showLobbyMessage(error.message, "error");
  } finally {
    toggleBusy(false);
  }
}

async function joinRoom() {
  const roomId = roomInput.value.trim().toUpperCase();
  if (!roomId) {
    showLobbyMessage("Enter a room code before joining.", "error");
    return;
  }
  const name = getPlayerName();
  if (!name || name === "Player") {
    showLobbyMessage("Enter your name first.", "error");
    nameInput.focus();
    return;
  }

  toggleBusy(true);
  try {
    const data = await request(`/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify({ name, playerId }),
    });
    handleJoinedRoom(data);
    showMessage("Joined. Game on.", "success");
  } catch (error) {
    showLobbyMessage(error.message, "error");
  } finally {
    toggleBusy(false);
  }
}

async function reconnectToRoom(roomId) {
  try {
    const data = await request(`/api/rooms/${roomId}/state?playerId=${encodeURIComponent(playerId)}`);
    handleJoinedRoom(data);
  } catch (_error) {
    localStorage.removeItem(STORAGE_KEYS.roomId);
    updateUrl(null);
    showLobby();
  }
}

function handleJoinedRoom(data) {
  roomState = data;
  roomInput.value = data.roomId;
  playerId = data.you?.id || playerId;

  if (playerId) {
    localStorage.setItem(STORAGE_KEYS.playerId, playerId);
  }

  localStorage.setItem(STORAGE_KEYS.name, getPlayerName());
  localStorage.setItem(STORAGE_KEYS.roomId, data.roomId);
  updateUrl(data.roomId);
  connectEventStream(data.roomId);
  syncAnimationState(data, true);

  // Show/hide panels based on game state
  statusBar.classList.remove("hidden");
  if (data.mode === "multiplayer" && data.players.length < 2) {
    invitePanelDiv.classList.remove("hidden");
    waitingPanel.classList.remove("hidden");
  } else {
    invitePanelDiv.classList.add("hidden");
    waitingPanel.classList.add("hidden");
  }

  showGame();
  render();
}

function connectEventStream(roomId) {
  closeEventStream();
  eventSource = new EventSource(`/api/rooms/${roomId}/events?playerId=${encodeURIComponent(playerId)}`);
  eventSource.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    const incomingShotId = payload.game?.shotId || 0;
    const isOwnShot = incomingShotId === lastFiredShotId;

    roomState = {
      ...payload,
      you: payload.players.find((player) => player.id === playerId) || roomState?.you || null,
    };

    // For our own shots, fireShot already handles the animation via the REST
    // response. Only run syncAnimationState for opponent shots (via SSE).
    if (!isOwnShot) {
      syncAnimationState(roomState);
    }

    // Hide waiting panel when opponent joins
    if (roomState.players.length >= 2) {
      waitingPanel.classList.add("hidden");
      invitePanelDiv.classList.add("hidden");
    }

    render();
    // Show ball-in-hand prompt when opponent fouled and it's our turn
    if (roomState.game.ballInHand && roomState.game.currentTurnPlayerId === playerId) {
      showMessage("Opponent fouled! Click the table to place the cue ball, or press Space to keep it.", "success");
    }
    // Show server status messages (fouls, turn changes, etc.)
    if (roomState.game.statusMessage) {
      const msg = roomState.game.statusMessage;
      const isFoul = msg.includes("foul") || msg.includes("scratched");
      const isWin = msg.includes("wins");
      if (isFoul || isWin) {
        showMessage(msg, isFoul ? "error" : "success");
      }
    }
  };
}

function closeEventStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

async function restartRack() {
  if (!roomState) {
    return;
  }

  toggleBusy(true);
  try {
    const data = await request(`/api/rooms/${roomState.roomId}/restart`, {
      method: "POST",
      body: JSON.stringify({ playerId }),
    });
    roomState = data;
    syncAnimationState(roomState, true);
    render();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    toggleBusy(false);
  }
}

async function copyInviteLink() {
  if (!roomState || roomState.mode !== "multiplayer") {
    return;
  }

  await navigator.clipboard.writeText(getInviteUrl(roomState.roomId));
  showMessage("Room link copied. Anyone who can reach this server URL can join that room.", "success");
}

function handleKeyDown(event) {
  if (document.activeElement?.tagName === "INPUT") return;

  if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
    event.preventDefault();
    keysDown.add(event.code);
    startGameLoop();
  }

  if (event.code === "Space") {
    event.preventDefault();
    if (!canShoot()) return;

    // If ball-in-hand, accept current cue ball position
    if (roomState.game.ballInHand) {
      const cueBall = getCueBall();
      if (cueBall) placeCueBall(cueBall.x, cueBall.y);
      return;
    }

    if (!isCharging && !shotInFlight) {
      isCharging = true;
      chargeStartTime = performance.now();
      currentPower = 0;
      startGameLoop();
    }
  }
}

function handleKeyUp(event) {
  if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
    keysDown.delete(event.code);
  }

  if (event.code === "Space" && isCharging) {
    event.preventDefault();
    isCharging = false;
    if (currentPower >= 0.05) {
      fireShot();
    }
    currentPower = 0;
    render();
  }
}

function startGameLoop() {
  if (gameLoopId) return;

  function tick() {
    let needsRender = false;

    if (canShoot() && !roomState.game.ballInHand) {
      if (keysDown.has("ArrowLeft")) {
        aimAngle -= 0.008;
        needsRender = true;
      }
      if (keysDown.has("ArrowRight")) {
        aimAngle += 0.008;
        needsRender = true;
      }
    }

    if (isCharging) {
      const elapsed = performance.now() - chargeStartTime;
      currentPower = Math.min(elapsed / 2000, 1);
      needsRender = true;
    }

    if (needsRender) render();

    if (keysDown.size > 0 || isCharging) {
      gameLoopId = requestAnimationFrame(tick);
    } else {
      gameLoopId = 0;
    }
  }

  gameLoopId = requestAnimationFrame(tick);
}

async function fireShot() {
  if (!canShoot() || shotInFlight) return;

  shotInFlight = true;
  toggleBusy(true);
  try {
    const data = await request(`/api/rooms/${roomState.roomId}/shots`, {
      method: "POST",
      body: JSON.stringify({
        playerId,
        angle: aimAngle,
        power: currentPower,
      }),
    });
    roomState = data;
    // Mark this shot as ours so SSE handler doesn't interfere
    lastFiredShotId = data.game.shotId;
    syncAnimationState(roomState);
    render();
    // Show foul feedback if we fouled
    if (data.game.ballInHand && data.game.currentTurnPlayerId !== playerId) {
      showMessage("Foul! Opponent gets ball-in-hand — they can place the cue ball anywhere.", "error");
    }
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    shotInFlight = false;
    toggleBusy(false);
  }
}

function handlePointerMove(event) {
  if (!canShoot() || !roomState.game.ballInHand) return;
  placementPos = getCanvasPoint(event);
  render();
}

function handleCanvasClick(event) {
  if (!canShoot() || !roomState.game.ballInHand) return;

  const point = getCanvasPoint(event);
  if (point.x < 25 || point.x > 935 || point.y < 25 || point.y > 495) return;

  const balls = getDisplayedBalls();
  const tooClose = balls.some(
    (b) => !b.pocketed && b.id !== "cue" && Math.hypot(b.x - point.x, b.y - point.y) < 24
  );
  if (tooClose) {
    showMessage("Too close to another ball. Try a different spot.", "error");
    return;
  }

  placeCueBall(point.x, point.y);
}

async function placeCueBall(x, y) {
  if (shotInFlight) return;
  shotInFlight = true;
  toggleBusy(true);
  try {
    const data = await request(`/api/rooms/${roomState.roomId}/place-cue`, {
      method: "POST",
      body: JSON.stringify({ playerId, x, y }),
    });
    roomState = data;
    placementPos = null;
    syncAnimationState(roomState, true);
    render();
    showMessage("Cue ball placed. Use ← → to aim, hold Space to charge.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    shotInFlight = false;
    toggleBusy(false);
  }
}

function canShoot() {
  return Boolean(
    roomState &&
      roomState.you &&
      roomState.game.currentTurnPlayerId === playerId &&
      !roomState.game.winnerId &&
      !roomState.game.isSimulating &&
      !roomState.game.isAiThinking
  );
}

function getCueBall() {
  return getDisplayedBalls().find((ball) => ball.id === "cue" && !ball.pocketed) || null;
}

function getDisplayedBalls() {
  return displayedBalls || roomState?.game?.balls || [];
}

function render() {
  renderHeader();
  renderScoreboard();
  renderPowerBar();
  renderTable();
}

function renderPowerBar() {
  if (!isCharging) {
    powerBarDiv.classList.add("hidden");
    return;
  }
  powerBarDiv.classList.remove("hidden");
  const pct = Math.round(currentPower * 100);
  powerFill.style.width = `${pct}%`;
  powerValue.textContent = `${pct}%`;
}

function renderHeader() {
  turnText.textContent = getTurnLabel();
  tableStateText.textContent = getTableStateLabel();
  restartButton.disabled = !roomState;
  copyInviteButton.disabled = !roomState || roomState.mode !== "multiplayer";
}

function getTurnLabel() {
  if (!roomState) {
    return "Waiting";
  }
  const winner = roomState.players.find((player) => player.id === roomState.game.winnerId);
  if (winner) {
    return `${winner.name} won`;
  }
  const current = roomState.players.find((player) => player.id === roomState.game.currentTurnPlayerId);
  if (!current) {
    return "Waiting";
  }
  return current.id === playerId ? "Your turn" : `${current.name}'s turn`;
}

function getTableStateLabel() {
  if (!roomState) {
    return "Open";
  }
  if (roomState.game.openTable) {
    return "Open table";
  }
  const youGroup = roomState.game.playerGroups[playerId];
  if (youGroup) {
    return youGroup === "solids" ? "You: solids" : "You: stripes";
  }
  return "Claimed";
}

function renderScoreboard() {
  if (!roomState) {
    scoreboard.innerHTML = "";
    return;
  }

  scoreboard.innerHTML = roomState.players
    .map((player) => {
      const active = player.id === roomState.game.currentTurnPlayerId ? "active" : "";
      const group = player.group
        ? `<span class="group-badge ${player.group}">${player.group === "solids" ? "Solids" : "Stripes"}</span>`
        : `<span class="group-badge">Open table</span>`;
      const role = player.isComputer ? "Computer" : player.id === playerId ? "You" : "Opponent";
      const status = player.isComputer
        ? roomState.game.isAiThinking
          ? "Thinking"
          : "Ready"
        : player.connected
          ? "Online"
          : "Away";
      return `
        <article class="player-card ${active}">
          <div class="player-meta">
            <span>${escapeHtml(role)}</span>
            <strong>${escapeHtml(player.name)}</strong>
            ${group}
          </div>
          <div class="player-points">
            <span>${escapeHtml(status)}</span>
            <strong>${getRemainingLabel(player)}</strong>
          </div>
        </article>
      `;
    })
    .join("");
}

function getRemainingLabel(player) {
  if (!roomState || roomState.game.openTable || !player.group) {
    return "Open";
  }

  const remaining = roomState.game.balls.filter(
    (ball) => ball.suit === player.group && !ball.pocketed
  ).length;
  return remaining === 0 ? "8-ball live" : `${remaining} left`;
}

function renderTable() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawTable();

  const balls = getDisplayedBalls();
  balls.forEach(drawBallShadow);
  balls.forEach(drawBall);

  // Only show cue stick when aiming — not during animation or ball-in-hand
  if (canShoot() && !roomState.game.ballInHand && !animationTimer) {
    drawAimGuide();
  }

  if (canShoot() && roomState.game.ballInHand) {
    drawBallInHandOverlay();
  }

  if (!roomState) {
    drawCenterMessage("Create a room to rack the table.");
    return;
  }

  if (roomState.mode === "multiplayer" && roomState.players.length < 2) {
    drawCenterMessage("Waiting for a second player to join online.");
    return;
  }

  if (roomState.game.winnerId) {
    const winner = roomState.players.find((player) => player.id === roomState.game.winnerId);
    drawCenterMessage(`${winner?.name || "Winner"} takes the rack.`);
  } else if (roomState.game.ballInHand && !canShoot()) {
    drawCenterMessage("Foul — ball-in-hand for opponent.");
  } else if (!canShoot() && (roomState.game.isSimulating || roomState.game.isAiThinking)) {
    drawCenterMessage(roomState.game.isAiThinking ? "House Bot is reading the table." : "Shot resolving...");
  }
}

function drawTable() {
  const W = canvas.width;
  const H = canvas.height;
  const WOOD = 8;       // dark mahogany rail thickness
  const CUSHION = 10;   // green rubber cushion thickness
  const BORDER = WOOD + CUSHION; // 18px total — felt starts here

  // 1. Outer mahogany wood rail
  const rail = ctx.createLinearGradient(0, 0, 0, H);
  rail.addColorStop(0, "#3d1a08");
  rail.addColorStop(0.5, "#1a0904");
  rail.addColorStop(1, "#3d1a08");
  ctx.fillStyle = rail;
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  // Wood grain lines
  ctx.strokeStyle = "rgba(120, 60, 20, 0.3)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const off = 3 + i * 3;
    ctx.beginPath();
    ctx.moveTo(off, off);
    ctx.lineTo(W - off, off);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(off, H - off);
    ctx.lineTo(W - off, H - off);
    ctx.stroke();
  }

  // 2. Green rubber cushion band
  ctx.fillStyle = "#185c18";
  roundRect(ctx, WOOD, WOOD, W - WOOD * 2, H - WOOD * 2, 20);
  ctx.fill();

  // Cushion highlight
  ctx.strokeStyle = "rgba(80, 200, 80, 0.22)";
  ctx.lineWidth = 2;
  roundRect(ctx, WOOD + 1, WOOD + 1, W - (WOOD + 1) * 2, H - (WOOD + 1) * 2, 19);
  ctx.stroke();

  // 3. Classic green felt playing surface
  const felt = ctx.createLinearGradient(0, BORDER, 0, H - BORDER);
  felt.addColorStop(0, "#2d6b1d");
  felt.addColorStop(0.45, "#1e4f14");
  felt.addColorStop(1, "#163a0e");
  ctx.fillStyle = felt;
  roundRect(ctx, BORDER, BORDER, W - BORDER * 2, H - BORDER * 2, 10);
  ctx.fill();

  // Felt inner edge highlight
  ctx.strokeStyle = "rgba(60, 140, 60, 0.38)";
  ctx.lineWidth = 2;
  roundRect(ctx, BORDER, BORDER, W - BORDER * 2, H - BORDER * 2, 10);
  ctx.stroke();

  // 4. Table markings
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(96, BORDER + 2);
  ctx.lineTo(96, H - BORDER - 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(192, H / 2, 88, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.stroke();

  // 5. Pocket cutouts
  const pockets = roomState?.game?.table?.pockets || DEFAULT_POCKETS;
  pockets.forEach((pocket) => {
    const rim = ctx.createRadialGradient(pocket.x, pocket.y, 3, pocket.x, pocket.y, 24);
    rim.addColorStop(0, "#050505");
    rim.addColorStop(0.55, "#0e0e0e");
    rim.addColorStop(1, "#1a0904");
    ctx.beginPath();
    ctx.arc(pocket.x, pocket.y, 24, 0, Math.PI * 2);
    ctx.fillStyle = rim;
    ctx.fill();
  });
}

function drawBallShadow(ball) {
  if (ball.pocketed) {
    return;
  }

  const radius = getBallRadius(ball);
  const alpha = ball.sinking ? 0.14 : 0.24;
  const shadow = ctx.createRadialGradient(ball.x + 3, ball.y + 5, 3, ball.x + 3, ball.y + 5, radius + 5);
  shadow.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
  shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.beginPath();
  ctx.arc(ball.x + 3, ball.y + 5, radius + 4, 0, Math.PI * 2);
  ctx.fillStyle = shadow;
  ctx.fill();
}

function drawSinkingBall(ball) {
  const t = Math.min(ball.sinkProgress || 0, 1);
  const baseRadius = roomState?.game?.table?.ballRadius || 12;
  const drawRadius = Math.max(baseRadius * (1 - t * 0.88), 1);

  // Spiral spin offset — orbits around ball.x/y (which is already moving toward pocket)
  const spiralRadius = (1 - t) * baseRadius * 0.9;
  const spiralAngle = t * Math.PI * 5; // 2.5 full rotations during sink
  const drawX = ball.x + Math.cos(spiralAngle) * spiralRadius;
  const drawY = ball.y + Math.sin(spiralAngle) * spiralRadius;

  ctx.save();
  ctx.globalAlpha = 1 - t * 0.5;

  ctx.beginPath();
  ctx.arc(drawX, drawY, drawRadius, 0, Math.PI * 2);
  ctx.fillStyle = makeBallGradient({ ...ball, x: drawX, y: drawY }, drawRadius);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.stroke();

  // Stripe band for stripe balls
  if (ball.suit === "stripes" && drawRadius > 3) {
    const ry = ball.rollY || 0;
    const bandY = Math.sin(ry) * drawRadius * 0.7;
    const bandHalf = drawRadius * 0.62 * Math.max(Math.abs(Math.cos(ry)), 0.2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(drawX, drawY, drawRadius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = ball.color;
    ctx.fillRect(drawX - drawRadius, drawY + bandY - bandHalf, drawRadius * 2, bandHalf * 2);
    ctx.restore();
  }

  ctx.restore();
}

function drawBall(ball) {
  if (ball.pocketed) {
    return;
  }
  // Sinking object balls get the spiral whirl animation
  if (ball.sinking && ball.id !== "cue") {
    drawSinkingBall(ball);
    return;
  }

  const radius = getBallRadius(ball);
  const rx = ball.rollX || 0;
  const ry = ball.rollY || 0;

  ctx.save();

  // 1. Base sphere gradient (lighting is fixed, never rotates)
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = makeBallGradient(ball, radius);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.stroke();

  // 2. Surface markings — 3D sphere projection based on rolling direction
  ctx.save();
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(ball.x, ball.y);

  // --- Rolling shadow: a dark spot that orbits the ball surface ---
  // This is the strongest visual cue for rotation — visible on ALL balls
  const shadowX = Math.sin(rx) * radius * 0.45;
  const shadowY = Math.sin(ry) * radius * 0.45;
  const rollingDark = ctx.createRadialGradient(shadowX, shadowY, 0, shadowX, shadowY, radius * 0.85);
  rollingDark.addColorStop(0, "rgba(0,0,0,0.18)");
  rollingDark.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = rollingDark;
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);

  // Rolling highlight on the opposite side
  const rollingLight = ctx.createRadialGradient(-shadowX, -shadowY, 0, -shadowX, -shadowY, radius * 0.7);
  rollingLight.addColorStop(0, "rgba(255,255,255,0.12)");
  rollingLight.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = rollingLight;
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);

  // --- Type-specific surface markings ---
  // Front-face 3D position (where number badge currently sits on sphere)
  const frontX = Math.sin(rx) * radius * 0.65;
  const frontY = Math.sin(ry) * radius * 0.65;
  const frontZ = Math.cos(rx) * Math.cos(ry);

  if (ball.suit === "stripes") {
    // Stripe band around equator — shifts vertically with ry, tilts with rx
    const bandY = Math.sin(ry) * radius * 0.75;
    const bandHalf = radius * 0.62 * Math.max(Math.abs(Math.cos(ry)), 0.18);
    ctx.fillStyle = ball.color;
    ctx.fillRect(-radius, bandY - bandHalf, radius * 2, bandHalf * 2);
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.fillRect(-radius, bandY - bandHalf, radius * 2, 1.5);
    ctx.fillRect(-radius, bandY + bandHalf - 1.5, radius * 2, 1.5);

    // Number badge orbits on sphere
    if (frontZ > 0.05) {
      const scale = Math.min(frontZ * 1.3, 1);
      const br = radius * 0.42 * scale;
      ctx.beginPath();
      ctx.arc(frontX, frontY, br, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.fill();
      if (br > 3) {
        ctx.fillStyle = "#203145";
        ctx.font = `700 ${Math.max(Math.round(10 * scale), 6)}px -apple-system`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(ball.number), frontX, frontY + 0.5);
      }
    }
  } else if (ball.kind === "object") {
    // Number badge orbits on sphere
    if (frontZ > 0.05) {
      const scale = Math.min(frontZ * 1.3, 1);
      const br = radius * 0.46 * scale;
      ctx.beginPath();
      ctx.arc(frontX, frontY, Math.max(br, 2), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.96)";
      ctx.fill();
      if (br > 3) {
        ctx.fillStyle = ball.number === 8 ? "#111111" : "#203145";
        ctx.font = `700 ${Math.max(Math.round(10 * scale), 6)}px -apple-system`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(ball.number), frontX, frontY + 0.5);
      }
    }

    // Two equator dots at opposite sides for continuous rotation visibility
    for (const offset of [Math.PI * 0.5, Math.PI * 1.5]) {
      const dotPhase = rx + offset;
      const dotZ = Math.cos(dotPhase) * Math.cos(ry);
      if (dotZ > -0.1) {
        const dotX = Math.sin(dotPhase) * radius * 0.7;
        const dotY = Math.sin(ry) * radius * 0.55;
        const dotAlpha = Math.max(dotZ + 0.1, 0) * 0.5;
        ctx.beginPath();
        ctx.arc(dotX, dotY, radius * 0.15, 0, Math.PI * 2);
        ctx.fillStyle = ball.number === 8
          ? `rgba(255,255,255,${dotAlpha})`
          : `rgba(0,0,0,${dotAlpha})`;
        ctx.fill();
      }
    }
  } else if (ball.id === "cue") {
    // Blue dot orbits on cue ball
    if (frontZ > 0.05) {
      const scale = Math.min(frontZ * 1.3, 1);
      ctx.beginPath();
      ctx.arc(frontX, frontY, radius * 0.2 * scale, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(70, 130, 210, ${0.6 * scale})`;
      ctx.fill();
    }
    // Second red dot at opposite pole
    const backZ = Math.cos(rx + Math.PI) * Math.cos(ry + Math.PI);
    if (backZ > 0.05) {
      const bx = Math.sin(rx + Math.PI) * radius * 0.65;
      const by = Math.sin(ry + Math.PI) * radius * 0.65;
      const bs = Math.min(backZ * 1.3, 1);
      ctx.beginPath();
      ctx.arc(bx, by, radius * 0.15 * bs, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(210, 70, 70, ${0.5 * bs})`;
      ctx.fill();
    }
  }

  ctx.restore(); // un-clip, un-translate

  // 3. Fixed specular highlight — light source never moves
  ctx.beginPath();
  ctx.arc(ball.x - radius * 0.32, ball.y - radius * 0.35, radius * 0.26, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.fill();

  ctx.restore();
}

function makeBallGradient(ball, radius) {
  const baseColor =
    ball.suit === "stripes" ? "#f0ece0" :
    ball.number === 8 ? "#1c1c1c" :
    ball.color;
  const gradient = ctx.createRadialGradient(
    ball.x - radius * 0.42,
    ball.y - radius * 0.5,
    radius * 0.2,
    ball.x,
    ball.y,
    radius
  );
  gradient.addColorStop(0, lightenColor(baseColor, 0.4));
  gradient.addColorStop(0.55, baseColor);
  gradient.addColorStop(1, darkenColor(baseColor, 0.22));
  return gradient;
}

function getBallRadius(ball) {
  return roomState?.game?.table?.ballRadius || 12;
}

function drawAimGuide() {
  const cueBall = getCueBall();
  if (!cueBall) return;

  const radius = roomState?.game?.table?.ballRadius || 12;
  const power = isCharging ? currentPower : 0.3;
  const backLength = 20 + power * 40;
  const dirX = Math.cos(aimAngle);
  const dirY = Math.sin(aimAngle);

  // 1. Cue stick behind the ball
  ctx.beginPath();
  ctx.moveTo(
    cueBall.x - dirX * (22 + backLength),
    cueBall.y - dirY * (22 + backLength)
  );
  ctx.lineTo(cueBall.x - dirX * 18, cueBall.y - dirY * 18);
  ctx.strokeStyle = "rgba(168, 103, 62, 0.95)";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.stroke();

  // 2. Raycast: find first ball the aim line hits
  const balls = getDisplayedBalls().filter(
    (b) => b.id !== "cue" && !b.pocketed && !b.sinking
  );
  const contactRadius = radius * 2; // cue + target ball radii
  let closestT = Infinity;
  let targetBall = null;
  let ghostX = 0;
  let ghostY = 0;

  for (const ball of balls) {
    const dx = ball.x - cueBall.x;
    const dy = ball.y - cueBall.y;
    const proj = dx * dirX + dy * dirY;
    if (proj < contactRadius) continue; // behind or overlapping

    const perpX = cueBall.x + proj * dirX - ball.x;
    const perpY = cueBall.y + proj * dirY - ball.y;
    const perpDist = Math.hypot(perpX, perpY);
    if (perpDist >= contactRadius) continue; // ray misses

    const backUp = Math.sqrt(contactRadius * contactRadius - perpDist * perpDist);
    const contactT = proj - backUp;
    if (contactT > 0 && contactT < closestT) {
      closestT = contactT;
      targetBall = ball;
      ghostX = cueBall.x + contactT * dirX;
      ghostY = cueBall.y + contactT * dirY;
    }
  }

  if (targetBall) {
    // Check if target ball is a legal hit
    const myGroup = roomState.game.playerGroups[playerId];
    const isOpen = roomState.game.openTable || !myGroup;
    let legalHit = true;
    if (!isOpen) {
      const myRemaining = getDisplayedBalls().filter(
        (b) => b.suit === myGroup && !b.pocketed
      ).length;
      if (myRemaining > 0) {
        // Must hit own group — not opponent's group, not 8-ball
        legalHit = targetBall.suit === myGroup;
      } else {
        // All own balls cleared — must hit 8-ball
        legalHit = targetBall.number === 8;
      }
    }

    const lineColor = legalHit ? "rgba(255,255,255,0.55)" : "rgba(255,80,80,0.7)";
    const ghostColor = legalHit ? "rgba(255,255,255,0.45)" : "rgba(255,80,80,0.55)";
    const predColor = legalHit ? "rgba(255,200,80,0.55)" : "rgba(255,80,80,0.45)";
    const ringColor = legalHit ? "rgba(255,200,80,0.35)" : "rgba(255,80,80,0.4)";

    // 3a. Dotted line from cue ball to ghost position
    ctx.beginPath();
    ctx.moveTo(cueBall.x + dirX * 18, cueBall.y + dirY * 18);
    ctx.lineTo(ghostX, ghostY);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 3b. Ghost cue ball at contact point
    ctx.beginPath();
    ctx.arc(ghostX, ghostY, radius, 0, Math.PI * 2);
    ctx.strokeStyle = ghostColor;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = legalHit ? "rgba(255,255,255,0.08)" : "rgba(255,80,80,0.06)";
    ctx.fill();

    // 3c. Target ball deflection trajectory
    const defDx = targetBall.x - ghostX;
    const defDy = targetBall.y - ghostY;
    const defDist = Math.hypot(defDx, defDy);
    if (defDist > 0.5) {
      const defNx = defDx / defDist;
      const defNy = defDy / defDist;

      // Cut angle determines prediction error — harder cuts = less accurate guide
      const dot = dirX * defNx + dirY * defNy;
      const cutAngle = Math.acos(Math.max(-1, Math.min(1, dot)));
      const errorSign = (defNx * (-dirY) + defNy * dirX) > 0 ? 1 : -1;
      const errorAmount = cutAngle * 0.12 * errorSign;
      const predAngle = Math.atan2(defNy, defNx) + errorAmount;

      const predLen = 110 - cutAngle * 30; // shorter line for harder cuts
      ctx.beginPath();
      ctx.moveTo(targetBall.x, targetBall.y);
      ctx.lineTo(
        targetBall.x + Math.cos(predAngle) * Math.max(predLen, 40),
        targetBall.y + Math.sin(predAngle) * Math.max(predLen, 40)
      );
      ctx.strokeStyle = predColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Small ring indicator on target ball
      ctx.beginPath();
      ctx.arc(targetBall.x, targetBall.y, radius + 3, 0, Math.PI * 2);
      ctx.strokeStyle = ringColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 3d. Cue ball deflection after contact (thinner, fainter)
      const cueDeflectX = dirX - defNx * dot;
      const cueDeflectY = dirY - defNy * dot;
      const cueDeflectDist = Math.hypot(cueDeflectX, cueDeflectY);
      if (cueDeflectDist > 0.01 && dot < 0.98) {
        const cdNx = cueDeflectX / cueDeflectDist;
        const cdNy = cueDeflectY / cueDeflectDist;
        ctx.beginPath();
        ctx.moveTo(ghostX, ghostY);
        ctx.lineTo(ghostX + cdNx * 60, ghostY + cdNy * 60);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  } else {
    // 3. No target — line extends to table edge or max distance
    const maxLen = 400;
    ctx.beginPath();
    ctx.moveTo(cueBall.x + dirX * 18, cueBall.y + dirY * 18);
    ctx.lineTo(cueBall.x + dirX * maxLen, cueBall.y + dirY * maxLen);
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawBallInHandOverlay() {
  // Ghost cue ball at mouse position
  if (placementPos) {
    const radius = roomState?.game?.table?.ballRadius || 12;
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.arc(placementPos.x, placementPos.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#f8f4ea";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // Prompt text
  ctx.fillStyle = "rgba(16, 33, 58, 0.6)";
  roundRect(ctx, canvas.width / 2 - 180, canvas.height / 2 - 24, 360, 48, 14);
  ctx.fill();
  ctx.fillStyle = "#f4fbff";
  ctx.font = "700 16px -apple-system";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Ball-in-hand: click to place, or Space to keep", canvas.width / 2, canvas.height / 2);
}

function drawCenterMessage(text) {
  ctx.fillStyle = "rgba(16, 33, 58, 0.46)";
  roundRect(ctx, 248, 216, 464, 92, 18);
  ctx.fill();
  ctx.fillStyle = "#f4fbff";
  ctx.font = "700 24px -apple-system";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY,
  };
}

function syncAnimationState(data, forceReset = false) {
  if (!data?.game) {
    displayedBalls = null;
    return;
  }

  if (forceReset) {
    cancelAnimation();
    animatedShotId = data.game.shotId || 0;
    displayedBalls = data.game.balls;
    return;
  }

  const hasNewShot =
    Number.isFinite(data.game.shotId) &&
    data.game.shotId > animatedShotId &&
    Array.isArray(data.game.lastShotFrames) &&
    data.game.lastShotFrames.length > 1;

  if (!hasNewShot) {
    // Don't overwrite displayedBalls while an animation is playing —
    // the REST response arrives after SSE already started the animation.
    if (!animationTimer) {
      displayedBalls = data.game.balls;
    }
    return;
  }

  animatedShotId = data.game.shotId;
  playAnimation(data.game.lastShotFrames, data.game.balls);
}

function playAnimation(frames, finalBalls) {
  cancelAnimation();
  if (frames.length < 2) {
    displayedBalls = finalBalls;
    render();
    return;
  }

  const MS_PER_FRAME = 16;
  const totalDuration = frames.length * MS_PER_FRAME;
  const startTime = performance.now();

  const step = (now) => {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / totalDuration, 1);
    const floatIndex = t * (frames.length - 1);
    const lo = Math.floor(floatIndex);
    const hi = Math.min(lo + 1, frames.length - 1);
    const alpha = floatIndex - lo;
    const frameA = frames[lo];
    const frameB = frames[hi];

    displayedBalls = frameA.map((ball, i) => {
      const ballB = frameB[i];
      if (!ballB || ball.pocketed) {
        return ball;
      }
      return {
        ...ball,
        x: ball.x + (ballB.x - ball.x) * alpha,
        y: ball.y + (ballB.y - ball.y) * alpha,
        sinkProgress: ball.sinkProgress + (ballB.sinkProgress - ball.sinkProgress) * alpha,
        rollX: (ball.rollX || 0) + ((ballB.rollX || 0) - (ball.rollX || 0)) * alpha,
        rollY: (ball.rollY || 0) + ((ballB.rollY || 0) - (ball.rollY || 0)) * alpha,
      };
    });

    render();

    if (t < 1) {
      animationTimer = requestAnimationFrame(step);
    } else {
      animationTimer = 0;
      displayedBalls = finalBalls;
      render();
    }
  };

  animationTimer = requestAnimationFrame(step);
}

function cancelAnimation() {
  if (animationTimer) {
    cancelAnimationFrame(animationTimer);
    animationTimer = 0;
  }
}

function getPlayerName() {
  const name = nameInput.value.trim().slice(0, 24) || "Player";
  nameInput.value = name;
  localStorage.setItem(STORAGE_KEYS.name, name);
  return name;
}

function updateUrl(roomId) {
  const url = new URL(window.location.href);
  if (roomId) {
    url.searchParams.set("room", roomId);
  } else {
    url.searchParams.delete("room");
  }
  history.replaceState({}, "", url);
}

function getInviteUrl(roomId) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

function toggleBusy(nextBusy) {
  quickMatchButton.disabled = nextBusy;
  computerButton.disabled = nextBusy;
  createPrivateButton.disabled = nextBusy;
  joinRoomButton.disabled = nextBusy;
  restartButton.disabled = nextBusy || !roomState;
}

function showMessage(text, tone = "info") {
  messageBox.className = `message ${tone}`;
  messageBox.textContent = text;
  messageBox.classList.remove("hidden");
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function lightenColor(hex, amount) {
  return mixColor(hex, "#ffffff", amount);
}

function darkenColor(hex, amount) {
  return mixColor(hex, "#000000", amount);
}

function mixColor(baseHex, targetHex, amount) {
  const base = hexToRgb(baseHex);
  const target = hexToRgb(targetHex);
  const clamped = Math.max(0, Math.min(1, amount));
  return `rgb(${
    Math.round(base.r + (target.r - base.r) * clamped)
  }, ${
    Math.round(base.g + (target.g - base.g) * clamped)
  }, ${
    Math.round(base.b + (target.b - base.b) * clamped)
  })`;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((piece) => piece + piece)
          .join("")
      : normalized;
  const parsed = Number.parseInt(value, 16);
  return {
    r: (parsed >> 16) & 255,
    g: (parsed >> 8) & 255,
    b: parsed & 255,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
