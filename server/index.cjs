require("dotenv").config();
const fs = require("fs");
const path = require("path");
const os = require("os");

const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { ethers, Wallet, getAddress } = require("ethers");
const { signProfile, verifyProfile } = require("./utils/signature.cjs");
const { appendVerificationLog } = require("./utils/verificationLogger.cjs");
const geofenceRoutes = require("./routes/geofence.cjs");
const emergencyRoutes = require("./routes/emergency.cjs");

const app = express();
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/", geofenceRoutes);
app.use("/", emergencyRoutes);

// ===== ENV =====
const RPC_URL = (process.env.AMOY_RPC_URL || "").trim();
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
const DATA_PATH = path.join(__dirname, "data.json");

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return { users: {}, profiles: {} };
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch (e) {
    console.log("Failed to load data.json:", e);
    return { users: {}, profiles: {} };
  }
}

const loaded = loadData();
const users = new Map(Object.entries(loaded.users || {})); // username -> { username, passHash, blockchainId }
const profiles = new Map(Object.entries(loaded.profiles || {})); // blockchainId -> profile
console.log("Loaded users:", users.size, "Loaded profiles:", profiles.size);

function saveData() {
  const usersObj = Object.fromEntries(users.entries());
  const profilesObj = Object.fromEntries(profiles.entries());
  fs.writeFileSync(
    DATA_PATH,
    JSON.stringify({ users: usersObj, profiles: profilesObj }, null, 2),
  );
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
  console.log("BAD AMOY_RPC_URL:", RPC_URL);
  console.log("Fix: set AMOY_RPC_URL in server/.env");
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
  wallet = await getIssuerWallet();
  contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
}

async function resyncChainFromLocal() {
  const ids = Array.from(profiles.keys());
  if (ids.length === 0) return;

  console.log(`Resync: checking ${ids.length} profiles on-chain...`);

  for (const blockchainId of ids) {
    const profile = profiles.get(blockchainId);
    const localHash = sha256Hex(JSON.stringify(profile));

    try {
      // Try reading (if exists, skip)
      await contract.getRecord(blockchainId);
      // If getRecord works, record exists → continue
    } catch (e) {
      // If reverted "ID not found" → re-create on chain
      const msg = String(e?.shortMessage || e?.reason || e?.message || "");
      if (msg.includes("ID not found") || msg.includes("CALL_EXCEPTION")) {
        console.log("Resync: writing missing ID:", blockchainId);
        const tx = await contract.createId(blockchainId, localHash);
        await tx.wait();
      } else {
        console.log("Resync: unexpected error for", blockchainId, msg);
      }
    }
  }

  console.log("Resync complete ✅");
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

function buildVerificationUrl(qrPayload) {
  const base64Payload = Buffer.from(JSON.stringify(qrPayload), "utf8").toString(
    "base64",
  );
  return `${BASE_URL}/verify-card?payload=${encodeURIComponent(base64Payload)}`;
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
      bloodGroup,
      allergies,
      emergencyContacts,
      address,
    } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: "username and password required" });
    if (users.has(username))
      return res.status(409).json({ error: "username already exists" });

    if (!name || !bloodGroup || !emergencyContacts || !address) {
      return res.status(400).json({ error: "Missing profile fields" });
    }

    const passHash = await bcryptHash(password, 10);
    const blockchainId = "TID-" + crypto.randomBytes(6).toString("hex");

    const profile = {
      blockchainId,
      username,
      name,
      bloodGroup,
      allergies: allergies || "",
      emergencyContacts,
      address,
      aadhaarVerified: false,
      createdAt: new Date().toISOString(),
    };

    const profileHash = sha256Hex(JSON.stringify(profile));

    // Write to blockchain
    const tx = await contract.createId(blockchainId, profileHash);
    const receipt = await tx.wait();

    // Save locally
    users.set(username, { username, passHash, blockchainId });
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
    const scanUrl = `${BASE_URL}/scan/${blockchainId}`;
    const verificationUrl = buildVerificationUrl(qrPayload);
    const qrDataUrl = await QRCode.toDataURL(verificationUrl);

    res.json({
      message: "registered",
      blockchainId,
      txHash: receipt.hash,
      scanUrl,
      verificationUrl,
      qrDataUrl,
      qrText: verificationUrl,
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
    res.json({ token, blockchainId: u.blockchainId });
  } catch (err) {
    res.status(500).json({ error: "login failed", details: String(err) });
  }
});

app.get("/me", authMiddleware, (req, res) => {
  const { username } = req.user;
  const u = users.get(username);
  if (!u) return res.status(404).json({ error: "user not found" });
  res.json({ username, blockchainId: u.blockchainId });
});

// ===== VERIFY API =====
app.get("/api/verify/:blockchainId", async (req, res) => {
  try {
    const { blockchainId } = req.params;

    const profile = profiles.get(blockchainId);
    if (!profile)
      return res.status(404).json({ error: "Profile not found (local store)" });

    const localHash = sha256Hex(JSON.stringify(profile));
    const [onChainHash] = await contract.getRecord(blockchainId);

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
        match: localHash.toLowerCase() === String(onChainHash).toLowerCase(),
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
app.get("/scan/:blockchainId", (req, res) => {
  const { blockchainId } = req.params;
  res.send(`
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
  </style>
</head>
<body>
  <h2>Traveller Safety — Verify</h2>
  <div id="root">Loading…</div>

<script>
(async function(){
  const res = await fetch("/api/verify/${blockchainId}");
  const root = document.getElementById("root");

  if(!res.ok){
    const text = await res.text();
    root.innerHTML = "<p>Verify failed: " + text + "</p>";
    return;
  }

  const data = await res.json();
  const p = data.profile;
  const proof = data.proof;

  root.innerHTML = \`
    <div class="card">
      <h3>Emergency Profile</h3>
      <p><b>ID:</b> <code>\${p.blockchainId}</code></p>
      <p><b>Name:</b> \${p.name}</p>
      <p><b>Blood Group:</b> \${p.bloodGroup}</p>
      <p><b>Allergies:</b> \${p.allergies || "-"}</p>
      <p><b>Emergency Contacts:</b> \${p.emergencyContacts}</p>
      <p><b>Address:</b> \${p.address}</p>
    </div>

    <div class="card">
      <h3>Blockchain Proof</h3>
      <p>Status: \${proof.match ? "<span class='ok'>VALID</span>" : "<span class='bad'>NOT MATCHING</span>"}</p>
      <p><b>Local Hash:</b> <code>\${proof.localHash}</code></p>
      <p><b>On-chain Hash:</b> <code>\${proof.onChainHash}</code></p>
    </div>
  \`;
})();
</script>
</body>
</html>
  `);
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
    const scanUrl = `${BASE_URL}/scan/${u.blockchainId}`;
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
    const verificationUrl = buildVerificationUrl(qrPayload);
    const qrDataUrl = await QRCode.toDataURL(verificationUrl);

    res.json({
      username,
      blockchainId: u.blockchainId,
      scanUrl,
      verificationUrl,
      qrDataUrl,
      qrText: verificationUrl,
    });
  } catch (err) {
    res.status(500).json({ error: "my-card failed", details: String(err) });
  }
});

(async function start() {
  try {
    await initBlockchain();
    await resyncChainFromLocal(); // ✅ ADD THIS LINE
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on LAN at ${BASE_URL}`);
    });
  } catch (e) {
    console.error("Startup failed:", e);
    process.exit(1);
  }
})();
