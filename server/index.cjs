require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const cors = require("cors");

const express = require("express");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { ethers, Wallet, getAddress } = require("ethers");
const geofenceRoutes = require("./routes/geofence.cjs");
const emergencyRoutes = require("./routes/emergency.cjs");
const adminRoutes = require("./routes/admin.cjs");

const CITY_ROUTES_DIR = path.join(__dirname, "routes", "zones");

let blockchainReady = false;

const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/", geofenceRoutes);
app.use("/", emergencyRoutes);

// ===== ENV =====
const RPC_URL = (
  process.env.AMOY_RPC_URL ||
  process.env.ALCHEMY_URL ||
  process.env.POLYGON_RPC_URL ||
  ""
).trim();
const PRIVATE_KEY = (process.env.PRIVATE_KEY || "")
  .trim()
  .replace(/^"|"$/g, "");
const JWT_SECRET = (process.env.JWT_SECRET || "dev_secret").trim();
const PORT = Number((process.env.PORT || "5000").trim());
function getLocalIPv4() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    if (!Array.isArray(addresses)) continue;
    for (const addr of addresses) {
      if (addr && addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "localhost";
}
const LOCAL_IP = getLocalIPv4();
const BASE_URL = (process.env.BASE_URL || `http://${LOCAL_IP}:${PORT}`)
  .trim()
  .replace(/\/+$/, "");

function getPublicBaseUrl(req) {
  const configured = String(BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const host = String(
    req?.headers?.["x-forwarded-host"] || req?.headers?.host || "",
  )
    .trim()
    .replace(/\/+$/, "");
  const proto = String(req?.headers?.["x-forwarded-proto"] || "")
    .trim()
    .replace(/\/+$/, "");

  const isPrivateOrLocalUrl = (value) => {
    try {
      const parsed = new URL(value);
      const hostname = String(parsed.hostname || "").toLowerCase();

      if (!hostname) return true;
      if (hostname === "localhost" || hostname === "127.0.0.1") return true;
      if (hostname.startsWith("10.")) return true;
      if (hostname.startsWith("192.168.")) return true;
      if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;

      return false;
    } catch {
      return true;
    }
  };

  // Force explicit public BASE_URL when configured.
  if (configured && !isPrivateOrLocalUrl(configured)) {
    return configured;
  }

  // Fallback to forwarded host only if it resolves to a public URL.
  if (host) {
    const protocol = proto || (host.startsWith("localhost") ? "http" : "https");
    const derived = `${protocol}://${host}`;
    if (!isPrivateOrLocalUrl(derived)) return derived;
  }

  return configured || `http://${LOCAL_IP}:${PORT}`;
}
function bcryptHash(password, rounds = 10) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, rounds, (err, hash) => {
      if (err) return reject(err);
      return resolve(hash);
    });
  });
}

function bcryptCompare(password, hash) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, hash, (err, same) => {
      if (err) return reject(err);
      return resolve(Boolean(same));
    });
  });
}

async function ensureChainSync() {
  const statePath = path.join(__dirname, "chain_state.json");

  const chainId = Number((await provider.getNetwork()).chainId);
  const block = await provider.getBlockNumber();

  // Read old state
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  } catch {}

  // If chain restarted (block number small again) OR chainId changed
  const restarted =
    prev && (prev.chainId !== chainId || block < (prev.blockNumber || 0));

  if (restarted) {
    console.log(
      "⚠️ Detected Hardhat chain reset. Clearing local data.json to avoid ID mismatch.",
    );
    // Clear local store
    if (fs.existsSync(DATA_PATH)) fs.unlinkSync(DATA_PATH);
  }

  fs.writeFileSync(
    statePath,
    JSON.stringify({ chainId, blockNumber: block }, null, 2),
  );
}

