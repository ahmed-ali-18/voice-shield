import { eventBus } from "../utils/event-bus.js";
import { createLogger } from "../utils/logger.js";
import { EVENTS, MIC_STATUS } from "../utils/constants.js";
import { getThresholds } from "../utils/settings-store.js";
import {
  bindVideoElement,
  toggleCamera,
  isCameraActive,
} from "../camera/camera-controller.js";
import {
  bindCanvasElement,
  startVision,
  stopVision,
} from "../vision/vision-controller.js";
import {
  toggleMicrophone,
  isMicActive,
} from "../audio/audio-controller.js";
import {
  bindCanvasElement as bindVadCanvasElement,
  startVad,
  stopVad,
} from "../vad/vad-controller.js";
import { startDecisionEngine } from "../decision/decision-controller.js";
import { initSettingsPanel } from "./settings-panel.js";
import { initSessionBridge } from "../utils/session-bridge.js";

const log = createLogger("ui/dashboard");

/**
 * Module 1 built the shell. Module 2 added camera/. Module 3 added vision/.
 * Module 4 added audio/ + vad/. Module 5 added decision/. This build layers
 * in the anti-false-positive upgrade: vision/ now requires a multi-frame
 * "natural speech pattern" (sustained, varying lip motion) rather than a
 * single open-mouth frame; decision/ additionally requires the lip-movement
 * and voice-energy time series to be correlated (A/V sync) before gating
 * ACTIVE; and audio/ runs a real DSP enhancement + noise-gate chain whose
 * gain is driven directly by the decision engine's live reading. The gate/
 * logic-readout UI has been listening for DECISION_UPDATED since Module 1.
 * The decision engine runs for the whole session and fails closed to MUTED
 * if either camera or mic stops/errors.
 */

const pipelinePill = document.getElementById("pipeline-pill");
const pipelinePillLabel = document.getElementById("pipeline-pill-label");
const eventLog = document.getElementById("event-log");

const videoStage = document.getElementById("video-stage");
const webcamVideo = document.getElementById("webcam-video");
const landmarkCanvas = document.getElementById("landmark-canvas");
const cameraToggleBtn = document.getElementById("camera-toggle-btn");
const cameraMeta = document.getElementById("camera-meta");

const metricFaceDetected = document.getElementById("metric-face-detected");
const metricMouthOpen = document.getElementById("metric-mouth-open");
const meterMouthOpen = document.getElementById("meter-mouth-open");
const metricLipMovement = document.getElementById("metric-lip-movement");
const meterLipMovement = document.getElementById("meter-lip-movement");
const metricSpeechPattern = document.getElementById("metric-speech-pattern");
const meterSpeechPattern = document.getElementById("meter-speech-pattern");
const metricHeadOrientation = document.getElementById("metric-head-orientation");

const waveformStage = document.getElementById("waveform-stage");
const waveformCanvas = document.getElementById("waveform-canvas");
const micToggleBtn = document.getElementById("mic-toggle-btn");
const micMeta = document.getElementById("mic-meta");

const metricVadScore = document.getElementById("metric-vad-score");
const meterVadScore = document.getElementById("meter-vad-score");
const metricAudioLevel = document.getElementById("metric-audio-level");
const metricNoiseGate = document.getElementById("metric-noise-gate");

const gate = document.getElementById("gate");
const gateStatus = document.getElementById("gate-status");
const logicVisual = document.getElementById("logic-visual");
const logicAudio = document.getElementById("logic-audio");
const logicSync = document.getElementById("logic-sync");
const logicResult = document.getElementById("logic-result");
const confidenceFill = document.getElementById("confidence-fill");
const confidenceValue = document.getElementById("confidence-value");

function appendLogEntry(message, kind = "system") {
  const entry = document.createElement("li");
  entry.className = `log-entry log-entry--${kind}`;
  const timestamp = new Date().toLocaleTimeString([], { hour12: false });
  entry.textContent = `${timestamp}  ${message}`;
  eventLog.prepend(entry);

  // Keep the log from growing unbounded during long sessions.
  while (eventLog.children.length > 50) {
    eventLog.removeChild(eventLog.lastChild);
  }
}

function setPipelineState(state, label) {
  pipelinePill.dataset.state = state;
  pipelinePillLabel.textContent = label;
}

