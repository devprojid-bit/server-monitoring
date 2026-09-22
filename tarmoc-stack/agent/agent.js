#!/usr/bin/env node
/**
 * TARMOC Agent — reads real CPU/RAM/Disk/Network/load/temperature from the host
 * and pushes it to the TARMOC API every INTERVAL_SECONDS. Zero npm dependencies:
 * uses only Node's built-ins (os, fs, child_process, global fetch — Node 18+).
 *
 * Two ways to run it:
 *  1) Pre-provisioned: set AGENT_TOKEN (from the dashboard's "Add server" modal
 *     or a POST /api/monitoring/servers call) — the agent skips registration.
 *  2) Self-registering: leave AGENT_TOKEN empty, set SERVER_NAME — the agent
 *     calls POST /api/agent/register once and caches the token it gets back
 *     in AGENT_STATE_FILE so it survives restarts.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = {
  apiUrl: (process.env.API_URL || 'http://localhost:4000').replace(/\/+$/, ''),
  serverName: process.env.SERVER_NAME || os.hostname(),
  hostname: process.env.AGENT_HOSTNAME || os.hostname(),
  ipAddress: process.env.IP_ADDRESS || firstNonInternalIp(),
  environment: process.env.ENVIRONMENT || 'production',
  type: process.env.SERVER_TYPE || 'Physical server',
  tags: (process.env.TAGS || '').split(',').map((t) => t.trim()).filter(Boolean),
  diskPath: process.env.DISK_PATH || (process.platform === 'win32' ? 'C:' : '/'),
  intervalSeconds: parseInt(process.env.INTERVAL_SECONDS || '15', 10),
  heartbeatEvery: parseInt(process.env.HEARTBEAT_EVERY_N_TICKS || '4', 10),
  stateFile: process.env.AGENT_STATE_FILE || path.join(__dirname, '.tarmoc-agent-state.json'),
  presetToken: process.env.AGENT_TOKEN || null,
  agentVersion: '1.0.0',
};

function firstNonInternalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '0.0.0.0';
}

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

// ---------- system readers ----------

// CPU usage via delta between two os.cpus() snapshots — works on Linux/macOS/Windows.
function cpuSnapshot() {
  return os.cpus().map((c) => ({ ...c.times }));
}
function cpuUsagePercent(prev, curr) {
  if (!prev || prev.length !== curr.length) return null;
  let idleDelta = 0, totalDelta = 0;
  for (let i = 0; i < curr.length; i++) {
    const p = prev[i], c = curr[i];
    const pIdle = p.idle, cIdle = c.idle;
    const pTotal = p.user + p.nice + p.sys + p.idle + p.irq;
    const cTotal = c.user + c.nice + c.sys + c.idle + c.irq;
    idleDelta += cIdle - pIdle;
    totalDelta += cTotal - pTotal;
  }
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
}

function ramUsage() {
  // Prefer /proc/meminfo's MemAvailable on Linux (accounts for reclaimable cache,
  // unlike raw freemem which under-reports "available" memory).
  if (process.platform === 'linux') {
    try {
      const text = fs.readFileSync('/proc/meminfo', 'utf8');
      const total = parseInt(/MemTotal:\s+(\d+)/.exec(text)[1], 10);
      const avail = parseInt(/MemAvailable:\s+(\d+)/.exec(text)[1], 10);
      return { usagePct: Math.round(((total - avail) / total) * 1000) / 10, totalGb: round2((total * 1024) / 1e9) };
    } catch (e) { /* fall through */ }
  }
  const total = os.totalmem(), free = os.freemem();
  return { usagePct: Math.round(((total - free) / total) * 1000) / 10, totalGb: round2(total / 1e9) };
}

function diskUsage(target) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`wmic logicaldisk where "DeviceID='${target}'" get Size,FreeSpace /value`, { encoding: 'utf8' });
      const size = parseInt(/Size=(\d+)/.exec(out)?.[1] || '0', 10);
      const free = parseInt(/FreeSpace=(\d+)/.exec(out)?.[1] || '0', 10);
      if (!size) return null;
      return { usagePct: Math.round(((size - free) / size) * 1000) / 10, totalGb: round2(size / 1e9) };
    }
    const out = execSync(`df -k ${target}`, { encoding: 'utf8' });
    const line = out.trim().split('\n').pop();
    const parts = line.trim().split(/\s+/); // Filesystem 1K-blocks Used Available Use% Mounted
    const totalKb = parseInt(parts[1], 10);
    const usedKb = parseInt(parts[2], 10);
    return { usagePct: Math.round((usedKb / totalKb) * 1000) / 10, totalGb: round2((totalKb * 1024) / 1e9) };
  } catch (e) {
    return null;
  }
}

