/**
 * decision/decision-engine.js — pure decision logic combining vision + audio
 * metrics into VoiceShield's core gate:
 *
 *   Microphone ACTIVE  ⇔  visualSpeaking  AND  voiceActive  AND  inSync
 *
 * No DOM, no event-bus, no timers here — decision-controller.js supplies the
 * live metrics each frame, runs the A/V-sync correlation, and owns the
 * hold-time debounce on the final result.
 */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * "Visually speaking" now means the vision pipeline's multi-frame natural
 * speech-pattern detector fired (see vision/speech-pattern-detector.js) —
 * sustained, *varying* lip motion over the last ~0.5s — while the user
 * faces the camera. A single open-mouth frame is deliberately NOT enough
 * on its own: earlier versions used mouthOpen OR lipMovement as an
 * instantaneous per-frame check, which false-triggered on a static open
 * mouth and on single noisy frames. All of that temporal-pattern logic now
 * lives in vision/; this function just reads its verdict.
 */
export function computeVisualSpeaking(faceMetrics) {
  if (!faceMetrics.faceDetected) return false;
  if (!faceMetrics.facingCamera) return false;
  return faceMetrics.naturalSpeechPattern === true;
}

/**
 * A 0-1 "how confident are we in this reading" figure for the UI only — it
 * has no effect on the gating decision itself. Blends how strong each
 * contributing signal is (speech pattern, audio, A/V sync, facing-camera),
 * so the confidence bar moves smoothly instead of snapping straight from 0
 * to 100 at the boolean edge.
 */
export function computeConfidence({ faceMetrics, audioMetrics, syncScore, visualSpeaking, voiceActive }) {
  if (!faceMetrics.faceDetected) return 0;

  const patternComponent = clamp(faceMetrics.speechPatternScore ?? 0, 0, 1);
  const audioComponent = clamp(audioMetrics.vadScore ?? 0, 0, 1);
  const syncComponent = clamp(syncScore ?? 0, 0, 1);
  const facingComponent = faceMetrics.facingCamera ? 1 : 0;

  const blended =
    patternComponent * 0.3 + audioComponent * 0.3 + syncComponent * 0.25 + facingComponent * 0.15;

  // A high blended score while the gate is actually MUTED would read as a
  // contradiction in the UI ("70% confident" next to a red MUTED badge), so
  // scale it down whenever the gating conditions aren't all satisfied.
  const isFullyActive = visualSpeaking && voiceActive;
  return isFullyActive ? clamp(blended, 0, 1) : clamp(blended * 0.4, 0, 1);
}
