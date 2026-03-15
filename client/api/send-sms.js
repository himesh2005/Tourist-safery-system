function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  const method = String(req.method || "GET").toUpperCase();
  const hasKey = Boolean(
    process.env.FAST2SMS_KEY || process.env.FAST2SMS_API_KEY,
  );

  if (method === "OPTIONS") return res.status(200).end();

  if (method === "GET") {
    const message = req.query?.message;
    const number = req.query?.number;
    if (!message || !number) {
      return res.status(200).json({
        success: true,
        reachable: true,
        method,
        hasKey,
        note: "Use POST with JSON body or GET with ?message=...&number=...",
      });
    }
    req.body = { message, number };
  } else if (method !== "POST") {
    return res.status(200).json({
      success: false,
      error: "Unsupported method",
      method,
    });
  }

  let body = req.body || {};
  if (Buffer.isBuffer(body)) {
    body = body.toString("utf8");
  }
  if (
    method === "POST" &&
    (!body || (typeof body === "object" && Object.keys(body).length === 0))
  ) {
    try {
      const rawBody = await readRawBody(req);
      if (rawBody) {
        body = JSON.parse(rawBody);
      }
    } catch {
      body = {};
    }
  }

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({
        success: false,
        error: "Invalid JSON request body",
        method,
        hasKey,
      });
    }
  }

  const { message, number } = body;
  if (!message || !number) {
    return res.status(200).json({
      success: false,
      error: "Missing message or number",
      method,
      hasKey,
      bodyType: typeof body,
      body,
    });
  }

  const apiKey = process.env.FAST2SMS_KEY || process.env.FAST2SMS_API_KEY || "";
  if (!apiKey) {
    return res.status(200).json({
      success: false,
      error: "FAST2SMS_KEY not configured in Vercel",
      method,
      hasKey: false,
    });
  }

  const https = require("https");
  const cleanNumber = String(number)
    .replace(/^\+91/, "")
    .replace(/^91/, "")
    .replace(/[^\d,]/g, "");

  const postData = JSON.stringify({
    route: "q",
    message: String(message),
    language: "english",
    flash: 0,
    numbers: cleanNumber,
  });

  return new Promise((resolve) => {
    const request = https.request(
      {
        hostname: "api.fast2sms.com",
        port: 443,
        path: "/dev/bulkV2",
        method: "POST",
        headers: {
          authorization: apiKey,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            res.status(200).json({
              success: false,
              error: "Invalid Fast2SMS response",
              method,
              hasKey,
              statusCode: response.statusCode,
              raw: data,
            });
            resolve();
            return;
          }

          console.log("Fast2SMS response:", JSON.stringify(parsed));
          const success =
            response.statusCode >= 200 &&
            response.statusCode < 300 &&
            parsed?.return === true;

          res.status(200).json({
            success,
            method,
            hasKey,
            statusCode: response.statusCode,
            result: parsed,
            error: success ? undefined : parsed?.message || "Fast2SMS failed",
          });
          resolve();
        });
      },
    );

    request.on("error", (error) => {
      console.error("Request error:", error.message);
      res.status(200).json({
        success: false,
        method,
        hasKey,
        error: error.message || "Request failed",
      });
      resolve();
    });

    request.write(postData);
    request.end();
  });
};
