import { BpmnValidationError } from '../errors.js';
import type { ProcessGraph } from '../model/graph.js';
import type { LoopRunner } from './loop-runner.js';
import type { EventChoice, RuntimeToken, Scope } from './runtime.js';
import type { ScopeTree } from './scopes.js';
import {
  ENGINE_STATE_VERSION,
  type EngineState,
  type IncidentState,
  type MultiTriggerState,
  type ScopeState,
  type TokenState,
} from './state.js';
import type { ExpressionMode } from './expression.js';
import type { TimerScheduler } from './timer-scheduler.js';
import type { EngineMode, ExecutionStatus, HistoryEntry } from './types.js';

/**
 * The live collections an execution is made of. The serializer reads them to
 * produce an {@link EngineState} and writes them back to restore one, which is
 * the only place that knows how the object graph and the plain data map onto
 * each other.
 */
export interface EngineRuntime {
  scopes: ScopeTree;
  timers: TimerScheduler;
  loops: LoopRunner;
  ready: RuntimeToken[];
  waiting: Map<string, RuntimeToken>;
  parallelBuffers: Map<string, Map<string, number>>;
  inclusiveBuffers: Map<string, RuntimeToken[]>;
  eventChoices: Map<string, EventChoice>;
  armedEvents: Map<string, string>;
  firedConditionals: Set<string>;
  multiTriggers: Map<string, Set<string>>;
  compensations: { activityId: string; scopeId: string }[];
  incidents: Map<string, IncidentState>;
  completedNodes: Set<string>;
  history: HistoryEntry[];
}

/** What only the engine itself knows: its identity and its counters. */
export interface EngineMeta {
  processId: string;
  status: ExecutionStatus;
  mode: EngineMode;
  expressions: ExpressionMode;
  maxSteps: number;
  steps: number;
  tokenSeq: number;
  /**
   * Every incident the engine is tracking, including retry bookkeeping for a
   * token that is no longer parked as an incident (e.g. one handed back to a
   * worker for another attempt) — losing that would restart its retry budget
   * on restore. `incidentList()` answers a narrower question: what is holding
   * a token right now.
   */
  openIncidents: IncidentState[];
}

/**
 * Projects a running execution into plain data.
 *
 * Not every token lives in a scope: a suspended subprocess parent, a token
 * repeating an activity and a token buffered at an inclusive join all sit
 * outside one, and `placement` is what tells them apart on the way back.
 */
export function serializeEngine(runtime: EngineRuntime, meta: EngineMeta): EngineState {
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

  for (const scope of runtime.scopes.all()) {
    for (const token of scope.tokens) record(token, 'active');
    // Suspended parents live outside their scope's token set.
    if (scope.parentToken) record(scope.parentToken, 'suspended');
  }
  for (const buffer of runtime.inclusiveBuffers.values()) {
    for (const token of buffer) record(token, 'inclusiveJoin');
  }
  // A token repeating an activity is suspended outside every scope too.
  for (const run of runtime.loops.all()) record(run.parentToken, 'suspended');

  return {
    version: ENGINE_STATE_VERSION,
    processId: meta.processId,
    status: meta.status,
    mode: meta.mode,
    expressions: meta.expressions,
    maxSteps: meta.maxSteps,
    steps: meta.steps,
    variables: runtime.scopes.rootVariables(),
    tokenSeq: meta.tokenSeq,
    scopeSeq: runtime.scopes.seq,
    loopSeq: runtime.loops.seq,
    scopes: runtime.scopes.toState(),
    tokens: [...tokens.values()],
    ready: runtime.ready.map((token) => token.id),
    completedNodes: [...runtime.completedNodes],
    history: [...runtime.history],
    parallelBuffers: [...runtime.parallelBuffers].map(([key, counts]) => ({
      key,
      counts: [...counts],
    })),
    inclusiveBuffers: [...runtime.inclusiveBuffers].map(([key, buffer]) => ({
      key,
      tokenIds: buffer.map((token) => token.id),
    })),
    eventChoices: [...runtime.eventChoices].map(([tokenId, choice]) => ({
      tokenId,
      alternatives: choice.alternatives.map((alt) => ({ ...alt })),
    })),
    armedEvents: [...runtime.armedEvents],
    firedConditionals: [...runtime.firedConditionals],
    multiTriggers: [...runtime.multiTriggers].map(([key, received]): MultiTriggerState => ({
      key,
      received: [...received],
    })),
    timers: runtime.timers.toState(),
    compensations: runtime.compensations.map((entry) => ({ ...entry })),
    incidents: meta.openIncidents.map((incident) => ({ ...incident })),
    loops: runtime.loops.toState(),
  };
}

/** Which graph a stored scope belongs to; only the engine can answer it. */
export type GraphForScope = (stored: ScopeState, scopesById: Map<string, Scope>) => ProcessGraph;

/**
 * Rebuilds the live collections from stored data, in the order the references
 * allow: scopes (parents first, since they come out in creation order), then
 * tokens, then everything that points at a token.
 */
export function hydrateEngine(
  runtime: EngineRuntime,
  state: EngineState,
  graphForScope: GraphForScope,
): void {
  runtime.scopes.seq = state.scopeSeq;
  runtime.loops.seq = state.loopSeq;
  for (const nodeId of state.completedNodes) runtime.completedNodes.add(nodeId);
  runtime.history.push(...state.history);

  const scopesById = new Map<string, Scope>();
  for (const stored of state.scopes) {
    const parentScope = stored.parentScopeId ? scopesById.get(stored.parentScopeId) : undefined;
    const scope: Scope = {
      id: stored.id,
      graph: graphForScope(stored, scopesById),
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
    runtime.scopes.add(scope);
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
    if (token.waiting) runtime.waiting.set(token.id, token);
  }

  for (const stored of state.scopes) {
    if (!stored.parentTokenId) continue;
    const parent = tokensById.get(stored.parentTokenId);
    const scope = scopesById.get(stored.id);
    if (parent && scope) scope.parentToken = parent;
  }

  for (const tokenId of state.ready) {
    const token = tokensById.get(tokenId);
    if (token) runtime.ready.push(token);
  }

  for (const buffer of state.parallelBuffers) {
    runtime.parallelBuffers.set(buffer.key, new Map(buffer.counts));
  }
  for (const buffer of state.inclusiveBuffers) {
    runtime.inclusiveBuffers.set(
      buffer.key,
      buffer.tokenIds
        .map((id) => tokensById.get(id))
        .filter((token): token is RuntimeToken => token !== undefined),
    );
  }
  for (const choice of state.eventChoices) {
    const token = tokensById.get(choice.tokenId);
    if (!token) continue;
    runtime.eventChoices.set(choice.tokenId, {
      token,
      alternatives: choice.alternatives.map((alt) => ({ ...alt })),
    });
  }
  for (const [eventNodeId, tokenId] of state.armedEvents) {
    runtime.armedEvents.set(eventNodeId, tokenId);
  }
  for (const key of state.firedConditionals ?? []) runtime.firedConditionals.add(key);
  for (const entry of state.multiTriggers ?? []) {
    runtime.multiTriggers.set(entry.key, new Set(entry.received));
  }

  runtime.timers.restore(state.timers);
  for (const entry of state.compensations ?? []) runtime.compensations.push({ ...entry });
  for (const incident of state.incidents ?? []) {
    runtime.incidents.set(incident.tokenId, { ...incident });
  }

  runtime.loops.restore(state.loops, scopesById, tokensById);
}
