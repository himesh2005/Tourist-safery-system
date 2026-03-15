require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const express = require("express");

const QRCode = require("qrcode");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { ethers, Wallet, getAddress } = require("ethers");
const { signProfile, verifyProfile } = require("./utils/signature.cjs");
const { appendVerificationLog } = require("./utils/verificationLogger.cjs");
const geofenceRoutes = require("./routes/geofence.cjs");
const emergencyRoutes = require("./routes/emergency.cjs");

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
// ===== System signing key (for QR signature issuance) =====
const SIGNING_PRIVATE_KEY = (process.env.SIGNING_PRIVATE_KEY || "")
  .trim()
  .replace(/^"|"$/g, "");
if (!SIGNING_PRIVATE_KEY) {
  throw new Error(
    "SIGNING_PRIVATE_KEY is not configured in environment variables.",
  );
}
const signingWallet = new Wallet(SIGNING_PRIVATE_KEY);
const TRUSTED_ISSUER_PUBLIC_KEY = signingWallet.address;
const issuerPublicKey = signingWallet.address;
console.log("Signing Wallet Address:", signingWallet.address);

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
console.log("Using DATA_PATH:", DATA_PATH);
console.log("Loaded users:", users.size, "Loaded profiles:", profiles.size);

function saveData() {
  const usersObj = Object.fromEntries(users.entries());
  const profilesObj = Object.fromEntries(profiles.entries());
  const dataDir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(
    DATA_PATH,
    JSON.stringify({ users: usersObj, profiles: profilesObj }, null, 2),
  );
}

function sendSMSViaHTTPS(message, number) {
  return new Promise((resolve) => {
    const cleanNumber = number
      .toString()
      .replace(/^\+91/, "")
      .replace(/^91/, "");

    const postData = JSON.stringify({
      route: "q",
      message,
      language: "english",
      flash: 0,
      numbers: cleanNumber,
    });

    const options = {
      hostname: "api.fast2sms.com",
      port: 443,
      path: "/dev/bulkV2",
      method: "POST",
      headers: {
        authorization: process.env.FAST2SMS_KEY,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          console.log("Fast2SMS direct result:", result);
          resolve(result);
        } catch (e) {
          resolve({ success: false, error: "parse error", raw: data });
        }
      });
    });

    req.on("error", (err) => {
      console.error("HTTPS request error:", err.message);
      resolve({ success: false, error: err.message });
    });

    req.write(postData);
    req.end();
  });
}

