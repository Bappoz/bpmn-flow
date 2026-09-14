import { describe, expect, it } from 'vitest';
import { ENGINE_STATE_VERSION, parseBpmn, WorkflowEngine } from '../src/index.js';
import type { EngineState, ProcessModel } from '../src/index.js';
import {
  CONDITIONAL_BOUNDARY,
  EVENT_BASED,
  JS_CONDITION_AFTER_WAIT,
  LINEAR,
  PARALLEL_WAIT,
  SUBPROCESS_WAIT,
} from './fixtures.js';

async function process(xml: string): Promise<ProcessModel> {
  return (await parseBpmn(xml)).processes[0]!;
}

/** Round-trips the state through JSON, like a database or a queue would. */
function persist(engine: WorkflowEngine): EngineState {
  return JSON.parse(JSON.stringify(engine.getState())) as EngineState;
}

describe('engine state round-trip', () => {
  it('resumes a parked user task in a brand new engine', async () => {
    const p = await process(LINEAR);
    const first = new WorkflowEngine(p).registerHandler('Charge', () => ({ charged: true }));
    const before = await first.start();
    expect(before.status).toBe('waiting');

    const stored = persist(first);
    const second = WorkflowEngine.restore(p, stored);
    const token = second.snapshot().tokens.find((t) => t.waitReason === 'userTask')!;
    expect(token.nodeId).toBe('Approve');

    const after = await second.completeTask(token.id, { approvedBy: 'alice' });
    expect(after.status).toBe('completed');
    expect(after.variables).toMatchObject({ charged: true, approvedBy: 'alice' });
    expect(after.completedNodes).toContain('End');
  });

  it('keeps parallel join bookkeeping across a restart', async () => {
    const p = await process(PARALLEL_WAIT);
    const first = new WorkflowEngine(p);
    let snap = await first.start();
    // Completes only one of the two branches before "crashing".
    const taskA = snap.tokens.find((t) => t.nodeId === 'TaskA')!;
    snap = await first.completeTask(taskA.id);
    expect(snap.status).toBe('waiting');

    const second = WorkflowEngine.restore(p, persist(first));
    const taskB = second.snapshot().tokens.find((t) => t.nodeId === 'TaskB')!;
    const after = await second.completeTask(taskB.id);

    // The join only fires because the first branch's arrival survived.
    expect(after.status).toBe('completed');
    expect(after.completedNodes).toContain('End');
  });

  it('restores a suspended parent token and its child scope', async () => {
    const p = await process(SUBPROCESS_WAIT);
    const first = new WorkflowEngine(p);
    const before = await first.start();
    expect(before.tokens.find((t) => t.nodeId === 'Review')?.waiting).toBe(true);

    const second = WorkflowEngine.restore(p, persist(first));
    const review = second.snapshot().tokens.find((t) => t.nodeId === 'Review')!;
    const after = await second.completeTask(review.id);

    expect(after.status).toBe('completed');
    expect(after.completedNodes).toEqual(expect.arrayContaining(['SubEnd', 'After', 'End']));
  });

  it('restores armed event-based gateway alternatives', async () => {
    const p = await process(EVENT_BASED);
    const first = new WorkflowEngine(p);
    await first.start();

    const second = WorkflowEngine.restore(p, persist(first));
    const after = await second.signal('OnRejected');

    expect(after.status).toBe('completed');
    expect(after.completedNodes).toContain('Cancel');
    expect(after.completedNodes).not.toContain('Ship');
  });

  it('resume() is a no-op on an already finished execution', async () => {
    const p = await process(LINEAR);
    const eng = new WorkflowEngine(p, { mode: 'auto' });
    const done = await eng.start();
    expect(done.status).toBe('completed');
    expect((await eng.resume()).status).toBe('completed');
  });

  it('keeps the expression mode across a restart', async () => {
    const p = await process(JS_CONDITION_AFTER_WAIT);
    const first = new WorkflowEngine(p, {
      expressions: 'javascript',
      variables: { itens: [1, 3] },
    });
    await first.start();
    const parked = first.snapshot().tokens.find((t) => t.waitReason === 'userTask')!;

    const second = WorkflowEngine.restore(p, persist(first));
    const after = await second.completeTask(parked.id);

    // Same diagram, same data: a restart must not change which flow the gateway
    // takes. Losing the mode would send the token down the default instead.
    expect(after.completedNodes).toContain('Big');
    expect(after.completedNodes).not.toContain('None');
  });

  it('lets the caller override the stored expression mode', async () => {
    const p = await process(JS_CONDITION_AFTER_WAIT);
    const first = new WorkflowEngine(p, {
      expressions: 'javascript',
      variables: { itens: [1, 3] },
    });
    await first.start();
    const parked = first.snapshot().tokens.find((t) => t.waitReason === 'userTask')!;

    const second = WorkflowEngine.restore(p, persist(first), { expressions: 'safe' });
    const after = await second.completeTask(parked.id);

    // The safe evaluator refuses the arrow function, so the guard reads as
    // undefined and the default flow wins.
    expect(after.completedNodes).toContain('None');
  });

  it('rejects a state from another process or version', async () => {
    const p = await process(LINEAR);
    const eng = new WorkflowEngine(p);
    await eng.start();
    const state = persist(eng);

    expect(() =>
      WorkflowEngine.restore(p, { ...state, version: ENGINE_STATE_VERSION + 1 }),
    ).toThrow(/state version/);
    expect(() => WorkflowEngine.restore(p, { ...state, processId: 'Other' })).toThrow(/process/);
  });
});

describe('conditional boundary across a restart', () => {
  it('does not fire again for an activation already fired', async () => {
    const p = await process(CONDITIONAL_BOUNDARY);
    const first = new WorkflowEngine(p, { variables: { urgente: true } });
    const before = await first.start();
    const entered = (snapshot: { history: { nodeId: string; event: string }[] }): number =>
      snapshot.history.filter((e) => e.nodeId === 'Priorizar' && e.event === 'enter').length;
    expect(entered(before)).toBe(1);

    const second = WorkflowEngine.restore(p, persist(first));
    const after = await second.resume();
    expect(entered(after)).toBe(1);
  });
});
