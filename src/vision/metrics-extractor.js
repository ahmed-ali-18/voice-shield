/**
 * vision/metrics-extractor.js — pure functions that turn a raw MediaPipe
 * FaceLandmarkerResult into the scalar metrics the decision engine cares
 * about. No DOM access and no MediaPipe imports here on purpose: this file
 * has zero side effects, which makes it trivial to unit test in isolation.
 */

// MediaPipe FaceMesh landmark indices (478-point topology) used below.
const LIP_TOP_INNER = 13;
const LIP_BOTTOM_INNER = 14;
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Interocular distance — a stable, scale-invariant normalizer for a face. */
function faceScale(landmarks) {
  return distance(landmarks[LEFT_EYE_OUTER], landmarks[RIGHT_EYE_OUTER]) || 1;
}

/** 0-1 "how open is the mouth right now", straight from MediaPipe's jawOpen blendshape. */
export function extractMouthOpenScore(blendshapes) {
  if (!blendshapes?.length) return 0;
  const jawOpen = blendshapes.find((category) => category.categoryName === "jawOpen");
  return jawOpen ? clamp(jawOpen.score, 0, 1) : 0;
}

/**
 * Stateful tracker for lip-movement velocity, mirroring vad/vad-engine.js's
 * adaptive noise-floor pattern. A raw frame-to-frame mouth-gap delta turned
 * out to be too noisy on its own: normal landmark jitter (camera noise,
 * lighting flicker, tiny head micro-movements) was enough to cross a fixed
 * threshold even with a completely still mouth, causing false "visually
 * speaking" positives. This tracker calibrates a "resting jitter" floor
 * continuously — allowed to drift only toward quieter readings, same as the
 * audio noise floor — so real lip motion (much larger than jitter) still
 * stands out clearly while a still face reads near 0 regardless of camera
 * quality or lighting.
 */
export function createLipMovementTracker() {
  const VELOCITY_SMOOTHING_ALPHA = 0.5;
  const FLOOR_ADAPT_ALPHA = 0.98;
  const FLOOR_MIN = 0.003;
  const MOVEMENT_TO_FLOOR_RATIO_FOR_FULL_CONFIDENCE = 5;

  let previousMouthGap = null;
  let smoothedVelocity = 0;
  let jitterFloor = FLOOR_MIN;

  return {
    reset() {
      previousMouthGap = null;
      smoothedVelocity = 0;
      jitterFloor = FLOOR_MIN;
    },

    update(landmarks) {
      const scale = faceScale(landmarks);
      const mouthGap = distance(landmarks[LIP_TOP_INNER], landmarks[LIP_BOTTOM_INNER]) / scale;
      const instantVelocity = previousMouthGap == null ? 0 : Math.abs(mouthGap - previousMouthGap);
      previousMouthGap = mouthGap;

      smoothedVelocity =
        VELOCITY_SMOOTHING_ALPHA * instantVelocity + (1 - VELOCITY_SMOOTHING_ALPHA) * smoothedVelocity;

      // Only drift the floor toward quieter readings — otherwise sustained
      // talking would slowly "recalibrate" jitter upward and the tracker
      // would stop detecting the speaker's own lip motion.
      if (smoothedVelocity < jitterFloor * 1.5) {
        jitterFloor = FLOOR_ADAPT_ALPHA * jitterFloor + (1 - FLOOR_ADAPT_ALPHA) * smoothedVelocity;
      }
      jitterFloor = Math.max(jitterFloor, FLOOR_MIN);

      const excess = smoothedVelocity - jitterFloor;
      const dynamicRange = jitterFloor * MOVEMENT_TO_FLOOR_RATIO_FOR_FULL_CONFIDENCE;
      const movementScore = clamp(excess / dynamicRange, 0, 1);

      return { movementScore, mouthGap };
    },
  };
}

function radToDeg(radians) {
  return (radians * 180) / Math.PI;
}

/**
 * Approximate yaw/pitch/roll (degrees) from MediaPipe's facial
 * transformation matrix (a column-major 4x4, WebGL-style array). This is a
 * standard Euler extraction — good enough to gate "is the user roughly
 * facing the camera", not a calibrated head-pose research tool.
 */
export function extractHeadOrientation(transformMatrix) {
  if (!transformMatrix) return { yaw: 0, pitch: 0, roll: 0 };

  const m = transformMatrix;
  const r00 = m[0], r10 = m[1];
  const r02 = m[8], r12 = m[9], r22 = m[10];

  const pitch = Math.asin(clamp(-r12, -1, 1));

  let yaw;
  let roll;
  if (Math.abs(r12) < 0.9999) {
    yaw = Math.atan2(r02, r22);
    roll = Math.atan2(r10, m[5]);
  } else {
    // Gimbal lock (looking almost straight up/down) — rare during normal
    // meeting use, fall back to a safe default rather than dividing by ~0.
    yaw = 0;
    roll = 0;
  }

  return { yaw: radToDeg(yaw), pitch: radToDeg(pitch), roll: radToDeg(roll) };
}

/** Not used by decision logic here (that's Module 5's job) — a preview flag. */
export function isFacingCamera(headOrientation, thresholds) {
  return (
    Math.abs(headOrientation.yaw) <= thresholds.HEAD_YAW_MAX_DEGREES &&
    Math.abs(headOrientation.pitch) <= thresholds.HEAD_PITCH_MAX_DEGREES
  );
}
