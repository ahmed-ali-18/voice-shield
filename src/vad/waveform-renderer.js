/**
 * vad/waveform-renderer.js — draws the live microphone waveform onto the
 * audio card's canvas. Pure rendering: takes a canvas context and data in,
 * holds no state of its own, mirrors vision/landmark-renderer.js's shape.
 */
export function drawWaveform(ctx, timeDomainData, { voiceActive = false } = {}) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  // Center reference line first so the waveform draws on top of it.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  ctx.lineWidth = Math.max(1.5, width / 400);
  ctx.strokeStyle = voiceActive ? "rgba(52, 211, 153, 0.9)" : "rgba(94, 234, 212, 0.55)";

  ctx.beginPath();
  const sliceWidth = width / timeDomainData.length;
  let x = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const v = timeDomainData[i] / 128.0; // 0..2, 1.0 == silence
    const y = (v * height) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.stroke();
}
