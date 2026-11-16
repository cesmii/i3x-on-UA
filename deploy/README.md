# Deployment: https://opcua.i3x.dev

The public demo runs on the CESMII server `admin.cesmii.net` (Ubuntu 22.04) as one systemd unit, `i3x-on-ua`. It runs what `./start.sh` runs on a laptop: the OPC UA plant simulation, the three i3X servers (cesmii, i3x2ua, uns) and the front door. The i3X side is **read-only**. The OPC UA plant is also open to UA clients at `opc.tcp://cesmiirouter.eastus2.cloudapp.azure.com:4840/UA/BeverageFactory`.

```
Internet ──https──> Cloudflare ──https──> Nginx :443 (opcua.i3x.dev) ──> front door 127.0.0.1:8084
                                                                          ├─ /cesmii/v1  → cesmii gateway :8085
                                                                          ├─ /i3x2ua/v1  → i3x2ua container 127.0.0.1:8082
                                                                          ├─ /uns/v1     → uns :8083
                                                                          └─ /v1         → the active one (compare/gateways.yaml)
                                       all three read the plant: opc.tcp://localhost:4840/UA/BeverageFactory

UA clients ──opc.tcp──> cesmiirouter.eastus2.cloudapp.azure.com:4840 (Azure NSG + ufw; not via Cloudflare) ──> plant
```

| File | Installed as |
|---|---|
| `deploy/i3x-on-ua.service` | `/etc/systemd/system/i3x-on-ua.service` |
| `deploy/nginx-opcua.i3x.dev.conf` | `/etc/nginx/sites-available/i3x-on-opcua` (+ symlink in `sites-enabled`) |
| `deploy/deploy.sh` | run by cron from the checkout |

## How updates reach the server

The checkout is `/var/www/apps/i3x-on-UA` (`~/apps` links to `/var/www/apps`), cloned over https from the public repo.
- The host's `/var/www/apps/git-update.sh` cron already runs `git pull` in every repo there every 2 minutes.
- **`deploy/deploy.sh`** (cron, every 3 minutes, like `CesmiiMigration/deploy.sh`) pulls too. When `HEAD` differs from the commit the service was started from (`.last-deploy`), it does three things:
  - runs `npm ci` if `package-lock.json` changed;
  - creates `.env` from `.env.example` if it's missing;
  - runs `sudo systemctl restart i3x-on-ua`.

  Documentation-only commits don't restart: `*.md`, `*.mmd`, `LICENSE` and anything under `docs/`. A restart resets the simulation and drops i3X subscriptions and OPC UA sessions. The script prints nothing when there's nothing to do, so cron mails only real deploys and errors.

So: **push to `main`, and the demo restarts on the new commit within about 3 minutes.**

## Ports on this host

8080 and 8081 are used by the i3X demo servers (`api.i3x.dev`), so our gateway runs on **8085** (`COMPARE_PORT_CESMII` in the unit). ufw admits 80/443 from Cloudflare, SSH, and 4840 (OPC UA) from anywhere; the i3X ports aren't reachable from outside.

| Port | What | Listens on |
|---|---|---|
| 8084 | Front door (Nginx proxies to it) | all interfaces, firewalled |
| 8085 | cesmii gateway | all interfaces, firewalled |
| 8082 | i3x2ua container | 127.0.0.1 |
| 8083 | uns | all interfaces, firewalled |
| 4840 | OPC UA plant | all interfaces, **public** (ufw + Azure NSG rule); the `docker0` rule lets the i3x2ua container in |

## Read-only, and what isn't covered

The unit sets:
- `COMPARE_READ_ONLY=1`: the front door refuses `PUT`, `DELETE` and `PATCH` for every gateway (501), and `/_switch/…` (403). i3X reads and subscriptions are `GET`/`POST`, so they work.
- `GATEWAY_READ_ONLY=1`: cesmii returns 501 on `PUT /objects/value`, and `/info` says `capabilities.update.current: false`.

i3x2ua runs with writes off (its default), and uns has no writes. Nginx sends CORS headers for `GET, POST, OPTIONS` only.

**Not covered:** authentication. i3X is open to anyone who reaches Cloudflare.

## The public OPC UA endpoint

`opc.tcp://cesmiirouter.eastus2.cloudapp.azure.com:4840/UA/BeverageFactory`, anonymous, security None (Sign/SignAndEncrypt with Basic256Sha256 also offered; client certificates are auto-accepted).

- **Hostname.** OPC UA can't go through Cloudflare's proxy, so the endpoint uses the VM's Azure DNS name. `OPCUA_HOSTNAME` in the unit makes the plant advertise it: by default it would advertise `cesmii-router2.internal.cloudapp.net`, which only resolves inside Azure, and clients that follow the endpoint list would fail. `localhost` stays advertised for the local i3X servers.
- **Session cap.** `OPCUA_MAX_SESSIONS=20` limits sessions and connections, so outside clients can't exhaust the server. The three i3X servers hold a few of them; if the cap is ever reached, a gateway that reconnects could be locked out until a client leaves.
- **Writable.** It isn't read-only: as in Machinery, `Identification/AssetId`, `ComponentName` and `Location` are writable, and a change shows in all three i3X servers until the next restart. The simulation overwrites process values every second anyway.
- **Certificate.** The self-signed server certificate (`server/pki/own/`) is created on first start, naming this machine, `localhost` and `OPCUA_HOSTNAME`. To get one that names the public hostname, move `server/pki/own/certs/certificate.pem` and `server/pki/own/private/private_key.pem` aside and restart.

