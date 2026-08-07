import { createLogger } from "../utils/logger.js";

const log = createLogger("vision/loader");

/**
 * vision/face-landmarker-loader.js — owns loading the MediaPipe Face
 * Landmarker model + WASM runtime exactly once per session. Vendored
 * locally under vendor/mediapipe/ (see README there) because Manifest V3
 * disallows executing remotely-fetched JavaScript inside an extension.
 */

let faceLandmarkerPromise = null;

/**
 * Pre-loads the WASM glue in the CURRENT world so it sets
 * self.ModuleFactory where the bundle looks for it.
 *
 * Why this is needed in Meet: the bundle loads the glue by appending a
 * <script> element. Inside a content script's isolated world, a
 * DOM-injected script executes in the page's MAIN world, so ModuleFactory
 * lands on the page's global while the isolated world's self.ModuleFactory
 * stays unset — createFromOptions then throws "ModuleFactory not set."
 *
 * Fix (no eval — the manifest CSP forbids it): import the ESM variant of
 * the glue (vision_wasm_module_internal.js), which assigns
 * globalThis.ModuleFactory in OUR world. Then delete wasmLoaderPath so the
 * bundle skips its own script-tag load, and point wasmBinaryPath at the
 * matching module wasm so the factory fetches the paired binary.
 */
async function preloadWasmGlue(filesetResolver) {
  const moduleUrl = filesetResolver.wasmLoaderPath.replace(
    "_internal.js",
    "_module_internal.js"
  );
  try {
    const glueModule = await import(/* webpackIgnore: true */ moduleUrl);
    if (globalThis.ModuleFactory || glueModule?.default) {
      globalThis.ModuleFactory = globalThis.ModuleFactory ?? glueModule.default;
      filesetResolver.wasmBinaryPath = filesetResolver.wasmBinaryPath.replace(
        "_internal.wasm",
        "_module_internal.wasm"
      );
      delete filesetResolver.wasmLoaderPath;
      quietMediaPipeLogs();
      log.info("WASM glue pre-loaded via module import.");
      return;
    }
    log.warn("Glue module loaded but exported no ModuleFactory - using bundle default.");
  } catch (error) {
    log.warn("Glue module pre-load failed - using bundle default.", error);
  }
}

/**
 * MediaPipe's C++ logging is routed to console.warn via
 * globalThis.custom_dbg (set by the module glue). Graph init routinely
 * prints INFO/WARNING lines ("Sets FaceBlendshapesGraph acceleration to
 * xnnpack by default.") that look like errors — filter those prefixes out
 * so the console only shows genuine E-level errors and JS exceptions.
 */
function quietMediaPipeLogs() {
  if (typeof globalThis.custom_dbg !== "function") return;
  const original = globalThis.custom_dbg;
  globalThis.custom_dbg = (...args) => {
    const msg = String(args[0] ?? "");
    if (/^(I\d{4}|W\d{4}|INFO:|WARNING:)/.test(msg)) return;
    original(...args);
  };
}

async function createWithDelegate(FaceLandmarker, filesetResolver, delegate) {  const options = {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL("vendor/mediapipe/models/face_landmarker.task"),
      delegate,
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  };

  try {
    return await FaceLandmarker.createFromOptions(filesetResolver, options);
  } catch (error) {
    if (delegate === "GPU") {
      // Some isolated-world/headless contexts reject WebGL - retry on CPU
      // before giving up.
      log.warn("GPU delegate failed - retrying with CPU.", error);
      return createWithDelegate(FaceLandmarker, filesetResolver, "CPU");
    }
    throw error;
  }
}

async function loadFaceLandmarker() {
  const { FaceLandmarker, FilesetResolver } = await import(
    /* webpackIgnore: true */ chrome.runtime.getURL("vendor/mediapipe/vision_bundle.mjs")
  );

  const filesetResolver = await FilesetResolver.forVisionTasks(
    chrome.runtime.getURL("vendor/mediapipe/wasm")
  );

  await preloadWasmGlue(filesetResolver);

  const faceLandmarker = await createWithDelegate(FaceLandmarker, filesetResolver, "GPU");

  log.info("Face Landmarker model ready.");
  return faceLandmarker;
}

/** Memoized — the multi-MB model should only ever load once per session. */
export function getFaceLandmarker() {
  if (!faceLandmarkerPromise) {
    faceLandmarkerPromise = loadFaceLandmarker().catch((error) => {
      faceLandmarkerPromise = null; // allow a retry on the next call
      throw error;
    });
  }
  return faceLandmarkerPromise;
}
