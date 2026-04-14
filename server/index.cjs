require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");

const express = require("express");
const cors = require("cors");

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { ethers, Wallet } = require("ethers");
const geofenceRoutes = require("./routes/geofence.cjs");
const emergencyRoutes = require("./routes/emergency.cjs");

const CITY_ROUTES_DIR = path.join(__dirname, "routes", "zones");

let blockchainReady = false;

const allowedOrigins = new Set([
  "https://tourist-safety-system-git-main-abhi-099a35d4.vercel.app",
  "https://tourist-safety-system.vercel.app",
  "http://localhost:5173",
]);
const vercelPreviewPattern =
  /^https:\/\/tourist-safety-system(?:-[a-z0-9-]+)?\.vercel\.app$/;
const corsOptions = {
  origin(origin, callback) {
    // Allow same-origin/curl/mobile requests with no Origin header.
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin) || vercelPreviewPattern.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 200,
};

const app = express();
app.use(cors(corsOptions));
app.options(/^\/.*$/, cors(corsOptions));
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
  "function createTouristId(string kyc, string itinerary, string emergencyContact, uint256 validUntil) external",
  "function touristIds(address) external view returns (uint256 id, string kyc, string itinerary, string emergencyContact, uint256 validUntil)",
  "function idCounter() external view returns (uint256)",
  "function createId(string blockchainId, bytes32 profileHash) external",
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
  return;
}

function hashKyc(value) {
  return "0x" + crypto.createHash("sha256").update(String(value)).digest("hex");
}

function maskKyc(value) {
  const clean = String(value || "").replace(/\s+/g, "");
  if (!clean) return "";
  const tail = clean.slice(-4);
  return `${"X".repeat(Math.max(clean.length - 4, 5))}${tail}`;
}

function isMissingFunctionRevert(err) {
  const msg = String(
    err?.shortMessage || err?.reason || err?.message || "",
  ).toLowerCase();
  return (
    msg.includes("no data present") ||
    msg.includes("missing revert data") ||
    msg.includes("function selector was not recognized")
  );
}

