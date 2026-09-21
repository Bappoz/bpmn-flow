import type { DataElementKind, ElementKind, EventDefinitionKind } from './kinds.js';

/**
 * Normalized, serializable BPMN model.
 *
 * This is a semantic view of a process: it deliberately omits diagram
 * interchange (DI) layout data, which the viewer reads straight from the raw
 * XML. Everything here is plain data so it can cross a network boundary or be
 * persisted without loss.
 */

/** A directed connection between two flow nodes within a process scope. */
export interface SequenceFlow {
  id: string;
  name?: string;
  sourceRef: string;
  targetRef: string;
  /**
   * FEEL/JavaScript-like boolean expression guarding the flow. Evaluated by the
   * engine against the process variables when leaving a gateway or activity.
   */
  conditionExpression?: string;
  /** True when this flow is the default branch of its source gateway/activity. */
  isDefault?: boolean;
}

/** Structured detail attached to an event via its event definition. */
export interface EventDetail {
  kind: EventDefinitionKind;
  /** Message/signal/error/escalation name, when applicable. */
  reference?: string;
  /** ISO-8601 duration/date or cron for timer events (e.g. "PT5M"). */
  timer?: string;
  /** Error/escalation code, when applicable. */
  code?: string;
  /** Conditional events: expression that fires the event once true. */
  condition?: string;
  /** Compensation throw events: the activity to compensate, if narrowed. */
  activityRef?: string;
}

/**
 * Repetition attached to an activity.
 *
 * `multiInstance` runs the activity once per item of a collection (or a fixed
 * cardinality), in parallel or one at a time. `standard` is a plain loop driven
 * by a boolean condition.
 */
export interface LoopCharacteristics {
  kind: 'multiInstance' | 'standard';
  /** Multi-instance: run instances one at a time. Standard loops always do. */
  sequential: boolean;
  /** Expression yielding how many instances to create. */
  cardinality?: string;
  /** Variable holding the input collection (`loopDataInputRef`). */
  collection?: string;
  /** Per-instance variable receiving the current item (`inputDataItem`). */
  elementVariable?: string;
  /** Variable receiving one entry per instance (`loopDataOutputRef`). */
  outputCollection?: string;
  /** Per-instance variable read into the output collection (`outputDataItem`). */
  outputElement?: string;
  /** Multi-instance: stops the remaining instances once true. */
  completionCondition?: string;
  /** Standard loop: repeat while true. */
  loopCondition?: string;
  /** Standard loop: evaluate the condition before the first iteration. */
  testBefore?: boolean;
  /** Standard loop: hard cap on iterations. */
  maximum?: number;
}

/** A single node in a process graph (event, task, gateway or subprocess). */
export interface FlowNode {
  id: string;
  kind: ElementKind;
  name?: string;
  incoming: string[];
  outgoing: string[];

  /**
   * Present on events; describes the trigger. Defaults to `none`. When an event
   * declares several definitions this is the first one — see {@link events}.
   */
  event?: EventDetail;
  /** Every event definition declared on the event, in document order. */
  events?: EventDetail[];

  /**
   * Multiple events: every declared trigger has to arrive before the event
   * fires. Without it (the specification's default) the first one is enough.
   */
  parallelMultiple?: boolean;

  /** Boundary events: id of the activity they are attached to. */
  attachedToRef?: string;
  /** Boundary events: false for non-interrupting boundary events. */
  cancelActivity?: boolean;

  /** Gateways / activities: id of the default outgoing sequence flow. */
  default?: string;
  /** Complex gateway: expression deciding when the join fires. */
  activationCondition?: string;

  /** Activity that only runs as a compensation handler, never in normal flow. */
  isForCompensation?: boolean;

  /** Receive/send tasks: name of the message they wait for or emit. */
  messageRef?: string;
  /**
   * Message events and receive tasks: expression picking the value that
   * identifies *this* instance among every instance listening for the same
   * message, read from the message's `extensionElements`
   * (`correlationKey="=pedidoId"`).
   *
   * Without it, a message of that name reaches every subscriber — a broadcast,
   * not a message.
   */
  correlationKey?: string;