// ===== Persistence =====
const DATA_PATH = (
  process.env.DATA_PATH ||
  path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname, "data.json")
).trim();

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return { users: {}, profiles: {} };
    const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    for (const [username, user] of Object.entries(data.users || {})) {
      if (!user || typeof user !== "object") continue;
      const profile = data.profiles?.[user.blockchainId] || null;
      if (!user.phone) {
        user.phone =
          user.emergencyContact ||
          profile?.mobile ||
          profile?.emergencyContacts ||
          "";
      }
      if (!user.emergencyContact) {
        user.emergencyContact = profile?.emergencyContacts || user.phone || "";
      }
      if (!user.name) {
        user.name = profile?.name || username;
      }
    }
    return data;
  } catch (e) {
    console.log("Failed to load data.json:", e);
    return { users: {}, profiles: {} };
  }
}

function readCityJson(fileName) {
  const filePath = path.join(CITY_ROUTES_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function cleanCity(city) {
  return String(city || "")
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*/g, "")
    .replace(/\d+/g, "")
    .trim();
}

const loaded = loadData();
const users = new Map(Object.entries(loaded.users || {})); // username -> { username, passHash, blockchainId }
const profiles = new Map(Object.entries(loaded.profiles || {})); // blockchainId -> profile
app.use("/admin", adminRoutes(users, profiles, saveData, DATA_PATH));
console.log("Using DATA_PATH:", DATA_PATH);
console.log("Loaded users:", users.size, "Loaded profiles:", profiles.size);

function saveData() {
  let existing = {};
  try {
    if (fs.existsSync(DATA_PATH)) {
      existing = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
    }
  } catch (e) {}

  const usersObj = Object.fromEntries(users.entries());
  const profilesObj = Object.fromEntries(profiles.entries());
  const dataDir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(
    DATA_PATH,
    JSON.stringify(
      { ...existing, users: usersObj, profiles: profilesObj },
      null,
      2,
    ),
  );
}

async function sendSMSViaVercel(message, number) {
  try {
    const vercelUrl = String(
      process.env.FRONTEND_URL ||
        "https://tourist-safety-system-theta.vercel.app",
    )
      .trim()
      .replace(/\/+$/, "");

    const response = await fetch(`${vercelUrl}/api/send-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, number }),
    });

    const result = await response.json();
    console.log("Vercel SMS result:", result);
    return result;
  } catch (err) {
    console.error("sendSMSViaVercel error:", err.message);
    return { success: false, error: err.message };
  }
}

async function checkAllUsersOfflineStatus() {
  const now = Date.now();
  const threshold = 30 * 1000;
  let didChange = false;

  for (const [blockchainId, profile] of profiles.entries()) {
    if (!profile?.lastHeartbeat) continue;

    const linkedUser =
      Array.from(users.values()).find(
        (entry) => entry.blockchainId === blockchainId,
      ) || null;

    if (profile.offlineAlertSent && profile.lastOfflineAlert) {
      if (now - Number(profile.lastOfflineAlert) > 5 * 60 * 1000) {
        profile.offlineAlertSent = false;
        profiles.set(blockchainId, profile);
        if (linkedUser?.username) {
          linkedUser.offlineAlertSent = false;
          users.set(linkedUser.username, linkedUser);
        }
        didChange = true;
      }
    }

    if (profile.offlineAlertSent) continue;

    const timeSince = now - Number(profile.lastHeartbeat.timestamp || 0);
    if (timeSince < threshold) continue;

    const zoneDesc =
      profile.lastHeartbeat.riskLevel === "danger"
        ? "DANGER ZONE - Naxal affected. Stay alert."
        : profile.lastHeartbeat.riskLevel === "moderate"
          ? "MODERATE ZONE - High crime area. Be cautious."
          : profile.lastHeartbeat.riskLevel === "safe"
            ? "SAFE ZONE - Area is generally safe."
            : "OUTSIDE MAPPED ZONES - Stay cautious.";

    const smsMessage =
      `Tourist Safety Alert\n` +
      `Hi ${profile.name || linkedUser?.name || "Traveler"}, you appear to be offline.\n\n` +
      `Last known location:\n` +
      `Zone: ${profile.lastHeartbeat.zoneName || "Unknown"}\n` +
      `Status: ${zoneDesc}\n\n` +
      `GPS: ${Number(profile.lastHeartbeat.lat || 0).toFixed(4)}, ${Number(profile.lastHeartbeat.lng || 0).toFixed(4)}\n` +
      `Maps: https://maps.google.com/?q=${profile.lastHeartbeat.lat},${profile.lastHeartbeat.lng}\n\n` +
      `If in danger call 112 immediately.\n` +
      `Tourist Safety System`;

    const userPhone = String(
      linkedUser?.phone ||
        linkedUser?.emergencyContact ||
        profile.mobile ||
        profile.emergencyContacts ||
        "",
    ).trim();

    if (!userPhone) continue;

    const result = await sendSMSViaVercel(smsMessage, userPhone);
    if (result?.success === true) {
      profile.offlineAlertSent = true;
      profile.lastOfflineAlert = Date.now();
      profiles.set(blockchainId, profile);
      if (linkedUser?.username) {
        linkedUser.offlineAlertSent = true;
        linkedUser.lastOfflineAlert = profile.lastOfflineAlert;
        users.set(linkedUser.username, linkedUser);
      }
      didChange = true;
    }
  }

  if (didChange) {
    saveData();
  }
}

// ===== Contract address loading =====
const DEPLOYED_PATH = path.join(
  __dirname,
  "..",
  "chain",
  "deployedAddresses.json",
);

function loadContractAddress() {
  try {
    const j = JSON.parse(fs.readFileSync(DEPLOYED_PATH, "utf-8"));
    return String(
      j?.contracts?.TravellerID || j?.CONTRACT_ADDRESS || "",
    ).trim();
  } catch (e) {
    return "";
  }
}

// Prefer .env if present; otherwise read deployedAddresses.json
const CONTRACT_ADDRESS =
  (process.env.CONTRACT_ADDRESS || "").trim().replace(/^"|"$/g, "") ||
  loadContractAddress();

// ===== hard checks =====
if (!RPC_URL) {
  console.log("BAD RPC URL:", RPC_URL);
  console.log(
    "Fix: set AMOY_RPC_URL or ALCHEMY_URL (or POLYGON_RPC_URL) in server/.env",
  );
  process.exit(1);
}

if (!PRIVATE_KEY) {
  console.log("BAD PRIVATE_KEY:", PRIVATE_KEY);
  console.log("Fix: set PRIVATE_KEY in server/.env");
  process.exit(1);
}

if (!ethers.isAddress(CONTRACT_ADDRESS)) {
  console.log("BAD CONTRACT_ADDRESS:", CONTRACT_ADDRESS);
  console.log(
    "Fix: run deploy first so chain/deployedAddresses.json is created, OR set CONTRACT_ADDRESS in server/.env",
  );
  process.exit(1);
}

// ===== Blockchain =====
const ABI = [
  "function createId(string blockchainId, bytes32 profileHash) external",
  "function getRecord(string blockchainId) external view returns (bytes32, uint256, address)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);

let wallet;
let contract;

async function getIssuerWallet() {
  const issuerWallet = new Wallet(PRIVATE_KEY, provider);
  console.log("Using Issuer Wallet:", issuerWallet.address);
  return issuerWallet;
}

async function initBlockchain() {
  try {
    wallet = await getIssuerWallet();
    contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
    blockchainReady = true;
  } catch (err) {
    console.warn(
      "Blockchain init failed (insufficient funds or RPC error):",
      err.message,
    );
    console.warn(
      "Server will run in LOCAL-ONLY mode - blockchain features disabled",
    );
    blockchainReady = false;
  }
}

async function resyncChainFromLocal() {
  try {
    if (!blockchainReady || !contract) return;
    const ids = Array.from(profiles.keys());
    if (ids.length === 0) return;

    console.log(`Resync: checking ${ids.length} profiles on-chain...`);

    for (const blockchainId of ids) {
      try {
        await contract.getRecord(blockchainId);
      } catch (e) {
        const msg = String(e?.shortMessage || e?.reason || e?.message || "");
        if (msg.includes("ID not found") || msg.includes("CALL_EXCEPTION")) {
          console.warn(
            "Resync warning: profile missing on-chain (read-only mode, skipping write):",
            blockchainId,
          );
        } else {
          console.warn(
            "Resync warning: on-chain read failed for",
            blockchainId,
            msg,
          );
        }
      }
    }

    console.log("Resync complete ✅ (read-only)");
  } catch (err) {
    console.warn(
      "Resync skipped due to unexpected error (non-fatal):",
      err?.message || String(err),
    );
  }
}

// Stable hash for verification
function sha256Hex(str) {
  return "0x" + crypto.createHash("sha256").update(str).digest("hex");
}

// ===== Auth middleware =====
function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Missing token" });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ===== Basic routes =====
app.get("/", (req, res) => {
  res.send(
    "Server is running ✅ Use /auth/register, /auth/login, /me, /health",
  );
});

app.get("/health", (req, res) => {
  checkAllUsersOfflineStatus().catch(console.error);
  res.json({ status: "ok" });
});

app.get("/debug/state", (req, res) => {
  res.json({
    usersCount: users.size,
    profilesCount: profiles.size,
    profileIds: Array.from(profiles.keys()).slice(0, 20),
    contractAddress: CONTRACT_ADDRESS,
  });
});

app.get("/api/test-vercel-sms", async (req, res) => {
  const result = await sendSMSViaVercel(
    "Test from Tourist Safety System backend watchdog",
    "8432419551",
  );
  res.json(result);
});

app.post("/api/user/heartbeat", authMiddleware, async (req, res) => {
  try {
    const { username } = req.user || {};
    const user = users.get(username);
    if (!user) {
      return res.json({ success: false });
    }

    const profile = profiles.get(user.blockchainId);
    if (!profile) {
      return res.json({ success: false });
    }

    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const zoneName = String(req.body?.zoneName || "Unknown").trim();
    const riskLevel = String(req.body?.riskLevel || "unknown")
      .trim()
      .toLowerCase();
    const riskScore = Number(req.body?.riskScore || 0);

    profile.lastHeartbeat = {
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      zoneName,
      riskLevel,
      riskScore: Number.isFinite(riskScore) ? riskScore : 0,
      timestamp: Date.now(),
    };
    profile.offlineAlertSent = false;
    profiles.set(user.blockchainId, profile);
    user.lastHeartbeat = profile.lastHeartbeat;
    user.offlineAlertSent = false;
    users.set(username, user);

    // Admin Alerts logic
    if (riskLevel !== "safe" && riskLevel !== "unknown") {
      let data = {};
      try {
        if (fs.existsSync(DATA_PATH)) {
          data = JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
        }
      } catch (e) {}

      if (!data.alerts) data.alerts = [];
      const lastAlert = data.alerts[data.alerts.length - 1];
      // Only record if it's a new zone or some time has passed to avoid flooding (every minute)
      if (
        !lastAlert ||
        lastAlert.blockchainId !== user.blockchainId ||
        lastAlert.zoneName !== zoneName ||
        Date.now() - new Date(lastAlert.timestamp).getTime() > 60000
      ) {
        data.alerts.push({
          id: `ALT-${Date.now()}`,
          blockchainId: user.blockchainId,
          userName: user.name || username,
          timestamp: new Date().toISOString(),
          zoneName,
          riskLevel,
          lat,
          lng,
        });
        fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
      }
    }

    saveData();

    res.json({ success: true });
    await checkAllUsersOfflineStatus();
    return;
  } catch (err) {
    console.log("USER HEARTBEAT ERROR:", err);
    return res.json({ success: false });
  }
});

app.post("/api/user/last-location", authMiddleware, (req, res) => {
  try {
    const { username, id } = req.user || {};
    const user = users.get(username);
    if (!user) {
      return res.json({ success: false });
    }

    const profile = profiles.get(user.blockchainId);
    if (!profile) {
      return res.json({ success: false });
    }

    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    const timestamp = Number(req.body?.timestamp || Date.now());
    const zoneName = String(req.body?.zoneName || "").trim();
    const riskLevel = String(req.body?.riskLevel || "safe")
      .trim()
      .toLowerCase();

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.json({ success: false });
    }

    profile.lastKnownLocation = {
      lat,
      lng,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      zoneName,
      riskLevel: riskLevel || "safe",
    };
    profiles.set(user.blockchainId, profile);
    if (id) {
      user.lastKnownLocation = profile.lastKnownLocation;
      users.set(username, user);
    }
    saveData();

    return res.json({ success: true });
  } catch (err) {
    console.log("USER LAST LOCATION ERROR:", err);
    return res.json({ success: false });
  }
});

app.post("/api/emergency/location-alert", async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    const payloadMessage = String(message || "").trim();
    if (!payloadMessage) {
      return res.status(400).json({ error: "message is required" });
    }

    const profileKey = profiles.has(userId)
      ? userId
      : users.get(userId || "")?.blockchainId || "";
    if (profileKey && profiles.has(profileKey)) {
      const profile = profiles.get(profileKey);
      profile.lastLocationAlert = {
        message: payloadMessage,
        createdAt: new Date().toISOString(),
      };
      profiles.set(profileKey, profile);
      saveData();
    }

    return res.json({
      success: true,
      userId: userId || "",
      recorded: Boolean(profileKey && profiles.has(profileKey)),
    });
  } catch (err) {
    console.log("LOCATION ALERT ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Failed to record location alert",
    });
  }
});

