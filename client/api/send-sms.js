module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res
      .status(405)
      .json({ success: false, error: "Method not allowed" });
  }

  let body = req.body || {};
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res
        .status(400)
        .json({ success: false, error: "Invalid JSON request body" });
    }
  }

  const { message, number } = body;
  if (!message || !number) {
    return res
      .status(400)
      .json({ success: false, error: "Missing message or number" });
  }

  const apiKey = process.env.FAST2SMS_KEY || process.env.FAST2SMS_API_KEY || "";
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: "FAST2SMS_KEY not configured in Vercel",
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
            res.status(502).json({
              success: false,
              error: "Invalid Fast2SMS response",
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

          res.status(success ? 200 : 502).json({
            success,
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
      res
        .status(500)
        .json({ success: false, error: error.message || "Request failed" });
      resolve();
    });

    request.write(postData);
    request.end();
  });
};
