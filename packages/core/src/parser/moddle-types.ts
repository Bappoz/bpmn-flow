/**
 * Structural view of the subset of the bpmn-moddle object tree consumed by the
 * parser. bpmn-moddle returns plain objects tagged with a `$type` discriminator
 * and cross-references resolved to object pointers (e.g. `sourceRef` is the
 * referenced element, not an id string).
 */

export interface MdRef {
  $type?: string;
  id?: string;
}

/** Anything a tool put under `bpmn:extensionElements`, attributes included. */
export interface MdExtensionElements {
  values?: (MdRef & { correlationKey?: string })[];
}

export interface MdEventDefinition {
  $type: string;
  /** Extensions on the event definition itself. */
  extensionElements?: MdExtensionElements;
  /** Link events carry the name on the definition itself. */
  name?: string;
  /** Conditional events: the expression that makes them fire. */
  condition?: { body?: string };
  /** Compensation throw events may target one activity. */
  activityRef?: MdRef;
  timeDuration?: { body?: string };
  timeDate?: { body?: string };
  timeCycle?: { body?: string };
  messageRef?: MdRef & { name?: string; extensionElements?: MdExtensionElements };
  signalRef?: MdRef & { name?: string };
  errorRef?: MdRef & { name?: string; errorCode?: string };
  escalationRef?: MdRef & { name?: string; escalationCode?: string };
}

/** `bpmn:MultiInstanceLoopCharacteristics` / `bpmn:StandardLoopCharacteristics`. */
export interface MdLoopCharacteristics {
  $type: string;
  isSequential?: boolean;
  loopCardinality?: { body?: string };
  completionCondition?: { body?: string };
  /** Resolved data object/input holding the collection to iterate. */
  loopDataInputRef?: MdRef & { name?: string };
  loopDataOutputRef?: MdRef & { name?: string };
  inputDataItem?: MdRef & { name?: string };
  outputDataItem?: MdRef & { name?: string };
  // standard loop
  loopCondition?: { body?: string };
  testBefore?: boolean;
  loopMaximum?: number | string;
}

/** `bpmn:PotentialOwner` / `bpmn:Performer` inside an activity. */
export interface MdResourceRole {
  $type: string;
  name?: string;
  resourceAssignmentExpression?: { expression?: { body?: string } };
}

/** `bpmn:DataInputAssociation` / `bpmn:DataOutputAssociation`. */
export interface MdDataAssociation {
  $type: string;
  assignment?: { from?: { body?: string }; to?: { body?: string } }[];
}

/** `bpmn:Lane` with the flow nodes it contains (references resolved). */
export interface MdLane {
  $type: string;
  id?: string;
  name?: string;
  flowNodeRef?: MdRef[];
  childLaneSet?: { lanes?: MdLane[] };
}

export interface MdElement {
  $type: string;
  id?: string;
  name?: string;
  /** Diagram interchange, when the file carries layout. */
  diagrams?: unknown[];

  // bpmn:Definitions
  rootElements?: MdElement[];

  // bpmn:Process / bpmn:SubProcess
  isExecutable?: boolean;
  flowElements?: MdElement[];
  triggeredByEvent?: boolean;

  // flow node wiring (arrays of resolved sequence-flow objects)
  incoming?: MdRef[];
  outgoing?: MdRef[];

  // events
  eventDefinitions?: MdEventDefinition[];
  attachedToRef?: MdRef;
  cancelActivity?: boolean;
  /** Multiple events: does the event need every trigger, or just one? */
  parallelMultiple?: boolean;
  /** Start event of an event subprocess: does it cancel the enclosing scope? */
  isInterrupting?: boolean;

  // gateways / activities
  default?: MdRef;
  /** Complex gateway: when the join is allowed to fire. */
  activationCondition?: { body?: string };

  // call activity
  calledElement?: string;

  // activities: multi-instance / standard loop
  loopCharacteristics?: MdLoopCharacteristics;

  // activities: who is expected to perform the work
  resources?: MdResourceRole[];
  /** Receive/send tasks: the message they wait for or emit. */
  messageRef?: MdRef & { name?: string; extensionElements?: MdExtensionElements };
  /** Extensions a tool attached to the element. */
  extensionElements?: MdExtensionElements;

  /** Ad-hoc subprocess: when its activities are considered done. */
  completionCondition?: { body?: string };
  /** Ad-hoc subprocess: `Parallel` (default) or `Sequential`. */
  ordering?: string;

  /** Data mapping in and out of an activity. */
  dataInputAssociations?: MdDataAssociation[];
  dataOutputAssociations?: MdDataAssociation[];

  /** Formal data inputs/outputs of an activity or process. */
  ioSpecification?: MdRef;
  /** Standard message correlation declared by the process. */
  correlationSubscriptions?: MdRef[];

  // process: swimlanes
  laneSets?: { lanes?: MdLane[] }[];
  /** Artifacts of a process/subprocess: associations, text annotations. */
  artifacts?: MdElement[];
  /** Activity that only runs as a compensation handler. */
  isForCompensation?: boolean;

  // sequence flow
  sourceRef?: MdRef;
  targetRef?: MdRef;
  conditionExpression?: { body?: string };

  // data elements
  /** `bpmn:dataObject`: declared as a collection. */
  isCollection?: boolean;
  /** `bpmn:dataObjectReference` -> the data object it stands for. */
  dataObjectRef?: MdRef;
  /** `bpmn:dataStoreReference` -> the data store it stands for. */
  dataStoreRef?: MdRef;

  // collaboration
  participants?: MdElement[];
  processRef?: MdRef;
  messageFlows?: MdElement[];
}
