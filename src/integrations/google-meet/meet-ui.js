import { MIC_STATUS } from "../../utils/constants.js";

/**
 * meet-ui.js — a small floating badge injected into the Meet page itself,
 * so you have some visible confirmation of VoiceShield's state without
 * needing the separate dashboard tab open. Deliberately minimal: status
 * text + a colored dot, not a re-implementation of the dashboard's cards.
 */

const BADGE_ID = "voiceshield-meet-badge";

function ensureBadge() {
  let badge = document.getElementById(BADGE_ID);
  if (badge) return badge;

  badge = document.createElement("div");
  badge.id = BADGE_ID;
  Object.assign(badge.style, {
    position: "fixed",
    bottom: "24px",
    left: "24px",
    zIndex: "2147483647", // stay above Meet's own UI
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 14px",
    borderRadius: "999px",
    background: "rgba(10, 13, 18, 0.92)",
    border: "1px solid rgba(255,255,255,0.12)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12px",
    color: "#e7ecf2",
    letterSpacing: "0.02em",
    pointerEvents: "none",
  });

  const dot = document.createElement("span");
  dot.id = `${BADGE_ID}-dot`;
  Object.assign(dot.style, {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#fb7185",
    flexShrink: "0",
  });

  const label = document.createElement("span");
  label.id = `${BADGE_ID}-label`;
  label.textContent = "VoiceShield · starting…";

  badge.append(dot, label);
  document.body.appendChild(badge);
  return badge;
}

export function showBadge() {
  ensureBadge();
}

export function hideBadge() {
  const badge = document.getElementById(BADGE_ID);
  if (badge) badge.remove();
}

export function updateBadge({ micStatus, error } = {}) {
  const badge = document.getElementById(BADGE_ID);
  if (!badge) return;

  const dot = document.getElementById(`${BADGE_ID}-dot`);
  const label = document.getElementById(`${BADGE_ID}-label`);

  if (error) {
    dot.style.background = "#fbbf24";
    label.textContent = `VoiceShield · ${error}`;
    return;
  }

  const isActive = micStatus === MIC_STATUS.ACTIVE;
  dot.style.background = isActive ? "#34d399" : "#fb7185";
  label.textContent = `VoiceShield · ${micStatus ?? "MUTED"}`;
}
