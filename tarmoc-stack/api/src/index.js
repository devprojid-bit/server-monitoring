require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('express-async-errors'); // makes async route handler errors reach the error middleware below instead of crashing the process

const db = require('./db');
const serversRoute = require('./routes/servers').router;
const agentRoute = require('./routes/agent');
const alertsRoute = require('./routes/alerts');
const containersRoute = require('./routes/containers');

// Last-resort safety net: one bad request should never take down the whole API.
// Without this, an unhandled rejection anywhere crashes the entire Node process
// (this is exactly what happened when the "containers" table didn't exist yet —
// every request to that route killed the API until Docker restarted it).
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (API stayed up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (API stayed up):', err);
});

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' })); // raised from 256kb to fit container-list payloads on hosts with many containers

// Basic rate limiting per MD-02 section 34. Agent ingestion gets a higher ceiling
// than admin/dashboard routes since it's called every few seconds per server.
app.use('/api/agent', rateLimit({ windowMs: 60 * 1000, max: 120 }));
app.use('/api/monitoring', rateLimit({ windowMs: 60 * 1000, max: 300 }));

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'unreachable' });
  }
});

app.use('/api/monitoring/servers', serversRoute);
app.use('/api/monitoring/alerts', alertsRoute);
app.use('/api/monitoring/containers', containersRoute);
app.use('/api/agent', agentRoute);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`TARMOC API listening on :${port}`));
