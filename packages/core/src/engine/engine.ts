import { BpmnExecutionError, BpmnValidationError } from '../errors.js';
import { ProcessGraph } from '../model/graph.js';
import { isActivityKind } from '../model/kinds.js';
import type {
  EventDetail,
  FlowNode,
  LoopCharacteristics,
  ProcessModel,
  SequenceFlow,
} from '../model/types.js';
import type { EventDefinitionKind } from '../model/kinds.js';
import { Emitter } from './emitter.js';
import { evaluateCondition, evaluateExpression, type ExpressionMode } from './expression.js';
import { BpmnError, HandlerRegistry, type TaskHandler } from './handlers.js';
import {
  ENGINE_STATE_VERSION,
  type EngineState,
  type MultiTriggerState,
  type IncidentState,
  type ScopeState,
  type TokenState,
  type TimerState,
} from './state.js';
import { parseTimerCycle, resolveTimerDueAt } from './timers.js';
import type {
  ActivityMetrics,
  EngineEvents,
  EngineOptions,
  ExecutionSnapshot,
  ExecutionStatus,
  HistoryEntry,
  PendingTask,
  TaskFilter,
  TokenSnapshot,
  WaitReason,
} from './types.js';

interface Scope {
  id: string;
  graph: ProcessGraph;
  /** Parent activity token suspended while this (sub)scope runs. */
  parentToken?: RuntimeToken;
  /** Scope that hosts this one; absent on the root scope. */
  parentScopeId?: string;
  /** Live reference to the hosting scope, used to resolve variables. */
  parentScope?: Scope;
  hostNodeId?: string;
  /** Data local to this scope; reads fall through to the parent chain. */
  variables: Record<string, unknown>;
  /** Set on scopes created for one instance of a loop/multi-instance activity. */
  loopId?: string;
  /** Position of this instance in the loop, `0`-based. Set with `loopId`. */
  loopIndex?: number;
  /** Data-mapped scopes do not read the caller's variables. */
  isolated?: boolean;
  /** Ad-hoc subprocess: activities not started yet. */
  adHocPending?: string[];
  /** Ad-hoc subprocess: expression that ends it early. */
  completionCondition?: string;
  tokens: Set<RuntimeToken>;
}

interface RuntimeToken {
  id: string;
  nodeId: string;
  scope: Scope;
  viaFlowId?: string;
  waiting?: WaitReason;
  /** Set on the token running one instance of a loop activity. */
  loopInstanceOf?: string;
}

/** Bookkeeping for an activity being repeated (multi-instance or loop). */
interface LoopRun {
  id: string;
  nodeId: string;
  /** Scope the repeated activity belongs to. */
  scope: Scope;
  /** Token suspended until every instance finishes. */
  parentToken: RuntimeToken;
  loop: LoopCharacteristics;
  items?: unknown[];
  total: number;
  started: number;
  completed: number;
  /**
   * Output of each finished instance, tagged with the instance it came from.
   * Instances of a parallel run finish in any order, so the index is what keeps
   * the aggregated collection aligned with the input collection.
   */
  results: { index: number; value: unknown }[];
  instanceScopes: Set<Scope>;
}

/** A message delivery narrowed to the instance the key identifies. */
interface Correlation {
  key: unknown;
}

interface EventChoice {
  token: RuntimeToken;
  alternatives: { eventNodeId: string; flowId: string }[];
}

const DEFAULT_MAX_STEPS = 100_000;
/** Standard loops without `loopMaximum` still need a ceiling. */
const DEFAULT_LOOP_MAXIMUM = 1_000;

/**
 * Token-based BPMN execution engine.
 *
 * Drives control tokens through a process graph honoring BPMN 2.0 semantics for
 * events, all task types (via pluggable handlers), exclusive/parallel/inclusive/
 * event-based gateways, embedded subprocesses and boundary events. Execution is
 * asynchronous (handlers may be async) and deterministic (tokens are processed
 * one at a time). Progress and state changes are observable through events.
 */
export class WorkflowEngine {
  private readonly emitter = new Emitter<EngineEvents>();
  private readonly registry = new HandlerRegistry();
  private readonly rootGraph: ProcessGraph;

  private readonly scopes: Scope[] = [];
  private readonly ready: RuntimeToken[] = [];
  private readonly waiting = new Map<string, RuntimeToken>();
  private readonly parallelBuffers = new Map<string, Map<string, number>>();
  private readonly inclusiveBuffers = new Map<string, RuntimeToken[]>();
  private readonly eventChoices = new Map<string, EventChoice>();
  private readonly loops = new Map<string, LoopRun>();
  /** Completed activities that carry a compensation handler, in order. */
  private readonly compensations: { activityId: string; scopeId: string }[] = [];
  /** Activities whose handler failed, keyed by token id. */
  private readonly incidents = new Map<string, IncidentState>();
  /** `boundaryId:hostTokenId` of conditional boundaries already fired. */
  private readonly firedConditionals = new Set<string>();
  /** Triggers collected so far by each waiting `parallelMultiple` event. */
  private readonly multiTriggers = new Map<string, Set<string>>();
  /** Pending timers keyed by `tokenId:nodeId`. */
  private readonly timers = new Map<string, TimerState>();
  private readonly armedEvents = new Map<string, string>();
  private readonly completedNodes = new Set<string>();
  private readonly history: HistoryEntry[] = [];

  private readonly initialVariables: Record<string, unknown>;
  /** Other processes of the same definitions, so a call activity can run. */
  private readonly definitions = new Map<string, ProcessModel>();
  private status: ExecutionStatus = 'idle';
  private tokenSeq = 0;
  private scopeSeq = 0;
  private loopSeq = 0;
  private readonly now: () => number;
  private readonly maxSteps: number;
  private readonly mode: 'automation' | 'auto';
  /** How the diagram's expressions are evaluated; safe unless the host says so. */
  private readonly expressions: ExpressionMode;
  private steps = 0;

  constructor(
    process: ProcessModel,
    private readonly options: EngineOptions = {},
  ) {
    if (!process.isExecutable) {
      throw new BpmnValidationError(`Process is not executable: ${process.id}`);
    }
    this.rootGraph = new ProcessGraph(process);
    this.initialVariables = { ...(options.variables ?? {}) };
    for (const callable of options.processes ?? []) {
      this.definitions.set(callable.id, callable);
    }
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.mode = options.mode ?? 'automation';
    this.expressions = options.expressions ?? 'safe';
    this.now = options.now ?? (() => Date.now());
  }

  /** Evaluates one of the diagram's expressions under the engine's mode. */
  private evaluate(expression: string, variables: Record<string, unknown>): unknown {
    return evaluateExpression(expression, variables, this.expressions);
  }

  /** Evaluates one of the diagram's expressions as a guard. */
  private condition(expression: string, variables: Record<string, unknown>): boolean {
    return evaluateCondition(expression, variables, this.expressions);
  }

  // --- Public API --------------------------------------------------------

  on = this.emitter.on.bind(this.emitter);

  /** Registers a handler by node id, element kind, or `*` wildcard. */
  registerHandler(selector: string, handler: TaskHandler): this {
    this.registry.register(selector, handler);
    return this;
  }

  get currentStatus(): ExecutionStatus {
    return this.status;
  }

  /** Starts the process and runs until it completes or blocks on waits. */
  async start(): Promise<ExecutionSnapshot> {
    if (this.status !== 'idle') {
      throw new BpmnExecutionError('Engine has already been started.');
    }
    const scope = this.createScope(this.rootGraph);
    Object.assign(scope.variables, this.initialVariables);
    const starts = this.rootGraph.startNodes();
    if (starts.length === 0) {
      throw new BpmnValidationError('Process has no start event.');
    }
    this.status = 'running';
    this.emitter.emit('process.start', { processId: this.rootGraph.process.id });
    for (const start of starts) this.spawn(scope, start.id);
    await this.drain();
    return this.snapshot();
  }

  /** Completes a parked user/receive task, then continues execution. */
  async completeTask(
    tokenId: string,
    output?: Record<string, unknown>,
  ): Promise<ExecutionSnapshot> {
    const token = this.waiting.get(tokenId);
    if (!token) throw new BpmnExecutionError(`No waiting task token: ${tokenId}`);
    if (output) this.assignVariables(token.scope, output);
    this.waiting.delete(tokenId);
    token.waiting = undefined;
    this.completeNode(token);
    this.leaveViaOutgoing(token);
    await this.drain();
    return this.snapshot();
  }

  /**
   * Delivers a trigger by node id or event reference name. Resolves a waiting
   * catch event, an event-based gateway alternative, or an attached boundary
   * event — whichever matches first — then continues execution.
   */
  async signal(nameOrId: string, output?: Record<string, unknown>): Promise<ExecutionSnapshot> {
    if (output) this.assignVariables(this.scopes[0], output);
    if (!this.deliverSignal(nameOrId)) {
      throw new BpmnExecutionError(`No catchable event for signal: ${nameOrId}`);
    }
    await this.drain();
    return this.snapshot();
  }

  /**
   * Delivers a *message*, which unlike a signal is point to point: it only
   * reaches the subscribers whose correlation key resolves to
   * `correlationKey`. A subscriber that declares no key has nothing to
   * discriminate on and accepts the message by name, as before.
   *
   * Nothing matching is a normal outcome — a message nobody is waiting for is
   * simply dropped — so this does not throw. Ask {@link subscribedTo} first
   * when the caller needs to know.
   */
  async correlate(
    name: string,
    correlationKey: unknown,
    output?: Record<string, unknown>,
  ): Promise<ExecutionSnapshot> {
    if (output) this.assignVariables(this.scopes[0], output);
    this.deliverSignal(name, { key: correlationKey });
    await this.drain();
    return this.snapshot();
  }

  /**
   * Whether this execution has a subscription that would accept the message —
   * the right name, and a correlation key that resolves to `correlationKey`.
   * Lets a router pick the instance a message belongs to without mutating any
   * of the others. Omitting the key asks by name alone.
   */
  subscribedTo(name: string, correlationKey?: unknown): boolean {
    const correlation = correlationKey === undefined ? undefined : { key: correlationKey };
    for (const token of this.waiting.values()) {
      if (token.waiting !== 'catchEvent' && token.waiting !== 'receiveTask') continue;
      const node = token.scope.graph.node(token.nodeId);
      if (node && matchesTrigger(node, name) && this.correlates(node, token.scope, correlation)) {
        return true;
      }
    }
    for (const scope of this.scopes) {
      for (const node of scope.graph.allNodes()) {
        const subscribes =
          (node.kind === 'boundaryEvent' && node.attachedToRef !== undefined) ||
          (node.kind === 'startEvent' && this.isEventSubProcessStart(scope, node));
        if (!subscribes || !matchesTrigger(node, name)) continue;
        if (this.correlates(node, scope, correlation)) return true;
      }
    }
    return false;
  }

  /** Whether this start event belongs to an event subprocess of the scope. */
  private isEventSubProcessStart(scope: Scope, node: FlowNode): boolean {
    return scope.graph
      .allNodes()
      .some(
        (host) =>
          host.triggeredByEvent === true &&
          host.process?.flowNodes.some((inner) => inner.id === node.id) === true,
      );
  }

