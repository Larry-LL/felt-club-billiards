const STORAGE_KEYS = {
  name: "felt-club-name",
  playerId: "felt-club-player-id",
  roomId: "felt-club-room-id",
};

const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const createRoomButton = document.getElementById("createRoomButton");
const joinRoomButton = document.getElementById("joinRoomButton");
const computerButton = document.getElementById("computerButton");
const practiceButton = document.getElementById("practiceButton");
const restartButton = document.getElementById("restartButton");
const copyInviteButton = document.getElementById("copyInviteButton");
const roomHeadline = document.getElementById("roomHeadline");
const statusText = document.getElementById("statusText");
const roomCode = document.getElementById("roomCode");
const modeText = document.getElementById("modeText");
const turnText = document.getElementById("turnText");
const tableStateText = document.getElementById("tableStateText");
const scoreboard = document.getElementById("scoreboard");
const messageBox = document.getElementById("message");
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
let aimState = {
  active: false,
  hover: false,
  x: 0,
  y: 0,
};

initialize();

function initialize() {
  const roomIdFromUrl = new URL(window.location.href).searchParams.get("room");
  nameInput.value = localStorage.getItem(STORAGE_KEYS.name) || "";
  roomInput.value = roomIdFromUrl || localStorage.getItem(STORAGE_KEYS.roomId) || "";

  createRoomButton.addEventListener("click", () => createRoom("multiplayer"));
  joinRoomButton.addEventListener("click", joinRoom);
  computerButton.addEventListener("click", () => createRoom("ai"));
  practiceButton.addEventListener("click", () => createRoom("practice"));
  restartButton.addEventListener("click", restartRack);
  copyInviteButton.addEventListener("click", copyInviteLink);

  canvas.addEventListener("pointerdown", beginAim);
  canvas.addEventListener("pointermove", moveAim);
  canvas.addEventListener("pointerleave", clearAim);
  window.addEventListener("pointerup", releaseAim);
  window.addEventListener("beforeunload", closeEventStream);

  render();

  if (roomInput.value.trim()) {
    reconnectToRoom(roomInput.value.trim().toUpperCase());
  }
}

async function createRoom(mode) {
  toggleBusy(true);
  try {
    const data = await request("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: getPlayerName(),
        playerId,
        mode,
      }),
    });
    handleJoinedRoom(data);
    showMessage(
      mode === "practice"
        ? "Practice table ready. Open table rules are shown, but practice never ends the rack."
        : mode === "ai"
          ? "Computer room ready. House Bot follows the same 8-ball rules."
          : "Room created. Copy the room link and send it to the other player.",
      "success"
    );
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    toggleBusy(false);
  }
}

