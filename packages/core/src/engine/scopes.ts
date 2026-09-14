import type { ProcessGraph } from '../model/graph.js';
import type { RuntimeToken, Scope } from './runtime.js';
import type { ScopeState } from './state.js';

/**
 * The scope tree of a running execution, and the variable resolution that
 * comes with it.
 *
 * A process, each subprocess and each instance of a multi-instance activity
 * form a chain: reading a variable walks it outwards (innermost wins) and
 * writing lands on the scope that already defines it. Keeping both the tree
 * and that rule here is what makes "process variable" mean one thing.
 */
export class ScopeTree {
  private readonly scopes: Scope[] = [];
  private sequence = 0;

  /**
   * @param fallbackVariables where a write lands before the root scope exists
   * (the engine's initial variables).
   */
  constructor(private readonly fallbackVariables: Record<string, unknown>) {}

  /** The live list, in creation order. The engine reads it; only this class mutates it. */
  all(): Scope[] {
    return this.scopes;
  }

  /** The process scope. Absent until the execution starts. */
  get root(): Scope | undefined {
    return this.scopes[0];
  }

  /** Next scope id to hand out; part of the serialized state. */
  get seq(): number {
    return this.sequence;
  }

  set seq(value: number) {
    this.sequence = value;
  }

  byId(id: string): Scope | undefined {
    return this.scopes.find((scope) => scope.id === id);
  }

  /** A new scope under `parentToken`'s scope, or the root when there is none. */
  create(graph: ProcessGraph, parentToken?: RuntimeToken, hostNodeId?: string): Scope {
    const scope: Scope = {
      id: this.nextId(),
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

  /** Id for a scope this class did not build (a loop instance, a restore). */
  nextId(): string {
    return `scope-${this.sequence++}`;
  }

  /** Adds a scope built elsewhere, keeping creation order. */
  add(scope: Scope): Scope {
    this.scopes.push(scope);
    return scope;
  }

  remove(scope: Scope): void {
    const index = this.scopes.indexOf(scope);
    if (index >= 0) this.scopes.splice(index, 1);
  }

  /**
   * Reads a variable walking the scope chain outwards: the innermost scope that
   * defines it wins, so a multi-instance item shadows a process variable.
   */
  read(scope: Scope | undefined, name: string): unknown {
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
  write(scope: Scope | undefined, name: string, value: unknown): void {
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
    const target = outermost ?? this.root;
    if (target) target.variables[name] = value;
    else this.fallbackVariables[name] = value;
  }

  assign(scope: Scope | undefined, values: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(values)) this.write(scope, name, value);
  }

  /** Flattened view of the scope chain, innermost value winning. */
  merged(scope: Scope | undefined): Record<string, unknown> {
    const chain: Scope[] = [];
    for (let current = scope; current; current = current.parentScope) chain.unshift(current);
    return Object.assign({}, ...chain.map((s) => s.variables)) as Record<string, unknown>;
  }

  /** The process variables, as a caller sees them. */
  rootVariables(): Record<string, unknown> {
    return { ...(this.root?.variables ?? this.fallbackVariables) };
  }

  /**
   * Live view handed to handlers: reads resolve through the scope chain and
   * writes go where {@link write} decides, so `ctx.variables.x = 1` keeps
   * working as documented.
   */
  proxy(scope: Scope): Record<string, unknown> {
    return new Proxy(
      {},
      {
        get: (_target, key): unknown =>
          typeof key === 'string' ? this.read(scope, key) : undefined,
        set: (_target, key, value) => {
          if (typeof key === 'string') this.write(scope, key, value);
          return true;
        },
        has: (_target, key) => typeof key === 'string' && this.read(scope, key) !== undefined,
        ownKeys: () => Object.keys(this.merged(scope)),
        getOwnPropertyDescriptor: (_target, key) => ({
          value: typeof key === 'string' ? this.read(scope, key) : undefined,
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
    );
  }

  /** The serializable projection of the whole tree. */
  toState(): ScopeState[] {
    return this.scopes.map((scope) => ({
      id: scope.id,
      ...(scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {}),
      ...(scope.hostNodeId ? { hostNodeId: scope.hostNodeId } : {}),
      ...(scope.parentToken ? { parentTokenId: scope.parentToken.id } : {}),
      ...(scope.loopId ? { loopId: scope.loopId } : {}),
      ...(scope.loopIndex !== undefined ? { loopIndex: scope.loopIndex } : {}),
      ...(scope.isolated ? { isolated: true } : {}),
      ...(scope.adHocPending ? { adHocPending: [...scope.adHocPending] } : {}),
      variables: { ...scope.variables },
    }));
  }
}
