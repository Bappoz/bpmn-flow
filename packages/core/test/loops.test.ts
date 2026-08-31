import { describe, expect, it } from 'vitest';
import { parseBpmn, WorkflowEngine } from '../src/index.js';
import type { EngineState, ProcessModel } from '../src/index.js';
import {
  MI_COLLECTION,
  MI_COMPLETION_CONDITION,
  MI_PARALLEL_COLLECTION,
  MI_PARALLEL_PARTIAL,
  MI_PARALLEL_USER_TASKS,
  MI_SEQUENTIAL,
  MI_SUBPROCESS,
  STANDARD_LOOP,
} from './fixtures.js';

async function process(xml: string): Promise<ProcessModel> {
  return (await parseBpmn(xml)).processes[0]!;
}

describe('multi-instance over a collection', () => {
  it('runs one instance per item and aggregates the outputs', async () => {
    const p = await process(MI_COLLECTION);
    const seen: unknown[] = [];
    const eng = new WorkflowEngine(p, { variables: { itens: [2, 3, 4] } });
    eng.registerHandler('Handle', (ctx) => {
      seen.push(ctx.get('item'));
      return { resultado: (ctx.get('item') as number) * 10 };
    });

    const snap = await eng.start();
    expect(snap.status).toBe('completed');
    expect(seen).toEqual([2, 3, 4]);
    expect(snap.variables.resultados).toEqual([20, 30, 40]);
    // The per-instance item never leaks into the process scope.
    expect(snap.variables).not.toHaveProperty('item');
  });

  it('exposes loopCounter and the item to each instance', async () => {
    const p = await process(MI_COLLECTION);
    const rows: string[] = [];
    const eng = new WorkflowEngine(p, { variables: { itens: ['a', 'b'] } });
    eng.registerHandler('Handle', (ctx) => {
      rows.push(`${String(ctx.get('loopCounter'))}:${String(ctx.get('item'))}`);
    });
    await eng.start();
    expect(rows).toEqual(['0:a', '1:b']);
  });

  it('skips the activity when the collection is empty', async () => {
    const p = await process(MI_COLLECTION);
    const eng = new WorkflowEngine(p, { variables: { itens: [] } });
    let ran = 0;
    eng.registerHandler('Handle', () => {
      ran += 1;
    });
    const snap = await eng.start();
    expect(ran).toBe(0);
    expect(snap.status).toBe('completed');
    expect(snap.completedNodes).toContain('End');
  });

  it('fails when the collection variable is not an array', async () => {
    const p = await process(MI_COLLECTION);
    const eng = new WorkflowEngine(p, { variables: { itens: 'nope' } });
    const snap = await eng.start();
    expect(snap.status).toBe('failed');
  });
});

describe('parallel multi-instance user tasks', () => {
  it('parks one token per approver and joins when all are done', async () => {
    const p = await process(MI_PARALLEL_USER_TASKS);
    const eng = new WorkflowEngine(p, { variables: { aprovadores: ['ana', 'bob', 'cid'] } });
    let snap = await eng.start();

    expect(snap.status).toBe('waiting');
    const waiting = snap.tokens.filter((t) => t.waitReason === 'userTask');
    expect(waiting).toHaveLength(3);

    snap = await eng.completeTask(waiting[0]!.id);
    expect(snap.status).toBe('waiting');
    snap = await eng.completeTask(waiting[1]!.id);
    expect(snap.status).toBe('waiting');
    snap = await eng.completeTask(waiting[2]!.id);

    expect(snap.status).toBe('completed');
    expect(snap.completedNodes).toContain('End');
  });
});

