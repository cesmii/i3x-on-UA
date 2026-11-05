# Virtual Beverage Plant: Diagrams (draft for Phase 1 review)

Details (ratings, instruments, connections, IDs): `PLANT_DESIGN.md`.

Tags follow ISA-5.1 style. Area numbers: 100 Water Treatment, 200 Syrup Room, 300 Blending & Carbonation, 400 Bottling Line 1, 500 Bottling Line 2 (future, with injected problems for the hack-a-thon), 900 Utilities. Instrument letters: LT level, FT flow, TT temperature, PT pressure, DT density/Brix, CT conductivity, AT analyzer (CO₂), XV on/off valve, FCV flow control valve.

## 1. Process flow (material flow)

Areas are stacked top to bottom, and each area reads left to right. Arrows *between* areas connect the areas themselves; each label names the actual equipment at each end. That's needed because Mermaid ignores a subgraph's own direction whenever its inner nodes link outside it.

```mermaid
flowchart TB
  classDef tank fill:#dbeafe,stroke:#1d4ed8,color:#0b1b3f
  classDef vendortank fill:#dbeafe,stroke:#c2410c,stroke-width:3px,color:#0b1b3f
  classDef pump fill:#dcfce7,stroke:#15803d,color:#052e16
  classDef skid fill:#fef3c7,stroke:#b45309,color:#3b1d02
  classDef machine fill:#f3e8ff,stroke:#7e22ce,color:#2e0a4f
  classDef util fill:#e5e7eb,stroke:#4b5563,color:#111827
  classDef future fill:#ffffff,stroke:#9ca3af,stroke-dasharray:5 5,color:#6b7280


  subgraph A100["Area 100: Water Treatment"]
    direction LR
    T101[("T-101 Raw Water Tank<br/>LT-101 · XV-101")]:::tank
    P101(["P-101 Raw Water Pump"]):::pump
    F101["F-101 Carbon Filter<br/>PDT-101"]:::skid
    RO101["RO-101 Reverse Osmosis Skid<br/>PT-102 · FT-101 · CT-101"]:::skid
    T102[("T-102 Treated Water Tank<br/>LT-102 · TT-102")]:::tank
    P102(["P-102 Treated Water Pump<br/>FT-102"]):::pump
    T101 --> P101 --> F101 --> RO101 --> T102 --> P102
  end

  subgraph A200["Area 200: Syrup Room"]
    direction LR
    SUGAR[/"Granulated Sugar"/]:::util
    SD201[("SD-201 Sugar Dissolver<br/>DT-201")]:::vendortank
    P201(["P-201 Dissolver Discharge Pump"]):::pump
    T201[("T-201 Simple Syrup Tank")]:::vendortank
    P202(["P-202 Syrup Transfer Pump"]):::pump
    T202[("T-202 Final Syrup Tank<br/>DT-202")]:::vendortank
    CONC[/"Flavor Concentrate<br/>XV-202 dosing"/]:::util
    P203(["P-203 Syrup Feed Pump"]):::pump
    SUGAR --> SD201 --> P201 --> T201 --> P202 --> T202 --> P203
    CONC --> T202
  end

  subgraph A300["Area 300: Blending & Carbonation"]
    direction LR
    DA301["DA-301 Deaerator<br/>AT-301 O₂ · PT-303"]:::skid
    BL301["BL-301 Inline Blender 1:5<br/>FT-301 · FT-302 · DT-301<br/>FCV-301 · FCV-302"]:::skid
    HX301["HX-301 Product Cooler<br/>TT-301"]:::skid
    CB301["CB-301 Carbonator<br/>AT-302 CO₂ · PT-304 · PCV-311"]:::skid
    T301[("T-301 Product Buffer Tank<br/>LT-301 · PT-305 · TT-305 · XV-301")]:::tank
    DA301 --> BL301 --> HX301 --> CB301 --> T301
  end

  subgraph A400["Area 400: Bottling Line 1 (PackML)"]
    direction LR
    FL401["FL-401 Filler"]:::machine
    CP402["CP-402 Capper"]:::machine
    LB403["LB-403 Labeler"]:::machine
    CK404["CK-404 Case Packer"]:::machine
    PZ405["PZ-405 Palletizer"]:::machine
    BOT[/"Empty PET bottles · caps · labels · cases"/]:::util
    WH[/"Finished goods (pallets)"/]:::util
    BOT --- FL401 --- CP402 --- LB403 --- CK404 --- PZ405 --- WH
  end

  subgraph A500["Area 500: Bottling Line 2 (future)"]
    direction LR
    FL501["FL-501 Filler"]:::future
    CP502["CP-502 Capper"]:::future
    LB503["LB-503 Labeler"]:::future
    CK504["CK-504 Case Packer"]:::future
    PZ505["PZ-505 Palletizer"]:::future
    FL501 -.- CP502 -.- LB503 -.- CK504 -.- PZ505
  end

  subgraph A900["Area 900: Utilities"]
    direction LR
    CO2[("CO2-901 CO₂ Supply<br/>LT-901 · PT-901")]:::util
    AIR["AC-902 Compressed Air<br/>PT-902"]:::util
    CIP["CIP-903 Clean-in-Place (later)"]:::future
  end

  %% Area-to-area links. Linking areas (not inner nodes) lets each area keep its own LR layout.
  A100 -- "treated water (P-102 → SD-201)" --> A200
  A100 -- "treated water (P-102 → DA-301)" --> A300
  A200 -- "final syrup (P-203 → BL-301)" --> A300
  A900 -- "CO₂ (CO2-901 → CB-301)" --> A300
  A300 -- "beverage (T-301 → FL-401)" --> A400
  A300 -. "beverage (future)" .-> A500
  A900 -. "compressed air" .-> A400

  subgraph LEGEND["Legend"]
    direction LR
    LG1[("Storage / buffer tank (ISA-95)")]:::tank
    LG2[("Mixing tank (Acme vendor type)")]:::vendortank
    LG3(["Pump (OPC 40223)"]):::pump
    LG4["Process unit / skid"]:::skid
    LG5["Packaging machine (Machinery + PackML)"]:::machine
    LG6[/"Supply / utility / material in or out"/]:::util
    LG7["Future (not built yet)"]:::future
    LGa[" "]:::util
    LGb[" "]:::util
    LGc[" "]:::future
    LGd[" "]:::future
    LGe[" "]:::machine
    LGf[" "]:::machine
    LGa -- "material flow" --> LGb
    LGc -. "future / indirect supply" .-> LGd
    LGe --- |"machine sequence (not modeled yet)"| LGf
    LG1 ~~~ LG2 ~~~ LG3 ~~~ LG4 ~~~ LG5 ~~~ LG6 ~~~ LG7
  end
  A400 ~~~ A500
  A500 ~~~ LEGEND
```

