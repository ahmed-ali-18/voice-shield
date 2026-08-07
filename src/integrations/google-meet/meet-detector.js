import { eventBus } from "../../utils/event-bus.js";
import { createLogger } from "../../utils/logger.js";
import { EVENTS } from "../../utils/constants.js";

const log = createLogger("integrations/google-meet/detector");

/**
 * meet-detector.js — the ONLY job here is answering "are we currently in an
 * active Meet call right now?" and emitting MEETING_JOINED/MEETING_LEFT on
 * transitions. No camera/mic/decision logic lives here — meet-controller.js
 * reacts to these events.
 *
 * Detection strategy: Meet is a single-page app, so neither a plain page-load
 * check nor a MutationObserver alone is reliable — URL can change without a
 * full reload, and the toolbar can mount/unmount without a URL change (e.g.
 * lobby → in-call). We combine both:
 *   1. A MutationObserver watching for the in-call toolbar's signature.
 *   2. A low-frequency URL poll as a fallback for transitions the observer
 *      might miss entirely.
 *
 * Selector philosophy (learned from live testing + 2025/2026 community
 * reference implementations):
 *   - aria-labels are the most stable signal, but labels now carry keyboard
 *     hints ("Turn off microphone (Ctrl+D)"), so EVERY match is a substring
 *     match ([aria-label*="..."]), never an exact "=" match.
 *   - `data-is-muted` / `data-mute-button` on the mic button are
 *     language-independent and still present in current Meet.
 *   - A single signal is NOT enough: the current waiting-room UI can contain
 *     the "Leave call" control too, so in-call requires either the leave
 *     control, or at least TWO other in-call signals together.
 *   - The pre-join/lobby screen is excluded explicitly (name input,
 *     "Join now" / "Ask to join", Meet's media-permission modal) BEFORE any
 *     in-call signal is trusted.
 *
 * If nothing matches after a grace period, a diagnostic dump prints which
 * selectors matched and a sample of the page's button aria-labels, so a
 * Meet UI change is diagnosable from DevTools instead of a silent no-op.
 */

const URL_POLL_INTERVAL_MS = 1500;
const NO_MATCH_WARNING_DELAY_MS = 15000;

// --- In-call signals -------------------------------------------------------
// Strongest: only mounts once actually inside a call. Note: current Meet can
// also show this in the waiting room, so on its own it is NOT sufficient —
// but combined with the lobby exclusion below it is the primary signal.
const LEAVE_CALL_SELECTOR = [
  'button[aria-label*="Leave call" i]',
  'button[aria-label*="Leave meeting" i]',
].join(", ");

// The in-call control bar: mic/camera toggles (substring labels + stable
// data attributes), the People button, participant tiles, and the toolbar
// container itself (jsname is more stable than obfuscated class names).
const DEVICE_TOGGLE_SELECTOR = [
  '[data-is-muted]',
  '[data-mute-button]',
  'button[aria-label*="Turn off microphone" i]',
  'button[aria-label*="Turn on microphone" i]',
  'button[aria-label*="microphone" i]',
  'button[aria-label*="Turn off camera" i]',
  'button[aria-label*="Turn on camera" i]',
].join(", ");

const PEOPLE_BUTTON_SELECTOR = 'button[aria-label*="People" i]';
const PARTICIPANT_TILE_SELECTOR = "[data-participant-id]";
const TOOLBAR_SELECTOR = '[jsname="BOHaEe"]';

// --- Lobby / pre-join exclusion --------------------------------------------
// If ANY of these is present we are NOT in a call: the pre-join name input,
// the join buttons, Meet's "use microphone and camera" permission modal, or
// the "Ready to join?" heading.
const LOBBY_SELECTOR = [
  'input[aria-label="Your name"]',
  'button[aria-label*="Join now" i]',
  'button[aria-label*="Ask to join" i]',
  'button[aria-label*="Use microphone and camera" i]',
  '[aria-label*="Ready to join" i]',
].join(", ");

