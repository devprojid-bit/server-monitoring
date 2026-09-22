const OFFLINE_AFTER = parseInt(process.env.OFFLINE_AFTER_SECONDS || '90', 10);

const SEVERITY_RANK = { info: 1, warning: 2, critical: 3, emergency: 4 };

// Derives a server's overall status from its last heartbeat and its active alerts.
// This keeps "status" a computed fact rather than a field that can drift out of sync.
function computeStatus(lastSeenAt, activeSeverities) {
  if (!lastSeenAt) return 'offline';
  const ageSeconds = (Date.now() - new Date(lastSeenAt).getTime()) / 1000;
  if (ageSeconds > OFFLINE_AFTER) return 'offline';

  const worst = activeSeverities.reduce((acc, s) => (SEVERITY_RANK[s] > SEVERITY_RANK[acc] ? s : acc), 'info');
  if (worst === 'critical' || worst === 'emergency') return 'critical';
  if (worst === 'warning') return 'warning';
  return 'healthy';
}

module.exports = { computeStatus, OFFLINE_AFTER };
