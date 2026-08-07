import { createLogger } from "../../utils/logger.js";

const log = createLogger("integrations/google-meet/adapter");

/**
 * meet-adapter.js — THE ONLY file in this project allowed to contain
 * Google-Meet-specific DOM selectors. If Meet changes its markup, this is
 * the one file that needs to change — meet-controller.js and the core
 * engine stay untouched.
 *
 * Primary selector: the `data-is-muted` attribute, which is language-
 * independent (unlike aria-label text, which only matches English UI).
 * Falls back to `data-mute-button`, then substring aria-label matching
 * (labels carry keyboard hints like "Turn off microphone (Ctrl+D)", so
 * exact "=" matches break). `aria-pressed` is intentionally NOT used —
 * its semantics on Meet's mute toggle are unverified and a wrong reading
 * would cause a self-fighting sync loop.
 *
 * This has not been validated against a live Meet session from this
 * environment — it's grounded in current community reference
 * implementations (see docs/google-meet-integration.md §6) and needs your
 * live testing to confirm/adjust.
 */

const MUTE_BUTTON_SELECTORS = [
  '[data-is-muted]',
  '[data-mute-button]',
  'button[aria-label*="Turn off microphone" i]',
  'button[aria-label*="Turn on microphone" i]',
  'button[aria-label*="microphone" i]',
];

function findMuteButton() {
  for (const selector of MUTE_BUTTON_SELECTORS) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * Returns true/false if we can confidently read the current state, or null
 * if no mute control could be found at all (e.g. mid-transition, or the
 * selector needs updating for a Meet UI change).
 */
export function readMuteState() {
  const button = findMuteButton();
  if (!button) return null;

  if (button.hasAttribute("data-is-muted")) {
    return button.getAttribute("data-is-muted") === "true";
  }

  const label = button.getAttribute("aria-label") || "";
  if (/turn on microphone/i.test(label)) return true; // "Turn on" = currently muted
  if (/turn off microphone/i.test(label)) return false; // "Turn off" = currently unmuted
  if (/^unmute/i.test(label.trim())) return true;
  if (/^mute/i.test(label.trim())) return false;

  return null;
}

/** Clicks Meet's real mute toggle. Returns true if a click was issued. */
function clickMuteButton() {
  const button = findMuteButton();
  if (!button) {
    log.warn("Could not find Meet's mute control — selector may need updating for this Meet UI version.");
    return false;
  }
  button.click();
  return true;
}

/**
 * Syncs Meet's actual mute state to match VoiceShield's decision.
 * No-ops if Meet already matches (avoids fighting a manual click on every
 * evaluate tick) or if the control can't be found. Returns the outcome for
 * the controller to log/emit.
 */
export function syncMuteState(shouldBeActive) {
  const currentlyMuted = readMuteState();
  if (currentlyMuted === null) {
    return { synced: false, reason: "control-not-found" };
  }

  const shouldBeMuted = !shouldBeActive;
  if (currentlyMuted === shouldBeMuted) {
    return { synced: true, reason: "already-in-sync", changed: false };
  }

  const clicked = clickMuteButton();
  return clicked
    ? { synced: true, reason: "clicked", changed: true }
    : { synced: false, reason: "click-failed" };
}
