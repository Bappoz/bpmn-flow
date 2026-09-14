import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/sessions.js';

const ORDER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:message id="MsgPago" name="pedido-pago">
    <bpmn:extensionElements>
      <zeebe:subscription correlationKey="=pedidoId" />
    </bpmn:extensionElements>
  </bpmn:message>
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Aguardar">
      <bpmn:messageEventDefinition messageRef="MsgPago" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aguardar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aguardar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

describe('routing a message across sessions', () => {
  it('advances only the session the key names', async () => {
    const store = new SessionStore();
    const order42 = await store.create({ xml: ORDER, variables: { pedidoId: 42 } });
    const order7 = await store.create({ xml: ORDER, variables: { pedidoId: 7 } });

    const delivered = await store.correlate('pedido-pago', 42);
    expect(delivered).toEqual([order42.id]);

    expect((await store.get(order42.id))?.snapshot.status).toBe('completed');
    expect((await store.get(order7.id))?.snapshot.status).toBe('waiting');
  });

  it('reports an undeliverable message instead of guessing', async () => {
    const store = new SessionStore();
    await store.create({ xml: ORDER, variables: { pedidoId: 42 } });
    expect(await store.correlate('pedido-pago', 99)).toEqual([]);
  });

  it('exposes it over HTTP', async () => {
    const app = createApp();
    const post = (path: string, body: unknown): Promise<Response> =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const created = (await (
      await post('/api/sessions', { xml: ORDER, variables: { pedidoId: 42 } })
    ).json()) as { id: string };

    const miss = await post('/api/messages', { name: 'pedido-pago', correlationKey: 99 });
    expect(miss.status).toBe(404);

    const hit = await post('/api/messages', { name: 'pedido-pago', correlationKey: '42' });
    expect(hit.status).toBe(200);
    expect((await hit.json()) as { delivered: string[] }).toEqual({ delivered: [created.id] });
  });
});