Opening it (done 2026-11-16): an Azure NSG inbound rule for TCP 4840 on the VM, and `sudo ufw allow 4840/tcp comment 'i3x-on-UA: public OPC UA plant'`.

## First-time install (done 2026-11-16)

```sh
# code
git clone https://github.com/cesmii/i3x-on-UA.git /var/www/apps/i3x-on-UA
cd /var/www/apps/i3x-on-UA && cp .env.example .env && npm ci

# service
sudo cp deploy/i3x-on-ua.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now i3x-on-ua
git rev-parse HEAD > .last-deploy

# the i3x2ua container must reach the plant on the host (ufw denies it by default)
sudo ufw allow in on docker0 to any port 4840 proto tcp comment 'i3x-on-UA: i3x2ua container -> OPC UA plant'

# web
sudo cp deploy/nginx-opcua.i3x.dev.conf /etc/nginx/sites-available/i3x-on-opcua
sudo ln -s /etc/nginx/sites-available/i3x-on-opcua /etc/nginx/sites-enabled/i3x-on-opcua
sudo nginx -t && sudo systemctl reload nginx

# updates
(crontab -l; echo '*/3 * * * * /var/www/apps/i3x-on-UA/deploy/deploy.sh') | crontab -
```

DNS: `opcua.i3x.dev` is a proxied (orange-cloud) record in the i3x.dev Cloudflare zone, pointing at this host like `api.i3x.dev`. The Nginx site uses the host's Cloudflare origin certificate. It names `*.cesmii.net`, which Cloudflare accepts in the zone's "Full" (non-strict) SSL mode, as for `api.i3x.dev`.

## Verify

```sh
H=https://opcua.i3x.dev
curl -s $H/ | head -20                                   # status: all three servers "ready in …"
curl -s $H/cesmii/v1/info                                # … "update":{"current":false …
curl -s $H/i3x2ua/v1/info; curl -s $H/uns/v1/info
curl -s -X PUT -H 'Content-Type: application/json' $H/cesmii/v1/objects/value -d '{"updates":[]}'   # → 501 read-only
curl -s -o /dev/null -w '%{http_code}\n' $H/_switch/uns  # → 403
```

In **i3X Explorer** (desktop, or https://explorer.i3x.dev), add `https://opcua.i3x.dev/cesmii/v1`, `…/i3x2ua/v1` and `…/uns/v1`. `docs/WALKTHROUGH.md` is the guided tour. Conformance: `node bin/i3x-test.js run https://opcua.i3x.dev/cesmii/v1` (or the suite's web UI at https://conformance.i3x.dev).

## Operate

| Task | How |
|---|---|
| Logs | `journalctl -u i3x-on-ua -f`, plus each server's log in `compare/logs/<name>.log` |
| Restart | `sudo systemctl restart i3x-on-ua`. The simulation starts over (seeded, so reproducible); history is in memory only |
| Stop | `sudo systemctl stop i3x-on-ua`. The launcher stops each process group and removes the container, the same as Ctrl-C |
| Status table | `cd /var/www/apps/i3x-on-UA && ./start.sh status` |
| Deploy log | cron mail for user `cesmii`; or run `deploy/deploy.sh` by hand |
| Change the server behind `/v1` | edit `active:` in `compare/gateways.yaml` and push (`/_switch` is disabled) |
| Simulation settings | `.env` on the server (`SIM_SPEED`, `SIM_SEED`, `SIM_HISTORY`, `SIM_FAULTS`), then restart |
| Unit changed in git | `sudo cp deploy/i3x-on-ua.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart i3x-on-ua` (deploy.sh doesn't re-install the unit) |
| Uninstall | remove the cron line; `sudo systemctl disable --now i3x-on-ua`; delete the unit, the Nginx site and symlink (reload Nginx), both 4840 ufw rules, and the Azure NSG 4840 rule |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `front door port :8084 is already in use` | Another launcher is running (`pgrep -fl src/launch.ts`), or set `FRONT_DOOR_PORT` in the unit |
| i3x2ua `permission denied … docker.sock` | The unit's user isn't in the `docker` group, or Docker isn't running |
| i3x2ua times out after 240 s | The `docker0` → 4840 ufw rule is missing, or the image pull (ghcr.io) is blocked |
| 444 / connection closed on opcua.i3x.dev | The request didn't come through Cloudflare (`$from_cloudflare`), or the DNS record isn't proxied |
| SSE subscriptions stall | Proxy buffering: the Nginx site sets `proxy_buffering off`; check Cloudflare isn't caching the path |
| UaExpert: "BadTcpEndpointUrlInvalid" or it connects to `…internal.cloudapp.net` | The unit wasn't re-installed after `OPCUA_HOSTNAME` was added (`systemctl show i3x-on-ua -p Environment`) |
| UA client times out on 4840 | The Azure NSG rule or `ufw allow 4840/tcp` is missing (`sudo ufw status`) |
| Push didn't deploy | `deploy.sh` by hand shows why: a failed `git pull` (local changes in the checkout?) or `sudo -n` refused |
