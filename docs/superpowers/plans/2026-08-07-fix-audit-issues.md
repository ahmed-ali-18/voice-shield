# VoiceShield Audit-Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 10 issues found in the read-only audit, ordered from lowest to highest severity, each as an independently testable task.

**Architecture:** All fixes stay inside the existing module boundaries. Pure-logic modules get a minimal `node --test` harness (Node's built-in test runner — no new dependencies). Behavior changes to browser-bound modules (Meet adapter/controller, popup, vision loop) are verified by manual checklists.

**Tech Stack:** JavaScript ES modules, Manifest V3, Node ≥ 18 (`node --test`), no build step, no new runtime dependencies.

## Global Constraints

- Extension must remain loadable as an unpacked MV3 extension after every task (no manifest field removed that is actually used).
- No changes to the public event names or `EVENTS` constant values.
- No new runtime dependencies; tests use only Node's built-in `node:test` and `node:assert`.
- All work happens inside the cloned repo at `voice-shiled/`. Commits run with `voice-shiled` as the working directory.
- Fix order (low → high severity) is fixed by the user: cosmetic → vendor contract → popup labels → settings-change gate loosening → A/V sync pairing → aria-pressed → manual override → vision loop → persisted settings in Meet → README rehaul (user-requested addition) → regression pass.

---
---

### Task 1: Cosmetic hygiene (version drift, dead permission, stale READMEs)

**Files:**
- Modify: `manifest.json:13` (remove `"scripting"`)
- Modify: `src/ui/dashboard.html:272`
- Modify: `src/extension/README.md` (rewrite, 4 lines)
- Modify: `docs/google-meet-integration.md:86` (permissions list)
- Modify: `README.md` (build history §9 — add item 8)

**Interfaces:** None — no code consumers.

- [ ] **Step 1: Remove the unused `scripting` permission**

`manifest.json` permissions block becomes:

```json
  "permissions": [
    "storage",
    "tabs"
  ],
```

(`grep -rn "chrome.scripting" src` confirms zero usages — verified in audit.)

- [ ] **Step 2: Fix version drift in the dashboard footer**

`src/ui/dashboard.html:272`:

```html
    <span id="build-tag">v0.8.0 · Google Meet integration</span>
```

- [ ] **Step 3: Replace the stale `src/extension/README.md`**

Replace the entire file content with:

```markdown
# extension/

Reserved for platform-integration code. The Google Meet integration now lives
in `src/integrations/google-meet/` — see `docs/google-meet-integration.md`.
```

- [ ] **Step 4: Fix the permissions list in the Meet integration doc**

`docs/google-meet-integration.md` §5, second bullet:

```markdown
- `permissions: ["storage", "tabs"]` (added `tabs`)
```

- [ ] **Step 5: Append build-history entry in root README.md**

In `README.md` §9, after item 7:

```markdown
8. Audit-fix pass: settings-change gate hardening, A/V-sync pairing at face rate,
   Meet manual-override redesign, vision-loop fail-closed, Meet loading persisted
   settings, test harness for the decision gate.
```

- [ ] **Step 6: Verify + commit**

Verify: `chrome://extensions` → reload VoiceShield → no "scripting" permission warning; dashboard loads; footer reads v0.8.0.

```bash
git add manifest.json src/ui/dashboard.html src/extension/README.md docs/google-meet-integration.md README.md
git commit -m "chore: version drift, dead scripting permission, stale READMEs"
```

---

### Task 2: MediaPipe vendor contract — pin version + fail loudly on mismatch

**Files:**
- Modify: `vendor/mediapipe/README.md`
- Modify: `src/vision/face-landmarker-loader.js:71-93, 95-110`

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadFaceLandmarker()` now throws a descriptive error if the vendored bundle doesn't expose `createFromOptions`.

- [ ] **Step 1: Pin the version in `vendor/mediapipe/README.md`**

In the setup section, replace the unpinned install line:

```bash
npm install @mediapipe/tasks-vision
```

with:

```bash
npm install @mediapipe/tasks-vision@0.10.22
```

And add this warning block directly after it:

```markdown
> **Version pin — do not upgrade casually.** `face-landmarker-loader.js` depends
> on internal file naming inside the package (`*_internal.js` / `*_module_internal.js`
> glue files). The latest published version is 1.0.1 (checked 2026-08-07) and the
> loader has NOT been tested against it. If you upgrade, re-test model loading in
> BOTH the dashboard tab and inside a Google Meet call before committing.
```

- [ ] **Step 2: Guard the bundle shape after import**

`src/vision/face-landmarker-loader.js`, in `loadFaceLandmarker()`, right after the import:

```js
  const { FaceLandmarker, FilesetResolver } = await import(
    /* webpackIgnore: true */ chrome.runtime.getURL("vendor/mediapipe/vision_bundle.mjs")
  );
  if (typeof FaceLandmarker?.createFromOptions !== "function") {
    throw new Error(
      "Vendored MediaPipe bundle is missing createFromOptions — the pinned version contract is broken. Re-run the vendor/mediapipe/README.md setup with the pinned version."
    );
  }
```

- [ ] **Step 3: Surface the version-mismatch hint on CPU-retry failure**

In `createWithDelegate`, change the final `throw error;` (the `delegate !== "GPU"` branch) to:

```js
    throw new Error(
      "Face Landmarker failed on both GPU and CPU delegates. If you recently upgraded @mediapipe/tasks-vision, re-check the version pin in vendor/mediapipe/README.md.",
      { cause: error }
    );
```

- [ ] **Step 4: Verify + commit**

Verify: dashboard → Start Camera → model loads with no new errors (both delegates retry path is only exercised on GPU failure, so just confirm normal load). To force the guard: temporarily rename `vision_bundle.mjs` → dashboard must show the descriptive error in the event log, then rename back.

```bash
git add vendor/mediapipe/README.md src/vision/face-landmarker-loader.js
git commit -m "fix: pin mediapipe vendor version and fail loudly on bundle mismatch"
```

---

### Task 3: Popup labels — say "analysis" capture in Meet sessions

**Files:**
- Modify: `src/popup/popup.js:117-125` (label block inside `render()`)

**Interfaces:** None — cosmetic only.

- [ ] **Step 1: Contextual button labels**

In `src/popup/popup.js` `render()`, replace the button-label block:

```js
  if (hasSession && !busy) {
    const isMeet = primarySession.kind === "meet";
    const cameraLabel = isMeet ? "Analysis Camera" : "Camera";
    const micLabel = isMeet ? "Analysis Mic" : "Microphone";
    els.cameraBtn.textContent = primarySession.cameraActive ? `Stop ${cameraLabel}` : `Start ${cameraLabel}`;
    els.cameraBtn.classList.toggle("p-btn--active", primarySession.cameraActive);
    els.micBtn.textContent = primarySession.micActive ? `Stop ${micLabel}` : `Start ${micLabel}`;
    els.micBtn.classList.toggle("p-btn--active", primarySession.micActive);
    const tooltip = isMeet
      ? "Controls VoiceShield's analysis capture — never the call's own audio."
      : "";
    els.cameraBtn.title = tooltip;
    els.micBtn.title = tooltip;
  }
```

- [ ] **Step 2: Clear stale tooltips when no session**

In the same function, in the `if (!primarySession)` branch, add before the `return`:

```js
    els.cameraBtn.title = "";
    els.micBtn.title = "";
```

- [ ] **Step 3: Verify + commit**

Verify: dashboard-only session → buttons read "Start Camera"/"Start Microphone". Join a Meet call (or simulate `kind: "meet"` by opening the popup with a Meet tab in a call) → buttons read "Start/Stop Analysis Camera"/"Analysis Mic" with the tooltip.

```bash
git add src/popup/popup.js
git commit -m "feat(popup): label analysis-capture controls distinctly during Meet calls"
```

---

### Task 4: Stop settings changes from loosening the gate + add the test harness

**Files:**
- Create: `package.json` (repo root of `voice-shiled/`)
- Create: `tests/decision-gate.test.js`
- Modify: `src/decision/decision-controller.js:144-148` (SETTINGS_UPDATED handler)

**Interfaces:**
- Consumes: existing `eventBus`, `EVENTS`, `MIC_STATUS`, `startDecisionEngine`, `stopDecisionEngine`, `setThreshold`, `resetThresholds`.
- Produces: `npm test` runs `node --test tests/`. The gate must stay MUTED across a settings change while lip/voice series are anti-correlated.

**Why:** `SYNC_WINDOW_SAMPLES` has no slider (settings-panel `FIELDS` list confirmed), so rebuilding `avSyncDetector` on every `SETTINGS_UPDATED` only clears correlation history — for ~1s `hasEnoughHistory=false` makes `inSync` pass unconditionally, temporarily *opening* the gate. `SYNC_THRESHOLD` is already read live from the store in `evaluate()`.

- [ ] **Step 1: Add the test harness (package.json)**

```json
{
  "name": "voiceshield",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/decision-gate.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { eventBus } from "../src/utils/event-bus.js";
import { EVENTS, MIC_STATUS } from "../src/utils/constants.js";
import {
  startDecisionEngine,
  stopDecisionEngine,
} from "../src/decision/decision-controller.js";
import { setThreshold, resetThresholds } from "../src/utils/settings-store.js";

// Persistent capture: DECISION_UPDATED emits synchronously during the
// triggering metric emit, so this listener always holds the latest decision.
let latestDecision = null;
eventBus.on(EVENTS.DECISION_UPDATED, (d) => {
  latestDecision = d;
});

function lastDecision() {
  return latestDecision;
}

function faceUpdate(i, speechScore) {
  eventBus.emit(EVENTS.FACE_METRICS_UPDATED, {
    faceDetected: true,
    mouthOpenScore: 0.2,
    lipMovementScore: speechScore,
    naturalSpeechPattern: true,
    speechPatternScore: speechScore,
    headYaw: 0,
    headPitch: 0,
    facingCamera: true,
  });
}

// voiceActive is forced true so only the A/V-sync leg can block the gate.
function audioUpdate(vadScore) {
  eventBus.emit(EVENTS.AUDIO_METRICS_UPDATED, {
    audioLevel: vadScore,
    vadScore,
    voiceActive: true,
  });
}

/** Fills the sync window with lip/voice series that are anti-correlated (r ≈ -1). */
function fillAntiCorrelatedWindow() {
  for (let i = 0; i < 40; i++) {
    const lip = (Math.sin(i / 2) + 1) / 2; // 0..1
    faceUpdate(i, lip);
    audioUpdate(1 - lip);
  }
}

test("gate stays MUTED while lip and voice are anti-correlated", () => {
  // HOLD_TIME 0 excludes the debounce from this test: the hold gate would
  // otherwise keep the gate ACTIVE for up to 500ms after the last true tick.
  setThreshold("HOLD_TIME_MS", 0);
  startDecisionEngine();
  fillAntiCorrelatedWindow();
  assert.equal(lastDecision().micStatus, MIC_STATUS.MUTED);
  stopDecisionEngine();
  resetThresholds();
});

test("changing HOLD_TIME_MS must not loosen the gate (sync history survives)", () => {
  setThreshold("HOLD_TIME_MS", 0);
  startDecisionEngine();
  fillAntiCorrelatedWindow();
  assert.equal(lastDecision().micStatus, MIC_STATUS.MUTED);

  setThreshold("HOLD_TIME_MS", 700); // triggers SETTINGS_UPDATED
  faceUpdate(100, 0.9);
  audioUpdate(0.1);

  assert.equal(lastDecision().micStatus, MIC_STATUS.MUTED);
  stopDecisionEngine();
  resetThresholds();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test` (workdir `voice-shiled`)
Expected: the second test FAILS — after `setThreshold`, the rebuilt `avSyncDetector` reports `hasEnoughHistory: false`, so `inSync` passes and the gate flips ACTIVE.

- [ ] **Step 4: Implement the fix**

`src/decision/decision-controller.js`, `SETTINGS_UPDATED` handler becomes:

```js
eventBus.on(EVENTS.SETTINGS_UPDATED, (thresholds) => {
  if (!running) return;
  // Only HOLD_TIME_MS is baked into a tracker at construction. The sync
  // detector is NOT rebuilt: SYNC_WINDOW_SAMPLES has no slider, and
  // SYNC_THRESHOLD is read live from the store in evaluate() — rebuilding
  // would only clear the correlation history, which briefly LOOSENS the gate
  // (hasEnoughHistory=false → inSync passes unconditionally for ~1s).
  holdGate = createHoldTimeGate(thresholds.HOLD_TIME_MS);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json tests/decision-gate.test.js src/decision/decision-controller.js
git commit -m "fix: settings changes no longer reset A/V-sync history and loosen the gate"
```

---

### Task 5: Time-align A/V sync pairs at the face-update rate

**Files:**
- Modify: `src/decision/decision-controller.js`
- Modify: `tests/decision-gate.test.js` (add one test)

**Interfaces:**
- Consumes: `createAvSyncDetector` (unchanged signature).
- Produces: `avSyncDetector.update()` is called exactly once per `FACE_METRICS_UPDATED` (not per audio event). New module state: `lastSync = { syncScore, hasEnoughHistory }`, updated on face ticks, consumed by `evaluate()`.

**Why:** `evaluate()` previously pushed a (lip, audio) pair on *every* face AND audio event. Face ticks at video-frame rate (~30fps, halts when the video stalls), audio at rAF rate (~60fps) — so the ring buffers held misaligned series (several audio samples per lip sample). Pairing at the slower signal's rate with sample-and-hold on the faster one is the standard fix, and it also stops a stalled video from contaminating the window with audio-only pushes.

- [ ] **Step 1: Write the failing test**

Append to `tests/decision-gate.test.js`:

```js
test("sync history accumulates at face rate, not audio rate", () => {
  setThreshold("HOLD_TIME_MS", 0);
  startDecisionEngine();

  // 29 face events (window is 30) — each with one trailing audio event.
  for (let i = 0; i < 29; i++) {
    faceUpdate(i, 0.5);
    audioUpdate(0.5);
  }
  assert.equal(lastDecision().syncScore, 1, "window not full yet");

  // 10 audio-only events must NOT push new pairs.
  for (let i = 0; i < 10; i++) audioUpdate(0.8);
  assert.equal(lastDecision().syncScore, 1, "audio-only events must not fill the sync window");

  // The 30th face event fills the window → real correlation replaces the sentinel.
  faceUpdate(100, 0.5);
  audioUpdate(0.5);
  assert.notEqual(lastDecision().syncScore, 1);
  stopDecisionEngine();
  resetThresholds();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: the new test FAILS — pre-fix, the 10 audio-only events push pairs and fill the window, so `syncScore` is already a real correlation value.

- [ ] **Step 3: Implement the fix**

In `src/decision/decision-controller.js`:

Replace the `evaluate()` function body's sync section:

```js
function evaluate() {
  const visualSpeaking = computeVisualSpeaking(latestFaceMetrics);
  const voiceActive = latestAudioMetrics.voiceActive;

  // lastSync is refreshed once per face tick (see the FACE_METRICS_UPDATED
  // handler) so both series are sampled at the same rate and time-aligned.
  const { syncScore, hasEnoughHistory } = lastSync;
  // Don't block on sync during the first ~1s of a session/re-detection —
  // there isn't enough history yet to judge correlation either way.
  const inSync = !hasEnoughHistory || syncScore >= getThresholds().SYNC_THRESHOLD;
  // ... rest of evaluate() unchanged ...
```

Add module state next to the other `let`s:

```js
let lastSync = { syncScore: 1, hasEnoughHistory: false };
```

In `startDecisionEngine()`, after the detector creation:

```js
  lastSync = { syncScore: 1, hasEnoughHistory: false };
```

Replace the `FACE_METRICS_UPDATED` handler:

```js
eventBus.on(EVENTS.FACE_METRICS_UPDATED, (detail) => {
  if (!running) return;
  latestFaceMetrics = detail;
  // Pair lip + latest audio at the face-update rate only — see evaluate().
  lastSync = avSyncDetector.update(
    detail.speechPatternScore ?? 0,
    latestAudioMetrics.vadScore ?? 0
  );
  evaluate();
});
```

Replace the `AUDIO_METRICS_UPDATED` handler:

```js
eventBus.on(EVENTS.AUDIO_METRICS_UPDATED, (detail) => {
  if (!running) return;
  latestAudioMetrics = detail;
  evaluate();
});
```

In all four fail-closed handlers (`CAMERA_STOPPED`, `CAMERA_ERROR`, `MIC_STOPPED`, `MIC_ERROR`), alongside `avSyncDetector?.reset();` add:

```js
  lastSync = { syncScore: 1, hasEnoughHistory: false };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decision/decision-controller.js tests/decision-gate.test.js
git commit -m "fix: time-align A/V sync pairs at the face-update rate"
```

---

### Task 6: Remove the ambiguous `aria-pressed` fallback in Meet mute-state reading

**Files:**
- Modify: `src/integrations/google-meet/meet-adapter.js:48-55`

**Interfaces:** None — `readMuteState()` keeps its `boolean | null` contract.

**Why:** `aria-pressed` on Meet's mute toggle almost certainly means "pressed = muted" (toggle-button convention); the code assumes the opposite ("active = unmuted"). A wrong guess makes `syncMuteState` click the button on every tick — a self-fighting loop. The branch is unverifiable without a live Meet session, so the lazy correct move is to drop it: if neither `data-is-muted` nor a clear label matches, return `null` and the controller safely no-ops.

- [ ] **Step 1: Delete the `aria-pressed` branch**

`src/integrations/google-meet/meet-adapter.js`, inside `readMuteState()`, delete:

```js
  if (button.hasAttribute("aria-pressed")) {
    // aria-pressed="true" means the button is active — i.e. unmuted.
    return button.getAttribute("aria-pressed") !== "true";
  }
```

And update the header comment (first paragraph) to note: `aria-pressed` is intentionally NOT used — its semantics on Meet's mute toggle are unverified and a wrong reading would cause a self-fighting sync loop.

- [ ] **Step 2: Verify + commit**

Verify: no way to test against live Meet from here — code review only: `readMuteState()` now returns true/false only from `data-is-muted` or an explicit label match, else `null` (no-op path).

```bash
git add src/integrations/google-meet/meet-adapter.js
git commit -m "fix: drop ambiguous aria-pressed fallback from Meet mute-state reading"
```

---

### Task 7: Manual override — respect the user until the decision itself changes

**Files:**
- Modify: `src/integrations/google-meet/meet-controller.js:24, 30-32, 141-164`
- Modify: `docs/google-meet-integration.md:120-122` (§9)

**Interfaces:** None — `handleDecisionUpdated({ micStatus })` unchanged.

**Why:** Today the 4s cooldown merely delays the fight: if the engine keeps wanting MUTED and the user keeps the mic unmuted, VoiceShield re-mutes them every 4s, forever. README's design option (a) — "respect as a temporary manual override until you speak again" — is the right behavior: pause auto-sync until the engine's *desired state flips* (which means the user is speaking again).

- [ ] **Step 1: Replace cooldown with resume-on-flip**

`src/integrations/google-meet/meet-controller.js`:

Delete the constant:

```js
const MANUAL_OVERRIDE_COOLDOWN_MS = 4000;
```

Replace the state declarations:

```js
let manualOverrideMicStatus = null; // engine's desired state when the user took over
```

Replace the `handleDecisionUpdated` body:

```js
function handleDecisionUpdated({ micStatus }) {
  if (!running) return;

  // If the user manually overrode us, stay hands-off until the engine's
  // desired state itself changes (i.e. they're speaking again).
  if (manualOverrideMicStatus !== null) {
    if (micStatus === manualOverrideMicStatus) return;
    manualOverrideMicStatus = null;
    log.info("Decision changed — resuming mute-button auto-sync.");
  }

  if (lastProgrammaticMutedState !== null) {
    const actualMuted = readMuteState();
    if (actualMuted !== null && actualMuted !== lastProgrammaticMutedState) {
      manualOverrideMicStatus = micStatus;
      log.info("Manual mute override detected — pausing auto-sync until the decision changes.");
      return;
    }
  }

  const shouldBeActive = micStatus === MIC_STATUS.ACTIVE;
  const result = syncMuteState(shouldBeActive);
  if (result.synced) {
    lastProgrammaticMutedState = !shouldBeActive;
  }

  updateBadge({ micStatus });
  eventBus.emit(EVENTS.ADAPTER_MUTE_SYNCED, { micStatus, ...result });
}
```

In `handleMeetingLeft()`, replace `manualOverrideUntil = 0;` with:

```js
  manualOverrideMicStatus = null;
```

- [ ] **Step 2: Update the design-question doc**

`docs/google-meet-integration.md` §9 — replace the paragraph with:

```markdown
## 9. Manual-override behavior (decided)

A manual click on Meet's mute button pauses auto-sync until VoiceShield's
own decision changes (i.e. until you're detected speaking again). This
implements design option (a): the manual override is respected, and the
engine never fights a user who deliberately took control. The badge keeps
showing what VoiceShield *wants* the state to be, so the divergence is
visible.
```

- [ ] **Step 3: Verify + commit**

Verify (manual, live Meet): while engine says MUTED, unmute manually → no re-mute after 4s; badge still shows MUTED. Speak → badge flips ACTIVE and Meet's button syncs.

```bash
git add src/integrations/google-meet/meet-controller.js docs/google-meet-integration.md
git commit -m "fix: manual mute override respected until the decision changes"
```

---

### Task 8: Vision loop — never die silently; fail closed on crash

**Files:**
- Modify: `src/vision/vision-controller.js:89-101` (loop) and `stopVision` path
- Modify: `src/decision/decision-controller.js` (add `VISION_ERROR` fail-closed handler)
- Modify: `tests/decision-gate.test.js` (add one test)

**Interfaces:**
- Consumes: `EVENTS.VISION_ERROR` (already defined in constants).
- Produces: a crashed vision loop emits `VISION_ERROR` and stops; the decision gate resets face metrics and evaluates MUTED on `VISION_ERROR`.

- [ ] **Step 1: Write the failing test**

Append to `tests/decision-gate.test.js`:

```js
test("VISION_ERROR fails the gate closed immediately", () => {
  setThreshold("HOLD_TIME_MS", 0);
  startDecisionEngine();

  // Correlated series; the sync window (30) is not full yet, so the gate opens.
  for (let i = 0; i < 5; i++) {
    faceUpdate(i, 0.9);
    audioUpdate(0.9);
  }
  assert.equal(lastDecision().micStatus, MIC_STATUS.ACTIVE);

  eventBus.emit(EVENTS.VISION_ERROR, { message: "boom" });
  assert.equal(lastDecision().micStatus, MIC_STATUS.MUTED);
  stopDecisionEngine();
  resetThresholds();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: fails — `VISION_ERROR` currently does nothing, gate stays ACTIVE (or in hold).

- [ ] **Step 3: Fail closed in `decision-controller.js`**

Add next to the other fail-closed handlers:

```js
eventBus.on(EVENTS.VISION_ERROR, () => {
  latestFaceMetrics = EMPTY_FACE_METRICS;
  avSyncDetector?.reset();
  lastSync = { syncScore: 1, hasEnoughHistory: false };
  if (running) evaluate();
});
```

- [ ] **Step 4: Harden the vision loop**

`src/vision/vision-controller.js`, replace the loop:

```js
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: all four tests PASS.

- [ ] **Step 6: Verify + commit**

Verify: dashboard — force a crash by throwing inside `processResult` (temporary debug line), confirm the event log shows the error and the gate goes MUTED; remove the debug line. `npm test` green.

```bash
git add src/vision/vision-controller.js src/decision/decision-controller.js tests/decision-gate.test.js
git commit -m "fix: vision loop fails closed instead of freezing on stale metrics"
```

---

### Task 9: Meet engine must load persisted sensitivity settings

**Files:**
- Modify: `src/integrations/google-meet/meet-controller.js:9, 90-91`

**Interfaces:**
- Consumes: `loadPersistedThresholds` from `../../utils/settings-store.js`.
- Produces: before `startDecisionEngine()` in a Meet call, persisted `chrome.storage.local` thresholds are merged into the in-memory store.

**Why:** `loadPersistedThresholds()` was only ever called from the dashboard boot path, so the Meet engine silently ran on factory defaults — contradicting README §1 ("Settings you tune in the dashboard apply the next time the engine starts inside a Meet tab").

- [ ] **Step 1: Import + call before engine start**

Add to the imports in `meet-controller.js`:

```js
import { loadPersistedThresholds } from "../../utils/settings-store.js";
```

In `handleMeetingJoined()`, immediately before `startDecisionEngine();`:

```js
  await loadPersistedThresholds();
  startDecisionEngine();
```

- [ ] **Step 2: Verify + commit**

Verify (manual, live Meet): set `Hold time` to 1500ms in the dashboard → reload the Meet tab → join a call → Meet tab console shows `[VoiceShield:settings-store] Loaded saved sensitivity settings.` and the gate holds ACTIVE ~1.5s after speech stops.

```bash
git add src/integrations/google-meet/meet-controller.js
git commit -m "fix: Meet engine loads persisted sensitivity settings before starting"
```

---

### Task 10: Rehaul both READMEs (root + vendor/mediapipe)

**Files:**
- Rewrite: `README.md` (root, ~19KB today)
- Rewrite: `vendor/mediapipe/README.md`

**Interfaces:** None — documentation only. This task is a full rewrite, so it must preserve every fact the earlier tasks already landed: the version pin + upgrade warning from Task 2, the build-history entry from Task 1, and the test-coverage note (below). The final regression (Task 11) no longer touches README.md.

**Requirements — root `README.md`:**
- Keep the existing structure and tone (status-first, architecture, "how detection works", settings table, limitations, roadmap, privacy, build history). This README is already good — the rehaul updates stale content and tightens prose, it does not invent new sections.
- Update stale content, verified against the current code:
  - Version references: `v0.8.0` everywhere (dashboard footer parity). No `v0.7.0` or "Module 6" remains.
  - §1 status: Meet Tier 1 done; add one line that an audit-fix pass hardened the gate (settings now apply in Meet, manual override is respected until the decision changes, vision fails closed).
  - §5 settings: state that dashboard-tuned settings now apply to the Meet engine too (persisted thresholds are loaded before the engine starts).
  - §6 known limitations: replace the "No automated tests yet" bullet with the test-coverage note (see below). Keep the still-true limits: Meet-only, mute-gate-only (Tier 2 not built), double capture, single speaker, single face, camera-dependent, no automated Meet-adapter tests.
  - §9 build history: add the audit-fix entry from Task 1.
- Add a short **Development** section (before Privacy or after Build history): `npm test` runs the decision-gate suite (Node ≥ 18, no dependencies), `tests/decision-gate.test.js` covers AND-logic, A/V-sync pairing, settings-change behavior, and fail-closed paths.
- Test-coverage note to include verbatim in §6:

```markdown
- **Partial test coverage.** `tests/decision-gate.test.js` covers the decision gate
  (AND-logic, fail-closed paths, A/V-sync pairing, settings-change behavior) via
  Node's built-in test runner — `npm test`. The Meet adapter/controller, popup,
  and UI remain manual-checklist territory.
```

- Do NOT introduce inaccuracies: double capture, single-face, single-speaker, browser-only, and Tier 2 (outgoing-track replacement) are all still true.

**Requirements — `vendor/mediapipe/README.md`:**
- Keep the one-time setup steps (npm install → copy bundle + wasm → curl model → reload).
- Pin the version: `npm install @mediapipe/tasks-vision@0.10.22` with the upgrade warning from Task 2 ("latest published is 1.0.1, loader untested against it — re-test dashboard + Meet before upgrading").
- Add an "After an upgrade, verify" checklist: (1) dashboard loads the model, (2) Meet badge appears in a call, (3) no "missing createFromOptions" error — which is the loader's explicit version-contract failure signal.
- Explain why BOTH wasm variants are vendored (`vision_wasm_internal.*` and `vision_wasm_module_internal.*`): the loader's content-script glue workaround imports the `_module_internal.js` ESM glue so `globalThis.ModuleFactory` lands in the isolated world — do not delete either variant.
- Keep the model-file privacy note (weights download once, no media uploaded).

- [ ] **Step 1: Rewrite `README.md`**

Full rewrite per the requirements above. Verify afterwards with:

```bash
grep -n "v0.7.0\|Module 6\|No automated tests" README.md   # expect: no matches
grep -n "0.8.0\|npm test\|tests/decision-gate.test.js" README.md   # expect: matches
```

- [ ] **Step 2: Rewrite `vendor/mediapipe/README.md`**

Full rewrite per the requirements above. Verify afterwards:

```bash
grep -n "0.10.22\|1.0.1\|module_internal\|missing createFromOptions" vendor/mediapipe/README.md   # expect: matches
```

- [ ] **Step 3: Cross-check facts against code**

Spot-check the rewritten README against the codebase: architecture diagram paths, threshold names in the settings table (`LIP_MOVEMENT_THRESHOLD`, `VAD_ACTIVITY_THRESHOLD`, `HOLD_TIME_MS`, `SYNC_THRESHOLD` …), and the DSP chain order (highpass 90Hz → voice emphasis → lowpass 7.5kHz → compressor → noise gate). Fix any mismatch found.

- [ ] **Step 4: Commit**

```bash
git add README.md vendor/mediapipe/README.md
git commit -m "docs: rehaul root and mediapipe READMEs to match v0.8.0 state"
```

---

### Task 11: Final regression pass

**Files:** none modified — verification only.

- [ ] **Step 1: Full regression**

1. `npm test` → all tests pass.
2. `chrome://extensions` → reload → dashboard opens; camera + mic + vision start; gate behaves.
3. Popup shows correct session state and (Meet) analysis-capture labels.
4. Live Meet checklist from `docs/google-meet-integration.md` §8 (badge, mute sync, manual override, leave-call teardown, double-capture prompts).

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: final regression pass"
```

(Only if the regression found and fixed something; otherwise skip this commit.)

---
---

## Self-review notes (completed before handoff)

- **Spec coverage:** all 10 audit findings map 1:1 to Tasks 1–9; Task 10 is the user-requested README rehaul (root + mediapipe); Task 11 is the regression pass. Ordering is exactly low → high severity as requested.
- **No placeholders:** every code change is written out in full; verification steps give the exact command and expected result.
- **Type consistency:** `lastSync = { syncScore, hasEnoughHistory }` is introduced in Task 5 and consumed consistently by `evaluate()`, the face handler, the four fail-closed handlers, and Task 8's `VISION_ERROR` handler. `readMuteState()` keeps its `boolean | null` contract. `handleDecisionUpdated({ micStatus })` signature unchanged. `manualOverrideMicStatus` replaces `manualOverrideUntil` everywhere (Task 7 touches both declaration and reset sites).
- **Known residual risks (documented, not fixed here):** Meet DOM selectors unverified against live Meet; `getProcessedStream()` still unused (Tier 2); no multi-face/speaker separation. All pre-existing and out of scope for this audit pass.
