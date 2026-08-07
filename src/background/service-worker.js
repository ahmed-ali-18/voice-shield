/**
 * VoiceShield — Background Service Worker
 *
 * Responsibilities:
 *   1. Act as the message router for the toolbar popup: the popup is a
 *      *remote control* that must never host the engine itself (a popup is
 *      killed on blur, which would tear down webcam/mic streams). It asks
 *      this worker for the state of every running engine session (dashboard
 *      tab and/or Google Meet tabs) and routes control commands to them.
 *   2. Open (or focus) the persistent dashboard tab on demand.
 *
 * The Google Meet integration (src/integrations/google-meet/) is a
 * manifest-declared content script that auto-injects into meet.google.com/*
 * independently of this file — see docs/google-meet-integration.md. Each
 * engine host reports through utils/session-bridge.js, which is the tab
 * side of the VS_GET_STATE / VS_COMMAND protocol.
 */

const DASHBOARD_PATH = "src/ui/dashboard.html";
const MEET_URL_PATTERN = "https://meet.google.com/*";
const TAB_TIMEOUT_MS = 1500;

async function openOrFocusDashboard() {
  const dashboardUrl = chrome.runtime.getURL(DASHBOARD_PATH);

  const existingTabs = await chrome.tabs.query({ url: dashboardUrl });

  if (existingTabs.length > 0) {
    const tab = existingTabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url: dashboardUrl });
}

/** Send a message to a tab; resolve with the response or null on failure/timeout. */
function askTab(tabId, message) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), TAB_TIMEOUT_MS);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response ?? null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Every engine host: the dashboard tab (if open) + Meet tabs currently in a call. */
async function findSessions() {
  const sessions = [];

  const dashTabs = await chrome.tabs.query({ url: chrome.runtime.getURL(DASHBOARD_PATH) });
  for (const tab of dashTabs) {
    const reply = await askTab(tab.id, { vsType: "VS_GET_STATE" });
    if (reply?.ok) {
      sessions.push({ kind: "dashboard", tabId: tab.id, ...reply.state });
    } else {
      // Tab exists but no bridge responds — it's running the old build and
      // needs a manual reload. Surface that instead of silently dropping it.
      sessions.push({ kind: "dashboard", tabId: tab.id, stale: true });
    }
  }

  const meetTabs = await chrome.tabs.query({ url: MEET_URL_PATTERN });
  for (const tab of meetTabs) {
    const reply = await askTab(tab.id, { vsType: "VS_GET_STATE" });
    if (reply?.ok && reply.state?.inCall) {
      sessions.push({ kind: "meet", tabId: tab.id, ...reply.state });
    }
  }

  return sessions;
}

/** The session the popup's control buttons act on: an active Meet call wins, else the dashboard. */
function pickPrimary(sessions) {
  return sessions.find((s) => s.kind === "meet") ?? sessions.find((s) => s.kind === "dashboard") ?? null;
}

async function handleGetState() {
  const sessions = await findSessions();
  return { ok: true, sessions };
}

async function handleCommand(message) {
  const sessions = await findSessions();
  const primary = pickPrimary(sessions);
  if (!primary) {
    return { ok: false, error: "No VoiceShield session is running. Open the dashboard first." };
  }
  return askTab(primary.tabId, { vsType: "VS_COMMAND", command: message.command });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.vsType === "VS_OPEN_DASHBOARD") {
    openOrFocusDashboard();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.vsType === "VS_GET_STATE") {
    handleGetState().then(sendResponse);
    return true; // async
  }
  if (message?.vsType === "VS_COMMAND") {
    handleCommand(message).then(sendResponse);
    return true; // async
  }
  return false;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    openOrFocusDashboard();
  }
});
