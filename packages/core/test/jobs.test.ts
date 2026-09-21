import { describe, expect, it } from 'vitest';
import { parseBpmn } from '../src/index.js';
import { EXTERNAL_JOB, EXTERNAL_JOB_C7, LINEAR } from './fixtures.js';

describe('job declarado no diagrama', () => {
  it('lê a convenção zeebe:taskDefinition', async () => {
    const model = await parseBpmn(EXTERNAL_JOB);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toEqual({ type: 'charge', retries: 2 });
  });

  it('lê a convenção camunda:type="external"', async () => {
    const model = await parseBpmn(EXTERNAL_JOB_C7);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toEqual({ type: 'charge' });
  });

  it('não inventa job para uma service task sem marcação', async () => {
    const model = await parseBpmn(LINEAR);
    const node = model.processes[0]!.flowNodes.find((n) => n.id === 'Charge');
    expect(node?.job).toBeUndefined();
  });
});
