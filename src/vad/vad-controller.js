import { eventBus } from "../utils/event-bus.js";
import { createLogger } from "../utils/logger.js";
import { EVENTS } from "../utils/constants.js";
import { getThresholds } from "../utils/settings-store.js";
import { resizeCanvasToElement } from "../utils/canvas.js";
import { createHoldTimeGate } from "../utils/hold-time-gate.js";
import { getAnalyser, isMicActive } from "../audio/audio-controller.js";
import {
  computeRMSLevel,
  createNoiseFloorTracker,
  energyToSpeechProbability,
} from "./vad-engine.js";
import { drawWaveform } from "./waveform-renderer.js";

const log = createLogger("vad");

/**
 * vad/vad-controller.js — single responsibility: pull raw samples from
 * audio/'s AnalyserNode once per frame, run them through vad-engine.js's
 * pure functions, draw the waveform via waveform-renderer.js, and emit
 * EVENTS.AUDIO_METRICS_UPDATED. It does not know about vision or the
 * decision engine.
 */

let canvas = null;
let ctx = null;
let rafHandle = null;
let running = false;
let noiseFloorTracker = null;
let holdGate = null;
let timeDomainBuffer = null;

export function bindCanvasElement(element) {
  canvas = element;
  ctx = canvas.getContext("2d");
}

export function isVadRunning() {
  return running;
}

export function startVad() {
  if (running) return;

  const analyser = getAnalyser();
  if (!analyser || !isMicActive()) {
    throw new Error("vad/: microphone must be started before VAD can run.");
  }
  if (!canvas) {
    throw new Error("vad/: no canvas bound — call bindCanvasElement() first.");
  }

  timeDomainBuffer = new Uint8Array(analyser.fftSize);
  noiseFloorTracker = createNoiseFloorTracker();
  holdGate = createHoldTimeGate(getThresholds().HOLD_TIME_MS);
  running = true;

  resizeCanvasToElement(canvas, canvas.parentElement);

  const loop = () => {
    if (!running) return;

    analyser.getByteTimeDomainData(timeDomainBuffer);

    const rms = computeRMSLevel(timeDomainBuffer);
    const noiseFloor = noiseFloorTracker.update(rms);
    const vadScore = energyToSpeechProbability(rms, noiseFloor);
    const instantaneousActive = vadScore >= getThresholds().VAD_ACTIVITY_THRESHOLD;
    const voiceActive = holdGate.update(instantaneousActive, performance.now());

    eventBus.emit(EVENTS.AUDIO_METRICS_UPDATED, { audioLevel: rms, vadScore, voiceActive });

    drawWaveform(ctx, timeDomainBuffer, { voiceActive });

    rafHandle = requestAnimationFrame(loop);
  };

  rafHandle = requestAnimationFrame(loop);
  log.info("VAD loop started.");
}

export function stopVad() {
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  log.info("VAD loop stopped.");
}

// HOLD_TIME_MS is baked into holdGate at construction (debounce timer), so
// a slider change rebuilds it rather than being picked up next frame.
eventBus.on(EVENTS.SETTINGS_UPDATED, (thresholds) => {
  if (!running) return;
  holdGate = createHoldTimeGate(thresholds.HOLD_TIME_MS);
});
