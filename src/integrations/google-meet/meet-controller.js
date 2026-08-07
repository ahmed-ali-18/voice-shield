import { eventBus } from "../../utils/event-bus.js";
import { createLogger } from "../../utils/logger.js";
import { EVENTS, MIC_STATUS } from "../../utils/constants.js";
import { bindVideoElement, startCamera, stopCamera } from "../../camera/camera-controller.js";
import { bindCanvasElement as bindVisionCanvas, startVision, stopVision } from "../../vision/vision-controller.js";
import { startMicrophone, stopMicrophone } from "../../audio/audio-controller.js";
import { bindCanvasElement as bindVadCanvas, startVad, stopVad } from "../../vad/vad-controller.js";
import { startDecisionEngine, stopDecisionEngine } from "../../decision/decision-controller.js";
import { readMuteState, syncMuteState } from "./meet-adapter.js";
import { showBadge, hideBadge, updateBadge } from "./meet-ui.js";
import { initSessionBridge } from "../../utils/session-bridge.js";

const log = createLogger("integrations/google-meet/controller");

/**
 * meet-controller.js — orchestrates the (unmodified) core engine inside the
 * Meet tab and keeps Meet's real mute button in sync with its decisions.
 * Contains zero Meet DOM selectors itself — all of that is isolated in
 * meet-adapter.js. This file only knows "there's an adapter with a
 * syncMuteState(bool) function", the same shape any future platform adapter
 * would expose.
 */

let running = false;
let hiddenVideo = null;
let hiddenFaceCanvas = null;
let hiddenWaveformCanvas = null;
let lastProgrammaticMutedState = null;
let manualOverrideMicStatus = null; // engine's desired state when the user took over
let unsubscribeDecision = null;

/**
 * A visually-negligible but fully live (not display:none) container.
 * MediaPipe reads a video element's intrinsic frame buffer, not its
 * rendered CSS size, so a 2x2px on-page footprint is enough — but it must
 * stay out of display:none, which some browsers use as a signal to pause
 * decoding entirely.
 */
function createHiddenCaptureSurface() {
  const container = document.createElement("div");
  container.setAttribute("data-voiceshield", "hidden-capture");
  Object.assign(container.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "2px",
    height: "2px",
    overflow: "hidden",
    opacity: "0.01",
    pointerEvents: "none",
    zIndex: "-1",
  });

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;

  const faceCanvas = document.createElement("canvas");
  const waveformCanvas = document.createElement("canvas");

  container.append(video, faceCanvas, waveformCanvas);
  document.body.appendChild(container);

  return { container, video, faceCanvas, waveformCanvas };
}

function removeHiddenCaptureSurface() {
  const existing = document.querySelector('[data-voiceshield="hidden-capture"]');
  if (existing) existing.remove();
}

async function handleMeetingJoined() {
  if (running) return;
  running = true;
  log.info("Starting core engine for this call.");

  const surface = createHiddenCaptureSurface();
  hiddenVideo = surface.video;
  hiddenFaceCanvas = surface.faceCanvas;
  hiddenWaveformCanvas = surface.waveformCanvas;

  bindVideoElement(hiddenVideo);
  bindVisionCanvas(hiddenFaceCanvas);
  bindVadCanvas(hiddenWaveformCanvas);

  showBadge();
  startDecisionEngine();
  unsubscribeDecision = eventBus.on(EVENTS.DECISION_UPDATED, handleDecisionUpdated);

  try {
    await startCamera();
    await startVision();
  } catch (error) {
    log.error("Camera/vision failed to start in Meet tab", error);
    updateBadge({ error: "Camera permission needed for VoiceShield to work here." });
  }

  try {
    await startMicrophone();
    startVad();
  } catch (error) {
    log.error("Microphone/VAD failed to start in Meet tab", error);
    updateBadge({ error: "Microphone permission needed for VoiceShield to work here." });
  }
}

function handleMeetingLeft() {
  if (!running) return;
  running = false;
  log.info("Call ended — tearing down core engine.");

  if (unsubscribeDecision) {
    unsubscribeDecision();
    unsubscribeDecision = null;
  }

  stopVad();
  stopMicrophone();
  stopVision();
  stopCamera();
  stopDecisionEngine();
  hideBadge();
  removeHiddenCaptureSurface();

  hiddenVideo = null;
  hiddenFaceCanvas = null;
  hiddenWaveformCanvas = null;
  lastProgrammaticMutedState = null;
  manualOverrideMicStatus = null;
}

/**
 * Reacts to the core engine's live gating decision by syncing Meet's real
 * mute button — unless a recent manual click looks like it overrode us (see
 * docs/google-meet-integration.md §9 for the manual-override design this
 * implements).
 */
function handleDecisionUpdated({ micStatus }) {
  if (!running) return;

  // If the user manually overrode us, stay hands-off until the engine's
  // desired state itself changes (i.e. they're speaking again).
  let clearedOverride = false;
  if (manualOverrideMicStatus !== null) {
    if (micStatus === manualOverrideMicStatus) return;
    manualOverrideMicStatus = null;
    clearedOverride = true;
    log.info("Decision changed — resuming mute-button auto-sync.");
  }

  // Skip the divergence check on the very event that just cleared the
  // override: the button is still in the user's manual state, and re-arming
  // here would deadlock — sync would never resume. `syncMuteState` no-ops
  // ("already-in-sync") and updates lastProgrammaticMutedState, so the next
  // decision event sees the states aligned.
  if (!clearedOverride && lastProgrammaticMutedState !== null) {
    const actualMuted = readMuteState();
    if (actualMuted !== null && actualMuted !== lastProgrammaticMutedState) {
      manualOverrideMicStatus = micStatus;
      log.info("Manual mute override detected — pausing auto-sync until the decision changes.");
      return;
    }
  }

  const shouldBeActive = micStatus === MIC_STATUS.ACTIVE;
  const result = syncMuteState(shouldBeActive);
  if (result.synced) {
    lastProgrammaticMutedState = !shouldBeActive;
  }

  updateBadge({ micStatus });
  eventBus.emit(EVENTS.ADAPTER_MUTE_SYNCED, { micStatus, ...result });
}

export function initMeetController() {
  eventBus.on(EVENTS.MEETING_JOINED, handleMeetingJoined);
  eventBus.on(EVENTS.MEETING_LEFT, handleMeetingLeft);
  initSessionBridge("meet");
  log.info("Meet controller ready, waiting for a call.");
}
