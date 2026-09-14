import { describe, expect, it } from 'vitest';
import { parseBpmn, WorkflowEngine } from '../src/index.js';
import type { EngineState, ProcessModel } from '../src/index.js';
import { ANY_MULTIPLE, PARALLEL_MULTIPLE, PARALLEL_MULTIPLE_BOUNDARY } from './fixtures.js';

async function process(xml: string): Promise<ProcessModel> {
  return (await parseBpmn(xml)).processes[0]!;
}

describe('parallelMultiple', () => {
  it('is read from the diagram', async () => {
    const p = await process(PARALLEL_MULTIPLE);
    expect(p.flowNodes.find((n) => n.id === 'Aguardar')?.parallelMultiple).toBe(true);
    const any = await process(ANY_MULTIPLE);
    expect(any.flowNodes.find((n) => n.id === 'Aguardar')?.parallelMultiple).toBeUndefined();
  });

  it('holds a catch event until every trigger arrived', async () => {
    const eng = new WorkflowEngine(await process(PARALLEL_MULTIPLE));
    let snap = await eng.start();
    expect(snap.status).toBe('waiting');

    snap = await eng.signal('pago');
    expect(snap.completedNodes).not.toContain('Expedir');
    expect(snap.status).toBe('waiting');

    snap = await eng.signal('nota');
    expect(snap.completedNodes).toContain('Expedir');
    expect(snap.status).toBe('completed');
  });

  it('fires on the first trigger without the attribute', async () => {
    const eng = new WorkflowEngine(await process(ANY_MULTIPLE));
    await eng.start();
    const snap = await eng.signal('pago');
    expect(snap.completedNodes).toContain('Expedir');
    expect(snap.status).toBe('completed');
  });

  it('counts the same trigger twice as one', async () => {
    const eng = new WorkflowEngine(await process(PARALLEL_MULTIPLE));
    await eng.start();
    await eng.signal('pago');
    const snap = await eng.signal('pago');
    expect(snap.status).toBe('waiting');
  });

  it('holds a boundary event until every trigger arrived', async () => {
    const eng = new WorkflowEngine(await process(PARALLEL_MULTIPLE_BOUNDARY));
    await eng.start();
    expect(eng.tasks({ nodeId: 'Conferir' })).toHaveLength(1);

    let snap = await eng.signal('pago');
    expect(snap.completedNodes).not.toContain('Acelerar');

    snap = await eng.signal('nota');
    expect(snap.completedNodes).toContain('Acelerar');
  });

  it('keeps the triggers it already received across a restart', async () => {
    const p = await process(PARALLEL_MULTIPLE);
    const first = new WorkflowEngine(p);
    await first.start();
    await first.signal('pago');

    const stored = JSON.parse(JSON.stringify(first.getState())) as EngineState;
    const second = WorkflowEngine.restore(p, stored);
    const snap = await second.signal('nota');
    expect(snap.completedNodes).toContain('Expedir');
    expect(snap.status).toBe('completed');
  });
});
