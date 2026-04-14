import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { FiEye, FiEyeOff } from "react-icons/fi";
import { API_URL } from "../config/env.js";

const MotionForm = motion.form;
const MotionButton = motion.button;
const MotionP = motion.p;
const MotionSmall = motion.small;

const usernameRegex = /^[A-Za-z0-9]{4,}$/;
const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;
const mobileRegex = /^\d{10}$/;

function toUnixTimestamp(dateValue) {
  const epochMs = new Date(dateValue).getTime();
  if (!Number.isFinite(epochMs)) return null;
  return Math.floor(epochMs / 1000);
}

export default function Register() {
  const [form, setForm] = useState({
    username: "",
    password: "",
    aadhaarOrPassport: "",
    itinerary: "",
    emergencyContact: "",
    validUntilDate: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [msg, setMsg] = useState("");
  const [issuedId, setIssuedId] = useState(null);

  function setField(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const errors = useMemo(() => {
    const next = {};

    if (!usernameRegex.test(form.username.trim())) {
      next.username =
        "Username must be alphanumeric, no spaces, minimum 4 characters.";
    }
    if (!passwordRegex.test(form.password)) {
      next.password =
        "Password needs 8+ chars with uppercase, lowercase, number, and special character.";
    }
    if (!form.aadhaarOrPassport.trim()) {
      next.aadhaarOrPassport = "Aadhaar or Passport is required.";
    }
    if (!form.itinerary.trim()) {
      next.itinerary = "Trip itinerary is required.";
    }
    if (!mobileRegex.test(form.emergencyContact.trim())) {
      next.emergencyContact = "Emergency contact must be a 10-digit number.";
    }

    const unix = toUnixTimestamp(form.validUntilDate);
    if (!unix) {
      next.validUntilDate = "Select a valid end date.";
    } else if (unix <= Math.floor(Date.now() / 1000)) {
      next.validUntilDate = "Validity must be in the future.";
    }

    return next;
  }, [form]);

  async function submit(e) {
    e.preventDefault();
    if (isSubmitting) return;
    if (Object.keys(errors).length > 0) {
      setMsg("Please fix validation errors before submitting.");
      return;
    }

    const validUntil = toUnixTimestamp(form.validUntilDate);
    if (!validUntil) {
      setMsg("Invalid validity date.");
      return;
    }

    setIsSubmitting(true);
    setMsg("Issuing blockchain tourist ID...");
    setIssuedId(null);

    try {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: form.username.trim(),
          password: form.password,
          aadhaarOrPassport: form.aadhaarOrPassport.trim(),
          itinerary: form.itinerary.trim(),
          emergencyContact: form.emergencyContact.trim(),
          validUntil,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        const reason = [data?.error, data?.details, data?.chainWriteError]
          .filter(Boolean)
          .join(" | ");
        setMsg(reason || "Registration failed.");
        setIsSubmitting(false);
        return;
      }

      setIssuedId({
        blockchainId: data.blockchainId,
        kyc: data.kyc,
        itinerary: data.itinerary,
        emergencyContact: data.emergencyContact,
        validUntil: data.validUntil,
      });
      setMsg("Digital tourist ID issued successfully.");
    } catch {
      setMsg("Network error. Please try again.");
    } finally {
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
          Register to issue your blockchain-based tourist ID.
        </p>

        <div className="auth-form">
          <Field
            label="Username"
            value={form.username}
            onChange={(v) => setField("username", v)}
            error={errors.username}
          />

          <Field
            label="Password"
            value={form.password}
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            onChange={(v) => setField("password", v)}
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
            label="Aadhaar / Passport"
            value={form.aadhaarOrPassport}
            onChange={(v) => setField("aadhaarOrPassport", v)}
            error={errors.aadhaarOrPassport}
          />

          <Field
            label="Trip Itinerary"
            value={form.itinerary}
            onChange={(v) => setField("itinerary", v)}
            error={errors.itinerary}
            helper="Example: Nagpur -> Gadchiroli -> Hemalkasa (5 days)"
          />

          <Field
            label="Emergency Contact"
            value={form.emergencyContact}
            onChange={(v) =>
              setField("emergencyContact", v.replace(/[^\d]/g, "").slice(0, 10))
            }
            error={errors.emergencyContact}
            helper="10 digits only."
          />

          <div className="field-wrap">
            <input
              className="field"
              type="date"
              value={form.validUntilDate}
              onChange={(e) => setField("validUntilDate", e.target.value)}
            />
            <label className="field-label floating-label-active">
              Valid Until
            </label>
            <FieldError text={errors.validUntilDate} />
          </div>
        </div>

        <div className="auth-actions">
          <MotionButton
            whileHover={{ scale: 1.02 }}
            type="submit"
            className="pill-btn"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Issuing..." : "Issue Tourist ID"}
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

        {issuedId ? (
          <div className="risk-item" style={{ marginTop: 14 }}>
            <h4>Digital Tourist ID</h4>
            <p>
              <strong>Blockchain Tourist ID:</strong> {issuedId.blockchainId}
            </p>
            <p>
              <strong>KYC (masked):</strong> {issuedId.kyc}
            </p>
            <p>
              <strong>Trip itinerary:</strong> {issuedId.itinerary}
            </p>
            <p>
              <strong>Emergency contact:</strong> {issuedId.emergencyContact}
            </p>
            <p>
              <strong>Valid until:</strong>{" "}
              {new Date(Number(issuedId.validUntil) * 1000).toLocaleString()}
            </p>
          </div>
        ) : null}
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