setInterval(() => {
  checkAllUsersOfflineStatus().catch((err) => {
    console.error("Heartbeat checker error:", err.message);
  });
}, 30000);

app.get("/api/tourist-spots/:city", (req, res) => {
  try {
    const city = cleanCity(req.params.city);
    const filePath = path.join(CITY_ROUTES_DIR, `${city}-tourist-spots.json`);
    if (!fs.existsSync(filePath)) {
      return res.json({ spots: [] });
    }
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return res.json(data);
  } catch (err) {
    console.log("TOURIST SPOTS /api/tourist-spots/:city ERROR:", err);
    return res.json({ spots: [] });
  }
});

app.get("/api/emergency-services/:city", (req, res) => {
  try {
    const city = cleanCity(req.params.city);
    const filePath = path.join(
      CITY_ROUTES_DIR,
      `${city}-emergency-services.json`,
    );
    if (!fs.existsSync(filePath)) {
      return res.json({ policeStations: [], hospitals: [] });
    }
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return res.json(data);
  } catch (err) {
    console.log("EMERGENCY SERVICES /api/emergency-services/:city ERROR:", err);
    return res.json({ policeStations: [], hospitals: [] });
  }
});

// ===== Register UI (shows QR) =====
app.get("/register-ui", (req, res) => {
  res.send(`
<!doctype html><html><head><meta charset="utf-8"/>
<title>Register UI</title>
<style>
body{font-family:Arial;max-width:520px;margin:40px auto;padding:0 16px}
input{width:100%;padding:10px;margin:6px 0;border:1px solid #ccc;border-radius:10px}
button{padding:10px 14px;border-radius:10px;border:1px solid #333;background:#111;color:#fff;cursor:pointer}
.card{border:1px solid #ddd;border-radius:12px;padding:14px;margin-top:16px}
img{max-width:240px;margin-top:10px;border:1px solid #eee;border-radius:10px}
pre{background:#f5f5f5;padding:10px;border-radius:10px;overflow:auto}
a{word-break:break-all}
</style></head><body>

<h2>Traveller Safety — Register (Demo UI)</h2>

<input id="u" placeholder="username"/>
<input id="p" placeholder="password" type="password"/>
<input id="n" placeholder="name"/>
<input id="b" placeholder="bloodGroup (e.g., O+)"/>
<input id="a" placeholder="allergies"/>
<input id="e" placeholder="emergencyContacts"/>
<input id="ad" placeholder="address"/>

<button onclick="go()">Create Blockchain ID + QR</button>

<div id="result"></div>

<script>
async function go(){
  const body = {
    username: u.value.trim(),
    password: p.value,
    name: n.value.trim(),
    bloodGroup: b.value.trim(),
    allergies: a.value.trim(),
    emergencyContacts: e.value.trim(),
    address: ad.value.trim()
  };

  const res = await fetch("/auth/register", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if(!res.ok){
    result.innerHTML = "<div class='card'><b>Error:</b><pre>"+JSON.stringify(data,null,2)+"</pre></div>";
    return;
  }

  result.innerHTML = \`
    <div class="card">
      <h3>Created ✅</h3>
      <p><b>ID:</b> \${data.blockchainId}</p>
      <p><b>Scan / Verify:</b> <a href="\${data.scanUrl || data.verifyUrl || '#'}" target="_blank">\${data.scanUrl || data.verifyUrl || "Offline QR payload (no URL required)"}</a></p>
      <img src="\${data.qrDataUrl}" alt="QR Code"/>
      <pre>\${JSON.stringify(data,null,2)}</pre>
    </div>
  \`;
}
</script>

</body></html>
  `);
});

