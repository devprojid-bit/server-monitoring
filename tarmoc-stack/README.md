# TARMOC — full stack (Postgres + API + Dashboard + Agent)

One `docker compose up` and you get all four pieces talking to each other with
**real data**: the agent reads the Docker host's actual CPU/RAM/disk/network,
pushes it to the API, which stores it in Postgres and runs the alert engine,
and the dashboard shows it live.

```
┌───────────┐   HTTP    ┌─────────┐   SQL    ┌────────────┐
│ dashboard │ ────────▶ │   api   │ ───────▶ │  postgres  │
│  (nginx)  │           │(express)│          │            │
└───────────┘           └─────────┘          └────────────┘
                              ▲
                              │ HTTP (X-Agent-Token)
                         ┌─────────┐
                         │  agent  │──── reads /proc, df, etc. from the
                         │ (host   │     Docker host via network_mode: host,
                         │  mode)  │     pid: host, and a read-only bind
                         └─────────┘     mount of / at /hostfs
```

## Deploy

```bash
cp .env.example .env
nano .env   # at minimum, set ADMIN_API_KEY to something real
docker compose up -d --build
```

Then open **http://<host-ip>:8088** (or whatever `DASHBOARD_PORT` you set).
The agent starts monitoring the Docker host itself immediately — no manual
registration needed for that first server. Give it ~15–30 seconds for the
first reading to land, then refresh.

## Deploy via Portainer (matches the screenshot you sent earlier)

1. Push this whole `tarmoc-stack` folder to a Git repo (new or the
   `server-monitoring` repo you already pushed the dashboard to — put it in
   a subfolder if you want to keep both).
2. **Stacks → Add stack → Repository.** Point it at the repo/branch, and set
   **Compose path** to `docker-compose.yml` (or `tarmoc-stack/docker-compose.yml`
   if it's a subfolder).
3. Under **Environment variables**, add the same keys as `.env.example`
   (Portainer's repository build doesn't read a `.env` file from the repo by
   default — paste them in there instead, at minimum `ADMIN_API_KEY`).
4. Deploy the stack. Portainer builds all four images and starts them.

## Monitor more servers

The bundled `agent` service only watches the machine Docker itself is running
on. To add another server:

1. Dashboard → **+ Add server** → fill it in → paste your `ADMIN_API_KEY`
   when asked → copy the token it generates.
2. On the *other* machine, grab just the `agent/` folder (or the standalone
   `tarmoc-agent.zip` from earlier), set `API_URL` to
   `http://<this-host-ip>:4000`, `SERVER_NAME` to the name you registered,
   `AGENT_TOKEN` to the copied token, and run it (`node agent.js`, the
   systemd unit, or `docker build && docker run`).

## What's real vs. what's a placeholder right now

- **Real:** CPU, RAM, disk, load average, uptime, network (rate computed from
  cumulative counters), status (computed from heartbeat freshness + active
  alerts), alerts (opened/escalated/resolved automatically against
  thresholds), agent version/last-seen.
- **Placeholder, clearly labeled in the UI:** per-core CPU breakdown, process
  list, service status, Docker container list — the agent doesn't collect
  these yet. The dashboard says so explicitly instead of showing fake numbers.
  Extending the agent to collect these is a natural next step, same pattern
  as the metrics it already sends.

## Security note on Docker monitoring

The agent mounts `/var/run/docker.sock` to read container stats. Be aware:
`:ro` on that mount only stops the container from writing to the socket *file* —
it doesn't restrict which Docker API calls can be made once connected. Anything
with access to that socket can, in principle, do anything the Docker daemon can,
including starting/stopping containers on the host. This agent's code only ever
makes read-only calls (`/version`, `/containers/json`, `/containers/{id}/stats`,
`/containers/{id}/json`) — but the access itself is powerful, so treat the
`tarmoc-agent` container as trusted infrastructure, not something to expose or
run with looser isolation than the host it's monitoring.

## Troubleshooting

- **Dashboard shows "Can't reach the API..."** — the browser (not the
  dashboard container) needs to reach the API directly. Click the "API: ..."
  pill in the sidebar and set it to `http://<host-ip>:4000` if auto-detection
  guessed wrong (e.g. you're viewing the dashboard through a different
  hostname/proxy than the host it's running on).
- **Agent shows FATAL: fetch failed** — API isn't reachable at `API_URL` yet;
  check `docker compose logs api` and `docker compose logs postgres`.
- **Numbers look like container stats, not host stats** — confirm the agent
  service still has `network_mode: host`, `pid: host`, and the `/:/hostfs:ro`
  volume; these three are what make its readings reflect the real host
  instead of the container's own limited view.
