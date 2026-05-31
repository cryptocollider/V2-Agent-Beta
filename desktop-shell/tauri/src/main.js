const phasePill = document.getElementById("phasePill");
const statusMessage = document.getElementById("statusMessage");
const statusMeta = document.getElementById("statusMeta");
const modeValue = document.getElementById("modeValue");
const dataDirValue = document.getElementById("dataDirValue");
const staticDirValue = document.getElementById("staticDirValue");
const statusLog = document.getElementById("statusLog");
const retryBtn = document.getElementById("retryBtn");
const browserLink = document.getElementById("browserLink");
const footnote = document.getElementById("footnote");
const titlebar = document.querySelector(".titlebar");
const titlebarBrand = document.querySelector(".titlebar-brand");
const titlebarDragfill = document.querySelector(".titlebar-dragfill");
const windowMinBtn = document.getElementById("windowMinBtn");
const windowMaxBtn = document.getElementById("windowMaxBtn");
const windowCloseBtn = document.getElementById("windowCloseBtn");
let desktopDragSession = null;
let desktopMoveInFlight = false;
let desktopPendingMove = { dx: 0, dy: 0 };

let redirecting = false;

function setStatus(status) {
  const phase = String(status?.phase || "booting").toUpperCase();
  const message = String(status?.message || "Preparing the local Agent 1 runtime.");
  const mode = String(status?.mode || "starting");
  const dataDir = String(status?.dataDir || "...");
  const staticDir = String(status?.staticDir || "...");
  const url = String(status?.url || "http://127.0.0.1:8787");
  const lastError = status?.lastError ? String(status.lastError) : "";
  const logLines = Array.isArray(status?.log) ? status.log.map((line) => String(line || "").trim()).filter(Boolean) : [];

  phasePill.textContent = phase;
  phasePill.dataset.phase = String(status?.phase || "booting");
  statusMessage.textContent = message;
  statusMeta.textContent = lastError || `Monitor URL: ${url}`;
  modeValue.textContent = mode;
  dataDirValue.textContent = dataDir;
  staticDirValue.textContent = staticDir;
  browserLink.href = url;
  footnote.textContent = status?.phase === "error"
    ? "Agent 1 did not come up cleanly yet. Retry after fixing the runtime message above."
    : "The shell will switch into the full Agent 1 monitor as soon as the local service is ready.";

  if (statusLog) {
    statusLog.innerHTML = logLines.length
      ? logLines.map((line) => `<div class="startup-log-row">${escapeHtml(line)}</div>`).join("")
      : `<div class="startup-log-row">${escapeHtml(message)}</div>`;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

async function closeDesktopWindow() {
  try {
    await shellInvoke("shell_close");
    return;
  } catch (error) {
    console.warn("native close bridge failed", error);
  }
  const currentWindow = getCurrentTauriWindow();
  try {
    if (currentWindow?.close) {
      await currentWindow.close();
      return;
    }
  } catch (error) {
    console.warn("window close bridge failed", error);
  }

  try {
    window.close();
  } catch {}
}

function getCurrentTauriWindow() {
  const tauri = window.__TAURI__ || null;
  return tauri?.window?.getCurrentWindow?.()
    || tauri?.window?.getCurrent?.()
    || tauri?.webviewWindow?.getCurrentWebviewWindow?.()
    || tauri?.webviewWindow?.getCurrent?.()
    || null;
}

async function shellInvoke(command, args = {}) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") throw new Error(`Tauri invoke bridge unavailable for ${command}`);
  return await invoke(command, args);
}

async function minimizeDesktopWindow() {
  try {
    await shellInvoke("shell_minimize");
    return;
  } catch (error) {
    console.warn("native minimize bridge failed", error);
  }
  const currentWindow = getCurrentTauriWindow();
  if (currentWindow?.minimize) await currentWindow.minimize();
}

async function toggleMaximizeDesktopWindow() {
  try {
    await shellInvoke("shell_toggle_maximize");
    return;
  } catch (error) {
    console.warn("native maximize bridge failed", error);
  }
  const currentWindow = getCurrentTauriWindow();
  if (!currentWindow) return;
  if (currentWindow.toggleMaximize) {
    await currentWindow.toggleMaximize();
    return;
  }
  if (currentWindow.isMaximized && currentWindow.maximize && currentWindow.unmaximize) {
    const isMaximized = await currentWindow.isMaximized();
    if (isMaximized) await currentWindow.unmaximize();
    else await currentWindow.maximize();
    return;
  }
  if (currentWindow.maximize) await currentWindow.maximize();
}

async function startDraggingDesktopWindow() {
  try {
    await shellInvoke("shell_start_dragging");
  } catch (error) {
    console.warn("native drag bridge failed", error);
  }
}

async function moveDesktopWindowBy(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return;
  desktopPendingMove.dx += dx;
  desktopPendingMove.dy += dy;
  if (desktopMoveInFlight) return;
  desktopMoveInFlight = true;
  while (desktopPendingMove.dx || desktopPendingMove.dy) {
    const nextDx = desktopPendingMove.dx;
    const nextDy = desktopPendingMove.dy;
    desktopPendingMove = { dx: 0, dy: 0 };
    try {
      await shellInvoke("shell_move_window_by", { dx: nextDx, dy: nextDy });
    } catch (error) {
      console.warn("native window move bridge failed", error);
      break;
    }
  }
  desktopMoveInFlight = false;
}

function finishDesktopWindowDrag(pointerId) {
  if (!desktopDragSession || (pointerId != null && desktopDragSession.pointerId !== pointerId)) return;
  desktopDragSession = null;
  desktopPendingMove = { dx: 0, dy: 0 };
}

function bindTitlebarDrag(element) {
  if (!element || element.dataset.dragBound === "1") return;
  element.dataset.dragBound = "1";
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
    if (window.__TAURI__?.core?.invoke) {
      event.preventDefault();
      startDraggingDesktopWindow().catch?.(console.error);
      return;
    }
    event.preventDefault();
    desktopDragSession = {
      pointerId: event.pointerId,
      lastX: event.screenX,
      lastY: event.screenY,
    };
    element.setPointerCapture?.(event.pointerId);
  });
  element.addEventListener("pointermove", (event) => {
    if (!desktopDragSession || event.pointerId !== desktopDragSession.pointerId) return;
    const dx = event.screenX - desktopDragSession.lastX;
    const dy = event.screenY - desktopDragSession.lastY;
    desktopDragSession.lastX = event.screenX;
    desktopDragSession.lastY = event.screenY;
    moveDesktopWindowBy(dx, dy).catch?.(console.error);
  });
  element.addEventListener("pointerup", (event) => {
    finishDesktopWindowDrag(event.pointerId);
  });
  element.addEventListener("pointercancel", (event) => {
    finishDesktopWindowDrag(event.pointerId);
  });
  element.addEventListener("lostpointercapture", (event) => {
    finishDesktopWindowDrag(event.pointerId);
  });
}

