const db = require('../db');
const { hashToken } = require('./token');

// Protects dashboard/admin routes: create/update/delete servers, manage rules, acknowledge alerts.
function requireAdminKey(req, res, next) {
  const key = req.header('X-Admin-Key');
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid X-Admin-Key' });
  }
  next();
}

// Protects agent ingestion routes: heartbeat, metrics.
async function requireAgentToken(req, res, next) {
  const token = req.header('X-Agent-Token');
  if (!token) return res.status(401).json({ error: 'Missing X-Agent-Token header' });

  const hash = hashToken(token);
  const { rows } = await db.query('SELECT id, name FROM servers WHERE agent_token_hash = $1', [hash]);
  if (!rows.length) return res.status(403).json({ error: 'Invalid agent token' });

  req.server = rows[0];
  next();
}

module.exports = { requireAdminKey, requireAgentToken };
