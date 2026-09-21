import { describe, expect, it } from 'vitest';
import { parseBpmn } from '../src/index.js';
import { EXTERNAL_JOB, EXTERNAL_JOB_C7, LINEAR } from './fixtures.js';

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
