import { eventBus } from "../utils/event-bus.js";
import { createLogger } from "../utils/logger.js";
import { EVENTS, MIC_STATUS } from "../utils/constants.js";

const log = createLogger("audio");

/**
 * audio/audio-controller.js — owns the microphone MediaStream and the full
 * Web Audio processing graph:
 *
 *   mic ──┬─► analyser (raw, untouched)         ← vad/ reads this for VAD
 *         └─► highpass → voice-emphasis → lowpass → compressor → noise gate
 *                                                          │
 *                                                          ├─► processed MediaStream (getProcessedStream())
 *                                                          └─► destination, only if preview is explicitly enabled
 *
 * VAD reads the *raw*, pre-DSP tap — running it through the enhancement
 * chain first would shift the energy levels our own VAD calibrates against.
 * The enhancement chain approximates "noise suppression + voice isolation"
 * using native Web Audio DSP nodes only (no ML model — consistent with the
 * project brief's pure Web Audio API constraint). The final noise-gate
 * node's gain is driven directly by the decision engine's ACTIVE/MUTED
 * reading, via the event bus only — this module never imports decision/
 * directly — so ambient sound between confirmed speech bursts is
 * physically attenuated on the processed output, not just labeled as such
 * in the UI.
 */

const MIC_CONSTRAINTS = {
  audio: {
    // Browser-side AEC/AGC/NS are now layered UNDERNEATH our own DSP chain
    // and noise gate, rather than instead of them. Our energy VAD still
    // reads the raw, pre-DSP tap below, so enabling these doesn't affect
    // VAD calibration — it only improves the input signal quality generally.
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  video: false,
};

// Noise-gate timing: opens fast so the start of a word isn't clipped,
// closes slower so trailing consonants aren't chopped off mid-syllable.
const GATE_OPEN_TIME_CONSTANT = 0.05;
const GATE_CLOSE_TIME_CONSTANT = 0.25;
const GATE_CLOSED_GAIN = 0.05; // not fully 0 — a hard cut sounds like a dropout; this reads as "silent" without clicking
const GATE_OPEN_GAIN = 1;

let mediaStream = null;
let audioContext = null;
let analyserNode = null;
let sourceNode = null;
let noiseGateNode = null;
let processedDestinationNode = null;
let previewEnabled = false;

function friendlyErrorMessage(error) {
  switch (error.name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "Microphone permission was denied. Allow mic access in the browser prompt and try again.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "No microphone device was found on this system.";
    case "NotReadableError":
    case "TrackStartError":
      return "The microphone is already in use by another application.";
    case "SecurityError":
      return "Microphone access is blocked by a security policy in this context.";
    default:
      return error.message || "Unknown microphone error.";
  }
}

export function isMicActive() {
  return mediaStream !== null;
}

/** vad/ reads directly from this — audio/ never interprets the signal itself. */
export function getAnalyser() {
  return analyserNode;
}

/** The enhanced + gated stream — exposed for a future "virtual mic" step (see extension/README.md). */
export function getProcessedStream() {
  return processedDestinationNode ? processedDestinationNode.stream : null;
}

export function isPreviewEnabled() {
  return previewEnabled;
}

/**
 * Lets the person hear the noise-suppressed, gated output live. Off by
 * default to avoid feedback howl through open speakers — recommend
 * headphones when enabling.
 */
export function setPreviewEnabled(enabled) {
  previewEnabled = enabled;
  if (!noiseGateNode || !audioContext) return;

  try {
    noiseGateNode.disconnect(audioContext.destination);
  } catch {
    // Wasn't connected yet — fine, nothing to undo.
  }
  if (enabled) {
    noiseGateNode.connect(audioContext.destination);
  }
}

/**
 * Builds the enhancement chain and returns its output node (the noise gate).
 * Every stage here is a native Web Audio node — no external model.
 */
function buildEnhancementChain(context, source) {
  // Cuts low-frequency rumble: AC hum, desk vibration, wind on the mic.
  const highpass = context.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 90;
  highpass.Q.value = 0.7;

  // Gentle boost across the core speech-intelligibility band, so the voice
  // sits forward of background texture without needing heavy compression.
  const voiceEmphasis = context.createBiquadFilter();
  voiceEmphasis.type = "peaking";
  voiceEmphasis.frequency.value = 1800;
  voiceEmphasis.Q.value = 0.9;
  voiceEmphasis.gain.value = 4;

  // Cuts high-frequency hiss beyond where speech intelligibility lives.
  const lowpass = context.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 7500;
  lowpass.Q.value = 0.7;

  // Evens out level swings so quiet syllables don't get lost once the gate
  // is factored in, without squashing dynamics as hard as a limiter would.
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -32;
  compressor.knee.value = 18;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.15;

  // The actual "isolation" step: attenuated to near-silent unless the
  // decision engine confirms the user is the one speaking right now (see
  // the EVENTS.DECISION_UPDATED listener at the bottom of this file).
  const noiseGate = context.createGain();
  noiseGate.gain.value = GATE_CLOSED_GAIN;

  source.connect(highpass);
  highpass.connect(voiceEmphasis);
  voiceEmphasis.connect(lowpass);
  lowpass.connect(compressor);
  compressor.connect(noiseGate);

  return noiseGate;
}

export async function startMicrophone() {
  if (isMicActive()) return;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);

    audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    // Raw tap for VAD — deliberately upstream of all DSP below.
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0; // vad/ does its own smoothing
    sourceNode.connect(analyserNode);

    // Enhancement + noise-gate chain feeding the "clean" processed output.
    noiseGateNode = buildEnhancementChain(audioContext, sourceNode);
    processedDestinationNode = audioContext.createMediaStreamDestination();
    noiseGateNode.connect(processedDestinationNode);

    if (previewEnabled) {
      noiseGateNode.connect(audioContext.destination);
    }

    const [track] = mediaStream.getAudioTracks();
    log.info("Microphone started", track.getSettings());

    eventBus.emit(EVENTS.MIC_READY, {
      deviceLabel: track.label || "Microphone",
      sampleRate: audioContext.sampleRate,
    });
  } catch (error) {
    log.error("Failed to start microphone", error);
    eventBus.emit(EVENTS.MIC_ERROR, { message: friendlyErrorMessage(error) });
    cleanup();
    throw error;
  }
}

function cleanup() {
  if (sourceNode) sourceNode.disconnect();
  if (audioContext) audioContext.close();
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  audioContext = null;
  analyserNode = null;
  sourceNode = null;
  noiseGateNode = null;
  processedDestinationNode = null;
}

export function stopMicrophone() {
  if (!isMicActive()) return;
  cleanup();
  log.info("Microphone stopped");
  eventBus.emit(EVENTS.MIC_STOPPED, {});
}

export async function toggleMicrophone() {
  if (isMicActive()) {
    stopMicrophone();
  } else {
    await startMicrophone();
  }
}

// Drives the noise gate directly off the decision engine's live reading, via
// the event bus only — audio/ never imports decision/ directly. Asymmetric
// ramp times avoid clicks and avoid chopping the tail of a word.
eventBus.on(EVENTS.DECISION_UPDATED, ({ micStatus }) => {
  if (!noiseGateNode || !audioContext) return;

  const isActive = micStatus === MIC_STATUS.ACTIVE;
  const targetGain = isActive ? GATE_OPEN_GAIN : GATE_CLOSED_GAIN;
  const timeConstant = isActive ? GATE_OPEN_TIME_CONSTANT : GATE_CLOSE_TIME_CONSTANT;

  noiseGateNode.gain.setTargetAtTime(targetGain, audioContext.currentTime, timeConstant);
});
