import { BpmnModdle } from 'bpmn-moddle';
import { BpmnParseError } from '../errors.js';
import type { DataElementKind, ElementKind, EventDefinitionKind } from '../model/kinds.js';
import {
  EVENT_KINDS,
  GATEWAY_KINDS,
  SUBPROCESS_KINDS,
  TASK_KINDS,
  isDataElementKind,
  isEventKind,
} from '../model/kinds.js';
import type {
  Association,
  BpmnModel,
  DataElement,
  DataMapping,
  EventDetail,
  FlowNode,
  LoopCharacteristics,
  MessageFlow,
  Participant,
  ProcessModel,
  SequenceFlow,
} from '../model/types.js';
import type {
  MdDataAssociation,
  MdElement,
  MdEventDefinition,
  MdLane,
  MdLoopCharacteristics,
  MdResourceRole,
} from './moddle-types.js';

const ELEMENT_KINDS = new Set<string>([
  ...EVENT_KINDS,
  ...TASK_KINDS,
  ...SUBPROCESS_KINDS,
  ...GATEWAY_KINDS,
]);

/** `bpmn:StartEvent` -> `startEvent`. Returns null for non-flow-node types. */
function toElementKind($type: string): ElementKind | null {
  const local = $type.replace(/^[^:]+:/, '');
  const camel = local.charAt(0).toLowerCase() + local.slice(1);
  return ELEMENT_KINDS.has(camel) ? (camel as ElementKind) : null;
}

/** `bpmn:DataObjectReference` -> `dataObjectReference`, or null if not data. */
function toDataElementKind($type: string): DataElementKind | null {
  const local = $type.replace(/^[^:]+:/, '');
  const camel = local.charAt(0).toLowerCase() + local.slice(1);
  return isDataElementKind(camel) ? camel : null;
}

/** One data declaration turned into a normalized {@link DataElement}. */
function readDataElement(el: MdElement, kind: DataElementKind): DataElement | undefined {
  if (!el.id) return undefined;
  const data: DataElement = { id: el.id, kind };
  if (el.name) data.name = el.name;
  const ref = el.dataObjectRef?.id ?? el.dataStoreRef?.id;
  if (ref) data.dataRef = ref;
  if (el.isCollection) data.isCollection = true;
  return data;
}

/** XSD element names that do not match the model's vocabulary. */
const KIND_ALIASES: Record<string, EventDefinitionKind> = {
  // `bpmn:CompensateEventDefinition` is the compensation trigger.
  compensate: 'compensation',
};

/** `bpmn:TimerEventDefinition` -> `timer`. */
function toEventDefinitionKind($type: string): EventDefinitionKind {
  const local = $type.replace(/^[^:]+:/, '').replace(/EventDefinition$/, '');
  const camel = local.charAt(0).toLowerCase() + local.slice(1);
  return KIND_ALIASES[camel] ?? (camel as EventDefinitionKind);
}

/** One `bpmn:*EventDefinition` turned into a normalized detail. */
function readEventDetail(def: MdEventDefinition): EventDetail {
  const detail: EventDetail = { kind: toEventDefinitionKind(def.$type) };
  const timer = def.timeDuration?.body ?? def.timeDate?.body ?? def.timeCycle?.body;
  if (timer) detail.timer = timer;
  const reference =
    def.messageRef?.name ??
    def.signalRef?.name ??
    def.errorRef?.name ??
    def.escalationRef?.name ??
    // Link events name the definition itself.
    def.name;
  if (reference) detail.reference = reference;
  const code = def.errorRef?.errorCode ?? def.escalationRef?.escalationCode;
  if (code) detail.code = code;
  if (def.condition?.body) detail.condition = def.condition.body;
  if (def.activityRef?.id) detail.activityRef = def.activityRef.id;
  return detail;
}

/** Every definition of an event; `none` when it declares none. */
function readEventDetails(defs: MdEventDefinition[] | undefined): EventDetail[] {
  if (!defs || defs.length === 0) return [{ kind: 'none' }];
  return defs.map(readEventDetail);
}

/**
 * Reads multi-instance / standard loop characteristics.
 *
 * Collections come from `loopDataInputRef`, which the spec models as a
 * reference to a data element: the referenced element's name (or id) is used as
 * the process variable holding the array.
 */
