import { BpmnExecutionError, BpmnValidationError } from '../errors.js';
import type { FlowNode, LoopCharacteristics } from '../model/types.js';
import type { LoopRun, RuntimeToken, Scope } from './runtime.js';
import type { ScopeTree } from './scopes.js';
import type { LoopRunState } from './state.js';
import type { TimerScheduler } from './timer-scheduler.js';

/** Standard loops without `loopMaximum` still need a ceiling. */
const DEFAULT_LOOP_MAXIMUM = 1_000;

/** What repeating an activity needs from the engine that owns the tokens. */
export interface LoopHost {
  evaluate(expression: string, variables: Record<string, unknown>): unknown;
  condition(expression: string, variables: Record<string, unknown>): boolean;
  fail(error: Error): void;
  spawn(scope: Scope, nodeId: string): RuntimeToken;
  discard(token: RuntimeToken): void;
  completeNode(token: RuntimeToken, options?: { history?: boolean }): void;
  leaveViaOutgoing(token: RuntimeToken): void;
  /** The engine's removal, which also forgets what the scope could compensate. */
  removeScope(scope: Scope): void;
  emit(
    event: 'activity.start' | 'activity.end',
    payload: { nodeId: string; tokenId: string },
  ): void;
}

/**
 * Activities that run more than once: multi-instance (parallel or sequential,
 * by collection or cardinality) and the standard loop.
 *
 * Each instance gets its own scope — with `loopCounter`, the element variable
 * and the output variable — while the token that entered the activity stays
 * suspended until the run is over.
 */
export class LoopRunner {
  private readonly runs = new Map<string, LoopRun>();
  private sequence = 0;

  constructor(
    private readonly host: LoopHost,
    private readonly scopes: ScopeTree,
    private readonly timers: TimerScheduler,
  ) {}

  /** Next loop id to hand out; part of the serialized state. */
  get seq(): number {
    return this.sequence;
  }

  set seq(value: number) {
    this.sequence = value;
  }

  get(id: string): LoopRun | undefined {
    return this.runs.get(id);
  }

  all(): LoopRun[] {
    return [...this.runs.values()];
  }

  /** The run repeating `nodeId` in that scope, when there is one. */
  find(nodeId: string, scope: Scope): LoopRun | undefined {
    return this.all().find((run) => run.nodeId === nodeId && run.scope === scope);
  }