// ===== AUTH =====
app.post("/api/check-username", (req, res) => {
  const username = String(req.body?.username || "").trim();
  if (!username) {
    return res.status(400).json({ available: false });
  }
  return res.json({ available: !users.has(username) });
});

app.post("/auth/register", async (req, res) => {
  try {
    const payload = req.body || {};
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");

    // Accept both legacy payload and new registration form payload
    const normalizedName = String(
      payload.name || payload.username || "",
    ).trim();
    const normalizedPhone = String(
      payload.phone || payload.mobile || "",
    ).trim();
    const normalizedEmergencyPhone = String(
      payload.emergencyContactPhone ||
        payload.emergencyContact ||
        payload.emergencyContacts ||
        payload.mobile ||
        "",
    ).trim();
    const normalizedEmergencyContactName = String(
      payload.emergencyContactName ||
        payload.emergencyName ||
        payload.name ||
        payload.username ||
        "",
    ).trim();
    const normalizedBloodGroup = String(payload.bloodGroup || "NA").trim();
    const normalizedItinerary = String(payload.itinerary || "").trim();
    const normalizedAddress = String(
      payload.address || payload.itinerary || "",
    ).trim();
    const normalizedAadhaarOrPassport = String(
      payload.aadhaarOrPassport || "",
    ).trim();
    const validUntilUnix = Number(payload.validUntil);
    const indianPhoneRegex = /^\d{10}$/;

    if (!username || !password)
      return res.status(400).json({ error: "username and password required" });
    if (users.has(username))
      return res.status(409).json({ error: "username already exists" });

    // Legacy registration requires complete profile fields.
    const isLegacyPayload = Boolean(
      payload.name ||
      payload.mobile ||
      payload.bloodGroup ||
      payload.emergencyContacts ||
      payload.address,
    );

    if (!normalizedName) {
      return res.status(400).json({ error: "Missing profile fields" });
    }
    if (!normalizedPhone || !indianPhoneRegex.test(normalizedPhone)) {
      return res.status(400).json({
        error: "phone must be a valid 10-digit numeric value",
      });
    }
    if (
      !normalizedEmergencyPhone ||
      !indianPhoneRegex.test(normalizedEmergencyPhone)
    ) {
      return res.status(400).json({
        error:
          "emergencyContactPhone/emergencyContact must be a valid 10-digit numeric value",
      });
    }
    if (normalizedPhone === normalizedEmergencyPhone) {
      return res.status(400).json({
        error: "phone and emergency contact phone must be different",
      });
    }
    if (isLegacyPayload && (!normalizedBloodGroup || !normalizedAddress)) {
      return res.status(400).json({ error: "Missing profile fields" });
    }

    const passHash = await bcryptHash(password, 10);
    const blockchainId = "TID-" + crypto.randomBytes(6).toString("hex");
    const createdAt = new Date().toISOString();

    let validTill = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    if (
      Number.isFinite(validUntilUnix) &&
      validUntilUnix > Math.floor(Date.now() / 1000)
    ) {
      validTill = new Date(validUntilUnix * 1000).toISOString();
    }

    const profile = {
      blockchainId,
      username,
      name: normalizedName,
      phone: normalizedPhone,
      mobile: normalizedPhone,
      bloodGroup: normalizedBloodGroup || "NA",
      allergies: String(payload.allergies || ""),
      emergencyContactName: normalizedEmergencyContactName,
      emergencyContactPhone: normalizedEmergencyPhone,
      emergencyContacts: normalizedEmergencyPhone,
      address: normalizedAddress || normalizedItinerary || "N/A",
      itinerary: normalizedItinerary,
      aadhaarOrPassport: normalizedAadhaarOrPassport,
      aadhaarVerified: Boolean(normalizedAadhaarOrPassport),
      createdAt,
      validTill,
    };

    const profileHash = sha256Hex(JSON.stringify(profile));

    // Try blockchain write, but keep registration resilient if chain call fails
    let txHash = null;
    let chainWriteStatus = "success";
    let chainWriteError = "";

    try {
      if (!contract) throw new Error("Contract not initialized");
      const tx = await contract.createId(blockchainId, profileHash);
      const receipt = await tx.wait();
      txHash = receipt?.hash || null;
      blockchainReady = true;
    } catch (err) {
      console.warn("Chain write skipped:", err.message);
      chainWriteStatus = "failed";
      chainWriteError = String(
        err?.shortMessage || err?.reason || err?.message || err,
      );
      console.log("REGISTER CHAIN WRITE FAILED:", chainWriteError);
    }

    // Save locally regardless of blockchain write result
    users.set(username, {
      username,
      passHash,
      blockchainId,
      id: blockchainId,
      name: normalizedName || username,
      phone: normalizedPhone || "",
      emergencyContactName: normalizedEmergencyContactName || "",
      emergencyContact: normalizedEmergencyPhone || "",
    });
    profiles.set(blockchainId, profile);
    saveData();

    res.json({
      blockchainId,
      createdAt,
      validTill,
      validUntil: Math.floor(new Date(validTill).getTime() / 1000),
      kyc: normalizedAadhaarOrPassport,
      itinerary: normalizedItinerary,
      phone: normalizedPhone,
      emergencyContactName: normalizedEmergencyContactName,
      emergencyContact: normalizedEmergencyPhone,
      emergencyPhone: normalizedEmergencyPhone,
      status: "success",
    });
  } catch (err) {
    console.log("REGISTER ERROR:", err);
    res.status(500).json({ error: "register failed", details: String(err) });
  }
});
app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }

    const u = users.get(username);
    if (!u) return res.status(401).json({ error: "Invalid credentials" });
    if (!u.passHash || typeof u.passHash !== "string") {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcryptCompare(password, u.passHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const loginTimestamp = Date.now();
    u.lastLoginAt = loginTimestamp;
    users.set(username, u);

    const profile = profiles.get(u.blockchainId) || null;
    if (profile && typeof profile === "object") {
      profile.lastLoginAt = loginTimestamp;
      profiles.set(u.blockchainId, profile);
    }
    saveData();

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "2h" });
    res.json({
      token,
      blockchainId: u.blockchainId,
      loginTimestamp,
      profile: profile
        ? {
            blockchainId: profile.blockchainId,
            name: profile.name,
            phone: profile.phone || profile.mobile || u.phone || "",
            mobile: profile.mobile || profile.phone || u.phone || "",
            emergencyPhone:
              profile.emergencyContactPhone ||
              profile.emergencyContacts ||
              u.emergencyContact ||
              "",
            emergencyContacts:
              profile.emergencyContacts ||
              profile.emergencyContactPhone ||
              u.emergencyContact ||
              "",
            emergencyContactName:
              profile.emergencyContactName || u.emergencyContactName || "",
            address: profile.address || "",
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: "login failed", details: String(err) });
  }
});

