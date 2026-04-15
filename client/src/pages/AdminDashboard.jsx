import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  FiUsers,
  FiMap,
  FiAlertTriangle,
  FiFileText,
  FiRefreshCw,
  FiSearch,
  FiLogOut,
} from "react-icons/fi";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { API_URL } from "../config/env.js";

// Leaflet heatmap plugin might need careful inclusion.
// For simplicity, if leaflet.heatmap is not available via npm, we can use a CDN or just standard circles.
// But the requirement asks for "Heat Map & Cluster View".

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState("tourists");
  const [tourists, setTourists] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [firs, setFirs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const nav = useNavigate();

  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const touristLayerRef = useRef(L.layerGroup());
  const heatLayerRef = useRef(null);
  const zonesLayerRef = useRef(L.layerGroup());

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      nav("/auth");
      return;
    }
    fetchData();
    const interval = setInterval(fetchData, 10000); // Auto-refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const fetchData = async () => {
    const token = localStorage.getItem("token");
    try {
      const [tRes, aRes, fRes, zRes] = await Promise.all([
        fetch(`${API_URL}/admin/tourists`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/admin/alerts`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/admin/firs`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${API_URL}/api/zones?city=gadchiroli`),
      ]);

      if (tRes.ok) setTourists(await tRes.json());
      if (aRes.ok) setAlerts(await aRes.json());
      if (fRes.ok) setFirs(await fRes.json());
      if (zRes.ok) {
        const zonesData = await zRes.json();
        renderZones(zonesData);
      }
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch admin data", err);
    }
  };

  const renderZones = (zones) => {
    if (!mapRef.current) return;
    zonesLayerRef.current.clearLayers();
    zones.forEach((zone) => {
      const color =
        zone.riskLevel === "danger"
          ? "#dc2626"
          : zone.riskLevel === "moderate"
            ? "#f97316"
            : "#16a34a";
      L.polygon(zone.coordinates, {
        color,
        fillColor: color,
        fillOpacity: 0.2,
        weight: 1,
      }).addTo(zonesLayerRef.current);
    });
  };

  useEffect(() => {
    if (
      (activeTab === "heatmap" || activeTab === "tourists") &&
      !mapRef.current &&
      mapContainerRef.current
    ) {
      mapRef.current = L.map(mapContainerRef.current).setView(
        [20.1849, 80.003],
        10,
      );
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(
        mapRef.current,
      );
      zonesLayerRef.current.addTo(mapRef.current);
      touristLayerRef.current.addTo(mapRef.current);
    }

    // Resize map when tab changes
    if (mapRef.current) {
      setTimeout(() => mapRef.current.invalidateSize(), 100);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!mapRef.current) return;

    touristLayerRef.current.clearLayers();

    tourists.forEach((t) => {
      const loc = t.lastHeartbeat || t.lastKnownLocation;
      if (loc && loc.lat && loc.lng) {
        if (activeTab === "tourists") {
          const icon = L.divIcon({
            className: "tourist-marker",
            html: `<div style="background: ${loc.riskLevel === "danger" ? "#dc2626" : loc.riskLevel === "moderate" ? "#f97316" : "#16a34a"}; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 8px rgba(0,0,0,0.3);"></div>`,
            iconSize: [12, 12],
          });

          L.marker([loc.lat, loc.lng], { icon })
            .bindPopup(
              `<strong>${t.name}</strong><br>Status: ${loc.riskLevel || "Safe"}<br>Zone: ${loc.zoneName || "Unknown"}`,
            )
            .addTo(touristLayerRef.current);
        } else if (activeTab === "heatmap") {
          // Heatmap fallback using overlapping circles
          L.circle([loc.lat, loc.lng], {
            radius: 2000,
            fillColor: "#ff4444",
            fillOpacity: 0.15,
            stroke: false,
            interactive: false,
          }).addTo(touristLayerRef.current);

          L.circle([loc.lat, loc.lng], {
            radius: 800,
            fillColor: "#ff0000",
            fillOpacity: 0.25,
            stroke: false,
            interactive: false,
          }).addTo(touristLayerRef.current);
        }
      }
    });
  }, [tourists, activeTab]);
  const filteredTourists = tourists.filter(
    (t) =>
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.blockchainId.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("adminUser");
    nav("/auth");
  };

  return (
    <div
      className="admin-dashboard-container"
      style={{
        display: "flex",
        height: "100vh",
        background: "#f8fafc",
        color: "#1e293b",
      }}
    >
      {/* Sidebar */}
      <div
        className="admin-sidebar"
        style={{
          width: "260px",
          background: "#ffffff",
          borderRight: "1px solid #e2e8f0",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{ padding: "2rem 1.5rem", borderBottom: "1px solid #f1f5f9" }}
        >
          <h2
            style={{ fontSize: "1.25rem", fontWeight: "700", color: "#0f172a" }}
          >
            Admin Panel
          </h2>
          <p style={{ fontSize: "0.875rem", color: "#64748b" }}>
            Tourism Safety System
          </p>
        </div>

        <nav style={{ flex: 1, padding: "1.5rem 1rem" }}>
          <SidebarLink
            icon={<FiUsers />}
            label="Tourists"
            active={activeTab === "tourists"}
            onClick={() => setActiveTab("tourists")}
          />
          <SidebarLink
            icon={<FiMap />}
            label="Heatmap"
            active={activeTab === "heatmap"}
            onClick={() => setActiveTab("heatmap")}
          />
          <SidebarLink
            icon={<FiAlertTriangle />}
            label="Alert Logs"
            active={activeTab === "alerts"}
            onClick={() => setActiveTab("alerts")}
          />
          <SidebarLink
            icon={<FiFileText />}
            label="E-FIR Portal"
            active={activeTab === "fir"}
            onClick={() => setActiveTab("fir")}
          />
        </nav>

        <div style={{ padding: "1rem", borderTop: "1px solid #f1f5f9" }}>
          <button
            onClick={logout}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              width: "100%",
              padding: "0.75rem",
              borderRadius: "8px",
              border: "none",
              background: "transparent",
              color: "#ef4444",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            <FiLogOut /> Logout
          </button>
        </div>
      </div>

      {/* Main Content */}
      <main style={{ flex: 1, overflowY: "auto", position: "relative" }}>
        <header
          style={{
            background: "#ffffff",
            padding: "1rem 2rem",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            borderBottom: "1px solid #e2e8f0",
            sticky: "top",
            zIndex: 10,
          }}
        >
          <h1 style={{ fontSize: "1.5rem", fontWeight: "600" }}>
            {activeTab === "tourists" && "Tourist Live Monitoring"}
            {activeTab === "heatmap" && "Risk Heatmap"}
            {activeTab === "alerts" && "Zone Breach Logs"}
            {activeTab === "fir" && "Automated E-FIR Generator"}
          </h1>
          <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              <FiSearch
                style={{
                  position: "absolute",
                  left: "12px",
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "#94a3b8",
                }}
              />
              <input
                type="text"
                placeholder="Search name or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  padding: "0.6rem 1rem 0.6rem 2.5rem",
                  borderRadius: "8px",
                  border: "1px solid #e2e8f0",
                  fontSize: "0.875rem",
                  width: "240px",
                }}
              />
            </div>
            <button
              onClick={fetchData}
              className="refresh-btn"
              style={{
                padding: "0.6rem",
                borderRadius: "8px",
                border: "1px solid #e2e8f0",
                background: "white",
                cursor: "pointer",
              }}
            >
              <FiRefreshCw />
            </button>
          </div>
        </header>

        <div style={{ padding: "2rem" }}>
          <AnimatePresence mode="wait">
            {activeTab === "tourists" && (
              <motion.div
                key="tourists"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "2rem",
                    height: "calc(100vh - 200px)",
                  }}
                >
                  <div
                    className="glass-card"
                    style={{
                      background: "white",
                      padding: "1.5rem",
                      borderRadius: "16px",
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                      overflowY: "auto",
                    }}
                  >
                    <table
                      style={{ width: "100%", borderCollapse: "collapse" }}
                    >
                      <thead>
                        <tr
                          style={{
                            textAlign: "left",
                            borderBottom: "1px solid #f1f5f9",
                          }}
                        >
                          <th
                            style={{ padding: "1rem 0.5rem", color: "#64748b" }}
                          >
                            Tourist
                          </th>
                          <th
                            style={{ padding: "1rem 0.5rem", color: "#64748b" }}
                          >
                            Status
                          </th>
                          <th
                            style={{ padding: "1rem 0.5rem", color: "#64748b" }}
                          >
                            Last Seen
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredTourists.map((t) => {
                          const loc = t.lastHeartbeat || t.lastKnownLocation;
                          return (
                            <tr
                              key={t.blockchainId}
                              style={{ borderBottom: "1px solid #f8fafc" }}
                            >
                              <td style={{ padding: "1rem 0.5rem" }}>
                                <div style={{ fontWeight: "600" }}>
                                  {t.name}
                                </div>
                                <div
                                  style={{
                                    fontSize: "0.75rem",
                                    color: "#94a3b8",
                                  }}
                                >
                                  {t.blockchainId}
                                </div>
                              </td>
                              <td style={{ padding: "1rem 0.5rem" }}>
                                <span
                                  style={{
                                    padding: "0.25rem 0.75rem",
                                    borderRadius: "99px",
                                    fontSize: "0.75rem",
                                    fontWeight: "600",
                                    background:
                                      loc?.riskLevel === "danger"
                                        ? "#fee2e2"
                                        : loc?.riskLevel === "moderate"
                                          ? "#ffedd5"
                                          : "#dcfce7",
                                    color:
                                      loc?.riskLevel === "danger"
                                        ? "#dc2626"
                                        : loc?.riskLevel === "moderate"
                                          ? "#ea580c"
                                          : "#16a34a",
                                  }}
                                >
                                  {loc?.riskLevel || "Safe"}
                                </span>
                              </td>
                              <td
                                style={{
                                  padding: "1rem 0.5rem",
                                  fontSize: "0.875rem",
                                }}
                              >
                                {loc
                                  ? new Date(loc.timestamp).toLocaleTimeString()
                                  : "N/A"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div
                    id="map"
                    ref={mapContainerRef}
                    style={{
                      borderRadius: "16px",
                      overflow: "hidden",
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                    }}
                  ></div>
                </div>
              </motion.div>
            )}

            {activeTab === "heatmap" && (
              <motion.div
                key="heatmap"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={{ height: "calc(100vh - 200px)" }}
              >
                <div
                  ref={mapContainerRef}
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: "16px",
                    overflow: "hidden",
                  }}
                ></div>
              </motion.div>
            )}

            {activeTab === "alerts" && (
              <motion.div
                key="alerts"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div
                  className="glass-card"
                  style={{
                    background: "white",
                    padding: "1.5rem",
                    borderRadius: "16px",
                    boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                  }}
                >
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr
                        style={{
                          textAlign: "left",
                          borderBottom: "1px solid #f1f5f9",
                        }}
                      >
                        <th
                          style={{ padding: "1rem 0.5rem", color: "#64748b" }}
                        >
                          Tourist
                        </th>
                        <th
                          style={{ padding: "1rem 0.5rem", color: "#64748b" }}
                        >
                          Zone
                        </th>
                        <th
                          style={{ padding: "1rem 0.5rem", color: "#64748b" }}
                        >
                          Risk
                        </th>
                        <th
                          style={{ padding: "1rem 0.5rem", color: "#64748b" }}
                        >
                          Time
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...alerts].reverse().map((a) => (
                        <tr
                          key={a.id}
                          style={{ borderBottom: "1px solid #f8fafc" }}
                        >
                          <td style={{ padding: "1rem 0.5rem" }}>
                            <div style={{ fontWeight: "600" }}>
                              {a.userName}
                            </div>
                            <div
                              style={{ fontSize: "0.75rem", color: "#94a3b8" }}
                            >
                              {a.blockchainId}
                            </div>
                          </td>
                          <td style={{ padding: "1rem 0.5rem" }}>
                            {a.zoneName}
                          </td>
                          <td style={{ padding: "1rem 0.5rem" }}>
                            <span
                              style={{
                                color:
                                  a.riskLevel === "danger"
                                    ? "#dc2626"
                                    : "#ea580c",
                                fontWeight: "600",
                              }}
                            >
                              {a.riskLevel.toUpperCase()}
                            </span>
                          </td>
                          <td
                            style={{
                              padding: "1rem 0.5rem",
                              fontSize: "0.875rem",
                            }}
                          >
                            {new Date(a.timestamp).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </motion.div>
            )}

            {activeTab === "fir" && (
              <motion.div
                key="fir"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: "2rem",
                  }}
                >
                  <div
                    className="glass-card"
                    style={{
                      background: "white",
                      padding: "2rem",
                      borderRadius: "16px",
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                    }}
                  >
                    <h3 style={{ marginBottom: "1.5rem" }}>
                      Generate New E-FIR
                    </h3>
                    <FirForm tourists={tourists} onRecordCreated={fetchData} />
                  </div>
                  <div
                    className="glass-card"
                    style={{
                      background: "white",
                      padding: "2rem",
                      borderRadius: "16px",
                      boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)",
                    }}
                  >
                    <h3 style={{ marginBottom: "1.5rem" }}>
                      Recent FIR Records
                    </h3>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "1rem",
                      }}
                    >
                      {firs.map((f) => (
                        <div
                          key={f.id}
                          style={{
                            padding: "1rem",
                            borderRadius: "8px",
                            border: "1px solid #e2e8f0",
                            background: "#f8fafc",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              marginBottom: "0.5rem",
                            }}
                          >
                            <strong>{f.touristName}</strong>
                            <div
                              style={{
                                display: "flex",
                                gap: "0.5rem",
                                alignItems: "center",
                              }}
                            >
                              <button
                                onClick={() => {
                                  const text = `E-FIR REPORT\nID: ${f.id}\nTourist: ${f.touristName} (${f.touristId})\nLast Seen: ${f.lastSeenLocation}\nDescription: ${f.description}\nTimestamp: ${new Date(f.timestamp).toLocaleString()}\nStatus: ${f.status}`;
                                  const element = document.createElement("a");
                                  const file = new Blob([text], {
                                    type: "text/plain",
                                  });
                                  element.href = URL.createObjectURL(file);
                                  element.download = `${f.id}.txt`;
                                  document.body.appendChild(element);
                                  element.click();
                                }}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: "#1d4ed8",
                                  cursor: "pointer",
                                  fontSize: "0.75rem",
                                  textDecoration: "underline",
                                }}
                              >
                                Download
                              </button>
                              <span
                                style={{
                                  fontSize: "0.75rem",
                                  color: "#64748b",
                                }}
                              >
                                {f.id}
                              </span>
                            </div>
                          </div>

                          <div
                            style={{ fontSize: "0.875rem", color: "#475569" }}
                          >
                            Last seen: {f.lastSeenLocation}
                          </div>
                          <div
                            style={{
                              fontSize: "0.875rem",
                              marginTop: "0.5rem",
                            }}
                          >
                            {f.description}
                          </div>
                          <div
                            style={{
                              fontSize: "0.75rem",
                              marginTop: "0.5rem",
                              color: "#94a3b8",
                            }}
                          >
                            {new Date(f.timestamp).toLocaleString()}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function SidebarLink({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        width: "100%",
        padding: "0.875rem 1rem",
        borderRadius: "12px",
        border: "none",
        background: active ? "#eff6ff" : "transparent",
        color: active ? "#1d4ed8" : "#64748b",
        fontWeight: active ? "600" : "500",
        cursor: "pointer",
        marginBottom: "0.5rem",
        transition: "all 0.2s",
      }}
    >
      <span style={{ fontSize: "1.1rem" }}>{icon}</span>
      {label}
    </button>
  );
}

