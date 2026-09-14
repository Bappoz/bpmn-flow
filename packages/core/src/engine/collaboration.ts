import { BpmnExecutionError, BpmnValidationError } from '../errors.js';
import type { BpmnModel, MessageFlow, ProcessModel } from '../model/types.js';
import { Emitter } from './emitter.js';
import { WorkflowEngine } from './engine.js';
import { ENGINE_STATE_VERSION, type EngineState } from './state.js';
import type { IncidentState } from './state.js';
import type {
  EngineEvents,
  EngineOptions,
  ExecutionSnapshot,
  ExecutionStatus,
  PendingTask,
  TaskFilter,
} from './types.js';

/** One participant of the collaboration that actually runs. */
export interface CollaborationParticipant {
  processId: string;
  participantId?: string;
  name?: string;
}

/** A message that travelled from one pool to another. */
export interface DeliveredMessage {
  flowId: string;
  name?: string;
  /** Process the message left. */
  from: string;
  /** Process that took it. */
  to: string;
  /** Node of the receiving pool the message was delivered to. */
  nodeId: string;
}

/** A message whose receiving pool is not subscribed yet. */
export interface InflightMessage {
  flowId: string;
  targetProcessId: string;
  targetNodeId: string;
  payload?: Record<string, unknown>;
}

export interface CollaborationPoolSnapshot extends CollaborationParticipant {
  snapshot: ExecutionSnapshot;
}

export interface CollaborationSnapshot {
  /** Aggregate: the collaboration is only done when every pool is. */
  status: ExecutionStatus;
  pools: CollaborationPoolSnapshot[];
  /** Messages routed between pools so far, oldest first. */
  messages: DeliveredMessage[];
  /** Messages waiting for their receiver to subscribe. */
  inflight: InflightMessage[];
}

/**
 * A task plus the pool it belongs to.
 *
 * Every pool numbers its own tokens, so `tokenId` alone does not identify a
 * task across a collaboration: `taskId` is the one to hand back.
 */
export interface CollaborationTask extends PendingTask {
  processId: string;
  /** `<processId>:<tokenId>`, unique across the whole collaboration. */
  taskId: string;
}

/** Serializable form of a whole collaboration. */
export interface CollaborationState {
  version: number;
  definitionsId: string;
  pools: { processId: string; state: EngineState }[];
  /** How many times each message flow already fired. */
  delivered: { flowId: string; count: number }[];
  messages: DeliveredMessage[];
  inflight: InflightMessage[];
}

export interface CollaborationOptions extends EngineOptions {
  /**
   * Data a message flow carries into the receiving pool. BPMN models the
   * message separately from the data mapping, so nothing crosses by default:
   * a host that wants a payload says what it is.
   */
  messagePayload?: (context: {
    flow: MessageFlow;
    /** Process the message is leaving. */
    from: string;
    /** Variables of the sending pool. */
    variables: Record<string, unknown>;
  }) => Record<string, unknown> | undefined;
}

/**
 * Runs a whole BPMN collaboration: one {@link WorkflowEngine} per executable
 * participant, with `messageFlow` routed point to point from its source node to
 * its target node — instead of the broadcast by name a plain `signal()` is.
 *
 * A single-process file works too: it is a collaboration of one pool.
 *
 * Black-box participants (`isExecutable="false"`) are not started, and a
 * message flow that begins or ends on one is not routed: there is nothing on
 * that side to run. A message whose receiver has not subscribed yet is held in
 * flight and delivered as soon as it does, the way a message broker would.
 */
export class CollaborationEngine {
  readonly participants: CollaborationParticipant[];
  private readonly emitter = new Emitter<EngineEvents & { message: DeliveredMessage }>();
  private readonly engines = new Map<string, WorkflowEngine>();
  private readonly processById = new Map<string, ProcessModel>();
  /** Which pool owns each node id, so a message flow knows where it lands. */
  private readonly poolOfNode = new Map<string, string>();
  private readonly messageFlows: MessageFlow[];
  private readonly delivered = new Map<string, number>();
  private readonly messages: DeliveredMessage[] = [];
  private inflight: InflightMessage[] = [];
  private started = false;

