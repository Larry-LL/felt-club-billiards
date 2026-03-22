const STORAGE_KEYS = {
  name: "felt-club-name",
  playerId: "felt-club-player-id",
  roomId: "felt-club-room-id",
};

const nameInput = document.getElementById("nameInput");
const roomInput = document.getElementById("roomInput");
const createRoomButton = document.getElementById("createRoomButton");
const computerButton = document.getElementById("computerButton");
const practiceButton = document.getElementById("practiceButton");
const joinRoomButton = document.getElementById("joinRoomButton");
const restartButton = document.getElementById("restartButton");
const copyInviteButton = document.getElementById("copyInviteButton");
const roomHeadline = document.getElementById("roomHeadline");
const statusText = document.getElementById("statusText");
const roomCode = document.getElementById("roomCode");
const turnText = document.getElementById("turnText");
const shotCount = document.getElementById("shotCount");
const modeText = document.getElementById("modeText");
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
let animationFrameId = 0;
let animatedShotId = 0;
let aimState = {
  active: false,
  hover: false,
  pointerX: 0,
  pointerY: 0,
};

initialize();

function initialize() {
  const roomIdFromUrl = new URL(window.location.href).searchParams.get("room");
  nameInput.value = localStorage.getItem(STORAGE_KEYS.name) || "";
  roomInput.value = roomIdFromUrl || localStorage.getItem(STORAGE_KEYS.roomId) || "";

  createRoomButton.addEventListener("click", () => createRoom("multiplayer"));
  computerButton.addEventListener("click", () => createRoom("ai"));
  practiceButton.addEventListener("click", () => createRoom("practice"));
  joinRoomButton.addEventListener("click", joinRoom);
  restartButton.addEventListener("click", restartRack);
  copyInviteButton.addEventListener("click", copyInviteLink);

  canvas.addEventListener("pointerdown", beginAim);
  canvas.addEventListener("pointermove", trackPointer);
  canvas.addEventListener("pointerleave", clearAimPreview);
  window.addEventListener("pointerup", releaseAim);
  window.addEventListener("beforeunload", closeEventStream);

  render();

  if (roomInput.value.trim()) {
    reconnectToRoom(roomInput.value.trim().toUpperCase());
  }
}

async function createRoom(mode) {
  const name = getPlayerName();
  toggleBusy(true);

  try {
    const data = await request("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name,
        playerId,
        mode,
      }),
    });

    handleJoinedRoom(data);
    showMessage(
      mode === "practice"
        ? "Practice table ready. You can shoot immediately."
        : mode === "ai"
          ? "Computer match ready. Break first and the house bot will answer automatically."
        : "Room created. Send the invite link to your friend.",
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
    showMessage("You joined the table. Line up your first shot when your turn arrives.", "success");
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
    showMessage("That saved room is no longer available. Create a new one to play.", "error");
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
  syncAnimationState(data);
  render();
}

function connectEventStream(roomId) {
  closeEventStream();

  eventSource = new EventSource(
    `/api/rooms/${roomId}/events?playerId=${encodeURIComponent(playerId)}`
  );

  eventSource.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    roomState = {
      ...payload,
      you: payload.players.find((player) => player.id === playerId) || roomState?.you || null,
    };
    syncAnimationState(roomState);
    render();
  };

  eventSource.onerror = () => {
    statusText.textContent = "Trying to reconnect to the room...";
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
  if (!roomState) {
    return;
  }

  const inviteUrl = getInviteUrl(roomState.roomId);
  await navigator.clipboard.writeText(inviteUrl);
  showMessage("Invite link copied. Send it to your friend.", "success");
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
  const distance = Math.hypot(point.x - cueBall.x, point.y - cueBall.y);
  if (distance > 60) {
    return;
  }

  aimState.active = true;
  aimState.hover = true;
  aimState.pointerX = point.x;
  aimState.pointerY = point.y;
  render();
}

function trackPointer(event) {
  if (!roomState || !canShoot()) {
    aimState.hover = false;
    if (!aimState.active) {
      render();
    }
    return;
  }

  const point = getCanvasPoint(event);
  aimState.hover = true;
  aimState.pointerX = point.x;
  aimState.pointerY = point.y;
  render();
}

