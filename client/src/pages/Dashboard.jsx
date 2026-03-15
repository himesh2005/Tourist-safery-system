import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import GeofenceMap from "../components/GeofenceMap.jsx";
import { API_URL } from "../config/env.js";

const BASE_API_URL = String(API_URL || "http://localhost:5000").replace(
  /\/+$/,
  "",
);

export default function Dashboard() {
  const nav = useNavigate();
  const [me, setMe] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      nav("/auth");
      return;
    }

    fetch(`${BASE_API_URL}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => response.json())
      .then((payload) => {
        if (payload?.error) {
          nav("/auth");
          return;
        }
        localStorage.setItem(
          "userProfile",
          JSON.stringify({
            id: payload.blockchainId,
            blockchainId: payload.blockchainId,
            username: payload.username || "",
            name: payload.profile?.name || payload.username || "Traveler",
            phone: payload.profile?.mobile || "",
            mobile: payload.profile?.mobile || "",
            emergencyContact: payload.profile?.emergencyContacts || "",
            emergencyContacts: payload.profile?.emergencyContacts || "",
            address: payload.profile?.address || "",
          }),
        );
        setMe(payload);
      })
      .catch(() => nav("/auth"));
  }, [nav]);

  return (
    <GeofenceMap
      travelerName={me?.username || "Traveler"}
      blockchainId={me?.blockchainId || ""}
      userProfile={me?.profile || null}
    />
  );
}
