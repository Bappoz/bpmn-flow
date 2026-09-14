import type { EventDefinitionKind } from '../model/kinds.js';
import type { EventDetail, FlowNode } from '../model/types.js';

/** Every event definition declared on a node, `event` as the fallback. */
export function detailsOf(node: FlowNode): EventDetail[] {
  return node.events ?? (node.event ? [node.event] : []);
}

/** A trigger matches a node by its id, its message, or any event reference. */
export function matchesTrigger(node: FlowNode, nameOrId: string): boolean {
  return (
    node.id === nameOrId ||
    node.messageRef === nameOrId ||
    detailsOf(node).some((detail) => detail.reference === nameOrId)
  );
}

/** First definition of a given kind, when the node declares one. */
export function detailOfKind(node: FlowNode, kind: EventDefinitionKind): EventDetail | undefined {
  return detailsOf(node).find((detail) => detail.kind === kind);
}

/**
 * The trigger keys a `parallelMultiple` event waits for: one per declared
 * definition. A definition without a reference (a timer, a conditional) is
 * identified by its kind, which is as far apart as two of them can be told.
 */
export function requiredTriggerKeys(node: FlowNode): string[] {
  return [...new Set(detailsOf(node).map((detail) => detail.reference ?? detail.kind))];
}

/** Which of the node's declared triggers a delivered name satisfies. */
export function triggerKeyFor(node: FlowNode, nameOrId: string): string {
  const detail = detailsOf(node).find((candidate) => candidate.reference === nameOrId);
  return detail ? (detail.reference ?? detail.kind) : nameOrId;
}
