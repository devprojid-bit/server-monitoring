const express = require('express');
const db = require('../db');
const { requireAdminKey } = require('../lib/auth');
const { computeStatus } = require('../lib/status');
const { generateToken, hashToken } = require('../lib/token');

const router = express.Router();

// Attach computed status + latest metric snapshot to a row of servers.
async function withLiveState(serverRows) {
  if (!serverRows.length) return [];
  const ids = serverRows.map((s) => s.id);

  const { rows: latestMetrics } = await db.query(
    `SELECT DISTINCT ON (server_id) *
     FROM server_metrics
     WHERE server_id = ANY($1)
     ORDER BY server_id, timestamp DESC`,
    [ids]
  );
  const metricByServer = Object.fromEntries(latestMetrics.map((m) => [m.server_id, m]));

  const { rows: activeAlerts } = await db.query(
    `SELECT server_id, severity FROM alerts WHERE server_id = ANY($1) AND status = 'active'`,
    [ids]
  );
  const alertsByServer = {};
  for (const a of activeAlerts) {
    (alertsByServer[a.server_id] = alertsByServer[a.server_id] || []).push(a.severity);
  }

  return serverRows.map((s) => {
    const m = metricByServer[s.id] || {};
    return {
      ...s,
      status: computeStatus(s.last_seen_at, alertsByServer[s.id] || []),
      cpu_usage: m.cpu_usage ?? null,
      ram_usage: m.ram_usage ?? null,
      disk_usage: m.disk_usage ?? null,
      network_rx: m.network_rx ?? null,
      network_tx: m.network_tx ?? null,
      temperature: m.temperature ?? null,
      load_1: m.load_1 ?? null,
      load_5: m.load_5 ?? null,
      load_15: m.load_15 ?? null,
      metrics_at: m.timestamp ?? null,
      active_alert_count: (alertsByServer[s.id] || []).length,
    };
  });
}

// GET /api/monitoring/servers
router.get('/', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM servers ORDER BY name ASC');
  res.json(await withLiveState(rows));
});

// GET /api/monitoring/servers/:id
router.get('/:id', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM servers WHERE id = $1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Server not found' });
  const [server] = await withLiveState(rows);
  res.json(server);
});

// POST /api/monitoring/servers — pre-provision a server from the dashboard (MD-02 section 28).
// Generates an agent token the person then uses to install the agent on the target machine.
router.post('/', requireAdminKey, async (req, res) => {
  const { name, hostname, ip_address, os, environment, type, tags } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const token = generateToken();
  const tokenHash = hashToken(token);

  try {
    const { rows } = await db.query(
      `INSERT INTO servers (name, hostname, ip_address, os, environment, type, tags, agent_token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, hostname, ip_address, os, environment || 'production', type || 'Virtual machine', tags || [], tokenHash]
    );
    await db.query(`INSERT INTO audit_log (action, server_id, ip, result) VALUES ('server.create', $1, $2, 'success')`, [rows[0].id, req.ip]);
    res.status(201).json({ ...rows[0], token }); // token only ever shown here
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Server name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to create server' });
  }
});

// PUT /api/monitoring/servers/:id  — edit metadata (name, env, tags, etc). Admin only.
router.put('/:id', requireAdminKey, async (req, res) => {
  const fields = ['name', 'hostname', 'ip_address', 'os', 'os_version', 'environment', 'type', 'tags'];
  const updates = [];
  const values = [];
  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      values.push(req.body[f]);
      updates.push(`${f} = $${values.length}`);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  const { rows } = await db.query(
    `UPDATE servers SET ${updates.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'Server not found' });
  await db.query(`INSERT INTO audit_log (action, server_id, result) VALUES ('server.update', $1, 'success')`, [req.params.id]);
  res.json(rows[0]);
});

// DELETE /api/monitoring/servers/:id — admin only, dangerous action per MD-02 section 32.
router.delete('/:id', requireAdminKey, async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM servers WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Server not found' });
  await db.query(`INSERT INTO audit_log (action, server_id, result) VALUES ('server.delete', $1, 'success')`, [req.params.id]);
  res.status(204).send();
});

// GET /api/monitoring/servers/:id/metrics — latest single reading
router.get('/:id/metrics', async (req, res) => {
  const { rows } = await db.query(
    `SELECT * FROM server_metrics WHERE server_id = $1 ORDER BY timestamp DESC LIMIT 1`,
    [req.params.id]
  );
  res.json(rows[0] || null);
});

const RANGE_TO_INTERVAL = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

// GET /api/monitoring/servers/:id/history?range=24h
router.get('/:id/history', async (req, res) => {
  const range = RANGE_TO_INTERVAL[req.query.range] || RANGE_TO_INTERVAL['24h'];
  const { rows } = await db.query(
    `SELECT timestamp, cpu_usage, ram_usage, disk_usage, network_rx, network_tx, temperature, load_1, load_5, load_15
     FROM server_metrics
     WHERE server_id = $1 AND timestamp > now() - $2::interval
     ORDER BY timestamp ASC`,
    [req.params.id, range]
  );
  res.json(rows);
});

module.exports = { router, withLiveState };