  constructor(
    private readonly model: BpmnModel,
    private readonly options: CollaborationOptions = {},
  ) {
    const runnable = model.processes.filter((process) => process.isExecutable);
    if (runnable.length === 0) {
      const pools = model.processes.map((process) => process.name ?? process.id).join(', ');
      throw new BpmnValidationError(
        pools
          ? `No executable process in the collaboration; every pool is a black box (${pools}).`
          : 'No process found in the collaboration.',
      );
    }

    this.messageFlows = model.messageFlows;
    this.participants = runnable.map((process) => {
      const participant = model.participants.find((p) => p.processRef === process.id);
      return {
        processId: process.id,
        ...(participant?.id ? { participantId: participant.id } : {}),
        ...((participant?.name ?? process.name) ? { name: participant?.name ?? process.name } : {}),
      };
    });

    for (const process of runnable) {
      this.processById.set(process.id, process);
      for (const node of flattenNodeIds(process)) this.poolOfNode.set(node, process.id);
    }
  }

  /** Listens on every pool at once; `processId` says which one spoke. */
  on<K extends keyof (EngineEvents & { message: DeliveredMessage })>(
    event: K,
    listener: (payload: (EngineEvents & { message: DeliveredMessage })[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /** Registers a handler on every pool, by node id, element kind or `*`. */
  registerHandler(
    selector: string,
    handler: Parameters<WorkflowEngine['registerHandler']>[1],
  ): this {
    for (const engine of this.engines.values()) engine.registerHandler(selector, handler);
    this.pendingHandlers.push([selector, handler]);
    return this;
  }

  private readonly pendingHandlers: [string, Parameters<WorkflowEngine['registerHandler']>[1]][] =
    [];

  /** The engine running one pool, for anything this façade does not cover. */
  engineFor(processId: string): WorkflowEngine | undefined {
    return this.engines.get(processId);
  }

  /** Starts every executable pool, then settles the messages they exchanged. */
  async start(): Promise<CollaborationSnapshot> {
    if (this.started) throw new BpmnExecutionError('Collaboration has already been started.');
    this.started = true;
    for (const participant of this.participants) {
      const engine = this.buildEngine(this.processById.get(participant.processId)!);
      this.engines.set(participant.processId, engine);
    }
    for (const engine of this.engines.values()) await engine.start();
    await this.settle();
    return this.snapshot();
  }

  /** Completes a task in whichever pool holds it. */
  async completeTask(
    taskId: string,
    output?: Record<string, unknown>,
  ): Promise<CollaborationSnapshot> {
    const { engine, tokenId } = this.resolve(taskId, (candidate, token) =>
      candidate.tasks().some((task) => task.tokenId === token),
    );
    await engine.completeTask(tokenId, output);
    await this.settle();
    return this.snapshot();
  }

  /** Activities whose handler failed, across every pool. */
  incidents(): (IncidentState & { processId: string; taskId: string })[] {
    const incidents: (IncidentState & { processId: string; taskId: string })[] = [];
    for (const [processId, engine] of this.engines) {
      for (const incident of engine.incidentList()) {
        incidents.push({ ...incident, processId, taskId: `${processId}:${incident.tokenId}` });
      }
    }
    return incidents;
  }

  /** Runs a failed activity again. */
  async retryTask(taskId: string): Promise<CollaborationSnapshot> {
    const { engine, tokenId } = this.resolve(taskId, holdsIncident);
    await engine.retryTask(tokenId);
    await this.settle();
    return this.snapshot();
  }

  /** Gives up on a failed activity and moves that pool on. */
  async resolveIncident(
    taskId: string,
    output?: Record<string, unknown>,
  ): Promise<CollaborationSnapshot> {
    const { engine, tokenId } = this.resolve(taskId, holdsIncident);
    await engine.resolveIncident(tokenId, output);
    await this.settle();
    return this.snapshot();
  }

  /** Broadcasts a signal to every pool, as the specification defines it. */
  async signal(name: string, output?: Record<string, unknown>): Promise<CollaborationSnapshot> {
    let delivered = false;
    for (const engine of this.engines.values()) {
      if (!engine.subscribedTo(name)) continue;
      await engine.signal(name, output);
      delivered = true;
    }
    if (!delivered) throw new BpmnExecutionError(`No catchable event for signal: ${name}`);
    await this.settle();
    return this.snapshot();
  }

  /** Routes a message to the pools whose correlation key matches. */
  async correlate(
    name: string,
    correlationKey: unknown,
    output?: Record<string, unknown>,
  ): Promise<CollaborationSnapshot> {
    for (const engine of this.engines.values()) {
      if (!engine.subscribedTo(name, correlationKey)) continue;
      await engine.correlate(name, correlationKey, output);
    }
    await this.settle();
    return this.snapshot();
  }

  /** Fires the timers of every pool that are due at `now`. */
  async tick(now?: number): Promise<CollaborationSnapshot> {
    for (const engine of this.engines.values()) await engine.tick(now);
    await this.settle();
    return this.snapshot();
  }

  /** Epoch milliseconds of the next thing that fires on its own, across pools. */
  nextTimerAt(): number | undefined {
    const due = [...this.engines.values()]
      .map((engine) => engine.nextTimerAt())
      .filter((at): at is number => at !== undefined);
    return due.length > 0 ? Math.min(...due) : undefined;
  }

  /** Work waiting on a person across every pool. */
  tasks(filter?: TaskFilter): CollaborationTask[] {
    const tasks: CollaborationTask[] = [];
    for (const [processId, engine] of this.engines) {
      for (const task of engine.tasks(filter)) {
        tasks.push({ processId, taskId: `${processId}:${task.tokenId}`, ...task });
      }
    }
    return tasks;
  }

  snapshot(): CollaborationSnapshot {
    const pools: CollaborationPoolSnapshot[] = this.participants
      .filter((participant) => this.engines.has(participant.processId))
      .map((participant) => ({
        ...participant,
        snapshot: this.engines.get(participant.processId)!.snapshot(),
      }));
    return {
      status: aggregate(pools.map((pool) => pool.snapshot.status)),
      pools,
      messages: this.messages.map((message) => ({ ...message })),
      inflight: this.inflight.map((message) => ({ ...message })),
    };
  }

  getState(): CollaborationState {
    return {
      version: ENGINE_STATE_VERSION,
      definitionsId: this.model.id,
      pools: [...this.engines].map(([processId, engine]) => ({
        processId,
        state: engine.getState(),
      })),
      delivered: [...this.delivered].map(([flowId, count]) => ({ flowId, count })),
      messages: this.messages.map((message) => ({ ...message })),
      inflight: this.inflight.map((message) => ({ ...message })),
    };
  }

  /**
   * Rebuilds a collaboration from stored state. The model must be the one the
   * state came from; re-register handlers and listeners afterwards.
   */
  static restore(
    model: BpmnModel,
    state: CollaborationState,
    options: CollaborationOptions = {},
  ): CollaborationEngine {
    if (state.version !== ENGINE_STATE_VERSION) {
      throw new BpmnValidationError(
        `Unsupported engine state version ${state.version}; expected ${ENGINE_STATE_VERSION}.`,
      );
    }
    const engine = new CollaborationEngine(model, options);
    engine.started = true;
    for (const pool of state.pools) {
      const process = engine.processById.get(pool.processId);
      if (!process) {
        throw new BpmnValidationError(
          `State names a pool the model does not have: ${pool.processId}.`,
        );
      }
      engine.engines.set(
        pool.processId,
        engine.wire(
          WorkflowEngine.restore(process, pool.state, {
            processes: model.processes,
            ...(options.mode ? { mode: options.mode } : {}),
            ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
            ...(options.now ? { now: options.now } : {}),
            ...(options.expressions ? { expressions: options.expressions } : {}),
          }),
          pool.processId,
        ),
      );
    }
    for (const entry of state.delivered) engine.delivered.set(entry.flowId, entry.count);
    engine.messages.push(...state.messages.map((message) => ({ ...message })));
    engine.inflight = state.inflight.map((message) => ({ ...message }));
    return engine;
  }

  /** Continues every pool, then settles the messages in flight. */
  async resume(): Promise<CollaborationSnapshot> {
    for (const engine of this.engines.values()) await engine.resume();
    await this.settle();
    return this.snapshot();
  }

  private buildEngine(process: ProcessModel): WorkflowEngine {
    const { messagePayload: _payload, ...engineOptions } = this.options;
    return this.wire(
      new WorkflowEngine(process, { ...engineOptions, processes: this.model.processes }),
      process.id,
    );
  }

  /** Forwards a pool's events onto the shared stream and applies handlers. */
  private wire(engine: WorkflowEngine, processId: string): WorkflowEngine {
    for (const [selector, handler] of this.pendingHandlers) {
      engine.registerHandler(selector, handler);
    }
    for (const event of EVENT_NAMES) {
      engine.on(event, (payload) => {
        this.emitter.emit(event, { processId, ...payload });
      });
    }
    return engine;
  }

  /**
   * Finds the pool a task id belongs to. A `<processId>:<tokenId>` from
   * {@link tasks} says it outright; a bare token id is still accepted, and
   * refused when two pools happen to have numbered a token the same.
   */
  private resolve(
    taskId: string,
    holds: (engine: WorkflowEngine, tokenId: string) => boolean,
  ): { engine: WorkflowEngine; tokenId: string } {
    const separator = taskId.indexOf(':');
    if (separator > 0) {
      const engine = this.engines.get(taskId.slice(0, separator));
      if (engine) return { engine, tokenId: taskId.slice(separator + 1) };
    }
    const holders = [...this.engines].filter(([, engine]) => holds(engine, taskId));
    if (holders.length === 0) throw new BpmnExecutionError(`No waiting task token: ${taskId}`);
    if (holders.length > 1) {
      const pools = holders.map(([processId]) => processId).join(', ');
      throw new BpmnExecutionError(
        `Token ${taskId} exists in more than one pool (${pools}); use the taskId from tasks().`,
      );
    }
    return { engine: holders[0]![1], tokenId: taskId };
  }

  /**
   * Routes every message flow whose source has completed since the last pass,
   * and retries the ones still in flight. Repeats until nothing moves: a
   * message can trigger the reply that triggers the next one.
   */
  private async settle(): Promise<void> {
    for (let pass = 0; pass < MAX_SETTLE_PASSES; pass += 1) {
      const queued = this.collect();
      this.inflight = [...this.inflight, ...queued];
      if (this.inflight.length === 0) return;

      const held: InflightMessage[] = [];
      let moved = false;
      for (const message of this.inflight) {
        const engine = this.engines.get(message.targetProcessId);
        if (!engine?.subscribedTo(message.targetNodeId)) {
          held.push(message);
          continue;
        }
        const flow = this.messageFlows.find((candidate) => candidate.id === message.flowId);
        await engine.signal(message.targetNodeId, message.payload);
        this.messages.push({
          flowId: message.flowId,
          ...(flow?.name ? { name: flow.name } : {}),
          from: this.poolOfNode.get(flow?.sourceRef ?? '') ?? '',
          to: message.targetProcessId,
          nodeId: message.targetNodeId,
        });
        this.emitter.emit('message', this.messages[this.messages.length - 1]!);
        moved = true;
      }
      this.inflight = held;
      if (!moved && queued.length === 0) return;
    }
    throw new BpmnExecutionError(
      `Message routing did not settle after ${MAX_SETTLE_PASSES} passes; the collaboration may be sending messages in a loop.`,
    );
  }

  /** Message flows whose source completed more times than they were routed. */
  private collect(): InflightMessage[] {
    const queued: InflightMessage[] = [];
    for (const flow of this.messageFlows) {
      const sourcePool = flow.sourceRef ? this.poolOfNode.get(flow.sourceRef) : undefined;
      const targetPool = flow.targetRef ? this.poolOfNode.get(flow.targetRef) : undefined;
      // One end outside the executable pools: a black box, nothing to route.
      if (!sourcePool || !targetPool || !flow.sourceRef || !flow.targetRef) continue;

      const engine = this.engines.get(sourcePool);
      if (!engine) continue;
      const completions = engine
        .snapshot()
        .history.filter(
          (entry) => entry.nodeId === flow.sourceRef && entry.event === 'complete',
        ).length;
      const already = this.delivered.get(flow.id) ?? 0;
      if (completions <= already) continue;

      this.delivered.set(flow.id, completions);
      const payload = this.options.messagePayload?.({
        flow,
        from: sourcePool,
        variables: engine.snapshot().variables,
      });
      for (let i = already; i < completions; i += 1) {
        queued.push({
          flowId: flow.id,
          targetProcessId: targetPool,
          targetNodeId: flow.targetRef,
          ...(payload ? { payload } : {}),
        });
      }
    }
    return queued;
  }
}

const holdsIncident = (engine: WorkflowEngine, tokenId: string): boolean =>
  engine.incidentList().some((incident) => incident.tokenId === tokenId);

/** Guards against two pools answering each other forever. */
const MAX_SETTLE_PASSES = 1_000;

const EVENT_NAMES = [
  'process.start',
  'process.end',
  'node.enter',
  'node.leave',
  'activity.start',
  'activity.end',
  'flow.take',
  'wait',
  'error',
] as const satisfies readonly (keyof EngineEvents)[];

/** Every node id of a process, nested scopes included. */
function flattenNodeIds(process: ProcessModel): string[] {
  const ids: string[] = [];
  for (const node of process.flowNodes) {
    ids.push(node.id);
    if (node.process) ids.push(...flattenNodeIds(node.process));
  }
  return ids;
}

/**
 * The collaboration's status: a failure anywhere fails it, and it is only
 * finished once no pool is still running or waiting.
 */
function aggregate(statuses: ExecutionStatus[]): ExecutionStatus {
  if (statuses.length === 0) return 'idle';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('waiting')) return 'waiting';
  if (statuses.includes('idle')) return 'idle';
  return statuses.includes('completed') ? 'completed' : 'terminated';
}
