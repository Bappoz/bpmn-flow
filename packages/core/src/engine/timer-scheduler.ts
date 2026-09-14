import type { FlowNode } from '../model/types.js';
import type { RuntimeToken } from './runtime.js';
import type { TimerState } from './state.js';
import { parseTimerCycle, resolveTimerDueAt } from './timers.js';
import { detailOfKind } from './triggers.js';

/** Timers are unique per (token, timer node) pair. */
export function timerKey(tokenId: string, nodeId: string): string {
  return `${tokenId}:${nodeId}`;
}

/**
 * The timers an execution is waiting on: which ones are armed, when each falls
 * due, and how a cycle rearms itself.
 *
 * It only schedules. What a due timer *does* — resolving a catch event,
 * firing a boundary — belongs to the engine, because it moves tokens.
 */
export class TimerScheduler {
  private readonly timers = new Map<string, TimerState>();

  constructor(private readonly now: () => number) {}

  /**
   * Arms the timers a parked token is subject to: the timer catch event it sits
   * on, plus any timer boundary event attached to the activity.
   */
  armFor(token: RuntimeToken): void {
    const node = token.scope.graph.node(token.nodeId);
    if (!node) return;
    const timer = detailOfKind(node, 'timer');
    if (timer && node.kind !== 'boundaryEvent') {
      this.arm(token, node, 'catch', timer.timer);
    }
    // A boundary event belongs to the activity as a whole, so a multi-instance
    // activity arms it once (when the loop starts), not once per instance.
    if (!token.loopInstanceOf) this.armBoundaries(token);
  }

  /** Arms timer boundary events attached to the activity the token sits on. */
  armBoundaries(token: RuntimeToken): void {
    for (const boundary of token.scope.graph.boundaryEvents(token.nodeId)) {
      const timer = detailOfKind(boundary, 'timer');
      if (!timer) continue;
      this.arm(token, boundary, 'boundary', timer.timer);
    }
  }

  arm(
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

  /** Schedules the next firing of a repeating timer, if any is left. */
  rearmCycle(entry: TimerState, node: FlowNode): void {
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

  /** Disarms everything waiting on a token that is going away. */
  clearFor(tokenId: string): void {
    for (const [key, entry] of this.timers) {
      if (entry.tokenId === tokenId) this.timers.delete(key);
    }
  }

  /** Whether this exact (token, node) timer is still armed. */
  has(entry: TimerState): boolean {
    return this.timers.has(timerKey(entry.tokenId, entry.nodeId));
  }

  /** Removes one timer, as the engine does when it fires it. */
  take(entry: TimerState): void {
    this.timers.delete(timerKey(entry.tokenId, entry.nodeId));
  }

  /** Armed timers, earliest first. */
  due(): TimerState[] {
    return [...this.timers.values()].sort((a, b) => a.dueAt - b.dueAt);
  }

  /** Earliest due date among the armed timers and the dates given. */
  nextAt(...alsoDue: number[]): number | undefined {
    const due = [...[...this.timers.values()].map((timer) => timer.dueAt), ...alsoDue];
    return due.length > 0 ? Math.min(...due) : undefined;
  }

  toState(): TimerState[] {
    return [...this.timers.values()].map((timer) => ({ ...timer }));
  }

  restore(timers: TimerState[]): void {
    for (const timer of timers)
      this.timers.set(timerKey(timer.tokenId, timer.nodeId), { ...timer });
  }
}