function isInsufficientFundsError(err) {
  const msg = String(
    err?.shortMessage || err?.reason || err?.message || err || "",
  ).toLowerCase();
  return msg.includes("insufficient funds");
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
    "Server is running. Use /auth/register, /auth/login, /me, /health",
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

// ===== AUTH =====
app.post("/api/check-username", (req, res) => {
  const username = String(req.body?.username || "").trim();
  if (!username) {
    return res.status(400).json({ available: false });
  }
  return res.json({ available: !users.has(username) });
});

app.get("/auth/register", (req, res) => {
  return res.status(405).json({
    error: "Method not allowed",
    message: "Use POST /auth/register with JSON body.",
  });
});

app.post("/auth/register", async (req, res) => {
  try {
    const {
      username,
      password,
      aadhaarOrPassport,
      itinerary,
      emergencyContact,
      validUntil,
    } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: "username and password required" });
    if (users.has(username))
      return res.status(409).json({ error: "username already exists" });

    if (!aadhaarOrPassport || !itinerary || !emergencyContact || !validUntil) {
      return res.status(400).json({
        error:
          "aadhaarOrPassport, itinerary, emergencyContact and validUntil are required",
      });
    }

    const validUntilNumber = Number(validUntil);
    if (!Number.isInteger(validUntilNumber) || validUntilNumber <= 0) {
      return res
        .status(400)
        .json({ error: "validUntil must be a unix timestamp (seconds)" });
    }

    const passHash = await bcryptHash(password, 10);
    const kycRaw = String(aadhaarOrPassport).trim();
    const itineraryText = String(itinerary).trim();
    const emergencyContactText = String(emergencyContact).trim();
    const kycHash = hashKyc(kycRaw);
    const kycMasked = maskKyc(kycRaw);

    if (!contract) {
      return res.status(503).json({
        error: "Blockchain unavailable",
        details: "Smart contract is not initialized",
      });
    }

    let onChainId = null;
    let txHash = null;
    let blockchainId = "";
    let chainMode = "createTouristId";
    let chainWriteStatus = "success";
    let chainWriteError = "";

    try {
      const tx = await contract.createTouristId(
        kycHash,
        itineraryText,
        emergencyContactText,
        validUntilNumber,
      );
      const receipt = await tx.wait();
      txHash = receipt?.hash || null;
      try {
        const latestId = await contract.idCounter();
        onChainId = Number(latestId);
      } catch {
        onChainId = null;
      }
      blockchainId =
        Number.isFinite(onChainId) && onChainId > 0
          ? `TID-${onChainId}`
          : `TID-${crypto.randomBytes(6).toString("hex")}`;
      blockchainReady = true;
    } catch (modernErr) {
      const modernErrorMessage = String(
        modernErr?.shortMessage ||
          modernErr?.reason ||
          modernErr?.message ||
          modernErr,
      );

      if (!isMissingFunctionRevert(modernErr)) {
        if (isInsufficientFundsError(modernErr)) {
          chainMode = "local_only";
          chainWriteStatus = "local_saved";
          chainWriteError = modernErrorMessage;
          blockchainId = `TID-${crypto.randomBytes(6).toString("hex")}`;
        } else {
          console.log("REGISTER CHAIN WRITE FAILED:", modernErrorMessage);
          return res.status(502).json({
            error: "Failed to create tourist ID on blockchain",
            chainWriteError: modernErrorMessage,
          });
        }
      }

      if (isMissingFunctionRevert(modernErr)) {
        // Backward compatibility for contracts that still expose createId.
        chainMode = "createId_legacy";
        blockchainId = `TID-${crypto.randomBytes(6).toString("hex")}`;
        const legacyProfileHash = sha256Hex(
          JSON.stringify({
            kycHash,
            itinerary: itineraryText,
            emergencyContact: emergencyContactText,
            validUntil: validUntilNumber,
          }),
        );

        try {
          const legacyTx = await contract.createId(blockchainId, legacyProfileHash);
          const legacyReceipt = await legacyTx.wait();
          txHash = legacyReceipt?.hash || null;
          onChainId = null;
          blockchainReady = true;
        } catch (legacyErr) {
          const modernDetails = modernErrorMessage;
          const legacyDetails = String(
            legacyErr?.shortMessage ||
              legacyErr?.reason ||
              legacyErr?.message ||
              legacyErr,
          );

          if (isInsufficientFundsError(legacyErr)) {
            chainMode = "local_only";
            chainWriteStatus = "local_saved";
            chainWriteError = `modern=${modernDetails} | legacy=${legacyDetails}`;
            txHash = null;
          } else {
            console.log(
              "REGISTER CHAIN WRITE FAILED:",
              `modern=${modernDetails} | legacy=${legacyDetails}`,
            );
            return res.status(502).json({
              error: "Failed to create tourist ID on blockchain",
              chainWriteError: `modern=${modernDetails} | legacy=${legacyDetails}`,
            });
          }
        }
      }

      if (!blockchainId) {
        blockchainId = `TID-${crypto.randomBytes(6).toString("hex")}`;
      }
    }
    const profile = {
      blockchainId,
      onChainId,
      kycHash,
      kycMasked,
      itinerary: itineraryText,
      emergencyContact: emergencyContactText,
      validUntil: validUntilNumber,
      createdAt: new Date().toISOString(),
      txHash,
      chainMode,
      chainWriteStatus,
      chainWriteError,
    };

    users.set(username, {
      username,
      passHash,
      blockchainId,
      id: blockchainId,
      emergencyContact: emergencyContactText,
      phone: emergencyContactText,
    });
    profiles.set(blockchainId, profile);
    saveData();

    res.json({
      blockchainId,
      kyc: kycMasked,
      itinerary: itineraryText,
      emergencyContact: emergencyContactText,
      validUntil: validUntilNumber,
      txHash,
      chainMode,
      chainWriteStatus,
      chainWriteError,
    });
  } catch (err) {
    console.log("REGISTER ERROR:", err);
    res.status(500).json({ error: "register failed", details: String(err) });
  }
});
app.get("/auth/login", (req, res) => {
  return res.status(405).json({
    error: "Method not allowed",
    message: "Use POST /auth/login with JSON body.",
  });
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
            kyc: profile.kycMasked || "",
            itinerary: profile.itinerary || "",
            emergencyContact: profile.emergencyContact || "",
            validUntil: profile.validUntil || null,
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
    name: u.name || username,
    phone: u.phone || profile?.emergencyContact || "",
    emergencyContact: u.emergencyContact || profile?.emergencyContact || "",
    blockchainId: u.blockchainId,
    kyc: profile?.kycMasked || "",
    itinerary: profile?.itinerary || "",
    validUntil: profile?.validUntil || null,
    profile: profile
      ? {
          blockchainId: profile.blockchainId,
          kyc: profile.kycMasked || "",
          itinerary: profile.itinerary || "",
          emergencyContact: profile.emergencyContact || "",
          validUntil: profile.validUntil || null,
        }
      : null,
  });
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
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Server running on LAN at ${BASE_URL}`);
    console.log(`CORS middleware initialized. Server ready on port ${PORT}`);
  });
})();





