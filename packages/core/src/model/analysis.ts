import type { ElementKind } from './kinds.js';
import type { FlowNode, ProcessModel, SequenceFlow } from './types.js';

/**
 * Structural analysis of a process graph: problems a diagram can carry that
 * only show up once a token actually runs into them — or never show up,
 * because the token gets stuck first.
 *
 * Everything here reads the model, never runs it. It complements
 * `decisionsAfter` (what a running token faces next) by looking at the whole
 * graph ahead of time, so a modeling tool can flag a broken diagram before
 * anyone executes it.
 */

export type StaticAnalysisIssueKind =
  'unreachable' | 'cycle-without-exit' | 'parallel-join-deadlock' | 'gateway-without-default';

export interface StaticAnalysisIssue {
  kind: StaticAnalysisIssueKind;
  severity: 'error' | 'warning';
  message: string;
  nodeId: string;
  /** Every node in the trap, in document order — only on `'cycle-without-exit'`. */
  cycle?: string[];
  /**
   * The upstream gateway that starves the join — only on
   * `'parallel-join-deadlock'`.
   */
  causeNodeId?: string;
}

/** Gateways that route a token down only one (or some) of their branches. */
const PARTIAL_SPLIT_KINDS = new Set<ElementKind>([
  'exclusiveGateway',
  'inclusiveGateway',
  'eventBasedGateway',
]);

/**
 * Every structural problem found in `process` and its nested subprocesses:
 * dead paths, loops with no way out, parallel joins starved by an upstream
 * split that cannot feed all their branches, and exclusive gateways one
 * missing condition away from failing the execution.
 */
export function analyzeProcess(process: ProcessModel): StaticAnalysisIssue[] {
  const issues: StaticAnalysisIssue[] = [];
  findUnreachable(process, issues);
  findTrappedCycles(process, issues);
  findUncoveredExclusiveGateways(process, issues);
  findParallelJoinDeadlocks(process, issues);
  for (const node of process.flowNodes) {
    if (node.process) issues.push(...analyzeProcess(node.process));
  }
  return issues;
}

/**
 * Nodes no token can ever reach by following sequence flows (and boundary
 * events, reached through their host) from a start event of this scope.
 *
 * Skipped when the scope has no start event of its own — an ad-hoc
 * subprocess with no explicit ordering has nothing to be "reachable" from.
 */
function findUnreachable(process: ProcessModel, issues: StaticAnalysisIssue[]): void {
  const starts = process.flowNodes.filter(
    (n) => n.kind === 'startEvent' && n.incoming.length === 0,
  );
  if (starts.length === 0) return;

  const nodes = new Map(process.flowNodes.map((n) => [n.id, n]));
  const flows = new Map(process.sequenceFlows.map((f) => [f.id, f]));
  const boundaryByHost = new Map<string, FlowNode[]>();
  for (const node of process.flowNodes) {
    if (node.kind !== 'boundaryEvent' || !node.attachedToRef) continue;
    const list = boundaryByHost.get(node.attachedToRef) ?? [];
    list.push(node);
    boundaryByHost.set(node.attachedToRef, list);
  }

  const reachable = new Set<string>();
  const queue = starts.map((n) => n.id);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    for (const flowId of node.outgoing) {
      const flow = flows.get(flowId);
      if (flow) queue.push(flow.targetRef);
    }
    for (const boundary of boundaryByHost.get(id) ?? []) queue.push(boundary.id);
  }

  for (const node of process.flowNodes) {
    if (reachable.has(node.id)) continue;
    issues.push({
      kind: 'unreachable',
      severity: 'warning',
      nodeId: node.id,
      message: `"${node.name ?? node.id}" is not reachable from any start event.`,
    });
  }
}

/**
 * Exclusive gateways where every outgoing flow carries a condition and none
 * is marked default: the engine fails outright the moment none of them
 * evaluates true, since nothing is left to fall back to.
 *
 * A flow with no condition at all is not flagged — the engine already treats
 * the first one it meets as an implicit catch-all, so it never runs dry (see
 * `firstMatching` in the engine).
 */
function findUncoveredExclusiveGateways(
  process: ProcessModel,
  issues: StaticAnalysisIssue[],
): void {
  const flows = new Map(process.sequenceFlows.map((f) => [f.id, f]));
  for (const node of process.flowNodes) {
    if (node.kind !== 'exclusiveGateway') continue;
    const outgoing = node.outgoing
      .map((id) => flows.get(id))
      .filter((f): f is SequenceFlow => f !== undefined);
    if (outgoing.length < 2) continue;

    const hasDefault = outgoing.some((f) => f.isDefault === true || f.id === node.default);
    if (hasDefault) continue;
    if (!outgoing.every((f) => f.conditionExpression)) continue;

    issues.push({
      kind: 'gateway-without-default',
      severity: 'warning',
      nodeId: node.id,
      message:
        `"${node.name ?? node.id}" has no default flow and every outgoing flow is conditional: ` +
        'if none of the conditions match at runtime, the execution fails with no valid outgoing flow.',
    });
  }
}

