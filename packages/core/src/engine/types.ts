import type { ElementKind } from '../model/kinds.js';
import type { ProcessModel } from '../model/types.js';
import type { ExpressionMode } from './expression.js';

export type ExecutionStatus =
  'idle' | 'running' | 'waiting' | 'completed' | 'terminated' | 'failed';

/** Why a token is parked, so callers know how to resume it. */
export type WaitReason =
  | 'userTask'
  | 'receiveTask'
  | 'catchEvent'
  | 'eventBasedGateway'
  | 'boundary'
  /** The activity's handler failed and the execution is holding, not dead. */
  | 'incident';

export interface TokenSnapshot {
  id: string;
  nodeId: string;
  nodeKind: ElementKind;
  scopeId: string;
  waiting: boolean;
  waitReason?: WaitReason;
}

/**
 * A unit of work waiting for someone (or something) outside the engine: a user
 * task, a receive task or a catch event.
 */
export interface PendingTask {
  tokenId: string;
  nodeId: string;
  nodeKind: ElementKind;
  name?: string;
  reason: WaitReason;
  scopeId: string;
  /** Lane the activity sits in, when the diagram declares swimlanes. */
  lane?: string;
  /** Roles/people from `bpmn:potentialOwner`. Empty means anyone. */
  candidates: string[];
  /** Variables visible to the activity (its scope chain, flattened). */
  variables: Record<string, unknown>;
}

/** Narrows a task list. An omitted field does not filter. */
export interface TaskFilter {
  /** Keeps tasks whose lane or candidate roles include this name. */
  role?: string;
  /** Keeps tasks parked for these reasons. */
  reason?: WaitReason | WaitReason[];
  /** Keeps tasks on this activity. */
  nodeId?: string;
}

export interface HistoryEntry {
  nodeId: string;
  nodeKind: ElementKind;
  event: 'enter' | 'complete';
  /** Epoch milliseconds, from the engine clock (`options.now`). */
  at: number;
  /** Position in the history, so entries stay ordered even at equal times. */
  seq: number;
}

/** How much time a process spent on one activity. */
export interface ActivityMetrics {
  nodeId: string;
  nodeKind: ElementKind;
  name?: string;
  /** Times the node was entered. */
  started: number;
  /** Times it completed. */
  completed: number;
  /** Sum of enter→complete durations, in milliseconds. */
  totalMs: number;
  averageMs: number;
  maxMs: number;
}

export interface ExecutionSnapshot {
  status: ExecutionStatus;
  variables: Record<string, unknown>;
  tokens: TokenSnapshot[];
  /** Distinct node ids that have completed at least once. */
  completedNodes: string[];
  history: HistoryEntry[];
}

/**
 * `automation`: wait states (user/receive tasks, catch events) pause until the
 * caller resumes them; unhandled service-like tasks pass through.
 * `auto`: every wait state resolves immediately, useful to simulate/animate a
 * run without providing handlers or external triggers.
 */
export type EngineMode = 'automation' | 'auto';

/** One outgoing flow offered to a {@link DecisionHandler}. */
export interface GatewayOption {
  flowId: string;
  targetId: string;
  name?: string;
  condition?: string;
  isDefault: boolean;
}

/** A branching gateway, handed to the caller so a person can decide instead. */
export interface GatewayDecision {
  nodeId: string;
  nodeKind: ElementKind;
  name?: string;
  /** Outgoing flows, in document order. */
  options: GatewayOption[];
  /** Flow ids the conditions would take on their own. */
  suggested: string[];
  /** Variables visible at the gateway. */
  variables: Record<string, unknown>;
}

/**
 * Decides which flow(s) leave a gateway, overriding the conditions.
 *
 * Returning `undefined` (or an id the gateway does not have) keeps the
 * engine's own decision, so the hook can answer some gateways and let the data
 * answer the rest. An exclusive gateway takes the first id returned; an
 * inclusive one takes all of them.
 */
export type DecisionHandler = (
  decision: GatewayDecision,
) => string | string[] | undefined | Promise<string | string[] | undefined>;

export interface EngineOptions {
  mode?: EngineMode;
  /**
   * Asked before an exclusive/inclusive gateway routes a token, so a person (or
   * another system) can choose the branch. Absent by default: gateways decide
   * from the data, as the specification says.
   */
  decide?: DecisionHandler;
  /**
   * Clock used to schedule timer events. Defaults to `Date.now`; inject a fake
   * one to test timers without waiting.
   */
  now?: () => number;
  /** Guards against infinite loops; caps node transitions per drain. */
  maxSteps?: number;
  /**
   * How flow conditions and other expressions of the diagram are evaluated.
   * `safe` (default) interprets a JavaScript subset with allowlisted globals;
   * `javascript` compiles the expression with `new Function` and therefore
   * trusts the definition as much as the surrounding code — only for diagrams
   * you author yourself.
   */
  expressions?: ExpressionMode;
  /** Initial process variables. */
  variables?: Record<string, unknown>;
  /**
   * Other processes of the same definitions, so a `callActivity` can execute
   * the process it references. Usually `model.processes`.
   */
  processes?: ProcessModel[];
  /**
   * What to do when an activity handler throws something other than a
   * {@link BpmnError}: `fail` (default) stops the whole execution, `incident`
   * parks the token so an operator can retry it.
   */
  onHandlerError?: 'fail' | 'incident';
  /** Automatic retries before giving up on a failing handler. */
  retry?: {
    /** Extra attempts after the first failure. Defaults to 0. */
    attempts?: number;
    /** ISO-8601 wait between attempts (e.g. `PT30S`). Immediate when absent. */
    delay?: string;
  };
}

export interface EngineEvents extends Record<string, unknown> {
  'process.start': { processId: string };
  'process.end': { processId: string; status: ExecutionStatus };
  'node.enter': { nodeId: string; nodeKind: ElementKind; tokenId: string };
  'node.leave': { nodeId: string; nodeKind: ElementKind; tokenId: string };
  'activity.start': { nodeId: string; tokenId: string };
  'activity.end': { nodeId: string; tokenId: string };
  'flow.take': { flowId: string; sourceId: string; targetId: string; tokenId: string };
  wait: { nodeId: string; tokenId: string; reason: WaitReason };
  error: { nodeId?: string; error: Error };
}
