import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';

/**
 * Two branches that both have to arrive before the slow service task runs, so
 * completing them concurrently puts two requests inside the same engine.
 */
const PARALLEL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:parallelGateway id="Split" />
    <bpmn:userTask id="TaskA" />
    <bpmn:userTask id="TaskB" />
    <bpmn:parallelGateway id="Join" />
    <bpmn:serviceTask id="Slow" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="fa" sourceRef="Split" targetRef="TaskA" />
    <bpmn:sequenceFlow id="fb" sourceRef="Split" targetRef="TaskB" />
    <bpmn:sequenceFlow id="fa2" sourceRef="TaskA" targetRef="Join" />
    <bpmn:sequenceFlow id="fb2" sourceRef="TaskB" targetRef="Join" />
    <bpmn:sequenceFlow id="fj" sourceRef="Join" targetRef="Slow" />
    <bpmn:sequenceFlow id="fs" sourceRef="Slow" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('concurrent requests on one session', () => {
  it('never reports a running execution as the answer to a completed one', async () => {
    const store = new SessionStore({
      handlers: {
        Slow: async () => {
          await sleep(30);
          return { done: true };
        },
      },
    });
    const created = await store.create({ xml: PARALLEL });
    const tasks = await store.tasks(created.id);
    expect(tasks).toHaveLength(2);

    const [first, second] = await Promise.all([
      store.complete(created.id, tasks[0]!.tokenId),
      store.complete(created.id, tasks[1]!.tokenId),
    ]);

    // Whoever answers last sees the finished execution; nobody sees a status
    // produced by someone else's drain loop.
    const statuses = [first.snapshot.status, second.snapshot.status];
    expect(statuses).not.toContain('running');
    expect(statuses).toContain('completed');
    expect(second.snapshot.variables).toMatchObject({ done: true });
  });

  it('applies concurrent completions exactly once each', async () => {
    let runs = 0;
    const store = new SessionStore({
      handlers: {
        Slow: async () => {
          runs += 1;
          await sleep(10);
          return {};
        },
      },
    });
    const created = await store.create({ xml: PARALLEL });
    const tasks = await store.tasks(created.id);
    await Promise.all(tasks.map((task) => store.complete(created.id, task.tokenId)));
    expect(runs).toBe(1);
  });
});
