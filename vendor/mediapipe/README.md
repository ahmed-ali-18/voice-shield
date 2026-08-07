# vendor/mediapipe/ — required, one-time setup

VoiceShield's vision module uses Google's `@mediapipe/tasks-vision` package
and the Face Landmarker model. **This folder must be populated by you before
the vision module will work.**

## Why this can't be pre-bundled or loaded from a CDN

Manifest V3 extensions are not allowed to execute JavaScript fetched from a
remote server at runtime ("remotely hosted code" is blocked by Chrome Web
Store policy and enforced by the browser). So the MediaPipe **library code**
has to physically live inside the extension folder — it can't be
`import()`-ed from a CDN like a regular web page would do.

## What you need to add

```
vendor/mediapipe/
├── vision_bundle.mjs         ← the library itself
├── wasm/                     ← the WASM runtime the library loads
│   ├── vision_wasm_internal.js / .wasm            ← classic loader glue
│   ├── vision_wasm_module_internal.js / .wasm     ← ESM glue (required — see below)
│   └── ...other files npm installs here
└── models/
    └── face_landmarker.task  ← the trained model (~3.7 MB)
```

## Steps

**1. Install the package (needs Node.js + internet access):**

```bash
mkdir -p /tmp/mp-fetch && cd /tmp/mp-fetch
npm init -y
npm install @mediapipe/tasks-vision@0.10.22
```

> **Version pin — do not upgrade casually.** `face-landmarker-loader.js` depends
> on internal file naming inside the package (`*_internal.js` /
> `*_module_internal.js` glue files). The latest published version is 1.0.1
> (checked 2026-08-07) and the loader has NOT been tested against it. If you
> upgrade, re-test model loading in BOTH the dashboard tab and inside a Google
> Meet call before committing.

**2. Copy the library + WASM runtime into this folder:**

```bash
cp node_modules/@mediapipe/tasks-vision/vision_bundle.mjs \
   <path-to-voiceshield>/vendor/mediapipe/vision_bundle.mjs

cp node_modules/@mediapipe/tasks-vision/wasm/* \
   <path-to-voiceshield>/vendor/mediapipe/wasm/
```

(If your installed version ships the wasm files under a different
subfolder name, copy whatever `.wasm` / `.js` glue files are there — the
loader just needs the whole `wasm/` directory contents.)

**3. Download the Face Landmarker model** (a data file, not code — see the
privacy note below):

```bash
curl -L -o <path-to-voiceshield>/vendor/mediapipe/models/face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
```

**4. Reload the unpacked extension** in `chrome://extensions`.

## Why BOTH wasm variants must stay

The `wasm/` folder ships two glue variants that look redundant but aren't:

- `vision_wasm_internal.js` + `vision_wasm_internal.wasm` — the classic
  script-tag loader glue the bundle uses by default.
- `vision_wasm_module_internal.js` + `vision_wasm_module_internal.wasm` — the
  ESM variant, imported directly by `face-landmarker-loader.js`'s content-script
  workaround.

The bundle normally loads its glue by appending a `<script>` element. Inside a
Meet content script's isolated world, a DOM-injected script executes in the
page's MAIN world — so `ModuleFactory` would land on the page's global, and
`createFromOptions` would throw "ModuleFactory not set" in the isolated world.
The loader therefore imports the `_module_internal.js` ESM glue directly (which
assigns `globalThis.ModuleFactory` in the isolated world) and points the
resolver at the matching `_module_internal.wasm`. **Do not delete either
variant** — the module-glue preload and the bundle's default path both depend
on these file names.

## After an upgrade, verify

If you ever do upgrade `@mediapipe/tasks-vision`, this is the minimum
checklist before committing the new files:

1. **Dashboard loads the model** — open the dashboard tab; the Facial Metrics
   card should track your face live, with no "Failed to load the MediaPipe Face
   Landmarker model" error in the event log.
2. **Meet badge appears in a call** — join a `meet.google.com` call; the
   VoiceShield badge should appear bottom-left and track ACTIVE/MUTED.
3. **No "missing createFromOptions" error** — the loader checks the vendored
   bundle for `FaceLandmarker.createFromOptions` before using it and throws
   exactly this error when the pinned version contract is broken (a renamed or
   removed export in a new release). If you see it, the bundle doesn't match
   the pinned version — re-run this setup with `@0.10.22`.

## Note on the model file and "on-device" processing

The `.task` model file is a trained-weights binary, not executable script,
so Chrome's remote-code policy doesn't apply to it — `face-landmarker-loader.js`
points `modelAssetPath` at the local copy from step 3, but you could instead
point it at the `storage.googleapis.com` URL above and let the browser fetch
it on first run (MediaPipe caches it after that). Either way, only the model
*weights* are downloaded once — no webcam video or audio is ever uploaded
anywhere. Vendoring it locally (as configured) is the more airtight option if
you want a fully offline story.

## Verifying it worked

Once populated, `chrome-extension://<your-id>/vendor/mediapipe/vision_bundle.mjs`
should load without a 404 in the dashboard tab's DevTools console (Cmd/Ctrl+Shift+J).
If you see "Failed to load the MediaPipe Face Landmarker model" in the
VoiceShield event log, double-check the three paths above.
