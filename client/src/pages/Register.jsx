import { useEffect, useMemo, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { FiEye, FiEyeOff } from "react-icons/fi";
import { API_URL } from "../config/env.js";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const usernameRegex = /^[A-Za-z0-9]{4,}$/;
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
const mobileRegex = /^\d{10}$/;
const MotionForm = motion.form;
const MotionButton = motion.button;
const MotionP = motion.p;
const MotionSmall = motion.small;

export default function Register() {
  const nav = useNavigate();
  const [form, setForm] = useState({
    username: "",
    password: "",
    name: "",
    mobile: "",
    bloodGroup: "",
    allergies: "",
    emergencyContacts: "",
    address: "",
  });
  const [errors, setErrors] = useState({});
  const [msg, setMsg] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [usernameAvailable, setUsernameAvailable] = useState(null);
  const [checkingUsername, setCheckingUsername] = useState(false);

  function set(k, v) {
    setForm((p) => ({ ...p, [k]: v }));
  }

  useEffect(() => {
    const username = form.username.trim();
    if (!usernameRegex.test(username)) {
      setUsernameAvailable(null);
      setCheckingUsername(false);
      return undefined;
    }

    const timer = setTimeout(async () => {
      try {
        setCheckingUsername(true);
        const res = await fetch(`${API_URL}/api/check-username`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username }),
        });
        const data = await res.json();
        setUsernameAvailable(Boolean(data.available));
      } catch {
        setUsernameAvailable(null);
      } finally {
        setCheckingUsername(false);
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [form.username]);

  const computedErrors = useMemo(() => {
    const next = {};
    const username = form.username.trim();
    const address = form.address.trim();
    const contacts = String(form.emergencyContacts || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    if (!usernameRegex.test(username)) {
      next.username =
        "Username must be alphanumeric, no spaces, minimum 4 characters.";
    } else if (usernameAvailable === false) {
      next.username = "Username already exists.";
    }

    if (!passwordRegex.test(form.password)) {
      next.password =
        "Password needs 8+ chars with uppercase, lowercase, number, and special character.";
    }

    if (!mobileRegex.test(form.mobile)) {
      next.mobile = "Mobile number must be exactly 10 digits.";
    }

    if (!BLOOD_GROUPS.includes(form.bloodGroup)) {
      next.bloodGroup = "Select a valid blood group.";
    }

    if (contacts.length === 0 || contacts.some((c) => !mobileRegex.test(c))) {
      next.emergencyContacts =
        "Enter comma-separated 10-digit emergency contact numbers.";
    }

    if (address.length < 10) {
      next.address = "Address must be at least 10 characters.";
    }

    if (!form.name.trim()) next.name = "Name is required.";

    return next;
  }, [form, usernameAvailable]);

  useEffect(() => {
    setErrors(computedErrors);
  }, [computedErrors]);

  async function submit(e) {
    e.preventDefault();
    if (isSubmitting) return;
    if (Object.keys(computedErrors).length > 0) {
      setMsg("Please fix validation errors before submitting.");
      return;
    }

    setIsSubmitting(true);
    setMsg("Creating account...");

    try {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok) {
        const serverDetails = [
          data?.error,
          data?.details,
          data?.chainWriteError,
        ]
          .filter(Boolean)
          .join(" | ");

        setMsg(
          serverDetails
            ? `Register failed: ${serverDetails}`
            : "Register failed. Please try again.",
        );
        setIsSubmitting(false);
        return;
      }

      if (data?.chainWriteStatus === "failed") {
        setMsg(
          "Account created, but blockchain sync is pending. Redirecting...",
        );
      } else {
        setMsg("Account created - Redirecting to login...");
      }
      setTimeout(() => nav("/auth"), 1200);
    } catch {
      setMsg("Network error. Please try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-screen page-container">
      <MotionForm
        onSubmit={submit}
        className="glass-card auth-card"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        <h2 className="auth-title">Create Account</h2>
        <p className="auth-subtitle">
          Register once to get your blockchain safety card.
        </p>

        <div className="auth-form">
          <Field
            label="Username"
            value={form.username}
            onChange={(v) => set("username", v)}
            error={errors.username}
            helper={
              checkingUsername
                ? "Checking availability..."
                : usernameAvailable === true
                  ? "Username available."
                  : "Minimum 4 alphanumeric characters."
            }
          />

          <Field
            label="Password"
            value={form.password}
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            onChange={(v) => set("password", v)}
            error={errors.password}
            helper="Use upper/lowercase, number and one special character."
            toggle={
              <button
                type="button"
                className="field-toggle"
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? <FiEyeOff /> : <FiEye />}
              </button>
            }
          />

          <Field
            label="Full Name"
            value={form.name}
            onChange={(v) => set("name", v)}
            error={errors.name}
          />
          <Field
            label="Mobile Number"
            value={form.mobile}
            onChange={(v) =>
              set("mobile", v.replace(/[^\d]/g, "").slice(0, 10))
            }
            error={errors.mobile}
            helper="10 digits only."
          />

          <div className="field-wrap">
            <select
              className="field select-field"
              value={form.bloodGroup}
              onChange={(e) => set("bloodGroup", e.target.value)}
            >
              <option value="">Select blood group</option>
              {BLOOD_GROUPS.map((bg) => (
                <option key={bg} value={bg}>
                  {bg}
                </option>
              ))}
            </select>
            <label className="field-label floating-label-active">
              Blood Group
            </label>
            <FieldError text={errors.bloodGroup} />
          </div>

          <Field
            label="Allergies (Optional)"
            value={form.allergies}
            onChange={(v) => set("allergies", v)}
          />
          <Field
            label="Emergency Contacts"
            value={form.emergencyContacts}
            onChange={(v) => set("emergencyContacts", v)}
            error={errors.emergencyContacts}
            helper="Comma separated 10-digit numbers."
          />
          <Field
            label="Address"
            value={form.address}
            onChange={(v) => set("address", v)}
            error={errors.address}
            helper="Minimum 10 characters."
          />
        </div>

        <div className="auth-actions">
          <MotionButton
            whileHover={{ scale: 1.02 }}
            type="submit"
            className="pill-btn"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Creating..." : "Create Account"}
          </MotionButton>
          <Link to="/auth">Back to login</Link>
        </div>

        <AnimatePresence mode="wait">
          <MotionP
            key={msg}
            className="auth-msg"
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
          >
            {msg}
          </MotionP>
        </AnimatePresence>
      </MotionForm>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  error,
  helper,
  toggle,
}) {
  return (
    <div className="field-wrap">
      <input
        className="field"
        placeholder=" "
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        autoComplete={autoComplete}
      />
      <label className="field-label">{label}</label>
      {toggle || null}
      {helper ? <small className="field-help">{helper}</small> : null}
      <FieldError text={error} />
    </div>
  );
}

function FieldError({ text }) {
  return (
    <AnimatePresence>
      {text ? (
        <MotionSmall
          className="field-error"
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
        >
          {text}
        </MotionSmall>
      ) : null}
    </AnimatePresence>
  );
}
