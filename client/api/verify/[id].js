module.exports = async (req, res) => {
  const { id } = req.query;
  const RAILWAY_URL = process.env.VITE_API_URL || 'https://tourist-safety-system-production.up.railway.app';
  try {
    const https = require('https');
    const url = new URL(`${RAILWAY_URL}/api/verify/${id}`);
    const data = await new Promise((resolve, reject) => {
      https.get(url.href, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve(body));
      }).on('error', reject);
    });
    res.status(200).json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