**Legend** (also drawn in the diagram):

| Shape / color | Meaning | Modeled with |
|---|---|---|
| Blue cylinder, blue outline | Storage / buffer tank | ISA-95 Equipment + EquipmentClass |
| Blue cylinder, thick orange outline | Mixing tank | Vendor `MixingTankType` (Acme profile, non-standard) |
| Green stadium | Pump | Pumps (OPC 40223) `PumpType` |
| Amber rectangle | Process unit or skid (filter, RO, deaerator, blender, cooler, carbonator) | ISA-95 Equipment + Machinery AddIns + PA-DIM instruments |
| Purple rectangle | Packaging machine | PackML `PackMLBaseObjectType` + Machinery AddIns |
| Grey parallelogram | External supply, utility, or material entering or leaving the plant | ISA-95 Equipment or not modeled |
| Dashed white box | Future scope (Line 2, CIP) | not built yet |
| Solid arrow | Material flow (direction of flow) | Pumps ports (`Direction` In/Out) joined by a connection reference (see STANDARDS_COVERAGE) |
| Dotted arrow | Future or indirect supply (e.g. compressed air to the whole line) | not modeled yet |
| Plain line between machines | Machine sequence on the packaging line | **not modeled as material links yet** (decided 2026-11-05) |
| Text under a name (LT-101, FT-301, …) | Instruments on that unit (ISA-5.1 tags) | PA-DIM devices |

## 2. Equipment hierarchy (ISA-95, `MadeUpOfEquipment`)

```mermaid
flowchart TD
  ENT["Enterprise: Demo Beverage Co."] --> SITE["Site: Plant 1"]
  SITE --> A100["Area: Water Treatment"]
  SITE --> A200["Area: Syrup Room"]
  SITE --> A300["Area: Blending & Carbonation"]
  SITE --> A400["ProductionLine: Bottling Line 1"]
  SITE -.-> A500["ProductionLine: Bottling Line 2 (future)"]
  SITE --> A900["Area: Utilities"]

  A100 --> U1["Units: T-101, F-101, RO-101, T-102"]
  A100 --> P1["Pumps: P-101, P-102 (OPC 40223)"]
  A200 --> U2["Units: SD-201, T-201, T-202 (Acme)<br/>Pumps: P-201, P-202, P-203"]
  A300 --> U3["Units: DA-301, BL-301, HX-301, CB-301, T-301"]
  A400 --> M4["WorkCells: FL-401 … PZ-405 (Machinery + PackML)"]
  U1 --> I1["ControlModules: LT/FT/TT/PT/CT transmitters, valves (PA-DIM)"]
```

Machines are **direct children of their line**. Machinery's `Machines` folder (§9) also `Organizes` FL-401 … PZ-405 (and the skids that carry Machinery building blocks), because the spec requires that entry point. In i3X, `parentId` is the line, and the `Machines` link appears only as a graph relationship with a fidelity note.
