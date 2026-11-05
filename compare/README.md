# Gateway switch: compare OPC UA → i3X interpretations (D9)

Runs **our** gateway and the **WG member's** gateway side by side against the same OPC UA plant, behind one front door, so the WG can compare them in i3X Explorer and with the conformance suite.

| Name | Implementation | Interpretation |
|---|---|---|
| `cesmii` | `gateway/`: ours (TypeScript, node-opcua) | `docs/gateway/MAPPING.md` |
| `i3x2ua` | [i3x2ua](https://github.com/AndreasHeine/i3x2ua) by Andreas Heine (Python, FastAPI, asyncua), run as his **unmodified published container** `ghcr.io/andreasheine/i3x2ua:1.16.2` | [OPCUA_I3X_MAPPING_PROFILE.md](https://github.com/AndreasHeine/i3x2ua/blob/master/docs/OPCUA_I3X_MAPPING_PROFILE.md) |

(`AndreasHeine/SampleServer-node-opcua` is his OPC UA *sample server*, not the gateway; here every gateway reads our beverage-plant server instead.)

## Use

**One step** (macOS, Linux, WSL): `./start.sh` from the project root (works from zsh or bash). It checks Node, runs `npm ci` if needed, creates `.env` from `.env.example`, generates the plant NodeSet if missing, starts Docker Desktop on macOS when a Docker gateway is enabled, then runs the launcher. `./start.sh status` and `./start.sh conformance` pass through. The equivalent npm commands:

```
npm run compare                  # start the plant (if not running), the enabled gateways and the front door
npm run compare -- status        # side-by-side: capabilities, namespaces/types/objects counts, roots
npm run compare -- conformance   # i3X conformance suite against each gateway → compare/logs/conformance-<name>.json
```

**Requirements:** Node 24. Docker Desktop must be running for `i3x2ua`; without it, `i3x2ua` is skipped with a message.

**Front door** (`http://localhost:8080`):

| Path | Goes to |
|---|---|
| `/v1/…` | the **active** gateway: `active:` in `gateways.yaml`. Saving the file re-routes live |
| `/cesmii/v1/…`, `/i3x2ua/v1/…` | that gateway, always |
| `/` | status JSON: active gateway, health, upstreams, docs |
| `/_switch/<name>` | switch at runtime (not saved to the file) |

Every proxied response carries `x-i3x-gateway: <name>`. SSE and gzip pass through unchanged.

**In i3X Explorer:** connect to `http://localhost:8080/v1` and flip `active:`, or add two connections, `…/cesmii/v1` and `…/i3x2ua/v1`.

## Configuration (`gateways.yaml`)

- **Side by side is the default:** both gateways are enabled, each on its own port (cesmii `8081`, i3x2ua `8082`). Set each port once (`port:`); `${port}` in a gateway's `env` refers to it. Set `enabled: false` to run only one.
- **Each gateway is an opaque backend.** `kind: process` takes a command and env; `kind: docker` takes an image, ports and env. Add a third interpretation the same way.
- **Fairness rule: each gateway runs with its own documented defaults, and only connection settings change** (OPC UA endpoint, anonymous, SecurityMode None). For `i3x2ua` that means `I3X_ENABLE_WRITES=0`, his `.env-example` default. The yaml explains what happens with writes on.
- **Interpretation switches** for `cesmii` go in its `env` (`I3X_QUALITY: base`, `I3X_ENUMS: name`, …). See MAPPING.md.
- **Lifecycle:** **one Ctrl-C stops everything the launcher started** (plant, gateways, container, front door), including during start-up and when pressed twice. Processes that don't exit within 6 s are killed. A server or gateway that was already listening on its port before you started is used as-is and left running.
  *(Fixed 2026-11-05: earlier, npm/tsx wrapper processes forwarded a second Ctrl-C that force-killed the launcher mid-cleanup, which left the plant and gateway running. The launcher and its processes now run without wrappers (`node --import tsx`), and the stop is two-phase with a kill fallback.)*

## Deployment (Nginx, decision D8)

Same layout as the front door. TLS and auth live in Nginx; both gateways serve plain HTTP on localhost:

```nginx
location /cesmii/v1/ { proxy_pass http://127.0.0.1:8081/v1/; proxy_buffering off; proxy_read_timeout 1h; }
location /i3x2ua/v1/ { proxy_pass http://127.0.0.1:8082/v1/; proxy_buffering off; proxy_read_timeout 1h; }
location /v1/      { proxy_pass http://127.0.0.1:8081/v1/; proxy_buffering off; proxy_read_timeout 1h; }   # the "active" one
location = /v1/info { auth_request off; proxy_pass http://127.0.0.1:8081/v1/info; }                    # i3X: /info stays public
```

`proxy_buffering off` is required for SSE (`/subscriptions/stream`).

## First run (2026-11-05, Line 1 plant, `npm run compare -- status / conformance`)

| | cesmii 0.5.0 | i3x2ua 1.16.2 |
|---|---|---|
| Conformance verdict | 1.0 Compatible: 55 passed, 0 failed, 3 skipped | 1.0 Compatible: 51 passed, 0 failed, 7 skipped |
| Capabilities | history read · current writes · stream | history read · stream (writes off by default) |
| Namespaces | 11 | 13 |
| ObjectTypes | 97 | 576 |
| RelationshipTypes | 15 | 8 |
| Objects | 855 | 5,621 |
| Roots | DeviceSet, NetworkSet, DeviceTopology, Machines, PackMLObjects, Demo Beverage Co., EquipmentClasses | Objects |
| Time for all exploratory list calls | 48 ms | 248 ms |

With writes on, `i3x2ua` failed UPD-01/03/04 against this plant: it forwards a write-back of an *unchanged* value to OPC UA and gets `BadNotWritable`, while `cesmii` treats unchanged attributes as no-ops. That's a real interpretation difference for the WG.

These counts show *that* the interpretations differ. The *why* (what each counts as an Object, how types are projected, identifier schemes, parent choice) is the comparison to do with the WG next.
