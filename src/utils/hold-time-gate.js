/**
 * utils/hold-time-gate.js — debounces a noisy boolean signal so brief dips
 * below threshold (a natural pause between words, a single dropped frame)
 * don't flicker whatever's downstream. Used by vad/ (smoothing the raw
 * per-frame VAD boolean) and decision/ (smoothing the final AND-gate
 * result) — pulled out here so neither module has to import the other.
 */
export function createHoldTimeGate(holdTimeMs) {
  let lastActiveAt = -Infinity;
  return {
    update(isActiveNow, nowMs) {
      if (isActiveNow) lastActiveAt = nowMs;
      return nowMs - lastActiveAt <= holdTimeMs;
    },
  };
}