function renderFaceMetrics(detail) {
  metricFaceDetected.textContent = detail.faceDetected ? "YES" : "NO";
  metricFaceDetected.classList.toggle("metric-value--muted", !detail.faceDetected);

  metricMouthOpen.textContent = detail.faceDetected ? detail.mouthOpenScore.toFixed(2) : "—";
  metricMouthOpen.classList.toggle("metric-value--muted", !detail.faceDetected);
  meterMouthOpen.style.width = `${Math.round(detail.mouthOpenScore * 100)}%`;

  metricLipMovement.textContent = detail.faceDetected ? detail.lipMovementScore.toFixed(2) : "—";
  metricLipMovement.classList.toggle("metric-value--muted", !detail.faceDetected);
  meterLipMovement.style.width = `${Math.round(detail.lipMovementScore * 100)}%`;

  const speechPatternScore = detail.speechPatternScore ?? 0;
  metricSpeechPattern.textContent = detail.faceDetected
    ? detail.naturalSpeechPattern
      ? "YES"
      : "no"
    : "—";
  metricSpeechPattern.classList.toggle("metric-value--muted", !detail.faceDetected || !detail.naturalSpeechPattern);
  meterSpeechPattern.style.width = `${Math.round(speechPatternScore * 100)}%`;

  if (detail.faceDetected) {
    const facingLabel = detail.facingCamera ? "facing" : "turned away";
    metricHeadOrientation.textContent = `${detail.headYaw.toFixed(1)}° / ${detail.headPitch.toFixed(1)}° · ${facingLabel}`;
    metricHeadOrientation.classList.remove("metric-value--muted");
  } else {
    metricHeadOrientation.textContent = "—";
    metricHeadOrientation.classList.add("metric-value--muted");
  }
}

function renderAudioMetrics({ audioLevel, vadScore, voiceActive }) {
  metricVadScore.textContent = vadScore.toFixed(2);
  metricVadScore.classList.remove("metric-value--muted");
  meterVadScore.style.width = `${Math.round(vadScore * 100)}%`;

  metricAudioLevel.textContent = audioLevel.toFixed(3);
  metricAudioLevel.classList.toggle("metric-value--muted", !voiceActive);
}

/**
 * Renders a decision-engine update. Wired now so Module 5 (decision engine)
 * can call `eventBus.emit(EVENTS.DECISION_UPDATED, {...})` with zero UI changes.
 */
function renderDecision({ visualSpeaking, voiceActive, syncScore, micStatus, confidence }) {
  logicVisual.dataset.value = String(visualSpeaking);
  logicVisual.querySelector(".logic-term__value").textContent = visualSpeaking ? "TRUE" : "FALSE";

  logicAudio.dataset.value = String(voiceActive);
  logicAudio.querySelector(".logic-term__value").textContent = voiceActive ? "TRUE" : "FALSE";

  const syncPct = Math.round((syncScore ?? 0) * 100);
  const syncPasses = (syncScore ?? 0) >= getThresholds().SYNC_THRESHOLD;
  logicSync.dataset.value = String(syncPasses);
  logicSync.querySelector(".logic-term__value").textContent = `${syncPct}%`;

  const isActive = micStatus === MIC_STATUS.ACTIVE;
  logicResult.dataset.value = String(isActive);
  logicResult.querySelector(".logic-term__value").textContent = micStatus;

  gate.dataset.status = isActive ? "active" : "muted";
  gateStatus.textContent = micStatus;

  const pct = Math.round((confidence ?? 0) * 100);
  confidenceFill.style.width = `${pct}%`;
  confidenceValue.textContent = `${pct}%`;

  // The physical noise gate in audio/audio-controller.js follows this same
  // micStatus reading (via EVENTS.DECISION_UPDATED) — this just mirrors it.
  metricNoiseGate.textContent = isActive ? "OPEN" : "CLOSED";
  metricNoiseGate.classList.toggle("metric-value--muted", !isActive);
}

// --- Event bus subscriptions (future modules plug in here) ---
eventBus.on(EVENTS.DECISION_UPDATED, renderDecision);

eventBus.on(EVENTS.CAMERA_READY, async (detail) => {
  videoStage.classList.add("has-stream");
  cameraToggleBtn.textContent = "Stop Camera";
  cameraToggleBtn.classList.add("btn--active");
  cameraToggleBtn.disabled = false;
  cameraMeta.textContent = `${detail.deviceLabel} · ${detail.width}×${detail.height} @ ${Math.round(detail.frameRate)}fps`;
  appendLogEntry(`Camera started (${detail.width}×${detail.height} @ ${Math.round(detail.frameRate)}fps).`, "vision");

  try {
    await startVision();
  } catch (error) {
    appendLogEntry(`Vision error: ${error.message}`, "error");
  }
});

eventBus.on(EVENTS.CAMERA_STOPPED, () => {
  stopVision();
  videoStage.classList.remove("has-stream");
  cameraToggleBtn.textContent = "Start Camera";
  cameraToggleBtn.classList.remove("btn--active");
  cameraToggleBtn.disabled = false;
  cameraMeta.textContent = "";
  setPipelineState("idle", "MODULE 6 — CAMERA STOPPED");
  appendLogEntry("Camera stopped.", "vision");
  renderFaceMetrics({ faceDetected: false, mouthOpenScore: 0, lipMovementScore: 0, naturalSpeechPattern: false, speechPatternScore: 0, headYaw: 0, headPitch: 0 });
});

