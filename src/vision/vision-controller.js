import { eventBus } from "../utils/event-bus.js";
import { createLogger } from "../utils/logger.js";
import { EVENTS } from "../utils/constants.js";
import { getThresholds } from "../utils/settings-store.js";
import { getVideoElement } from "../camera/camera-controller.js";
import { getFaceLandmarker } from "./face-landmarker-loader.js";
import {
  extractMouthOpenScore,
  createLipMovementTracker,
  extractHeadOrientation,
  isFacingCamera,
} from "./metrics-extractor.js";
import { createSpeechPatternDetector } from "./speech-pattern-detector.js";
import { resizeCanvasToElement } from "../utils/canvas.js";
import { drawFaceOverlay } from "./landmark-renderer.js";

const log = createLogger("vision");

/**
 * vision/vision-controller.js — single responsibility: run the MediaPipe
 * Face Landmarker against camera/'s video element once per frame, turn the
 * result into VoiceShield's metrics via metrics-extractor.js +
 * speech-pattern-detector.js, draw the overlay via landmark-renderer.js,
 * and emit EVENTS.FACE_METRICS_UPDATED. It does not know about audio, VAD,
 * or the decision engine.
 */

let canvas = null;
let ctx = null;
let rafHandle = null;
let running = false;
let lastVideoTime = -1;

// Stateful across frames — tracks the adaptive jitter floor so a still face
// reads near-zero movement regardless of camera noise. Reset whenever
// vision (re)starts or the face drops out of frame, so a fresh session
// doesn't inherit a stale calibration from a different lighting setup.
const lipMovementTracker = createLipMovementTracker();

// Stateful across frames — the rolling window that turns per-frame lip
// movement into a "sustained, varying, natural speech" judgment. Its window
// size and thresholds are baked in at construction, so it's rebuilt (not
// just re-read) whenever the Detection Sensitivity sliders change.
let speechPatternDetector = createSpeechPatternDetector(getThresholds());

eventBus.on(EVENTS.SETTINGS_UPDATED, (thresholds) => {
  speechPatternDetector = createSpeechPatternDetector(thresholds);
});

export function bindCanvasElement(element) {
  canvas = element;
  ctx = canvas.getContext("2d");
}

export function isVisionRunning() {
  return running;
}

export async function startVision() {
  if (running) return;

  const videoElement = getVideoElement();
  if (!videoElement || !videoElement.srcObject) {
    throw new Error("vision/: camera must be started before vision can run.");
  }
  if (!canvas) {
    throw new Error("vision/: no canvas bound — call bindCanvasElement() first.");
  }

  eventBus.emit(EVENTS.VISION_MODEL_LOADING, {});
  let faceLandmarker;
  try {
    faceLandmarker = await getFaceLandmarker();
  } catch (error) {
    log.error("Failed to load Face Landmarker model", error);
    eventBus.emit(EVENTS.VISION_ERROR, {
      message:
        "Could not load the MediaPipe Face Landmarker model. Have you completed the vendor/mediapipe/README.md setup steps?",
    });
    return;
  }
  eventBus.emit(EVENTS.VISION_MODEL_READY, {});

  running = true;
  lipMovementTracker.reset();
  speechPatternDetector.reset();
  lastVideoTime = -1;

  const loop = () => {
    if (!running) return;

    try {
      // detectForVideo requires a new frame each call; skip if the video
      // hasn't advanced (e.g. tab backgrounded) to avoid redundant inference.
      if (videoElement.readyState >= 2 && videoElement.currentTime !== lastVideoTime) {
        lastVideoTime = videoElement.currentTime;
        const result = faceLandmarker.detectForVideo(videoElement, performance.now());
        processResult(result, videoElement);
      }
    } catch (error) {
      // A crashed inference loop must not leave stale "speaking" metrics
      // frozen on the gate — stop, reset, and report so the decision engine
      // fails closed (see its VISION_ERROR handler).
      log.error("Vision loop crashed — stopping vision and failing closed.", error);
      stopVision();
      lipMovementTracker.reset();
      speechPatternDetector.reset();
      eventBus.emit(EVENTS.VISION_ERROR, {
        message: "Vision processing failed unexpectedly; the gate is closed (MUTED). Toggle the camera off/on to retry.",
      });
      return;
    }

    rafHandle = requestAnimationFrame(loop);
  };

  resizeCanvasToElement(canvas, videoElement);
  rafHandle = requestAnimationFrame(loop);
  log.info("Vision loop started.");
}

export function stopVision() {
  running = false;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = null;
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  log.info("Vision loop stopped.");
}

function processResult(result, videoElement) {
  const landmarks = result.faceLandmarks?.[0] ?? null;
  const blendshapes = result.faceBlendshapes?.[0]?.categories ?? null;
  const transformMatrix = result.facialTransformationMatrixes?.[0]?.data ?? null;

  if (!landmarks) {
    lipMovementTracker.reset();
    speechPatternDetector.reset();
    eventBus.emit(EVENTS.FACE_METRICS_UPDATED, {
      faceDetected: false,
      mouthOpenScore: 0,
      lipMovementScore: 0,
      naturalSpeechPattern: false,
      speechPatternScore: 0,
      headYaw: 0,
      headPitch: 0,
      facingCamera: false,
    });
    drawFaceOverlay(ctx, null);
    return;
  }

  const mouthOpenScore = extractMouthOpenScore(blendshapes);
  const { movementScore } = lipMovementTracker.update(landmarks);
  const { isNaturalSpeechPattern, patternScore } = speechPatternDetector.update(movementScore);

  const headOrientation = extractHeadOrientation(transformMatrix);
  const facingCamera = isFacingCamera(headOrientation, getThresholds());

  eventBus.emit(EVENTS.FACE_METRICS_UPDATED, {
    faceDetected: true,
    mouthOpenScore,
    lipMovementScore: movementScore,
    naturalSpeechPattern: isNaturalSpeechPattern,
    speechPatternScore: patternScore,
    headYaw: headOrientation.yaw,
    headPitch: headOrientation.pitch,
    facingCamera,
  });

  resizeCanvasToElement(canvas, videoElement);
  drawFaceOverlay(ctx, landmarks, { isNaturalSpeechPattern });
}
