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
const http = require('http');
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
  dockerSocket: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  dockerEnabled: process.env.DOCKER_MONITORING !== 'false',
  agentVersion: '1.1.0',
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
  return clampPct((1 - idleDelta / totalDelta) * 100, 'CPU usage');
}

function ramUsage() {
  // Prefer /proc/meminfo's MemAvailable on Linux (accounts for reclaimable cache,
  // unlike raw freemem which under-reports "available" memory).
  if (process.platform === 'linux') {
    try {
      const text = fs.readFileSync('/proc/meminfo', 'utf8');
      const total = parseInt(/MemTotal:\s+(\d+)/.exec(text)[1], 10);
      const avail = parseInt(/MemAvailable:\s+(\d+)/.exec(text)[1], 10);
      return { usagePct: clampPct(((total - avail) / total) * 100, 'RAM usage'), totalGb: round2((total * 1024) / 1e9) };
    } catch (e) { /* fall through */ }
  }
  const total = os.totalmem(), free = os.freemem();
  return { usagePct: clampPct(((total - free) / total) * 100, 'RAM usage'), totalGb: round2(total / 1e9) };
}

function diskUsage(target) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`wmic logicaldisk where "DeviceID='${target}'" get Size,FreeSpace /value`, { encoding: 'utf8' });
      const size = parseInt(/Size=(\d+)/.exec(out)?.[1] || '0', 10);
      const free = parseInt(/FreeSpace=(\d+)/.exec(out)?.[1] || '0', 10);
      if (!size) return null;
      return { usagePct: clampPct(((size - free) / size) * 100, 'Disk usage'), totalGb: round2(size / 1e9) };
    }
    const out = execSync(`df -k ${target}`, { encoding: 'utf8' });
    // A long filesystem/device name (common with LVM/overlay) makes df wrap it onto
    // its own line, pushing the numeric columns to the next line. Joining every line
    // after the header back into one string before splitting on whitespace makes the
    // parsing correct whether df wrapped or not — this is the actual bug that caused
    // impossible readings like "408%" (Used and Total getting read from the wrong columns).
    const dataLines = out.trim().split('\n').slice(1);
    const parts = dataLines.join(' ').trim().split(/\s+/); // [fs, 1K-blocks, Used, Available, Use%, ...mount]
    const totalKb = parseInt(parts[1], 10);
    const usedKb = parseInt(parts[2], 10);
    if (!totalKb || Number.isNaN(usedKb)) return null;
    return { usagePct: clampPct((usedKb / totalKb) * 100, 'Disk usage'), totalGb: round2((totalKb * 1024) / 1e9) };
  } catch (e) {
    return null;
  }
}

// Belt-and-suspenders: a usage percentage can never legitimately be outside 0–100.
// If any reader (now or in the future) miscalculates, this clamps it instead of
// displaying nonsense — and logs a warning so the underlying bug doesn't go unnoticed
// just because the symptom is hidden. label identifies which reading triggered it.
function clampPct(n, label) {
  if (Number.isNaN(n)) return null;
  if (n < 0 || n > 100) {
    log(`WARNING: ${label || 'a metric'} computed as ${round2(n)}% — clamping to 0-100. This usually means a parsing bug; worth checking manually with the underlying command (df/free/etc).`);
  }
  return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
}

let lastNetSample = null; // { bytes: {rx, tx}, at: ms }
// Interfaces that don't represent real external network traffic — Docker bridges,
// veth pairs (one per container), and similar virtual plumbing. On a host running
// many containers, summing these alongside the real NIC double- and triple-counts
// internal traffic and massively inflates the reported Mbps. Only physical/real
// NICs (eth0, ens*, enp*, wlan0, bond0, etc.) should count toward the total.
// Interfaces that are unambiguously Docker's own internal plumbing — never a real
// WAN path. Deliberately NOT excluding tap/tun/wg here: on some hosts (this one
// included) the real internet connection is itself a tap/tun/VPN-style interface,
// so blanket-excluding those categories silently zeroed out all real traffic.
// docker0 and veth* are always Docker; "br-XXXXXXXXXXXX" (12 hex chars) is
// Docker's own naming for user-defined bridge networks specifically.
const VIRTUAL_IFACE_PATTERN = /^(lo|docker\d*|veth[0-9a-f]|br-[0-9a-f]{12}$|virbr|cni|flannel|cali|vxlan|ifb)/;

