import { createRingBuffer } from "../utils/ring-buffer.js";

/**
 * vision/speech-pattern-detector.js — distinguishes natural talking motion
 * from a single "mouth open" frame, a static held-open mouth (yawning,
 * resting with jaw slack), or an isolated jitter spike.
 *
 * Real speech shows a *fluttering* pattern: lip-gap velocity repeatedly
 * rises and falls over consecutive frames. This tracker keeps a rolling
 * window of per-frame lip-movement scores (from
 * vision/metrics-extractor.js's createLipMovementTracker) and only reports
 * "natural speech pattern" when the window shows BOTH:
 *   - the mouth was actively moving for a meaningful fraction of recent
 *     frames (not just once), and
 *   - the signal actually varies frame-to-frame (rules out a static hold,
 *     which can sit "open" but nearly motionless).
 */

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
}

function standardDeviation(values) {
  const m = mean(values);
  const variance = mean(values.map((value) => (value - m) ** 2));
  return Math.sqrt(variance);
}

export function createSpeechPatternDetector(thresholds) {
  const {
    NATURAL_SPEECH_WINDOW_FRAMES: windowSize,
    LIP_MOVEMENT_THRESHOLD: activeFrameThreshold,
    NATURAL_SPEECH_MIN_ACTIVE_FRACTION: minActiveFraction,
    NATURAL_SPEECH_MIN_VARIABILITY: minVariability,
  } = thresholds;

  const buffer = createRingBuffer(windowSize);

  return {
    reset() {
      buffer.clear();
    },

    /** Call once per vision frame with the current (jitter-floor-relative) lip-movement score. */
    update(movementScore) {
      buffer.push(movementScore);

      if (!buffer.isFull) {
        // Not enough history yet to judge a pattern — default to "not speaking"
        // rather than guessing, so a session's first half-second can't
        // false-trigger on a single early frame.
        return { isNaturalSpeechPattern: false, patternScore: 0 };
      }

      const activeFraction =
        buffer.values.filter((value) => value >= activeFrameThreshold).length / buffer.length;
      const variability = standardDeviation(buffer.values);

      const isNaturalSpeechPattern =
        activeFraction >= minActiveFraction && variability >= minVariability;

      // 0-1 blended score for the UI/confidence calc — smoother than the
      // boolean so the confidence bar doesn't jump straight from 0 to 100.
      const patternScore = Math.min(
        1,
        activeFraction * 0.6 + Math.min(variability / (minVariability * 3), 1) * 0.4
      );

      return { isNaturalSpeechPattern, patternScore };
    },
  };
}
