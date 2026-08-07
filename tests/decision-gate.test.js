import test from "node:test";
import assert from "node:assert/strict";
import { eventBus } from "../src/utils/event-bus.js";
import { EVENTS, MIC_STATUS } from "../src/utils/constants.js";
import {
  startDecisionEngine,
  stopDecisionEngine,
} from "../src/decision/decision-controller.js";
import { setThreshold, resetThresholds } from "../src/utils/settings-store.js";

// Persistent capture: DECISION_UPDATED emits synchronously during the
// triggering metric emit, so this listener always holds the latest decision.
let latestDecision = null;
eventBus.on(EVENTS.DECISION_UPDATED, (d) => {
  latestDecision = d;
});

function lastDecision() {
  return latestDecision;
}

function faceUpdate(i, speechScore) {
  eventBus.emit(EVENTS.FACE_METRICS_UPDATED, {
    faceDetected: true,
    mouthOpenScore: 0.2,
    lipMovementScore: speechScore,
    naturalSpeechPattern: true,
    speechPatternScore: speechScore,
    headYaw: 0,
    headPitch: 0,
    facingCamera: true,
  });
}

// voiceActive is forced true so only the A/V-sync leg can block the gate.
function audioUpdate(vadScore) {
  eventBus.emit(EVENTS.AUDIO_METRICS_UPDATED, {
    audioLevel: vadScore,
    vadScore,
    voiceActive: true,
  });
}

/** Fills the sync window with lip/voice series that are anti-correlated (r ≈ -1). */
function fillAntiCorrelatedWindow() {
  for (let i = 0; i < 40; i++) {
    const lip = (Math.sin(i / 2) + 1) / 2; // 0..1
    faceUpdate(i, lip);
    audioUpdate(1 - lip);
  }
}

test("gate stays MUTED while lip and voice are anti-correlated", () => {
  // HOLD_TIME 0 excludes the debounce from this test: the hold gate would
  // otherwise keep the gate ACTIVE for up to 500ms after the last true tick.
  setThreshold("HOLD_TIME_MS", 0);
  startDecisionEngine();
  fillAntiCorrelatedWindow();
  assert.equal(lastDecision().micStatus, MIC_STATUS.MUTED);
  stopDecisionEngine();
  resetThresholds();
});

test("changing HOLD_TIME_MS must not loosen the gate (sync history survives)", async () => {
  setThreshold("HOLD_TIME_MS", 0);
  startDecisionEngine();
  fillAntiCorrelatedWindow();
  assert.equal(lastDecision().micStatus, MIC_STATUS.MUTED);

  setThreshold("HOLD_TIME_MS", 700); // triggers SETTINGS_UPDATED

  // A rebuilt hold gate starts with lastActiveAt = 0, so it reports
  // "active" while performance.now() is still under 700ms. In the
  // extension the dashboard has been open for seconds; in a fresh Node
  // process the clock starts at 0, which would mask the gate logic this
  // test measures. Wait the zero-state out before feeding new metrics.
  await new Promise((resolve) => setTimeout(resolve, 800));

  faceUpdate(100, 0.9);
  audioUpdate(0.1);

  assert.equal(lastDecision().micStatus, MIC_STATUS.MUTED);
  stopDecisionEngine();
  resetThresholds();
});

test("sync history accumulates at face rate, not audio rate", () => {
  setThreshold("HOLD_TIME_MS", 0);
  startDecisionEngine();

  // 29 face events (window is 30) — each with one trailing audio event.
  for (let i = 0; i < 29; i++) {
    faceUpdate(i, 0.5);
    audioUpdate(0.5);
  }
  assert.equal(lastDecision().syncScore, 1, "window not full yet");

  // 10 audio-only events must NOT push new pairs.
  for (let i = 0; i < 10; i++) audioUpdate(0.8);
  assert.equal(lastDecision().syncScore, 1, "audio-only events must not fill the sync window");

  // The 30th face event fills the window → real correlation replaces the sentinel.
  faceUpdate(100, 0.5);
  audioUpdate(0.5);
  assert.notEqual(lastDecision().syncScore, 1);
  stopDecisionEngine();
  resetThresholds();
});
