import { describe, expect, it } from 'vitest';
import { ENGINE_STATE_VERSION, WorkflowEngine, parseBpmn } from '../src/index.js';
import type { ProcessModel } from '../src/index.js';
import { EXTERNAL_JOB, EXTERNAL_JOB_C7, LINEAR } from './fixtures.js';

async function process(xml: string): Promise<ProcessModel> {
  return (await parseBpmn(xml)).processes[0]!;
}

describe('job declared on the diagram', () => {
  it('reads the zeebe:taskDefinition convention', async () => {
    const model = await parseBpmn(EXTERNAL_JOB);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toEqual({ type: 'charge', retries: 2 });
  });

  it('reads the camunda:type="external" convention', async () => {
    const model = await parseBpmn(EXTERNAL_JOB_C7);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toEqual({ type: 'charge' });
  });

  it('does not invent a job for an unmarked service task', async () => {
    const model = await parseBpmn(LINEAR);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toBeUndefined();
  });
});

describe('external job wait state', () => {
  it('holds the activity instead of passing through', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB));
    const snap = await eng.start();

    expect(snap.status).toBe('waiting');
    const [task] = eng.tasks({ reason: 'job' });
    expect(task).toMatchObject({ nodeId: 'Charge', reason: 'job', job: { type: 'charge' } });
  });

  it('carries on once the worker completes it', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB));
    await eng.start();
    const [task] = eng.tasks({ reason: 'job' });

    const snap = await eng.completeTask(task!.tokenId, { authorized: true });

    expect(snap.status).toBe('completed');
    expect(snap.variables).toMatchObject({ authorized: true });
  });

  it('lets a local handler win when there is one', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB));
    eng.registerHandler('Charge', () => ({ authorized: true }));

    const snap = await eng.start();

    expect(snap.status).toBe('completed');
    expect(eng.tasks({ reason: 'job' })).toHaveLength(0);
  });

  it('survives a restore with the token parked on the job', async () => {
    const model = await parseBpmn(EXTERNAL_JOB);
    const eng = new WorkflowEngine(model.processes[0]!);
    await eng.start();
    const state = eng.getState();

    const revived = WorkflowEngine.restore(model.processes[0]!, state);
    const [task] = revived.tasks({ reason: 'job' });
    expect(task).toMatchObject({ nodeId: 'Charge', reason: 'job' });
    expect(state.version).toBe(ENGINE_STATE_VERSION);
  });
});