function readLoopCharacteristics(
  lc: MdLoopCharacteristics | undefined,
): LoopCharacteristics | undefined {
  if (!lc) return undefined;
  const nameOf = (ref: { id?: string; name?: string } | undefined): string | undefined =>
    ref ? (ref.name ?? ref.id) : undefined;

  if (lc.$type.endsWith(':StandardLoopCharacteristics')) {
    const loop: LoopCharacteristics = { kind: 'standard', sequential: true };
    if (lc.loopCondition?.body) loop.loopCondition = lc.loopCondition.body;
    if (lc.testBefore !== undefined) loop.testBefore = lc.testBefore;
    const maximum = lc.loopMaximum === undefined ? undefined : Number(lc.loopMaximum);
    if (maximum !== undefined && Number.isFinite(maximum)) loop.maximum = maximum;
    return loop;
  }

  const loop: LoopCharacteristics = {
    kind: 'multiInstance',
    sequential: lc.isSequential === true,
  };
  if (lc.loopCardinality?.body) loop.cardinality = lc.loopCardinality.body;
  const collection = nameOf(lc.loopDataInputRef);
  if (collection) loop.collection = collection;
  const elementVariable = nameOf(lc.inputDataItem);
  if (elementVariable) loop.elementVariable = elementVariable;
  const outputCollection = nameOf(lc.loopDataOutputRef);
  if (outputCollection) loop.outputCollection = outputCollection;
  const outputElement = nameOf(lc.outputDataItem);
  if (outputElement) loop.outputElement = outputElement;
  if (lc.completionCondition?.body) loop.completionCondition = lc.completionCondition.body;
  return loop;
}

