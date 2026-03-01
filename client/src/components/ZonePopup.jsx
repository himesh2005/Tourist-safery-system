import { motion } from "framer-motion";

const COPY = {
  restricted: {
    title: "\u{1F6AB} Restricted Area",
    points: [
      "Officially restricted for safety reasons",
      "Unauthorized entry may be unsafe",
      "Follow administrative guidelines",
    ],
  },
  high_crime: {
    title: "\u26A0 High Crime Area",
    points: [
      "Higher incident activity reported in this area",
      "Avoid isolated movement and dark shortcuts",
      "Keep emergency contacts reachable",
    ],
  },
  time_based: {
    title: "\u{1F319} Night Risk Zone",
    points: [
      "Risk increases during configured late-night hours",
      "Prefer well-lit public routes",
      "Exit the zone before risk window if possible",
    ],
  },
};

function capitalize(value) {
  return String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1);
}

export default function ZonePopup({ zone, onClose }) {
  if (!zone) return null;

  const content = COPY[zone.type] || COPY.restricted;
  const safeHours =
    zone.type === "time_based" && zone.activeHours
      ? `${zone.activeHours.start}:00 - ${zone.activeHours.end}:00`
      : "Monitored continuously";

  return (
    <motion.div
      className={`zone-popup-card zone-popup-${zone.type}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div className="zone-popup-head">
        <h4>{content.title}</h4>
        <button className="zone-close" onClick={onClose} type="button" aria-label="Close zone details">
          X
        </button>
      </div>

      <div className="zone-badge">Risk Level: {capitalize(zone.riskLevel)}</div>
      <ul>
        {content.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {zone.type === "time_based" ? <p className="zone-safe-hours">Safe Hours: {safeHours}</p> : null}
      <p className="zone-emergency">Emergency Suggestion: Remain in well-lit public areas.</p>
    </motion.div>
  );
}
