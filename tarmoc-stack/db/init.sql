-- TARMOC Infrastructure Monitoring — database schema
-- Matches MD-02 section 36 (simplified for MVP: servers, metrics, alerts, audit log)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS servers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT UNIQUE NOT NULL,
  hostname           TEXT,
  ip_address         TEXT,
  os                 TEXT,
  os_version         TEXT,
  architecture       TEXT,
  environment        TEXT DEFAULT 'production',
  type               TEXT DEFAULT 'Virtual machine', -- Physical server / Virtual machine / Docker host
  tags               TEXT[] DEFAULT '{}',
  agent_version      TEXT,
  agent_token_hash   TEXT,                            -- sha256 of the plaintext token, never the token itself
  last_seen_at       TIMESTAMPTZ,
  uptime_seconds     BIGINT DEFAULT 0,
  cores              INT,
  threads            INT,
  ram_total_gb       NUMERIC,
  disk_total_gb      NUMERIC,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_metrics (
  id            BIGSERIAL PRIMARY KEY,
  server_id     UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cpu_usage     NUMERIC,
  ram_usage     NUMERIC,
  disk_usage    NUMERIC,
  network_rx    BIGINT,
  network_tx    BIGINT,
  load_1        NUMERIC,
  load_5        NUMERIC,
  load_15       NUMERIC,
  temperature   NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_metrics_server_time ON server_metrics (server_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id          UUID REFERENCES servers(id) ON DELETE CASCADE, -- NULL = applies to all servers
  metric             TEXT NOT NULL,       -- cpu_usage | ram_usage | disk_usage | temperature
  operator           TEXT NOT NULL DEFAULT '>',
  threshold          NUMERIC NOT NULL,
  duration_seconds   INT NOT NULL DEFAULT 0,
  severity           TEXT NOT NULL,       -- info | warning | critical | emergency
  enabled            BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id     UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,
  severity      TEXT NOT NULL,
  value         NUMERIC,
  threshold     NUMERIC,
  status        TEXT NOT NULL DEFAULT 'active', -- active | acknowledged | resolved
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_server_status ON alerts (server_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_name     TEXT,
  action        TEXT NOT NULL,
  server_id     UUID,
  ip            TEXT,
  result        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per container, kept current (upserted) rather than a time series — a
-- container's identity is its (server_id, container_id) pair. MD-02 section 14.
CREATE TABLE IF NOT EXISTS containers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id         UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  container_id      TEXT NOT NULL,   -- Docker's own container ID
  name              TEXT NOT NULL,
  image             TEXT,
  state             TEXT,            -- running | exited | restarting | paused | ...
  status            TEXT,            -- Docker's human-readable status string
  cpu_percent       NUMERIC,         -- NOT capped at 100 — a container can use multiple cores
  mem_used_bytes    BIGINT,
  mem_limit_bytes   BIGINT,
  net_rx_bytes      BIGINT,
  net_tx_bytes      BIGINT,
  restart_count     INT,
  started_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, container_id)
);
CREATE INDEX IF NOT EXISTS idx_containers_server ON containers (server_id);

-- Default threshold rules (MD-02 section 7 / 8 / 26) — apply to all servers (server_id = NULL)
INSERT INTO alert_rules (metric, operator, threshold, severity, duration_seconds)
SELECT * FROM (VALUES
  ('cpu_usage',    '>', 85,  'warning',   300),
  ('cpu_usage',    '>', 95,  'critical',  60),
  ('ram_usage',    '>', 80,  'warning',   180),
  ('ram_usage',    '>', 90,  'critical',  60),
  ('disk_usage',   '>', 80,  'warning',   0),
  ('disk_usage',   '>', 90,  'critical',  0),
  ('disk_usage',   '>', 95,  'emergency', 0),
  ('temperature',  '>', 75,  'warning',   0),
  ('temperature',  '>', 85,  'critical',  0),
  ('temperature',  '>', 95,  'emergency', 0)
) AS v(metric, operator, threshold, severity, duration_seconds)
WHERE NOT EXISTS (SELECT 1 FROM alert_rules WHERE server_id IS NULL);