  /** Ad-hoc subprocess: expression that ends it before every activity ran. */
  completionCondition?: string;
  /** Ad-hoc subprocess: whether its activities run one at a time. */
  sequential?: boolean;

  /**
   * Values copied into the activity's scope when it starts. Declaring any of
   * them isolates the scope: it stops seeing the caller's variables.
   */
  dataInput?: DataMapping[];
  /** Values copied back to the caller when the activity completes. */
  dataOutput?: DataMapping[];

  /** Sub-processes: id of a called global process (call activity). */
  calledElement?: string;
  /** Event sub-processes are triggered by their start event, not by a token. */
  triggeredByEvent?: boolean;
  /**
   * Start event of an event subprocess: `false` for a non-interrupting one,
   * which runs alongside the enclosing scope instead of cancelling it.
   * Defaults to interrupting, as the specification does.
   */
  interrupting?: boolean;
  /** Nested scope for subprocess-like nodes. */
  process?: ProcessModel;

  /** Multi-instance or standard loop attached to the activity. */
  loop?: LoopCharacteristics;

  /** Name of the lane (swimlane) the node belongs to, when the diagram has one. */
  lane?: string;
  /**
   * Roles or people expected to perform the activity, read from
   * `bpmn:potentialOwner` / `bpmn:performer`.
   */
  candidates?: string[];

  /**
   * Work handed to something outside the engine: the activity parks until a
   * worker completes it. Read from `zeebe:taskDefinition` or from Camunda 7's
   * `camunda:type="external"`, so a diagram authored in either tool runs here.
   */
  job?: { type: string; retries?: number };
}

/**
 * Non-executable connection between elements, used by BPMN to link a
 * compensation boundary event to the activity that undoes the work.
 */
export interface Association {
  id: string;
  sourceRef: string;
  targetRef: string;
}

/**
 * One assignment of a data association: read `from` in the source scope, write
 * the result to `to` in the target scope.
 */
export interface DataMapping {
  from: string;
  to: string;
}

/**
 * Data the diagram declares: a data object, a data store, or a reference to
 * either. The engine does not move data through them — variables do that — but
 * they are what the process says it works on, which a viewer or an editor
 * shows and `ioSpecification` builds on.
 */
export interface DataElement {
  id: string;
  kind: DataElementKind;
  name?: string;
  /** Reference kinds: id of the data object or data store they point at. */
  dataRef?: string;
  /** Data objects declared as a collection (`isCollection="true"`). */
  isCollection?: boolean;
}

/** A participant (pool) in a collaboration. */
export interface Participant {
  id: string;
  name?: string;
  processRef?: string;
}

/** A message flow between two participants/nodes in a collaboration. */
export interface MessageFlow {
  id: string;
  name?: string;
  sourceRef?: string;
  targetRef?: string;
}

/** A single BPMN process definition. */
export interface ProcessModel {
  id: string;
  name?: string;
  isExecutable: boolean;
  flowNodes: FlowNode[];
  sequenceFlows: SequenceFlow[];
  /** Associations declared in the scope (compensation wiring). */
  associations?: Association[];
  /** Data objects, data references and data stores declared in the scope. */
  dataElements?: DataElement[];
}

/**
 * A BPMN element the parser saw and did not model, so the engine will not act
 * on it. Recorded rather than dropped, so `validate()` can say out loud which
 * parts of the diagram will not run.
 */
export interface UnsupportedElement {
  /** Local XML name, e.g. `ioSpecification`. */
  type: string;
  id?: string;
  /** Element that declares it, when it hangs off a node or a process. */
  ownerId?: string;
}

/** Root of a parsed BPMN file: one or more processes plus collaboration info. */
export interface BpmnModel {
  id: string;
  name?: string;
  processes: ProcessModel[];
  participants: Participant[];
  messageFlows: MessageFlow[];
  /** `bpmn:dataStore` elements, which the spec declares outside any process. */
  dataStores: DataElement[];
  /** Elements present in the XML that the parser does not model. */
  unsupported: UnsupportedElement[];
}