app.get("/me", authMiddleware, (req, res) => {
  const { username } = req.user;
  const u = users.get(username);
  if (!u) return res.status(404).json({ error: "user not found" });
  const profile = profiles.get(u.blockchainId) || null;
  res.json({
    id: u.id || u.blockchainId,
    username,
    name: profile?.name || u.name || username,
    phone: u.phone || profile?.phone || profile?.mobile || "",
    emergencyPhone:
      u.emergencyContact ||
      profile?.emergencyContactPhone ||
      profile?.emergencyContacts ||
      "",
    emergencyContact:
      u.emergencyContact ||
      profile?.emergencyContactPhone ||
      profile?.emergencyContacts ||
      "",
    emergencyContactName:
      u.emergencyContactName || profile?.emergencyContactName || "",
    blockchainId: u.blockchainId,
    bloodGroup: profile?.bloodGroup || "",
    profile: profile
      ? {
          blockchainId: profile.blockchainId,
          name: profile.name,
          phone: profile.phone || profile.mobile || u.phone || "",
          mobile: profile.mobile || profile.phone || u.phone || "",
          emergencyContactPhone:
            profile.emergencyContactPhone ||
            profile.emergencyContacts ||
            u.emergencyContact ||
            "",
          emergencyContacts:
            profile.emergencyContacts ||
            profile.emergencyContactPhone ||
            u.emergencyContact ||
            "",
          emergencyContactName:
            profile.emergencyContactName || u.emergencyContactName || "",
          address: profile.address || "",
          bloodGroup: profile.bloodGroup || "",
        }
      : null,
  });
});

