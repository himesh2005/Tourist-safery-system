import { useState } from "react";
import { FiChevronDown } from "react-icons/fi";
import { motion, AnimatePresence } from "framer-motion";

export default function AreaIntelligencePanel() {
  const [open, setOpen] = useState(true);

  return (
    <section className="glass-card panel">
      <div className="panel-head">
        <h3 className="panel-title">Area Intelligence Guide</h3>
        <button
          className="pill-btn panel-toggle"
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse area intelligence" : "Expand area intelligence"}
        >
          <FiChevronDown style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="risk-items"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="risk-item">
              <h4>Restricted Zones (Always Avoid)</h4>
              <p>Operational or structural hazard zones. Enter only if authorized.</p>
            </div>
            <div className="risk-item">
              <h4>High Crime Zones (Stay Alert)</h4>
              <p>Higher incident density. Avoid isolated routes and keep contacts ready.</p>
            </div>
            <div className="risk-item">
              <h4>Night Risk Zones (Avoid 2 AM - 6 AM)</h4>
              <p>Risk elevates in configured night windows. Exit early when possible.</p>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