let observer = null;
let pollHandle = null;
let isInCall = false;
let noMatchWarningTimer = null;

function countMatching(selector) {
  return document.querySelectorAll(selector).length;
}

function looksLikeLobby() {
  return countMatching(LOBBY_SELECTOR) > 0;
}

function detectInCallNow() {
  // Lobby gates everything — the waiting room can contain leave/mic
  // controls, so it must be ruled out before any in-call signal counts.
  if (looksLikeLobby()) return false;

  if (countMatching(LEAVE_CALL_SELECTOR) > 0) return true;

  const deviceSignals = countMatching(DEVICE_TOGGLE_SELECTOR);
  const peopleSignals = countMatching(PEOPLE_BUTTON_SELECTOR);
  const tileSignals = countMatching(PARTICIPANT_TILE_SELECTOR);
  const toolbarSignals = countMatching(TOOLBAR_SELECTOR);

  // Require at least two independent signals: a lone mic button is not
  // enough (the lobby also has device toggles for pre-join testing).
  const signals = [deviceSignals, peopleSignals, tileSignals, toolbarSignals].filter(
    (n) => n > 0
  ).length;
  return signals >= 2;
}

/**
 * Prints a diagnostic dump when the grace period expires without ever seeing
 * an in-call signal: which selector groups matched, plus a sample of the
 * page's button aria-labels. This is the ground truth a future selector fix
 * is built from.
 */
function debugPageSignals() {
  const report = {
    lobbySignals: countMatching(LOBBY_SELECTOR),
    leaveSignals: countMatching(LEAVE_CALL_SELECTOR),
    deviceSignals: countMatching(DEVICE_TOGGLE_SELECTOR),
    peopleSignals: countMatching(PEOPLE_BUTTON_SELECTOR),
    tileSignals: countMatching(PARTICIPANT_TILE_SELECTOR),
    toolbarSignals: countMatching(TOOLBAR_SELECTOR),
  };

  const labels = [];
  document.querySelectorAll("button").forEach((button) => {
    const label = button.getAttribute("aria-label");
    if (label && label.length > 1) labels.push(label);
  });
  const uniqueLabels = [...new Set(labels)].slice(0, 40);

  log.warn("Diagnostic dump for Meet DOM selectors:", {
    selectorReport: report,
    buttonAriaLabelSample: uniqueLabels,
  });
}

function evaluate() {
  const nowInCall = detectInCallNow();
  if (nowInCall === isInCall) return;

  isInCall = nowInCall;
  if (isInCall) {
    if (noMatchWarningTimer) {
      clearTimeout(noMatchWarningTimer);
      noMatchWarningTimer = null;
    }
    log.info("Meeting joined.");
    eventBus.emit(EVENTS.MEETING_JOINED, { url: location.href });
  } else {
    log.info("Meeting left.");
    eventBus.emit(EVENTS.MEETING_LEFT, {});
  }
}

export function isCurrentlyInCall() {
  return isInCall;
}

export function startMeetDetector() {
  if (observer) return; // already running

  observer = new MutationObserver(() => evaluate());
  observer.observe(document.body, { childList: true, subtree: true });

  pollHandle = setInterval(evaluate, URL_POLL_INTERVAL_MS);

  evaluate(); // check immediately in case we're injected mid-call

  // If we never see any in-call signal within the grace period, the person
  // is very likely actually in a call and our selectors just don't match
  // this Meet UI version — dump diagnostics instead of failing silently.
  noMatchWarningTimer = setTimeout(() => {
    if (!isInCall) {
      debugPageSignals();
    }
  }, NO_MATCH_WARNING_DELAY_MS);

  log.info("Meet detector started.");
}

export function stopMeetDetector() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  if (noMatchWarningTimer) {
    clearTimeout(noMatchWarningTimer);
    noMatchWarningTimer = null;
  }
  if (isInCall) {
    isInCall = false;
    eventBus.emit(EVENTS.MEETING_LEFT, {});
  }
  log.info("Meet detector stopped.");
}
