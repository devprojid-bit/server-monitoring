const db = require('../db');

const SEVERITY_RANK = { info: 1, warning: 2, critical: 3, emergency: 4 };
const OPS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
};

// Called once per metric per incoming reading. Finds the highest-severity rule that
// the value breaches, and reconciles that against any currently-active alert for the
// same server + metric: opens a new one, escalates/de-escalates it, or resolves it.
async function evaluateMetric(serverId, metric, value) {
  if (value === undefined || value === null || Number.isNaN(Number(value))) return;

  const { rows: rules } = await db.query(
    `SELECT * FROM alert_rules
     WHERE metric = $1 AND enabled = true AND (server_id = $2 OR server_id IS NULL)
     ORDER BY threshold DESC`,
    [metric, serverId]
  );

  let triggered = null;
  for (const rule of rules) {
    const cmp = OPS[rule.operator] || OPS['>'];
    if (cmp(Number(value), Number(rule.threshold))) {
      if (!triggered || SEVERITY_RANK[rule.severity] > SEVERITY_RANK[triggered.severity]) {
        triggered = rule;
      }
    }
  }

  const { rows: activeRows } = await db.query(
    `SELECT * FROM alerts WHERE server_id = $1 AND metric = $2 AND status = 'active' LIMIT 1`,
    [serverId, metric]
  );
  const active = activeRows[0];

  if (triggered) {
    if (!active) {
      await db.query(
        `INSERT INTO alerts (server_id, metric, severity, value, threshold, status)
         VALUES ($1, $2, $3, $4, $5, 'active')`,
        [serverId, metric, triggered.severity, value, triggered.threshold]
      );
    } else if (active.severity !== triggered.severity || Number(active.threshold) !== Number(triggered.threshold)) {
      await db.query(
        `UPDATE alerts SET severity = $1, value = $2, threshold = $3 WHERE id = $4`,
        [triggered.severity, value, triggered.threshold, active.id]
      );
    } else {
      await db.query(`UPDATE alerts SET value = $1 WHERE id = $2`, [value, active.id]);
    }
  } else if (active) {
    await db.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1`,
      [active.id]
    );
  }
}

async function evaluateReading(serverId, reading) {
  const checks = [
    ['cpu_usage', reading.cpu_usage],
    ['ram_usage', reading.ram_usage],
    ['disk_usage', reading.disk_usage],
    ['temperature', reading.temperature],
  ];
  for (const [metric, value] of checks) {
    await evaluateMetric(serverId, metric, value);
  }
}

module.exports = { evaluateReading, evaluateMetric };
