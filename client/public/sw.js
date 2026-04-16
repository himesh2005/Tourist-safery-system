/* tourist-safety/client/public/sw.js */

const APP_URL = "/";
const DANGER_NOTIFICATION_TITLE = "Tourist Safety Alert";
const DANGER_NOTIFICATION_BODY =
  "You are currently in a Danger Zone. Stay alert. If anything happens, use the emergency alert to notify nearby services.";

const DANGER_NOTIFICATION_TAG = "danger-zone-persistent-alert";
const PERIODIC_ALERT_MS = 15 * 60 * 1000; // 15 minutes

let periodicTimerId = null;

function canNotify() {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

async function showDangerNotification(source = "system") {
  if (!canNotify()) return;

  await self.registration.showNotification(DANGER_NOTIFICATION_TITLE, {
    body: DANGER_NOTIFICATION_BODY,
    tag: DANGER_NOTIFICATION_TAG,
    icon: "/vite.svg",
    badge: "/vite.svg",
    requireInteraction: true,
    renotify: true,
    silent: false,
    data: {
      source,
      timestamp: Date.now(),
      url: APP_URL,
    },
  });
}

function startPeriodicDangerAlerts() {
  // Best-effort periodic notification while SW is alive.
  if (periodicTimerId) return;
  periodicTimerId = setInterval(() => {
    showDangerNotification("interval").catch(() => {});
  }, PERIODIC_ALERT_MS);
}

function stopPeriodicDangerAlerts() {
  if (!periodicTimerId) return;
  clearInterval(periodicTimerId);
  periodicTimerId = null;
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      startPeriodicDangerAlerts();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const payload = event.data || {};

  if (payload.type === "TEST_ALERT_NOTIFICATION") {
    event.waitUntil(showDangerNotification("manual-test"));
    return;
  }

  if (payload.type === "START_PERIODIC_DANGER_ALERTS") {
    startPeriodicDangerAlerts();
    return;
  }

  if (payload.type === "STOP_PERIODIC_DANGER_ALERTS") {
    stopPeriodicDangerAlerts();
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = {
          body: event.data ? event.data.text() : "",
        };
      }

      const title = payload.title || DANGER_NOTIFICATION_TITLE;
      const body = payload.body || DANGER_NOTIFICATION_BODY;
      const tag = payload.tag || DANGER_NOTIFICATION_TAG;

      if (!canNotify()) return;

      await self.registration.showNotification(title, {
        body,
        tag,
        icon: "/vite.svg",
        badge: "/vite.svg",
        requireInteraction: true,
        renotify: true,
        data: {
          source: "push",
          timestamp: Date.now(),
          url: payload.url || APP_URL,
        },
      });
    })(),
  );
});

self.addEventListener("sync", (event) => {
  // Optional background sync fallback.
  if (event.tag === "danger-zone-sync-alert") {
    event.waitUntil(showDangerNotification("sync"));
  }
});

self.addEventListener("periodicsync", (event) => {
  // Fires if Periodic Background Sync is supported and registered from the page.
  if (event.tag === "danger-zone-15m-alert") {
    event.waitUntil(showDangerNotification("periodicsync"));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of allClients) {
        const url = new URL(client.url);
        if (url.pathname === APP_URL || url.pathname === "/index.html") {
          await client.focus();
          return;
        }
      }

      await self.clients.openWindow(APP_URL);
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // Keep service worker alive and avoid unhandled lifecycle changes in demos.
  event.waitUntil(Promise.resolve());
});
