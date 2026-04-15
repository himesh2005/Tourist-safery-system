import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import {
  FiAlertTriangle,
  FiClock,
  FiDatabase,
  FiFileText,
  FiFilter,
  FiLogOut,
  FiMap,
  FiMenu,
  FiRefreshCw,
  FiSearch,
  FiShield,
  FiUsers,
  FiX,
} from "react-icons/fi";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { API_URL } from "../config/env.js";

const REFRESH_MS = 10_000;
const DEFAULT_CENTER = [20.1849, 80.003];

const NAV_ITEMS = [
  { key: "tourists", label: "Tourists", icon: FiUsers },
  { key: "heatmap", label: "Heatmap", icon: FiMap },
  { key: "records", label: "Digital IDs", icon: FiDatabase },
  { key: "alerts", label: "Alerts", icon: FiAlertTriangle },
  { key: "fir", label: "E-FIR", icon: FiFileText },
];

export default function AdminDashboard() {
  const nav = useNavigate();

  const [activeNav, setActiveNav] = useState("tourists");
  const [tourists, setTourists] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [firs, setFirs] = useState([]);
  const [zones, setZones] = useState([]);

  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isTablet, setIsTablet] = useState(false);

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const mapLayersRef = useRef({
    touristsLayer: null,
    heatLayer: null,
    clusterLayer: null,
    zonesLayer: null,
  });

  const isMapMode = activeNav === "tourists" || activeNav === "heatmap";

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1024px)");

    const syncLayout = () => {
      const tabletMode = media.matches;
      setIsTablet(tabletMode);
      setSidebarOpen(!tabletMode);
    };

    syncLayout();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", syncLayout);
      return () => media.removeEventListener("change", syncLayout);
    }

    media.addListener(syncLayout);
    return () => media.removeListener(syncLayout);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem("token");
    const adminUser = localStorage.getItem("adminUser");

    if (!token || !adminUser) {
      nav("/auth", { replace: true });
      return;
    }

    fetchAll({ silent: false });

    const interval = setInterval(() => {
      fetchAll({ silent: true });
    }, REFRESH_MS);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isMapMode) {
      teardownMap();
      return;
    }

    const containerChanged =
      mapRef.current &&
      mapContainerRef.current &&
      mapRef.current.getContainer() !== mapContainerRef.current;

    if (containerChanged) {
      teardownMap();
    }

    if (!mapRef.current && mapContainerRef.current) {
      const map = L.map(mapContainerRef.current, {
        zoomControl: true,
        minZoom: 4,
      }).setView(DEFAULT_CENTER, 10);

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
      }).addTo(map);

      mapLayersRef.current.touristsLayer = L.layerGroup().addTo(map);
      mapLayersRef.current.heatLayer = L.layerGroup().addTo(map);
      mapLayersRef.current.clusterLayer = L.layerGroup().addTo(map);
      mapLayersRef.current.zonesLayer = L.layerGroup().addTo(map);

      mapRef.current = map;
    }

    if (mapRef.current) {
      setTimeout(() => mapRef.current?.invalidateSize(), 120);
    }

    return () => {
      // keep map alive while switching tourists <-> heatmap
    };
  }, [isMapMode, activeNav]);

  useEffect(() => {
    if (!mapRef.current || !isMapMode) return;
    drawZones();
    drawTouristOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourists, zones, activeNav, query]);

  const filteredTourists = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tourists;

    return tourists.filter((t) => {
      const name = String(t.name || "").toLowerCase();
      const id = String(t.blockchainId || "").toLowerCase();
      const username = String(t.username || "").toLowerCase();
      return name.includes(q) || id.includes(q) || username.includes(q);
    });
  }, [tourists, query]);

  const filteredAlerts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...alerts].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
    );

    if (!q) return list;
    return list.filter((a) => {
      const name = String(a.userName || "").toLowerCase();
      const id = String(a.blockchainId || "").toLowerCase();
      const zone = String(a.zoneName || "").toLowerCase();
      return name.includes(q) || id.includes(q) || zone.includes(q);
    });
  }, [alerts, query]);

  const records = useMemo(() => {
    return filteredTourists.map((t) => {
      const r = t.digitalIdRecord || {};
      return {
        name: t.name || t.username || "--",
        blockchainId: t.blockchainId || r.blockchainId || "--",
        itinerary: r.itinerary || "--",
        emergencyContacts: r.emergencyContacts || "--",
        validFrom: r.validFrom || t.loginTimestamp || null,
        validTill: r.validTill || null,
      };
    });
  }, [filteredTourists]);

  async function fetchAll({ silent }) {
    const token = localStorage.getItem("token");
    if (!token) return;

    if (!silent) setLoading(true);
    setBusy(true);

    try {
      const headers = { Authorization: `Bearer ${token}` };

      const [tRes, aRes, fRes, zRes] = await Promise.all([
        fetch(`${API_URL}/admin/tourists`, { headers }),
        fetch(`${API_URL}/admin/alerts`, { headers }),
        fetch(`${API_URL}/admin/firs`, { headers }),
        fetch(`${API_URL}/api/zones?city=gadchiroli`),
      ]);

      if (tRes.status === 401 || tRes.status === 403) {
        handleLogout();
        return;
      }

      const [touristsData, alertsData, firsData, zonesData] = await Promise.all(
        [
          tRes.ok ? tRes.json() : [],
          aRes.ok ? aRes.json() : [],
          fRes.ok ? fRes.json() : [],
          zRes.ok ? zRes.json() : [],
        ],
      );

      setTourists(Array.isArray(touristsData) ? touristsData : []);
      setAlerts(Array.isArray(alertsData) ? alertsData : []);
      setFirs(Array.isArray(firsData) ? firsData : []);
      setZones(Array.isArray(zonesData) ? zonesData : []);
      setLastUpdated(Date.now());
      setMessage("");
    } catch {
      setMessage("Unable to fetch admin data. Retrying automatically.");
    } finally {
      setBusy(false);
      setLoading(false);
    }
  }

  function teardownMap() {
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
      mapLayersRef.current = {
        touristsLayer: null,
        heatLayer: null,
        clusterLayer: null,
        zonesLayer: null,
      };
    }
  }

  function drawZones() {
    const zonesLayer = mapLayersRef.current.zonesLayer;
    if (!zonesLayer) return;

    zonesLayer.clearLayers();

    zones.forEach((zone) => {
      if (!Array.isArray(zone.coordinates) || zone.coordinates.length < 3)
        return;
      const risk = normalizeRisk(zone.riskLevel);
      const color = riskColor(risk);

      L.polygon(zone.coordinates, {
        color,
        weight: 1.5,
        fillColor: color,
        fillOpacity: activeNav === "heatmap" ? 0.24 : 0.16,
      })
        .bindPopup(
          `
          <div style="min-width:200px;">
            <strong>${zone.name || "Unknown Zone"}</strong><br/>
            Risk: <span style="text-transform:uppercase;font-weight:700;color:${color};">${risk}</span>
          </div>
        `,
        )
        .addTo(zonesLayer);
    });
  }

  function drawTouristOverlays() {
    const touristsLayer = mapLayersRef.current.touristsLayer;
    const heatLayer = mapLayersRef.current.heatLayer;
    const clusterLayer = mapLayersRef.current.clusterLayer;
    const map = mapRef.current;

    if (!touristsLayer || !heatLayer || !clusterLayer || !map) return;

    touristsLayer.clearLayers();
    heatLayer.clearLayers();
    clusterLayer.clearLayers();

    const sourceTourists =
      activeNav === "heatmap" ? tourists : filteredTourists;

    const liveTourists = sourceTourists
      .map((t) => {
        const loc = getLocation(t);
        if (!loc) return null;
        return { tourist: t, loc };
      })
      .filter(Boolean);

    if (liveTourists.length === 0) {
      const fallbackTourist = tourists.find((t) => getLocation(t));
      const fallbackLoc = fallbackTourist ? getLocation(fallbackTourist) : null;
      if (fallbackLoc) {
        map.setView([fallbackLoc.lat, fallbackLoc.lng], 11);
      } else {
        map.setView(DEFAULT_CENTER, 10);
      }
      return;
    }

    if (activeNav === "tourists") {
      const bounds = [];

      liveTourists.forEach(({ tourist, loc }) => {
        const risk = normalizeRisk(loc.riskLevel || tourist.riskZoneStatus);
        const color = riskColor(risk);
        bounds.push([loc.lat, loc.lng]);

        const marker = L.circleMarker([loc.lat, loc.lng], {
          radius: 8,
          color: "#fff",
          weight: 2,
          fillColor: color,
          fillOpacity: 0.95,
        });

        marker.bindPopup(`
          <div style="min-width:220px;">
            <strong>${tourist.name || tourist.username || "Tourist"}</strong><br/>
            ID: ${tourist.blockchainId || "N/A"}<br/>
            Zone: ${loc.zoneName || tourist.zoneName || "Unknown"}<br/>
            Risk: <span style="font-weight:700;text-transform:uppercase;color:${color};">${risk}</span><br/>
            Location: ${fixed(loc.lat)}, ${fixed(loc.lng)}<br/>
            Time: ${formatDateTime(loc.timestamp)}
          </div>
        `);
        marker.addTo(touristsLayer);
      });

      if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      } else if (bounds.length === 1) {
        map.setView(bounds[0], 13);
      }
    }

    if (activeNav === "heatmap") {
      const grouped = buildClusters(liveTourists);

      liveTourists.forEach(({ loc }) => {
        const risk = normalizeRisk(loc.riskLevel);
        const color = riskColor(risk);

        L.circle([loc.lat, loc.lng], {
          radius: 1400,
          stroke: false,
          fillColor: color,
          fillOpacity: 0.2,
          interactive: false,
        }).addTo(heatLayer);

        L.circle([loc.lat, loc.lng], {
          radius: 700,
          stroke: false,
          fillColor: color,
          fillOpacity: 0.3,
          interactive: false,
        }).addTo(heatLayer);

        L.circleMarker([loc.lat, loc.lng], {
          radius: 4,
          stroke: false,
          fillColor: color,
          fillOpacity: 0.95,
          interactive: false,
        }).addTo(heatLayer);
      });

      grouped.forEach((cluster) => {
        const avgRisk = cluster.avgRisk;
        const color =
          avgRisk >= 1.6 ? "#dc2626" : avgRisk >= 0.8 ? "#f97316" : "#16a34a";
        const radius = Math.min(36, 10 + cluster.count * 2);

        L.circleMarker([cluster.lat, cluster.lng], {
          radius,
          weight: 2,
          color: "#ffffff",
          fillColor: color,
          fillOpacity: 0.88,
        })
          .bindPopup(
            `
            <div>
              <strong>Cluster Zone</strong><br/>
              Tourists: ${cluster.count}<br/>
              Approx center: ${fixed(cluster.lat)}, ${fixed(cluster.lng)}
            </div>
          `,
          )
          .addTo(clusterLayer);

        const label = L.divIcon({
          className: "cluster-count-icon",
          html: `<div style="
              background:#0f172a;
              color:#fff;
              border:1px solid rgba(255,255,255,0.55);
              border-radius:999px;
              min-width:28px;
              height:28px;
              display:grid;
              place-items:center;
              font-size:12px;
              font-weight:700;
              box-shadow:0 6px 20px rgba(15,23,42,0.35);
              padding:0 8px;
            ">${cluster.count}</div>`,
          iconSize: [28, 28],
        });

        L.marker([cluster.lat, cluster.lng], {
          icon: label,
          interactive: false,
        }).addTo(clusterLayer);
      });

      const bounds = liveTourists.map(({ loc }) => [loc.lat, loc.lng]);
      if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
      } else if (bounds.length === 1) {
        map.setView(bounds[0], 12);
      } else {
        const fallbackTourist = tourists.find((t) => getLocation(t));
        const fallbackLoc = fallbackTourist
          ? getLocation(fallbackTourist)
          : null;
        if (fallbackLoc) {
          map.setView([fallbackLoc.lat, fallbackLoc.lng], 11);
        } else {
          map.setView(DEFAULT_CENTER, 10);
        }
      }
    }
  }

  function handleLogout() {
    localStorage.removeItem("token");
    localStorage.removeItem("adminUser");
    nav("/auth", { replace: true });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        color: "#e6f6ff",
        position: "relative",
      }}
    >
      <AnimatePresence>
        {isTablet && sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(2, 6, 23, 0.56)",
              zIndex: 32,
            }}
          />
        )}
      </AnimatePresence>

      <aside
        className="glass-card"
        style={{
          width: 260,
          maxWidth: "82vw",
          padding: "1rem",
          borderRadius: 0,
          borderTop: "none",
          borderBottom: "none",
          borderLeft: "none",
          position: isTablet ? "fixed" : "sticky",
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: isTablet ? 40 : 20,
          transform: isTablet
            ? sidebarOpen
              ? "translateX(0)"
              : "translateX(-110%)"
            : "translateX(0)",
          transition: "transform 220ms ease",
          boxShadow: isTablet ? "0 20px 42px rgba(2, 6, 23, 0.48)" : "none",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          background: "rgba(8, 17, 29, 0.88)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: "#d7f1ff" }}>
              Admin Dashboard
            </div>
            <div style={{ fontSize: 12, color: "#96b3c3" }}>
              Tourism Safety System
            </div>
          </div>
          {isTablet ? (
            <button
              onClick={() => setSidebarOpen(false)}
              style={iconButtonStyle()}
              aria-label="Close sidebar"
            >
              <FiX />
            </button>
          ) : null}
        </div>

        <nav style={{ display: "grid", gap: 8 }}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.key;
            return (
              <button
                key={item.key}
                onClick={() => {
                  setActiveNav(item.key);
                  setSidebarOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  borderRadius: 12,
                  border: active
                    ? "1px solid rgba(159,233,255,0.45)"
                    : "1px solid transparent",
                  padding: "0.8rem 0.9rem",
                  color: active ? "#e8f7ff" : "#a8c4d4",
                  background: active
                    ? "rgba(79, 180, 255, 0.14)"
                    : "transparent",
                  cursor: "pointer",
                  fontWeight: active ? 700 : 600,
                }}
              >
                <Icon />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div style={{ marginTop: "auto", display: "grid", gap: 10 }}>
          <div
            style={{
              fontSize: 12,
              color: "#9bb4c2",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <FiClock />
            Auto-refresh every 10s
          </div>
          <button
            onClick={handleLogout}
            style={{ ...iconButtonStyle(), width: "100%", borderRadius: 10 }}
          >
            <FiLogOut />
            <span style={{ marginLeft: 8 }}>Logout</span>
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, minWidth: 0, padding: "1rem 1rem 1.25rem 1rem" }}>
        <header
          className="glass-card"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            justifyContent: "space-between",
            padding: "0.85rem 1rem",
            marginBottom: "1rem",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
            }}
          >
            {isTablet ? (
              <button
                onClick={() => setSidebarOpen((prev) => !prev)}
                style={iconButtonStyle()}
                aria-label="Toggle sidebar"
              >
                <FiMenu />
              </button>
            ) : null}
            <h2
              style={{
                margin: 0,
                fontSize: 18,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {titleFor(activeNav)}
            </h2>
            {busy && (
              <FiRefreshCw style={{ animation: "spin 1s linear infinite" }} />
            )}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            <div style={{ position: "relative" }}>
              <FiSearch
                style={{
                  position: "absolute",
                  left: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "#8fb1c5",
                }}
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder(activeNav)}
                style={{
                  width: 250,
                  maxWidth: "70vw",
                  borderRadius: 10,
                  border: "1px solid rgba(180, 226, 244, 0.28)",
                  padding: "0.58rem 0.75rem 0.58rem 2rem",
                  background: "rgba(10, 18, 30, 0.45)",
                  color: "#e8f7ff",
                }}
              />
            </div>
            <button
              onClick={() => fetchAll({ silent: false })}
              style={iconButtonStyle()}
              title="Refresh now"
            >
              <FiRefreshCw />
            </button>
          </div>
        </header>

        {message ? (
          <div
            className="glass-card"
            style={{
              marginBottom: "1rem",
              padding: "0.8rem 1rem",
              borderColor: "rgba(248, 113, 113, 0.55)",
              color: "#ffd2d2",
            }}
          >
            {message}
          </div>
        ) : null}

        <AnimatePresence mode="wait">
          {loading ? (
            <div
              key="loading"
              className="glass-card"
              style={{ padding: "2rem", textAlign: "center" }}
            >
              Loading admin module...
            </div>
          ) : (
            <div style={{ display: "grid", gap: "1rem" }}>
              {isMapMode ? (
                <div
                  style={{
                    display: "grid",
                    gap: "1rem",
                    gridTemplateColumns:
                      activeNav === "tourists"
                        ? "minmax(320px, 1fr) minmax(420px, 1.1fr)"
                        : "1fr",
                  }}
                >
                  {activeNav === "tourists" ? (
                    <TouristMonitoringTable tourists={filteredTourists} />
                  ) : null}

                  <section className="glass-card" style={{ padding: "0.8rem" }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: 10,
                      }}
                    >
                      <div style={{ fontWeight: 700 }}>
                        {activeNav === "tourists"
                          ? "Live Location Map"
                          : "Heat Map & Cluster View"}
                      </div>
                      <div style={{ fontSize: 12, color: "#9dc0d3" }}>
                        Updated:{" "}
                        {lastUpdated ? formatDateTime(lastUpdated) : "—"}
                      </div>
                    </div>

                    <div
                      ref={mapContainerRef}
                      style={{
                        width: "100%",
                        height: "calc(100vh - 230px)",
                        minHeight: 420,
                        borderRadius: 14,
                        overflow: "hidden",
                        border: "1px solid rgba(186, 225, 241, 0.2)",
                      }}
                    />

                    {activeNav === "heatmap" ? (
                      <div
                        style={{
                          marginTop: 10,
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          color: "#a9c7d7",
                          fontSize: 12,
                        }}
                      >
                        <FiFilter />
                        Density zones and risk overlays are interactive.
                        Zoom/pan enabled.
                      </div>
                    ) : null}
                  </section>
                </div>
              ) : null}

              {activeNav === "records" ? (
                <DigitalIdRecordsTable records={records} />
              ) : null}

              {activeNav === "alerts" ? (
                <AlertsTable alerts={filteredAlerts} />
              ) : null}

              {activeNav === "fir" ? (
                <FirPanel
                  tourists={tourists}
                  firs={firs}
                  onCreated={() => fetchAll({ silent: true })}
                />
              ) : null}
            </div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function TouristMonitoringTable({ tourists }) {
  return (
    <section
      className="glass-card"
      style={{ padding: "1rem", overflow: "auto", minWidth: 0 }}
    >
      <h3 style={{ marginTop: 0 }}>Tourist Live Monitoring</h3>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
      >
        <thead>
          <tr
            style={{
              textAlign: "left",
              borderBottom: "1px solid rgba(180,225,244,0.2)",
            }}
          >
            <th style={thStyle}>Tourist</th>
            <th style={thStyle}>Blockchain ID</th>
            <th style={thStyle}>Login Timestamp</th>
            <th style={thStyle}>Location</th>
            <th style={thStyle}>Risk</th>
          </tr>
        </thead>
        <tbody>
          {tourists.map((t) => {
            const loc = getLocation(t);
            const risk = normalizeRisk(loc?.riskLevel || t.riskZoneStatus);
            return (
              <tr
                key={t.blockchainId || t.username}
                style={{ borderBottom: "1px solid rgba(180,225,244,0.1)" }}
              >
                <td style={tdStyle}>
                  <strong>{displayOrDash(t.name || t.username)}</strong>
                </td>
                <td style={tdStyle}>{displayOrDash(t.blockchainId)}</td>
                <td style={tdStyle}>{formatDateTime(t.loginTimestamp)}</td>
                <td style={tdStyle}>
                  {loc ? `${fixed(loc.lat)}, ${fixed(loc.lng)}` : "--"}
                </td>
                <td style={tdStyle}>
                  <span style={riskPillStyle(risk)}>{risk.toUpperCase()}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {tourists.length === 0 ? (
        <EmptyNote text="No tourists found for the selected query." />
      ) : null}
    </section>
  );
}

function DigitalIdRecordsTable({ records }) {
  return (
    <section
      className="glass-card"
      style={{ padding: "1rem", overflow: "auto" }}
    >
      <h3 style={{ marginTop: 0 }}>Digital ID Records Viewer</h3>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
      >
        <thead>
          <tr
            style={{
              textAlign: "left",
              borderBottom: "1px solid rgba(180,225,244,0.2)",
            }}
          >
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Blockchain ID</th>
            <th style={thStyle}>Trip Itinerary</th>
            <th style={thStyle}>Emergency Contacts</th>
            <th style={thStyle}>Validity</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr
              key={r.blockchainId}
              style={{ borderBottom: "1px solid rgba(180,225,244,0.1)" }}
            >
              <td style={tdStyle}>{displayOrDash(r.name)}</td>
              <td style={tdStyle}>{displayOrDash(r.blockchainId)}</td>
              <td style={tdStyle}>{displayOrDash(r.itinerary)}</td>
              <td style={tdStyle}>{displayOrDash(r.emergencyContacts)}</td>
              <td style={tdStyle}>
                {r.validFrom || r.validTill
                  ? `${formatDateTime(r.validFrom)} → ${formatDateTime(r.validTill)}`
                  : "--"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {records.length === 0 ? (
        <EmptyNote text="No ID records available." />
      ) : null}
    </section>
  );
}

function AlertsTable({ alerts }) {
  return (
    <section
      className="glass-card"
      style={{ padding: "1rem", overflow: "auto" }}
    >
      <h3 style={{ marginTop: 0 }}>Alert & Zone Breach Logs</h3>
      <table
        style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
      >
        <thead>
          <tr
            style={{
              textAlign: "left",
              borderBottom: "1px solid rgba(180,225,244,0.2)",
            }}
          >
            <th style={thStyle}>Tourist</th>
            <th style={thStyle}>ID</th>
            <th style={thStyle}>Timestamp</th>
            <th style={thStyle}>Zone</th>
            <th style={thStyle}>Risk</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => {
            const risk = normalizeRisk(a.riskLevel);
            return (
              <tr
                key={a.id}
                style={{ borderBottom: "1px solid rgba(180,225,244,0.1)" }}
              >
                <td style={tdStyle}>{displayOrDash(a.userName)}</td>
                <td style={tdStyle}>{displayOrDash(a.blockchainId)}</td>
                <td style={tdStyle}>{formatDateTime(a.timestamp)}</td>
                <td style={tdStyle}>{displayOrDash(a.zoneName)}</td>
                <td style={tdStyle}>
                  <span style={riskPillStyle(risk)}>{risk.toUpperCase()}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {alerts.length === 0 ? (
        <EmptyNote text="No breach alerts available." />
      ) : null}
    </section>
  );
}

function FirPanel({ tourists, firs, onCreated }) {
  const [form, setForm] = useState({
    touristId: "",
    lastSeenLocation: "",
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  async function submitFir(e) {
    e.preventDefault();
    if (submitting) return;

    const token = localStorage.getItem("token");
    const selected = tourists.find((t) => t.blockchainId === form.touristId);

    setSubmitting(true);
    setNotice("");

    try {
      const res = await fetch(`${API_URL}/admin/fir`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          touristId: form.touristId,
          touristName: selected?.name || selected?.username || "",
          lastSeenLocation: form.lastSeenLocation,
          description: form.description,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setNotice(data.error || "Unable to generate E-FIR.");
        return;
      }

      setNotice("E-FIR generated successfully.");
      setForm({ touristId: "", lastSeenLocation: "", description: "" });
      onCreated?.();
    } catch {
      setNotice("Network error while generating E-FIR.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gap: "1rem",
        gridTemplateColumns: "minmax(300px, 1fr) minmax(300px, 1fr)",
      }}
    >
      <section className="glass-card" style={{ padding: "1rem" }}>
        <h3 style={{ marginTop: 0 }}>Automated E-FIR Generator (Prototype)</h3>
        <form onSubmit={submitFir} style={{ display: "grid", gap: "0.9rem" }}>
          <label style={labelStyle}>
            Select Tourist Name / ID
            <select
              required
              value={form.touristId}
              onChange={(e) =>
                setForm((p) => ({ ...p, touristId: e.target.value }))
              }
              style={inputStyle}
            >
              <option value="">Choose tourist...</option>
              {tourists.map((t) => (
                <option key={t.blockchainId} value={t.blockchainId}>
                  {t.name || t.username} ({t.blockchainId})
                </option>
              ))}
            </select>
          </label>

          <label style={labelStyle}>
            Last Seen Location
            <input
              required
              value={form.lastSeenLocation}
              onChange={(e) =>
                setForm((p) => ({ ...p, lastSeenLocation: e.target.value }))
              }
              placeholder="Example: Main market, Gadchiroli"
              style={inputStyle}
            />
          </label>

          <label style={labelStyle}>
            Description / Comments
            <textarea
              required
              rows={4}
              value={form.description}
              onChange={(e) =>
                setForm((p) => ({ ...p, description: e.target.value }))
              }
              placeholder="Add missing report details..."
              style={{ ...inputStyle, resize: "vertical", minHeight: 110 }}
            />
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="pill-btn"
            style={{ padding: "0.75rem 1rem", borderRadius: 10 }}
          >
            {submitting ? "Generating..." : "Generate E-FIR"}
          </button>
        </form>
        {notice ? (
          <p style={{ marginTop: 10, color: "#cce9f7", fontSize: 13 }}>
            {notice}
          </p>
        ) : null}
      </section>

      <section
        className="glass-card"
        style={{ padding: "1rem", overflow: "auto" }}
      >
        <h3 style={{ marginTop: 0 }}>Recent E-FIR Records</h3>
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {firs
            .slice()
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .map((f) => (
              <article
                key={f.id}
                style={{
                  border: "1px solid rgba(190,229,244,0.24)",
                  borderRadius: 12,
                  padding: "0.75rem",
                  background: "rgba(16, 25, 36, 0.45)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    alignItems: "center",
                  }}
                >
                  <strong>{f.touristName || "Unknown Tourist"}</strong>
                  <button
                    onClick={() => downloadFirEntry(f)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "#9fe9ff",
                      cursor: "pointer",
                      textDecoration: "underline",
                      fontSize: 12,
                    }}
                  >
                    Download log
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "#9eb7c5", marginTop: 2 }}>
                  {f.id}
                </div>
                <div style={{ marginTop: 8, fontSize: 13 }}>
                  <div>
                    <strong>Last seen:</strong> {f.lastSeenLocation}
                  </div>
                  <div style={{ marginTop: 4 }}>{f.description}</div>
                  <div style={{ marginTop: 6, color: "#9db4c2", fontSize: 12 }}>
                    {formatDateTime(f.timestamp)}
                  </div>
                </div>
              </article>
            ))}
        </div>
        {firs.length === 0 ? (
          <EmptyNote text="No E-FIR records generated yet." />
        ) : null}
      </section>
    </div>
  );
}

function buildClusters(items) {
  const buckets = new Map();

  items.forEach(({ loc }) => {
    const key = `${roundTo(loc.lat, 2)}_${roundTo(loc.lng, 2)}`;
    const risk = riskWeight(normalizeRisk(loc.riskLevel));

    const curr = buckets.get(key) || {
      latSum: 0,
      lngSum: 0,
      count: 0,
      riskSum: 0,
    };

    curr.latSum += loc.lat;
    curr.lngSum += loc.lng;
    curr.count += 1;
    curr.riskSum += risk;
    buckets.set(key, curr);
  });

  return Array.from(buckets.values()).map((entry) => ({
    lat: entry.latSum / entry.count,
    lng: entry.lngSum / entry.count,
    count: entry.count,
    avgRisk: entry.riskSum / entry.count,
  }));
}

function getLocation(tourist) {
  const candidate =
    tourist?.currentLocation ||
    tourist?.lastHeartbeat ||
    tourist?.lastKnownLocation ||
    null;

  if (!candidate) return null;
  const lat = Number(candidate.lat);
  const lng = Number(candidate.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    lat,
    lng,
    zoneName: candidate.zoneName || tourist.zoneName || "Unknown",
    riskLevel: candidate.riskLevel || tourist.riskZoneStatus || "safe",
    timestamp: Number(candidate.timestamp || Date.now()),
  };
}

function normalizeRisk(value) {
  const risk = String(value || "").toLowerCase();
  if (risk === "danger" || risk === "moderate" || risk === "safe") return risk;
  if (risk === "high" || risk === "restricted" || risk === "high_crime")
    return "danger";
  if (risk === "medium" || risk === "warning" || risk === "time_based")
    return "moderate";
  return "safe";
}

function riskColor(risk) {
  if (risk === "danger") return "#ef4444";
  if (risk === "moderate") return "#f97316";
  return "#22c55e";
}

function riskWeight(risk) {
  if (risk === "danger") return 2;
  if (risk === "moderate") return 1;
  return 0.3;
}

function riskPillStyle(risk) {
  const color = riskColor(risk);
  return {
    background: `${color}22`,
    color,
    border: `1px solid ${color}55`,
    fontWeight: 700,
    fontSize: 12,
    borderRadius: 999,
    padding: "2px 10px",
    display: "inline-block",
  };
}

function downloadFirEntry(fir) {
  const content = [
    "TOURISM SAFETY SYSTEM - E-FIR REPORT",
    "------------------------------------",
    `FIR ID: ${fir.id || "N/A"}`,
    `Tourist: ${fir.touristName || "N/A"}`,
    `Tourist ID: ${fir.touristId || "N/A"}`,
    `Last Seen Location: ${fir.lastSeenLocation || "N/A"}`,
    `Description: ${fir.description || "N/A"}`,
    `Status: ${fir.status || "Reported"}`,
    `Created At: ${formatDateTime(fir.timestamp)}`,
  ].join("\n");

  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fir.id || "e-fir-report"}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function titleFor(key) {
  if (key === "tourists") return "Tourist Live Monitoring";
  if (key === "heatmap") return "Interactive Heat Map & Cluster View";
  if (key === "records") return "Digital ID Records Viewer";
  if (key === "alerts") return "Alert & Zone Breach Logs";
  return "Automated E-FIR Generator";
}

function searchPlaceholder(key) {
  if (key === "alerts") return "Search name, ID, zone...";
  if (key === "records") return "Search records by name or ID...";
  return "Search by name or blockchain ID...";
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString();
}

function fixed(n) {
  return Number(n).toFixed(5);
}

function displayOrDash(value) {
  if (value === null || value === undefined) return "--";
  const text = String(value).trim();
  return text ? text : "--";
}

function roundTo(n, decimals) {
  const p = 10 ** decimals;
  return Math.round(Number(n) * p) / p;
}

function iconButtonStyle() {
  return {
    border: "1px solid rgba(167, 224, 248, 0.35)",
    background: "rgba(255, 255, 255, 0.1)",
    color: "#d8f1ff",
    borderRadius: 8,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.52rem 0.62rem",
  };
}

function EmptyNote({ text }) {
  return (
    <div style={{ marginTop: 10, fontSize: 13, color: "#9fc0d3" }}>{text}</div>
  );
}

const thStyle = { padding: "0.6rem 0.45rem", fontSize: 12, color: "#9dc0d3" };
const tdStyle = { padding: "0.65rem 0.45rem", verticalAlign: "top" };
const labelStyle = { display: "grid", gap: 6, fontSize: 13, color: "#cce6f3" };
const inputStyle = {
  border: "1px solid rgba(180,226,244,0.28)",
  borderRadius: 10,
  padding: "0.65rem 0.75rem",
  background: "rgba(8, 16, 26, 0.55)",
  color: "#eaf9ff",
};