/** Roles from `bpmn:potentialOwner` / `bpmn:performer` resource assignments. */
function readCandidates(resources: MdResourceRole[] | undefined): string[] {
  if (!resources) return [];
  const names: string[] = [];
  for (const resource of resources) {
    const expression = resource.resourceAssignmentExpression?.expression?.body ?? resource.name;
    if (!expression) continue;
    // A single expression may list several roles: "gerentes, diretoria".
    for (const part of expression.split(',')) {
      const name = part.trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Maps every flow node id to the name of the lane containing it. */
function readLaneAssignments(lanes: MdLane[] | undefined, into: Map<string, string>): void {
  for (const lane of lanes ?? []) {
    const name = lane.name ?? lane.id;
    for (const ref of lane.flowNodeRef ?? []) {
      if (ref.id && name) into.set(ref.id, name);
    }
    readLaneAssignments(lane.childLaneSet?.lanes, into);
  }
}

/** Assignments of a data association, as `from`/`to` expression pairs. */
function readDataMappings(associations: MdDataAssociation[] | undefined): DataMapping[] {
  const mappings: DataMapping[] = [];
  for (const association of associations ?? []) {
    for (const assignment of association.assignment ?? []) {
      const from = assignment.from?.body;
      const to = assignment.to?.body;
      if (from && to) mappings.push({ from, to });
    }
  }
  return mappings;
}

/** `bpmn:Association` artifacts, which wire compensation handlers. */
function readAssociations(artifacts: MdElement[] | undefined): Association[] {
  const associations: Association[] = [];
  for (const artifact of artifacts ?? []) {
    if (!artifact.$type.endsWith(':Association')) continue;
    if (!artifact.id || !artifact.sourceRef?.id || !artifact.targetRef?.id) continue;
    associations.push({
      id: artifact.id,
      sourceRef: artifact.sourceRef.id,
      targetRef: artifact.targetRef.id,
    });
  }
  return associations;
}

interface ScopeAccumulator {
  nodes: FlowNode[];
  flows: SequenceFlow[];
  dataElements: DataElement[];
}

/** Recursively walks a process/subprocess scope into normalized model arrays. */
function readScope(elements: MdElement[]): ScopeAccumulator {
  const nodes = new Map<string, FlowNode>();
  const flows: SequenceFlow[] = [];
  const dataElements: DataElement[] = [];

  // First pass: flow nodes (so we can wire flows onto them afterwards).
  for (const el of elements) {
    const kind = toElementKind(el.$type);
    if (!kind || !el.id) continue;

    const node: FlowNode = { id: el.id, kind, incoming: [], outgoing: [] };
    if (el.name) node.name = el.name;
    if (isEventKind(kind)) {
      const details = readEventDetails(el.eventDefinitions);
      node.event = details[0];
      node.events = details;
    }
    if (kind === 'boundaryEvent') {
      if (el.attachedToRef?.id) node.attachedToRef = el.attachedToRef.id;
      node.cancelActivity = el.cancelActivity !== false;
    }
    if (el.default?.id) node.default = el.default.id;
    if (el.activationCondition?.body) node.activationCondition = el.activationCondition.body;
    if (el.calledElement) node.calledElement = el.calledElement;
    const loop = readLoopCharacteristics(el.loopCharacteristics);
    if (loop) node.loop = loop;
    const candidates = readCandidates(el.resources);
    if (candidates.length > 0) node.candidates = candidates;
    const message = el.messageRef?.name ?? el.messageRef?.id;
    if (message) node.messageRef = message;
    if (kind === 'adHocSubProcess') {
      if (el.completionCondition?.body) node.completionCondition = el.completionCondition.body;
      if (el.ordering?.toLowerCase() === 'sequential') node.sequential = true;
    }
    const dataInput = readDataMappings(el.dataInputAssociations);
    if (dataInput.length > 0) node.dataInput = dataInput;
    const dataOutput = readDataMappings(el.dataOutputAssociations);
    if (dataOutput.length > 0) node.dataOutput = dataOutput;
    if (el.triggeredByEvent) node.triggeredByEvent = true;
    if (kind === 'startEvent' && el.isInterrupting !== undefined) {
      node.interrupting = el.isInterrupting;
    }
    if (el.isForCompensation) node.isForCompensation = true;
    if (el.flowElements && el.flowElements.length > 0) {
      const inner = readScope(el.flowElements);
      const associations = readAssociations(el.artifacts);
      node.process = {
        id: el.id,
        isExecutable: true,
        flowNodes: inner.nodes,
        sequenceFlows: inner.flows,
        ...(associations.length > 0 ? { associations } : {}),
        ...(inner.dataElements.length > 0 ? { dataElements: inner.dataElements } : {}),
      };
    }
    nodes.set(node.id, node);
  }

  // Second pass: sequence flows, wiring incoming/outgoing from the flows
  // themselves rather than trusting the optional node arrays.
  for (const el of elements) {
    if (toElementKind(el.$type) !== null) continue;
    const dataKind = toDataElementKind(el.$type);
    if (dataKind) {
      const data = readDataElement(el, dataKind);
      if (data) dataElements.push(data);
      continue;
    }
    if (el.$type.endsWith(':SequenceFlow') && el.id && el.sourceRef?.id && el.targetRef?.id) {
      const flow: SequenceFlow = {
        id: el.id,
        sourceRef: el.sourceRef.id,
        targetRef: el.targetRef.id,
      };
      if (el.name) flow.name = el.name;
      if (el.conditionExpression?.body) flow.conditionExpression = el.conditionExpression.body;
      flows.push(flow);
      nodes.get(el.sourceRef.id)?.outgoing.push(el.id);
      nodes.get(el.targetRef.id)?.incoming.push(el.id);
    }
  }

  // Mark default flows for readability of the model.
  for (const node of nodes.values()) {
    if (node.default) {
      const def = flows.find((f) => f.id === node.default);
      if (def) def.isDefault = true;
    }
  }

  return { nodes: [...nodes.values()], flows, dataElements };
}

function readProcess(el: MdElement): ProcessModel {
  const scope = readScope(el.flowElements ?? []);

  const lanes = new Map<string, string>();
  for (const laneSet of el.laneSets ?? []) readLaneAssignments(laneSet.lanes, lanes);
  for (const node of scope.nodes) {
    const lane = lanes.get(node.id);
    if (lane) node.lane = lane;
  }

  const associations = readAssociations(el.artifacts);
  const process: ProcessModel = {
    id: el.id ?? 'process',
    isExecutable: el.isExecutable !== false,
    flowNodes: scope.nodes,
    sequenceFlows: scope.flows,
    ...(associations.length > 0 ? { associations } : {}),
    ...(scope.dataElements.length > 0 ? { dataElements: scope.dataElements } : {}),
  };
  if (el.name) process.name = el.name;
  return process;
}

/**
 * Parses BPMN 2.0 XML into a normalized {@link BpmnModel}.
 *
 * Recognizes every standard flow node (events with their definitions, all task
 * types, gateways, subprocesses and call activities), sequence flows with
 * conditions, and collaboration participants/message flows. Diagram layout is
 * intentionally ignored; the viewer renders directly from the XML.
 *
 * @throws {BpmnParseError} when the XML is malformed or contains no process.
 */
export async function parseBpmn(xml: string): Promise<BpmnModel> {
  const moddle = new BpmnModdle();
  let rootElement: unknown;
  try {
    ({ rootElement } = await moddle.fromXML(xml));
  } catch (cause) {
    throw new BpmnParseError(
      `Failed to parse BPMN XML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const definitions = rootElement as MdElement;
  const roots = definitions.rootElements ?? [];

  const processes: ProcessModel[] = [];
  const participants: Participant[] = [];
  const messageFlows: MessageFlow[] = [];
  const dataStores: DataElement[] = [];

  for (const root of roots) {
    if (root.$type.endsWith(':Process')) {
      processes.push(readProcess(root));
    } else if (root.$type.endsWith(':DataStore')) {
      const store = readDataElement(root, 'dataStore');
      if (store) dataStores.push(store);
    } else if (root.$type.endsWith(':Collaboration')) {
      for (const part of root.participants ?? []) {
        const participant: Participant = { id: part.id ?? '' };
        if (part.name) participant.name = part.name;
        if (part.processRef?.id) participant.processRef = part.processRef.id;
        participants.push(participant);
      }
      for (const mf of root.messageFlows ?? []) {
        const messageFlow: MessageFlow = { id: mf.id ?? '' };
        if (mf.name) messageFlow.name = mf.name;
        if (mf.sourceRef?.id) messageFlow.sourceRef = mf.sourceRef.id;
        if (mf.targetRef?.id) messageFlow.targetRef = mf.targetRef.id;
        messageFlows.push(messageFlow);
      }
    }
  }

  if (processes.length === 0) {
    throw new BpmnParseError('No BPMN process found in the provided XML.');
  }

  const model: BpmnModel = {
    id: definitions.id ?? 'definitions',
    processes,
    participants,
    messageFlows,
    dataStores,
  };
  if (definitions.name) model.name = definitions.name;
  return model;
}
