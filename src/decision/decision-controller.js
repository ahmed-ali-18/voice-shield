import { eventBus } from "../utils/event-bus.js";
import { createLogger } from "../utils/logger.js";
import { EVENTS, MIC_STATUS } from "../utils/constants.js";
import { getThresholds } from "../utils/settings-store.js";
import { createHoldTimeGate } from "../utils/hold-time-gate.js";
import { createAvSyncDetector } from "./av-sync-detector.js";
import { computeVisualSpeaking, computeConfidence } from "./decision-engine.js";

const log = createLogger("decision");

/**
 * decision/decision-controller.js — single responsibility: hold the latest
 * snapshot from vision/ (FACE_METRICS_UPDATED) and vad/ (AUDIO_METRICS_UPDATED),
 * re-evaluate the gate whenever either changes, debounce the result, and
 * emit EVENTS.DECISION_UPDATED. It does not touch the DOM, camera, or audio
 * APIs directly — that's what keeps decision-engine.js's actual logic
 * trivially testable in isolation.
 *
 * The gate now requires three things together: visualSpeaking (multi-frame
 * natural lip-movement pattern, facing the camera), voiceActive (VAD), and
 * inSync (the lip-movement and voice-energy time series are actually
 * correlated over the last ~1s — see av-sync-detector.js). That third check
 * is what stops an unrelated nearby voice from opening the mic just because
 * it happens to overlap with incidental face/lip motion.
 *
 * Fail-closed by design: if the camera or mic stops or errors out mid-session,
 * the corresponding metrics snapshot resets to "not speaking" immediately,
 * and the sync detector's history is cleared too, so the gate falls back to
 * MUTED rather than freezing on — or being biased by — stale readings.
 */

const EMPTY_FACE_METRICS = {
  faceDetected: false,
  mouthOpenScore: 0,
  lipMovementScore: 0,
  naturalSpeechPattern: false,
  speechPatternScore: 0,
  headYaw: 0,
  headPitch: 0,
  facingCamera: false,
};

const EMPTY_AUDIO_METRICS = { audioLevel: 0, vadScore: 0, voiceActive: false };

let latestFaceMetrics = EMPTY_FACE_METRICS;
let latestAudioMetrics = EMPTY_AUDIO_METRICS;
let holdGate = null;
let avSyncDetector = null;
let lastSync = { syncScore: 1, hasEnoughHistory: false };
let running = false;

function evaluate() {
  const visualSpeaking = computeVisualSpeaking(latestFaceMetrics);
  const voiceActive = latestAudioMetrics.voiceActive;

  // lastSync is refreshed once per face tick (see the FACE_METRICS_UPDATED
  // handler) so both series are sampled at the same rate and time-aligned.
  const { syncScore, hasEnoughHistory } = lastSync;
  // Don't block on sync during the first ~1s of a session/re-detection —
  // there isn't enough history yet to judge correlation either way.
  const inSync = !hasEnoughHistory || syncScore >= getThresholds().SYNC_THRESHOLD;

  const rawActive = visualSpeaking && voiceActive && inSync;
  const debouncedActive = holdGate.update(rawActive, performance.now());
  const micStatus = debouncedActive ? MIC_STATUS.ACTIVE : MIC_STATUS.MUTED;

  const confidence = computeConfidence({
    faceMetrics: latestFaceMetrics,
    audioMetrics: latestAudioMetrics,
    syncScore,
    visualSpeaking,
    voiceActive,
  });

  eventBus.emit(EVENTS.DECISION_UPDATED, { visualSpeaking, voiceActive, syncScore, micStatus, confidence });
}

export function isDecisionEngineRunning() {
  return running;
}

/** Starts evaluating immediately — the gate is live for the whole dashboard
 * session, independent of whether camera/mic happen to be on yet. */
export function startDecisionEngine() {
  if (running) return;
  running = true;
  holdGate = createHoldTimeGate(getThresholds().HOLD_TIME_MS);
  avSyncDetector = createAvSyncDetector(getThresholds());
  lastSync = { syncScore: 1, hasEnoughHistory: false };
  latestFaceMetrics = EMPTY_FACE_METRICS;
  latestAudioMetrics = EMPTY_AUDIO_METRICS;
  log.info("Decision engine started.");
  evaluate(); // emit an initial MUTED reading right away
}

export function stopDecisionEngine() {
  running = false;
  log.info("Decision engine stopped.");
}

eventBus.on(EVENTS.FACE_METRICS_UPDATED, (detail) => {
  if (!running) return;
  latestFaceMetrics = detail;
  // Pair lip + latest audio at the face-update rate only — see evaluate().
  lastSync = avSyncDetector.update(
    detail.speechPatternScore ?? 0,
    latestAudioMetrics.vadScore ?? 0
  );
  evaluate();
});

eventBus.on(EVENTS.AUDIO_METRICS_UPDATED, (detail) => {
  if (!running) return;
  latestAudioMetrics = detail;
  evaluate();
});

// Fail-closed: camera/mic stopping or erroring resets that side of the gate
// AND clears the sync history, so a fresh camera/mic session doesn't inherit
// a correlation window mixing old and new signal.
eventBus.on(EVENTS.CAMERA_STOPPED, () => {
  latestFaceMetrics = EMPTY_FACE_METRICS;
  avSyncDetector?.reset();
  lastSync = { syncScore: 1, hasEnoughHistory: false };
  if (running) evaluate();
});

eventBus.on(EVENTS.CAMERA_ERROR, () => {
  latestFaceMetrics = EMPTY_FACE_METRICS;
  avSyncDetector?.reset();
  lastSync = { syncScore: 1, hasEnoughHistory: false };
  if (running) evaluate();
});

eventBus.on(EVENTS.MIC_STOPPED, () => {
  latestAudioMetrics = EMPTY_AUDIO_METRICS;
  avSyncDetector?.reset();
  lastSync = { syncScore: 1, hasEnoughHistory: false };
  if (running) evaluate();
});

eventBus.on(EVENTS.MIC_ERROR, () => {
  latestAudioMetrics = EMPTY_AUDIO_METRICS;
  avSyncDetector?.reset();
  lastSync = { syncScore: 1, hasEnoughHistory: false };
  if (running) evaluate();
});

eventBus.on(EVENTS.SETTINGS_UPDATED, (thresholds) => {
  if (!running) return;
  // Only HOLD_TIME_MS is baked into a tracker at construction. The sync
  // detector is NOT rebuilt: SYNC_WINDOW_SAMPLES has no slider, and
  // SYNC_THRESHOLD is read live from the store in evaluate() — rebuilding
  // would only clear the correlation history, which briefly LOOSENS the gate
  // (hasEnoughHistory=false → inSync passes unconditionally for ~1s).
  holdGate = createHoldTimeGate(thresholds.HOLD_TIME_MS);
});
