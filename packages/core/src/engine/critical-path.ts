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
 * path from a start reaches an end event at all. Acyclic portions are solved
 * with memoized dynamic programming; cyclic back-edges are ignored during the
 * current recursion branch so loops stay bounded.
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

  const memo = new Map<string, CriticalPathResult | undefined>();
  const visiting = new Set<string>();

  const longestFrom = (nodeId: string): CriticalPathResult | undefined => {
    if (memo.has(nodeId)) return memo.get(nodeId);
    if (visiting.has(nodeId)) return undefined;
    const node = nodes.get(nodeId);
    if (!node) return undefined;

    visiting.add(nodeId);
    const selfWeight = weightOf.get(nodeId) ?? 0;
    let best: CriticalPathResult | undefined;

    if (node.kind === 'endEvent') {
      best = { path: [nodeId], totalMs: selfWeight };
    } else {
      for (const flowId of node.outgoing) {
        const flow = flows.get(flowId);
        if (!flow) continue;
        const tail = longestFrom(flow.targetRef);
        if (!tail) continue;

        const candidate: CriticalPathResult = {
          path: [nodeId, ...tail.path],
          totalMs: selfWeight + tail.totalMs,
        };
        if (!best || candidate.totalMs > best.totalMs) best = candidate;
      }
    }

    visiting.delete(nodeId);
    memo.set(nodeId, best);
    return best;
  };

  let best: CriticalPathResult | undefined;
  for (const start of starts) {
    const candidate = longestFrom(start.id);
    if (candidate && (!best || candidate.totalMs > best.totalMs)) best = candidate;
  }
  return best;
}
