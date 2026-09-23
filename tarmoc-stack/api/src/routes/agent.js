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

// POST /api/agent/containers  — header: X-Agent-Token
// Body: { containers: [{ id, name, image, state, status, cpu_percent, mem_used_bytes,
//                         mem_limit_bytes, net_rx_bytes, net_tx_bytes, restart_count, started_at }] }
// Upserts the current set for this server and removes any not present in this report
// (i.e. containers that were removed since the last check). MD-02 section 14.
router.post('/containers', requireAgentToken, async (req, res) => {
  const list = Array.isArray(req.body.containers) ? req.body.containers : [];
  const serverId = req.server.id;

  const seenIds = list.map((c) => c.id).filter(Boolean);
  if (seenIds.length) {
    await db.query(
      `DELETE FROM containers WHERE server_id = $1 AND container_id <> ALL($2::text[])`,
      [serverId, seenIds]
    );
  } else {
    await db.query(`DELETE FROM containers WHERE server_id = $1`, [serverId]);
  }

  for (const c of list) {
    if (!c.id || !c.name) continue;
    await db.query(
      `INSERT INTO containers (server_id, container_id, name, image, state, status, cpu_percent, mem_used_bytes, mem_limit_bytes, net_rx_bytes, net_tx_bytes, restart_count, started_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (server_id, container_id) DO UPDATE SET
         name = EXCLUDED.name, image = EXCLUDED.image, state = EXCLUDED.state, status = EXCLUDED.status,
         cpu_percent = EXCLUDED.cpu_percent, mem_used_bytes = EXCLUDED.mem_used_bytes,
         mem_limit_bytes = EXCLUDED.mem_limit_bytes, net_rx_bytes = EXCLUDED.net_rx_bytes,
         net_tx_bytes = EXCLUDED.net_tx_bytes, restart_count = EXCLUDED.restart_count,
         started_at = EXCLUDED.started_at, updated_at = now()`,
      [serverId, c.id, c.name, c.image || null, c.state || null, c.status || null,
       c.cpu_percent ?? null, c.mem_used_bytes ?? null, c.mem_limit_bytes ?? null,
       c.net_rx_bytes ?? null, c.net_tx_bytes ?? null, c.restart_count ?? null, c.started_at || null]
    );
  }

  res.status(201).json({ ok: true, count: list.length });
});

module.exports = router;
