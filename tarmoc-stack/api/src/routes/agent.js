const express = require('express');
const db = require('../db');
const { generateToken, hashToken } = require('../lib/token');
const { requireAgentToken } = require('../lib/auth');
const { evaluateReading } = require('../lib/alertEngine');

const router = express.Router();

// POST /api/agent/register
// Called once when installing an agent on a new server. Returns the plaintext token —
// only shown here, only the sha256 hash is stored (MD-02 section 28/35).
router.post('/register', async (req, res) => {
  const { name, hostname, ip_address, os, os_version, architecture, environment, type, tags, cores, threads, ram_total_gb, disk_total_gb } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const token = generateToken();
  const tokenHash = hashToken(token);

  try {
    const { rows } = await db.query(
      `INSERT INTO servers (name, hostname, ip_address, os, os_version, architecture, environment, type, tags, cores, threads, ram_total_gb, disk_total_gb, agent_token_hash, agent_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, NULL)
       ON CONFLICT (name) DO UPDATE SET
         hostname = EXCLUDED.hostname, ip_address = EXCLUDED.ip_address, os = EXCLUDED.os,
         os_version = EXCLUDED.os_version, architecture = EXCLUDED.architecture,
         environment = EXCLUDED.environment, type = EXCLUDED.type, tags = EXCLUDED.tags,
         cores = EXCLUDED.cores, threads = EXCLUDED.threads, ram_total_gb = EXCLUDED.ram_total_gb,
         disk_total_gb = EXCLUDED.disk_total_gb, agent_token_hash = EXCLUDED.agent_token_hash,
         updated_at = now()
       RETURNING id, name`,
      [name, hostname, ip_address, os, os_version, architecture, environment || 'production', type || 'Virtual machine', tags || [], cores, threads, ram_total_gb, disk_total_gb, tokenHash]
    );
    await db.query(`INSERT INTO audit_log (action, server_id, ip, result) VALUES ('agent.register', $1, $2, 'success')`, [rows[0].id, req.ip]);
    res.status(201).json({ server_id: rows[0].id, name: rows[0].name, token });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Server name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to register server' });
  }
});

// POST /api/agent/heartbeat  — header: X-Agent-Token
router.post('/heartbeat', requireAgentToken, async (req, res) => {
  const { uptime_seconds, agent_version } = req.body;
  await db.query(
    `UPDATE servers SET last_seen_at = now(), uptime_seconds = COALESCE($1, uptime_seconds), agent_version = COALESCE($2, agent_version), updated_at = now() WHERE id = $3`,
    [uptime_seconds, agent_version, req.server.id]
  );
  res.json({ ok: true, server_id: req.server.id });
});

// POST /api/agent/metrics  — header: X-Agent-Token
router.post('/metrics', requireAgentToken, async (req, res) => {
  const raw = req.body;
  // A usage percentage is never legitimately outside 0–100. Clamping here means a bug
  // in any agent (now or a future one) can't corrupt stored history or fire bogus
  // alerts — this is what would have silently capped the "408%" disk reading at 100%.
  const clampPct = (v) => (v === undefined || v === null || Number.isNaN(Number(v))) ? null : Math.max(0, Math.min(100, Number(v)));
  const cpu_usage = clampPct(raw.cpu_usage);
  const ram_usage = clampPct(raw.ram_usage);
  const disk_usage = clampPct(raw.disk_usage);
  const { network_rx, network_tx, load_1, load_5, load_15, temperature } = raw;

  await db.query(
    `INSERT INTO server_metrics (server_id, cpu_usage, ram_usage, disk_usage, network_rx, network_tx, load_1, load_5, load_15, temperature)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [req.server.id, cpu_usage, ram_usage, disk_usage, network_rx, network_tx, load_1, load_5, load_15, temperature]
  );
  await db.query(`UPDATE servers SET last_seen_at = now() WHERE id = $1`, [req.server.id]);

  await evaluateReading(req.server.id, { cpu_usage, ram_usage, disk_usage, temperature });

  res.status(201).json({ ok: true });
});

module.exports = router;
