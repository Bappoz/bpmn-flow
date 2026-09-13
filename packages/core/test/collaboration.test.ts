import { describe, expect, it } from 'vitest';
import { CollaborationEngine, parseBpmn } from '../src/index.js';
import type { CollaborationState } from '../src/index.js';
import { COLLABORATION_BLACKBOX_FIRST, COLLABORATION_TWO_POOLS, LINEAR } from './fixtures.js';

describe('CollaborationEngine', () => {
  it('runs every executable pool of the collaboration', async () => {
    const model = await parseBpmn(COLLABORATION_TWO_POOLS);
    const engine = new CollaborationEngine(model);
    const snap = await engine.start();

    expect(snap.pools.map((pool) => pool.processId)).toEqual(['Cliente', 'Loja']);
    // The customer sent the order and now waits for the confirmation; the shop
    // took the order and is separating items.
    expect(engine.tasks().map((task) => `${task.processId}/${task.nodeId}`)).toEqual([
      'Cliente/ReceberOk',
      'Loja/Separar',
    ]);
    expect(snap.status).toBe('waiting');
  });

  it('routes a message flow from its source to its target', async () => {
    const model = await parseBpmn(COLLABORATION_TWO_POOLS);
    const engine = new CollaborationEngine(model);
    let snap = await engine.start();
    expect(snap.messages.map((m) => m.flowId)).toEqual(['mfPedido']);

    const separar = engine.tasks({ nodeId: 'Separar' })[0]!;
    snap = await engine.completeTask(separar.taskId);

    expect(snap.messages.map((m) => m.flowId)).toEqual(['mfPedido', 'mfOk']);
    expect(snap.status).toBe('completed');
    const cliente = snap.pools.find((pool) => pool.processId === 'Cliente')!;
    expect(cliente.snapshot.completedNodes).toContain('C2');
    const loja = snap.pools.find((pool) => pool.processId === 'Loja')!;
    expect(loja.snapshot.completedNodes).toContain('L2');
  });

  it('names the pools after their participants', async () => {
    const model = await parseBpmn(COLLABORATION_TWO_POOLS);
    const engine = new CollaborationEngine(model);
    expect(engine.participants).toEqual([
      { processId: 'Cliente', participantId: 'PartCliente', name: 'Cliente' },
      { processId: 'Loja', participantId: 'PartLoja', name: 'Loja' },
    ]);
  });

  it('skips black-box pools', async () => {
    const model = await parseBpmn(COLLABORATION_BLACKBOX_FIRST);
    const engine = new CollaborationEngine(model);
    const snap = await engine.start();
    expect(snap.pools.map((pool) => pool.processId)).toEqual(['Main']);
    expect(snap.status).toBe('completed');
  });

  it('works on a single-process file too', async () => {
    const model = await parseBpmn(LINEAR);
    const engine = new CollaborationEngine(model);
    const snap = await engine.start();
    expect(snap.pools).toHaveLength(1);
    expect(snap.status).toBe('waiting');
  });

  it('carries the payload a host defines', async () => {
    const model = await parseBpmn(COLLABORATION_TWO_POOLS);
    const engine = new CollaborationEngine(model, {
      variables: { pedido: 42 },
      messagePayload: ({ flow, variables }) =>
        flow.id === 'mfPedido' ? { pedidoRecebido: variables.pedido } : undefined,
    });
    await engine.start();
    const loja = engine.snapshot().pools.find((pool) => pool.processId === 'Loja')!;
    expect(loja.snapshot.variables).toMatchObject({ pedidoRecebido: 42 });
  });

  it('holds a message until the receiving pool subscribes', async () => {
    const model = await parseBpmn(COLLABORATION_TWO_POOLS);
    const engine = new CollaborationEngine(model);
    await engine.start();
    // The confirmation only exists after "Separar", so nothing is in flight yet.
    expect(engine.snapshot().inflight).toEqual([]);
  });

  it('resumes a collaboration from its stored state', async () => {
    const model = await parseBpmn(COLLABORATION_TWO_POOLS);
    const first = new CollaborationEngine(model);
    await first.start();
    const stored = JSON.parse(JSON.stringify(first.getState())) as CollaborationState;

    const second = CollaborationEngine.restore(model, stored);
    const separar = second.tasks({ nodeId: 'Separar' })[0]!;
    const snap = await second.completeTask(separar.taskId);
    expect(snap.status).toBe('completed');
    // The order message is not delivered a second time.
    expect(snap.messages.filter((m) => m.flowId === 'mfPedido')).toHaveLength(1);
  });

  it('reports the task it cannot find', async () => {
    const model = await parseBpmn(COLLABORATION_TWO_POOLS);
    const engine = new CollaborationEngine(model);
    await engine.start();
    await expect(engine.completeTask('nao-existe')).rejects.toThrow(/nao-existe/);
  });

  it('refuses a bare token id two pools both have', async () => {
    const model = await parseBpmn(COLLABORATION_TWO_POOLS);
    const engine = new CollaborationEngine(model);
    await engine.start();
    // Each pool numbers its own tokens, so the same id exists twice.
    const bare = engine.tasks()[0]!.tokenId;
    expect(engine.tasks().filter((task) => task.tokenId === bare)).toHaveLength(2);
    await expect(engine.completeTask(bare)).rejects.toThrow(/more than one pool/);
  });
});
