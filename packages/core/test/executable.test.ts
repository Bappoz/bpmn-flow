import { describe, expect, it } from 'vitest';
import {
  BpmnValidationError,
  executableProcess,
  findExecutableProcess,
  parseBpmn,
} from '../src/index.js';
import { COLLABORATION_ALL_BLACKBOX, COLLABORATION_BLACKBOX_FIRST, LINEAR } from './fixtures.js';

describe('executableProcess', () => {
  it('skips a leading black-box pool', async () => {
    const model = await parseBpmn(COLLABORATION_BLACKBOX_FIRST);
    expect(model.processes[0]?.id).toBe('BlackBox');
    expect(executableProcess(model).id).toBe('Main');
  });

  it('returns the only process of a single-pool diagram', async () => {
    const model = await parseBpmn(LINEAR);
    expect(executableProcess(model).id).toBe('P');
  });

  it('names the pools it found when none is executable', async () => {
    const model = await parseBpmn(COLLABORATION_ALL_BLACKBOX);
    expect(() => executableProcess(model)).toThrow(BpmnValidationError);
    expect(() => executableProcess(model)).toThrow(/Cliente/);
  });

  it('findExecutableProcess reports absence instead of throwing', async () => {
    const model = await parseBpmn(COLLABORATION_ALL_BLACKBOX);
    expect(findExecutableProcess(model)).toBeUndefined();
  });
});