// ===== VERIFY API =====
app.get("/api/verify/:blockchainId", async (req, res) => {
  try {
    const { blockchainId } = req.params;

    const profile = profiles.get(blockchainId);
    if (!profile)
      return res.status(404).json({ error: "Profile not found (local store)" });

    const localHash = sha256Hex(JSON.stringify(profile));

    let onChainHash = null;
    let onChainAvailable = true;
    let onChainError = "";

    try {
      const record = await contract.getRecord(blockchainId);
      onChainHash = record?.[0] || null;
    } catch (chainErr) {
      onChainAvailable = false;
      onChainError = String(
        chainErr?.shortMessage ||
          chainErr?.reason ||
          chainErr?.message ||
          chainErr,
      );
      console.log("VERIFY CHAIN READ FAILED:", blockchainId, onChainError);
    }

    const safeProfile = {
      blockchainId: profile.blockchainId,
      name: profile.name,
      bloodGroup: profile.bloodGroup,
      allergies: profile.allergies,
      emergencyContacts: profile.emergencyContacts,
      address: profile.address,
    };

    res.json({
      profile: safeProfile,
      proof: {
        localHash,
        onChainHash,
        onChainAvailable,
        onChainError,
        match:
          Boolean(onChainHash) &&
          localHash.toLowerCase() === String(onChainHash).toLowerCase(),
      },
    });
  } catch (err) {
    console.log("VERIFY ERROR:", err);
    res.status(500).json({ error: "Verify error", details: String(err) });
  }
});

(async function start() {
  try {
    await initBlockchain();
    if (blockchainReady) {
      await resyncChainFromLocal();
    }
  } catch (e) {
    console.warn("Startup initialization warning:", e?.message || String(e));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on LAN at ${BASE_URL}`);
  });
})();