async function checkAllUsersOfflineStatus() {
  const now = Date.now();
  const threshold = 30 * 1000;
  let didChange = false;

  console.log(`Offline check: scanning ${profiles.size} users...`);

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
    console.log(
      `${profile.name || linkedUser?.name || blockchainId}: ${Math.round(timeSince / 1000)}s since heartbeat, zone: ${profile.lastHeartbeat.zoneName}, risk: ${profile.lastHeartbeat.riskLevel}`,
    );

    if (timeSince < threshold) continue;

    console.log(
      `${profile.name || linkedUser?.name || blockchainId}: OFFLINE — sending SMS alert`,
    );

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
      `GPS: ${Number(profile.lastHeartbeat.lat).toFixed(4)}, ${Number(profile.lastHeartbeat.lng).toFixed(4)}\n` +
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
    console.log(`Sending SMS to: ${userPhone}`);

    if (!userPhone) {
      console.log(
        `No phone number for ${profile.name || linkedUser?.name || blockchainId} — skipping`,
      );
      continue;
    }

    const result = await sendSMSViaHTTPS(smsMessage, userPhone);
    console.log("SMS sent result:", JSON.stringify(result));

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

function buildSignableQrProfile(input) {
  return {
    blockchainId: input.blockchainId,
    name: input.name,
    bloodGroup: input.bloodGroup,
    allergies: input.allergies || "",
    emergencyContacts: input.emergencyContacts,
    address: input.address,
    onChainHash: input.onChainHash,
  };
}

function buildVerificationUrl(qrPayload, baseUrl = BASE_URL) {
  const base64Payload = Buffer.from(JSON.stringify(qrPayload), "utf8").toString(
    "base64",
  );
  return `${String(baseUrl || BASE_URL).replace(/\/+$/, "")}/verify-card?payload=${encodeURIComponent(base64Payload)}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeAddress(value) {
  try {
    return getAddress(String(value || "").trim());
  } catch {
    return "";
  }
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").trim();
  if (forwarded) return forwarded.split(",")[0].trim();
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function formatTimestamp(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value || "");
  }
}

function validateVerifyCardPayload(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, reason: "Payload must be a JSON object" };
  }

  const required = [
    "type",
    "blockchainId",
    "name",
    "bloodGroup",
    "emergencyContacts",
    "address",
    "onChainHash",
    "signature",
    "issuerPublicKey",
  ];

  for (const key of required) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) {
      return { valid: false, reason: `Missing or invalid field: ${key}` };
    }
  }

  if (input.type !== "TouristSafetyEmergencyCard") {
    return { valid: false, reason: "Invalid card type" };
  }

  return { valid: true };
}

function renderVerificationPage(profile, verificationResult) {
  const safeProfile = {
    blockchainId: escapeHtml(profile.blockchainId || "-"),
    name: escapeHtml(profile.name || "-"),
    bloodGroup: escapeHtml(profile.bloodGroup || "-"),
    allergies: escapeHtml(profile.allergies || "-"),
    emergencyContacts: escapeHtml(profile.emergencyContacts || "-"),
    address: escapeHtml(profile.address || "-"),
  };
  const isValid = verificationResult.finalStatus === "VALID";
  const verifiedAt = formatTimestamp(verificationResult.timestamp);
  const verificationId = escapeHtml(
    verificationResult.verificationId || "VER-UNKNOWN",
  );

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Tourist Safety - Card Verification</title>
  <style>
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:"Segoe UI",sans-serif;
      color:#e6f6ff;
      background:linear-gradient(135deg,#0f2027,#203a43,#2c5364);
      background-size:200% 200%;
      animation:bgShift 14s ease infinite;
      min-height:100vh
    }
    .shell{max-width:700px;margin:0 auto;padding:24px 16px}
    .container{display:grid;gap:14px}
    .panel{
      border:1px solid rgba(255,255,255,.24);
      border-radius:20px;
      padding:16px;
      backdrop-filter: blur(12px);
      background:rgba(255,255,255,.06);
      box-shadow:0 20px 40px rgba(0,0,0,.4)
    }
    .title{font-size:1.28rem;font-weight:700;margin:0}
    .status{display:inline-block;margin-top:10px;padding:10px 16px;border-radius:999px;font-weight:800;font-size:15px}
    .status-ok{background:linear-gradient(90deg,rgba(22,163,74,.75),rgba(34,197,94,.75));color:#f0fff6;border:1px solid rgba(134,239,172,.75)}
    .status-bad{background:linear-gradient(90deg,rgba(185,28,28,.8),rgba(239,68,68,.8));color:#fff5f5;border:1px solid rgba(252,165,165,.75)}
    .section-title{margin:0 0 10px 0;font-size:1.02rem}
    .row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid rgba(255,255,255,.12)}
    .row:last-child{border-bottom:none}
    .key{color:#b8cfdd;font-weight:600}
    .val{font-weight:600;text-align:right;word-break:break-word}
    .ok{color:#86efac;font-weight:700}
    .bad{color:#fca5a5;font-weight:700}
    .warning{
      border-radius:14px;
      padding:15px;
      font-weight:700;
      line-height:1.5;
      color:#fff;
      background:linear-gradient(90deg,#7f1d1d,#b91c1c);
      box-shadow:0 0 18px rgba(239,68,68,.42);
      border:1px solid rgba(252,165,165,.7);
      animation:slideDown .32s ease-out
    }
    @keyframes bgShift{
      0%{background-position:0% 50%}
      50%{background-position:100% 50%}
      100%{background-position:0% 50%}
    }
    @keyframes slideDown{
      from{transform:translateY(-8px);opacity:0}
      to{transform:translateY(0);opacity:1}
    }
    @media (max-width: 640px){
      .row{flex-direction:column;align-items:flex-start}
      .val{text-align:left}
    }
  </style>
</head>
<body>
  <div class="shell">
  <div class="container">
    <div class="panel">
      <h1 class="title">Tourist Safety Emergency Card</h1>
      <div class="status ${isValid ? "status-ok" : "status-bad"}">${isValid ? "VALID CARD" : "INVALID / TAMPERED CARD"}</div>
    </div>

    ${
      isValid
        ? ""
        : `
    <div class="warning">
      WARNING<br/>
      This QR card failed cryptographic verification.<br/>
      Do NOT trust this information.
    </div>
    `
    }

    <div class="panel">
      <h2 class="section-title">Profile</h2>
      <div class="row"><div class="key">ID</div><div class="val">${safeProfile.blockchainId}</div></div>
      <div class="row"><div class="key">Name</div><div class="val">${safeProfile.name}</div></div>
      <div class="row"><div class="key">Blood Group</div><div class="val">${safeProfile.bloodGroup}</div></div>
      <div class="row"><div class="key">Allergies</div><div class="val">${safeProfile.allergies}</div></div>
      <div class="row"><div class="key">Emergency Contacts</div><div class="val">${safeProfile.emergencyContacts}</div></div>
      <div class="row"><div class="key">Address</div><div class="val">${safeProfile.address}</div></div>
    </div>

    <div class="panel">
      <h2 class="section-title">Verification</h2>
      <div class="row"><div class="key">Digital Signature</div><div class="val ${verificationResult.signatureValid ? "ok" : "bad"}">${verificationResult.signatureValid ? "VALID" : "INVALID"}</div></div>
      <div class="row"><div class="key">Blockchain Integrity</div><div class="val ${verificationResult.blockchainMatched ? "ok" : "bad"}">${verificationResult.blockchainMatched ? "VERIFIED" : "FAILED"}</div></div>
      <div class="row"><div class="key">Issued By</div><div class="val">Tourist Safety System Authority</div></div>
      <div class="row"><div class="key">Verification ID</div><div class="val">${verificationId}</div></div>
      <div class="row"><div class="key">Verified At</div><div class="val">${escapeHtml(verifiedAt)}</div></div>
    </div>
  </div>
  </div>
</body>
</html>
  `;
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
    "Server is running ✅ Use /register-ui, /auth/register, /auth/login, /scan/:id",
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

app.get("/api/test-sms", async (req, res) => {
  const result = await sendSMSViaHTTPS(
    "Test from Tourist Safety System",
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
    const {
      username,
      password,
      name,
      mobile,
      bloodGroup,
      allergies,
      emergencyContacts,
      address,
    } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: "username and password required" });
    if (users.has(username))
      return res.status(409).json({ error: "username already exists" });

    if (!name || !mobile || !bloodGroup || !emergencyContacts || !address) {
      return res.status(400).json({ error: "Missing profile fields" });
    }

    const passHash = await bcryptHash(password, 10);
    const blockchainId = "TID-" + crypto.randomBytes(6).toString("hex");

    const profile = {
      blockchainId,
      username,
      name,
      mobile,
      bloodGroup,
      allergies: allergies || "",
      emergencyContacts,
      address,
      aadhaarVerified: false,
      createdAt: new Date().toISOString(),
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
      name,
      phone: mobile || emergencyContacts || "",
      emergencyContact: emergencyContacts || mobile || "",
    });
    profiles.set(blockchainId, profile);
    saveData();

    const signableProfile = buildSignableQrProfile({
      blockchainId,
      name,
      bloodGroup,
      allergies: allergies || "",
      emergencyContacts,
      address,
      onChainHash: profileHash,
    });
    const signature = await signProfile(signableProfile, signingWallet);
    const qrPayload = {
      type: "TouristSafetyEmergencyCard",
      ...signableProfile,
      signature,
      issuerPublicKey,
    };
    const requestBaseUrl = getPublicBaseUrl(req);
    const scanUrl = `${process.env.FRONTEND_URL || "https://tourist-safety-system-theta.vercel.app"}/#/verify/${blockchainId}`;
    const verificationUrl = buildVerificationUrl(qrPayload, requestBaseUrl);
    const qrDataUrl = await QRCode.toDataURL(scanUrl);

    res.json({
      message:
        chainWriteStatus === "success"
          ? "registered"
          : "registered locally (blockchain write pending)",
      blockchainId,
      txHash,
      chainWriteStatus,
      chainWriteError,
      scanUrl,
      verificationUrl,
      qrDataUrl,
      qrText: scanUrl,
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

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "2h" });
    const profile = profiles.get(u.blockchainId) || null;
    res.json({
      token,
      blockchainId: u.blockchainId,
      profile: profile
        ? {
            blockchainId: profile.blockchainId,
            name: profile.name,
            mobile: profile.mobile || "",
            emergencyContacts: profile.emergencyContacts || "",
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
    phone: u.phone || profile?.mobile || profile?.emergencyContacts || "",
    emergencyContact:
      u.emergencyContact || profile?.emergencyContacts || profile?.mobile || "",
    blockchainId: u.blockchainId,
    bloodGroup: profile?.bloodGroup || "",
    profile: profile
      ? {
          blockchainId: profile.blockchainId,
          name: profile.name,
          mobile: profile.mobile || "",
          emergencyContacts: profile.emergencyContacts || "",
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

app.post("/verify-signature", async (req, res) => {
  try {
    const { profile, signature, publicKey } = req.body || {};
    if (!profile || !signature || !publicKey) {
      return res.status(400).json({
        valid: false,
        error: "profile, signature and publicKey are required",
      });
    }

    const valid = await verifyProfile(profile, signature, publicKey);
    return res.json({ valid });
  } catch (err) {
    console.log("VERIFY SIGNATURE ERROR:", err);
    return res.status(500).json({ valid: false });
  }
});

app.get("/verify-card", async (req, res) => {
  const requestTimestamp = new Date().toISOString();
  const requestIp = getClientIp(req);
  const fallbackResult = {
    signatureValid: false,
    blockchainMatched: false,
    issuerValid: false,
    finalStatus: "INVALID",
    verificationId: "VER-UNKNOWN",
    timestamp: requestTimestamp,
  };

  try {
    const payload = String(req.query.payload || "").trim();
    let parsed = null;
    let signableProfile = buildSignableQrProfile({});

    try {
      if (!payload || payload.length > 20000)
        throw new Error("Missing or oversized payload");
      const decoded = Buffer.from(payload, "base64").toString("utf8");
      parsed = JSON.parse(decoded);
      signableProfile = buildSignableQrProfile(parsed || {});
    } catch {
      const verificationId = await appendVerificationLog({
        blockchainId: signableProfile.blockchainId || "UNKNOWN",
        timestamp: requestTimestamp,
        ipAddress: requestIp,
        signatureValid: false,
        blockchainMatched: false,
        finalStatus: "INVALID",
      });
      fallbackResult.verificationId = verificationId;
      return res
        .status(400)
        .send(renderVerificationPage(signableProfile, fallbackResult));
    }

    const payloadValidation = validateVerifyCardPayload(parsed);
    if (!payloadValidation.valid) {
      const verificationId = await appendVerificationLog({
        blockchainId: signableProfile.blockchainId || "UNKNOWN",
        timestamp: requestTimestamp,
        ipAddress: requestIp,
        signatureValid: false,
        blockchainMatched: false,
        finalStatus: "INVALID",
      });
      fallbackResult.verificationId = verificationId;
      return res
        .status(400)
        .send(renderVerificationPage(signableProfile, fallbackResult));
    }

    const normalizedPayloadIssuer = normalizeAddress(parsed.issuerPublicKey);
    const normalizedTrustedIssuer = normalizeAddress(TRUSTED_ISSUER_PUBLIC_KEY);
    const issuerValid = Boolean(
      normalizedPayloadIssuer &&
      normalizedTrustedIssuer &&
      normalizedPayloadIssuer === normalizedTrustedIssuer,
    );

    const verificationResult = {
      signatureValid: false,
      blockchainMatched: false,
      issuerValid,
      finalStatus: "INVALID",
      verificationId: "VER-UNKNOWN",
      timestamp: requestTimestamp,
    };

    if (issuerValid) {
      const signature = String(parsed.signature || "");
      verificationResult.signatureValid = await verifyProfile(
        signableProfile,
        signature,
        normalizedPayloadIssuer,
      );

      if (verificationResult.signatureValid) {
        try {
          const localProfile = profiles.get(
            String(signableProfile.blockchainId || ""),
          );
          if (localProfile) {
            const localRecomputedHash = sha256Hex(JSON.stringify(localProfile));
            const [onChainHash] = await contract.getRecord(
              String(signableProfile.blockchainId || ""),
            );
            const chainHash = String(onChainHash || "").toLowerCase();
            verificationResult.blockchainMatched =
              localRecomputedHash.toLowerCase() === chainHash &&
              String(signableProfile.onChainHash || "").toLowerCase() ===
                chainHash;
          }
        } catch {
          verificationResult.blockchainMatched = false;
        }
      }
    }

    verificationResult.finalStatus =
      verificationResult.issuerValid &&
      verificationResult.signatureValid &&
      verificationResult.blockchainMatched
        ? "VALID"
        : "INVALID";

    verificationResult.verificationId = await appendVerificationLog({
      blockchainId: signableProfile.blockchainId || "UNKNOWN",
      timestamp: requestTimestamp,
      ipAddress: requestIp,
      signatureValid: verificationResult.signatureValid,
      blockchainMatched: verificationResult.blockchainMatched,
      finalStatus: verificationResult.finalStatus,
    });

    return res
      .status(verificationResult.finalStatus === "VALID" ? 200 : 400)
      .send(renderVerificationPage(signableProfile, verificationResult));
  } catch (err) {
    console.log("VERIFY CARD ERROR:", err);
    try {
      fallbackResult.verificationId = await appendVerificationLog({
        blockchainId: "UNKNOWN",
        timestamp: requestTimestamp,
        ipAddress: requestIp,
        signatureValid: false,
        blockchainMatched: false,
        finalStatus: "INVALID",
      });
    } catch {}
    return res
      .status(400)
      .send(renderVerificationPage(buildSignableQrProfile({}), fallbackResult));
  }
});
// ===== Scan / Verify Page =====
app.get("/scan/:blockchainId", async (req, res) => {
  try {
    const { blockchainId } = req.params;

    const profile = profiles.get(blockchainId);
    if (!profile) {
      return res.status(404).send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Traveller Safety — Verify</title>
  <style>
    body{font-family:Arial; max-width:720px; margin:40px auto; padding:0 16px;}
    .card{border:1px solid #ddd; border-radius:12px; padding:16px; margin-bottom:16px;}
    .bad{color:red;font-weight:bold}
    code{background:#f5f5f5;padding:2px 6px;border-radius:6px; word-break:break-all}
  </style>
</head>
<body>
  <h2>Traveller Safety — Verify</h2>
  <div class="card">
    <p class="bad"><b>Profile not found</b></p>
    <p><b>ID:</b> <code>${escapeHtml(blockchainId)}</code></p>
  </div>
</body>
</html>
      `);
    }

    const localHash = sha256Hex(JSON.stringify(profile));

    let onChainHash = null;
    let onChainAvailable = true;
    let onChainError = "";

    try {
      const record = await contract.getRecord(blockchainId);
      onChainHash = record?.[0] || null;
    } catch (err) {
      onChainAvailable = false;
      onChainError = String(
        err?.shortMessage || err?.reason || err?.message || err,
      );
    }

    const match =
      Boolean(onChainHash) &&
      localHash.toLowerCase() === String(onChainHash).toLowerCase();

    const safe = {
      blockchainId: escapeHtml(profile.blockchainId || ""),
      name: escapeHtml(profile.name || ""),
      bloodGroup: escapeHtml(profile.bloodGroup || ""),
      allergies: escapeHtml(profile.allergies || "-"),
      emergencyContacts: escapeHtml(profile.emergencyContacts || ""),
      address: escapeHtml(profile.address || ""),
      localHash: escapeHtml(localHash || ""),
      onChainHash: escapeHtml(onChainHash ? String(onChainHash) : "N/A"),
      onChainError: escapeHtml(onChainError || ""),
    };

    return res.status(200).send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Traveller Safety — Verify</title>
  <style>
    body{font-family:Arial; max-width:720px; margin:40px auto; padding:0 16px;}
    .card{border:1px solid #ddd; border-radius:12px; padding:16px; margin-bottom:16px;}
    .ok{color:green;font-weight:bold}
    .bad{color:red;font-weight:bold}
    code{background:#f5f5f5;padding:2px 6px;border-radius:6px; word-break:break-all}
    .muted{color:#666}
  </style>
</head>
<body>
  <h2>Traveller Safety — Verify</h2>

  <div class="card">
    <h3>Emergency Profile</h3>
    <p><b>ID:</b> <code>${safe.blockchainId}</code></p>
    <p><b>Name:</b> ${safe.name}</p>
    <p><b>Blood Group:</b> ${safe.bloodGroup}</p>
    <p><b>Allergies:</b> ${safe.allergies}</p>
    <p><b>Emergency Contacts:</b> ${safe.emergencyContacts}</p>
    <p><b>Address:</b> ${safe.address}</p>
  </div>

  <div class="card">
    <h3>Blockchain Proof</h3>
    <p>Status: ${match ? "<span class='ok'>VALID</span>" : "<span class='bad'>NOT MATCHING</span>"}</p>
    <p><b>Local Hash:</b> <code>${safe.localHash}</code></p>
    <p><b>On-chain Hash:</b> <code>${safe.onChainHash}</code></p>
    ${onChainAvailable ? "" : `<p class="muted"><b>On-chain read:</b> ${safe.onChainError}</p>`}
  </div>
</body>
</html>
    `);
  } catch (err) {
    return res.status(500).send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Traveller Safety — Verify</title>
</head>
<body>
  <h2>Traveller Safety — Verify</h2>
  <p><b>Verify failed:</b> ${escapeHtml(String(err?.message || err || "unknown error"))}</p>
</body>
</html>
    `);
  }
});

// ===== My Card (QR after login) =====
app.get("/my-card", authMiddleware, async (req, res) => {
  try {
    const { username } = req.user;
    const u = users.get(username);
    if (!u) return res.status(404).json({ error: "user not found" });

    const profile = profiles.get(u.blockchainId);
    if (!profile) return res.status(404).json({ error: "profile not found" });

    const onChainHash = sha256Hex(JSON.stringify(profile));
    const requestBaseUrl = getPublicBaseUrl(req);
    const scanUrl = `${process.env.FRONTEND_URL || "https://tourist-safety-system-theta.vercel.app"}/#/verify/${u.blockchainId}`;
    const signableProfile = buildSignableQrProfile({
      blockchainId: u.blockchainId,
      name: profile.name,
      bloodGroup: profile.bloodGroup,
      allergies: profile.allergies || "",
      emergencyContacts: profile.emergencyContacts,
      address: profile.address,
      onChainHash,
    });
    const signature = await signProfile(signableProfile, signingWallet);
    const qrPayload = {
      type: "TouristSafetyEmergencyCard",
      ...signableProfile,
      signature,
      issuerPublicKey,
    };
    const verificationUrl = buildVerificationUrl(qrPayload, requestBaseUrl);
    const qrDataUrl = await QRCode.toDataURL(scanUrl);

    res.json({
      username,
      blockchainId: u.blockchainId,
      scanUrl,
      verificationUrl,
      qrDataUrl,
      qrText: scanUrl,
    });
  } catch (err) {
    res.status(500).json({ error: "my-card failed", details: String(err) });
  }
});

(async function start() {
  try {
    await initBlockchain();
    if (blockchainReady) {
      await resyncChainFromLocal(); // ✅ ADD THIS LINE
    }
  } catch (e) {
    console.warn("Startup initialization warning:", e?.message || String(e));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on LAN at ${BASE_URL}`);
  });
})();
