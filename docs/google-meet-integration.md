# VoiceShield — Platform Integration Architecture

## 1. The constraint that shapes everything

To make VoiceShield "just work" in a live Meet call with no manual dashboard operation, the vision/audio/decision engine has to run **inside the Meet tab itself**, not in VoiceShield's separate dashboard tab. Two hard platform facts force this:

1. **`MediaStream`/`MediaStreamTrack` objects cannot cross tabs.** `chrome.runtime.sendMessage` uses structured clone, which does not support live media objects. There is no API to capture a stream in the dashboard tab and hand it to the Meet tab's `RTCPeerConnection`.
2. **Meet's outgoing WebRTC connection lives in Meet's own page context.** Only code running *in that page* (a content script) can influence what Meet actually sends.

So: the entire capture → detect → decide pipeline must execute inside `meet.google.com`, driven by a content script. The dashboard tab becomes a secondary, optional surface — good for calibrating sensitivity settings before a call, not required during one.

**Consequence worth being upfront about:** your camera and microphone get captured **twice** during a Meet call — once by Meet itself for the actual call, once independently by VoiceShield's content script for analysis. This is unavoidable; there's no API for a content script to read Meet's own internal `MediaStream`. Both captures are still 100% on-device — nothing about this sends data anywhere — but expect two permission prompts on first use, and a bit more CPU/battery draw than Meet alone.

## 2. Two integration tiers

### Tier 1 — Control Meet's own mute button (this milestone)
VoiceShield runs its full detection pipeline in a hidden capture inside the Meet tab, and when the decision engine says MUTED/ACTIVE, a content script clicks Meet's real mute/unmute button — the same action as if you clicked it yourself. Meet's own WebRTC pipeline handles the rest exactly as it always does.

- **Robust for the actual muting behavior** — no interception of encoded audio, no browser security edge cases.
- **Fragile in one specific way**: it depends on `document.querySelector('[data-is-muted]')` (and an `aria-label` fallback) inside Meet's live DOM. Meet's UI can change this without notice. This selector **cannot be verified from this sandboxed environment** — I have no live access to Meet's current DOM. It's grounded in current community-maintained extensions (checked against 2026-dated sources), but it needs validation against your actual Meet session, the same iterative way we've tested every other module.
- Does **not** apply VoiceShield's noise-suppression DSP to what Meet actually transmits — it only gates whether the mic is on or off. While ACTIVE, Meet sends your raw mic audio as it always would.

### Tier 2 — Replace the outgoing track (future milestone, higher risk)
A `MAIN`-world script overrides `navigator.mediaDevices.getUserMedia` before Meet's own code calls it, so Meet transparently receives VoiceShield's already-processed, noise-gated stream (`audio/audio-controller.js`'s `getProcessedStream()`, already built) instead of the raw mic. This would make the noise suppression actually reach other participants, not just gate on/off.

This is meaningfully harder and riskier:
- Requires winning a race against Meet's own `getUserMedia` call (must inject before Meet's JS runs)
- Must survive Meet's own reconnects/device switches without breaking the call
- A bug here can silently break someone's ability to be heard in a real meeting, which is a much worse failure mode than a bug in a standalone dashboard

I'm deliberately not building this yet. It needs Tier 1 proven stable first, plus live testing I can't do myself from here.

## 3. Layered architecture

```
Browser Extension
├── background/                  Per-tab meeting-state tracking, icon/badge
├── ui/ (dashboard, settings)     Unchanged — manual testing/tuning surface
├── camera/ vision/ audio/ vad/ decision/ utils/   ← Core Engine, UNCHANGED
│                                   Platform-agnostic. Zero Meet-specific code.
│                                   Already built (Modules 1-6). Reused as-is
│                                   inside the Meet tab via dynamic import.
└── integrations/
    └── google-meet/              ← ALL Meet-specific code lives only here
        ├── meet-bootstrap.js      Content-script entry point (classic script,
        │                          dynamically imports the core engine's ES modules)
        ├── meet-detector.js       Is this a Meet tab? In a call or in the lobby?
        │                          MutationObserver-based, no meeting-specific
        │                          business logic.
        ├── meet-adapter.js        THE ONLY file with Meet DOM selectors.
        │                          Reads/sets Meet's real mute state.
        ├── meet-controller.js     Orchestrator: starts/stops the core engine
        │                          on join/leave, listens for DECISION_UPDATED,
        │                          calls the adapter.
        └── meet-ui.js             Minimal on-page status badge (not the full
                                   dashboard — just ACTIVE/MUTED + a manual override)
```

