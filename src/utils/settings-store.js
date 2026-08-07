import { eventBus } from "./event-bus.js";
import { createLogger } from "./logger.js";
import { EVENTS, DEFAULT_THRESHOLDS } from "./constants.js";

const log = createLogger("settings-store");

/**
 * utils/settings-store.js — the single mutable source of truth for
 * VoiceShield's tunable thresholds. DEFAULT_THRESHOLDS in constants.js
 * remains the read-only "factory defaults" seed; every module that used to
 * import DEFAULT_THRESHOLDS directly for a per-frame or per-evaluate check
 * now calls getThresholds() here instead, so moving a slider in the
 * Detection Sensitivity card takes effect immediately without restarting
 * the camera or mic.
 *
 * A few thresholds are baked into a stateful tracker/detector's internal
 * ring-buffer size at construction time (e.g. NATURAL_SPEECH_WINDOW_FRAMES,
 * SYNC_WINDOW_SAMPLES) rather than re-read every frame. For those, the
 * owning module listens for EVENTS.SETTINGS_UPDATED and rebuilds the
 * tracker with fresh values — see vision-controller.js and
 * decision-controller.js.
 */

const STORAGE_KEY = "voiceshield_thresholds_v1";

let thresholds = { ...DEFAULT_THRESHOLDS };

export function getThresholds() {
  return thresholds;
}

function persist() {
  try {
    chrome.storage?.local?.set({ [STORAGE_KEY]: thresholds });
  } catch (error) {
    log.warn("Could not persist settings", error);
  }
}

export function setThreshold(key, value) {
  if (!(key in thresholds)) {
    log.warn(`Unknown threshold key "${key}" — ignoring.`);
    return;
  }
  thresholds = { ...thresholds, [key]: value };
  eventBus.emit(EVENTS.SETTINGS_UPDATED, thresholds);
  persist();
}

export function resetThresholds() {
  thresholds = { ...DEFAULT_THRESHOLDS };
  eventBus.emit(EVENTS.SETTINGS_UPDATED, thresholds);
  persist();
}

/** Call once during dashboard boot, before wiring anything that reads thresholds. */
export async function loadPersistedThresholds() {
  try {
    const result = await chrome.storage?.local?.get(STORAGE_KEY);
    const saved = result?.[STORAGE_KEY];
    if (saved) {
      // Merge over defaults rather than replacing outright, so a threshold
      // added in a later version (not present in an older saved blob)
      // still gets a sane value instead of `undefined`.
      thresholds = { ...DEFAULT_THRESHOLDS, ...saved };
      eventBus.emit(EVENTS.SETTINGS_UPDATED, thresholds);
      log.info("Loaded saved sensitivity settings.");
    }
  } catch (error) {
    log.warn("Could not load saved settings — using defaults.", error);
  }
}
