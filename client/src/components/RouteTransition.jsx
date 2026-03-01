import { AnimatePresence, motion } from "framer-motion";

export default function RouteTransition({ children, routeKey }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={routeKey}
        className="page-wrap"
        initial={{ opacity: 0, scale: 0.95, y: 8, filter: "blur(6px)" }}
        animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, scale: 0.95, y: -6, filter: "blur(6px)" }}
        transition={{ duration: 0.35, ease: "easeInOut" }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