async function pollStatus() {
  if (!window.__TAURI__?.core?.invoke) {
    setStatus({
      phase: "error",
      message: "Tauri API bridge is unavailable.",
      mode: "shell-loader",
      dataDir: "...",
      staticDir: "...",
      url: "http://127.0.0.1:8787",
      lastError: "The desktop shell frontend could not reach the native launcher bridge."
    });
    return;
  }

  try {
    const status = await window.__TAURI__.core.invoke("shell_status");
    setStatus(status);
    if (!redirecting && status?.phase === "ready" && status?.url) {
      redirecting = true;
      window.location.replace(String(status.url));
      return;
    }
  } catch (error) {
    setStatus({
      phase: "error",
      message: "The desktop shell could not read launcher status.",
      mode: "shell-loader",
      dataDir: "...",
      staticDir: "...",
      url: "http://127.0.0.1:8787",
      lastError: String(error || "unknown shell status error")
    });
  }

  window.setTimeout(pollStatus, 1000);
}

retryBtn.addEventListener("click", () => {
  redirecting = false;
  pollStatus();
});

if (windowCloseBtn) {
  windowCloseBtn.addEventListener("click", () => {
    closeDesktopWindow().catch?.(console.error);
  });
}

if (windowMinBtn) {
  windowMinBtn.addEventListener("click", () => {
    minimizeDesktopWindow().catch?.(console.error);
  });
}

if (windowMaxBtn) {
  windowMaxBtn.addEventListener("click", () => {
    toggleMaximizeDesktopWindow().catch?.(console.error);
  });
}

bindTitlebarDrag(titlebar);
bindTitlebarDrag(titlebarBrand);
bindTitlebarDrag(titlebarDragfill);

pollStatus();
