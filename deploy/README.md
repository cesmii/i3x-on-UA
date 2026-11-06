# Running the demo on a server (systemd)

`i3x-on-opc.service` runs what `./start.sh` runs: the plant, cesmii, i3x2ua, uns and the front door on :8080. It runs **read-only**.

## What is exposed

| Port | What | Open it? |
|---|---|---|
| **8080** (`FRONT_DOOR_PORT` in the unit) | Front door: `/cesmii/v1`, `/i3x2ua/v1`, `/uns/v1`, `/v1` (active), `/` status | **Yes.** This is the one to give the WG. |
| 4840 | OPC UA plant (`opc.tcp://<host>:4840/UA/BeverageFactory`), for UaExpert | Only if people need UaExpert; see below |
| 8081, 8083 | cesmii, uns directly (bound to all interfaces) | No: same content as `/cesmii/v1` and `/uns/v1` |
| 8082 | i3x2ua container, bound to 127.0.0.1 only | Can't (Docker would otherwise bypass ufw) |

**Read-only (`COMPARE_READ_ONLY=1`, `GATEWAY_READ_ONLY=1`):**
- The front door refuses `PUT`, `DELETE` and `PATCH` for every gateway (501) and `/_switch/…` (403). i3X reads are `GET` or `POST`, so they still work.
- cesmii itself returns 501 on `PUT /objects/value` and reports `capabilities.update.current: false`.
- i3x2ua runs with writes off (its default); uns never writes.
- Conformance through the front door: 1.0 Compatible, with Update omitted.

**The OPC UA server is not read-only:** it allows anonymous access with security None. Anyone who reaches 4840 can write the Machinery Identification read-write properties (`AssetId`, `ComponentName`, `Location`). No Methods are implemented. Keep 4840 closed unless UaExpert access matters; a restart puts the values back.

**No TLS or authentication.** That's acceptable for a demo; the conformance suite warns (CORE-06). Decision D8 is Nginx in front for TLS and auth. If you add it, proxy `443 → 127.0.0.1:8080`, disable buffering for `/subscriptions/stream` (`proxy_buffering off`) and close 8080.

## Install (Linux, as root)

```sh
useradd --system --create-home i3x                                 # or use an existing user (needs a home for npm's cache)
usermod -aG docker i3x
install -d -o i3x -g i3x /opt/i3x-on-OPC
sudo -u i3x git clone <repo> /opt/i3x-on-OPC
cd /opt/i3x-on-OPC
sudo -u i3x npm ci                                                 # Node 24
sudo -u i3x cp .env.example .env                                   # sim settings (optional)
# the plant NodeSet is committed; if it's missing: sudo -u i3x npm run generate -w factory

cp deploy/i3x-on-opc.service /etc/systemd/system/
# edit User=, WorkingDirectory= and PATH= (the directory with `node`: `dirname $(sudo -u i3x bash -lc 'command -v node')`)
systemctl daemon-reload
systemctl enable --now i3x-on-opc
journalctl -u i3x-on-opc -f                                       # wait for "front door http://localhost:8080/v1"
```

i3x2ua pulls its image on first start, so allow a minute or two.

## Firewall (ufw)

If 8080 is taken, set `Environment=FRONT_DOOR_PORT=<port>` in the unit and use that port below. The other ports are in `compare/gateways.yaml` (`port:` per gateway, `opcua.endpoint`/`containerEndpoint` for 4840) if they clash too.

```sh
ufw allow 8080/tcp
# ufw allow 4840/tcp                                  # only for UaExpert access (writable, see above)
ufw allow in on docker0 to any port 4840 proto tcp    # needed: i3x2ua (in Docker) reads the plant through the host
```

Without the `docker0` rule, ufw's default deny blocks the container's connection to the plant, and i3x2ua never gets ready (`journalctl` shows its 240 s timeout). With firewalld, add `docker0` to the `trusted` zone instead.

## Operate

- `systemctl restart i3x-on-opc` restarts everything (the plant simulation starts over; history is in memory).
- `systemctl stop` sends SIGINT: the launcher stops each process group and removes the container, the same as Ctrl-C.
- Logs: the journal, plus each gateway's log in `compare/logs/`.
- To change the active gateway behind `/v1`, edit `active:` in `compare/gateways.yaml`. It's picked up live; `/_switch` is disabled.
- `./start.sh status` works on the server as usual.