let lastNetSample = null; // { bytes: {rx, tx}, at: ms }
function networkRateMbps() {
  if (process.platform !== 'linux') return { rxMbps: null, txMbps: null };
  try {
    const text = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    text.split('\n').slice(2).forEach((line) => {
      const [ifacePart, rest] = line.split(':');
      if (!rest) return;
      const iface = (ifacePart || '').trim();
      if (!iface || iface === 'lo') return;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0] || 0; // bytes received
      tx += cols[8] || 0; // bytes transmitted
    });
    const now = Date.now();
    let rxMbps = null, txMbps = null;
    if (lastNetSample) {
      const dt = (now - lastNetSample.at) / 1000;
      if (dt > 0) {
        rxMbps = round2(((rx - lastNetSample.rx) * 8) / 1e6 / dt);
        txMbps = round2(((tx - lastNetSample.tx) * 8) / 1e6 / dt);
      }
    }
    lastNetSample = { rx, tx, at: now };
    return { rxMbps, txMbps, rxBytes: rx, txBytes: tx };
  } catch (e) {
    return { rxMbps: null, txMbps: null };
  }
}

function temperatureC() {
  if (process.platform !== 'linux') return null;
  try {
    const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
    return round2(parseInt(raw, 10) / 1000);
  } catch (e) {
    return null;
  }
}

function loadAvg() {
  const [l1, l5, l15] = os.loadavg(); // returns [0,0,0] on Windows — expected, not a bug
  return { load_1: round2(l1), load_5: round2(l5), load_15: round2(l15) };
}

function round2(n) { return Math.round(n * 100) / 100; }

// ---------- state (cached token) ----------

function loadState() {
  try { return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8')); } catch (e) { return null; }
}
function saveState(state) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ---------- API calls ----------

async function apiFetch(pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(CONFIG.apiUrl + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function ensureToken() {
  if (CONFIG.presetToken) return CONFIG.presetToken;

  const cached = loadState();
  if (cached?.token) return cached.token;

  log(`No token found — registering "${CONFIG.serverName}" with ${CONFIG.apiUrl} ...`);
  const disk = diskUsage(CONFIG.diskPath);
  const mem = ramUsage();
  const result = await apiFetch('/api/agent/register', {
    method: 'POST',
    body: {
      name: CONFIG.serverName,
      hostname: CONFIG.hostname,
      ip_address: CONFIG.ipAddress,
      os: `${os.type()} ${os.release()}`,
      architecture: os.arch(),
      environment: CONFIG.environment,
      type: CONFIG.type,
      tags: CONFIG.tags,
      cores: os.cpus().length,
      threads: os.cpus().length,
      ram_total_gb: mem.totalGb,
      disk_total_gb: disk?.totalGb ?? null,
    },
  });
  saveState({ token: result.token, server_id: result.server_id, name: result.name });
  log(`Registered as server_id=${result.server_id}. Token cached in ${CONFIG.stateFile}`);
  return result.token;
}

// ---------- main loop ----------

let tick = 0;
async function sendHeartbeat(token) {
  await apiFetch('/api/agent/heartbeat', {
    method: 'POST',
    headers: { 'X-Agent-Token': token },
    body: { uptime_seconds: Math.round(os.uptime()), agent_version: CONFIG.agentVersion },
  });
}

async function sendMetrics(token, prevCpu) {
  const currCpu = cpuSnapshot();
  const cpuPct = cpuUsagePercent(prevCpu, currCpu);
  const mem = ramUsage();
  const disk = diskUsage(CONFIG.diskPath);
  const net = networkRateMbps();
  const load = loadAvg();
  const temp = temperatureC();

  const reading = {
    cpu_usage: cpuPct,
    ram_usage: mem.usagePct,
    disk_usage: disk?.usagePct ?? null,
    network_rx: net.rxBytes ?? null,
    network_tx: net.txBytes ?? null,
    load_1: load.load_1,
    load_5: load.load_5,
    load_15: load.load_15,
    temperature: temp,
  };

  await apiFetch('/api/agent/metrics', {
    method: 'POST',
    headers: { 'X-Agent-Token': token },
    body: reading,
  });

  log(`sent cpu=${reading.cpu_usage}% ram=${reading.ram_usage}% disk=${reading.disk_usage}% ` +
      `net=${net.rxMbps ?? '—'}/${net.txMbps ?? '—'}Mbps load=${load.load_1} temp=${temp ?? '—'}°C`);

  return currCpu;
}

async function main() {
  log(`TARMOC agent starting — API=${CONFIG.apiUrl} server=${CONFIG.serverName} interval=${CONFIG.intervalSeconds}s`);
  const token = await ensureToken();

  let prevCpu = cpuSnapshot();
  // First real sample needs a baseline; wait one short beat before the first real reading.
  await new Promise((r) => setTimeout(r, 1000));

  const loop = async () => {
    tick++;
    try {
      if (tick % CONFIG.heartbeatEvery === 1) await sendHeartbeat(token);
      prevCpu = await sendMetrics(token, prevCpu);
    } catch (err) {
      log('ERROR:', err.message);
    }
  };

  await loop();
  const timer = setInterval(loop, CONFIG.intervalSeconds * 1000);

  const shutdown = () => {
    log('Agent stopping.');
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('FATAL:', err.message);
  process.exit(1);
});
