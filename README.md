# VoiceShield

**Camera-Assisted Voice Isolation for Video Calls and Meetings**
A privacy-preserving Chrome extension (Manifest V3) that gates microphone transmission using on-device facial-landmark detection combined with real-time voice activity detection. All processing happens locally — no audio or video ever leaves the machine.

Research prototype — Department of Data Science, ACE Engineering College. Current version: **v0.8.0**.

---

## 1. Current status — read this first

**VoiceShield is a working detection/decision engine with a live dashboard, now also integrated with Google Meet.** Zoom Web, Teams Web, and WhatsApp Web are not yet connected — see [§7](#7-roadmap--extending-to-more-platforms--deeper-integration).

Right now, VoiceShield:
- **Captures** your webcam and microphone
- **Detects** natural speech (multi-frame lip-movement pattern + facing-camera check)
- **Detects** voice activity (adaptive energy-based VAD)
- **Correlates** the two in time (A/V sync) to reject unrelated background voices
- **Applies** real-time DSP noise suppression + a noise gate
- **Shows** the live ACTIVE/MUTED decision on its own dashboard
- **Runs automatically inside Google Meet** — joins the detection pipeline the moment you enter a call, and syncs the decision to Meet's real mute/unmute button

It does **not** yet:
- Work inside Zoom Web, Teams Web, or WhatsApp Web (same architecture, not yet built — see §7)
- Replace the actual outgoing audio track with the noise-suppressed signal (today it only gates mute/unmute; the DSP-cleaned audio doesn't yet reach other participants — see §7, "Tier 2")

An audit-fix pass hardened the gate since Meet integration shipped: settings tuned in the dashboard now apply inside Meet (persisted thresholds are loaded before the engine starts), a manual override of Meet's mute button is respected until the engine's own decision changes, and a vision failure fails the gate closed instead of freezing on stale readings.

This was a deliberate, staged scope: the original brief asked for a *simulated* MVP first, which shipped as the dashboard; platform integration followed as its own phase, documented in full in [`docs/google-meet-integration.md`](docs/google-meet-integration.md).

### Where to test it

**Three surfaces:**

1. **The toolbar popup** — click the VoiceShield toolbar icon. A compact remote-control popup shows the live ACTIVE/MUTED gate, face/voice/sync metrics, and Start/Stop Camera + Microphone buttons for whichever session is running. During a Meet call these are labeled "Analysis Camera"/"Analysis Mic" so it's clear they control VoiceShield's own capture, never the call's audio. The popup never hosts the engine itself — closing it can't kill your streams.
2. **The dashboard tab** — click "Open Dashboard" in the popup (or it opens automatically on install). Good for calibrating Detection Sensitivity settings before a call, or testing detection quality in isolation.
3. **Inside an actual Google Meet call** — join any `meet.google.com` call. VoiceShield injects automatically: a small floating badge appears bottom-left showing ACTIVE/MUTED, and Meet's own mic icon toggles to match VoiceShield's decision in real time. No dashboard tab needs to be open for this — it runs independently inside the Meet tab itself.

Settings you tune in the dashboard apply the next time the engine starts inside a Meet tab (both read from the same persisted `chrome.storage.local` values).

---

## 2. Installation

### One-time setup

**Step 1 — Load the unpacked extension**
1. Unzip the project folder
2. Open `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `voiceshield` folder
5. Pin the VoiceShield icon to your toolbar (optional but convenient)

**Step 2 — Vendor the MediaPipe library (required, one-time)**
Manifest V3 blocks extensions from executing JavaScript fetched from a remote server at runtime, so the MediaPipe Face Landmarker library has to physically live inside the extension folder — it can't load from a CDN like a normal webpage. Full steps are in `vendor/mediapipe/README.md`, summarized here:

```bash
mkdir -p /tmp/mp-fetch && cd /tmp/mp-fetch
npm init -y
npm install @mediapipe/tasks-vision@0.10.22

cp node_modules/@mediapipe/tasks-vision/vision_bundle.mjs \
   <path-to-voiceshield>/vendor/mediapipe/vision_bundle.mjs

cp node_modules/@mediapipe/tasks-vision/wasm/* \
   <path-to-voiceshield>/vendor/mediapipe/wasm/

curl -L -o <path-to-voiceshield>/vendor/mediapipe/models/face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
```

**Step 3 — Reload**
`chrome://extensions` → click the reload icon on the VoiceShield card.

**That's it — no separate setup for Google Meet.** The extension already declares `host_permissions` for `meet.google.com` and auto-injects its content script into any Meet tab. The first time it runs there, your browser will prompt for camera/mic permission a second time (separate from Meet's own prompt) — see §6.

### Opening the dashboard
Click the VoiceShield toolbar icon → the popup opens → click **Open Dashboard** (or the dashboard opens automatically on first install). The popup stays deliberately thin: popups close on blur, which would kill the webcam/mic stream mid-session if the engine ran there — so the engine always lives in a tab, and the popup is a remote control for it.

---

## 3. Architecture

```
voiceshield/
├── manifest.json                 Manifest V3 config
├── icons/                        Toolbar icons
├── vendor/mediapipe/             Vendored MediaPipe library + model (see §2)
├── docs/
│   └── google-meet-integration.md   Full platform-integration architecture writeup
├── tests/
│   └── decision-gate.test.js      Decision-gate test suite (see §10)
└── src/
    ├── background/                Message router for the popup; opens the dashboard tab
    ├── popup/                     Toolbar popup — remote control (state + analysis-capture toggles)
    ├── camera/                    Owns getUserMedia({video}) + stream lifecycle
    ├── vision/                    MediaPipe Face Landmarker + speech-pattern detection
    ├── audio/                     getUserMedia({audio}) + Web Audio DSP chain
    ├── vad/                       Voice activity detection (energy-based)
    ├── decision/                  Combines vision + audio into the ACTIVE/MUTED gate
    ├── ui/                        Dashboard HTML/CSS/JS, settings panel
    ├── integrations/
    │   └── google-meet/           ALL Google Meet-specific code — content script,
    │                               DOM-selector adapter, orchestrator, on-page badge.
    │                               Imports the core engine above unmodified.
    └── utils/                     Event bus, logger, constants, session bridge, shared helpers
```

**Core principle: the core engine (`camera/ vision/ audio/ vad/ decision/ utils/`) is platform-agnostic and imports nothing from `integrations/`.** All Google-Meet-specific code — DOM selectors, mute-button syncing, the on-page badge — lives only in `integrations/google-meet/`, which imports the core engine, never the other way around. A future Zoom/Teams/WhatsApp adapter would be a new `integrations/<platform>/` folder following the same shape, reusing the core engine as-is. Full reasoning in [`docs/google-meet-integration.md`](docs/google-meet-integration.md).

Within the core engine, **modules never import each other directly** — they communicate through `utils/event-bus.js` (a tiny pub/sub). This is what let each module be built, tested, and approved independently, and it's also what let `integrations/google-meet/` reuse every one of them unmodified: it just imports the same public functions (`startCamera()`, `startVision()`, etc.) the dashboard already used, and listens for the same `DECISION_UPDATED` event.

### Data flow

```
camera/ ──video frames──► vision/ ──FACE_METRICS_UPDATED──┐
                                                             ├──► decision/ ──DECISION_UPDATED──► ui/ (Gate card)
audio/  ──raw samples───► vad/  ──AUDIO_METRICS_UPDATED───┘                         │
                                                                                      └──► audio/ (drives noise-gate gain)
```

1. **vision/** runs MediaPipe Face Landmarker on each webcam frame, extracts mouth-open score, an adaptive-jitter-floor lip-movement score, head yaw/pitch, and a multi-frame "natural speech pattern" verdict (see §4).
2. **vad/** reads raw microphone samples, computes RMS energy, calibrates an adaptive noise floor, and derives a 0–1 speech probability plus a debounced voice-active boolean.
3. **decision/** holds the latest reading from both, requires all three of: multi-frame visual speech pattern, voice activity, and audio-visual time-correlation (§4) — debounces the result — and emits the final `ACTIVE`/`MUTED` status.
4. **audio/** separately runs a real DSP enhancement chain (highpass → voice-emphasis → lowpass → compressor → noise gate) whose gate gain is driven directly by the decision engine's live reading, so ambient sound between confirmed speech is physically attenuated on the processed output.
5. **ui/** renders all of the above live, and lets you tune every threshold via the Detection Sensitivity panel without restarting anything.

---

## 4. How detection actually works (the parts worth understanding)

### Multi-frame natural speech pattern (not just "mouth open")
A single open-mouth frame is not enough — that false-triggers on yawning or a resting slack jaw. `vision/speech-pattern-detector.js` keeps a rolling ~0.5s window of lip-movement readings and only counts it as speaking when the window shows **both** sustained activity (moving often enough recently) **and** actual variability (frame-to-frame change) — distinguishing a fluttering, talking mouth from a static hold.

### Adaptive jitter floor
Webcam landmark tracking jitters slightly even on a still face. Rather than a fixed threshold, `vision/metrics-extractor.js`'s lip-movement tracker continuously calibrates what *this* camera's resting noise looks like, and only counts movement clearly above that — same design as the audio noise floor below.

### Audio-visual synchronization
Even a genuinely moving mouth and genuine voice activity aren't enough on their own — a stationary face's jitter (or someone chewing) could coincidentally overlap with someone else's voice on the mic. `decision/av-sync-detector.js` runs a rolling Pearson correlation between the lip-movement and voice-energy time series; only a *positive, sustained correlation* counts as evidence the visible person is the one making the sound.

### Adaptive noise floor (VAD)
`vad/vad-engine.js` tracks a slow-moving energy baseline that calibrates to room noise, but is only allowed to drift toward quieter readings — never toward louder ones — so sustained speech can't recalibrate the floor and cause the VAD to stop detecting the speaker.

### Real-time DSP noise suppression
`audio/audio-controller.js` runs mic input through: highpass (90Hz, cuts rumble/hum) → voice-emphasis peaking filter (clarity boost) → lowpass (7.5kHz, cuts hiss) → dynamics compressor (levels out volume swings) → a noise gate whose gain is driven directly by the live decision engine reading. This is native Web Audio DSP — no ML model, consistent with the pure Web Audio API constraint from the brief.

### Fail-closed design
If the camera, microphone, or vision pipeline stops or errors mid-session, the corresponding side of the gate resets to "not speaking" within the hold time (~500ms) — the mic can't get stuck reporting ACTIVE on stale data. A vision failure specifically resets the face metrics and clears the A/V-sync history, so the gate falls closed rather than freezing on its last reading.

---

## 5. Detection Sensitivity settings

Every threshold used above is tunable live from the dashboard's Detection Sensitivity panel, no restart required:

| Setting | What it controls |
|---|---|
| Lip movement sensitivity (`LIP_MOVEMENT_THRESHOLD`) | How much lip velocity counts as "moving" per frame |
| Voice activity sensitivity (`VAD_ACTIVITY_THRESHOLD`) | How far above the noise floor counts as "speaking" |
| Hold time (`HOLD_TIME_MS`) | How long the gate stays ACTIVE after speech signals drop, to avoid flicker on natural pauses |
| Head yaw/pitch max *(advanced)* (`HEAD_YAW_MAX_DEGREES`, `HEAD_PITCH_MAX_DEGREES`) | How far you can turn from the camera and still count as "facing" it |
| Mouth open threshold *(advanced)* (`MOUTH_OPEN_THRESHOLD`) | Informational display threshold only — no longer part of the gating decision |
| Speech pattern fraction/variability *(advanced)* (`NATURAL_SPEECH_MIN_ACTIVE_FRACTION`, `NATURAL_SPEECH_MIN_VARIABILITY`) | Tunes the multi-frame pattern detector's strictness |
| A/V sync threshold *(advanced)* (`SYNC_THRESHOLD`) | How strong the lip/voice correlation must be before gating ACTIVE |

The A/V-sync window length (`SYNC_WINDOW_SAMPLES`, ~1s) is fixed and has no slider.

Settings persist across sessions via `chrome.storage.local`. Since the audit-fix pass, the same persisted values are loaded before the Meet engine starts, so settings tuned in the dashboard apply inside Meet too. **Reset to defaults** restores the factory-calibrated values.

---

## 6. Known limitations

- **Only Google Meet is integrated so far.** Zoom Web, Teams Web, WhatsApp Web are architecturally straightforward to add (same core engine, new `integrations/<platform>/` folder) but not yet built — see §7.
- **Gates mute/unmute only — doesn't yet reach the transmitted audio.** VoiceShield's noise-suppressed, gated signal exists (`audio-controller.js`'s `getProcessedStream()`) but Meet still sends your raw mic while ACTIVE; VoiceShield only controls *whether* it's sending, not the signal itself. Replacing the actual outgoing track is "Tier 2" in `docs/google-meet-integration.md` — deliberately not built yet, since it's meaningfully riskier (a bug there can silently break someone's ability to be heard mid-call) and needs Tier 1 proven stable first.
- **Meet's mute-button DOM selector is unverified against a live Meet session.** `integrations/google-meet/meet-adapter.js` isolates all Meet-specific DOM knowledge to one file specifically so this is a one-file fix if wrong, but it's grounded in community reference implementations, not a live test from this environment — needs your real-world confirmation.
- **Double camera/mic capture during a Meet call.** Meet captures your camera/mic for the actual call; VoiceShield's content script independently captures both again for its own analysis (no API exists to share Meet's internal `MediaStream` with a content script). Expect a second permission prompt and modestly higher CPU/battery draw.
- **Single simultaneous speaker only.** If you and someone else speak at the exact same moment while you're both on camera and in sync, both voices pass through — VoiceShield isolates *when* your mic is open, not *which* voice within that window (true source separation is a much larger undertaking, noted as future work in the original Executive Summary).
- **One face at a time.** The Face Landmarker is configured for a single face; a second person entering frame isn't distinguished from the primary user.
- **Camera-dependent.** Poor lighting, being far from the camera, wearing a mask, or extreme head angles will degrade landmark quality and can produce false negatives (correctly failing "closed" toward MUTED, per the fail-closed design — annoying but not unsafe).
- **A/V sync needs ~1s of history** to become meaningful after each detection restart (camera toggle, face re-entering frame) — there's a brief grace period where sync doesn't block the gate.
- **Changing hold time discards an in-progress hold.** The hold gate is the only tracker rebuilt when its setting changes, so adjusting it mid-speech can drop the gate to MUTED right at the moment of the change until speech re-triggers it. A/V-sync history is deliberately preserved on settings changes — rebuilding it would briefly loosen the gate.
- **Browser-only.** This is a Chrome extension; it cannot see or affect native desktop apps (e.g. the WhatsApp *desktop* app, as opposed to web.whatsapp.com in a browser tab) at all — browser extensions only have access to browser tab contexts.
- **Partial test coverage.** `tests/decision-gate.test.js` covers the decision gate
  (AND-logic, fail-closed paths, A/V-sync pairing, settings-change behavior) via
  Node's built-in test runner — `npm test`. The Meet adapter/controller, popup,
  and UI remain manual-checklist territory.

---

## 7. Roadmap — extending to more platforms + deeper integration

### Done: Google Meet, Tier 1 (mute-button sync)
A content script (`src/integrations/google-meet/`) detects when you're in a Meet call, runs the full core engine headlessly (hidden `<video>`/`<canvas>`, same modules the dashboard uses), and clicks Meet's real mute button to match the decision engine's ACTIVE/MUTED reading — while respecting a manual override: if you click Meet's button yourself, auto-sync pauses until the engine's own decision changes (i.e. until you're detected speaking again). Full design in [`docs/google-meet-integration.md`](docs/google-meet-integration.md).

### Next: Tier 2 — replace the outgoing audio track
Right now Meet still transmits your *raw* mic while ACTIVE — VoiceShield's noise-suppressed, gated stream (`getProcessedStream()`, already built) isn't reaching other participants yet. Tier 2 would override `navigator.mediaDevices.getUserMedia` in a `MAIN`-world script before Meet's own code calls it, so Meet transparently receives the already-processed stream instead. This is meaningfully riskier than Tier 1 — it has to win a race against Meet's own `getUserMedia` call and survive Meet's reconnects/device switches without breaking someone's ability to be heard — so it's deliberately being held until Tier 1 is proven stable through real use.

### Then: Zoom Web / Teams Web / WhatsApp Web
Same shape as `integrations/google-meet/` — a `detector.js` (is this platform's tab in a call?), an `adapter.js` (that platform's DOM selectors, isolated to one file), a `controller.js` (orchestrates the unmodified core engine), and a `ui.js` (badge). None of `camera/ vision/ audio/ vad/ decision/` need to change.

### Further out (per the original Executive Summary's Phase 3)
- **Desktop companion app** creating a system-level virtual microphone, so VoiceShield can gate audio for *native* apps (Zoom desktop, Teams desktop) — not just browser tabs
- **Speaker recognition** to verify the active speaker matches a registered voice profile, hardening against someone else mimicking lip movement in frame
- **Multi-speaker separation** for the "two people talking into the same open mic" edge case noted in §6

---

## 8. Privacy

All facial landmark detection and voice activity detection run **entirely on-device** via MediaPipe (WASM, in-browser) and the Web Audio API. No frame, audio sample, or derived metric is ever sent to a server. The only network activity involved is the one-time MediaPipe model download during setup (see §2) — a static, unauthenticated file, not user data.

---

## 9. Build history

Built incrementally, module by module, with review and testing between each:

1. Extension shell, dashboard UI, event bus
2. Camera controller (webcam permission, live preview)
3. Vision (MediaPipe Face Landmarker integration)
4. Audio + VAD (mic permission, Web Audio, waveform, voice activity detection)
5. Decision engine (the AND-gate, later upgraded to multi-frame + A/V sync + real DSP noise suppression after false-positive testing)
6. Detection Sensitivity settings (live-tunable thresholds, persisted)
7. Google Meet integration, Tier 1 (headless core engine inside the Meet tab, real mute-button sync, on-page badge) — this file updated accordingly
8. Audit-fix pass (9 fixes + test harness):
   - Version drift to 0.8.0, dead `chrome.scripting` permission removed, stale READMEs updated
   - MediaPipe vendor pinned to `@mediapipe/tasks-vision@0.10.22`; the loader now fails loudly when the vendored bundle breaks the version contract
   - Ambiguous `aria-pressed` fallback dropped from Meet mute-state reading
   - Settings changes no longer reset A/V-sync history or loosen the gate
   - A/V-sync pairs time-aligned at the face-update rate
   - Popup labels analysis-capture controls distinctly during Meet calls
   - Manual Meet mute-button override respected until the decision changes
   - Vision loop fails closed on error instead of freezing on stale metrics
   - Meet engine loads persisted sensitivity settings before starting
   - Test harness for the decision gate (`tests/decision-gate.test.js`)
9. Documentation rehaul: both READMEs rewritten to match the v0.8.0 state (this file + `vendor/mediapipe/README.md`)

---

## 10. Development

**Tests.** `npm test` runs the decision-gate suite with Node's built-in test runner (`node --test`) — Node ≥ 18, zero dependencies, nothing to install. The suite lives in `tests/decision-gate.test.js` and covers the gate's AND-logic (lip movement, voice activity, and A/V sync must all agree), A/V-sync pairing at the face-update rate, settings-change behavior (changing hold time must not loosen the gate), and fail-closed paths (a `VISION_ERROR` closes the gate to MUTED within the hold time (~500ms)).