eventBus.on(EVENTS.CAMERA_ERROR, (detail) => {
  cameraToggleBtn.disabled = false;
  cameraToggleBtn.textContent = "Start Camera";
  setPipelineState("error", "MODULE 6 — CAMERA ERROR");
  appendLogEntry(`Camera error: ${detail?.message ?? "unknown"}`, "error");
});

eventBus.on(EVENTS.VISION_MODEL_LOADING, () => {
  setPipelineState("idle", "MODULE 6 — LOADING VISION MODEL");
  appendLogEntry("Loading MediaPipe Face Landmarker model (first run may take a few seconds)…", "vision");
});

eventBus.on(EVENTS.VISION_MODEL_READY, () => {
  setPipelineState("active", "MODULE 6 — VISION LIVE");
  appendLogEntry("Face Landmarker ready. Tracking mouth, lips, and head pose.", "vision");
});

eventBus.on(EVENTS.VISION_ERROR, (detail) => {
  setPipelineState("error", "MODULE 6 — VISION ERROR");
  appendLogEntry(detail?.message ?? "Unknown vision error.", "error");
});

eventBus.on(EVENTS.FACE_METRICS_UPDATED, renderFaceMetrics);

eventBus.on(EVENTS.MIC_READY, (detail) => {
  waveformStage.classList.add("has-stream");
  micToggleBtn.textContent = "Stop Microphone";
  micToggleBtn.classList.add("btn--active");
  micToggleBtn.disabled = false;
  micMeta.textContent = `${detail.deviceLabel} · ${Math.round(detail.sampleRate)}Hz`;
  appendLogEntry(`Microphone started (${detail.deviceLabel}).`, "audio");

  try {
    startVad();
    setPipelineState("active", "MODULE 6 — AUDIO + VAD LIVE");
  } catch (error) {
    appendLogEntry(`VAD error: ${error.message}`, "error");
  }
});

eventBus.on(EVENTS.MIC_STOPPED, () => {
  stopVad();
  waveformStage.classList.remove("has-stream");
  micToggleBtn.textContent = "Start Microphone";
  micToggleBtn.classList.remove("btn--active");
  micToggleBtn.disabled = false;
  micMeta.textContent = "";
  setPipelineState("idle", "MODULE 6 — MICROPHONE STOPPED");
  appendLogEntry("Microphone stopped.", "audio");
  renderAudioMetrics({ audioLevel: 0, vadScore: 0, voiceActive: false });
  metricVadScore.classList.add("metric-value--muted");
  metricAudioLevel.classList.add("metric-value--muted");
});

eventBus.on(EVENTS.MIC_ERROR, (detail) => {
  micToggleBtn.disabled = false;
  micToggleBtn.textContent = "Start Microphone";
  setPipelineState("error", "MODULE 6 — MICROPHONE ERROR");
  appendLogEntry(`Microphone error: ${detail?.message ?? "unknown"}`, "error");
});

eventBus.on(EVENTS.AUDIO_METRICS_UPDATED, renderAudioMetrics);

cameraToggleBtn.addEventListener("click", async () => {
  cameraToggleBtn.disabled = true;
  cameraToggleBtn.textContent = isCameraActive() ? "Stopping…" : "Requesting access…";
  try {
    await toggleCamera();
  } catch {
    // Error already surfaced via EVENTS.CAMERA_ERROR listener above.
  }
});

micToggleBtn.addEventListener("click", async () => {
  micToggleBtn.disabled = true;
  micToggleBtn.textContent = isMicActive() ? "Stopping…" : "Requesting access…";
  try {
    await toggleMicrophone();
  } catch {
    // Error already surfaced via EVENTS.MIC_ERROR listener above.
  }
});

// --- Module 1 boot sequence ---
async function boot() {
  log.info("Dashboard shell ready.");
  bindVideoElement(webcamVideo);
  bindCanvasElement(landmarkCanvas);
  bindVadCanvasElement(waveformCanvas);
  setPipelineState("idle", "MODULE 6 — CAMERA + MIC READY TO START");
  appendLogEntry("Dashboard loaded. Click \"Start Camera\" and \"Start Microphone\" to begin. The decision engine is live and will gate the mic automatically.");

  // Load any saved sensitivity settings before anything else reads a
  // threshold, so the very first evaluate() uses the person's saved values.
  await initSettingsPanel();

  // The decision engine runs for the whole session — it emits an initial
  // MUTED reading immediately, then re-evaluates on every metrics update.
  startDecisionEngine();

  // Expose this tab's engine state to the toolbar popup (via the background
  // service worker) — a remote control, so the popup can stay lightweight.
  initSessionBridge("dashboard");
}

document.addEventListener("DOMContentLoaded", () => {
  boot();
});