function clearAimPreview() {
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

  try {
    toggleBusy(true);
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
  if (!roomState || !roomState.you) {
    return false;
  }

  return (
    roomState.game.currentTurnPlayerId === playerId &&
    !roomState.game.winnerId &&
    !roomState.game.isSimulating &&
    !roomState.game.isAiThinking
  );
}

function isPracticeMode() {
  return roomState?.mode === "practice";
}

function isComputerMode() {
  return roomState?.mode === "ai";
}

function getCueBall() {
  return getRenderedBalls().find((ball) => ball.id === "cue" && !ball.pocketed) || null;
}

function getAimVector() {
  const cueBall = getCueBall();
  if (!cueBall || (!aimState.active && !aimState.hover)) {
    return null;
  }

  const dx = cueBall.x - aimState.pointerX;
  const dy = cueBall.y - aimState.pointerY;
  const dragDistance = Math.min(Math.hypot(dx, dy), 190);
  if (dragDistance < 2) {
    return null;
  }

  const angle = Math.atan2(dy, dx);
  return {
    cueBall,
    angle,
    dragDistance,
    power: dragDistance / 190,
  };
}

function render() {
  renderHeader();
  renderScoreboard();
  renderTable();
}

function renderHeader() {
  const roomId = roomState?.roomId || "-";
  roomCode.textContent = roomId;
  roomHeadline.textContent = roomState
    ? `${isPracticeMode() ? "Practice" : "Room"} ${roomState.roomId}`
    : "No room yet";
  shotCount.textContent = String(roomState?.game?.shotCount || 0);
  modeText.textContent = roomState
    ? isPracticeMode()
      ? "Solo"
      : isComputerMode()
        ? "CPU"
        : "Versus"
    : "Mode";
  copyInviteButton.disabled = !roomState || roomState.mode !== "multiplayer";
  restartButton.disabled = !roomState;

  if (!roomState) {
    turnText.textContent = "Waiting";
    statusText.textContent = "Create a multiplayer table, or open a solo practice session.";
    return;
  }

  const currentPlayer = roomState.players.find(
    (player) => player.id === roomState.game.currentTurnPlayerId
  );
  const winner = roomState.players.find((player) => player.id === roomState.game.winnerId);

  if (winner) {
    turnText.textContent = `${winner.name} won`;
  } else if (currentPlayer) {
    turnText.textContent = isPracticeMode() ? "Your turn" : `${currentPlayer.name}'s turn`;
  } else {
    turnText.textContent = "Waiting";
  }

  statusText.textContent = roomState.game.statusMessage;
}

function renderScoreboard() {
  if (!roomState) {
    scoreboard.innerHTML = `
      <article class="player-card">
        <h3>Open a table</h3>
        <p>Choose Practice Solo, Play Computer, or create a room for a friend.</p>
      </article>
    `;
    return;
  }

  scoreboard.innerHTML = roomState.players
    .map((player) => {
      const activeClass = player.id === roomState.game.currentTurnPlayerId ? "active" : "";
      const me = player.isComputer
        ? "Computer"
        : player.id === playerId
          ? isPracticeMode()
            ? "Practice"
            : "You"
          : "Friend";
      const status = player.isComputer
        ? roomState.game.isAiThinking
          ? "Thinking"
          : "Ready"
        : isPracticeMode()
          ? "Solo session"
          : player.connected
            ? "Online"
            : "Away";
      return `
        <article class="player-card ${activeClass}">
          <div class="player-meta">
            <span>${escapeHtml(me)}</span>
            <strong>${escapeHtml(player.name)}</strong>
          </div>
          <div class="player-points">
            <span>${escapeHtml(status)}</span>
            <strong>${player.score}</strong>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderTable() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawTable();

  const balls = getRenderedBalls();
  balls.forEach(drawBallShadow);
  balls.forEach(drawBall);

  if (canShoot()) {
    drawAimGuide();
  }

  drawGuidanceOverlay();

  if (!roomState) {
    drawTableMessage("Create a room or practice table to rack the balls.");
    return;
  }

  if (!isPracticeMode() && !isComputerMode() && roomState.players.length < 2) {
    drawTableMessage("Waiting for a second player to join.");
    return;
  }

  if (!canShoot() && !roomState.game.winnerId) {
    const turnPlayer = roomState.players.find(
      (player) => player.id === roomState.game.currentTurnPlayerId
    );
    drawTableMessage(
      roomState.game.isAiThinking
        ? "House Bot is lining up a shot."
        : turnPlayer?.id === playerId
        ? "Shot in progress..."
        : `${turnPlayer?.name || "Opponent"} is lining up a shot.`
    );
  }

  if (roomState.game.winnerId) {
    const winner = roomState.players.find((player) => player.id === roomState.game.winnerId);
    drawTableMessage(`${winner?.name || "A player"} wins the rack. Start a new one anytime.`);
  }
}

function drawTable() {
  ctx.fillStyle = "#26170f";
  roundRect(ctx, 0, 0, canvas.width, canvas.height, 30);
  ctx.fill();

  const tableGradient = ctx.createLinearGradient(0, 24, 0, canvas.height - 24);
  tableGradient.addColorStop(0, "#1a7656");
  tableGradient.addColorStop(0.4, "#0f5c41");
  tableGradient.addColorStop(1, "#0c4631");
  ctx.fillStyle = tableGradient;
  roundRect(ctx, 24, 24, canvas.width - 48, canvas.height - 48, 24);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 2;
  ctx.strokeRect(96, 24, 1, canvas.height - 48);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.beginPath();
  ctx.arc(192, canvas.height / 2, 88, 0, Math.PI * 2);
  ctx.stroke();

  const pockets = roomState?.game?.table?.pockets || DEFAULT_POCKETS;
  pockets.forEach((pocket) => {
    const rim = ctx.createRadialGradient(pocket.x, pocket.y, 6, pocket.x, pocket.y, 24);
    rim.addColorStop(0, "#050404");
    rim.addColorStop(1, "#2f1f18");
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

  const radius = getBallRenderRadius(ball);
  const opacity = ball.sinking ? 0.26 * (1 - ball.sinkProgress * 0.6) : 0.26;
  const shadow = ctx.createRadialGradient(ball.x + 3, ball.y + 5, 3, ball.x + 3, ball.y + 5, radius + 5);
  shadow.addColorStop(0, `rgba(0, 0, 0, ${opacity})`);
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

  const radius = getBallRenderRadius(ball);
  const alpha = ball.sinking ? 1 - ball.sinkProgress * 0.7 : 1;
  const base = ctx.createRadialGradient(
    ball.x - radius * 0.45,
    ball.y - radius * 0.5,
    radius * 0.2,
    ball.x,
    ball.y,
    radius
  );
  base.addColorStop(0, lightenColor(ball.color, 0.35));
  base.addColorStop(0.55, ball.color);
  base.addColorStop(1, darkenColor(ball.color, 0.28));

  ctx.beginPath();
  ctx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = base;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.stroke();

  if (ball.kind === "object") {
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, radius * 0.48, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(251, 247, 240, 0.96)";
    ctx.fill();

    ctx.fillStyle = "#4b3024";
    ctx.font = "700 10px Barlow";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ball.label, ball.x, ball.y + 0.5);
  }

  ctx.beginPath();
  ctx.arc(ball.x - radius * 0.32, ball.y - radius * 0.36, radius * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.34)";
  ctx.fill();
  ctx.restore();
}

function drawAimGuide() {
  const vector = getAimVector();
  const cueBall = getCueBall();
  if (!cueBall || !vector) {
    return;
  }

  const angle = vector.angle;
  const power = vector.power;
  const guideLength = 180 + power * 70;
  const backLength = 18 + power * 44;
  const startX = cueBall.x + Math.cos(angle) * 18;
  const startY = cueBall.y + Math.sin(angle) * 18;
  const endX = cueBall.x + Math.cos(angle) * guideLength;
  const endY = cueBall.y + Math.sin(angle) * guideLength;
  const cueStickX = cueBall.x - Math.cos(angle) * (34 + backLength);
  const cueStickY = cueBall.y - Math.sin(angle) * (34 + backLength);

  ctx.beginPath();
  ctx.moveTo(cueStickX, cueStickY);
  ctx.lineTo(cueBall.x - Math.cos(angle) * 18, cueBall.y - Math.sin(angle) * 18);
  ctx.strokeStyle = "rgba(111, 73, 47, 0.92)";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.strokeStyle = aimState.active ? "rgba(255, 246, 201, 0.92)" : "rgba(255, 246, 201, 0.62)";
  ctx.lineWidth = aimState.active ? 3 : 2;
  ctx.setLineDash([10, 8]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(endX, endY, 7, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 246, 201, 0.3)";
  ctx.fill();

  ctx.fillStyle = "rgba(10, 9, 8, 0.76)";
  roundRect(ctx, 26, canvas.height - 68, 260, 40, 14);
  ctx.fill();
  ctx.fillStyle = "#fef8ea";
  ctx.font = "600 14px Barlow";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(
    `Pull back from cue ball${vector ? `  •  Power ${Math.round(power * 100)}%` : ""}`,
    40,
    canvas.height - 48
  );
}

function drawGuidanceOverlay() {
  ctx.fillStyle = "rgba(10, 9, 8, 0.62)";
  roundRect(ctx, canvas.width - 280, 28, 232, 74, 16);
  ctx.fill();
  ctx.fillStyle = "#fef8ea";
  ctx.font = "600 13px Barlow";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("How to shoot", canvas.width - 258, 42);
  ctx.font = "500 12px Barlow";
  ctx.fillStyle = "rgba(254, 248, 234, 0.82)";
  ctx.fillText("1. Start on the cue ball", canvas.width - 258, 62);
  ctx.fillText("2. Drag backward to set power", canvas.width - 258, 78);
  ctx.fillText("3. Release to send it forward", canvas.width - 258, 94);
}

function drawTableMessage(text) {
  ctx.fillStyle = "rgba(9, 9, 9, 0.52)";
  roundRect(ctx, 248, 216, 464, 92, 18);
  ctx.fill();
  ctx.fillStyle = "#fef8ea";
  ctx.font = "600 24px Fraunces";
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
  computerButton.disabled = nextBusy;
  practiceButton.disabled = nextBusy;
  joinRoomButton.disabled = nextBusy;
  restartButton.disabled = nextBusy || !roomState;
}

function getRenderedBalls() {
  return displayedBalls || roomState?.game?.balls || [];
}

function getBallRenderRadius(ball) {
  const baseRadius = roomState?.game?.table?.ballRadius || 12;
  if (!ball.sinking) {
    return baseRadius;
  }

  return Math.max(baseRadius * (1 - ball.sinkProgress * 0.55), 2);
}

function syncAnimationState(data, forceReset = false) {
  if (!data?.game) {
    displayedBalls = null;
    return;
  }

  if (forceReset) {
    animatedShotId = data.game.shotId || 0;
    displayedBalls = data.game.balls;
    cancelActiveAnimation();
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
  playShotAnimation(data.game.lastShotFrames, data.game.balls);
}

function playShotAnimation(frames, finalBalls) {
  cancelActiveAnimation();

  let index = 0;
  const step = () => {
    displayedBalls = frames[index] || finalBalls;
    render();
    index += 1;

    if (index < frames.length) {
      animationFrameId = window.setTimeout(step, 16);
      return;
    }

    displayedBalls = finalBalls;
    animationFrameId = 0;
    render();
  };

  step();
}

function cancelActiveAnimation() {
  if (animationFrameId) {
    window.clearTimeout(animationFrameId);
    animationFrameId = 0;
  }
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
  const mixed = {
    r: Math.round(base.r + (target.r - base.r) * clamped),
    g: Math.round(base.g + (target.g - base.g) * clamped),
    b: Math.round(base.b + (target.b - base.b) * clamped),
  };
  return `rgb(${mixed.r}, ${mixed.g}, ${mixed.b})`;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const value = normalized.length === 3
    ? normalized
        .split("")
        .map((part) => part + part)
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
