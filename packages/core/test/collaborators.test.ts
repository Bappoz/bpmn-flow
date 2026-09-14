import { describe, expect, it } from 'vitest';
import { ProcessGraph, parseBpmn } from '../src/index.js';
import type { ProcessModel } from '../src/index.js';
import { ScopeTree } from '../src/engine/scopes.js';
import { TimerScheduler } from '../src/engine/timer-scheduler.js';
import type { RuntimeToken, Scope } from '../src/engine/runtime.js';
import { TIMER_BOUNDARY, TIMER_CATCH } from './fixtures.js';

/**
 * The collaborators extracted from WorkflowEngine are exercised here without
 * an engine at all — which is the point of having extracted them.
 */

async function graph(xml: string): Promise<ProcessGraph> {
  const process: ProcessModel = (await parseBpmn(xml)).processes[0]!;
  return new ProcessGraph(process);
}

function tokenIn(scope: Scope, nodeId: string, id = 't0'): RuntimeToken {
  const token: RuntimeToken = { id, nodeId, scope };
  scope.tokens.add(token);
  return token;
}

describe('ScopeTree', () => {
  it('resolves a variable from the innermost scope that defines it', async () => {
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    root.variables.valor = 10;
    const child = tree.create(root.graph, tokenIn(root, 'Start'));
    child.variables.valor = 99;

    expect(tree.read(child, 'valor')).toBe(99);
    expect(tree.read(root, 'valor')).toBe(10);
    expect(tree.read(child, 'inexistente')).toBeUndefined();
  });

  it('writes to the scope that already defines the variable', async () => {
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    root.variables.valor = 10;
    const child = tree.create(root.graph, tokenIn(root, 'Start'));

    tree.write(child, 'valor', 42);
    expect(root.variables.valor).toBe(42);
    expect(Object.hasOwn(child.variables, 'valor')).toBe(false);
  });

  it('sends a brand new variable to the process scope', async () => {
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    const child = tree.create(root.graph, tokenIn(root, 'Start'));

    tree.write(child, 'novo', 1);
    expect(root.variables.novo).toBe(1);
  });

  it('keeps an isolated scope from writing into the caller', async () => {
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    const isolated = tree.create(root.graph, tokenIn(root, 'Start'));
    delete isolated.parentScope; // what a data-mapped call activity looks like
    isolated.isolated = true;

    tree.write(isolated, 'interno', 1);
    expect(isolated.variables.interno).toBe(1);
    expect(root.variables.interno).toBeUndefined();
  });

  it('falls back to the engine variables before the root scope exists', () => {
    const initial: Record<string, unknown> = {};
    const tree = new ScopeTree(initial);
    tree.write(undefined, 'antes', 1);
    expect(initial.antes).toBe(1);
    expect(tree.rootVariables()).toEqual({ antes: 1 });
  });

  it('flattens the chain innermost first', async () => {
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    root.variables.a = 1;
    root.variables.b = 1;
    const child = tree.create(root.graph, tokenIn(root, 'Start'));
    child.variables.b = 2;

    expect(tree.merged(child)).toEqual({ a: 1, b: 2 });
  });

  it('proxies reads and writes through the chain', async () => {
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    root.variables.valor = 10;
    const child = tree.create(root.graph, tokenIn(root, 'Start'));
    const proxy = tree.proxy(child);

    expect(proxy.valor).toBe(10);
    proxy.valor = 20;
    expect(root.variables.valor).toBe(20);
    expect(Object.keys(proxy)).toContain('valor');
    expect('valor' in proxy).toBe(true);
    delete proxy.valor;
    expect(tree.read(child, 'valor')).toBeUndefined();
  });

  it('hands out ids in creation order and forgets a removed scope', async () => {
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    const child = tree.create(root.graph, tokenIn(root, 'Start'));
    expect(tree.all()).toHaveLength(2);
    expect(tree.byId(child.id)).toBe(child);

    tree.remove(child);
    expect(tree.all()).toEqual([root]);
    expect(tree.byId(child.id)).toBeUndefined();
    expect(tree.seq).toBe(2);
  });
});

