import { describe, expect, it } from 'vitest';
import { analyzeProcess, criticalPath, parseBpmn } from '../src/index.js';
import type { ActivityMetrics, ProcessModel } from '../src/index.js';
import {
  ENDLESS_LOOP,
  EXCLUSIVE,
  EXCLUSIVE_NO_DEFAULT,
  LINEAR,
  PARALLEL,
  PARALLEL_DEADLOCK,
  UNREACHABLE_ISLAND,
} from './fixtures.js';

async function process(xml: string): Promise<ProcessModel> {
  return (await parseBpmn(xml)).processes[0]!;
}

function metric(nodeId: string, averageMs: number): ActivityMetrics {
  return {
    nodeId,
    nodeKind: 'task',
    started: 1,
    completed: 1,
    totalMs: averageMs,
    averageMs,
    maxMs: averageMs,
  };
}

describe('analyzeProcess', () => {
  it('finds nothing wrong in a well-formed linear process', async () => {
    expect(analyzeProcess(await process(LINEAR))).toEqual([]);
  });

  it('does not flag an exclusive gateway that has a default flow', async () => {
    const issues = analyzeProcess(await process(EXCLUSIVE));
    expect(issues.some((i) => i.kind === 'gateway-without-default')).toBe(false);
  });

  it('does not flag a parallel join fed by a matching parallel split', async () => {
    const issues = analyzeProcess(await process(PARALLEL));
    expect(issues.some((i) => i.kind === 'parallel-join-deadlock')).toBe(false);
  });

  describe('unreachable', () => {
    it('flags nodes disconnected from every start event', async () => {
      const issues = analyzeProcess(await process(UNREACHABLE_ISLAND));
      const unreachable = issues.filter((i) => i.kind === 'unreachable').map((i) => i.nodeId);

      expect(unreachable.sort()).toEqual(['Lost', 'Orphan']);
      expect(unreachable).not.toContain('Start');
      expect(unreachable).not.toContain('Main');
      expect(unreachable).not.toContain('End');
    });

    it('recurses into subprocesses', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="t" id="D">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubStart" />
      <bpmn:task id="Inner" />
      <bpmn:endEvent id="SubEnd" />
      <bpmn:task id="Stranded" />
      <bpmn:sequenceFlow id="s1" sourceRef="SubStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="s2" sourceRef="Inner" targetRef="SubEnd" />
    </bpmn:subProcess>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Sub" />
    <bpmn:sequenceFlow id="f1" sourceRef="Sub" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;
      const issues = analyzeProcess(await process(xml));

      expect(issues).toEqual([
        expect.objectContaining({ kind: 'unreachable', nodeId: 'Stranded' }),
      ]);
    });

    it('does not flag an ad-hoc subprocess: its activities have no ordering flows', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="t" id="D">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:adHocSubProcess id="Atendimento">
      <bpmn:serviceTask id="Ligar" />
      <bpmn:serviceTask id="Enviar" />
    </bpmn:adHocSubProcess>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Atendimento" />
    <bpmn:sequenceFlow id="f1" sourceRef="Atendimento" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;
      expect(analyzeProcess(await process(xml))).toEqual([]);
    });
  });

  describe('cycle-without-exit', () => {
    it('flags a loop with no flow leaving it', async () => {
      const issues = analyzeProcess(await process(ENDLESS_LOOP));
      const cycle = issues.find((i) => i.kind === 'cycle-without-exit');

      expect(cycle).toMatchObject({ severity: 'error', nodeId: 'Spin' });
      expect(cycle?.cycle?.sort()).toEqual(['Again', 'Spin']);
    });

    it('does not flag a loop with a conditional exit', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" targetNamespace="t" id="D">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:task id="Try" />
    <bpmn:exclusiveGateway id="Ok" default="fRetry" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Try" />
    <bpmn:sequenceFlow id="f1" sourceRef="Try" targetRef="Ok" />
    <bpmn:sequenceFlow id="fRetry" sourceRef="Ok" targetRef="Try" />
    <bpmn:sequenceFlow id="fExit" sourceRef="Ok" targetRef="End">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">done === true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
  </bpmn:process>
</bpmn:definitions>`;
      const issues = analyzeProcess(await process(xml));
      expect(issues.some((i) => i.kind === 'cycle-without-exit')).toBe(false);
    });
  });

  describe('gateway-without-default', () => {
    it('flags an exclusive gateway with no default and full condition coverage', async () => {
      const issues = analyzeProcess(await process(EXCLUSIVE_NO_DEFAULT));

      expect(issues).toEqual([
        expect.objectContaining({
          kind: 'gateway-without-default',
          severity: 'warning',
          nodeId: 'Gw',
        }),
      ]);
    });

    it('does not flag a gateway where an unconditioned flow acts as a fallback', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" targetNamespace="t" id="D">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Gw" />
    <bpmn:task id="High" />
    <bpmn:task id="Low" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Gw" />
    <bpmn:sequenceFlow id="fHigh" sourceRef="Gw" targetRef="High">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">amount &gt; 100</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fLow" sourceRef="Gw" targetRef="Low" />
  </bpmn:process>
</bpmn:definitions>`;
      const issues = analyzeProcess(await process(xml));
      expect(issues.some((i) => i.kind === 'gateway-without-default')).toBe(false);
    });
  });

  describe('parallel-join-deadlock', () => {
    it('flags a parallel join fed by an upstream exclusive split', async () => {
      const issues = analyzeProcess(await process(PARALLEL_DEADLOCK));

      expect(issues).toEqual([
        expect.objectContaining({
          kind: 'parallel-join-deadlock',
          severity: 'error',
          nodeId: 'Join',
          causeNodeId: 'Split',
        }),
      ]);
    });
  });
});

describe('criticalPath', () => {
  it('picks the path whose activities sum to the largest average duration', async () => {
    const model = await process(EXCLUSIVE);
    const metrics = [metric('High', 500), metric('Low', 100)];

    expect(criticalPath(model, metrics)).toEqual({
      path: ['Start', 'Gw', 'High', 'EndHigh'],
      totalMs: 500,
    });
  });

  it('weighs an unmetered node as zero and still returns a path', async () => {
    const model = await process(LINEAR);

    expect(criticalPath(model, [])).toEqual({
      path: ['Start', 'Charge', 'Approve', 'End'],
      totalMs: 0,
    });
  });

  it('returns undefined when no path reaches an end event', async () => {
    const model = await process(ENDLESS_LOOP);
    expect(criticalPath(model, [metric('Spin', 1000)])).toBeUndefined();
  });
});
