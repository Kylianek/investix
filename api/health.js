/* GET /api/health - jestli API běží a jestli je napojená databáze (bez jakýchkoli tajných údajů). */
const { ping } = require('./_db');

module.exports = async (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ api: true, ...(await ping()) }));
};
