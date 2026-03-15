module.exports = (req, res) => {
  res.json({ pong: true, time: Date.now() });
};