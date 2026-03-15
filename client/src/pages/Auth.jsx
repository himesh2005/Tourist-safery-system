import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { FiEye, FiEyeOff } from "react-icons/fi";
import { API_URL } from "../config/env.js";

export default function Auth() {
  const nav = useNavigate();
  const [username, setU] = useState("");
  const [password, setP] = useState("");
  const [msg, setMsg] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function login(e) {
    e.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setMsg("Logging in...");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      const n = await fetch(`${API_URL}/auth/login`, {
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
      localStorage.setItem("blockchainId", data.blockchainId);
      if (data.profile) {
        localStorage.setItem(
          "userProfile",
          JSON.stringify({
            id: data.blockchainId,
            blockchainId: data.blockchainId,
            name: data.profile.name || username,
            phone: data.profile.mobile || "",
            mobile: data.profile.mobile || "",
            emergencyContact: data.profile.emergencyContacts || "",
            emergencyContacts: data.profile.emergencyContacts || "",
            address: data.profile.address || "",
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
      <motion.form
        onSubmit={login}
        className="glass-card auth-card"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        <h2 className="auth-title">Tourist Safety System</h2>
        <p className="auth-subtitle">
          Sign in to access your live geofence dashboard.
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
          <motion.button
            whileHover={{ scale: 1.02 }}
            type="submit"
            className="pill-btn"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Signing in..." : "Login"}
          </motion.button>
          <Link to="/register">Create account</Link>
        </div>

        <AnimatePresence mode="wait">
          <motion.p
            key={msg}
            className="auth-msg"
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
          >
            {msg}
          </motion.p>
        </AnimatePresence>
      </motion.form>
    </div>
  );
}
