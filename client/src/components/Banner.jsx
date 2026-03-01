import { motion } from "framer-motion";

const LABELS = {
  safe: "All Clear - You are in a safe area.",
  restricted: "Restricted Zone - Leave Immediately.",
  high_crime: "High Crime Area - Stay Alert.",
  time_based: "Night Risk Active - Avoid Staying.",
};

const ICONS = {
  safe: "\u{1F7E2}",
  restricted: "\u{1F534}",
  high_crime: "\u{1F7E0}",
  time_based: "\u{1F7E3}",
};

const DEMO_BULLETS = [
  "Area flagged for safety concerns",
  "Avoid isolated movement",
  "Stay in well-lit zones",
  "Contact emergency if needed",
];

function getDemoZoneText(type, zoneName) {
  if (type === "time_based") return `You are inside a Night Risk Zone${zoneName ? `: ${zoneName}` : "."}`;
  if (type === "high_crime") return `You are inside a High Crime Zone${zoneName ? `: ${zoneName}` : "."}`;
  if (type === "restricted") return `You are inside a Restricted Zone${zoneName ? `: ${zoneName}` : "."}`;
  return "You are in a safe area.";
}

export default function Banner({ statusType = "safe", details = "", onDismiss, demoMode = false, zoneName = "" }) {
  const type = LABELS[statusType] ? statusType : "safe";

  return (
    <motion.div
      className={`zone-status-banner status-${type}`}
      initial={{ y: -80, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -80, opacity: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
    >
      <div className="banner-left">
        <span>{ICONS[type]}</span>
        <strong>{demoMode && type !== "safe" ? "\u{1F6A8} HIGH RISK AREA DETECTED" : LABELS[type]}</strong>
      </div>
      <div className="banner-right">
        <small>{details || `Time: ${new Date().toLocaleTimeString()}`}</small>
        {typeof onDismiss === "function" ? (
          <button className="banner-dismiss" onClick={onDismiss} aria-label="Dismiss banner" type="button">
            X
          </button>
        ) : null}
      </div>

      {demoMode && type !== "safe" ? (
        <div className="banner-demo-body">
          <small>Time: 3:00 AM (Simulated)</small>
          <small>{getDemoZoneText(type, zoneName)}</small>
          <small>Immediate exit recommended.</small>
          <ul className="banner-list">
            {DEMO_BULLETS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </motion.div>
  );
}