async function joinRoom() {
  const roomId = roomInput.value.trim().toUpperCase();
  if (!roomId) {
    showMessage("Enter a room code before joining.", "error");
    return;
  }

  toggleBusy(true);
  try {
    const data = await request(`/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify({
        name: getPlayerName(),
        playerId,
      }),
    });
    handleJoinedRoom(data);
    showMessage("Joined the room. The rack is live and synced through this server.", "success");
  } catch (error) {
    showMessage(error.message, "error");
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
  render();
}

function connectEventStream(roomId) {
  closeEventStream();
  eventSource = new EventSource(`/api/rooms/${roomId}/events?playerId=${encodeURIComponent(playerId)}`);
  eventSource.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    roomState = {
      ...payload,
      you: payload.players.find((player) => player.id === playerId) || roomState?.you || null,
    };
    syncAnimationState(roomState);
    render();
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

function beginAim(event) {
  if (!canShoot()) {
    return;
  }

  const cueBall = getCueBall();
  if (!cueBall) {
    return;
  }

  const point = getCanvasPoint(event);
  if (Math.hypot(point.x - cueBall.x, point.y - cueBall.y) > 64) {
    return;
  }

  aimState.active = true;
  aimState.hover = true;
  aimState.x = point.x;
  aimState.y = point.y;
  render();
}

function moveAim(event) {
  if (!roomState || !canShoot()) {
    aimState.hover = false;
    if (!aimState.active) {
      render();
    }
    return;
  }

  const point = getCanvasPoint(event);
  aimState.hover = true;
  aimState.x = point.x;
  aimState.y = point.y;
  render();
}

function clearAim() {
  aimState.hover = false;
  if (!aimState.active) {
    render();
  }
}

async function releaseAim(event) {
  if (!aimState.active || !canShoot()) {
    aimState.active = false;
    render();
    return;
  }

  const cueBall = getCueBall();
  const point = getCanvasPoint(event);
  const dx = cueBall.x - point.x;
  const dy = cueBall.y - point.y;
  const dragDistance = Math.min(Math.hypot(dx, dy), 190);
  aimState.active = false;
  render();

  if (dragDistance < 18) {
    return;
  }

  toggleBusy(true);
  try {
    const data = await request(`/api/rooms/${roomState.roomId}/shots`, {
      method: "POST",
      body: JSON.stringify({
        playerId,
        angle: Math.atan2(dy, dx),
        power: dragDistance / 190,
      }),
    });
    roomState = data;
    syncAnimationState(roomState);
    render();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
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

function getAimVector() {
  const cueBall = getCueBall();
  if (!cueBall || (!aimState.active && !aimState.hover)) {
    return null;
  }

  const dx = cueBall.x - aimState.x;
  const dy = cueBall.y - aimState.y;
  const dragDistance = Math.min(Math.hypot(dx, dy), 190);
  if (dragDistance < 2) {
    return null;
  }

  return {
    angle: Math.atan2(dy, dx),
    power: dragDistance / 190,
  };
}

function render() {
  renderHeader();
  renderScoreboard();
  renderTable();
}

function renderHeader() {
  roomHeadline.textContent = roomState
    ? `${roomState.mode === "practice" ? "Practice" : roomState.mode === "ai" ? "CPU Match" : "Online Room"} ${roomState.roomId}`
    : "No room yet";
  statusText.textContent = roomState
    ? roomState.game.statusMessage
    : "Create a room, copy the link, and let someone join from anywhere this server is reachable.";
  roomCode.textContent = roomState?.roomId || "-";
  modeText.textContent = roomState
    ? roomState.mode === "practice"
      ? "Practice"
      : roomState.mode === "ai"
        ? "CPU"
        : "Online"
    : "Mode";
  turnText.textContent = getTurnLabel();
  tableStateText.textContent = getTableStateLabel();
  copyInviteButton.disabled = !roomState || roomState.mode !== "multiplayer";
  restartButton.disabled = !roomState;
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
    scoreboard.innerHTML = `
      <article class="player-card">
        <div class="player-meta">
          <span>Multiplayer</span>
          <strong>Room-based sync</strong>
        </div>
        <div class="player-points">
          <span>Online</span>
          <strong>Ready</strong>
        </div>
      </article>
    `;
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

  if (canShoot()) {
    drawAimGuide();
  }

  drawInstructionOverlay();

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
  } else if (!canShoot() && (roomState.game.isSimulating || roomState.game.isAiThinking)) {
    drawCenterMessage(roomState.game.isAiThinking ? "House Bot is reading the table." : "Shot resolving...");
  }
}

function drawTable() {
  ctx.fillStyle = "#7a4f38";
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 28);
  ctx.fill();

  const felt = ctx.createLinearGradient(0, 24, 0, canvas.height - 24);
  felt.addColorStop(0, "#20c997");
  felt.addColorStop(0.45, "#0fa37f");
  felt.addColorStop(1, "#087a61");
  ctx.fillStyle = felt;
  roundRect(ctx, 24, 24, canvas.width - 48, canvas.height - 48, 22);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 2;
  ctx.strokeRect(96, 24, 1, canvas.height - 48);
  ctx.beginPath();
  ctx.arc(192, canvas.height / 2, 88, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.stroke();

  const pockets = roomState?.game?.table?.pockets || DEFAULT_POCKETS;
  pockets.forEach((pocket) => {
    const rim = ctx.createRadialGradient(pocket.x, pocket.y, 5, pocket.x, pocket.y, 24);
    rim.addColorStop(0, "#080808");
    rim.addColorStop(1, "#372218");
    ctx.beginPath();
    ctx.arc(pocket.x, pocket.y, 24, 0, Math.PI * 2);
    ctx.fillStyle = rim;
    ctx.fill();
  });
}

function drawBallShadow(ball) {
  if (ball.pocketed && ball.id !== "cue") {
    return;
  }

  const radius = getBallRadius(ball);
  const alpha = ball.sinking ? 0.18 : 0.24;
  const shadow = ctx.createRadialGradient(ball.x + 3, ball.y + 5, 3, ball.x + 3, ball.y + 5, radius + 5);
  shadow.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
  shadow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.beginPath();
  ctx.arc(ball.x + 3, ball.y + 5, radius + 4, 0, Math.PI * 2);
  ctx.fillStyle = shadow;
  ctx.fill();
}

function drawBall(ball) {
  if (ball.pocketed && ball.id !== "cue") {
    return;
  }

  const radius = getBallRadius(ball);
  const alpha = ball.sinking ? 1 - ball.sinkProgress * 0.75 : 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = makeBallGradient(ball, radius);
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.stroke();

  if (ball.suit === "stripes") {
    ctx.save();
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = ball.color;
    ctx.fillRect(ball.x - radius, ball.y - radius * 0.4, radius * 2, radius * 0.8);
    ctx.restore();
  }

  if (ball.kind === "object") {
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, radius * 0.47, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.96)";
    ctx.fill();
    ctx.fillStyle = ball.number === 8 ? "#111111" : "#203145";
    ctx.font = "700 10px -apple-system";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(ball.number), ball.x, ball.y + 0.5);
  }

  ctx.beginPath();
  ctx.arc(ball.x - radius * 0.32, ball.y - radius * 0.35, radius * 0.26, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.fill();
  ctx.restore();
}

function makeBallGradient(ball, radius) {
  const gradient = ctx.createRadialGradient(
    ball.x - radius * 0.42,
    ball.y - radius * 0.5,
    radius * 0.2,
    ball.x,
    ball.y,
    radius
  );
  gradient.addColorStop(0, lightenColor(ball.color, 0.36));
  gradient.addColorStop(0.55, ball.number === 8 ? "#1c1c1c" : ball.color);
  gradient.addColorStop(1, darkenColor(ball.number === 8 ? "#1c1c1c" : ball.color, 0.28));
  return gradient;
}

function getBallRadius(ball) {
  const base = roomState?.game?.table?.ballRadius || 12;
  if (!ball.sinking) {
    return base;
  }
  return Math.max(base * (1 - ball.sinkProgress * 0.55), 2);
}

function drawAimGuide() {
  const vector = getAimVector();
  const cueBall = getCueBall();
  if (!vector || !cueBall) {
    return;
  }

  const guideLength = 180 + vector.power * 70;
  const backLength = 20 + vector.power * 40;
  const angle = vector.angle;
  const endX = cueBall.x + Math.cos(angle) * guideLength;
  const endY = cueBall.y + Math.sin(angle) * guideLength;

  ctx.beginPath();
  ctx.moveTo(cueBall.x - Math.cos(angle) * (22 + backLength), cueBall.y - Math.sin(angle) * (22 + backLength));
  ctx.lineTo(cueBall.x - Math.cos(angle) * 18, cueBall.y - Math.sin(angle) * 18);
  ctx.strokeStyle = "rgba(168, 103, 62, 0.95)";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cueBall.x + Math.cos(angle) * 18, cueBall.y + Math.sin(angle) * 18);
  ctx.lineTo(endX, endY);
  ctx.strokeStyle = "rgba(255,255,255,0.78)";
  ctx.lineWidth = aimState.active ? 3 : 2;
  ctx.setLineDash([10, 8]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawInstructionOverlay() {
  ctx.fillStyle = "rgba(16, 33, 58, 0.44)";
  roundRect(ctx, canvas.width - 318, 26, 270, 110, 18);
  ctx.fill();
  ctx.fillStyle = "#f4fbff";
  ctx.font = "700 13px -apple-system";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("8-ball controls", canvas.width - 292, 42);
  ctx.font = "500 12px -apple-system";
  ctx.fillText("1. Start your drag on the cue ball", canvas.width - 292, 64);
  ctx.fillText("2. Pull backward to set direction and power", canvas.width - 292, 82);
  ctx.fillText("3. Release to fire the shot", canvas.width - 292, 100);
  ctx.fillText("4. Clear your suit before the 8-ball", canvas.width - 292, 118);
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
    displayedBalls = data.game.balls;
    return;
  }

  animatedShotId = data.game.shotId;
  playAnimation(data.game.lastShotFrames, data.game.balls);
}

function playAnimation(frames, finalBalls) {
  cancelAnimation();
  let index = 0;

  const step = () => {
    displayedBalls = frames[index] || finalBalls;
    render();
    index += 1;
    if (index < frames.length) {
      animationTimer = window.setTimeout(step, 16);
      return;
    }
    animationTimer = 0;
    displayedBalls = finalBalls;
    render();
  };

  step();
}

function cancelAnimation() {
  if (animationTimer) {
    window.clearTimeout(animationTimer);
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
  createRoomButton.disabled = nextBusy;
  joinRoomButton.disabled = nextBusy;
  computerButton.disabled = nextBusy;
  practiceButton.disabled = nextBusy;
  restartButton.disabled = nextBusy || !roomState;
}

function showMessage(text, tone = "info") {
  messageBox.className = `message ${tone}`;
  messageBox.textContent = text;
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