**The core engine (camera/vision/audio/vad/decision/utils) is imported unmodified.** No Meet-aware code was added to any of those files. A future Zoom/Teams/WhatsApp adapter reuses 100% of them — only a new `integrations/zoom/` folder with its own detector/adapter/controller/ui would be needed, following this same shape.

## 4. Event flow

```
meet-bootstrap.js
  └─ detects meeting joined ──► meet-controller.js
        ├─ creates hidden <video>/<canvas>, binds camera/ + vision/
        ├─ starts audio/ + vad/
        ├─ starts decision/ (unchanged — same DECISION_UPDATED event)
        └─ subscribes to DECISION_UPDATED
              └─ micStatus changed? ──► meet-adapter.js.syncMuteState(micStatus)
                                              └─ clicks Meet's real mute button
                                                 (only if Meet's current state
                                                  doesn't already match — avoids
                                                  fighting the user's own manual
                                                  clicks)
meet-ui.js shows a small floating badge reflecting the same DECISION_UPDATED stream
```

New events added to `utils/constants.js` (core engine still knows nothing about them — only the integration layer emits/consumes these):
- `MEETING_JOINED`, `MEETING_LEFT` — from `meet-detector.js`
- `ADAPTER_MUTE_SYNCED` — from `meet-adapter.js`, for the badge/logging

## 5. Manifest changes required

- `host_permissions: ["https://meet.google.com/*"]`
- `permissions: ["storage", "tabs"]` (added `tabs`)
- `content_scripts` entry matching `https://meet.google.com/*`, loading `meet-bootstrap.js`
- `web_accessible_resources` exposing the core engine's `.js` files and the vendored MediaPipe assets to the `meet.google.com` origin (needed because a content script's dynamic `import()`/`fetch()` of a `chrome-extension://` URL is otherwise blocked)

## 6. Known browser/WebRTC limitations (honest list)

- **Double camera/mic capture**, per §1 — unavoidable with Tier 1 or Tier 2.
- **DOM-selector fragility.** `meet-adapter.js` is isolated specifically so a Meet UI change only requires touching one file, but it *will* eventually need an update when Google changes their markup. No way around this without Tier 2's track-replacement approach, which has its own, different fragility (race conditions, reconnect handling).
- **`aria-label` values are localized.** The English-language selector fallback won't match Meet in other display languages. `data-is-muted` (an attribute, not a label) is language-independent and used as the primary selector for this reason.
- **Content scripts cannot access Meet's internal JS state or its `RTCPeerConnection` object directly** — everything must be inferred from the DOM.
- **No way to detect "who else is talking"** from the page — VoiceShield still can't do true multi-speaker separation; that limitation from the core engine carries over unchanged.
- **Extension updates require Meet tabs to be reloaded** to pick up new content-script code — same as any Chrome extension.
- **Manifest V3 forbids remotely-hosted code**, so exactly like the dashboard's MediaPipe setup, nothing here loads code from a CDN at runtime — everything ships inside the extension package.

## 7. Milestone plan

| Milestone | Scope | Status |
|---|---|---|
| **1** | Meet detection + lifecycle tracking, core engine running headless inside the Meet tab, Tier-1 mute-button sync, minimal on-page badge | **Building now** |
| 2 | Hardening: permission-denial/device-switch/reconnect handling, badge polish, per-tab settings sync from the dashboard's Settings panel | Next, after Milestone 1 is validated live |
| 3 | Tier 2 — `getUserMedia` override + outgoing track replacement, so noise suppression reaches other participants | Future — needs Milestone 1/2 proven stable first |
| 4 | Zoom Web / Teams Web / WhatsApp Web adapters, reusing the same core engine + this same adapter shape | Future |

## 8. Testing checklist (manual, for Milestone 1)

- [ ] Join a Meet call → badge appears, camera/mic permission prompts appear (separate from Meet's own)
- [ ] Talk normally, facing camera → badge shows ACTIVE, Meet's own mute icon actually unmutes
- [ ] Stay silent → badge shows MUTED, Meet's own mic icon actually mutes
- [ ] Manually click Meet's mute button yourself mid-call → VoiceShield should not immediately fight your manual override on the very next tick (see §9)
- [ ] Leave the call → engine stops, badge disappears, no lingering camera/mic indicator
- [ ] Deny camera or mic permission → graceful message, doesn't break the Meet call itself
- [ ] Multiple Meet tabs open at once → each gets its own independent instance
- [ ] Refresh the Meet tab mid-call → re-initializes cleanly

## 9. Manual-override behavior (decided)

A manual click on Meet's mute button pauses auto-sync until VoiceShield's
own decision changes (i.e. until you're detected speaking again). This
implements design option (a): the manual override is respected, and the
engine never fights a user who deliberately took control. The badge keeps
showing what VoiceShield *wants* the state to be, so the divergence is
visible.