function networkRateMbps() {
  if (process.platform !== 'linux') return { rxMbps: null, txMbps: null };
  try {
    const text = fs.readFileSync('/proc/net/dev', 'utf8');
    let rx = 0, tx = 0;
    text.split('\n').slice(2).forEach((line) => {
      const [ifacePart, rest] = line.split(':');
      if (!rest) return;
      const iface = (ifacePart || '').trim();
      if (!iface || VIRTUAL_IFACE_PATTERN.test(iface)) return;
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

// ---------- Docker container monitoring (MD-02 section 14) ----------
// Talks to the Docker Engine API directly over its unix socket — no docker CLI and
// no npm dependency needed. Requires /var/run/docker.sock to be bind-mounted
// read-only into this container (see docker-compose.yml).

let dockerAvailable = null; // null = not checked yet, else true/false
let dockerWarnedOnce = false;

function dockerRequest(reqPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: CONFIG.dockerSocket, path: reqPath, method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Docker API ${reqPath} → ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(body ? JSON.parse(body) : null); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Docker API ${reqPath} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

async function checkDockerAvailable() {
  if (!CONFIG.dockerEnabled) { dockerAvailable = false; return false; }
  if (!fs.existsSync(CONFIG.dockerSocket)) { dockerAvailable = false; return false; }
  try {
    await dockerRequest('/version', 2000);
    dockerAvailable = true;
    log(`Docker socket detected at ${CONFIG.dockerSocket} — container monitoring enabled.`);
  } catch (e) {
    dockerAvailable = false;
    log(`Docker socket present but not reachable (${e.message}) — container monitoring disabled.`);
  }
  return dockerAvailable;
}

// Same formula `docker stats` itself uses: usage delta as a fraction of the host's
// total CPU-time delta, scaled by core count. This is intentionally NOT capped at
// 100 — a container using two full cores on a multi-core host legitimately reads ~200%.
function containerCpuPercent(stats) {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cores = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage || []).length || os.cpus().length || 1;
    if (sysDelta <= 0 || cpuDelta < 0) return 0;
    const pct = (cpuDelta / sysDelta) * cores * 100;
    // Sanity ceiling only — guards against a parsing/API oddity producing a wild
    // number, not a "max 100%" assumption (multi-core containers can exceed 100%).
    return Math.max(0, Math.min(cores * 100, round2(pct)));
  } catch (e) { return null; }
}
function containerMemUsed(stats) {
  try {
    // Docker CLI subtracts page cache from the raw usage figure so "used" reflects
    // what the container is actually holding, not reclaimable filesystem cache.
    const cache = (stats.memory_stats.stats && (stats.memory_stats.stats.cache ?? stats.memory_stats.stats.inactive_file)) || 0;
    return Math.max(0, (stats.memory_stats.usage || 0) - cache);
  } catch (e) { return null; }
}
function containerNetBytes(stats) {
  try {
    const nets = stats.networks || {};
    let rx = 0, tx = 0;
    Object.values(nets).forEach((n) => { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; });
    return { rx, tx };
  } catch (e) { return { rx: null, tx: null }; }
}

async function getContainers() {
  if (dockerAvailable === null) await checkDockerAvailable();
  if (!dockerAvailable) return [];

  let list;
  try {
    list = await dockerRequest('/containers/json?all=true');
  } catch (e) {
    if (!dockerWarnedOnce) { log('WARNING: failed to list containers:', e.message); dockerWarnedOnce = true; }
    return [];
  }

  const results = await Promise.all(list.map(async (c) => {
    const name = (c.Names && c.Names[0] || c.Id).replace(/^\//, '');
    const base = { id: c.Id, name, image: c.Image, state: c.State, status: c.Status, restart_count: null, started_at: null, cpu_percent: null, mem_used_bytes: null, mem_limit_bytes: null, net_rx_bytes: null, net_tx_bytes: null };
    if (c.State !== 'running') return base; // stats/inspect are only meaningful for running containers

    try {
      const [stats, inspect] = await Promise.all([
        dockerRequest(`/containers/${c.Id}/stats?stream=false`),
        dockerRequest(`/containers/${c.Id}/json`),
      ]);
      const net = containerNetBytes(stats);
      return {
        ...base,
        cpu_percent: containerCpuPercent(stats),
        mem_used_bytes: containerMemUsed(stats),
        mem_limit_bytes: stats.memory_stats?.limit ?? null,
        net_rx_bytes: net.rx, net_tx_bytes: net.tx,
        restart_count: inspect.RestartCount ?? null,
        started_at: inspect.State?.StartedAt || null,
      };
    } catch (e) {
      return base; // one container's stats failing shouldn't drop it from the list entirely
    }
  }));

  return results;
}

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

async function sendContainers(token) {
  const containers = await getContainers();
  if (!dockerAvailable) return; // nothing to report, and we already logged why once
  await apiFetch('/api/agent/containers', {
    method: 'POST',
    headers: { 'X-Agent-Token': token },
    body: { containers },
  });
  const running = containers.filter((c) => c.state === 'running').length;
  log(`containers: ${running}/${containers.length} running`);
}

async function main() {
  log(`TARMOC agent starting — API=${CONFIG.apiUrl} server=${CONFIG.serverName} interval=${CONFIG.intervalSeconds}s`);
  const token = await ensureToken();
  await checkDockerAvailable();

  let prevCpu = cpuSnapshot();
  // First real sample needs a baseline; wait one short beat before the first real reading.
  await new Promise((r) => setTimeout(r, 1000));

  const loop = async () => {
    tick++;
    try {
      if (tick % CONFIG.heartbeatEvery === 1) await sendHeartbeat(token);
      prevCpu = await sendMetrics(token, prevCpu);
      if (dockerAvailable) await sendContainers(token);
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
