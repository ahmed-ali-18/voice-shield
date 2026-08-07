/**
 * meet-bootstrap.js — the actual content-script entry point declared in
 * manifest.json. This file is intentionally NOT an ES module itself
 * (content_scripts entries load as classic scripts), so it uses dynamic
 * import() to pull in the real ES-module code. Those imported files' own
 * relative imports (e.g. "../../utils/event-bus.js") resolve fine on their
 * own since ES module resolution is based on the importing file's URL, not
 * this bootstrap file's.
 *
 * Every dynamically-imported path here — and everything those files import
 * in turn — must be listed in manifest.json's web_accessible_resources for
 * the meet.google.com origin, or the fetch will be blocked.
 */
(async () => {
  try {
    const [{ startMeetDetector }, { initMeetController }] = await Promise.all([
      import(chrome.runtime.getURL("src/integrations/google-meet/meet-detector.js")),
      import(chrome.runtime.getURL("src/integrations/google-meet/meet-controller.js")),
    ]);

    initMeetController();
    startMeetDetector();

    console.log("%c[VoiceShield] Meet integration loaded.", "color:#7dd3fc;font-weight:600");
  } catch (error) {
    console.error("[VoiceShield] Failed to load Meet integration:", error);
  }
})();
