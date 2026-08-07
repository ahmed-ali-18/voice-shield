/**
 * vad/vad-engine.js — pure signal-processing functions for energy-based
 * voice activity detection. No Web Audio, DOM, or event-bus imports here on
 * purpose (same philosophy as vision/metrics-extractor.js) — this is where
 * a future model-based VAD (e.g. Picovoice Cobra) would slot in without
 * touching vad-controller.js's calling convention.
 */

/** Root-mean-square level (0-1ish) of a time-domain byte buffer (0-255, centered at 128). */
export function computeRMSLevel(timeDomainData) {
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const normalized = (timeDomainData[i] - 128) / 128; // -1..1
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / timeDomainData.length);
}

/**
 * Tracks a slowly-adapting noise floor so the VAD calibrates itself to the
 * room instead of relying on one fixed global threshold. Returned as a
 * small stateful object so vad-controller.js can hold one instance across
 * frames without this module needing any module-level mutable state.
 */
export function createNoiseFloorTracker({ initial = 0.02, riseRate = 0.02, fallRate = 0.002 } = {}) {
  let noiseFloor = initial;
  return {
    update(rms) {
      // Rises slowly toward quiet-period levels; falls even more slowly so
      // a sudden loud sound doesn't instantly redefine "quiet".
      noiseFloor += rms < noiseFloor ? (rms - noiseFloor) * riseRate : (rms - noiseFloor) * fallRate;
      return noiseFloor;
    },
    get value() {
      return noiseFloor;
    },
  };
}

/**
 * Converts an RMS level + adaptive noise floor into a 0-1 "speech
 * probability" score via a logistic curve over the margin above the floor.
 * Swappable later for a model-based VAD without changing the caller.
 */
export function energyToSpeechProbability(rms, noiseFloor, { sensitivity = 12 } = {}) {
  const margin = rms - noiseFloor;
  const probability = 1 / (1 + Math.exp(-sensitivity * (margin - 0.01)));
  return Math.min(1, Math.max(0, probability));
}
