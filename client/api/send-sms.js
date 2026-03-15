module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });
  const { message, number } = req.body || {};
  if (!message || !number)
    return res.status(400).json({ error: "Missing fields" });
  const apiKey = process.env.FAST2SMS_KEY;
  if (!apiKey) return res.status(500).json({ error: "FAST2SMS_KEY not set" });
  const https = require("https");
  const cleanNumber = number.toString().replace(/^\+91/, "").replace(/^91/, "");
  const postData = JSON.stringify({
    route: "q",
    message,
    language: "english",
    flash: 0,
    numbers: cleanNumber,
  });
  return new Promise((resolve) => {
    const r = https.request(
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
        response.on("data", (c) => (data += c));
        response.on("end", () => {
          try {
            const result = JSON.parse(data);
            console.log("Fast2SMS:", JSON.stringify(result));
            res.status(200).json({ success: result.return === true, result });
          } catch (e) {
            res.status(200).json({ success: false, raw: data });
          }
          resolve();
        });
      },
    );
    r.on("error", (e) => {
      res.status(500).json({ success: false, error: e.message });
      resolve();
    });
    r.write(postData);
    r.end();
  });
};
