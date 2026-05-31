module.exports = async (req, res) => {
  const { id } = req.query;
  const RAILWAY_URL =
    process.env.VITE_API_URL ||
    "https://tourist-safety-system-production-c1e5.up.railway.app";
  const https = require("https");
  return new Promise((resolve) => {
    https
      .get(`${RAILWAY_URL}/api/verify/${id}`, (response) => {
        let data = "";
        response.on("data", (c) => (data += c));
        response.on("end", () => {
          try {
            res.status(200).json(JSON.parse(data));
          } catch (e) {
            res.status(500).json({ error: "parse error" });
          }
          resolve();
        });
      })
      .on("error", (e) => {
        res.status(500).json({ error: e.message });
        resolve();
      });
  });
};
