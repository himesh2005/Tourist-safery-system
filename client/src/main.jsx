import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";
import "leaflet/dist/leaflet.css";

const PERIODIC_ALERT_MS = 15 * 60 * 1000;

async function registerServiceWorkerAndNotifications() {
  if (typeof window === "undefined") return;

  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });

      const readyRegistration = await navigator.serviceWorker.ready;

      if (readyRegistration?.active) {
        readyRegistration.active.postMessage({
          type: "START_PERIODIC_DANGER_ALERTS",
        });
      }

      if ("periodicSync" in registration) {
        try {
          await registration.periodicSync.register("danger-zone-15m-alert", {
            minInterval: PERIODIC_ALERT_MS,
          });
        } catch {
          // Periodic Background Sync is not available/allowed in all browsers.
        }
      }

      if ("sync" in registration) {
        registration.sync.register("danger-zone-sync-alert").catch(() => {});
      }
    } catch {
      // Service worker registration failure should never block app startup.
    }
  }

  if ("Notification" in window && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // Ignore permission prompt errors.
    }
  }
}

registerServiceWorkerAndNotifications();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