describe('TimerScheduler', () => {
  const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('arms the timer of the catch event a token sits on', async () => {
    const scheduler = new TimerScheduler(() => T0);
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    const token = tokenIn(root, 'Wait5m');

    scheduler.armFor(token);
    const [armed] = scheduler.due();
    expect(armed?.nodeId).toBe('Wait5m');
    expect(armed?.kind).toBe('catch');
    expect(armed?.dueAt).toBeGreaterThan(T0);
  });

  it('arms a boundary timer on the activity the token sits on', async () => {
    const scheduler = new TimerScheduler(() => T0);
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_BOUNDARY));
    scheduler.armFor(tokenIn(root, 'Approve'));

    const [armed] = scheduler.due();
    expect(armed?.kind).toBe('boundary');
  });

  it('does not arm a boundary once per loop instance', async () => {
    const scheduler = new TimerScheduler(() => T0);
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_BOUNDARY));
    const instance = tokenIn(root, 'Approve');
    instance.loopInstanceOf = 'loop-0';

    scheduler.armFor(instance);
    expect(scheduler.due()).toHaveLength(0);
  });

  it('orders by due date and answers the next one', async () => {
    const scheduler = new TimerScheduler(() => T0);
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    const node = root.graph.requireNode('Wait5m');

    scheduler.arm(tokenIn(root, 'Wait5m', 't1'), node, 'catch', 'PT2H');
    scheduler.arm(tokenIn(root, 'Wait5m', 't2'), node, 'catch', 'PT1H');
    expect(scheduler.due().map((timer) => timer.tokenId)).toEqual(['t2', 't1']);
    expect(scheduler.nextAt()).toBe(scheduler.due()[0]?.dueAt);
    // A scheduled retry is a due date too.
    expect(scheduler.nextAt(T0)).toBe(T0);
  });

  it('ignores a definition it cannot schedule', async () => {
    const scheduler = new TimerScheduler(() => T0);
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    const node = root.graph.requireNode('Wait5m');

    scheduler.arm(tokenIn(root, 'Wait5m'), node, 'catch', undefined);
    scheduler.arm(tokenIn(root, 'Wait5m'), node, 'catch', 'nao-e-uma-duracao');
    expect(scheduler.due()).toHaveLength(0);
    expect(scheduler.nextAt()).toBeUndefined();
  });

  it('disarms everything waiting on a token that goes away', async () => {
    const scheduler = new TimerScheduler(() => T0);
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_BOUNDARY));
    scheduler.armFor(tokenIn(root, 'Approve'));
    expect(scheduler.due()).toHaveLength(1);

    scheduler.clearFor('t0');
    expect(scheduler.due()).toHaveLength(0);
  });

  it('rearms a cycle while repetitions remain', async () => {
    let now = T0;
    const scheduler = new TimerScheduler(() => now);
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_BOUNDARY));
    const node = root.graph.requireNode('Deadline');
    scheduler.arm(tokenIn(root, 'Approve'), node, 'boundary', 'R2/PT1H');

    const first = scheduler.due()[0]!;
    scheduler.take(first);
    now = first.dueAt;
    scheduler.rearmCycle(first, node);
    const second = scheduler.due()[0]!;
    expect(second.repetitions).toBe(1);
    expect(second.dueAt).toBeGreaterThan(first.dueAt);

    scheduler.take(second);
    scheduler.rearmCycle(second, node);
    // Last repetition spent: nothing is armed again.
    expect(scheduler.due()).toHaveLength(0);
  });

  it('round-trips its state', async () => {
    const scheduler = new TimerScheduler(() => T0);
    const tree = new ScopeTree({});
    const root = tree.create(await graph(TIMER_CATCH));
    scheduler.armFor(tokenIn(root, 'Wait5m'));
    const stored = scheduler.toState();

    const restored = new TimerScheduler(() => T0);
    restored.restore(stored);
    expect(restored.due()).toEqual(stored);
    expect(restored.has(stored[0]!)).toBe(true);
  });
});
