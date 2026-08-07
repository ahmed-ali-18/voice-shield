import { eventBus } from "../utils/event-bus.js";
import { createLogger } from "../utils/logger.js";
import { EVENTS, TARGET_FPS } from "../utils/constants.js";

const log = createLogger("camera");

/**
 * camera/ — single responsibility: own the webcam MediaStream and its
 * lifecycle (start/stop/errors). It does NOT know about MediaPipe, canvas
 * drawing, or the decision engine. vision/ (Module 3) will pull frames from
 * the same <video> element via getVideoElement() — camera/ just has to keep
 * that element fed with a live stream.
 */

const CAMERA_CONSTRAINTS = {
  video: {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: TARGET_FPS, max: TARGET_FPS },
    facingMode: "user",
  },
  audio: false,
};

let videoElement = null;
let mediaStream = null;
let isStarting = false;

function friendlyErrorMessage(error) {
  switch (error.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Camera permission was denied. Allow camera access in the browser prompt and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No camera device was found on this system.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is already in use by another application.";
    case "OverconstrainedError":
      return "No camera on this device satisfies the requested resolution/frame rate.";
    case "SecurityError":
      return "Camera access is blocked by a security policy in this context.";
    default:
      return error.message || "Unknown camera error.";
  }
}

/**
 * Binds the <video> element this module streams into. Called once during
 * dashboard boot.
 */
export function bindVideoElement(element) {
  videoElement = element;
}

/** Exposed so vision/ (Module 3) can read frames from the exact same element. */
export function getVideoElement() {
  return videoElement;
}

export function isCameraActive() {
  return mediaStream !== null;
}

export async function startCamera() {
  if (isStarting || isCameraActive()) return;
  if (!videoElement) {
    throw new Error("camera/: no <video> element bound — call bindVideoElement() first.");
  }

  isStarting = true;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
    videoElement.srcObject = mediaStream;
    await videoElement.play();

    const [track] = mediaStream.getVideoTracks();
    const settings = track.getSettings();

    log.info("Camera started", settings);
    eventBus.emit(EVENTS.CAMERA_READY, {
      width: settings.width,
      height: settings.height,
      frameRate: settings.frameRate,
      deviceLabel: track.label || "Webcam",
    });
  } catch (error) {
    log.error("Failed to start camera", error);
    eventBus.emit(EVENTS.CAMERA_ERROR, { message: friendlyErrorMessage(error) });
    mediaStream = null;
    throw error;
  } finally {
    isStarting = false;
  }
}

export function stopCamera() {
  if (!mediaStream) return;

  mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  if (videoElement) videoElement.srcObject = null;

  log.info("Camera stopped");
  eventBus.emit(EVENTS.CAMERA_STOPPED, {});
}

export async function toggleCamera() {
  if (isCameraActive()) {
    stopCamera();
  } else {
    await startCamera();
  }
}
