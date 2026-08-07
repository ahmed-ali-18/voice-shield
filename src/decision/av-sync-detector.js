import { createRingBuffer } from "../utils/ring-buffer.js";

/**
 * decision/av-sync-detector.js — checks that lip-movement energy and voice
 * energy are actually rising and falling *together* over a short rolling
 * window, not just individually nonzero right now.
 *
 * This is what stops the "friend talking off-camera while the user sits
 * still" false positive: without this check, a stationary face's landmark
 * jitter (or an unrelated mouth movement like chewing) happening to overlap
 * with someone else's voice on the mic would satisfy a simple
 * "visualSpeaking AND voiceActive" AND-gate. Requiring the two time series
 * to be positively correlated means the lip motion has to actually track
 * the audio's rhythm — which an unrelated background speaker's voice won't.
 *
 * This is a heuristic, not a true lip-sync / source-separation model — it
 * can still be fooled by a well-timed coincidence, but it meaningfully
 * raises the bar over independent instantaneous checks.
 */

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

/** Pearson correlation coefficient, guarded against near-zero variance (flat signals). */
function correlation(xs, ys) {
  const n = xs.length;
  const meanX = mean(xs);
  const meanY = mean(ys);

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  if (denominator < 1e-6) return 0; // one or both signals essentially flat — no evidence of sync either way

  return covariance / denominator;
}

export function createAvSyncDetector(thresholds) {
  const windowSize = thresholds.SYNC_WINDOW_SAMPLES;
  const lipSamples = createRingBuffer(windowSize);
  const audioSamples = createRingBuffer(windowSize);

  return {
    reset() {
      lipSamples.clear();
      audioSamples.clear();
    },

    /** Call once per decision-engine evaluate() tick with the latest paired readings. */
    update(lipMovementScore, audioEnergyScore) {
      lipSamples.push(lipMovementScore);
      audioSamples.push(audioEnergyScore);

      if (!lipSamples.isFull) {
        // Not enough history yet — pass through rather than block the very
        // start of a session on an empty correlation window.
        return { syncScore: 1, hasEnoughHistory: false };
      }

      const r = correlation(lipSamples.values, audioSamples.values);
      // Only positive correlation counts as evidence of sync; map -1..1 to 0..1.
      return { syncScore: Math.max(0, r), hasEnoughHistory: true };
    },
  };
}
