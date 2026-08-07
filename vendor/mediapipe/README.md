# vendor/mediapipe/ — required, one-time setup

VoiceShield's vision module uses Google's `@mediapipe/tasks-vision` package
and the Face Landmarker model. **This folder must be populated by you before
Module 3 will work.**

## Why this can't be pre-bundled or loaded from a CDN

Manifest V3 extensions are not allowed to execute JavaScript fetched from a
remote server at runtime ("remotely hosted code" is blocked by Chrome Web
Store policy and enforced by the browser). So the MediaPipe **library code**
has to physically live inside the extension folder — it can't be
`import()`-ed from a CDN like a regular web page would do.

This sandbox this project was built in has no internet access, so these
files could not be downloaded and included automatically. It's a five-minute,
one-time step on your machine.

## What you need to add

```
vendor/mediapipe/
├── vision_bundle.mjs         ← the library itself
├── wasm/                     ← the WASM runtime the library loads
│   ├── vision_wasm_internal.js
│   ├── vision_wasm_internal.wasm
│   └── ...other files npm installs here
└── models/
    └── face_landmarker.task  ← the trained model (~3.7 MB)
```

## Steps

**1. Install the package (needs Node.js + internet access):**

```bash
mkdir -p /tmp/mp-fetch && cd /tmp/mp-fetch
npm init -y
npm install @mediapipe/tasks-vision
```

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

**3. Download the Face Landmarker model** (this is a data file, not code —
downloading it at runtime instead of vendoring it is also fine, see note
below):

```bash
curl -L -o <path-to-voiceshield>/vendor/mediapipe/models/face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
```

**4. Reload the unpacked extension** in `chrome://extensions`.

## Note on the model file and "on-device" processing

The `.task` model file is a trained-weights binary, not executable script,
so Chrome's remote-code policy doesn't apply to it — `vision-controller.js`
currently points at the local copy in step 3, but you could instead point
`modelAssetPath` directly at the `storage.googleapis.com` URL above and let
the browser fetch it on first run (MediaPipe caches it after that). Either
way, only the model *weights* are downloaded once — no webcam video or audio
is ever uploaded anywhere. Vendoring it locally (as configured) is the more
airtight option if you want a fully offline story.

## Verifying it worked

Once populated, `chrome-extension://<your-id>/vendor/mediapipe/vision_bundle.mjs`
should load without a 404 in the dashboard tab's DevTools console (Cmd/Ctrl+Shift+J).
If you see "Failed to load the MediaPipe Face Landmarker model" in the
VoiceShield event log, double-check the three paths above.
