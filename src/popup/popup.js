import { createLogger } from "../utils/logger.js";

const log = createLogger("ui/popup");

/**
 * src/popup/popup.js — the toolbar popup is a *remote control*, not the
 * engine host: the detection engine keeps running in the dashboard tab or
 * a Google Meet tab, and this popup queries/commands it through the
 * background service worker (GET_STATE / COMMAND) while it's open.
 */

const REFRESH_INTERVAL_MS = 500;
const STATUS_ORDER = { meet: 0, dashboard: 1 };

let primarySession = null;
let busy = false;

const els = {
  pipelinePill: document.getElementById("pipeline-pill"),
  pipelineLabel: document.getElementById("pipeline-label"),
  gate: document.getElementById("gate"),
  gateStatus: document.getElementById("gate-status"),
  confidenceFill: document.getElementById("confidence-fill"),
  confidenceValue: document.getElementById("confidence-value"),
  metricFace: document.getElementById("metric-face"),
  metricVoice: document.getElementById("metric-voice"),
  metricSync: document.getElementById("metric-sync"),
  cameraBtn: document.getElementById("camera-btn"),
  micBtn: document.getElementById("mic-btn"),
  dashboardBtn: document.getElementById("dashboard-btn"),
  sessionDashboard: document.getElementById("session-dashboard"),
  sessionDashboardState: document.getElementById("session-dashboard-state"),
  sessionMeet: document.getElementById("session-meet"),
  sessionMeetState: document.getElementById("session-meet-state"),
  statusLine: document.getElementById("status-line"),
};

function sendBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response ?? { ok: false, error: "No response from background." });
      });
    } catch (error) {
      resolve({ ok: false, error: error?.message ?? String(error) });
    }
  });
}

async function fetchSessions() {
  const response = await sendBackground({ vsType: "VS_GET_STATE" });
  if (!response?.ok) {
    return { sessions: [], error: response?.error ?? "Background worker unreachable." };
  }
  return { sessions: response.sessions ?? [], error: null };
}

function pickPrimary(sessions) {
  const active = sessions.filter(
    (s) => s.engineReady && (s.inCall || s.source === "dashboard")
  );
  active.sort((a, b) => (STATUS_ORDER[a.kind] ?? 9) - (STATUS_ORDER[b.kind] ?? 9));
  return active[0] ?? null;
}

function setPill(state, label) {
  els.pipelinePill.dataset.state = state;
  els.pipelineLabel.textContent = label;
}

function setConfidence(value) {
  const pct = Math.round((value ?? 0) * 100);
  els.confidenceFill.style.width = `${pct}%`;
  els.confidenceValue.textContent = `${pct}%`;
}

function setMetric(element, text, isOn) {
  element.dataset.on = String(isOn);
  element.querySelector(".p-metric__value").textContent = text;
}

function render(sessions) {
  primarySession = pickPrimary(sessions);

  if (!primarySession) {
    setPill("idle", "NO SESSION");
  } else if (primarySession.lastError) {
    setPill("error", "ERROR");
  } else if (primarySession.cameraActive || primarySession.micActive || primarySession.visionReady) {
    setPill("active", primarySession.inCall ? "PROTECTING CALL" : "LIVE");
  } else {
    setPill("idle", "IDLE");
  }

  if (!primarySession) {
    els.gate.dataset.status = "muted";
    els.gateStatus.textContent = "MUTED";
    setConfidence(0);
    setMetric(els.metricFace, "-", false);
    setMetric(els.metricVoice, "-", false);
    setMetric(els.metricSync, "-", false);
  } else {
    const isActive = primarySession.micStatus === "ACTIVE";
    els.gate.dataset.status = isActive ? "active" : "muted";
    els.gateStatus.textContent = primarySession.micStatus ?? "MUTED";
    setConfidence(primarySession.confidence ?? 0);
    setMetric(els.metricFace, primarySession.faceDetected ? "YES" : "no", !!primarySession.faceDetected);
    setMetric(els.metricVoice, primarySession.voiceActive ? "YES" : "no", !!primarySession.voiceActive);
    const syncPct = Math.round((primarySession.syncScore ?? 0) * 100);
    setMetric(els.metricSync, `${syncPct}%`, syncPct > 0);
  }

  const hasSession = !!primarySession;
  els.cameraBtn.disabled = !hasSession || busy;
  els.micBtn.disabled = !hasSession || busy;
  if (hasSession && !busy) {
    els.cameraBtn.textContent = primarySession.cameraActive ? "Stop Camera" : "Start Camera";
    els.cameraBtn.classList.toggle("p-btn--active", primarySession.cameraActive);
    els.micBtn.textContent = primarySession.micActive ? "Stop Microphone" : "Start Microphone";
    els.micBtn.classList.toggle("p-btn--active", primarySession.micActive);
  }

  const dashboardSession = sessions.find((s) => s.kind === "dashboard");
  const meetSession = sessions.find((s) => s.kind === "meet");

  els.sessionDashboard.dataset.active = String(
    !!dashboardSession && !dashboardSession.stale && (dashboardSession.cameraActive || dashboardSession.micActive)
  );
  els.sessionDashboardState.textContent = dashboardSession
    ? dashboardSession.stale
      ? "needs reload"
      : dashboardSession.cameraActive || dashboardSession.micActive
        ? "engine live"
        : "open"
    : "not running";

  els.sessionMeet.dataset.active = String(!!meetSession);
  els.sessionMeetState.textContent = meetSession ? "in call" : "not in call";

  if (!primarySession) {
    const stale = sessions.some((s) => s.stale);
    els.statusLine.textContent = stale
      ? "Dashboard is open but runs the old build — reload that tab (Ctrl+R), then reopen this popup."
      : "Open the dashboard (or join a Meet call) to start the engine.";
    els.statusLine.style.color = "";
    return;
  }

  const errorText = primarySession.lastError ?? "";
  els.statusLine.textContent = errorText;
  els.statusLine.style.color = errorText ? "" : "transparent";
}

async function refresh() {
  let sessions = [];
  let error = null;
  try {
    ({ sessions, error } = await fetchSessions());
  } catch (err) {
    log.warn("Failed to fetch sessions", err);
    error = err?.message ?? String(err);
  }
  if (error && sessions.length === 0) {
    els.statusLine.textContent = error;
    els.statusLine.style.color = "";
  }
  render(sessions);
}

async function runCommand(command) {
  if (busy || !primarySession) return;
  busy = true;
  els.cameraBtn.disabled = true;
  els.micBtn.disabled = true;
  try {
    const response = await sendBackground({ vsType: "VS_COMMAND", command });
    if (!response?.ok) {
      els.statusLine.textContent = response?.error ?? "Command failed.";
      els.statusLine.style.color = "";
    }
  } catch (error) {
    els.statusLine.textContent = error?.message ?? String(error);
    els.statusLine.style.color = "";
  }
  busy = false;
  await refresh();
}

els.cameraBtn.addEventListener("click", () => runCommand("toggle-camera"));
els.micBtn.addEventListener("click", () => runCommand("toggle-mic"));

els.dashboardBtn.addEventListener("click", async () => {
  await sendBackground({ vsType: "VS_OPEN_DASHBOARD" });
  window.close();
});

async function boot() {
  log.info("Popup opened.");
  await refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

boot();
