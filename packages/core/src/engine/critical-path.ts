import type { ProcessModel } from '../model/types.js';
import type { ActivityMetrics } from './types.js';

export interface CriticalPathResult {
  /** Node ids from a start event to an end event, in traversal order. */
  path: string[];
  /** Sum of average durations along the path, in milliseconds. */
  totalMs: number;
}

/**
 * The path through the process most likely to be the bottleneck: from a start
 * event to an end event, weighing each activity by its average duration from
 * {@link ActivityMetrics} (typically `engine.metrics()`, aggregated across
 * however many past executions the caller wants to account for).
 *
 * Undefined when the metrics do not name it (weighed as zero) and when no
 * path from a start reaches an end event at all. A loop is walked at most
 * once per path — revisiting a node ends that branch there — so a process
 * with cycles still gets a longest *simple* path instead of an unbounded one.
 */
export function criticalPath(
  process: ProcessModel,
  metrics: ActivityMetrics[],
): CriticalPathResult | undefined {
  const weightOf = new Map(metrics.map((m) => [m.nodeId, m.averageMs]));
  const nodes = new Map(process.flowNodes.map((n) => [n.id, n]));
  const flows = new Map(process.sequenceFlows.map((f) => [f.id, f]));
  const starts = process.flowNodes.filter(
    (n) => n.kind === 'startEvent' && n.incoming.length === 0,
  );

  let best: CriticalPathResult | undefined;

  const walk = (nodeId: string, path: string[], visited: Set<string>, totalMs: number): void => {
    const node = nodes.get(nodeId);
    if (!node) return;
    const nextPath = [...path, nodeId];
    const nextTotal = totalMs + (weightOf.get(nodeId) ?? 0);

    if (node.kind === 'endEvent') {
      if (!best || nextTotal > best.totalMs) best = { path: nextPath, totalMs: nextTotal };
      return;
    }
    for (const flowId of node.outgoing) {
      const flow = flows.get(flowId);
      if (!flow || visited.has(flow.targetRef)) continue;
      walk(flow.targetRef, nextPath, new Set(visited).add(flow.targetRef), nextTotal);
    }
  };

  for (const start of starts) walk(start.id, [], new Set([start.id]), 0);
  return best;
}
