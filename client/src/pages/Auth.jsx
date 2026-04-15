import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";

import { FiEye, FiEyeOff } from "react-icons/fi";
import { API_URL } from "../config/env.js";

export default function Auth() {
  const nav = useNavigate();
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [msg, setMsg] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  async function login(e) {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMsg("Logging in...");

    try {
      const endpoint = isAdmin
        ? `${API_URL}/admin/login`
        : `${API_URL}/auth/login`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const n = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const data = await n.json();
      if (!n.ok) {
        setMsg(data.error || "Login failed");
        setIsSubmitting(false);
        return;
      }

      localStorage.setItem("token", data.token);
      if (isAdmin) {
        localStorage.setItem("adminUser", data.username);
        setMsg("Admin Success - Redirecting...");
        nav("/admin-dashboard");
        return;
      }
      localStorage.setItem("blockchainId", data.blockchainId);
      const profileRes = await fetch(`${API_URL}/me`, {
        headers: { Authorization: `Bearer ${data.token}` },
      });
      if (profileRes.ok) {
        const profile = await profileRes.json();
        localStorage.setItem(
          "userProfile",
          JSON.stringify({
            id: profile.id,
            username: profile.username || username,
            name: profile.name || username,
            phone: profile.phone || profile.emergencyContact || "",
            emergencyContact: profile.emergencyContact || "",
            blockchainId: profile.blockchainId,
            kyc: profile.kyc || profile.profile?.kyc || "",
            itinerary: profile.itinerary || profile.profile?.itinerary || "",
            validUntil:
              profile.validUntil || profile.profile?.validUntil || null,
            profile: profile.profile || null,
          }),
        );
      }
      setMsg("Success - Redirecting...");
      nav("/dashboard");
    } catch {
      setMsg("Network error. Please try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-screen page-container">
      <form onSubmit={login} className="glass-card auth-card">
        <div
          className="auth-mode-tabs"
          style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}
        >
          <button
            type="button"
            onClick={() => setIsAdmin(false)}
            className={`tab-btn ${!isAdmin ? "active" : ""}`}
            style={{
              background: !isAdmin ? "rgba(25, 118, 210, 0.1)" : "transparent",
              border: "none",
              padding: "0.5rem 1rem",
              borderRadius: "8px",
              color: !isAdmin ? "#1976D2" : "#666",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            User Login
          </button>
          <button
            type="button"
            onClick={() => setIsAdmin(true)}
            className={`tab-btn ${isAdmin ? "active" : ""}`}
            style={{
              background: isAdmin ? "rgba(25, 118, 210, 0.1)" : "transparent",
              border: "none",
              padding: "0.5rem 1rem",
              borderRadius: "8px",
              color: isAdmin ? "#1976D2" : "#666",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            Admin Login
          </button>
        </div>
        <h2 className="auth-title">
          {isAdmin ? "Admin Dashboard" : "Tourist Safety System"}
        </h2>
        <p className="auth-subtitle">
          {isAdmin
            ? "Authorized access only."
            : "Sign in to access your live geofence dashboard."}
        </p>

        <div className="auth-form">
          <div className="field-wrap">
            <input
              className="field"
              placeholder=" "
              value={username}
              onChange={(e) => setU(e.target.value)}
              autoComplete="username"
            />
            <label className="field-label">Username</label>
            <small className="field-help">Use your registered username.</small>
          </div>

          <div className="field-wrap">
            <input
              className="field"
              placeholder=" "
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setP(e.target.value)}
              autoComplete="current-password"
            />
            <label className="field-label">Password</label>
            <button
              type="button"
              className="field-toggle"
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? <FiEyeOff /> : <FiEye />}
            </button>
            <small className="field-help">
              Never share your password with anyone.
            </small>
          </div>
        </div>

        <div className="auth-actions">
          <button type="submit" className="pill-btn" disabled={isSubmitting}>
            {isSubmitting ? "Signing in..." : "Login"}
          </button>
          <Link to="/register">Create account</Link>
        </div>

        <p className="auth-msg">{msg}</p>
      </form>
    </div>
  );
}
