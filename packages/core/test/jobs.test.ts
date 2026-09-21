import { describe, expect, it } from 'vitest';
import { BpmnError, ENGINE_STATE_VERSION, WorkflowEngine, parseBpmn } from '../src/index.js';
import type { ProcessModel } from '../src/index.js';
import { EXTERNAL_JOB, EXTERNAL_JOB_C7, JOB_WITH_BOUNDARY, LINEAR } from './fixtures.js';

function incidentFor(eng: WorkflowEngine, tokenId: string) {
  return eng.getState().incidents.find((incident) => incident.tokenId === tokenId);
}

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

describe('worker reporting a failure', () => {
  it('opens an incident once the retries run out', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB), {
      onHandlerError: 'incident',
    });
    await eng.start();
    const [task] = eng.tasks({ reason: 'job' });

    const snap = await eng.failJob(task!.tokenId, new Error('gateway timeout'));

    expect(snap.status).toBe('waiting');
    expect(eng.incidentList()).toMatchObject([
      { nodeId: 'Charge', message: 'gateway timeout', attempts: 1 },
    ]);
    expect(eng.tasks({ reason: 'job' })).toHaveLength(0);
  });

  it('hands the job back while an attempt remains', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB), {
      onHandlerError: 'incident',
      retry: { attempts: 1 },
    });
    await eng.start();
    const [first] = eng.tasks({ reason: 'job' });

    await eng.failJob(first!.tokenId, new Error('gateway timeout'));

    // An attempt remains: the activity waits on a worker again, no incident yet.
    expect(eng.tasks({ reason: 'job' })).toHaveLength(1);
    expect(eng.incidentList()).toHaveLength(0);
  });

  it('refuses a token that is not waiting on a worker', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB));
    await eng.start();

    await expect(eng.failJob('nope', new Error('x'))).rejects.toThrow(/No job for token/);
  });

  it('refuses a token parked for a different reason', async () => {
    const eng = new WorkflowEngine(await process(LINEAR));
    await eng.start();
    const [task] = eng.tasks({ reason: 'userTask' });

    await expect(eng.failJob(task!.tokenId, new Error('x'))).rejects.toThrow(/No job for token/);
  });

  it('fires the error boundary when the worker sends a BpmnError', async () => {
    const eng = new WorkflowEngine(await process(JOB_WITH_BOUNDARY));
    await eng.start();
    const [task] = eng.tasks({ reason: 'job' });

    const snap = await eng.failJob(task!.tokenId, new BpmnError('DECLINED'));

    expect(snap.completedNodes).toContain('Declined');
  });

  it('restores with the failure policy the host passes in', async () => {
    const model = await parseBpmn(EXTERNAL_JOB);
    const eng = new WorkflowEngine(model.processes[0]!, { onHandlerError: 'incident' });
    await eng.start();

    const revived = WorkflowEngine.restore(model.processes[0]!, eng.getState(), {
      onHandlerError: 'incident',
    });
    const [task] = revived.tasks({ reason: 'job' });
    await revived.failJob(task!.tokenId, new Error('gateway timeout'));

    // Without the widening, the restored engine would fall back to 'fail' and kill the instance.
    expect(revived.incidentList()).toMatchObject([{ message: 'gateway timeout' }]);
  });

  it('falls back to "fail" on restore when the host omits onHandlerError', async () => {
    const model = await parseBpmn(EXTERNAL_JOB);
    const eng = new WorkflowEngine(model.processes[0]!);
    await eng.start();

    const revived = WorkflowEngine.restore(model.processes[0]!, eng.getState());
    const [task] = revived.tasks({ reason: 'job' });
    const snap = await revived.failJob(task!.tokenId, new Error('gateway timeout'));

    expect(snap.status).toBe('failed');
    expect(revived.incidentList()).toHaveLength(0);
  });

  it('keeps the retry budget across a restore, so it can still exhaust', async () => {
    const model = await parseBpmn(EXTERNAL_JOB);
    const opts = { onHandlerError: 'incident' as const, retry: { attempts: 1 } };
    const eng = new WorkflowEngine(model.processes[0]!, opts);
    await eng.start();
    const [first] = eng.tasks({ reason: 'job' });
    await eng.failJob(first!.tokenId, new Error('gateway timeout'));

    // One attempt already spent; the host round-trips the engine through the
    // journal before the next command, as it does for every command.
    const revived = WorkflowEngine.restore(model.processes[0]!, eng.getState(), opts);
    const [second] = revived.tasks({ reason: 'job' });
    const snap = await revived.failJob(second!.tokenId, new Error('gateway timeout again'));

    // The budget was not reset by the round trip: this second failure opens
    // the incident instead of granting a fresh attempt.
    expect(snap.status).toBe('waiting');
    expect(revived.incidentList()).toMatchObject([{ nodeId: 'Charge', attempts: 2 }]);
    expect(revived.tasks({ reason: 'job' })).toHaveLength(0);
  });

  it('drops the incident bookkeeping once the job succeeds', async () => {
    const eng = new WorkflowEngine(await process(EXTERNAL_JOB), {
      onHandlerError: 'incident',
      retry: { attempts: 1 },
    });
    await eng.start();
    const [first] = eng.tasks({ reason: 'job' });
    await eng.failJob(first!.tokenId, new Error('gateway timeout'));
    const [retried] = eng.tasks({ reason: 'job' });

    await eng.completeTask(retried!.tokenId, { authorized: true });

    expect(incidentFor(eng, retried!.tokenId)).toBeUndefined();
  });
});