function FirForm({ tourists, onRecordCreated }) {
  const [formData, setFormData] = useState({
    touristId: "",
    lastSeenLocation: "",
    description: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    const token = localStorage.getItem("token");
    const selectedTourist = tourists.find(
      (t) => t.blockchainId === formData.touristId,
    );

    try {
      const res = await fetch(`${API_URL}/admin/fir`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...formData,
          touristName: selectedTourist?.name || "Unknown",
        }),
      });
      if (res.ok) {
        setFormData({ touristId: "", lastSeenLocation: "", description: "" });
        onRecordCreated();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}
    >
      <div>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            fontWeight: "600",
            marginBottom: "0.5rem",
          }}
        >
          Select Tourist
        </label>
        <select
          required
          value={formData.touristId}
          onChange={(e) =>
            setFormData({ ...formData, touristId: e.target.value })
          }
          style={{
            width: "100%",
            padding: "0.75rem",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
          }}
        >
          <option value="">Choose a tourist...</option>
          {tourists.map((t) => (
            <option key={t.blockchainId} value={t.blockchainId}>
              {t.name} ({t.blockchainId})
            </option>
          ))}
        </select>
      </div>
      <div>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            fontWeight: "600",
            marginBottom: "0.5rem",
          }}
        >
          Last Seen Location
        </label>
        <input
          required
          type="text"
          value={formData.lastSeenLocation}
          onChange={(e) =>
            setFormData({ ...formData, lastSeenLocation: e.target.value })
          }
          placeholder="e.g. Bhamragad Forest Area"
          style={{
            width: "100%",
            padding: "0.75rem",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
          }}
        />
      </div>
      <div>
        <label
          style={{
            display: "block",
            fontSize: "0.875rem",
            fontWeight: "600",
            marginBottom: "0.5rem",
          }}
        >
          Description / Comments
        </label>
        <textarea
          required
          rows={4}
          value={formData.description}
          onChange={(e) =>
            setFormData({ ...formData, description: e.target.value })
          }
          placeholder="Enter details about the missing report..."
          style={{
            width: "100%",
            padding: "0.75rem",
            borderRadius: "8px",
            border: "1px solid #e2e8f0",
            resize: "none",
          }}
        />
      </div>
      <button
        type="submit"
        disabled={submitting}
        style={{
          padding: "0.875rem",
          borderRadius: "8px",
          border: "none",
          background: "#1d4ed8",
          color: "white",
          fontWeight: "600",
          cursor: submitting ? "not-allowed" : "pointer",
          marginTop: "1rem",
        }}
      >
        {submitting ? "Generating..." : "Generate E-FIR Report"}
      </button>
    </form>
  );
}
