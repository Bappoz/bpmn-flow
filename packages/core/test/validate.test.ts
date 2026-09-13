import { describe, expect, it } from 'vitest';
import { validateBpmn } from '../src/index.js';
import { LINEAR } from './fixtures.js';

const NO_START = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="t">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:task id="A" />
  </bpmn:process>
</bpmn:definitions>`;

describe('validateBpmn', () => {
  it('accepts a well-formed process', async () => {
    const result = await validateBpmn(LINEAR);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('reports a missing start event as an error', async () => {
    const result = await validateBpmn(NO_START);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes('no start event'))).toBe(true);
  });

  it('warns about unreachable and dead-end nodes', async () => {
    const result = await validateBpmn(NO_START);
    expect(result.issues.some((i) => i.severity === 'warning' && i.nodeId === 'A')).toBe(true);
  });

  it('flags invalid XML as invalid', async () => {
    const result = await validateBpmn('<nope>');
    expect(result.valid).toBe(false);
  });
});

const CROSS_SCOPE_FLOW = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="t">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:subProcess id="Sub">
      <bpmn:startEvent id="SubStart" />
      <bpmn:task id="Inner" />
      <bpmn:sequenceFlow id="s1" sourceRef="SubStart" targetRef="Inner" />
      <bpmn:sequenceFlow id="s2" sourceRef="Inner" targetRef="End" />
    </bpmn:subProcess>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Sub" />
  </bpmn:process>
</bpmn:definitions>`;

const ORPHAN_BOUNDARY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="t">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:task id="A" />
    <bpmn:boundaryEvent id="B" attachedToRef="Fantasma">
      <bpmn:timerEventDefinition />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="A" />
    <bpmn:sequenceFlow id="f1" sourceRef="A" targetRef="End" />
    <bpmn:sequenceFlow id="f2" sourceRef="B" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const BOUNDARY_ON_GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="t">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Gw" />
    <bpmn:boundaryEvent id="B" attachedToRef="Gw">
      <bpmn:timerEventDefinition />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Gw" />
    <bpmn:sequenceFlow id="f1" sourceRef="Gw" targetRef="End" />
    <bpmn:sequenceFlow id="f2" sourceRef="B" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const MISSING_CALLED_ELEMENT = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="t">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:callActivity id="C" name="Conferir" calledElement="NaoExiste" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="C" />
    <bpmn:sequenceFlow id="f1" sourceRef="C" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const BLACK_BOX_ONLY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="t">
  <bpmn:process id="P" name="Cliente" isExecutable="false">
    <bpmn:startEvent id="Start" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

describe('reference integrity', () => {
  it('reports a sequence flow leaving its own scope', async () => {
    const result = await validateBpmn(CROSS_SCOPE_FLOW);
    expect(result.valid).toBe(false);
    const issue = result.issues.find((i) => i.nodeId === 's2');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('End');
  });

  it('reports a boundary event attached to nothing', async () => {
    const result = await validateBpmn(ORPHAN_BOUNDARY);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.nodeId === 'B' && i.message.includes('not attached'))).toBe(
      true,
    );
  });

  it('reports a boundary event attached to something that is not an activity', async () => {
    const result = await validateBpmn(BOUNDARY_ON_GATEWAY);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.nodeId === 'B' && i.message.includes('Gw'))).toBe(true);
  });

  it('reports a call activity whose called process is absent', async () => {
    const result = await validateBpmn(MISSING_CALLED_ELEMENT);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.nodeId === 'C' && i.message.includes('NaoExiste'))).toBe(
      true,
    );
  });

  it('warns when a process is not executable', async () => {
    const result = await validateBpmn(BLACK_BOX_ONLY);
    // A black-box pool is legal BPMN; it just cannot be run.
    expect(result.valid).toBe(true);
    expect(
      result.issues.some((i) => i.severity === 'warning' && i.message.includes('Cliente')),
    ).toBe(true);
  });

  it('keeps a well-formed diagram free of reference errors', async () => {
    const result = await validateBpmn(LINEAR);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});