  /** Expands an activity marked as multi-instance (or standard loop). */
  start(token: RuntimeToken, node: FlowNode, loop: LoopCharacteristics): void {
    const scope = token.scope;
    const variables = this.scopes.merged(scope);
    let items: unknown[] | undefined;
    let total: number;

    if (loop.kind === 'multiInstance') {
      if (loop.collection) {
        const collection: unknown = this.scopes.read(scope, loop.collection);
        if (!isUnknownArray(collection)) {
          this.host.fail(
            new BpmnExecutionError(
              `Multi-instance collection "${loop.collection}" of ${node.id} is not an array.`,
            ),
          );
          return;
        }
        items = [...collection];
        total = items.length;
      } else if (loop.cardinality) {
        const value = Number(this.host.evaluate(loop.cardinality, variables));
        if (!Number.isFinite(value) || value < 0) {
          this.host.fail(
            new BpmnExecutionError(`Multi-instance cardinality of ${node.id} is not a number.`),
          );
          return;
        }
        total = Math.floor(value);
      } else {
        this.host.fail(
          new BpmnExecutionError(
            `Multi-instance activity ${node.id} needs a cardinality or a collection.`,
          ),
        );
        return;
      }
    } else {
      total = loop.maximum ?? DEFAULT_LOOP_MAXIMUM;
      // `testBefore` means the condition guards the very first iteration too.
      if (
        loop.testBefore &&
        loop.loopCondition &&
        !this.host.condition(loop.loopCondition, variables)
      ) {
        total = 0;
      }
    }

    if (total === 0) {
      // Zero instances: the activity is simply skipped, per the specification.
      this.host.completeNode(token);
      this.host.leaveViaOutgoing(token);
      return;
    }

    scope.tokens.delete(token); // suspend until every instance is done
    this.timers.armBoundaries(token);
    const run: LoopRun = {
      id: `loop-${this.sequence++}`,
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
    this.runs.set(run.id, run);
    if (loop.outputCollection) this.scopes.write(scope, loop.outputCollection, []);
    this.host.emit('activity.start', { nodeId: node.id, tokenId: token.id });

    if (loop.sequential) {
      this.startInstance(run);
      return;
    }
    for (let index = 0; index < total; index++) this.startInstance(run);
  }

  /** Creates one instance scope (with its own item/counter) and its token. */
  private startInstance(run: LoopRun): void {
    const index = run.started++;
    const variables: Record<string, unknown> = { loopCounter: index };
    if (run.loop.elementVariable && run.items) {
      variables[run.loop.elementVariable] = run.items[index];
    }
    // Declaring the output variable locally keeps each instance's result inside
    // its own scope, so a handler can just `set` it and the loop collects it.
    if (run.loop.outputElement) variables[run.loop.outputElement] = undefined;
    const scope = this.scopes.add({
      id: this.scopes.nextId(),
      graph: run.scope.graph,
      parentScope: run.scope,
      parentScopeId: run.scope.id,
      hostNodeId: run.nodeId,
      loopId: run.id,
      loopIndex: index,
      variables,
      tokens: new Set(),
    });
    run.instanceScopes.add(scope);
    const token = this.host.spawn(scope, run.nodeId);
    token.loopInstanceOf = run.id;
  }

  /** One instance reached the end of the activity. */
  finishInstance(token: RuntimeToken): void {
    const run = token.loopInstanceOf ? this.runs.get(token.loopInstanceOf) : undefined;
    const scope = token.scope;
    this.host.discard(token);
    if (!run) return;

    this.collectOutput(run, scope);
    run.instanceScopes.delete(scope);
    this.host.removeScope(scope);
    run.completed++;

    const variables = this.scopes.merged(run.scope);
    if (run.loop.kind === 'multiInstance') {
      if (
        run.loop.completionCondition &&
        this.host.condition(run.loop.completionCondition, variables)
      ) {
        return this.finish(run);
      }
      if (run.loop.sequential) {
        if (run.started < run.total) return this.startInstance(run);
        return this.finish(run);
      }
      if (run.completed >= run.total) this.finish(run);
      return;
    }

    const repeat =
      run.started < run.total &&
      (!run.loop.loopCondition || this.host.condition(run.loop.loopCondition, variables));
    if (repeat) this.startInstance(run);
    else this.finish(run);
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
  private collectOutput(run: LoopRun, instanceScope: Scope): void {
    const { outputCollection, outputElement } = run.loop;
    if (!outputCollection || !outputElement) return;
    if (!isUnknownArray(this.scopes.read(run.scope, outputCollection))) return;
    run.results.push({
      index: instanceScope.loopIndex ?? run.results.length,
      value: this.scopes.read(instanceScope, outputElement),
    });
    const ordered = [...run.results].sort((a, b) => a.index - b.index);
    this.scopes.write(
      run.scope,
      outputCollection,
      ordered.map((result) => result.value),
    );
  }

  /** Every instance is done (or was cancelled): the activity itself completes. */
  private finish(run: LoopRun): void {
    this.clear(run);

    const parent = run.parentToken;
    parent.scope.tokens.add(parent);
    this.host.emit('activity.end', { nodeId: run.nodeId, tokenId: parent.id });
    this.host.completeNode(parent, { history: false });
    this.host.leaveViaOutgoing(parent);
  }

  /** Discards every instance of a repeated activity and forgets the run. */
  cancel(run: LoopRun): void {
    this.clear(run);
  }

  /** Cancels every repeated activity living in the given scope. */
  cancelIn(scope: Scope): void {
    for (const run of this.all()) {
      if (run.scope !== scope) continue;
      this.cancel(run);
      this.host.discard(run.parentToken);
    }
  }

  private clear(run: LoopRun): void {
    this.runs.delete(run.id);
    for (const scope of [...run.instanceScopes]) {
      for (const token of [...scope.tokens]) this.host.discard(token);
      this.host.removeScope(scope);
    }
    run.instanceScopes.clear();
  }

  toState(): LoopRunState[] {
    return this.all().map((run) => ({
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
    }));
  }

  restore(
    states: LoopRunState[],
    scopesById: Map<string, Scope>,
    tokensById: Map<string, RuntimeToken>,
  ): void {
    for (const stored of states) {
      const scope = scopesById.get(stored.scopeId);
      const parentToken = tokensById.get(stored.parentTokenId);
      const loop = scope?.graph.node(stored.nodeId)?.loop;
      if (!scope || !parentToken || !loop) {
        throw new BpmnValidationError(`Cannot restore loop ${stored.id} on node ${stored.nodeId}.`);
      }
      this.runs.set(stored.id, {
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
}

/** `Array.isArray` narrows to `any[]`; the engine never wants `any`. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}
