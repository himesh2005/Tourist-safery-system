const express = require("express");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// Hardcoded admin credentials
const ADMIN_USER = "Himesh";
const ADMIN_PASS = "Himesh@2005";

// Middlewares and data access will be passed from index.cjs or we can use a singleton/shared data approach.
// Since index.cjs manages 'users' and 'profiles' Maps, we'll need a way to access them.
// For now, let's assume we'll inject what we need or index.cjs will handle the exports.

module.exports = (users, profiles, saveData, DATA_PATH) => {

  // Admin Login
  router.post("/login", (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      const token = jwt.sign({ username: ADMIN_USER, role: "admin" }, JWT_SECRET, { expiresIn: "4h" });
      return res.json({ success: true, token, username: ADMIN_USER });
    }
    return res.status(401).json({ success: false, error: "Invalid admin credentials" });
  });

  // Auth Middleware for Admin
  const adminAuth = (req, res, next) => {
    try {
      const header = req.headers.authorization || "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : null;
      if (!token) return res.status(401).json({ error: "Missing token" });
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.role !== "admin") return res.status(403).json({ error: "Not authorized as admin" });
      req.admin = decoded;
      next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  };

  // Get all tourists
  router.get("/tourists", adminAuth, (req, res) => {
    const touristList = Array.from(users.values()).map(u => {
      const profile = profiles.get(u.blockchainId) || {};
      return {
        username: u.username,
        name: u.name || profile.name || u.username,
        blockchainId: u.blockchainId,
        lastHeartbeat: u.lastHeartbeat || profile.lastHeartbeat || null,
        lastKnownLocation: u.lastKnownLocation || profile.lastKnownLocation || null,
        loginTimestamp: profile.createdAt || null,
      };
    });
    res.json(touristList);
  });

  // Get alerts breach history
  router.get("/alerts", adminAuth, (req, res) => {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    res.json(data.alerts || []);
  });

  // Submit E-FIR
  router.post("/fir", adminAuth, (req, res) => {
    const { touristId, touristName, lastSeenLocation, description } = req.body;
    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    if (!data.firs) data.firs = [];

    const newFir = {
      id: `FIR-${Date.now()}`,
      touristId,
      touristName,
      lastSeenLocation,
      description,
      timestamp: new Date().toISOString(),
      status: "Reported"
    };

    data.firs.push(newFir);
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    res.json({ success: true, fir: newFir });
  });

  // Get all FIR records
  router.get("/firs", adminAuth, (req, res) => {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    res.json(data.firs || []);
  });

  return router;
};
