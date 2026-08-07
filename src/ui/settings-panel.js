import { eventBus } from "../utils/event-bus.js";
import { EVENTS } from "../utils/constants.js";
import { getThresholds, setThreshold, resetThresholds, loadPersistedThresholds } from "../utils/settings-store.js";

/**
 * ui/settings-panel.js — single responsibility: wire the Detection
 * Sensitivity card's <input type="range"> sliders to utils/settings-store.js.
 * Every module that reads a threshold reads it live from the store, so
 * moving a slider here takes effect immediately across vision/, vad/, and
 * decision/ without restarting the camera or mic.
 */

const FIELDS = [
  { key: "LIP_MOVEMENT_THRESHOLD", inputId: "setting-lip-movement", valueId: "setting-lip-movement-value", format: (v) => v.toFixed(2) },
  { key: "VAD_ACTIVITY_THRESHOLD", inputId: "setting-vad", valueId: "setting-vad-value", format: (v) => v.toFixed(2) },
  { key: "HOLD_TIME_MS", inputId: "setting-hold-time", valueId: "setting-hold-time-value", format: (v) => `${Math.round(v)}ms` },
  { key: "HEAD_YAW_MAX_DEGREES", inputId: "setting-yaw", valueId: "setting-yaw-value", format: (v) => `${Math.round(v)}°` },
  { key: "HEAD_PITCH_MAX_DEGREES", inputId: "setting-pitch", valueId: "setting-pitch-value", format: (v) => `${Math.round(v)}°` },
  { key: "MOUTH_OPEN_THRESHOLD", inputId: "setting-mouth-open", valueId: "setting-mouth-open-value", format: (v) => v.toFixed(2) },
  { key: "NATURAL_SPEECH_MIN_ACTIVE_FRACTION", inputId: "setting-active-fraction", valueId: "setting-active-fraction-value", format: (v) => v.toFixed(2) },
  { key: "NATURAL_SPEECH_MIN_VARIABILITY", inputId: "setting-variability", valueId: "setting-variability-value", format: (v) => v.toFixed(3) },
  { key: "SYNC_THRESHOLD", inputId: "setting-sync", valueId: "setting-sync-value", format: (v) => v.toFixed(2) },
];

function syncFieldsFromStore() {
  const thresholds = getThresholds();
  for (const field of FIELDS) {
    const input = document.getElementById(field.inputId);
    const output = document.getElementById(field.valueId);
    if (!input || !output) continue;
    const value = thresholds[field.key];
    input.value = String(value);
    output.textContent = field.format(value);
  }
}

/** Call once during dashboard boot, after the DOM is ready. */
export async function initSettingsPanel() {
  await loadPersistedThresholds();
  syncFieldsFromStore();

  for (const field of FIELDS) {
    const input = document.getElementById(field.inputId);
    const output = document.getElementById(field.valueId);
    if (!input) continue;

    input.addEventListener("input", () => {
      const value = Number(input.value);
      setThreshold(field.key, value);
      if (output) output.textContent = field.format(value);
    });
  }

  const resetBtn = document.getElementById("settings-reset-btn");
  resetBtn?.addEventListener("click", () => {
    resetThresholds();
    syncFieldsFromStore();
  });

  // Keeps sliders in sync if settings change from somewhere other than this
  // panel (e.g. a future "reset" triggered elsewhere).
  eventBus.on(EVENTS.SETTINGS_UPDATED, syncFieldsFromStore);
}
