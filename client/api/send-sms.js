module.exports = function(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'not allowed' });
    return;
  }
  res.status(200).json({
    ok: true,
    bodyType: typeof req.body,
    body: JSON.stringify(req.body),
    hasKey: !!process.env.FAST2SMS_KEY
  });
};