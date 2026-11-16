/**
 * ISA95Operations: the leftover types the plant needs beyond the OPC Foundation NodeSets
 * (namespace https://cesmii.net/i3x-demo/ISA95Operations/, written to its own NodeSet).
 *
 * Why each exists (checked against ISA-95 COM 1.00 = OPC 10030, the only ISA-95 NodeSet we load):
 * - COM 1.00 models the resources (equipment, personnel, physical assets, material) but no work:
 *   no work request / job order objects. OPC 10031-4 (ISA-95 Job Control) has job orders, but as
 *   Structures passed to a JobOrderReceiver's methods, not as browsable Objects. So WorkRequestType
 *   and JobOrderType are ours; their field and state names follow OPC 10031-4's ISA95JobOrderDataType
 *   and ISA95JobOrderStateMachineType, so a later move to 10031-4 is a rename, not a redesign.
 * - COM 1.00 has no references *between* the resource models (person ↔ equipment, material ↔
 *   equipment, order ↔ anything). The names below are ISA-95 vocabulary: material use
 *   Consumed/Produced (Part 2 §5.6 / Part 4 material actuals), storage location (MaterialLot
 *   attribute), dispatching (Part 3 §6.6, Part 4 job orders' hierarchy scope).
 * - COM 1.00 declares MaterialDefinitionType's <MaterialClass> placeholder with no reference at all,
 *   unlike equipment and personnel (DefinedByEquipmentClass, DefinedByPersonnelClass). We add the
 *   missing sibling DefinedByMaterialClass under COM's own abstract DefinedBy.
 *
 * Design: docs/factory/PLANT_DESIGN.md §8; COM findings: docs/factory/STANDARDS_COVERAGE.md.
 */
import { type AddressSpace, type Namespace, type UAObjectType, type UAReferenceType } from "node-opcua-address-space";
import { NSU } from "./lib/load.js";

export interface OpsTypes {
  DefinedByMaterialClass: UAReferenceType;
  Operates: UAReferenceType;
  Consumes: UAReferenceType;
  Produces: UAReferenceType;
  StoredIn: UAReferenceType;
  DispatchedTo: UAReferenceType;
  WorkRequestType: UAObjectType;
  JobOrderType: UAObjectType;
}

export function buildOpsTypes(as: AddressSpace, ns: Namespace): OpsTypes {
  const isa = as.getNamespaceIndex(NSU.ISA95);
  const id = (i: number) => `ns=${ns.index};i=${i}`;
  const nonHier = as.findReferenceType("NonHierarchicalReferences")!;
  const ref = (i: number, browseName: string, inverseName: string, description: string, subtypeOf: UAReferenceType = nonHier) =>
    ns.addReferenceType({ nodeId: id(i), browseName, inverseName, description, subtypeOf });

  const DefinedByMaterialClass = ref(4001, "DefinedByMaterialClass", "MaterialClassOf",
    "Categorizes a MaterialDefinition by a MaterialClass. The sibling of ISA-95 COM DefinedByEquipmentClass / DefinedByPersonnelClass, which COM 1.00 lacks.",
    as.findReferenceType("DefinedBy", isa)!);
  const Operates = ref(4002, "Operates", "OperatedBy",
    "A Person operates an equipment element (ISA-95 personnel assigned to equipment; Part 4 personnel actual).");
  const Consumes = ref(4003, "Consumes", "ConsumedBy",
    "Equipment or a job order consumes a material lot (ISA-95 material use \"Consumed\").");
  const Produces = ref(4004, "Produces", "ProducedBy",
    "Equipment or a job order produces a material lot (ISA-95 material use \"Produced\").");
  const StoredIn = ref(4005, "StoredIn", "StorageLocationOf",
    "A material lot is stored in an equipment element (ISA-95 MaterialLot \"Storage Location\"). ISA-95 COM 1.00 has LocatedIn, but declares it a subtype of HasProperty, so it can't link two Objects.");
  const DispatchedTo = ref(4006, "DispatchedTo", "ReceivesJobOrder",
    "A job order is dispatched to the equipment element that executes it (ISA-95 Part 3 dispatching; the job order's hierarchy scope; the OPC 10031-4 JobOrderReceiver).");

  const isa95Object = as.findObjectType("ISA95ObjectType", isa)!;
  const prop = (owner: UAObjectType, browseName: string, dataType: string, mandatory: boolean, description: string) =>
    ns.addVariable({ propertyOf: owner, browseName, dataType, description, modellingRule: mandatory ? "Mandatory" : "Optional" });
  const state = (owner: UAObjectType, description: string) =>
    ns.addVariable({ componentOf: owner, browseName: "State", dataType: "String", typeDefinition: "BaseDataVariableType", modellingRule: "Mandatory", description });
  const quantity = (owner: UAObjectType, browseName: string, description: string) =>
    as.findVariableType("AnalogUnitType")!.instantiate({ namespace: ns, componentOf: owner, browseName: { namespaceIndex: ns.index, name: browseName }, dataType: "Double",
      valueRank: -1, modellingRule: "Mandatory", description });
  const STATES = "OPC 10031-4 ISA95JobOrderStateMachineType state name: NotAllowedToStart, AllowedToStart, Running, Interrupted, Ended or Aborted.";

  // both types first, so their fixed NodeIds are taken before node-opcua numbers the members
  const WorkRequestType = ns.addObjectType({ nodeId: id(1001), browseName: "WorkRequestType", subtypeOf: isa95Object,
    description: "An ISA-95 work request (Part 4): a production order, made up of the job orders that carry it out." });
  const JobOrderType = ns.addObjectType({ nodeId: id(1002), browseName: "JobOrderType", subtypeOf: isa95Object,
    description: "An ISA-95 job order (Part 4): one unit of work dispatched to an equipment element. Fields follow OPC 10031-4 ISA95JobOrderDataType." });
  prop(JobOrderType, "JobOrderID", "String", true, "Unique identifier of the job order");
  prop(JobOrderType, "Description", "String", true, "What the job order does");
  prop(JobOrderType, "WorkMasterID", "String", true, "The work master (recipe / routing) the job order executes");
  prop(JobOrderType, "Priority", "Int32", false, "Scheduling priority (1 = highest)");
  prop(JobOrderType, "StartTime", "UtcTime", false, "Actual start");
  prop(JobOrderType, "EndTime", "UtcTime", false, "Actual end");
  state(JobOrderType, STATES);
  quantity(JobOrderType, "PlannedQuantity", "Quantity to produce or process");
  quantity(JobOrderType, "ActualQuantity", "Quantity produced or processed so far");

  prop(WorkRequestType, "WorkRequestID", "String", true, "Unique identifier of the work request");
  prop(WorkRequestType, "Description", "String", true, "What the work request produces");
  prop(WorkRequestType, "Priority", "Int32", false, "Scheduling priority (1 = highest)");
  prop(WorkRequestType, "StartTime", "UtcTime", false, "Actual start");
  prop(WorkRequestType, "EndTime", "UtcTime", false, "Actual end");
  state(WorkRequestType, `Aggregate of its job orders; ${STATES}`);
  ns.addObject({ componentOf: WorkRequestType, browseName: "<JobOrder>", typeDefinition: JobOrderType, modellingRule: "OptionalPlaceholder",
    description: "The job orders that make up this work request" });

  return { DefinedByMaterialClass, Operates, Consumes, Produces, StoredIn, DispatchedTo, WorkRequestType, JobOrderType };
}
