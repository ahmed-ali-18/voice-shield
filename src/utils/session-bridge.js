import { eventBus } from "./event-bus.js";
import { createLogger } from "./logger.js";
import { EVENTS, MIC_STATUS } from "./constants.js";
import { isCameraActive, toggleCamera } from "../camera/camera-controller.js";
import { isMicActive, toggleMicrophone } from "../audio/audio-controller.js";

const log = createLogger("session-bridge");

/**
 * utils/session-bridge.js — lets the extension popup (and anything else
 * outside a running engine context) query and command a live engine
 * instance. Each engine host (dashboard tab, Google Meet content script)
 * calls initSessionBridge("<source>") once; the bridge then:
 *
 *   1. Mirrors the engine's event-bus into a plain, serializable snapshot
 *      (lastDecision, cameraActive, ...) so a remote caller never touches
 *      DOM or MediaStream objects.
 *   2. Listens for chrome.runtime messages:
 *        { vsType: "VS_GET_STATE" }  → replies with the snapshot
 *        { vsType: "VS_COMMAND", command } → toggle-camera / toggle-mic
 *
 * The popup → background service worker → tab(s) path is defined in
 * src/background/service-worker.js; this file only handles the tab side.
 */

let source = null;

const snapshot = {
  engineReady: false,
  cameraActive: false,
  micActive: false,
  visionReady: false,
  faceDetected: false,
  voiceActive: false,
  micStatus: MIC_STATUS.MUTED,
  confidence: 0,
  syncScore: 0,
  inCall: false,
  lastError: null,
};

function emitError(message) {
  snapshot.lastError = message;
}

function bindEvents() {
  eventBus.on(EVENTS.CAMERA_READY, () => {
    snapshot.cameraActive = true;
    snapshot.lastError = null;
  });
  eventBus.on(EVENTS.CAMERA_STOPPED, () => {
    snapshot.cameraActive = false;
  });
  eventBus.on(EVENTS.CAMERA_ERROR, (detail) => {
    snapshot.cameraActive = false;
    emitError(detail?.message ?? "Camera error.");
  });

  eventBus.on(EVENTS.MIC_READY, () => {
    snapshot.micActive = true;
    snapshot.lastError = null;
  });
  eventBus.on(EVENTS.MIC_STOPPED, () => {
    snapshot.micActive = false;
  });
  eventBus.on(EVENTS.MIC_ERROR, (detail) => {
    snapshot.micActive = false;
    emitError(detail?.message ?? "Microphone error.");
  });

  eventBus.on(EVENTS.VISION_MODEL_LOADING, () => {
    snapshot.visionReady = false;
  });
  eventBus.on(EVENTS.VISION_MODEL_READY, () => {
    snapshot.visionReady = true;
  });
  eventBus.on(EVENTS.VISION_ERROR, (detail) => {
    snapshot.visionReady = false;
    emitError(detail?.message ?? "Vision error.");
  });

  eventBus.on(EVENTS.FACE_METRICS_UPDATED, (detail) => {
    snapshot.faceDetected = detail.faceDetected;
  });

  eventBus.on(EVENTS.AUDIO_METRICS_UPDATED, (detail) => {
    snapshot.voiceActive = detail.voiceActive;
  });

  eventBus.on(EVENTS.DECISION_UPDATED, (detail) => {
    snapshot.micStatus = detail.micStatus;
    snapshot.confidence = detail.confidence ?? 0;
    snapshot.syncScore = detail.syncScore ?? 0;
    snapshot.voiceActive = detail.voiceActive;
  });

  // Meet-only events — the dashboard context never receives these, so
  // inCall stays false there by construction.
  eventBus.on(EVENTS.MEETING_JOINED, () => {
    snapshot.inCall = true;
  });
  eventBus.on(EVENTS.MEETING_LEFT, () => {
    snapshot.inCall = false;
  });
  eventBus.on(EVENTS.ADAPTER_ERROR, (detail) => {
    emitError(detail?.message ?? "Platform adapter error.");
  });
}

function getState() {
  return {
    ...snapshot,
    source,
    cameraActive: isCameraActive(),
    micActive: isMicActive(),
  };
}

async function runCommand(command) {
  switch (command) {
    case "toggle-camera":
      return { ok: true, result: await toggleCamera() };
    case "toggle-mic":
      return { ok: true, result: await toggleMicrophone() };
    default:
      return { ok: false, error: `Unknown command "${command}".` };
  }
}

function registerMessageHandler() {
  // chrome.runtime is only available inside a real extension context. If
  // this page is opened outside the extension (e.g. dashboard.html loaded
  // from the file system or a local server), skip registration instead of
  // throwing "Cannot read properties of undefined (reading 'onMessage')".
  if (!chrome?.runtime?.onMessage) {
    log.warn("chrome.runtime messaging unavailable — popup control disabled here.");
    return;
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.vsType === "VS_GET_STATE") {
      sendResponse({ ok: true, state: getState() });
      return false;
    }
    if (message?.vsType === "VS_COMMAND") {
      runCommand(message.command)
        .then((result) => sendResponse(result))
        .catch((error) => {
          log.warn("Command failed", error);
          sendResponse({ ok: false, error: error?.message ?? String(error) });
        });
      return true; // keep the channel open for the async reply
    }
    return false;
  });
}

export function initSessionBridge(sourceName) {
  source = sourceName;
  snapshot.engineReady = true;
  bindEvents();
  registerMessageHandler();
  log.info(`Session bridge ready (source: ${sourceName}).`);
}