/**
 * Parallel-gateway joins fed by an upstream split that cannot activate all of
 * their incoming branches at once — an exclusive, inclusive or event-based
 * gateway sitting above two or more of the join's incoming flows. The join
 * waits for a token on every incoming flow; that split only ever sends the
 * token down one (or some) of them, so the join can never complete.
 */
function findParallelJoinDeadlocks(process: ProcessModel, issues: StaticAnalysisIssue[]): void {
  const nodes = new Map(process.flowNodes.map((n) => [n.id, n]));
  const flows = new Map(process.sequenceFlows.map((f) => [f.id, f]));
  const predecessorsOf = new Map<string, string[]>();
  for (const flow of process.sequenceFlows) {
    const list = predecessorsOf.get(flow.targetRef) ?? [];
    list.push(flow.sourceRef);
    predecessorsOf.set(flow.targetRef, list);
  }

  /** Ancestor split gateways (out-degree > 1) reachable backward from `nodeId`. */
  const ancestorSplits = (nodeId: string): Set<string> => {
    const splits = new Set<string>();
    const visited = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = nodes.get(id);
      if (node && node.outgoing.length > 1) splits.add(id);
      for (const predecessor of predecessorsOf.get(id) ?? []) queue.push(predecessor);
    }
    return splits;
  };

  for (const join of process.flowNodes) {
    if (join.kind !== 'parallelGateway' || join.incoming.length < 2) continue;
    const branches = join.incoming
      .map((flowId) => flows.get(flowId)?.sourceRef)
      .filter((id): id is string => id !== undefined);

    const sharedBy = new Map<string, number>();
    for (const branch of branches) {
      for (const splitId of ancestorSplits(branch)) {
        sharedBy.set(splitId, (sharedBy.get(splitId) ?? 0) + 1);
      }
    }

    for (const [splitId, branchCount] of sharedBy) {
      if (branchCount < 2) continue;
      const split = nodes.get(splitId);
      if (!split || !PARTIAL_SPLIT_KINDS.has(split.kind)) continue;
      issues.push({
        kind: 'parallel-join-deadlock',
        severity: 'error',
        nodeId: join.id,
        causeNodeId: splitId,
        message:
          `"${join.name ?? join.id}" waits for a token on every incoming flow, but ` +
          `"${split.name ?? splitId}" only ever sends the token down one of the branches ` +
          'feeding it: the join can never complete.',
      });
    }
  }
}

/**
 * Loops the token can enter but never leave: a strongly connected component
 * of the flow graph with no flow leading outside of it. A cycle with a real
 * exit (a gateway condition, an extra outgoing flow) is not flagged — only
 * one where every path out loops back in.
 */
function findTrappedCycles(process: ProcessModel, issues: StaticAnalysisIssue[]): void {
  const flows = new Map(process.sequenceFlows.map((f) => [f.id, f]));
  const adjacency = new Map<string, string[]>();
  for (const node of process.flowNodes) {
    adjacency.set(
      node.id,
      node.outgoing
        .map((id) => flows.get(id)?.targetRef)
        .filter((t): t is string => t !== undefined),
    );
  }

  for (const component of stronglyConnectedComponents(
    process.flowNodes.map((n) => n.id),
    adjacency,
  )) {
    const members = new Set(component);
    const isCycle =
      component.length > 1 || (adjacency.get(component[0]!) ?? []).includes(component[0]!);
    if (!isCycle) continue;
    const trapped = component.every((id) =>
      (adjacency.get(id) ?? []).every((target) => members.has(target)),
    );
    if (!trapped) continue;

    // Keep the diagram's own order instead of the algorithm's traversal order.
    const ordered = process.flowNodes.map((n) => n.id).filter((id) => members.has(id));
    issues.push({
      kind: 'cycle-without-exit',
      severity: 'error',
      nodeId: ordered[0]!,
      cycle: ordered,
      message: `A cycle among ${ordered.map((id) => `"${id}"`).join(', ')} has no flow leaving it: a token entering it never progresses past it.`,
    });
  }
}

/** Tarjan's strongly connected components over an adjacency list. */
function stronglyConnectedComponents(
  nodeIds: string[],
  adjacency: Map<string, string[]>,
): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  const strongConnect = (v: string): void => {
    indices.set(v, index);
    lowlink.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      result.push(component);
    }
  };

  for (const id of nodeIds) {
    if (!indices.has(id)) strongConnect(id);
  }
  return result;
}
