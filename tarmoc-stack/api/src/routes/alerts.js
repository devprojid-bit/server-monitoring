const express = require('express');
const db = require('../db');
const { requireAdminKey } = require('../lib/auth');

const router = express.Router();

// GET /api/monitoring/alerts?status=active&server_id=...
router.get('/', async (req, res) => {
  const conditions = [];
  const values = [];
  if (req.query.status) { values.push(req.query.status); conditions.push(`a.status = $${values.length}`); }
  if (req.query.server_id) { values.push(req.query.server_id); conditions.push(`a.server_id = $${values.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await db.query(
    `SELECT a.*, s.name AS server_name
     FROM alerts a JOIN servers s ON s.id = a.server_id
     ${where}
     ORDER BY a.started_at DESC
     LIMIT 200`,
    values
  );
  res.json(rows);
});

// POST /api/monitoring/alerts/rules — admin only
router.post('/rules', requireAdminKey, async (req, res) => {
  const { server_id, metric, operator, threshold, duration_seconds, severity } = req.body;
  if (!metric || threshold === undefined || !severity) {
    return res.status(400).json({ error: 'metric, threshold and severity are required' });
  }
  const { rows } = await db.query(
    `INSERT INTO alert_rules (server_id, metric, operator, threshold, duration_seconds, severity)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [server_id || null, metric, operator || '>', threshold, duration_seconds || 0, severity]
  );
  res.status(201).json(rows[0]);
});

// PUT /api/monitoring/alerts/rules/:id — admin only
router.put('/rules/:id', requireAdminKey, async (req, res) => {
  const { operator, threshold, duration_seconds, severity, enabled } = req.body;
  const { rows } = await db.query(
    `UPDATE alert_rules SET
       operator = COALESCE($1, operator), threshold = COALESCE($2, threshold),
       duration_seconds = COALESCE($3, duration_seconds), severity = COALESCE($4, severity),
       enabled = COALESCE($5, enabled)
     WHERE id = $6 RETURNING *`,
    [operator, threshold, duration_seconds, severity, enabled, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Rule not found' });
  res.json(rows[0]);
});

// GET /api/monitoring/alerts/rules
router.get('/rules', async (req, res) => {
  const { rows } = await db.query(`SELECT * FROM alert_rules ORDER BY metric, threshold`);
  res.json(rows);
});

// POST /api/monitoring/alerts/:id/acknowledge — admin only
router.post('/:id/acknowledge', requireAdminKey, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE alerts SET status = 'acknowledged' WHERE id = $1 AND status = 'active' RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Active alert not found' });
  await db.query(`INSERT INTO audit_log (action, server_id, result) VALUES ('alert.acknowledge', $1, 'success')`, [rows[0].server_id]);
  res.json(rows[0]);
});

// POST /api/monitoring/alerts/:id/resolve — admin only
router.post('/:id/resolve', requireAdminKey, async (req, res) => {
  const { rows } = await db.query(
    `UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
  res.json(rows[0]);
});

module.exports = router;
