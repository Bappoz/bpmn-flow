import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

/**
 * Regression for issue #12: `POST /api/sessions` accepts XML from anyone, so a
 * flow condition of that XML must not be able to run code in the server.
 *
 * The condition below only means something if the expression is executed as
 * JavaScript: it writes a marker on `globalThis` and then routes the token.
 * Under the safe evaluator it is not even parseable, so the marker never
 * appears and the gateway falls back to its default flow.
 */
const PROBE = '__bpmnFlowUntrustedProbe';

const HOSTILE = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Gw" default="fSafe" />
    <bpmn:task id="Owned" />
    <bpmn:task id="Safe" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Gw" />
    <bpmn:sequenceFlow id="fOwned" sourceRef="Gw" targetRef="Owned">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">(globalThis.${PROBE} = { pid: process.pid, cwd: process.cwd() }, true)</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fSafe" sourceRef="Gw" targetRef="Safe" />
    <bpmn:sequenceFlow id="f1" sourceRef="Owned" targetRef="End" />
    <bpmn:sequenceFlow id="f2" sourceRef="Safe" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

async function createSession(xml: string): Promise<Response> {
  return createApp().request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ xml }),
  });
}

describe('a session created from untrusted XML', () => {
  it('never executes the expressions of the diagram', async () => {
    const response = await createSession(HOSTILE);
    expect(response.status).toBe(201);

    const { snapshot } = (await response.json()) as {
      snapshot: { status: string; completedNodes: string[] };
    };
    expect(snapshot.status).toBe('completed');
    // The guard read as false, so the gateway took its default branch.
    expect(snapshot.completedNodes).toContain('Safe');
    expect(snapshot.completedNodes).not.toContain('Owned');
    expect(PROBE in globalThis).toBe(false);
  });

  it('cannot ask the server for the javascript evaluator', async () => {
    const response = await createApp().request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Not part of the API: the mode belongs to whoever runs the server.
      body: JSON.stringify({ xml: HOSTILE, expressions: 'javascript' }),
    });

    expect(response.status).toBe(201);
    expect(PROBE in globalThis).toBe(false);
  });

  it('still routes on the conditions it can read', async () => {
    const xml = HOSTILE.replace(
      `(globalThis.${PROBE} = { pid: process.pid, cwd: process.cwd() }, true)`,
      'valor &gt; 100',
    );
    const response = await createApp().request('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xml, variables: { valor: 500 } }),
    });

    const { snapshot } = (await response.json()) as { snapshot: { completedNodes: string[] } };
    expect(snapshot.completedNodes).toContain('Owned');
  });
});
