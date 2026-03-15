import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import L from "leaflet";
import { API_URL } from "../config/env.js";

const BASE_API_URL = String(API_URL || "http://localhost:5000").replace(
  /\/+$/,
  "",
);
const api = (path = "") =>
  `${BASE_API_URL}${String(path).startsWith("/") ? path : `/${path}`}`;
const SMS_API_PATH = "/api/send-sms";

const GADCHIROLI_CENTER = [20.1849, 80.003];
const NAGPUR_CENTER = [21.1458, 79.0882];
const DEMO_LOCATION = [21.1445, 79.091];
const ALERT_INTERVAL_MS = 5 * 60 * 1000;

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncateMiddle(value, start = 6, end = 4) {
  const input = String(value || "");
  if (!input || input.length <= start + end + 3) return input;
  return `${input.slice(0, start)}...${input.slice(-end)}`;
}

function toTitle(value) {
  const input = String(value || "")
    .replace(/[-_]/g, " ")
    .trim();
  if (!input) return "";
  return input.replace(/\b\w/g, (char) => char.toUpperCase());
}

function toRad(value) {
  return (Number(value) * Math.PI) / 180;
}

function haversineKm(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== 2 ||
    b.length !== 2
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const lat1 = Number(a[0]);
  const lng1 = Number(a[1]);
  const lat2 = Number(b[0]);
  const lng2 = Number(b[1]);

  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const calc =
    sinLat * sinLat +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * sinLng * sinLng;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(calc), Math.sqrt(1 - calc));
}

function squaredDistance(a, b) {
  const dLat = Number(a[0]) - Number(b[0]);
  const dLng = Number(a[1]) - Number(b[1]);
  return dLat * dLat + dLng * dLng;
}

function isPointInPolygon(point, polygon) {
  const y = point[0];
  const x = point[1];
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i][0];
    const xi = polygon[i][1];
    const yj = polygon[j][0];
    const xj = polygon[j][1];
    const intersects =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }

  return inside;
}

function getNearestEntries(userPosition, list, limit = 3) {
  if (!Array.isArray(list) || list.length === 0) return [];

  const enriched = list
    .map((item) => ({
      ...item,
      distanceKm: haversineKm(userPosition, [item.latitude, item.longitude]),
    }))
    .filter((item) => Number.isFinite(item.distanceKm))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  if (enriched.length === 0) return list.slice(0, limit);
  return enriched.slice(0, limit);
}

function normalizeZones(data) {
  if (!Array.isArray(data)) return [];

  return data
    .map((zone) => {
      if (!zone || typeof zone !== "object") return null;

      const sourceRisk = String(zone.riskLevel || "")
        .trim()
        .toLowerCase();
      const riskLevel =
        sourceRisk === "danger" || sourceRisk === "high"
          ? "danger"
          : sourceRisk === "moderate" || sourceRisk === "medium"
            ? "moderate"
            : sourceRisk === "safe" || sourceRisk === "low"
              ? "safe"
              : "moderate";

      const type =
        zone.type === "restricted" ||
        zone.type === "high_crime" ||
        zone.type === "time_based"
          ? zone.type
          : riskLevel === "danger"
            ? "restricted"
            : riskLevel === "moderate"
              ? "high_crime"
              : "time_based";

      const active =
        zone.active === "always" || zone.active === "time_based"
          ? zone.active
          : "always";

      return {
        ...zone,
        riskLevel,
        type,
        active,
        crimeIndex: Number(zone.crimeIndex ?? zone.riskScore ?? 0),
      };
    })
    .filter(
      (zone) =>
        zone &&
        zone.id &&
        zone.name &&
        Array.isArray(zone.coordinates) &&
        zone.coordinates.length >= 3 &&
        zone.coordinates.every(
          (pair) =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            Number.isFinite(Number(pair[0])) &&
            Number.isFinite(Number(pair[1])),
        ),
    );
}

function normalizeTouristSpots(data) {
  const spots = Array.isArray(data?.spots) ? data.spots : [];
  return spots.filter(
    (spot) =>
      spot &&
      Number.isFinite(Number(spot.lat)) &&
      Number.isFinite(Number(spot.lng)),
  );
}

function normalizeEmergencyServices(data) {
  const hospitals = Array.isArray(data?.hospitals) ? data.hospitals : [];
  const policeStations = Array.isArray(data?.policeStations)
    ? data.policeStations
    : Array.isArray(data?.police_stations)
      ? data.police_stations
      : [];

  const normalizeEntries = (list) =>
    list
      .filter(
        (item) =>
          item &&
          Number.isFinite(Number(item.lat ?? item.latitude)) &&
          Number.isFinite(Number(item.lng ?? item.longitude)),
      )
      .map((item) => ({
        ...item,
        latitude: Number(item.lat ?? item.latitude),
        longitude: Number(item.lng ?? item.longitude),
      }));

  return {
    hospitals: normalizeEntries(hospitals),
    police_stations: normalizeEntries(policeStations),
  };
}

function getZoneVisual(riskLevel) {
  if (riskLevel === "danger") {
    return { fill: "#C62828", stroke: "#8E0000", dot: "#C62828" };
  }
  if (riskLevel === "moderate") {
    return { fill: "#E65100", stroke: "#BF360C", dot: "#E65100" };
  }
  return { fill: "#2E7D32", stroke: "#1B5E20", dot: "#2E7D32" };
}

function buildEmergencyPopup(item, type) {
  const name = escapeHtml(item.name);
  const address = escapeHtml(item.address || "Address unavailable");
  const phone = escapeHtml(item.phone || "Contact unavailable");
  const availability =
    type === "hospital" && item.emergency === false
      ? '<div style="font-size:11px;color:#A61B1B;margin-bottom:10px">Emergency services unavailable</div>'
      : "";

  return `<div style="padding:14px 16px;min-width:190px;font-family:'DM Sans',sans-serif">
  <div style="font-size:13px;font-weight:600;color:#1a1a1a;margin-bottom:4px">${name}</div>
  <div style="font-size:12px;color:#666;margin-bottom:10px">${address}</div>
  ${availability}
  ${
    item.phone
      ? `<a href="tel:${escapeHtml(item.phone)}" style="display:flex;align-items:center;justify-content:center;gap:6px;background:#1976D2;color:white;padding:8px;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/></svg>
    Call Now
  </a>`
      : `<div style="display:flex;align-items:center;justify-content:center;background:#94A3B8;color:white;padding:8px;border-radius:8px;font-size:13px;font-weight:500">${phone}</div>`
  }
</div>`;
}

