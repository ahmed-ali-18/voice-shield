/**
 * VoiceShield — Shared Constants
 * Central place for tunable thresholds and shared string keys so no module
 * hardcodes magic numbers. Later modules (vision, vad, decision) import from here.
 */

export const MIC_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  MUTED: "MUTED",
});

export const EVENTS = Object.freeze({
  FACE_METRICS_UPDATED: "vision:metrics-updated",
  AUDIO_METRICS_UPDATED: "audio:metrics-updated",
  DECISION_UPDATED: "decision:updated",
  CAMERA_READY: "camera:ready",
  CAMERA_ERROR: "camera:error",
  CAMERA_STOPPED: "camera:stopped",
  MIC_READY: "mic:ready",
  MIC_ERROR: "mic:error",
  MIC_STOPPED: "mic:stopped",
  VISION_MODEL_LOADING: "vision:model-loading",
  VISION_MODEL_READY: "vision:model-ready",
  VISION_ERROR: "vision:error",
  SETTINGS_UPDATED: "settings:updated",

  // Platform integration (src/integrations/*) — the core engine above never
  // emits or listens for these; they exist only between a platform's
  // detector/controller/adapter/ui files.
  MEETING_JOINED: "meeting:joined",
  MEETING_LEFT: "meeting:left",
  ADAPTER_MUTE_SYNCED: "adapter:mute-synced",
  ADAPTER_ERROR: "adapter:error",
});

export const PLATFORM = Object.freeze({
  GOOGLE_MEET: "google-meet",
});

// Thresholds — exposed here so Module 6 (UI) can wire them to live sliders
// without the decision engine needing to know about the DOM.
export const DEFAULT_THRESHOLDS = Object.freeze({
  // Informational only as of the anti-false-positive rework below — still
  // computed and displayed in the Facial Metrics card (and used for the
  // landmark-overlay color cue), but no longer part of the gating decision.
  // A static open mouth (yawning, resting) was reading as "speaking" when
  // this was used as an OR trigger, so it was removed from the gate logic.
  MOUTH_OPEN_THRESHOLD: 0.15,

  // Per-frame bar for "is the mouth moving at all this frame" — feeds the
  // multi-frame pattern window below, not used directly as a gate on its own.
  LIP_MOVEMENT_THRESHOLD: 0.3, // 0-1, how far current lip velocity sits above the adaptive per-user jitter floor (see vision/metrics-extractor.js createLipMovementTracker)

  HEAD_YAW_MAX_DEGREES: 25, // how far the user may turn away and still count as "facing camera"
  HEAD_PITCH_MAX_DEGREES: 20,
  VAD_ACTIVITY_THRESHOLD: 0.5, // 0-1 speech probability / energy score
  HOLD_TIME_MS: 500, // debounce so mic doesn't flicker on <0.5s pauses

  // Multi-frame speech-pattern detection (vision/speech-pattern-detector.js).
  // Natural talking shows a *fluttering* pattern of lip movement over time —
  // not a single open-mouth frame, and not a constant static hold. These
  // require both "moving often enough recently" and "actually varying"
  // before counting as natural speech.
  NATURAL_SPEECH_WINDOW_FRAMES: 18, // ~0.5-0.6s of history at 30fps
  NATURAL_SPEECH_MIN_ACTIVE_FRACTION: 0.35, // at least this fraction of the recent window must be above LIP_MOVEMENT_THRESHOLD
  NATURAL_SPEECH_MIN_VARIABILITY: 0.05, // std-dev floor — a static hold has ~0 variability even if "open"

  // Audio-visual synchrony (decision/av-sync-detector.js). Correlates the
  // lip-movement and voice-energy time series over a rolling window so a
  // stationary face next to an unrelated audio source (background chatter,
  // music, another speaker) can't satisfy the gate just because both
  // happen to be nonzero at the same moment.
  SYNC_WINDOW_SAMPLES: 30, // ~1s of paired samples at the combined update rate
  SYNC_THRESHOLD: 0.15, // minimum positive correlation required once enough history exists
});

export const TARGET_FPS = 30;
