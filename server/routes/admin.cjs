const express = require("express");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// Hardcoded admin credentials (as requested)
const ADMIN_USER = "Himesh";
const ADMIN_PASS = "Himesh@2005";

module.exports = (users, profiles, saveData, DATA_PATH) => {
  const router = express.Router();

  function safeString(value) {
    return String(value || "").trim();
  }

  function normalizeRiskLevel(value) {
    const risk = safeString(value).toLowerCase();
    if (risk === "danger" || risk === "moderate" || risk === "safe")
      return risk;
    if (risk === "high" || risk === "high_crime" || risk === "restricted")
      return "danger";
    if (risk === "low" || risk === "normal") return "safe";
    return "safe";
  }

  function resolveLocation(user, profile) {
    const hb = user?.lastHeartbeat || profile?.lastHeartbeat || null;
    const lk = user?.lastKnownLocation || profile?.lastKnownLocation || null;

    const candidate = hb || lk;
    if (!candidate) return null;

    const lat = Number(candidate.lat);
    const lng = Number(candidate.lng);

    return {
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      zoneName: safeString(candidate.zoneName) || "Unknown",
      riskLevel: normalizeRiskLevel(candidate.riskLevel),
      riskScore: Number.isFinite(Number(candidate.riskScore))
        ? Number(candidate.riskScore)
        : null,
      timestamp: Number(candidate.timestamp || 0) || null,
    };
  }

  function ensureDataFile() {
    const filePath = safeString(DATA_PATH);
    if (!filePath) return;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          { users: {}, profiles: {}, alerts: [], firs: [] },
          null,
          2,
        ),
      );
    }
  }

  function readDataStore() {
    try {
      ensureDataFile();
      const raw = fs.readFileSync(DATA_PATH, "utf-8");
      const parsed = JSON.parse(raw || "{}");
      if (!Array.isArray(parsed.alerts)) parsed.alerts = [];
      if (!Array.isArray(parsed.firs)) parsed.firs = [];
      return parsed;
    } catch {
      return { alerts: [], firs: [] };
    }
  }

  function writeDataStore(data) {
    ensureDataFile();
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  }

  function isAdminTokenPayload(decoded) {
    return (
      decoded &&
      decoded.role === "admin" &&
      safeString(decoded.username) === ADMIN_USER
    );
  }

  // ---------- Security middleware ----------
  function adminAuth(req, res, next) {
    try {
      const header = safeString(req.headers.authorization);
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token) return res.status(401).json({ error: "Missing token" });

      const decoded = jwt.verify(token, JWT_SECRET);
      if (!isAdminTokenPayload(decoded)) {
        return res.status(403).json({ error: "Not authorized as admin" });
      }

      req.admin = decoded;
      res.setHeader("Cache-Control", "no-store");
      next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  }

  // ---------- Auth ----------
  router.post("/login", (req, res) => {
    const username = safeString(req.body?.username);
    const password = safeString(req.body?.password);

    if (!username || !password) {
      return res
        .status(400)
        .json({ success: false, error: "username and password required" });
    }

    if (username !== ADMIN_USER || password !== ADMIN_PASS) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid admin credentials" });
    }

    const token = jwt.sign(
      { username: ADMIN_USER, role: "admin" },
      JWT_SECRET,
      { expiresIn: "4h" },
    );

    return res.json({ success: true, token, username: ADMIN_USER });
  });

  // ---------- Tourists Monitoring + Digital ID Records ----------
  router.get("/tourists", adminAuth, (req, res) => {
    const q = safeString(req.query?.q).toLowerCase();

    const tourists = Array.from(users.values())
      .map((u) => {
        const profile = profiles.get(u.blockchainId) || {};
        const location = resolveLocation(u, profile);
        const loginTimestamp =
          Number(u.lastLoginAt || profile.lastLoginAt || 0) ||
          Number(new Date(profile.createdAt || 0).getTime()) ||
          null;

        const itinerary =
          profile.itinerary ||
          profile.tripItinerary ||
          profile.travelPlan ||
          "";

        const emergencyContacts =
          profile.emergencyContacts ||
          u.emergencyContact ||
          u.phone ||
          profile.mobile ||
          "";

        const validFrom =
          profile.createdAt || profile.validFrom || profile.issueDate || null;

        const validTill =
          profile.validTill || profile.validUntil || profile.validTo || null;

        return {
          username: u.username,
          name: u.name || profile.name || u.username,
          blockchainId: u.blockchainId,
          loginTimestamp,

          // Monitoring panel fields
          currentLocation: location
            ? {
                lat: location.lat,
                lng: location.lng,
                timestamp: location.timestamp,
              }
            : null,
          riskZoneStatus: location?.riskLevel || "safe",
          zoneName: location?.zoneName || "Unknown",
          lastHeartbeat: u.lastHeartbeat || profile.lastHeartbeat || null,
          lastKnownLocation:
            u.lastKnownLocation || profile.lastKnownLocation || null,

          // Digital ID records fields
          digitalIdRecord: {
            blockchainId: u.blockchainId,
            itinerary,
            emergencyContacts,
            validFrom,
            validTill,
          },
        };
      })
      .filter((t) => {
        if (!q) return true;
        return (
          safeString(t.name).toLowerCase().includes(q) ||
          safeString(t.blockchainId).toLowerCase().includes(q) ||
          safeString(t.username).toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const aTs =
          Number(
            a.lastHeartbeat?.timestamp || a.lastKnownLocation?.timestamp || 0,
          ) || 0;
        const bTs =
          Number(
            b.lastHeartbeat?.timestamp || b.lastKnownLocation?.timestamp || 0,
          ) || 0;
        return bTs - aTs;
      });

    return res.json(tourists);
  });

  // Optional alias for Digital ID panel consumers
  router.get("/records", adminAuth, (req, res) => {
    const q = safeString(req.query?.q).toLowerCase();
    const records = Array.from(users.values())
      .map((u) => {
        const profile = profiles.get(u.blockchainId) || {};
        return {
          name: u.name || profile.name || u.username,
          username: u.username,
          blockchainId: u.blockchainId,
          itinerary:
            profile.itinerary ||
            profile.tripItinerary ||
            profile.travelPlan ||
            "",
          emergencyContacts:
            profile.emergencyContacts ||
            u.emergencyContact ||
            u.phone ||
            profile.mobile ||
            "",
          validFrom:
            profile.createdAt || profile.validFrom || profile.issueDate || null,
          validTill:
            profile.validTill || profile.validUntil || profile.validTo || null,
        };
      })
      .filter((r) => {
        if (!q) return true;
        return (
          safeString(r.name).toLowerCase().includes(q) ||
          safeString(r.blockchainId).toLowerCase().includes(q) ||
          safeString(r.username).toLowerCase().includes(q)
        );
      });

    return res.json(records);
  });

  // ---------- Alerts / Zone Breach Logs ----------
  router.get("/alerts", adminAuth, (req, res) => {
    const q = safeString(req.query?.q).toLowerCase();
    const risk = safeString(req.query?.risk).toLowerCase();

    const data = readDataStore();
    const alerts = (data.alerts || [])
      .map((a) => ({
        id: a.id || `ALT-${Date.now()}`,
        blockchainId: safeString(a.blockchainId),
        userName: safeString(a.userName),
        zoneName: safeString(a.zoneName) || "Unknown",
        riskLevel: normalizeRiskLevel(a.riskLevel),
        timestamp: a.timestamp || new Date().toISOString(),
        lat: Number.isFinite(Number(a.lat)) ? Number(a.lat) : null,
        lng: Number.isFinite(Number(a.lng)) ? Number(a.lng) : null,
      }))
      .filter((a) => {
        const passQuery =
          !q ||
          a.userName.toLowerCase().includes(q) ||
          a.blockchainId.toLowerCase().includes(q) ||
          a.zoneName.toLowerCase().includes(q);

        const passRisk = !risk || a.riskLevel === risk;
        return passQuery && passRisk;
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.json(alerts);
  });

  // ---------- E-FIR ----------
  router.post("/fir", adminAuth, (req, res) => {
    const touristId = safeString(req.body?.touristId);
    const touristName = safeString(req.body?.touristName);
    const lastSeenLocation = safeString(req.body?.lastSeenLocation);
    const description = safeString(req.body?.description);

    if (!touristId || !lastSeenLocation || !description) {
      return res.status(400).json({
        success: false,
        error: "touristId, lastSeenLocation and description are required",
      });
    }

    const userMatch = Array.from(users.values()).find(
      (u) => safeString(u.blockchainId) === touristId,
    );
    const resolvedName =
      touristName || userMatch?.name || userMatch?.username || "Unknown";

    const data = readDataStore();
    const newFir = {
      id: `FIR-${Date.now()}`,
      touristId,
      touristName: resolvedName,
      lastSeenLocation,
      description,
      timestamp: new Date().toISOString(),
      status: "Reported",
      generatedBy: ADMIN_USER,
    };

    data.firs.push(newFir);
    writeDataStore(data);

    // Keep primary app persistence in sync where relevant
    if (typeof saveData === "function") {
      try {
        saveData();
      } catch {
        // Non-blocking for FIR write
      }
    }

    return res.status(201).json({ success: true, fir: newFir });
  });

  router.get("/firs", adminAuth, (req, res) => {
    const q = safeString(req.query?.q).toLowerCase();
    const data = readDataStore();
    const firs = (data.firs || [])
      .filter((f) => {
        if (!q) return true;
        return (
          safeString(f.touristName).toLowerCase().includes(q) ||
          safeString(f.touristId).toLowerCase().includes(q) ||
          safeString(f.id).toLowerCase().includes(q)
        );
      })
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.json(firs);
  });

  return router;
};
