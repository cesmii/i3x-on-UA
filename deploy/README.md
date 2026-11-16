# Deploying the demo on a Linux server (systemd)

`deploy/i3x-on-opc.service` runs what `./start.sh` runs on a laptop: the OPC UA plant simulation, the three i3X gateways (cesmii, i3x2ua, uns) and the front door. It starts at boot, restarts on failure, and runs **read-only**.

> **Status (2026-11-16): ready, first deployment in progress.** The repo is prepared for publication: OPC Foundation spec documents and PMMI files are no longer tracked (`.gitignore`; each `docs/` folder's README says where to get them). The OPC Foundation NodeSets in `nodesets/standard/` are MIT-licensed and stay.
>
> The unit was written for and checked against the launcher's behaviour on macOS. **It has not been run under systemd yet**, so watch the first start (step 6).

## 1. What you get, and what to expose

| Port | What | Open in the firewall? |
|---|---|---|
| **8084** (set `FRONT_DOOR_PORT` in the unit to change it) | **Front door:** `/cesmii/v1`, `/i3x2ua/v1`, `/uns/v1`; `/v1` → the active gateway; `/` → JSON status | **Yes.** This is the only URL to give the WG. |
| 4840 | OPC UA plant `opc.tcp://<host>:4840/UA/BeverageFactory`, for UaExpert | Only if people need UaExpert (it's writable; see below) |
| 8081, 8083 | cesmii and uns directly (they listen on all interfaces) | **No.** Same content as through the front door |
| 8082 | i3x2ua container (published on 127.0.0.1 only) | Not reachable from outside |

The unit's environment sets **read-only mode**:
- `COMPARE_READ_ONLY=1`: the front door refuses `PUT`, `DELETE` and `PATCH` for every gateway (501), and `/_switch/…` (403). i3X reads and subscriptions are `GET` or `POST`, so they keep working.
- `GATEWAY_READ_ONLY=1`: cesmii itself returns 501 on `PUT /objects/value`, and `/info` says `capabilities.update.current: false`. This covers :8081 if it's ever reached directly.
- i3x2ua runs with writes off (its default), and uns has no writes.
- Conformance through the front door: **1.0 Compatible**, with Update listed as an omitted optional feature.

**Not covered by read-only:**
- **The OPC UA server on 4840.** It allows anonymous access with security None, so anyone who reaches it can write the Machinery Identification read-write properties (`AssetId`, `ComponentName`, `Location`). No Methods are implemented. A restart resets the values.
- **TLS and authentication.** There are none. That's acceptable for a demo; the conformance suite warns about it (CORE-06). The plan (D8) is Nginx in front (§8).

## 2. Prerequisites and code

On the server you need:
- Linux with systemd;
- **Node 24** (20+ works);
- **Docker Engine**, for i3x2ua (`ghcr.io/andreasheine/i3x2ua:1.16.2`, pulled on first start; needs outbound access to ghcr.io);
- git.

Create a service user and directory (as root):

```sh
useradd --system --create-home i3x          # needs a home for npm's cache; an existing user works too
usermod -aG docker i3x                      # the launcher runs `docker run` / `docker rm`
install -d -o i3x -g i3x /opt/i3x-on-OPC
```

**Get the code onto the server.** If there's a remote:

```sh
sudo -u i3x git clone <repo-url> /opt/i3x-on-OPC
```

If there isn't one yet, use a bundle. It carries the full history and needs no remote:

```sh
# on the Mac
git -C ~/Projects/i3x-on-OPC bundle create /tmp/i3x-on-OPC.bundle main
scp /tmp/i3x-on-OPC.bundle <server>:/tmp/
# on the server
sudo -u i3x git clone /tmp/i3x-on-OPC.bundle /opt/i3x-on-OPC
```

`.env`, `server/pki/` and `node_modules/` aren't in git; they get created on the server.

## 3. Install dependencies

```sh
cd /opt/i3x-on-OPC
sudo -u i3x npm ci                          # exact pinned versions from package-lock.json
sudo -u i3x cp .env.example .env            # simulation settings; the defaults are fine
```

The plant NodeSets (`nodesets/factory/BeverageFactory.NodeSet2.xml` and `ISA95Operations.NodeSet2.xml`) are committed. If either is missing, run `sudo -u i3x npm run generate -w factory`.

Optional smoke test before systemd: `sudo -u i3x ./start.sh`, wait for `front door http://localhost:8084/v1`, then Ctrl-C.

## 4. Install the unit

```sh
cp deploy/i3x-on-opc.service /etc/systemd/system/
sudo -u i3x bash -lc 'command -v node'      # e.g. /home/i3x/.nvm/versions/node/v24.x/bin/node
```

Edit `/etc/systemd/system/i3x-on-opc.service`:

| Line | Set it to |
|---|---|
| `User=` | the service user (`i3x`) |
| `WorkingDirectory=` | the checkout (`/opt/i3x-on-OPC`) |
| `Environment=PATH=` | the directory holding `node` first, e.g. `/home/i3x/.nvm/versions/node/v24.x/bin:/usr/local/bin:/usr/bin:/bin`. systemd doesn't read nvm or `.bashrc`. |
| `Environment=FRONT_DOOR_PORT=` | `8084`, or a free port if 8084 is taken (`ss -ltnp | grep :8084`) |

Write each setting on its own line: systemd unit files don't support comments after a value.

**Other port clashes** (`ss -ltnp | grep -E ':(4840|808[1-3])'`): there's no override yet, so edit `compare/gateways.yaml` on the server. Each gateway has a `port:`. The plant's port is in both `opcua.endpoint` and `opcua.containerEndpoint`; change them together. A local edit there will need care on `git pull`.

## 5. Firewall

Using ufw (replace 8084 if you changed `FRONT_DOOR_PORT`):

```sh
ufw allow 8084/tcp
ufw allow in on docker0 to any port 4840 proto tcp    # required: lets the i3x2ua container reach the plant on the host
# ufw allow 4840/tcp                                  # only if people need UaExpert (writable, see §1)
```

- **Without the `docker0` rule**, ufw's default deny blocks the container from reaching the plant, and i3x2ua never gets ready.
- **With firewalld**, put `docker0` in the `trusted` zone instead: `firewall-cmd --permanent --zone=trusted --add-interface=docker0`.
- **Don't open 8081–8083.** Docker publishes 8082 on 127.0.0.1 only, so its usual habit of bypassing ufw doesn't apply.

## 6. Start and verify

```sh
systemctl daemon-reload
systemctl enable --now i3x-on-opc
journalctl -u i3x-on-opc -f
```

Expect something like the following within a minute or two (the first start pulls the i3x2ua image):

```
[compare] cesmii: ready in 3.0 s → http://localhost:8081/v1
[compare] i3x2ua: ready in 10.1 s → http://localhost:8082/v1
[compare] uns: ready in 2.0 s → http://localhost:8083/v1
[compare] front door http://localhost:8084/v1 → active "cesmii" …
[compare] read-only (COMPARE_READ_ONLY): PUT/DELETE/PATCH and /_switch are refused
```

Then, from **another machine** (`H=http://<server>:8084`):

```sh
curl -s $H/ | head -20                                   # status: all three gateways "ready in …"
curl -s $H/cesmii/v1/info                                # … "update":{"current":false …
curl -s $H/i3x2ua/v1/info; curl -s $H/uns/v1/info
curl -s -X PUT -H 'Content-Type: application/json' $H/cesmii/v1/objects/value -d '{"updates":[]}'   # → 501 read-only
curl -s -o /dev/null -w '%{http_code}\n' $H/_switch/uns  # → 403
curl -s --max-time 3 http://<server>:8081/v1/info || echo "8081 closed (good)"
```

In **i3X Explorer**, add `http://<server>:8084/cesmii/v1`, `…/i3x2ua/v1` and `…/uns/v1`. `docs/WALKTHROUGH.md` is the guided tour.

Optional, from a machine with the conformance suite: `node bin/i3x-test.js run http://<server>:8084/cesmii/v1`.

## 7. Operate

| Task | How |
|---|---|
| Logs | `journalctl -u i3x-on-opc`, plus each gateway's log in `compare/logs/<name>.log` |
| Restart | `systemctl restart i3x-on-opc`. The simulation starts over (seeded, so it's reproducible); history is in memory only |
| Stop | `systemctl stop i3x-on-opc`. It sends SIGINT; the launcher stops each process group and runs `docker rm -f` on the container, the same as Ctrl-C |
| Status table | `cd /opt/i3x-on-OPC && sudo -u i3x ./start.sh status` |
| Change the gateway behind `/v1` | edit `active:` in `compare/gateways.yaml`; it's picked up live (`/_switch` is disabled) |
| Simulation settings | `.env` (`SIM_SPEED`, `SIM_SEED`, `SIM_HISTORY`, `SIM_FAULTS`), then restart |
| Update | `sudo -u i3x git pull` (or fetch a new bundle), `sudo -u i3x npm ci`, then restart. Re-copy the unit only if `deploy/i3x-on-opc.service` changed, and re-apply your edits |
| Uninstall | `systemctl disable --now i3x-on-opc && rm /etc/systemd/system/i3x-on-opc.service && systemctl daemon-reload`; remove the firewall rules |

## 8. Troubleshooting

| Symptom | Likely cause |
|---|---|
| `front door port :8084 is already in use` | Something else holds the port: set `FRONT_DOOR_PORT` (§4) |
| `node: command not found` / exit 127 | `PATH=` in the unit doesn't include node's directory |
| i3x2ua `docker run failed` / `permission denied … docker.sock` | The user isn't in the `docker` group (re-login doesn't apply to services: `systemctl restart`) or Docker isn't running |
| i3x2ua times out after 240 s | Missing `docker0` firewall rule (§5), or the image pull is blocked |
| Explorer can't connect | The 8084 firewall rule, or a cloud provider's security group in front of the host |
| SSE subscriptions stall behind a proxy | The proxy buffers: in Nginx set `proxy_buffering off` for `/…/subscriptions/stream` |

**Nginx later (D8: TLS and auth).** Proxy `443 → http://127.0.0.1:8084`, turn buffering off for the stream endpoints, add authentication (`/info` should stay open), then remove the 8084 firewall rule.
