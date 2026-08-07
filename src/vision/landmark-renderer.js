/**
 * vision/landmark-renderer.js — draws the face mesh dots and lip outline
 * onto the overlay canvas. Pure rendering: takes a canvas context and data
 * in, has no state of its own, and knows nothing about MediaPipe or events.
 */

// Inner+outer lip ring indices (MediaPipe FaceMesh 478-point topology),
// ordered to trace a closed loop around the mouth.
const LIPS_OUTLINE = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 308, 324, 318, 402, 317,
  14, 87, 178, 88, 95, 185, 40, 39, 37, 0, 267, 269, 270, 409, 415, 310, 311,
  312, 13, 82, 81, 42, 183, 78,
];

export function drawFaceOverlay(ctx, landmarks, { isNaturalSpeechPattern = false } = {}) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!landmarks) return;

  ctx.save();
  // Mirror to match the mirrored <video> preview (CSS: scaleX(-1)).
  ctx.translate(width, 0);
  ctx.scale(-1, 1);

  ctx.fillStyle = "rgba(94, 234, 212, 0.5)";
  for (const point of landmarks) {
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Green only once the multi-frame speech-pattern detector confirms
  // natural talking — a static open mouth or single noisy frame stays violet.
  ctx.strokeStyle = isNaturalSpeechPattern ? "rgba(52, 211, 153, 0.9)" : "rgba(167, 139, 250, 0.85)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  LIPS_OUTLINE.forEach((index, i) => {
    const point = landmarks[index];
    const x = point.x * width;
    const y = point.y * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}
