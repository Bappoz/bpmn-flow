import type { ProcessGraph } from '../model/graph.js';
import type { LoopCharacteristics } from '../model/types.js';
import type { WaitReason } from './types.js';

/**
 * The live shapes an execution is made of, shared by the engine and its
 * collaborators. They are deliberately plain: everything durable about them is
 * projected into {@link EngineState} instead of being persisted directly.
 */

export interface Scope {
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

export interface RuntimeToken {
  id: string;
  nodeId: string;
  scope: Scope;
  viaFlowId?: string;
  waiting?: WaitReason;
  /** Set on the token running one instance of a loop activity. */
  loopInstanceOf?: string;
}

/** Bookkeeping for an activity being repeated (multi-instance or loop). */
export interface LoopRun {
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

/** An event-based gateway waiting for whichever alternative fires first. */
export interface EventChoice {
  token: RuntimeToken;
  alternatives: { eventNodeId: string; flowId: string }[];
}
