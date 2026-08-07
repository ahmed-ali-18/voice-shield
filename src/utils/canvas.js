/**
 * utils/canvas.js — shared DPI-aware canvas sizing helper. Used by both the
 * vision overlay canvas and the audio waveform canvas so this logic only
 * exists in one place.
 */
export function resizeCanvasToElement(canvas, referenceElement) {
  const rect = referenceElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.round(rect.width * dpr));
  const targetHeight = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  return { width: canvas.width, height: canvas.height };
}