describe('parallel multi-instance output collection', () => {
  /** Completes the instance handling `item`, whatever its position. */
  async function completeItem(eng: WorkflowEngine, item: string): Promise<void> {
    const task = eng.tasks().find((t) => t.variables.item === item);
    expect(task, `no pending instance for item ${item}`).toBeDefined();
    await eng.completeTask(task!.tokenId, { resultado: `r-${item}` });
  }

  it('keeps the output collection positional when instances finish out of order', async () => {
    const p = await process(MI_PARALLEL_COLLECTION);
    const eng = new WorkflowEngine(p, { variables: { itens: ['a', 'b', 'c'] } });
    let snap = await eng.start();
    expect(snap.tokens.filter((t) => t.waiting)).toHaveLength(3);

    // Reverse of the input order: the aggregation must not follow it.
    for (const item of ['c', 'b', 'a']) await completeItem(eng, item);

    snap = eng.snapshot();
    expect(snap.status).toBe('completed');
    expect(snap.variables.resultados).toEqual(['r-a', 'r-b', 'r-c']);
  });

  it('keeps the order across a state round-trip', async () => {
    const p = await process(MI_PARALLEL_COLLECTION);
    const first = new WorkflowEngine(p, { variables: { itens: ['a', 'b', 'c'] } });
    await first.start();
    await completeItem(first, 'c');

    const state = JSON.parse(JSON.stringify(first.getState())) as EngineState;
    const second = WorkflowEngine.restore(p, state);
    await completeItem(second, 'a');
    await completeItem(second, 'b');

    const snap = second.snapshot();
    expect(snap.status).toBe('completed');
    expect(snap.variables.resultados).toEqual(['r-a', 'r-b', 'r-c']);
  });

  it('leaves no gap when the completion condition cancels the rest', async () => {
    const p = await process(MI_PARALLEL_PARTIAL);
    const eng = new WorkflowEngine(p, { variables: { itens: ['a', 'b', 'c'] } });
    await eng.start();

    await completeItem(eng, 'c');
    await completeItem(eng, 'a'); // second result satisfies `resultados.length >= 2`

    const snap = eng.snapshot();
    expect(snap.status).toBe('completed');
    // Instance `b` never ran: its slot is dropped, not left as a hole.
    expect(snap.variables.resultados).toEqual(['r-a', 'r-c']);
  });
});

describe('sequential multi-instance', () => {
  it('runs a single instance at a time', async () => {
    const p = await process(MI_SEQUENTIAL);
    const eng = new WorkflowEngine(p);
    let snap = await eng.start();

    for (let expected = 3; expected > 0; expected--) {
      const waiting = snap.tokens.filter((t) => t.waiting);
      expect(waiting).toHaveLength(1);
      snap = await eng.completeTask(waiting[0]!.id);
    }
    expect(snap.status).toBe('completed');
  });
});

describe('completion condition', () => {
  it('stops the remaining instances once it holds', async () => {
    const p = await process(MI_COMPLETION_CONDITION);
    let attempts = 0;
    const eng = new WorkflowEngine(p);
    eng.registerHandler('Try', (ctx) => {
      attempts += 1;
      if (ctx.get('loopCounter') === 2) ctx.set('encontrado', true);
    });
    const snap = await eng.start();
    expect(attempts).toBe(3); // cardinality is 10, but it stopped at the third
    expect(snap.status).toBe('completed');
  });
});

describe('multi-instance subprocess', () => {
  it('creates one child scope per item', async () => {
    const p = await process(MI_SUBPROCESS);
    const charged: unknown[] = [];
    const eng = new WorkflowEngine(p, { variables: { pedidos: [{ id: 1 }, { id: 2 }] } });
    eng.registerHandler('Charge', (ctx) => {
      charged.push((ctx.get('pedido') as { id: number }).id);
    });
    const snap = await eng.start();
    expect(charged).toEqual([1, 2]);
    expect(snap.status).toBe('completed');
    expect(snap.completedNodes).toContain('End');
  });
});

describe('standard loop', () => {
  it('repeats the activity while the condition holds', async () => {
    const p = await process(STANDARD_LOOP);
    let tries = 0;
    const eng = new WorkflowEngine(p);
    eng.registerHandler('Retry', (ctx) => {
      tries += 1;
      if (tries === 3) ctx.set('pago', true);
    });
    const snap = await eng.start();
    expect(tries).toBe(3);
    expect(snap.status).toBe('completed');
    expect(snap.variables.pago).toBe(true);
  });

  it('never runs when the condition is false up front (testBefore)', async () => {
    const p = await process(STANDARD_LOOP);
    let tries = 0;
    const eng = new WorkflowEngine(p, { variables: { pago: true } });
    eng.registerHandler('Retry', () => {
      tries += 1;
    });
    const snap = await eng.start();
    expect(tries).toBe(0);
    expect(snap.status).toBe('completed');
  });
});

describe('multi-instance state round-trip', () => {
  it('restores pending instances and finishes them', async () => {
    const p = await process(MI_PARALLEL_USER_TASKS);
    const first = new WorkflowEngine(p, { variables: { aprovadores: ['ana', 'bob'] } });
    const started = await first.start();
    await first.completeTask(started.tokens.find((t) => t.waiting)!.id);

    const state = JSON.parse(JSON.stringify(first.getState())) as EngineState;
    const second = WorkflowEngine.restore(p, state);
    const pending = second.snapshot().tokens.filter((t) => t.waiting);
    expect(pending).toHaveLength(1);

    const after = await second.completeTask(pending[0]!.id);
    expect(after.status).toBe('completed');
    expect(after.completedNodes).toContain('End');
  });
});
