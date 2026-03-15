export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { message, number } = req.body || {};

  if (!message || !number) {
    return res.status(400).json({ error: "Missing message or number" });
  }

  try {
    const response = await fetch("https://api.fast2sms.com/dev/bulkV2", {
      method: "POST",
      headers: {
        authorization: process.env.FAST2SMS_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        route: "q",
        message,
        language: "english",
        flash: 0,
        numbers: number.toString().replace(/^\+91/, "").replace(/^91/, ""),
      }),
    });

    const result = await response.json();
    console.log("Fast2SMS result:", result);

    if (result.return === true) {
      return res.status(200).json({ success: true, result });
    }

    return res.status(200).json({ success: false, error: result.message });
  } catch (err) {
    console.error("SMS error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