  /**
   * Work currently waiting on a person or an external trigger: user tasks,
   * receive tasks and catch events, with the lane and the roles that may act on
   * them. This is the task list a UI renders as an inbox.
   */
  tasks(filter: TaskFilter = {}): PendingTask[] {
    const tasks: PendingTask[] = [];
    for (const token of this.waiting.values()) {
      const node = token.scope.graph.node(token.nodeId);
      if (!node || !token.waiting) continue;
      const candidates = node.candidates ?? [];
      const task: PendingTask = {
        tokenId: token.id,
        nodeId: node.id,
        nodeKind: node.kind,
        reason: token.waiting,
        scopeId: token.scope.id,
        candidates,
        variables: this.mergedVariables(token.scope),
        ...(node.name ? { name: node.name } : {}),
        ...(node.lane ? { lane: node.lane } : {}),
      };
      if (!matchesFilter(task, filter)) continue;
      tasks.push(task);
    }
    return tasks;
  }

  /**
   * Where the time went: one entry per activity, ordered by total time spent.
   * Durations pair each `enter` with the next `complete` of the same node, so a
   * multi-instance activity reports the sum across its instances.
   */
  metrics(): ActivityMetrics[] {
    const pending = new Map<string, number[]>();
    const stats = new Map<string, ActivityMetrics>();

    for (const entry of [...this.history].sort((a, b) => a.seq - b.seq)) {
      const current = stats.get(entry.nodeId) ?? {
        nodeId: entry.nodeId,
        nodeKind: entry.nodeKind,
        started: 0,
        completed: 0,
        totalMs: 0,
        averageMs: 0,
        maxMs: 0,
        ...(this.nodeName(entry.nodeId) ? { name: this.nodeName(entry.nodeId) } : {}),
      };
      if (entry.event === 'enter') {
        current.started += 1;
        const queue = pending.get(entry.nodeId) ?? [];
        queue.push(entry.at);
        pending.set(entry.nodeId, queue);
      } else {
        current.completed += 1;
        const startedAt = pending.get(entry.nodeId)?.shift();
        if (startedAt !== undefined) {
          const duration = Math.max(0, entry.at - startedAt);
          current.totalMs += duration;
          current.maxMs = Math.max(current.maxMs, duration);
        }
      }
      stats.set(entry.nodeId, current);
    }

    for (const entry of stats.values()) {
      entry.averageMs = entry.completed > 0 ? entry.totalMs / entry.completed : 0;
    }
    return [...stats.values()].sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Name of a node, looked up across every live scope. */
  private nodeName(nodeId: string): string | undefined {
    for (const scope of this.scopes) {
      const node = scope.graph.node(nodeId);
      if (node?.name) return node.name;
    }
    return undefined;
  }

  /** Activities whose handler failed and are holding, newest failure first. */
  incidentList(): IncidentState[] {
    return [...this.incidents.values()].filter((incident) => this.waiting.has(incident.tokenId));
  }

  /** Runs a failed activity again, from the incident it left behind. */
  async retryTask(tokenId: string): Promise<ExecutionSnapshot> {
    const token = this.waiting.get(tokenId);
    if (!token || token.waiting !== 'incident') {
      throw new BpmnExecutionError(`No incident for token: ${tokenId}`);
    }
    this.waiting.delete(tokenId);
    token.waiting = undefined;
    this.clearTimersFor(tokenId);
    this.ready.push(token);
    await this.drain();
    return this.snapshot();
  }

  /**
   * Gives up on the failing activity and moves on as if it had succeeded,
   * optionally writing the output a human decided on.
   */
  async resolveIncident(
    tokenId: string,
    output?: Record<string, unknown>,
  ): Promise<ExecutionSnapshot> {
    const token = this.waiting.get(tokenId);
    if (!token || token.waiting !== 'incident') {
      throw new BpmnExecutionError(`No incident for token: ${tokenId}`);
    }
    if (output) this.assignVariables(token.scope, output);
    this.waiting.delete(tokenId);
    token.waiting = undefined;
    this.incidents.delete(tokenId);
    this.completeNode(token);
    this.leaveViaOutgoing(token);
    await this.drain();
    return this.snapshot();
  }

  /**
   * Timers waiting to fire, earliest first. A host can use the first due date
   * to decide when to call {@link tick} again.
   */
  dueTimers(): TimerState[] {
    return [...this.timers.values()].sort((a, b) => a.dueAt - b.dueAt);
  }

  /**
   * Epoch milliseconds of the next thing that fires on its own — a timer or a
   * scheduled retry — or `undefined` when nothing is pending.
   */
  nextTimerAt(): number | undefined {
    const retries = this.incidentList()
      .map((incident) => incident.retryAt)
      .filter((at): at is number => at !== undefined);
    const due = [...this.dueTimers().map((timer) => timer.dueAt), ...retries];
    return due.length > 0 ? Math.min(...due) : undefined;
  }

  /**
   * Fires every timer due at `now` (defaults to the engine clock) and continues
   * the execution. Nothing due means nothing changes.
   */
  async tick(now: number = this.now()): Promise<ExecutionSnapshot> {
    let fired = false;
    for (const entry of this.dueTimers()) {
      if (entry.dueAt > now) break;
      if (!this.timers.has(timerKey(entry.tokenId, entry.nodeId))) continue;
      if (this.fireTimer(entry)) fired = true;
    }
    // Scheduled retries are due dates too.
    for (const incident of [...this.incidents.values()]) {
      if (incident.retryAt === undefined || incident.retryAt > now) continue;
      const token = this.waiting.get(incident.tokenId);
      if (!token || token.waiting !== 'incident') continue;
      this.waiting.delete(token.id);
      token.waiting = undefined;
      const { retryAt: _scheduled, ...pending } = incident;
      this.incidents.set(incident.tokenId, pending);
      this.ready.push(token);
      fired = true;
    }
    if (fired) await this.drain();
    return this.snapshot();
  }

  snapshot(): ExecutionSnapshot {
    const tokens: TokenSnapshot[] = [];
    for (const scope of this.scopes) {
      for (const token of scope.tokens) {
        const node = scope.graph.node(token.nodeId);
        if (!node) continue;
        tokens.push({
          id: token.id,
          nodeId: token.nodeId,
          nodeKind: node.kind,
          scopeId: scope.id,
          waiting: token.waiting !== undefined,
          ...(token.waiting ? { waitReason: token.waiting } : {}),
        });
      }
    }
    return {
      status: this.status,
      variables: this.rootVariables(),
      tokens,
      completedNodes: [...this.completedNodes],
      history: [...this.history],
    };
  }

  /**
   * Serializes everything needed to continue this execution later: scope tree,
   * every token (including suspended parents and tokens buffered at inclusive
   * joins), gateway buffers, armed events and id sequences.
   *
   * Handlers and listeners are not serializable; register them again on the
   * restored engine.
   */
  getState(): EngineState {
    const tokens = new Map<string, TokenState>();
    const record = (token: RuntimeToken, placement: TokenState['placement']): void => {
      tokens.set(token.id, {
        id: token.id,
        nodeId: token.nodeId,
        scopeId: token.scope.id,
        ...(token.viaFlowId ? { viaFlowId: token.viaFlowId } : {}),
        ...(token.waiting ? { waiting: token.waiting } : {}),
        ...(placement && placement !== 'active' ? { placement } : {}),
        ...(token.loopInstanceOf ? { loopInstanceOf: token.loopInstanceOf } : {}),
      });
    };

    for (const scope of this.scopes) {
      for (const token of scope.tokens) record(token, 'active');
      // Suspended parents live outside their scope's token set.
      if (scope.parentToken) record(scope.parentToken, 'suspended');
    }
    for (const buffer of this.inclusiveBuffers.values()) {
      for (const token of buffer) record(token, 'inclusiveJoin');
    }
    // A token repeating an activity is suspended outside every scope too.
    for (const run of this.loops.values()) record(run.parentToken, 'suspended');

    return {
      version: ENGINE_STATE_VERSION,
      processId: this.rootGraph.process.id,
      status: this.status,
      mode: this.mode,
      maxSteps: this.maxSteps,
      steps: this.steps,
      variables: this.rootVariables(),
      tokenSeq: this.tokenSeq,
      scopeSeq: this.scopeSeq,
      loopSeq: this.loopSeq,
      scopes: this.scopes.map((scope) => ({
        id: scope.id,
        ...(scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {}),
        ...(scope.hostNodeId ? { hostNodeId: scope.hostNodeId } : {}),
        ...(scope.parentToken ? { parentTokenId: scope.parentToken.id } : {}),
        ...(scope.loopId ? { loopId: scope.loopId } : {}),
        ...(scope.loopIndex !== undefined ? { loopIndex: scope.loopIndex } : {}),
        ...(scope.isolated ? { isolated: true } : {}),
        ...(scope.adHocPending ? { adHocPending: [...scope.adHocPending] } : {}),
        variables: { ...scope.variables },
      })),
      tokens: [...tokens.values()],
      ready: this.ready.map((token) => token.id),
      completedNodes: [...this.completedNodes],
      history: [...this.history],
      parallelBuffers: [...this.parallelBuffers].map(([key, counts]) => ({
        key,
        counts: [...counts],
      })),
      inclusiveBuffers: [...this.inclusiveBuffers].map(([key, buffer]) => ({
        key,
        tokenIds: buffer.map((token) => token.id),
      })),
      eventChoices: [...this.eventChoices].map(([tokenId, choice]) => ({
        tokenId,
        alternatives: choice.alternatives.map((alt) => ({ ...alt })),
      })),
      armedEvents: [...this.armedEvents],
      firedConditionals: [...this.firedConditionals],
      multiTriggers: [...this.multiTriggers].map(([key, received]): MultiTriggerState => ({
        key,
        received: [...received],
      })),
      timers: [...this.timers.values()].map((timer) => ({ ...timer })),
      compensations: this.compensations.map((entry) => ({ ...entry })),
      incidents: this.incidentList().map((incident) => ({ ...incident })),
      loops: [...this.loops.values()].map((run) => ({
        id: run.id,
        nodeId: run.nodeId,
        scopeId: run.scope.id,
        parentTokenId: run.parentToken.id,
        ...(run.items ? { items: run.items } : {}),
        total: run.total,
        started: run.started,
        completed: run.completed,
        results: run.results.map((result) => ({ ...result })),
        instanceScopeIds: [...run.instanceScopes].map((scope) => scope.id),
      })),
    };
  }

  /**
   * Rebuilds an engine from a previously stored {@link EngineState}, so an
   * execution can survive a restart or move between processes.
   *
   * The process model must be the same one the state was produced from.
   * Re-register handlers and listeners before resuming.
   */
  static restore(
    process: ProcessModel,
    state: EngineState,
    options: Pick<EngineOptions, 'mode' | 'maxSteps' | 'processes' | 'now' | 'expressions'> = {},
  ): WorkflowEngine {
    if (state.version !== ENGINE_STATE_VERSION) {
      throw new BpmnValidationError(
        `Unsupported engine state version ${state.version}; expected ${ENGINE_STATE_VERSION}.`,
      );
    }
    if (state.processId !== process.id) {
      throw new BpmnValidationError(
        `State belongs to process "${state.processId}", not "${process.id}".`,
      );
    }
    const engine = new WorkflowEngine(process, {
      mode: options.mode ?? state.mode,
      maxSteps: options.maxSteps ?? state.maxSteps,
      variables: state.variables,
      ...(options.processes ? { processes: options.processes } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    engine.hydrate(state);
    return engine;
  }

  /**
   * Continues a restored (or otherwise paused) execution until it completes or
   * blocks again. Returns immediately when the process already ended.
   */
  async resume(): Promise<ExecutionSnapshot> {
    if (this.status === 'idle') {
      throw new BpmnExecutionError('Engine has not been started; call start() first.');
    }
    if (this.status === 'completed' || this.status === 'terminated' || this.status === 'failed') {
      return this.snapshot();
    }
    await this.drain();
    return this.snapshot();
  }

  private hydrate(state: EngineState): void {
    this.status = state.status;
    this.steps = state.steps;
    this.tokenSeq = state.tokenSeq;
    this.scopeSeq = state.scopeSeq;
    this.loopSeq = state.loopSeq;
    for (const nodeId of state.completedNodes) this.completedNodes.add(nodeId);
    this.history.push(...state.history);

    // Scopes come out in creation order, so a parent is always rebuilt first.
    const scopesById = new Map<string, Scope>();
    for (const stored of state.scopes) {
      const parentScope = stored.parentScopeId ? scopesById.get(stored.parentScopeId) : undefined;
      const scope: Scope = {
        id: stored.id,
        graph: this.graphForScope(stored, scopesById),
        tokens: new Set(),
        variables: { ...stored.variables },
        ...(stored.parentScopeId ? { parentScopeId: stored.parentScopeId } : {}),
        // An isolated scope keeps its own data: no variable chain to the caller.
        ...(parentScope && !stored.isolated ? { parentScope } : {}),
        ...(stored.hostNodeId ? { hostNodeId: stored.hostNodeId } : {}),
        ...(stored.loopId ? { loopId: stored.loopId } : {}),
        ...(stored.loopIndex !== undefined ? { loopIndex: stored.loopIndex } : {}),
        ...(stored.isolated ? { isolated: true } : {}),
        ...(stored.adHocPending ? { adHocPending: [...stored.adHocPending] } : {}),
      };
      // The completion condition lives on the host node, so it is re-derived.
      const host =
        parentScope && stored.hostNodeId ? parentScope.graph.node(stored.hostNodeId) : undefined;
      if (host?.completionCondition) scope.completionCondition = host.completionCondition;
      scopesById.set(scope.id, scope);
      this.scopes.push(scope);
    }

    const tokensById = new Map<string, RuntimeToken>();
    for (const stored of state.tokens) {
      const scope = scopesById.get(stored.scopeId);
      if (!scope) {
        throw new BpmnValidationError(
          `Token ${stored.id} references unknown scope ${stored.scopeId}.`,
        );
      }
      const token: RuntimeToken = {
        id: stored.id,
        nodeId: stored.nodeId,
        scope,
        ...(stored.viaFlowId ? { viaFlowId: stored.viaFlowId } : {}),
        ...(stored.waiting ? { waiting: stored.waiting } : {}),
        ...(stored.loopInstanceOf ? { loopInstanceOf: stored.loopInstanceOf } : {}),
      };
      tokensById.set(token.id, token);
      // Suspended parents and tokens buffered at a join sit outside the scope.
      if ((stored.placement ?? 'active') === 'active') scope.tokens.add(token);
      if (token.waiting) this.waiting.set(token.id, token);
    }

    for (const stored of state.scopes) {
      if (!stored.parentTokenId) continue;
      const parent = tokensById.get(stored.parentTokenId);
      const scope = scopesById.get(stored.id);
      if (parent && scope) scope.parentToken = parent;
    }

    for (const tokenId of state.ready) {
      const token = tokensById.get(tokenId);
      if (token) this.ready.push(token);
    }

    for (const buffer of state.parallelBuffers) {
      this.parallelBuffers.set(buffer.key, new Map(buffer.counts));
    }
    for (const buffer of state.inclusiveBuffers) {
      const restored = buffer.tokenIds
        .map((id) => tokensById.get(id))
        .filter((token): token is RuntimeToken => token !== undefined);
      this.inclusiveBuffers.set(buffer.key, restored);
    }
    for (const choice of state.eventChoices) {
      const token = tokensById.get(choice.tokenId);
      if (!token) continue;
      this.eventChoices.set(choice.tokenId, {
        token,
        alternatives: choice.alternatives.map((alt) => ({ ...alt })),
      });
    }
    for (const [eventNodeId, tokenId] of state.armedEvents) {
      this.armedEvents.set(eventNodeId, tokenId);
    }
    for (const key of state.firedConditionals ?? []) this.firedConditionals.add(key);
    for (const entry of state.multiTriggers ?? []) {
      this.multiTriggers.set(entry.key, new Set(entry.received));
    }

    for (const timer of state.timers) {
      this.timers.set(timerKey(timer.tokenId, timer.nodeId), { ...timer });
    }
    for (const entry of state.compensations ?? []) this.compensations.push({ ...entry });
    for (const incident of state.incidents ?? [])
      this.incidents.set(incident.tokenId, { ...incident });

    for (const stored of state.loops) {
      const scope = scopesById.get(stored.scopeId);
      const parentToken = tokensById.get(stored.parentTokenId);
      const loop = scope?.graph.node(stored.nodeId)?.loop;
      if (!scope || !parentToken || !loop) {
        throw new BpmnValidationError(`Cannot restore loop ${stored.id} on node ${stored.nodeId}.`);
      }
      this.loops.set(stored.id, {
        id: stored.id,
        nodeId: stored.nodeId,
        scope,
        parentToken,
        loop,
        ...(stored.items ? { items: stored.items } : {}),
        total: stored.total,
        started: stored.started,
        completed: stored.completed,
        results: (stored.results ?? []).map((result) => ({ ...result })),
        instanceScopes: new Set(
          stored.instanceScopeIds
            .map((id) => scopesById.get(id))
            .filter((s): s is Scope => s !== undefined),
        ),
      });
    }
  }

  /**
   * Root scope uses the root graph, a subprocess scope its host's inner
   * process, and a loop instance scope the same graph as the activity it
   * repeats.
   */
  private graphForScope(stored: ScopeState, scopesById: Map<string, Scope>): ProcessGraph {
    const { parentScopeId, hostNodeId, loopId } = stored;
    if (!parentScopeId) return this.rootGraph;
    const parent = scopesById.get(parentScopeId);
    if (!parent) throw new BpmnValidationError(`Unknown parent scope: ${parentScopeId}.`);
    if (loopId) return parent.graph;
    if (!hostNodeId) throw new BpmnValidationError(`Child scope ${stored.id} has no host node.`);
    const host = parent.graph.requireNode(hostNodeId);
    const called = this.processFor(host);
    if (!called) {
      throw new BpmnValidationError(`Host node ${hostNodeId} no longer defines a subprocess.`);
    }
    return new ProcessGraph(called);
  }

  // --- Scope & token plumbing -------------------------------------------

  private createScope(graph: ProcessGraph, parentToken?: RuntimeToken, hostNodeId?: string): Scope {
    const scope: Scope = {
      id: `scope-${this.scopeSeq++}`,
      graph,
      tokens: new Set(),
      variables: {},
      ...(parentToken
        ? { parentToken, parentScope: parentToken.scope, parentScopeId: parentToken.scope.id }
        : {}),
      ...(hostNodeId ? { hostNodeId } : {}),
    };
    this.scopes.push(scope);
    return scope;
  }

  private spawn(scope: Scope, nodeId: string, viaFlowId?: string): RuntimeToken {
    const token: RuntimeToken = {
      id: `t${this.tokenSeq++}`,
      nodeId,
      scope,
      ...(viaFlowId ? { viaFlowId } : {}),
    };
    scope.tokens.add(token);
    this.ready.push(token);
    return token;
  }

  private discard(token: RuntimeToken): void {
    token.scope.tokens.delete(token);
    this.waiting.delete(token.id);
    this.clearTimersFor(token.id);
    for (const key of [...this.firedConditionals]) {
      if (key.endsWith(`:${token.id}`)) this.firedConditionals.delete(key);
    }
    // A discarded token must never be processed again, even if it was already
    // queued — cancellation (terminate, interrupting boundary) relies on this.
    const queued = this.ready.indexOf(token);
    if (queued >= 0) this.ready.splice(queued, 1);
  }

  /** Moves a token from a link throw event to the matching link catch event. */
  private followLink(token: RuntimeToken, node: FlowNode): boolean {
    const name = node.event?.reference;
    const target = token.scope.graph
      .allNodes()
      .find(
        (candidate) =>
          candidate.kind === 'intermediateCatchEvent' &&
          candidate.event?.kind === 'link' &&
          candidate.event.reference === name,
      );
    if (!target) return false;

    this.completeNode(token);
    this.discard(token);
    // The catch side is satisfied by the jump: continue from its outgoing flow.
    const arrived = this.spawn(token.scope, target.id);
    this.completeNode(arrived);
    this.ready.splice(this.ready.indexOf(arrived), 1);
    this.leaveViaOutgoing(arrived);
    return true;
  }

  // --- Timers ------------------------------------------------------------

  /**
   * Arms the timers a parked token is subject to: the timer catch event it sits
   * on, plus any timer boundary event attached to the activity.
   */
  private armTimers(token: RuntimeToken): void {
    const node = token.scope.graph.node(token.nodeId);
    if (!node) return;
    const timer = detailOfKind(node, 'timer');
    if (timer && node.kind !== 'boundaryEvent') {
      this.armTimer(token, node, 'catch', timer.timer);
    }
    // A boundary event belongs to the activity as a whole, so a multi-instance
    // activity arms it once (in startLoop), not once per instance.
    if (!token.loopInstanceOf) this.armBoundaryTimers(token);
  }

  /** Arms timer boundary events attached to the activity the token sits on. */
  private armBoundaryTimers(token: RuntimeToken): void {
    for (const boundary of token.scope.graph.boundaryEvents(token.nodeId)) {
      const timer = detailOfKind(boundary, 'timer');
      if (!timer) continue;
      this.armTimer(token, boundary, 'boundary', timer.timer);
    }
  }

  private armTimer(
    token: RuntimeToken,
    node: FlowNode,
    kind: TimerState['kind'],
    definition: string | undefined,
  ): void {
    // Without a definition there is nothing to schedule: the event still works
    // through an explicit signal.
    if (!definition) return;
    const dueAt = resolveTimerDueAt(definition, this.now());
    if (dueAt === undefined) return;
    const cycle = parseTimerCycle(definition);
    this.timers.set(timerKey(token.id, node.id), {
      tokenId: token.id,
      nodeId: node.id,
      scopeId: token.scope.id,
      kind,
      dueAt,
      definition,
      // A cycle keeps firing while the activity it guards is still running.
      ...(cycle ? { repetitions: cycle.repetitions } : {}),
    });
  }

  /** Schedules the next firing of a repeating boundary timer, if any is left. */
  private rearmCycle(entry: TimerState, node: FlowNode): void {
    const cycle = parseTimerCycle(entry.definition);
    if (!cycle) return;
    const remaining = entry.repetitions === null ? null : (entry.repetitions ?? 1) - 1;
    if (remaining !== null && remaining <= 0) return;
    const dueAt = resolveTimerDueAt(cycle.interval, this.now());
    if (dueAt === undefined) return;
    this.timers.set(timerKey(entry.tokenId, node.id), {
      ...entry,
      dueAt,
      ...(remaining === null ? { repetitions: null } : { repetitions: remaining }),
    });
  }

  private clearTimersFor(tokenId: string): void {
    for (const [key, entry] of this.timers) {
      if (entry.tokenId === tokenId) this.timers.delete(key);
    }
  }

  /** Resolves one due timer. Returns true when the execution moved. */
  private fireTimer(entry: TimerState): boolean {
    this.timers.delete(timerKey(entry.tokenId, entry.nodeId));

    if (entry.kind === 'boundary') {
      const scope = this.scopes.find((s) => s.id === entry.scopeId);
      const boundary = scope?.graph.node(entry.nodeId);
      if (!scope || !boundary) return false;
      const fired = this.fireBoundary(scope, boundary);
      // A cyclic, non-interrupting boundary rearms for its next firing.
      if (fired && boundary.cancelActivity === false) this.rearmCycle(entry, boundary);
      return fired;
    }

    const token = this.waiting.get(entry.tokenId);
    if (!token || token.waiting !== 'catchEvent' || token.nodeId !== entry.nodeId) return false;
    const node = token.scope.graph.node(token.nodeId);
    // The timer is one trigger among several on a parallel multiple event.
    if (node && !this.recordTrigger(node, `${node.id}:${token.id}`, 'timer')) return false;
    this.waiting.delete(token.id);
    token.waiting = undefined;
    this.completeNode(token);
    this.leaveViaOutgoing(token);
    return true;
  }

  // --- Variables ---------------------------------------------------------

  /**
   * Reads a variable walking the scope chain outwards: the innermost scope that
   * defines it wins, so a multi-instance item shadows a process variable.
   */
  private readVariable(scope: Scope | undefined, name: string): unknown {
    for (let current = scope; current; current = current.parentScope) {
      if (Object.hasOwn(current.variables, name)) return current.variables[name];
    }
    return undefined;
  }

  /**
   * Writes to the scope that already defines the variable; otherwise to the
   * process scope, matching the usual "process variable" expectation. Use
   * `setLocal` in a handler to keep a value inside the current scope.
   */
  private writeVariable(scope: Scope | undefined, name: string, value: unknown): void {
    let outermost: Scope | undefined;
    for (let current = scope; current; current = current.parentScope) {
      if (Object.hasOwn(current.variables, name)) {
        current.variables[name] = value;
        return;
      }
      outermost = current;
    }
    // A new variable lands on the outermost scope the activity can see. For an
    // isolated scope (data-mapped call activity) that is the scope itself, so
    // its data never leaks into the caller.
    const target = outermost ?? this.scopes[0];
    if (target) target.variables[name] = value;
    else this.initialVariables[name] = value;
  }

  private assignVariables(scope: Scope | undefined, values: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(values)) this.writeVariable(scope, name, value);
  }

  /** Flattened view of the scope chain, innermost value winning. */
  private mergedVariables(scope: Scope | undefined): Record<string, unknown> {
    const chain: Scope[] = [];
    for (let current = scope; current; current = current.parentScope) chain.unshift(current);
    return Object.assign({}, ...chain.map((s) => s.variables)) as Record<string, unknown>;
  }

  private rootVariables(): Record<string, unknown> {
    return { ...(this.scopes[0]?.variables ?? this.initialVariables) };
  }

  /**
   * Live view handed to handlers: reads resolve through the scope chain and
   * writes go where {@link writeVariable} decides, so `ctx.variables.x = 1`
   * keeps working as documented.
   */
  private variableProxy(scope: Scope): Record<string, unknown> {
    return new Proxy(
      {},
      {
        get: (_target, key) =>
          typeof key === 'string' ? this.readVariable(scope, key) : undefined,
        set: (_target, key, value) => {
          if (typeof key === 'string') this.writeVariable(scope, key, value);
          return true;
        },
        has: (_target, key) =>
          typeof key === 'string' && this.readVariable(scope, key) !== undefined,
        ownKeys: () => Object.keys(this.mergedVariables(scope)),
        getOwnPropertyDescriptor: (_target, key) => ({
          value: typeof key === 'string' ? this.readVariable(scope, key) : undefined,
          enumerable: true,
          configurable: true,
          writable: true,
        }),
        deleteProperty: (_target, key) => {
          if (typeof key !== 'string') return true;
          for (let current: Scope | undefined = scope; current; current = current.parentScope) {
            if (Object.hasOwn(current.variables, key)) {
              delete current.variables[key];
              return true;
            }
          }
          return true;
        },
      },
    ) as Record<string, unknown>;
  }

  // --- Run loop ----------------------------------------------------------

  private async drain(): Promise<void> {
    for (;;) {
      const token = this.ready.shift();
      if (token) {
        if (this.steps++ > this.maxSteps) {
          this.fail(
            new BpmnExecutionError('Execution exceeded maxSteps (possible infinite loop).'),
          );
          return;
        }
        await this.processToken(token);
        continue;
      }
      // No ready tokens: check inclusive joins that can now fire.
      if (await this.fireReadyInclusiveJoins()) continue;
      // A conditional event fires as soon as its condition holds.
      if (this.fireReadyConditionalEvents()) continue;
      // An ad-hoc subprocess may declare itself done before running everything.
      if (this.finishSatisfiedAdHocScopes()) continue;
      // Auto mode resolves the next wait to keep the simulation moving.
      if (this.mode === 'auto' && this.autoResolveWait()) continue;
      break;
    }
    this.settleStatus();
  }

  private async processToken(token: RuntimeToken): Promise<void> {
    const node = token.scope.graph.node(token.nodeId);
    if (!node) {
      this.discard(token);
      return;
    }
    // A repeated activity expands into instances before anything else runs;
    // the instance tokens themselves carry `loopInstanceOf` and fall through.
    if (node.loop && !token.loopInstanceOf && isActivityKind(node.kind)) {
      this.startLoop(token, node, node.loop);
      return;
    }
    this.emitter.emit('node.enter', { nodeId: node.id, nodeKind: node.kind, tokenId: token.id });
    this.record(node, 'enter');

    switch (true) {
      case node.kind === 'startEvent':
        this.completeNode(token);
        this.leaveViaOutgoing(token);
        return;
      case node.kind === 'endEvent':
        await this.handleEndEvent(token, node);
        return;
      case node.kind === 'intermediateThrowEvent': {
        // A link throw jumps to its matching catch instead of flowing on.
        if (detailOfKind(node, 'link') && this.followLink(token, node)) return;
        const compensation = detailOfKind(node, 'compensation');
        if (compensation) await this.compensate(token.scope, compensation.activityRef);
        const escalation = detailOfKind(node, 'escalation');
        // An escalation is a shout for help: the branch carries on either way.
        if (escalation) this.raiseEscalation(token.scope, escalation.code ?? escalation.reference);
        this.throwTrigger(node);
        this.completeNode(token);
        this.leaveViaOutgoing(token);
        return;
      }
      case node.kind === 'intermediateCatchEvent':
        this.park(token, 'catchEvent');
        return;
      case node.kind === 'exclusiveGateway':
        await this.handleExclusive(token, node);
        return;
      case node.kind === 'parallelGateway':
        this.handleParallel(token, node);
        return;
      case node.kind === 'inclusiveGateway':
        await this.handleInclusive(token, node);
        return;
      case node.kind === 'eventBasedGateway':
        this.handleEventBased(token, node);
        return;
      case node.kind === 'complexGateway':
        await this.handleComplex(token, node);
        return;
      case node.kind === 'subProcess' ||
        node.kind === 'transaction' ||
        node.kind === 'adHocSubProcess' ||
        (node.kind === 'callActivity' && this.processFor(node) !== undefined):
        this.handleSubProcess(token, node);
        return;
      default:
        await this.handleActivity(token, node);
        return;
    }
  }

  // --- Events ------------------------------------------------------------

  private async handleEndEvent(token: RuntimeToken, node: FlowNode): Promise<void> {
    this.completeNode(token);
    const kind = node.event?.kind ?? 'none';
    if (kind === 'terminate') {
      this.terminateScope(token.scope);
      return;
    }
    if (kind === 'compensation') {
      await this.compensate(token.scope, node.event?.activityRef);
      this.discard(token);
      this.checkScopeCompletion(token.scope);
      return;
    }
    if (kind === 'cancel') {
      await this.cancelTransaction(token);
      return;
    }
    if (kind === 'escalation') {
      this.discard(token);
      const detail = node.event;
      this.raiseEscalation(token.scope, detail?.code ?? detail?.reference);
      this.checkScopeCompletion(token.scope);
      return;
    }
    // An end event may also throw a signal or a message on its way out.
    this.throwTrigger(node);
    if (kind === 'error') {
      this.discard(token);
      const code = node.event?.code ?? node.event?.reference;
      if (this.raiseErrorOnHost(token.scope, code)) return;
      if (this.raiseErrorOnEventSubProcess(code)) return;
      this.checkScopeCompletion(token.scope);
      return;
    }
    this.discard(token);
    this.checkScopeCompletion(token.scope);
  }

  // --- Activities --------------------------------------------------------

  private async handleActivity(token: RuntimeToken, node: FlowNode): Promise<void> {
    const handler = this.registry.resolve(node);
    const isWaitTask = node.kind === 'userTask' || node.kind === 'receiveTask';

    if (!handler) {
      if (isWaitTask) {
        this.park(token, node.kind === 'receiveTask' ? 'receiveTask' : 'userTask');
        return;
      }
      // Unhandled automatic task: pass straight through.
      this.completeNode(token);
      this.leaveViaOutgoing(token);
      return;
    }

    this.emitter.emit('activity.start', { nodeId: node.id, tokenId: token.id });
    try {
      const result = await handler({
        node,
        variables: this.variableProxy(token.scope),
        get: (name) => this.readVariable(token.scope, name),
        set: (name, value) => this.writeVariable(token.scope, name, value),
        setLocal: (name, value) => {
          token.scope.variables[name] = value;
        },
      });
      if (result && typeof result === 'object') this.assignVariables(token.scope, result);
    } catch (error) {
      if (error instanceof BpmnError) {
        this.emitter.emit('activity.end', { nodeId: node.id, tokenId: token.id });
        this.discard(token);
        if (this.raiseErrorOnActivity(token.scope, node.id, error.code)) return;
        // No boundary event: an error event subprocess is the next chance.
        if (this.raiseErrorOnEventSubProcess(error.code)) return;
        this.fail(error);
        return;
      }
      this.handleFailure(token, node, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.incidents.delete(token.id);
    this.emitter.emit('activity.end', { nodeId: node.id, tokenId: token.id });
    this.completeNode(token);
    this.leaveViaOutgoing(token);
  }

  /**
   * A handler threw something that is not a business error: retry it, hold it
   * as an incident, or fail the execution — depending on the options.
   */
  private handleFailure(token: RuntimeToken, node: FlowNode, error: Error): void {
    const attempts = (this.incidents.get(token.id)?.attempts ?? 0) + 1;
    const allowed = this.options.retry?.attempts ?? 0;
    const incident: IncidentState = {
      tokenId: token.id,
      nodeId: node.id,
      scopeId: token.scope.id,
      message: error.message,
      attempts,
    };

    if (attempts <= allowed) {
      const delay = this.options.retry?.delay;
      const retryAt = delay ? resolveTimerDueAt(delay, this.now()) : undefined;
      if (retryAt === undefined) {
        // Retry right away: back to the queue, the step guard bounds the loop.
        this.incidents.set(token.id, incident);
        this.ready.push(token);
        return;
      }
      this.incidents.set(token.id, { ...incident, retryAt });
      this.park(token, 'incident');
      this.emitter.emit('error', { nodeId: node.id, error });
      return;
    }

    if ((this.options.onHandlerError ?? 'fail') === 'incident') {
      this.incidents.set(token.id, incident);
      this.park(token, 'incident');
      this.emitter.emit('error', { nodeId: node.id, error });
      return;
    }
    this.incidents.delete(token.id);
    this.fail(error);
  }

  /**
   * The process an activity runs: the embedded one for a subprocess, or the
   * process a call activity references, when it is part of the definitions.
   */
  private processFor(node: FlowNode): ProcessModel | undefined {
    if (node.process) return node.process;
    if (node.kind === 'callActivity' && node.calledElement) {
      return this.definitions.get(node.calledElement);
    }
    return undefined;
  }

  private handleSubProcess(token: RuntimeToken, node: FlowNode): void {
    const called = this.processFor(node);
    if (!called) {
      // Nothing to run inside: behave as a pass-through activity.
      this.completeNode(token);
      this.leaveViaOutgoing(token);
      return;
    }
    this.emitter.emit('activity.start', { nodeId: node.id, tokenId: token.id });
    token.scope.tokens.delete(token); // suspend parent while child runs
    this.armBoundaryTimers(token);
    const childGraph = new ProcessGraph(called);
    const child = this.createScope(childGraph, token, node.id);
    this.applyDataInput(node, token.scope, child);

    if (node.kind === 'adHocSubProcess') {
      this.startAdHoc(child, node, childGraph);
      return;
    }

    const starts = childGraph.startNodes().filter((s) => !s.event || s.event.kind === 'none');
    if (starts.length === 0) {
      // No plain start: complete immediately.
      this.finishSubProcess(child);
      return;
    }
    for (const start of starts) this.spawn(child, start.id);
  }

  /**
   * Ad-hoc subprocess: its activities have no sequence flow telling them when
   * to run. Every activity without an incoming flow is eligible; `ordering`
   * decides whether they run together or one at a time, and a
   * `completionCondition` can end the scope before all of them ran.
   */
  private startAdHoc(scope: Scope, node: FlowNode, graph: ProcessGraph): void {
    const activities = graph
      .allNodes()
      .filter((candidate) => isActivityKind(candidate.kind) && candidate.incoming.length === 0);
    if (activities.length === 0) {
      this.finishSubProcess(scope);
      return;
    }
    if (node.completionCondition) scope.completionCondition = node.completionCondition;

    if (node.sequential) {
      scope.adHocPending = activities.slice(1).map((activity) => activity.id);
      this.spawn(scope, activities[0]!.id);
      return;
    }
    scope.adHocPending = [];
    for (const activity of activities) this.spawn(scope, activity.id);
  }

  /** Copies the caller's values into the activity's scope, isolating it. */
  private applyDataInput(node: FlowNode, from: Scope, into: Scope): void {
    if (!node.dataInput || node.dataInput.length === 0) return;
    const source = this.mergedVariables(from);
    for (const mapping of node.dataInput) {
      into.variables[mapping.to] = this.evaluate(mapping.from, source);
    }
    // Declaring a mapping means the activity works with its own data only.
    delete into.parentScope;
    into.isolated = true;
  }

  /** Copies the activity's results back to the caller. */
  private applyDataOutput(node: FlowNode, from: Scope, into: Scope): void {
    if (!node.dataOutput || node.dataOutput.length === 0) return;
    const source = this.mergedVariables(from);
    for (const mapping of node.dataOutput) {
      this.writeVariable(into, mapping.to, this.evaluate(mapping.from, source));
    }
  }

  private finishSubProcess(child: Scope): void {
    const parent = child.parentToken;
    const hostId = child.hostNodeId;
    const host = hostId ? parent?.scope.graph.node(hostId) : undefined;
    if (host && parent) this.applyDataOutput(host, child, parent.scope);
    this.scopes.splice(this.scopes.indexOf(child), 1);
    if (!parent || !hostId) return;
    parent.scope.tokens.add(parent);
    this.emitter.emit('activity.end', { nodeId: hostId, tokenId: parent.id });
    this.completeNode(parent);
    this.leaveViaOutgoing(parent);
  }

  // --- Compensation & cancellation ---------------------------------------

  /** The activity that undoes `activityId`, via its compensation boundary. */
  private compensationHandlerFor(scope: Scope, activityId: string): FlowNode | undefined {
    for (const boundary of scope.graph.boundaryEvents(activityId)) {
      if (!detailOfKind(boundary, 'compensation')) continue;
      for (const targetId of scope.graph.associationsFrom(boundary.id)) {
        const handler = scope.graph.node(targetId);
        if (handler) return handler;
      }
    }
    return undefined;
  }

  /**
   * Runs the compensation handlers of the scope in reverse completion order —
   * the last thing done is the first thing undone. `activityRef` narrows it to
   * a single activity, as a targeted compensation event does.
   */
  private async compensate(scope: Scope, activityRef?: string): Promise<void> {
    for (let index = this.compensations.length - 1; index >= 0; index--) {
      const entry = this.compensations[index]!;
      if (entry.scopeId !== scope.id) continue;
      if (activityRef && entry.activityId !== activityRef) continue;
      this.compensations.splice(index, 1); // an activity is compensated once
      const handler = this.compensationHandlerFor(scope, entry.activityId);
      if (!handler) continue;
      const token = this.spawn(scope, handler.id);
      // Run it now: the throw event only continues once the undo is done.
      this.ready.splice(this.ready.indexOf(token), 1);
      this.emitter.emit('activity.start', { nodeId: handler.id, tokenId: token.id });
      await this.processToken(token);
    }
  }

  /**
   * Cancel end event inside a transaction: undo what the transaction already
   * did, drop the rest of its work and leave through the cancel boundary event.
   */
  private async cancelTransaction(token: RuntimeToken): Promise<void> {
    const scope = token.scope;
    await this.compensate(scope);
    this.discard(token);

    const parentToken = scope.parentToken;
    const hostId = scope.hostNodeId;
    this.cancelLoopsOf(scope);
    for (const remaining of [...scope.tokens]) this.discard(remaining);
    this.removeScope(scope);

    if (!parentToken || !hostId) {
      // A cancel outside a transaction ends the process instance.
      this.status = 'terminated';
      return;
    }
    const parentScope = parentToken.scope;
    this.discard(parentToken);
    const boundary = parentScope.graph
      .boundaryEvents(hostId)
      .find((candidate) => detailOfKind(candidate, 'cancel'));
    if (boundary) {
      this.emitBoundary(parentScope, boundary);
      return;
    }
    this.checkScopeCompletion(parentScope);
  }

  // --- Multi-instance & loops -------------------------------------------

  /** Expands an activity marked as multi-instance (or standard loop). */
  private startLoop(token: RuntimeToken, node: FlowNode, loop: LoopCharacteristics): void {
    const scope = token.scope;
    const variables = this.mergedVariables(scope);
    let items: unknown[] | undefined;
    let total: number;

    if (loop.kind === 'multiInstance') {
      if (loop.collection) {
        const collection = this.readVariable(scope, loop.collection);
        if (!Array.isArray(collection)) {
          this.fail(
            new BpmnExecutionError(
              `Multi-instance collection "${loop.collection}" of ${node.id} is not an array.`,
            ),
          );
          return;
        }
        items = [...collection];
        total = items.length;
      } else if (loop.cardinality) {
        const value = Number(this.evaluate(loop.cardinality, variables));
        if (!Number.isFinite(value) || value < 0) {
          this.fail(
            new BpmnExecutionError(`Multi-instance cardinality of ${node.id} is not a number.`),
          );
          return;
        }
        total = Math.floor(value);
      } else {
        this.fail(
          new BpmnExecutionError(
            `Multi-instance activity ${node.id} needs a cardinality or a collection.`,
          ),
        );
        return;
      }
    } else {
      total = loop.maximum ?? DEFAULT_LOOP_MAXIMUM;
      // `testBefore` means the condition guards the very first iteration too.
      if (loop.testBefore && loop.loopCondition && !this.condition(loop.loopCondition, variables))
        total = 0;
    }

    if (total === 0) {
      // Zero instances: the activity is simply skipped, per the specification.
      this.completeNode(token);
      this.leaveViaOutgoing(token);
      return;
    }

    scope.tokens.delete(token); // suspend until every instance is done
    this.armBoundaryTimers(token);
    const run: LoopRun = {
      id: `loop-${this.loopSeq++}`,
      nodeId: node.id,
      scope,
      parentToken: token,
      loop,
      ...(items ? { items } : {}),
      total,
      started: 0,
      completed: 0,
      results: [],
      instanceScopes: new Set(),
    };
    this.loops.set(run.id, run);
    if (loop.outputCollection) this.writeVariable(scope, loop.outputCollection, []);
    this.emitter.emit('activity.start', { nodeId: node.id, tokenId: token.id });

    if (loop.sequential) {
      this.startLoopInstance(run);
      return;
    }
    for (let index = 0; index < total; index++) this.startLoopInstance(run);
  }

  /** Creates one instance scope (with its own item/counter) and its token. */
  private startLoopInstance(run: LoopRun): void {
    const index = run.started++;
    const variables: Record<string, unknown> = { loopCounter: index };
    if (run.loop.elementVariable && run.items) {
      variables[run.loop.elementVariable] = run.items[index];
    }
    // Declaring the output variable locally keeps each instance's result inside
    // its own scope, so a handler can just `set` it and the loop collects it.
    if (run.loop.outputElement) variables[run.loop.outputElement] = undefined;
    const scope: Scope = {
      id: `scope-${this.scopeSeq++}`,
      graph: run.scope.graph,
      parentScope: run.scope,
      parentScopeId: run.scope.id,
      hostNodeId: run.nodeId,
      loopId: run.id,
      loopIndex: index,
      variables,
      tokens: new Set(),
    };
    this.scopes.push(scope);
    run.instanceScopes.add(scope);
    const token = this.spawn(scope, run.nodeId);
    token.loopInstanceOf = run.id;
  }

  /** One instance reached the end of the activity. */
  private finishLoopInstance(token: RuntimeToken): void {
    const run = token.loopInstanceOf ? this.loops.get(token.loopInstanceOf) : undefined;
    const scope = token.scope;
    this.discard(token);
    if (!run) return;

    this.collectLoopOutput(run, scope);
    run.instanceScopes.delete(scope);
    this.removeScope(scope);
    run.completed++;

    const variables = this.mergedVariables(run.scope);
    if (run.loop.kind === 'multiInstance') {
      if (run.loop.completionCondition && this.condition(run.loop.completionCondition, variables))
        return this.finishLoop(run);
      if (run.loop.sequential) {
        if (run.started < run.total) return this.startLoopInstance(run);
        return this.finishLoop(run);
      }
      if (run.completed >= run.total) this.finishLoop(run);
      return;
    }

    const repeat =
      run.started < run.total &&
      (!run.loop.loopCondition || this.condition(run.loop.loopCondition, variables));
    if (repeat) this.startLoopInstance(run);
    else this.finishLoop(run);
  }

  /**
   * Aggregates the instance's output variable into the output collection.
   *
   * The specification asks for positional correspondence between input and
   * output collection: the result of the instance that ran over `itens[2]`
   * belongs at `resultados[2]`. Appending on completion breaks that as soon as
   * a parallel run finishes out of order, so the result is stored under the
   * instance index and the whole collection is rebuilt in index order.
   *
   * The rebuilt array is dense: an instance cancelled by a completion condition
   * never contributes, instead of leaving a hole (an instance that produced
   * `undefined` still occupies its slot).
   */
  private collectLoopOutput(run: LoopRun, instanceScope: Scope): void {
    const { outputCollection, outputElement } = run.loop;
    if (!outputCollection || !outputElement) return;
    if (!Array.isArray(this.readVariable(run.scope, outputCollection))) return;
    run.results.push({
      index: instanceScope.loopIndex ?? run.results.length,
      value: this.readVariable(instanceScope, outputElement),
    });
    const ordered = [...run.results].sort((a, b) => a.index - b.index);
    this.writeVariable(
      run.scope,
      outputCollection,
      ordered.map((result) => result.value),
    );
  }

  /** Every instance is done (or was cancelled): the activity itself completes. */
  private finishLoop(run: LoopRun): void {
    this.loops.delete(run.id);
    for (const scope of [...run.instanceScopes]) {
      for (const token of [...scope.tokens]) this.discard(token);
      this.removeScope(scope);
    }
    run.instanceScopes.clear();

    const parent = run.parentToken;
    parent.scope.tokens.add(parent);
    this.emitter.emit('activity.end', { nodeId: run.nodeId, tokenId: parent.id });
    this.completeNode(parent, { history: false });
    this.leaveViaOutgoing(parent);
  }

  /** Discards every instance of a repeated activity and forgets the run. */
  private cancelLoop(run: LoopRun): void {
    this.loops.delete(run.id);
    for (const scope of [...run.instanceScopes]) {
      for (const token of [...scope.tokens]) this.discard(token);
      this.removeScope(scope);
    }
    run.instanceScopes.clear();
  }

  /** Cancels every repeated activity living in the given scope. */
  private cancelLoopsOf(scope: Scope): void {
    for (const run of [...this.loops.values()]) {
      if (run.scope !== scope) continue;
      this.cancelLoop(run);
      this.discard(run.parentToken);
    }
  }

  private removeScope(scope: Scope): void {
    const index = this.scopes.indexOf(scope);
    if (index >= 0) this.scopes.splice(index, 1);
    // Nothing left to compensate in a scope that no longer exists.
    for (let i = this.compensations.length - 1; i >= 0; i--) {
      if (this.compensations[i]!.scopeId === scope.id) this.compensations.splice(i, 1);
    }
  }

  // --- Gateways ----------------------------------------------------------

  private async handleExclusive(token: RuntimeToken, node: FlowNode): Promise<void> {
    this.completeNode(token);
    const flows = token.scope.graph.outgoing(node);
    const byData = this.firstMatching(flows, node, token.scope) ?? this.defaultFlow(flows, node);
    // Exclusive means one: whatever the hook answers, only the first is taken.
    const chosen = (await this.chooseFlows(token, node, flows, byData ? [byData] : []))[0];
    if (!chosen) {
      this.fail(new BpmnExecutionError(`Exclusive gateway ${node.id} has no valid outgoing flow.`));
      return;
    }
    this.moveAlong(token, chosen);
    this.discard(token);
  }

  private handleParallel(token: RuntimeToken, node: FlowNode): void {
    const incoming = node.incoming;
    if (incoming.length > 1) {
      const key = `${token.scope.id}:${node.id}`;
      const counts = this.parallelBuffers.get(key) ?? new Map<string, number>();
      if (token.viaFlowId) counts.set(token.viaFlowId, (counts.get(token.viaFlowId) ?? 0) + 1);
      this.parallelBuffers.set(key, counts);
      this.discard(token);
      const satisfied = incoming.every((f) => (counts.get(f) ?? 0) >= 1);
      if (!satisfied) return;
      for (const f of incoming) counts.set(f, (counts.get(f) ?? 0) - 1);
      this.completeNode(token);
      this.splitAll(token.scope, node);
      return;
    }
    this.completeNode(token);
    this.splitAll(token.scope, node);
    this.discard(token);
  }

  private async handleInclusive(token: RuntimeToken, node: FlowNode): Promise<void> {
    if (node.incoming.length > 1) {
      const key = `${token.scope.id}:${node.id}`;
      const buffer = this.inclusiveBuffers.get(key) ?? [];
      buffer.push(token);
      this.inclusiveBuffers.set(key, buffer);
      token.scope.tokens.delete(token);
      // Firing decision is made in fireReadyInclusiveJoins once quiescent.
      return;
    }
    this.completeNode(token);
    await this.inclusiveSplit(token, node);
    this.discard(token);
  }

  /**
   * Complex gateway. With an `activationCondition` the join fires when that
   * expression turns true (the number of tokens that arrived is exposed as
   * `arrived`); without one it behaves like an inclusive gateway.
   */
  private async handleComplex(token: RuntimeToken, node: FlowNode): Promise<void> {
    await this.handleInclusive(token, node);
  }

  private handleEventBased(token: RuntimeToken, node: FlowNode): void {
    this.completeNode(token);
    const flows = token.scope.graph.outgoing(node);
    const alternatives = flows.map((f) => ({ eventNodeId: f.targetRef, flowId: f.id }));
    this.eventChoices.set(token.id, { token, alternatives });
    for (const alt of alternatives) this.armedEvents.set(alt.eventNodeId, token.id);
    token.waiting = 'eventBasedGateway';
    this.waiting.set(token.id, token);
    this.emitter.emit('wait', { nodeId: node.id, tokenId: token.id, reason: 'eventBasedGateway' });
  }

  // --- Flow selection ----------------------------------------------------

  /**
   * Lets `options.decide` route the token instead of the conditions. Without a
   * hook — or when it answers nothing the gateway recognizes — the data-driven
   * choice stands.
   */
  private async chooseFlows(
    token: RuntimeToken,
    node: FlowNode,
    flows: SequenceFlow[],
    byData: SequenceFlow[],
  ): Promise<SequenceFlow[]> {
    if (!this.options.decide) return byData;
    const answer = await this.options.decide({
      nodeId: node.id,
      nodeKind: node.kind,
      options: flows.map((flow) => ({
        flowId: flow.id,
        targetId: flow.targetRef,
        isDefault: flow.isDefault === true || flow.id === node.default,
        ...(flow.name ? { name: flow.name } : {}),
        ...(flow.conditionExpression ? { condition: flow.conditionExpression } : {}),
      })),
      suggested: byData.map((flow) => flow.id),
      variables: this.mergedVariables(token.scope),
      ...(node.name ? { name: node.name } : {}),
    });
    if (answer === undefined) return byData;
    const ids = typeof answer === 'string' ? [answer] : answer;
    const picked = ids
      .map((id) => flows.find((flow) => flow.id === id))
      .filter((flow): flow is SequenceFlow => flow !== undefined);
    return picked.length > 0 ? picked : byData;
  }

  private firstMatching(
    flows: SequenceFlow[],
    node: FlowNode,
    scope: Scope,
  ): SequenceFlow | undefined {
    const variables = this.mergedVariables(scope);
    for (const flow of flows) {
      if (flow.id === node.default) continue;
      if (!flow.conditionExpression) return flow;
      if (this.condition(flow.conditionExpression, variables)) return flow;
    }
    return undefined;
  }

  private defaultFlow(flows: SequenceFlow[], node: FlowNode): SequenceFlow | undefined {
    if (node.default) return flows.find((f) => f.id === node.default);
    if (this.mode === 'auto') return flows[0];
    return undefined;
  }

  private async inclusiveSplit(token: RuntimeToken, node: FlowNode): Promise<void> {
    const flows = token.scope.graph.outgoing(node);
    const variables = this.mergedVariables(token.scope);
    const taken = flows.filter(
      (f) =>
        f.id !== node.default &&
        (!f.conditionExpression || this.condition(f.conditionExpression, variables)),
    );
    const byData =
      taken.length > 0
        ? taken
        : this.defaultFlow(flows, node)
          ? [this.defaultFlow(flows, node)!]
          : [];
    const chosen = await this.chooseFlows(token, node, flows, byData);
    if (chosen.length === 0) {
      this.fail(new BpmnExecutionError(`Inclusive gateway ${node.id} has no valid outgoing flow.`));
      return;
    }
    for (const flow of chosen) this.moveAlong(token, flow);
  }

  private splitAll(scope: Scope, node: FlowNode): void {
    for (const flow of scope.graph.outgoing(node)) {
      this.emitter.emit('flow.take', {
        flowId: flow.id,
        sourceId: flow.sourceRef,
        targetId: flow.targetRef,
        tokenId: '-',
      });
      this.spawn(scope, flow.targetRef, flow.id);
    }
  }

  private leaveViaOutgoing(token: RuntimeToken): void {
    // An instance of a repeated activity never continues on its own: it reports
    // back to the loop, which decides whether to start another one.
    if (token.loopInstanceOf) {
      this.finishLoopInstance(token);
      return;
    }
    const node = token.scope.graph.node(token.nodeId);
    if (!node) return;
    const flows = token.scope.graph.outgoing(node);
    if (flows.length === 0) {
      // Implicit end.
      this.discard(token);
      this.checkScopeCompletion(token.scope);
      return;
    }
    // Uncontrolled flow: take every unconditional/true-condition flow.
    const variables = this.mergedVariables(token.scope);
    const taken = flows.filter(
      (f) => !f.conditionExpression || this.condition(f.conditionExpression, variables),
    );
    const chosen =
      taken.length > 0
        ? taken
        : this.defaultFlow(flows, node)
          ? [this.defaultFlow(flows, node)!]
          : flows.slice(0, 1);
    for (const flow of chosen) this.moveAlong(token, flow);
    this.discard(token);
  }

  private moveAlong(token: RuntimeToken, flow: SequenceFlow): void {
    this.emitter.emit('node.leave', {
      nodeId: token.nodeId,
      nodeKind: token.scope.graph.requireNode(token.nodeId).kind,
      tokenId: token.id,
    });
    this.emitter.emit('flow.take', {
      flowId: flow.id,
      sourceId: flow.sourceRef,
      targetId: flow.targetRef,
      tokenId: token.id,
    });
    this.spawn(token.scope, flow.targetRef, flow.id);
  }

  // --- Waits, signals & boundaries --------------------------------------

  private park(token: RuntimeToken, reason: WaitReason): void {
    token.waiting = reason;
    this.waiting.set(token.id, token);
    this.armTimers(token);
    this.emitter.emit('wait', { nodeId: token.nodeId, tokenId: token.id, reason });
  }

  /**
   * Records one trigger against an event and answers whether it may now fire.
   *
   * A plain multiple event fires on the first trigger that reaches it. One
   * marked `parallelMultiple` collects them instead and only opens once every
   * declared trigger arrived, which is what the specification asks for;
   * `gateKey` is what tells two activations of the same event apart.
   */
  private recordTrigger(node: FlowNode, gateKey: string, triggerKey: string): boolean {
    if (node.parallelMultiple !== true) return true;
    const required = requiredTriggerKeys(node);
    if (required.length <= 1) return true;

    const received = this.multiTriggers.get(gateKey) ?? new Set<string>();
    received.add(triggerKey);
    if (!required.every((key) => received.has(key))) {
      this.multiTriggers.set(gateKey, received);
      return false;
    }
    this.multiTriggers.delete(gateKey);
    return true;
  }

  /**
   * Whether a subscriber accepts this delivery. A broadcast signal reaches
   * everyone; a correlated message only reaches the subscribers whose key
   * resolves to the delivered value.
   */
  private correlates(node: FlowNode, scope: Scope, correlation: Correlation | undefined): boolean {
    if (!correlation || !node.correlationKey) return true;
    const value = this.evaluate(node.correlationKey, this.mergedVariables(scope));
    return sameCorrelationKey(value, correlation.key);
  }

  /**
   * Whether a delivered signal opens this event. Addressing it by its own id
   * fires it outright: that names the event, not one of its triggers.
   */
  private signalOpens(node: FlowNode, gateKey: string, nameOrId: string): boolean {
    if (node.id === nameOrId) {
      this.multiTriggers.delete(gateKey);
      return true;
    }
    return this.recordTrigger(node, gateKey, triggerKeyFor(node, nameOrId));
  }

  /**
   * Delivers a trigger to **every** subscriber that matches, as the
   * specification requires of a signal: parked catch events, armed
   * event-based gateway alternatives, boundary events and event subprocesses.
   */
  private deliverSignal(nameOrId: string, correlation?: Correlation): boolean {
    // A trigger absorbed by a parallel multiple event that is still short of
    // the rest was delivered too: it just did not move anything yet.
    let delivered = false;

    // 1. Parked catch events and receive tasks (by node id or event reference).
    const parked: RuntimeToken[] = [];
    for (const token of this.waiting.values()) {
      if (token.waiting !== 'catchEvent' && token.waiting !== 'receiveTask') continue;
      const node = token.scope.graph.node(token.nodeId);
      if (!node || !matchesTrigger(node, nameOrId)) continue;
      if (!this.correlates(node, token.scope, correlation)) continue;
      delivered = true;
      if (this.signalOpens(node, `${node.id}:${token.id}`, nameOrId)) parked.push(token);
    }
    for (const token of parked) {
      this.waiting.delete(token.id);
      token.waiting = undefined;
      this.completeNode(token);
      this.leaveViaOutgoing(token);
    }

    // 2. Event-based gateway alternatives.
    for (const [eventNodeId, gatewayTokenId] of [...this.armedEvents]) {
      const choice = this.eventChoices.get(gatewayTokenId);
      if (!choice) continue;
      const eventNode = choice.token.scope.graph.node(eventNodeId);
      if (!eventNode || !matchesTrigger(eventNode, nameOrId)) continue;
      if (!this.correlates(eventNode, choice.token.scope, correlation)) continue;
      this.resolveEventChoice(choice, eventNodeId);
      delivered = true;
    }

    // 3. Boundary events on active/waiting/suspended activities.
    if (this.fireBoundaryBySignal(nameOrId, correlation)) delivered = true;

    // 4. Event subprocesses listening for this trigger.
    if (
      this.startEventSubProcesses(
        (start, scope) =>
          matchesTrigger(start, nameOrId) &&
          this.correlates(start, scope, correlation) &&
          this.signalOpens(start, `${start.id}:${scope.id}`, nameOrId),
      )
    ) {
      delivered = true;
    }

    return delivered;
  }

  /**
   * Starts every event subprocess whose start event matches. An interrupting
   * one cancels the work of the scope that declares it; a non-interrupting one
   * runs alongside it.
   */
  private startEventSubProcesses(matches: (start: FlowNode, host: Scope) => boolean): boolean {
    let started = false;
    for (const scope of [...this.scopes]) {
      // Loop instance scopes share their parent's graph: only look once.
      if (scope.loopId) continue;
      for (const node of scope.graph.allNodes()) {
        if (!node.triggeredByEvent || !node.process) continue;
        // An event subprocess already running is not started again.
        const running = this.scopes.some(
          (s) => s.hostNodeId === node.id && s.parentScopeId === scope.id,
        );
        if (running) continue;
        const graph = new ProcessGraph(node.process);
        const start = graph
          .allNodes()
          .find((candidate) => candidate.kind === 'startEvent' && matches(candidate, scope));
        if (!start) continue;
        this.launchEventSubProcess(scope, node, graph, start);
        started = true;
      }
    }
    return started;
  }

  private launchEventSubProcess(
    host: Scope,
    node: FlowNode,
    graph: ProcessGraph,
    start: FlowNode,
  ): void {
    if (start.interrupting !== false) {
      // Interrupting: the enclosing scope stops doing whatever it was doing.
      for (const token of [...host.tokens]) this.discard(token);
    }
    const child = this.createScope(graph, undefined, node.id);
    child.parentScope = host;
    child.parentScopeId = host.id;
    this.emitter.emit('activity.start', { nodeId: node.id, tokenId: '-' });
    const token = this.spawn(child, start.id);
    this.completeNode(token);
  }

  private resolveEventChoice(choice: EventChoice, eventNodeId: string): void {
    const { token, alternatives } = choice;
    this.waiting.delete(token.id);
    this.eventChoices.delete(token.id);
    for (const alt of alternatives) this.armedEvents.delete(alt.eventNodeId);
    const flow = alternatives.find((a) => a.eventNodeId === eventNodeId)?.flowId;
    token.scope.tokens.delete(token);
    // Continue from the chosen catch event onward.
    const chosen = this.spawn(token.scope, eventNodeId, flow);
    this.completeNode(chosen);
    // The catch event itself is considered already satisfied: pass through.
    this.ready.splice(this.ready.indexOf(chosen), 1);
    this.leaveViaOutgoing(chosen);
  }

  /** Reports whether any boundary event took the trigger, fired or not. */
  private fireBoundaryBySignal(nameOrId: string, correlation?: Correlation): boolean {
    let delivered = false;
    for (const scope of this.scopes) {
      for (const node of scope.graph.allNodes()) {
        if (node.kind !== 'boundaryEvent' || !node.attachedToRef) continue;
        if (node.id !== nameOrId && !detailsOf(node).some((d) => d.reference === nameOrId)) {
          continue;
        }
        if (!this.correlates(node, scope, correlation)) continue;
        delivered = true;
        if (!this.signalOpens(node, `${node.id}:${scope.id}`, nameOrId)) continue;
        if (this.fireBoundary(scope, node)) return true;
      }
    }
    return delivered;
  }

  /**
   * A throw event with a signal or message definition delivers it, so catch
   * events, boundary events and event subprocesses listening for that name
   * react — the same broadcast an external `signal()` performs.
   */
  private throwTrigger(node: FlowNode): void {
    for (const detail of detailsOf(node)) {
      if (detail.kind !== 'signal' && detail.kind !== 'message') continue;
      const name = detail.reference ?? node.messageRef;
      if (name) this.deliverSignal(name);
    }
  }

  /**
   * Escalation travels outwards: it looks for an escalation boundary event on
   * the activity that hosts this scope, then for an escalation event
   * subprocess. Unlike an error, an unhandled escalation is not a failure.
   */
  private raiseEscalation(scope: Scope, code?: string): boolean {
    for (let current: Scope | undefined = scope; current; current = current.parentScope) {
      const hostId = current.hostNodeId;
      const parentScope = current.parentToken?.scope ?? current.parentScope;
      if (!hostId || !parentScope) continue;
      const boundary = parentScope.graph.boundaryEvents(hostId).find((candidate) => {
        const detail = detailOfKind(candidate, 'escalation');
        if (!detail) return false;
        return !code || !detail.code || detail.code === code;
      });
      if (boundary && this.fireBoundary(parentScope, boundary)) return true;
    }
    return this.startEventSubProcesses((start) => {
      const detail = detailOfKind(start, 'escalation');
      if (!detail) return false;
      return !code || !detail.code || detail.code === code;
    });
  }

  /** True when an event subprocess with a matching error start event ran. */
  private raiseErrorOnEventSubProcess(code?: string): boolean {
    return this.startEventSubProcesses(
      (start) =>
        start.event?.kind === 'error' && (!code || !start.event.code || start.event.code === code),
    );
  }

  private raiseErrorOnActivity(scope: Scope, activityId: string, code?: string): boolean {
    for (const node of scope.graph.allNodes()) {
      if (node.kind !== 'boundaryEvent' || node.attachedToRef !== activityId) continue;
      const error = detailOfKind(node, 'error');
      if (!error) continue;
      if (code && error.code && error.code !== code) continue;
      // Route from the boundary (activity token already discarded).
      const chosen = this.spawn(scope, node.id);
      this.completeNode(chosen);
      this.ready.splice(this.ready.indexOf(chosen), 1);
      this.leaveViaOutgoing(chosen);
      return true;
    }
    return false;
  }

  private raiseErrorOnHost(childScope: Scope, code?: string): boolean {
    const parent = childScope.parentToken;
    const hostId = childScope.hostNodeId;
    if (!parent || !hostId) return false;
    const found = this.raiseErrorOnActivity(parent.scope, hostId, code);
    if (found) {
      // Cancel the remaining subprocess scope and its suspended parent.
      for (const t of [...childScope.tokens]) this.discard(t);
      this.scopes.splice(this.scopes.indexOf(childScope), 1);
      this.discard(parent);
    }
    return found;
  }

  private fireBoundary(scope: Scope, boundary: FlowNode): boolean {
    const hostId = boundary.attachedToRef!;
    const interrupting = boundary.cancelActivity !== false;

    // Host is a repeated activity: the event applies to every instance at once.
    const run = [...this.loops.values()].find(
      (candidate) => candidate.nodeId === hostId && candidate.scope === scope,
    );
    if (run) {
      if (interrupting) {
        this.cancelLoop(run);
        this.discard(run.parentToken);
      }
      this.emitBoundary(scope, boundary);
      return true;
    }

    // Find the host token: a waiting task token, or a suspended subprocess parent.
    const childScope = this.scopes.find((s) => s.hostNodeId === hostId && s.parentToken);
    if (childScope) {
      if (interrupting) {
        this.cancelLoopsOf(childScope);
        for (const t of [...childScope.tokens]) this.discard(t);
        this.scopes.splice(this.scopes.indexOf(childScope), 1);
        const parent = childScope.parentToken!;
        this.discard(parent);
      }
      this.emitBoundary(scope, boundary);
      return true;
    }
    for (const token of scope.tokens) {
      if (token.nodeId !== hostId) continue;
      if (interrupting) this.discard(token);
      this.emitBoundary(scope, boundary);
      return true;
    }
    return false;
  }

  private emitBoundary(scope: Scope, boundary: FlowNode): void {
    const chosen = this.spawn(scope, boundary.id);
    this.completeNode(chosen);
    this.ready.splice(this.ready.indexOf(chosen), 1);
    this.leaveViaOutgoing(chosen);
  }

  // --- Inclusive join firing --------------------------------------------

  private async fireReadyInclusiveJoins(): Promise<boolean> {
    for (const [key, buffer] of this.inclusiveBuffers) {
      if (buffer.length === 0) continue;
      const first = buffer[0]!;
      const scope = first.scope;
      const node = scope.graph.requireNode(first.nodeId);
      if (node.activationCondition) {
        // Complex gateway: the diagram decides when enough tokens arrived.
        const variables = { ...this.mergedVariables(scope), arrived: buffer.length };
        if (!this.condition(node.activationCondition, variables)) continue;
      } else if (this.canAnyTokenReach(scope, node.id, buffer)) {
        continue;
      }
      this.inclusiveBuffers.delete(key);
      this.completeNode(first);
      // Merge all buffered tokens into a single continuation.
      await this.inclusiveSplit(first, node);
      return true;
    }
    return false;
  }

  /**
   * Resumes a parked conditional catch event whose condition became true.
   * Evaluated whenever the engine runs out of ready tokens, which is when the
   * variables have settled.
   */
  private fireReadyConditionalEvents(): boolean {
    for (const token of [...this.waiting.values()]) {
      if (token.waiting !== 'catchEvent') continue;
      const node = token.scope.graph.node(token.nodeId);
      const condition = node ? detailOfKind(node, 'conditional')?.condition : undefined;
      if (!condition) continue;
      if (!this.condition(condition, this.mergedVariables(token.scope))) continue;
      this.waiting.delete(token.id);
      token.waiting = undefined;
      this.completeNode(token);
      this.leaveViaOutgoing(token);
      return true;
    }
    return this.fireReadyConditionalBoundaries();
  }

  /**
   * A conditional boundary event watches the variables while its activity runs.
   * Each activation fires once, so a non-interrupting one does not loop.
   */
  private fireReadyConditionalBoundaries(): boolean {
    for (const token of [...this.waiting.values()]) {
      const scope = token.scope;
      for (const boundary of scope.graph.boundaryEvents(token.nodeId)) {
        const condition = detailOfKind(boundary, 'conditional')?.condition;
        if (!condition) continue;
        const key = `${boundary.id}:${token.id}`;
        if (this.firedConditionals.has(key)) continue;
        if (!this.condition(condition, this.mergedVariables(scope))) continue;
        this.firedConditionals.add(key);
        if (this.fireBoundary(scope, boundary)) return true;
      }
    }
    return false;
  }

  /** Ends ad-hoc scopes whose completion condition already holds. */
  private finishSatisfiedAdHocScopes(): boolean {
    for (const scope of [...this.scopes]) {
      if (!scope.completionCondition) continue;
      if (!this.condition(scope.completionCondition, this.mergedVariables(scope))) continue;
      for (const token of [...scope.tokens]) this.discard(token);
      scope.adHocPending = [];
      delete scope.completionCondition;
      this.finishSubProcess(scope);
      return true;
    }
    return false;
  }

  /** True if any active token (outside `exclude`) can still reach `targetId`. */
  private canAnyTokenReach(scope: Scope, targetId: string, exclude: RuntimeToken[]): boolean {
    const excludeIds = new Set(exclude.map((t) => t.id));
    const sources: string[] = [];
    for (const token of scope.tokens) {
      if (excludeIds.has(token.id)) continue;
      sources.push(token.nodeId);
    }
    for (const t of this.ready) {
      if (t.scope === scope && !excludeIds.has(t.id)) sources.push(t.nodeId);
    }
    const visited = new Set<string>();
    const queue = [...sources];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const node = scope.graph.node(current);
      if (!node || node.id === targetId) continue;
      for (const flow of scope.graph.outgoing(node)) queue.push(flow.targetRef);
    }
    return false;
  }

  // --- Auto mode & termination ------------------------------------------

  private autoResolveWait(): boolean {
    const next = this.waiting.values().next();
    if (next.done) return false;
    const token = next.value;
    if (token.waiting === 'eventBasedGateway') {
      const choice = this.eventChoices.get(token.id);
      if (choice && choice.alternatives[0]) {
        this.resolveEventChoice(choice, choice.alternatives[0].eventNodeId);
        return true;
      }
    }
    this.waiting.delete(token.id);
    token.waiting = undefined;
    this.completeNode(token);
    this.leaveViaOutgoing(token);
    return true;
  }

  private terminateScope(scope: Scope): void {
    // Repeated activities keep their tokens outside the scope: cancel them too.
    this.cancelLoopsOf(scope);
    for (const token of [...scope.tokens]) this.discard(token);
    if (scope.parentToken) {
      this.finishSubProcess(scope);
    } else {
      this.status = 'terminated';
    }
  }

  private checkScopeCompletion(scope: Scope): void {
    if (scope.tokens.size > 0) return;
    if (this.hasPendingFor(scope)) return;
    // Ad-hoc, one at a time: the next activity only starts now.
    const next = scope.adHocPending?.shift();
    if (next !== undefined) {
      this.spawn(scope, next);
      return;
    }
    if (scope.parentToken) {
      this.finishSubProcess(scope);
      return;
    }
    // Event subprocess scopes have no parent token: they just go away.
    if (scope.hostNodeId) {
      this.emitter.emit('activity.end', { nodeId: scope.hostNodeId, tokenId: '-' });
      this.removeScope(scope);
    }
  }

  private hasPendingFor(scope: Scope): boolean {
    for (const key of this.inclusiveBuffers.keys()) {
      if (key.startsWith(`${scope.id}:`) && this.inclusiveBuffers.get(key)!.length > 0) return true;
    }
    return false;
  }

  /**
   * Marks the node as completed. `history: false` keeps the bookkeeping without
   * a history entry — used when a repeated activity finishes, since each
   * instance already recorded its own enter/complete pair.
   */
  private completeNode(token: RuntimeToken, options: { history?: boolean } = {}): void {
    this.completedNodes.add(token.nodeId);
    const node = token.scope.graph.node(token.nodeId);
    if (node && this.compensationHandlerFor(token.scope, node.id)) {
      // Remember it so a later compensation event can undo it, newest first.
      this.compensations.push({ activityId: node.id, scopeId: token.scope.id });
    }
    if (node && options.history !== false) this.record(node, 'complete');
  }

  /** Appends to the history with the engine clock, keeping order explicit. */
  private record(node: FlowNode, event: HistoryEntry['event']): void {
    this.history.push({
      nodeId: node.id,
      nodeKind: node.kind,
      event,
      at: this.now(),
      seq: this.history.length,
    });
  }

  private fail(error: Error): void {
    this.status = 'failed';
    this.emitter.emit('error', { error });
    this.ready.length = 0;
  }

  private settleStatus(): void {
    if (this.status === 'failed' || this.status === 'terminated') {
      this.emitFinal();
      return;
    }
    const hasTokens = this.scopes.some((s) => s.tokens.size > 0);
    const hasBuffers = [...this.inclusiveBuffers.values()].some((b) => b.length > 0);
    if (!hasTokens && !hasBuffers) {
      this.status = 'completed';
      this.emitFinal();
      return;
    }
    this.status = this.waiting.size > 0 ? 'waiting' : 'running';
  }

  private emitFinal(): void {
    this.emitter.emit('process.end', { processId: this.rootGraph.process.id, status: this.status });
  }
}

/** Applies a {@link TaskFilter} to one task. */
function matchesFilter(task: PendingTask, filter: TaskFilter): boolean {
  if (filter.nodeId && task.nodeId !== filter.nodeId) return false;
  if (filter.reason) {
    const reasons = Array.isArray(filter.reason) ? filter.reason : [filter.reason];
    if (!reasons.includes(task.reason)) return false;
  }
  if (filter.role && task.lane !== filter.role && !task.candidates.includes(filter.role)) {
    return false;
  }
  return true;
}

/** Every event definition declared on a node (one `none` when it declares none). */
function detailsOf(node: FlowNode): EventDetail[] {
  return node.events ?? (node.event ? [node.event] : []);
}

/**
 * The trigger keys a `parallelMultiple` event waits for: one per declared
 * definition. A definition without a reference (a timer, a conditional) is
 * identified by its kind, which is as far apart as two of them can be told.
 */
function requiredTriggerKeys(node: FlowNode): string[] {
  return [...new Set(detailsOf(node).map((detail) => detail.reference ?? detail.kind))];
}

/** Which of the node's declared triggers a delivered name satisfies. */
function triggerKeyFor(node: FlowNode, nameOrId: string): string {
  const detail = detailsOf(node).find((candidate) => candidate.reference === nameOrId);
  return detail ? (detail.reference ?? detail.kind) : nameOrId;
}

/** A trigger matches a node by its id, its message, or any event reference. */
function matchesTrigger(node: FlowNode, nameOrId: string): boolean {
  return (
    node.id === nameOrId ||
    node.messageRef === nameOrId ||
    detailsOf(node).some((detail) => detail.reference === nameOrId)
  );
}

/** First definition of a given kind, when the node declares one. */
function detailOfKind(node: FlowNode, kind: EventDefinitionKind): EventDetail | undefined {
  return detailsOf(node).find((detail) => detail.kind === kind);
}

/**
 * Whether two correlation keys identify the same instance. Compared by value,
 * with a textual fallback: a key that travelled through a URL or a JSON body
 * arrives as text, and `"42"` names the same order as `42`.
 */
function sameCorrelationKey(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') return false;
  return String(a) === String(b);
}

/** Timers are unique per (token, timer node) pair. */
function timerKey(tokenId: string, nodeId: string): string {
  return `${tokenId}:${nodeId}`;
}
