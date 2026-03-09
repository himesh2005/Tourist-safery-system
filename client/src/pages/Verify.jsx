import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { API_URL } from "../config/env.js";

const BASE_API_URL = String(API_URL || "http://localhost:5000").replace(
  /\/+$/,
  "",
);

export default function Verify() {
  const { id } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [profile, setProfile] = useState(null);
  const [proof, setProof] = useState(null);

  useEffect(() => {
    const controller = new AbortController();

    async function run() {
      if (!id) {
        setError("Missing verification ID in URL.");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError("");
      setProfile(null);
      setProof(null);

      try {
        const res = await fetch(
          `${BASE_API_URL}/api/verify/${encodeURIComponent(id)}`,
          { signal: controller.signal },
        );

        const data = await res.json();

        if (!res.ok) {
          setError(data?.error || "Verification failed.");
          setLoading(false);
          return;
        }

        setProfile(data?.profile || null);
        setProof(data?.proof || null);
      } catch (err) {
        if (err?.name !== "AbortError") {
          setError("Unable to reach server. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    }

    run();
    return () => controller.abort();
  }, [id]);

  const status = useMemo(() => {
    if (!proof) return "Unknown";
    return proof.match ? "VALID ✅" : "NOT MATCHING ⚠️";
  }, [proof]);

  return (
    <div className="page-container" style={{ maxWidth: 860, margin: "0 auto" }}>
      <div className="glass-card panel" style={{ marginTop: 24 }}>
        <h2 className="panel-title">Card Verification</h2>
        <p className="geo-meta">
          Blockchain ID: <strong>{id || "N/A"}</strong>
        </p>

        {loading && <p>Loading verification data...</p>}

        {!loading && error && (
          <div className="risk-item" style={{ borderColor: "#ff7b7b" }}>
            <h4>Error</h4>
            <p>{error}</p>
          </div>
        )}

        {!loading && !error && profile && (
          <>
            <div className="risk-item">
              <h4>Status</h4>
              <p>{status}</p>
            </div>

            <div className="risk-item">
              <h4>Name</h4>
              <p>{profile.name || "N/A"}</p>
            </div>

            <div className="risk-item">
              <h4>Blood Group</h4>
              <p>{profile.bloodGroup || "N/A"}</p>
            </div>

            <div className="risk-item">
              <h4>Allergies</h4>
              <p>{profile.allergies || "None"}</p>
            </div>

            <div className="risk-item">
              <h4>Emergency Contacts</h4>
              <p>{profile.emergencyContacts || "N/A"}</p>
            </div>

            <div className="risk-item">
              <h4>Address</h4>
              <p>{profile.address || "N/A"}</p>
            </div>

            {proof && (
              <div className="risk-item">
                <h4>Proof</h4>
                <p style={{ wordBreak: "break-all" }}>
                  <strong>Local Hash:</strong> {proof.localHash || "N/A"}
                  <br />
                  <strong>On-chain Hash:</strong> {proof.onChainHash || "N/A"}
                  <br />
                  <strong>On-chain Available:</strong>{" "}
                  {proof.onChainAvailable ? "Yes" : "No"}
                  <br />
                  {!proof.onChainAvailable && proof.onChainError ? (
                    <>
                      <strong>Chain Error:</strong> {proof.onChainError}
                    </>
                  ) : null}
                </p>
              </div>
            )}
          </>
        )}

        <div style={{ marginTop: 16 }}>
          <Link to="/auth">Back to Login</Link>
        </div>
      </div>
    </div>
  );
}