function buildTouristPopup(spot, warningInDanger) {
  const name = escapeHtml(spot.name);
  const type = escapeHtml(spot.type || "Tourist spot");
  const opens = escapeHtml(spot.opens || "N/A");
  const closes = escapeHtml(spot.closes || "N/A");
  const season = escapeHtml(spot.bestSeason || "Year round");
  const warning = warningInDanger
    ? "Located inside a danger zone"
    : spot.warning
      ? escapeHtml(spot.warning)
      : "";

  return `<div style="padding:14px 16px;min-width:200px;font-family:'DM Sans',sans-serif">
  <div style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:4px">${name}</div>
  <div style="font-size:12px;color:#555;margin-bottom:8px">${type}</div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
    <span style="background:#E3F2FD;color:#1565C0;padding:2px 8px;border-radius:99px;font-size:11px">🕐 ${opens}–${closes}</span>
    <span style="background:#E8F5E9;color:#2E7D32;padding:2px 8px;border-radius:99px;font-size:11px">📅 ${season}</span>
  </div>
  ${warning ? `<div style="background:#FFF3E0;border-left:3px solid #F57C00;padding:6px 8px;border-radius:4px;font-size:11px;color:#E65100">${warning}</div>` : ""}
</div>`;
}

function createMarkerIcon(type) {
  if (type === "police") {
    return L.divIcon({
      className: "",
      html: `<div style="position:relative;width:28px;height:36px">
    <svg viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22S28 23.333 28 14C28 6.268 21.732 0 14 0z" fill="#1565C0"/>
      <path d="M14 7l2.5 2.5v4L14 15.5 11.5 13.5v-4L14 7z" fill="white" stroke="white" stroke-width="0.5"/>
      <path d="M11 15.5h6v3.5a3 3 0 01-6 0v-3.5z" fill="white"/>
    </svg>
  </div>`,
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -38],
    });
  }

  if (type === "hospital") {
    return L.divIcon({
      className: "",
      html: `<div style="position:relative;width:28px;height:36px">
    <svg viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22S28 23.333 28 14C28 6.268 21.732 0 14 0z" fill="#C62828"/>
      <rect x="12" y="7" width="4" height="14" rx="1" fill="white"/>
      <rect x="7" y="12" width="14" height="4" rx="1" fill="white"/>
    </svg>
  </div>`,
      iconSize: [28, 36],
      iconAnchor: [14, 36],
      popupAnchor: [0, -38],
    });
  }

  return L.divIcon({
    className: "",
    html: `<div style="position:relative;width:28px;height:36px">
    <svg viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22S28 23.333 28 14C28 6.268 21.732 0 14 0z" fill="#00796B"/>
      <path d="M14 8l1.5 4.5H20l-3.8 2.8 1.5 4.5L14 17l-3.7 2.8 1.5-4.5L8 12.5h4.5L14 8z" fill="white"/>
    </svg>
  </div>`,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -38],
  });
}

function createUserIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="width:18px;height:18px;position:relative">
    <div style="position:absolute;inset:0;background:#1976D2;border-radius:50%;border:3px solid white;box-shadow:0 2px 8px rgba(25,118,210,0.5);z-index:2"></div>
    <div style="position:absolute;inset:-6px;background:rgba(25,118,210,0.2);border-radius:50%;animation:pulse 2s infinite"></div>
  </div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function AppLogoIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 2 4 6v6c0 5.2 3.4 9.9 8 11 4.6-1.1 8-5.8 8-11V6l-8-4Z"
        fill="#1A73E8"
      />
      <path
        d="M12 6.2 8.7 8v3.7c0 2.9 1.8 5.7 3.3 6.3 1.5-.6 3.3-3.4 3.3-6.3V8L12 6.2Z"
        fill="white"
      />
    </svg>
  );
}

function LocateIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 3v3m0 12v3m9-9h-3M6 12H3m13.364 6.364-2.121-2.121M8.757 8.757 6.636 6.636m9.728 0-2.121 2.121m-5.486 7.486-2.121 2.121"
        stroke="#1A1A1A"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3.5" fill="#1976D2" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" fill="#1A1A1A" />
      <path
        d="M12 10v6m0-9h.01"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SosIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 3 4 7v5c0 5.2 3.4 9.3 8 10 4.6-.7 8-4.8 8-10V7l-8-4Z"
        fill="white"
      />
      <path
        d="M9 10.2c0-.66.54-1.2 1.2-1.2h3.6c.66 0 1.2.54 1.2 1.2v.1c0 .44-.24.85-.64 1.06l-1.53.82 1.53.82c.4.21.64.62.64 1.06v.12c0 .66-.54 1.2-1.2 1.2h-3.6C9.54 15.4 9 14.86 9 14.2"
        stroke="#C62828"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function GeofenceMap({
  travelerName = "Traveler",
  blockchainId = "",
  userProfile = null,
}) {
  const [zones, setZones] = useState([]);
  const [cities, setCities] = useState([]);
  const [selectedCity, setSelectedCity] = useState("gadchiroli");
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [userPosition, setUserPosition] = useState(null);
  const [activeZone, setActiveZone] = useState(null);
  const [selectedZone, setSelectedZone] = useState(null);
  const [lastAlertTime, setLastAlertTime] = useState(null);
  const [currentHour, setCurrentHour] = useState(new Date().getHours());
  const [errorMessage, setErrorMessage] = useState("");
  const [dismissedZoneId, setDismissedZoneId] = useState("");
  const [touristSpots, setTouristSpots] = useState([]);
  const [emergencyInfo, setEmergencyInfo] = useState({
    hospitals: [],
    police_stations: [],
  });
  const [emergencyLoading, setEmergencyLoading] = useState(false);
  const [emergencyError, setEmergencyError] = useState("");
  const [showIntelPanel, setShowIntelPanel] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [isOnlineState, setIsOnlineState] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [connectivityBanner, setConnectivityBanner] = useState(null);
  const [actionBanner, setActionBanner] = useState(null);
  const [sosModalOpen, setSosModalOpen] = useState(false);
  const [sosSubmitting, setSosSubmitting] = useState(false);
  const [sosResult, setSosResult] = useState(null);
  const [cachedZone, setCachedZone] = useState(null);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const userMarkerRef = useRef(null);
  const zoneLayerGroupRef = useRef(null);
  const touristLayerGroupRef = useRef(null);
  const emergencyLayerGroupRef = useRef(null);
  const watcherIdRef = useRef(null);
  const activeZoneRef = useRef(null);
  const lastAlertTimeRef = useRef(null);
  const userPickedCityRef = useRef(false);
  const sheetDragStartRef = useRef(null);
  const sheetRef = useRef(null);
  const sheetHandleRef = useRef(null);
  const wasOfflineRef = useRef(false);
  const locationDisabledTimerRef = useRef(null);
  const lastSavedLocationAtRef = useRef(0);
  const bannerTimeoutRef = useRef(null);

  const nearestHospitals = useMemo(
    () => getNearestEntries(userPosition, emergencyInfo.hospitals, 3),
    [emergencyInfo.hospitals, userPosition],
  );
  const nearestPoliceStations = useMemo(
    () => getNearestEntries(userPosition, emergencyInfo.police_stations, 3),
    [emergencyInfo.police_stations, userPosition],
  );
  const nearbyServices = [...nearestHospitals, ...nearestPoliceStations];
  const effectiveUserProfile = {
    id: userProfile?.blockchainId || blockchainId || "",
    blockchainId: userProfile?.blockchainId || blockchainId || "",
    name:
      userProfile?.name ||
      travelerName ||
      JSON.parse(localStorage.getItem("userProfile") || "{}")?.name ||
      "Traveler",
    phone:
      userProfile?.mobile ||
      JSON.parse(localStorage.getItem("userProfile") || "{}")?.phone ||
      "",
    emergencyContact:
      userProfile?.emergencyContacts ||
      JSON.parse(localStorage.getItem("userProfile") || "{}")
        ?.emergencyContact ||
      "",
  };

  function getCurrentHour() {
    return isDemoMode ? 3 : currentHour;
  }

  function getAuthToken() {
    return localStorage.getItem("token") || "";
  }

  function showActionBanner(message, tone = "info", duration = 4000) {
    setActionBanner({ message, tone });
    if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
    bannerTimeoutRef.current = setTimeout(() => {
      setActionBanner(null);
    }, duration);
  }

  function showSOSResult(type, message) {
    setSosResult({ type, message });
  }

  function storeLastKnownZone(zonePayload) {
    localStorage.setItem(
      "lastKnownZone",
      JSON.stringify({
        zoneName: zonePayload?.zoneName || zonePayload?.name || "",
        riskLevel: zonePayload?.riskLevel || "safe",
        lat: zonePayload?.lat ?? null,
        lng: zonePayload?.lng ?? null,
        timestamp: zonePayload?.timestamp || Date.now(),
      }),
    );
  }

  async function saveLastLocation(lat, lng, zoneDetails) {
    const data = {
      lat,
      lng,
      timestamp: Date.now(),
      zoneName: zoneDetails?.name || zoneDetails?.zoneName || "",
      riskLevel: zoneDetails?.riskLevel || "safe",
    };
    localStorage.setItem("lastKnownLocation", JSON.stringify(data));

    if (!navigator.onLine) return;
    try {
      await fetch(api("/api/user/last-location"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: JSON.stringify(data),
      });
    } catch {}
  }

  function clearLocationDisabledTimer() {
    if (locationDisabledTimerRef.current) {
      clearTimeout(locationDisabledTimerRef.current);
      locationDisabledTimerRef.current = null;
    }
  }

  async function sendLastLocationAlert() {
    const lastLoc = JSON.parse(
      localStorage.getItem("lastKnownLocation") || "{}",
    );
    const storedUser = JSON.parse(localStorage.getItem("userProfile") || "{}");
    if (!lastLoc?.lat) return;

    const timeAgo = Math.round(
      (Date.now() - Number(lastLoc.timestamp || Date.now())) / 60000,
    );
    const alertMessage =
      `⚠️ TOURIST LOCATION ALERT\n` +
      `${storedUser.name || effectiveUserProfile.name || "Tourist"} has disabled their location.\n` +
      `Last known location (${timeAgo} min ago):\n` +
      `📍 ${lastLoc.lat}, ${lastLoc.lng}\n` +
      `Zone: ${lastLoc.zoneName || "Unknown"} (${lastLoc.riskLevel || "unknown"} risk)\n` +
      `Google Maps: https://maps.google.com/?q=${lastLoc.lat},${lastLoc.lng}\n` +
      `Tourist ID: ${storedUser.blockchainId || effectiveUserProfile.blockchainId}\n` +
      `Emergency Contact: ${storedUser.emergencyContact || effectiveUserProfile.emergencyContact}\n` +
      `Sent via Tourist Safety System`;

    try {
      if (!navigator.onLine) throw new Error("offline");
      const response = await fetch(SMS_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: alertMessage,
          number: "8432419551",
        }),
      });
      const result = await response.json();
      if (!response.ok || result?.success !== true) {
        throw new Error(result?.error || "SMS send failed");
      }
      showActionBanner(
        "Emergency contact notified with last known location",
        "success",
      );
    } catch {
      window.location.href = `sms:8432419551?body=${encodeURIComponent(alertMessage)}`;
      showActionBanner("Opening SMS app — please press Send", "info");
    }
  }

  function startLocationDisabledTimer() {
    if (locationDisabledTimerRef.current) return;
    const lastZone = JSON.parse(localStorage.getItem("lastKnownZone") || "{}");
    if (!lastZone || lastZone.riskLevel === "safe") return;

    locationDisabledTimerRef.current = setTimeout(
      () => {
        sendLastLocationAlert();
      },
      15 * 60 * 1000,
    );

    showActionBanner(
      `Location disabled in ${lastZone.zoneName || "non-safe zone"}. Emergency contact will be notified in 15 min if location stays off.`,
      "warning",
      9000,
    );
  }

  async function handleCameBackOnline() {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    navigator.geolocation.getCurrentPosition(async (position) => {
      const lat = Number(position?.coords?.latitude);
      const lng = Number(position?.coords?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      try {
        const response = await fetch(api("/api/geofence/check"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lng, city: selectedCity }),
        });
        if (!response.ok) throw new Error("geofence check failed");
        const zone = await response.json();

        storeLastKnownZone({
          zoneName: zone.zoneName,
          riskLevel: zone.riskLevel,
          lat,
          lng,
          timestamp: Date.now(),
        });

        const colors = {
          safe: "#2E7D32",
          moderate: "#E65100",
          danger: "#C62828",
        };
        const icons = { safe: "✅", moderate: "⚠️", danger: "🚨" };
        const toast = document.createElement("div");
        toast.className = "gm-back-online-toast";
        toast.style.background = colors[zone.riskLevel] || colors.safe;
        toast.innerHTML = `
          ${icons[zone.riskLevel] || icons.safe} Back online — You are in<br>
          <strong>${escapeHtml(zone.zoneName || "Unknown Zone")}</strong>
          (${String(zone.riskLevel || "safe").toUpperCase()} risk)
          ${zone.riskLevel !== "safe" ? "<br><small>⚡ Stay alert — emergency services are loaded</small>" : ""}
        `;
        document.body.appendChild(toast);

        const dismissTime = zone.riskLevel === "danger" ? 10000 : 6000;
        setTimeout(() => {
          toast.style.animation = "slideUp 0.3s ease forwards";
          setTimeout(() => toast.remove(), 300);
        }, dismissTime);

        if (zone.riskLevel === "danger") {
          setTimeout(() => {
            setSosModalOpen(true);
          }, 2000);
        }
      } catch {}
    });
  }

  async function sendSOSAlert(lat, lng, sosMessage) {
    if (!navigator.onLine) {
      window.location.href = `sms:8432419551?body=${encodeURIComponent(sosMessage)}`;
      showSOSResult(
        "sms",
        "Opening SMS app — press Send to alert emergency contact",
      );
      showActionBanner("Opening SMS app — please press Send", "info");
      return;
    }

    try {
      showSOSResult("loading", "Sending alert...");

      const response = await fetch(SMS_API_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: sosMessage,
          number: "8432419551",
        }),
        signal: AbortSignal.timeout(8000),
      });
      const result = await response.json();

      if (response.ok && result?.success === true) {
        showSOSResult(
          "success",
          "✅ Emergency alert sent successfully via SMS",
        );
        showActionBanner(
          "Emergency alert sent to nearest police station",
          "success",
        );
      } else {
        throw new Error(result?.error || "SMS send failed");
      }
    } catch {
      window.location.href = `sms:8432419551?body=${encodeURIComponent(sosMessage)}`;
      showSOSResult("sms", "📱 Opening SMS app — press Send to complete alert");
      showActionBanner("Opening SMS app — please press Send", "info");
    }
  }

  async function sendSosAlert() {
    if (!Array.isArray(userPosition) || userPosition.length !== 2) return;
    const [lat, lng] = userPosition;
    const zoneName = activeZone?.name || cachedZone?.zoneName || "Unknown Zone";
    const riskLevel = activeZone?.riskLevel || cachedZone?.riskLevel || "safe";
    const sosMessage =
      `🆘 TOURIST SAFETY ALERT\n` +
      `Name: ${effectiveUserProfile.name}\n` +
      `Tourist ID: ${effectiveUserProfile.blockchainId}\n` +
      `Phone: ${effectiveUserProfile.emergencyContact || effectiveUserProfile.phone || "N/A"}\n` +
      `Location: ${lat}, ${lng}\n` +
      `Zone: ${zoneName} (${riskLevel} risk)\n` +
      `Google Maps: https://maps.google.com/?q=${lat},${lng}\n` +
      `Time: ${new Date().toLocaleString("en-IN")}\n` +
      `Sent via Tourist Safety System`;

    setSosSubmitting(true);
    try {
      await sendSOSAlert(lat, lng, sosMessage);
    } finally {
      setSosSubmitting(false);
    }
  }

  useEffect(() => {
    const cached = JSON.parse(localStorage.getItem("lastKnownZone") || "null");
    if (cached) setCachedZone(cached);

    const onOffline = () => {
      wasOfflineRef.current = true;
      setIsOnlineState(false);
      setConnectivityBanner({
        state: "offline",
        message: "📵 No internet — SOS will use SMS app (works on 2G)",
      });
    };

    const onOnline = () => {
      setIsOnlineState(true);
      setConnectivityBanner({ state: "online", message: "✅ Back online" });
      setTimeout(() => setConnectivityBanner(null), 3000);
      if (wasOfflineRef.current) handleCameBackOnline();
      wasOfflineRef.current = false;
    };

    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [selectedCity]);

  useEffect(() => {
    if (!sosModalOpen) {
      setSosResult(null);
    }
  }, [sosModalOpen]);

  function isZoneActive(zone, hour = getCurrentHour()) {
    if (!zone || typeof zone !== "object") return false;
    if (zone.active === "always") return true;

    if (zone.active === "time_based" && zone.activeHours) {
      const start = Number(zone.activeHours.start);
      const end = Number(zone.activeHours.end);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
      if (start < end) return hour >= start && hour < end;
      return hour >= start || hour < end;
    }

    return false;
  }

  function evaluatePosition(lat, lng, hourNow) {
    let matchedZone = null;

    for (let i = 0; i < zones.length; i += 1) {
      const zone = zones[i];
      if (zone.riskLevel === "safe") continue;
      if (!isZoneActive(zone, hourNow)) continue;
      if (isPointInPolygon([lat, lng], zone.coordinates)) {
        matchedZone = zone;
        break;
      }
    }

    if (matchedZone) {
      const previousZoneId = activeZoneRef.current?.id || null;
      const now = Date.now();
      const canRepeatAlert =
        !lastAlertTimeRef.current ||
        now - lastAlertTimeRef.current > ALERT_INTERVAL_MS;

      setActiveZone(matchedZone);
      activeZoneRef.current = matchedZone;
      setCachedZone({
        zoneName: matchedZone.name,
        riskLevel: matchedZone.riskLevel,
        lat,
        lng,
        timestamp: now,
      });
      storeLastKnownZone({
        zoneName: matchedZone.name,
        riskLevel: matchedZone.riskLevel,
        lat,
        lng,
        timestamp: now,
      });

      if (previousZoneId !== matchedZone.id || canRepeatAlert) {
        setLastAlertTime(now);
        lastAlertTimeRef.current = now;
      }
    } else {
      setActiveZone(null);
      activeZoneRef.current = null;
      setLastAlertTime(null);
      lastAlertTimeRef.current = null;
      setDismissedZoneId("");
      const safePayload = {
        zoneName: "Safe area",
        riskLevel: "safe",
        lat,
        lng,
        timestamp: Date.now(),
      };
      setCachedZone(safePayload);
      storeLastKnownZone(safePayload);
    }
  }

  function centerOnUser() {
    if (!mapRef.current || !Array.isArray(userPosition)) return;
    mapRef.current.setView(userPosition, 14, { animate: true });
  }

  useEffect(() => {
    if (typeof window === "undefined" || window.innerWidth >= 768)
      return undefined;
    const handle = sheetHandleRef.current;
    const sheet = sheetRef.current;
    if (!handle || !sheet) return undefined;

    let startY = 0;
    let startHeight = 0;

    const onTouchStart = (event) => {
      startY = event.touches[0].clientY;
      startHeight = sheet.offsetHeight;
    };

    const onTouchMove = (event) => {
      const delta = startY - event.touches[0].clientY;
      const newH = Math.min(
        Math.max(startHeight + delta, 180),
        window.innerHeight * 0.7,
      );
      sheet.style.height = `${newH}px`;
    };

    const onTouchEnd = () => {
      const expanded = sheet.offsetHeight > window.innerHeight * 0.42;
      setSheetExpanded(expanded);
      sheet.style.height = "";
    };

    handle.addEventListener("touchstart", onTouchStart, { passive: true });
    handle.addEventListener("touchmove", onTouchMove, { passive: true });
    handle.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      handle.removeEventListener("touchstart", onTouchStart);
      handle.removeEventListener("touchmove", onTouchMove);
      handle.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  useEffect(() => {
    setIsDemoMode(selectedCity === "nagpur-demo");
  }, [selectedCity]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return undefined;

    const map = L.map(mapContainerRef.current, {
      zoomControl: false,
      preferCanvas: true,
      attributionControl: false,
    }).setView(GADCHIROLI_CENTER, 11);
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);

    L.control.zoom({ position: "bottomright" }).addTo(map);
    zoneLayerGroupRef.current = L.layerGroup().addTo(map);
    touristLayerGroupRef.current = L.layerGroup().addTo(map);
    emergencyLayerGroupRef.current = L.layerGroup().addTo(map);

    return () => {
      if (watcherIdRef.current !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(watcherIdRef.current);
      }

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentHour(new Date().getHours());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      clearLocationDisabledTimer();
      if (bannerTimeoutRef.current) clearTimeout(bannerTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadCities() {
      try {
        const response = await fetch(api("/api/cities"), { cache: "no-store" });
        if (!response.ok) throw new Error("Cities fetch failed");
        const payload = await response.json();
        if (cancelled || !Array.isArray(payload)) return;

        const hasDemo = payload.some((city) => city.key === "nagpur-demo");
        setCities(
          hasDemo
            ? payload
            : [
                ...payload,
                {
                  key: "nagpur-demo",
                  city: "Nagpur (Demo Alert Mode)",
                  center: NAGPUR_CENTER,
                  zoneCount: 3,
                },
              ],
        );
      } catch {
        if (!cancelled) {
          setCities([
            {
              key: "gadchiroli",
              city: "Gadchiroli",
              center: GADCHIROLI_CENTER,
              zoneCount: 0,
            },
            {
              key: "nagpur-demo",
              city: "Nagpur (Demo Alert Mode)",
              center: NAGPUR_CENTER,
              zoneCount: 3,
            },
          ]);
        }
      }
    }

    loadCities();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadZones() {
      if (!navigator.onLine) {
        const cached = JSON.parse(
          localStorage.getItem("lastKnownZone") || "null",
        );
        if (!cancelled && cached) {
          setCachedZone(cached);
          setErrorMessage("Offline mode active. Showing cached zone data.");
        }
        return;
      }
      try {
        const response = await fetch(
          api(`/api/zones/${encodeURIComponent(selectedCity)}`),
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("Zones fetch failed");
        const payload = await response.json();
        if (cancelled) return;
        const normalized = normalizeZones(payload);
        setZones(normalized);
        setSelectedZone(null);
        setErrorMessage(normalized.length === 0 ? "No zones configured." : "");
      } catch {
        if (!cancelled) {
          setZones([]);
          setErrorMessage("Failed to load geofence zones.");
        }
      }
    }

    loadZones();
    return () => {
      cancelled = true;
    };
  }, [selectedCity]);

  useEffect(() => {
    let cancelled = false;

    async function loadCityOverlays() {
      setEmergencyLoading(true);
      setEmergencyError("");

      try {
        const [touristResponse, emergencyResponse] = await Promise.all([
          fetch(api(`/api/tourist-spots/${encodeURIComponent(selectedCity)}`), {
            cache: "no-store",
          }),
          fetch(
            api(`/api/emergency-services/${encodeURIComponent(selectedCity)}`),
            {
              cache: "no-store",
            },
          ),
        ]);

        if (!cancelled) {
          if (touristResponse.ok) {
            setTouristSpots(
              normalizeTouristSpots(await touristResponse.json()),
            );
          } else {
            setTouristSpots([]);
          }

          if (emergencyResponse.ok) {
            setEmergencyInfo(
              normalizeEmergencyServices(await emergencyResponse.json()),
            );
          } else {
            setEmergencyInfo({ hospitals: [], police_stations: [] });
            setEmergencyError("No emergency service dataset available.");
          }
        }
      } catch {
        if (!cancelled) {
          setTouristSpots([]);
          setEmergencyInfo({ hospitals: [], police_stations: [] });
          setEmergencyError("Unable to load emergency services.");
        }
      } finally {
        if (!cancelled) setEmergencyLoading(false);
      }
    }

    loadCityOverlays();
    return () => {
      cancelled = true;
    };
  }, [selectedCity]);

  useEffect(() => {
    if (!mapRef.current || cities.length === 0) return;
    const city = cities.find((entry) => entry.key === selectedCity);
    if (!city || !Array.isArray(city.center)) return;
    mapRef.current.setView(city.center, isDemoMode ? 14 : 11, {
      animate: true,
    });
  }, [cities, isDemoMode, selectedCity]);

  useEffect(() => {
    if (!mapRef.current || !zoneLayerGroupRef.current) return;

    zoneLayerGroupRef.current.clearLayers();

    zones.forEach((zone) => {
      if (zone.type === "time_based" && !isZoneActive(zone)) return;

      const visual = getZoneVisual(zone.riskLevel);
      const polygon = L.polygon(zone.coordinates, {
        color: visual.stroke,
        weight: 2,
        fillColor: visual.fill,
        fillOpacity: 0.25,
        className: `zone-polygon zone-polygon-${zone.riskLevel}`,
      });

      polygon.on("click", () => {
        setSelectedZone(zone);
        setShowIntelPanel(true);
      });

      polygon.addTo(zoneLayerGroupRef.current);
    });
  }, [currentHour, isDemoMode, zones]);

  useEffect(() => {
    if (!mapRef.current || !touristLayerGroupRef.current) return;

    touristLayerGroupRef.current.clearLayers();
    const touristIcon = createMarkerIcon("tourist");

    touristSpots.forEach((spot) => {
      const warningInDanger = zones.some(
        (zone) =>
          zone.riskLevel === "danger" &&
          isPointInPolygon(
            [Number(spot.lat), Number(spot.lng)],
            zone.coordinates,
          ),
      );

      L.marker([Number(spot.lat), Number(spot.lng)], { icon: touristIcon })
        .bindPopup(buildTouristPopup(spot, warningInDanger))
        .addTo(touristLayerGroupRef.current);
    });
  }, [touristSpots, zones]);

  useEffect(() => {
    if (!mapRef.current || !emergencyLayerGroupRef.current) return;

    emergencyLayerGroupRef.current.clearLayers();

    const hospitalIcon = createMarkerIcon("hospital");
    const policeIcon = createMarkerIcon("police");

    nearestHospitals.forEach((item) => {
      L.marker([item.latitude, item.longitude], { icon: hospitalIcon })
        .bindTooltip(`${item.name} | ${item.phone || "No phone"}`, {
          direction: "top",
          offset: [0, -28],
          opacity: 0.95,
        })
        .bindPopup(buildEmergencyPopup(item, "hospital"))
        .addTo(emergencyLayerGroupRef.current);
    });

    nearestPoliceStations.forEach((item) => {
      L.marker([item.latitude, item.longitude], { icon: policeIcon })
        .bindTooltip(`${item.name} | ${item.phone || "No phone"}`, {
          direction: "top",
          offset: [0, -28],
          opacity: 0.95,
        })
        .bindPopup(buildEmergencyPopup(item, "police"))
        .addTo(emergencyLayerGroupRef.current);
    });
  }, [nearestHospitals, nearestPoliceStations]);

  useEffect(() => {
    if (!mapRef.current) return undefined;

    if (isDemoMode) {
      if (watcherIdRef.current !== null && "geolocation" in navigator) {
        navigator.geolocation.clearWatch(watcherIdRef.current);
        watcherIdRef.current = null;
      }

      const [lat, lng] = DEMO_LOCATION;
      setUserPosition([lat, lng]);
      if (!userMarkerRef.current) {
        userMarkerRef.current = L.marker([lat, lng], {
          icon: createUserIcon(),
          zIndexOffset: 2000,
        }).addTo(mapRef.current);
      } else {
        userMarkerRef.current.setLatLng([lat, lng]);
      }

      mapRef.current.setView([lat, lng], 14, { animate: true });
      evaluatePosition(lat, lng, 3);
      if (Date.now() - lastSavedLocationAtRef.current >= 30000) {
        lastSavedLocationAtRef.current = Date.now();
        saveLastLocation(
          lat,
          lng,
          activeZoneRef.current || { riskLevel: "safe" },
        );
      }
      return undefined;
    }

    if (!("geolocation" in navigator)) {
      setErrorMessage("Geolocation is not supported on this device.");
      return undefined;
    }

    const onSuccess = (position) => {
      const lat = Number(position?.coords?.latitude);
      const lng = Number(position?.coords?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      setUserPosition([lat, lng]);
      setErrorMessage("");
      clearLocationDisabledTimer();

      if (!userPickedCityRef.current && cities.length > 0) {
        const nearest = cities.reduce((best, city) => {
          if (!Array.isArray(city.center) || city.key === "nagpur-demo") {
            return best;
          }
          const dist = squaredDistance([lat, lng], city.center);
          if (!best || dist < best.dist) return { key: city.key, dist };
          return best;
        }, null);

        if (nearest?.key && nearest.key !== selectedCity) {
          setSelectedCity(nearest.key);
        }
      }

      if (!userMarkerRef.current) {
        userMarkerRef.current = L.marker([lat, lng], {
          icon: createUserIcon(),
          zIndexOffset: 2000,
        }).addTo(mapRef.current);
      } else {
        userMarkerRef.current.setLatLng([lat, lng]);
      }

      evaluatePosition(lat, lng, getCurrentHour());
      if (Date.now() - lastSavedLocationAtRef.current >= 30000) {
        lastSavedLocationAtRef.current = Date.now();
        saveLastLocation(
          lat,
          lng,
          activeZoneRef.current || { riskLevel: "safe" },
        );
      }
    };

    const onError = (error) => {
      if (error?.code === 1) {
        setErrorMessage("Location permission denied.");
        startLocationDisabledTimer();
      } else if (error?.code === 2) {
        setErrorMessage("Location unavailable.");
      } else if (error?.code === 3) {
        setErrorMessage("Location request timed out.");
      } else {
        setErrorMessage("Unable to retrieve your location.");
      }
    };

    watcherIdRef.current = navigator.geolocation.watchPosition(
      onSuccess,
      onError,
      {
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 5000,
      },
    );

    return () => {
      if (watcherIdRef.current !== null) {
        navigator.geolocation.clearWatch(watcherIdRef.current);
        watcherIdRef.current = null;
      }
    };
  }, [cities, currentHour, isDemoMode, selectedCity, zones]);

  const bannerZoneName =
    activeZone?.name ||
    cachedZone?.zoneName ||
    `${toTitle(selectedCity)} overview`;
  const bannerRiskLevel =
    activeZone?.riskLevel || cachedZone?.riskLevel || "safe";
  const currentZoneLabel = bannerZoneName;
  const zoneStatusText =
    bannerRiskLevel === "danger"
      ? "Danger"
      : bannerRiskLevel === "moderate"
        ? "Moderate"
        : "Safe";
  const statusDotStyle = {
    background: getZoneVisual(bannerRiskLevel).dot,
  };
  const userInitial = String(travelerName || "T")
    .trim()
    .charAt(0)
    .toUpperCase();
  const canShowAlert = !activeZone || dismissedZoneId !== activeZone.id;
  const sheetLabel = nearbyServices.length
    ? `${nearbyServices.length} Nearby Services`
    : emergencyLoading
      ? "Loading nearby services"
      : "Nearby services unavailable";

  function handleSheetPointerDown(event) {
    sheetDragStartRef.current = event.clientY;
  }

  function handleSheetPointerUp(event) {
    if (typeof window !== "undefined" && window.innerWidth < 768) return;
    const start = sheetDragStartRef.current;
    if (start === null) return;
    const delta = start - event.clientY;
    sheetDragStartRef.current = null;

    if (Math.abs(delta) < 8) {
      setSheetExpanded((value) => !value);
      return;
    }

    if (delta > 40) setSheetExpanded(true);
    if (delta < -40) setSheetExpanded(false);
  }

  return (
    <div className="gm-dashboard">
      <div ref={mapContainerRef} className="gm-map-canvas" />

      {connectivityBanner ? (
        <div
          id="connectivity-banner"
          className={`gm-connectivity-banner gm-connectivity-banner-${connectivityBanner.state}`}
        >
          <span>{connectivityBanner.message}</span>
        </div>
      ) : null}

      {actionBanner ? (
        <div
          className={`gm-action-banner gm-action-banner-${actionBanner.tone}`}
        >
          {actionBanner.message}
        </div>
      ) : null}

      <div className="gm-top-left">
        <div className="gm-search-card">
          <div className="gm-search-inner">
            <div className="gm-brand-row">
              <div className="gm-brand-icon">
                <AppLogoIcon />
              </div>
              <div className="gm-brand-copy">
                <strong>Tourist Safety System</strong>
                <span>{currentZoneLabel}</span>
              </div>
              <div className="gm-search-mobile-avatar">{userInitial}</div>
              <div className="gm-status-dot" style={statusDotStyle} />
            </div>
            <div className="gm-search-divider" />
            <div className="gm-search-select-row">
              <label htmlFor="citySelect" className="gm-inline-label">
                CITY
              </label>
              <select
                id="citySelect"
                className="gm-city-select"
                value={selectedCity}
                onChange={(event) => {
                  userPickedCityRef.current = true;
                  setSelectedCity(event.target.value);
                }}
              >
                {cities.map((city) => (
                  <option key={city.key} value={city.key}>
                    {city.key === "nagpur-demo"
                      ? "Nagpur (Demo Alert Mode)"
                      : `${city.city} (${city.zoneCount})`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {errorMessage ? (
            <p className="gm-inline-error">{errorMessage}</p>
          ) : null}
        </div>
      </div>

      <div className="gm-top-right">
        <div className="gm-user-card">
          <div className="gm-user-avatar">{userInitial}</div>
          <div className="gm-user-meta">
            <strong>{travelerName || "Traveler"}</strong>
            <span>{truncateMiddle(blockchainId || "No blockchain ID")}</span>
          </div>
          <div className={`gm-user-badge gm-user-badge-${bannerRiskLevel}`}>
            {zoneStatusText}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {canShowAlert ? (
          <motion.div
            className={`gm-alert-pill gm-alert-pill-${activeZone?.riskLevel || "safe"}`}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className="gm-alert-copy">
              <strong>{currentZoneLabel}</strong>
              <span>
                {zoneStatusText} risk{!isOnlineState ? " • ⚡ Cached" : ""}
              </span>
            </div>
            {activeZone && !isDemoMode ? (
              <button
                type="button"
                className="gm-alert-dismiss"
                onClick={() => setDismissedZoneId(activeZone.id)}
              >
                <span aria-hidden="true">&times;</span>
              </button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="gm-fab-stack">
        <button
          type="button"
          className="gm-fab"
          onClick={centerOnUser}
          title="Center on my location"
        >
          <LocateIcon />
        </button>
        <button
          type="button"
          className="gm-fab gm-fab-sos"
          onClick={() => setSosModalOpen(true)}
          title="SOS"
        >
          <SosIcon />
        </button>
        <button
          type="button"
          className="gm-fab"
          onClick={() => setShowIntelPanel(true)}
          title="Area Intelligence"
        >
          <InfoIcon />
        </button>
      </div>

      <AnimatePresence>
        {sosModalOpen ? (
          <motion.div
            className="gm-sos-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => (sosSubmitting ? null : setSosModalOpen(false))}
          >
            <motion.div
              className="gm-sos-modal sos-modal"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="gm-sos-modal-icon">🆘</div>
              <h3>Send Emergency Alert?</h3>
              <p>
                This will share your current GPS coordinates, name, and contact
                number with the nearest police station via SMS.
              </p>
              <div className="gm-sos-preview">
                📍 Lat: {userPosition?.[0]?.toFixed(5) || "N/A"}, Lng:{" "}
                {userPosition?.[1]?.toFixed(5) || "N/A"}
              </div>
              <div className="gm-sos-preview">
                ⚠️ Zone: {currentZoneLabel} —{" "}
                {String(bannerRiskLevel).toUpperCase()}
              </div>
              <button
                id="sos-confirm"
                type="button"
                className="gm-sos-confirm"
                disabled={sosSubmitting || !userPosition}
                onClick={sendSosAlert}
              >
                {sosSubmitting ? "SENDING..." : "YES, SEND ALERT"}
              </button>
              <button
                id="sos-cancel"
                type="button"
                className="gm-sos-cancel"
                onClick={() => (sosSubmitting ? null : setSosModalOpen(false))}
              >
                Cancel
              </button>
              {sosResult ? (
                <div
                  id="sos-result"
                  className={`gm-sos-result gm-sos-result--${sosResult.type}`}
                >
                  {sosResult.message}
                </div>
              ) : null}
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showIntelPanel ? (
          <>
            <motion.button
              type="button"
              aria-label="Close area intelligence"
              className="gm-intel-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowIntelPanel(false)}
            />
            <motion.aside
              className="gm-intel-panel"
              initial={{ x: -320 }}
              animate={{ x: 0 }}
              exit={{ x: -320 }}
              transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
            >
              <div className="gm-intel-head">
                <div>
                  <strong>Area Intelligence</strong>
                  <p>{toTitle(selectedCity)} live map context</p>
                </div>
                <button
                  type="button"
                  className="gm-intel-close"
                  onClick={() => setShowIntelPanel(false)}
                >
                  <span aria-hidden="true">&times;</span>
                </button>
              </div>

              <div className="gm-legend-list">
                <div>
                  <span className="gm-legend-swatch gm-legend-safe" />
                  Safe
                </div>
                <div>
                  <span className="gm-legend-swatch gm-legend-moderate" />
                  Moderate
                </div>
                <div>
                  <span className="gm-legend-swatch gm-legend-danger" />
                  Danger
                </div>
              </div>

              <div className="gm-intel-card">
                <p className="gm-intel-label">Current area</p>
                <strong>{currentZoneLabel}</strong>
                <span>{zoneStatusText} risk</span>
              </div>

              <div className="gm-intel-card">
                <p className="gm-intel-label">Selected zone</p>
                <strong>{selectedZone?.name || "Tap any zone"}</strong>
                <span>
                  {selectedZone
                    ? `${toTitle(selectedZone.riskLevel)} • Score ${selectedZone.riskScore ?? selectedZone.crimeIndex ?? "N/A"}`
                    : "Zone details open here"}
                </span>
              </div>

              <div className="gm-intel-card">
                <p className="gm-intel-label">Live coordinates</p>
                <strong>
                  {userPosition
                    ? `${userPosition[0].toFixed(4)}, ${userPosition[1].toFixed(4)}`
                    : "Waiting for GPS"}
                </strong>
                <span>
                  {lastAlertTime
                    ? `Last update ${new Date(lastAlertTime).toLocaleTimeString()}`
                    : "No active alert"}
                </span>
              </div>

              {selectedZone?.reason ? (
                <div className="gm-intel-detail">
                  <strong>Why this zone matters</strong>
                  <p>{selectedZone.reason}</p>
                </div>
              ) : null}
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      <div
        ref={sheetRef}
        className={`gm-bottom-sheet ${sheetExpanded ? "gm-bottom-sheet-expanded" : ""}`}
      >
        <button
          ref={sheetHandleRef}
          type="button"
          className="gm-sheet-handle-wrap"
          onPointerDown={handleSheetPointerDown}
          onPointerUp={handleSheetPointerUp}
        >
          <span className="gm-sheet-handle" />
          <span className="gm-sheet-title">{sheetLabel}</span>
        </button>

        <div className="gm-sheet-content">
          {emergencyLoading ? (
            <div className="gm-sheet-state">Loading nearby services...</div>
          ) : null}
          {emergencyError ? (
            <div className="gm-sheet-state gm-sheet-state-error">
              {emergencyError}
            </div>
          ) : null}

          <div className="gm-service-rail">
            {nearestHospitals.map((service, index) => (
              <article
                key={`hospital-${service.id || service.name}`}
                className="gm-service-card gm-service-card-hospital"
              >
                <div className="gm-service-card-top">
                  <span className="gm-service-type">Hospital</span>
                  {index === 0 ? (
                    <span className="gm-service-nearest">Nearest</span>
                  ) : null}
                </div>
                <strong className="gm-service-name">{service.name}</strong>
                <span className="gm-service-distance">
                  {Number.isFinite(service.distanceKm)
                    ? `${service.distanceKm.toFixed(2)} km`
                    : "Distance unavailable"}
                </span>
                <span className="gm-service-phone">
                  {service.phone || "No phone"}
                </span>
                {service.phone ? (
                  <a href={`tel:${service.phone}`} className="gm-service-call">
                    Call
                  </a>
                ) : (
                  <span className="gm-service-call gm-service-call-disabled">
                    No Phone
                  </span>
                )}
              </article>
            ))}

            {nearestPoliceStations.map((service, index) => (
              <article
                key={`police-${service.id || service.name}`}
                className="gm-service-card gm-service-card-police"
              >
                <div className="gm-service-card-top">
                  <span className="gm-service-type">Police</span>
                  {index === 0 ? (
                    <span className="gm-service-nearest">Nearest</span>
                  ) : null}
                </div>
                <strong className="gm-service-name">{service.name}</strong>
                <span className="gm-service-distance">
                  {Number.isFinite(service.distanceKm)
                    ? `${service.distanceKm.toFixed(2)} km`
                    : "Distance unavailable"}
                </span>
                <span className="gm-service-phone">
                  {service.phone || "No phone"}
                </span>
                {service.phone ? (
                  <a href={`tel:${service.phone}`} className="gm-service-call">
                    Call
                  </a>
                ) : (
                  <span className="gm-service-call gm-service-call-disabled">
                    No Phone
                  </span>
                )}
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
