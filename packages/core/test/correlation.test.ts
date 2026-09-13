import { describe, expect, it } from 'vitest';
import { parseBpmn, WorkflowEngine } from '../src/index.js';
import type { ProcessModel } from '../src/index.js';
import {
  MESSAGE_CORRELATION,
  MESSAGE_CORRELATION_RECEIVE_TASK,
  MESSAGE_NO_CORRELATION,
} from './fixtures.js';

async function process(xml: string): Promise<ProcessModel> {
  return (await parseBpmn(xml)).processes[0]!;
}

describe('message correlation', () => {
  it('reads the correlation key from the message extensions', async () => {
    const p = await process(MESSAGE_CORRELATION);
    expect(p.flowNodes.find((n) => n.id === 'AguardarPagamento')?.correlationKey).toBe('pedidoId');
  });

  it('reads it on a receive task too', async () => {
    const p = await process(MESSAGE_CORRELATION_RECEIVE_TASK);
    expect(p.flowNodes.find((n) => n.id === 'Receber')?.correlationKey).toBe('pedidoId');
  });

  it('wakes only the instance the key names', async () => {
    const p = await process(MESSAGE_CORRELATION);
    const p42 = new WorkflowEngine(p, { variables: { pedidoId: 42 } });
    const p7 = new WorkflowEngine(p, { variables: { pedidoId: 7 } });
    await p42.start();
    await p7.start();

    const snap42 = await p42.correlate('pedido-pago', 42);
    const snap7 = await p7.correlate('pedido-pago', 42);

    expect(snap42.status).toBe('completed');
    expect(snap7.status).toBe('waiting');
    expect(snap7.completedNodes).not.toContain('Expedir');
  });

  it('matches a key that arrived as text', async () => {
    const eng = new WorkflowEngine(await process(MESSAGE_CORRELATION), {
      variables: { pedidoId: 42 },
    });
    await eng.start();
    expect((await eng.correlate('pedido-pago', '42')).status).toBe('completed');
  });

  it('drops a message nobody correlates with, without throwing', async () => {
    const eng = new WorkflowEngine(await process(MESSAGE_CORRELATION), {
      variables: { pedidoId: 42 },
    });
    await eng.start();
    const snap = await eng.correlate('pedido-pago', 99);
    expect(snap.status).toBe('waiting');
  });

  it('still reaches a subscriber that declares no key', async () => {
    const eng = new WorkflowEngine(await process(MESSAGE_NO_CORRELATION), {
      variables: { pedidoId: 42 },
    });
    await eng.start();
    expect((await eng.correlate('pedido-pago', 99)).status).toBe('completed');
  });

  it('keeps signal() a broadcast', async () => {
    const eng = new WorkflowEngine(await process(MESSAGE_CORRELATION), {
      variables: { pedidoId: 42 },
    });
    await eng.start();
    expect((await eng.signal('pedido-pago')).status).toBe('completed');
  });

  it('answers which instance a message belongs to', async () => {
    const p = await process(MESSAGE_CORRELATION);
    const eng = new WorkflowEngine(p, { variables: { pedidoId: 42 } });
    await eng.start();
    expect(eng.subscribedTo('pedido-pago', 42)).toBe(true);
    expect(eng.subscribedTo('pedido-pago', 7)).toBe(false);
    expect(eng.subscribedTo('pedido-pago')).toBe(true);
    expect(eng.subscribedTo('outra-mensagem', 42)).toBe(false);
  });

  it('stops answering once the subscription was consumed', async () => {
    const eng = new WorkflowEngine(await process(MESSAGE_CORRELATION), {
      variables: { pedidoId: 42 },
    });
    await eng.start();
    await eng.correlate('pedido-pago', 42);
    expect(eng.subscribedTo('pedido-pago', 42)).toBe(false);
  });
});
