# i3X over OPC UA

A virtual beverage plant modelled in OPC UA with the standard companion specifications, served through **three different i3X 1.0 implementations side by side**. You can compare how each one turns the same plant into an i3X address space.

**Live demo: https://opcua.i3x.dev** (read-only). Point [i3X Explorer](https://explorer.i3x.dev) at any of:

| i3X server | URL | What it is |
|---|---|---|
| **CESMII gateway** | `https://opcua.i3x.dev/cesmii/v1` | Our generic OPC UA → i3X gateway. It projects types, references and values, and records what it loses in `metadata.opcua`. |
| **i3x2ua** | `https://opcua.i3x.dev/i3x2ua/v1` | Andreas Heine's independent [OPC UA → i3X gateway](https://github.com/AndreasHeine/i3x2ua), run unmodified with its own defaults. |
| **UNS** | `https://opcua.i3x.dev/uns/v1` | A naive, hand-authored "UNS-style" model that polls tags from the plant and ignores OPC UA types. |

All three pass the [i3X conformance suite](https://conformance.i3x.dev), yet they disagree on roots, object granularity, composition, types, identity and quality. [`docs/gateway/COMPARISON.md`](docs/gateway/COMPARISON.md) lists the differences.

## What's in the plant

One site with water treatment, a syrup room, blending & carbonation, a bottling line and utilities, plus the people, materials and orders around them:

- **Equipment.** Tanks, pumps, process skids and five packaging machines. They're built from ISA-95, OPC UA for Machinery, PackML, Pumps, PA-DIM field instruments and a vendor tank profile.
- **Personnel, materials, orders.** ISA-95 persons and classes, material definitions and lots, and work requests made of job orders. They're linked to the equipment by graph relationships (Operates, Consumes, Produces, StoredIn, DispatchedTo).
- **Live simulation.** Mass balance, batch syrup making, PackML state machines with faults, and starved/blocked propagation. Job orders progress as the line runs.

## Run it yourself

You need **Node.js 24** and **git**. **Docker** is optional: it's only used for the i3x2ua container, which is skipped without it. Works on macOS, Linux and WSL.

```sh
git clone https://github.com/cesmii/i3x-on-UA.git
cd i3x-on-UA
./start.sh
```

The first run installs dependencies, creates `.env` from `.env.example`, and starts Docker Desktop on macOS if needed. It then launches the plant, the three i3X servers and a front door. Wait for:

```
[compare] front door http://localhost:8084/v1 → active "cesmii"
```

| Connect to | URL |
|---|---|
| i3X Explorer: CESMII / i3x2ua / UNS | `http://localhost:8084/cesmii/v1`, `…/i3x2ua/v1`, `…/uns/v1` |
| The active server (switch with `active:` in `compare/gateways.yaml`) | `http://localhost:8084/v1` |
| UaExpert or any OPC UA client (anonymous, security None) | `opc.tcp://localhost:4840/UA/BeverageFactory` |

Through the front door, the enterprise reads "Demo Beverage Co. - CESMII / - Andreas / - UNS", so several Explorer windows are easy to tell apart. Ctrl-C stops everything.

Other commands:

```sh
./start.sh status        # side-by-side counts for each running server
./start.sh conformance   # run the i3X conformance suite against each (needs a local copy of the suite)
```

Settings:
- `.env`: simulation speed and seed, injected faults (`SIM_FAULTS=PT-902=BadNotConnected`), and our gateway's interpretation switches.
- `compare/gateways.yaml`: ports, which servers run, which one `/v1` points at.

Each part can also run on its own, e.g. `npm start -w server` (plant only) or `npm start -w gateway`.

## Where to read next

| | |
|---|---|
| [`docs/WALKTHROUGH.md`](docs/WALKTHROUGH.md) | Guided tour: the same filler, nameplate, states and counts in UaExpert and in each i3X server |
| [`docs/gateway/MAPPING.md`](docs/gateway/MAPPING.md) | How the CESMII gateway maps OPC UA to i3X, with every switch |
| [`docs/gateway/FIDELITY.md`](docs/gateway/FIDELITY.md) | What the projection loses, and the audit that checks every loss is described (`npm run audit -w gateway`) |
| [`docs/gateway/COMPARISON.md`](docs/gateway/COMPARISON.md) | CESMII vs i3x2ua (and UNS), difference by difference |
| [`docs/factory/`](docs/factory/) | Plant design, standards coverage, OPC UA model notes, simulation |
| [`uns/README.md`](uns/README.md) | The UNS persona and its deliberately naive choices |
| [`deploy/README.md`](deploy/README.md) | How the public demo is deployed and kept up to date |
| [`NODESET_TO_JSON_SCHEMA_ANALYSIS.md`](NODESET_TO_JSON_SCHEMA_ANALYSIS.md) | OPC UA types → JSON Schema: the fidelity analysis behind the gateway |

## Layout

```
factory/    plant definition (plant/line1.yaml) → OPC UA NodeSet generator + checks
server/     node-opcua server + process simulation
gateway/    CESMII OPC UA → i3X gateway
uns/        UNS-style i3X server
compare/    launcher + front door that runs them side by side
nodesets/   OPC Foundation NodeSets (standard/), the vendor profile, the generated plant model (factory/)
deploy/     systemd unit, Nginx site and auto-deploy script for https://opcua.i3x.dev
docs/       design notes, comparisons, i3X reference copies
```

This is a CESMII i3X working-group project. The i3X specification is at [cesmii/i3X](https://github.com/cesmii/i3X).

## License

MIT, © CESMII. See [`LICENSE`](LICENSE). The OPC Foundation NodeSets and i3X reference documents keep their own MIT notices. OPC Foundation specification documents and PMMI files are not included; the README in each `docs/` folder says where to get them.
