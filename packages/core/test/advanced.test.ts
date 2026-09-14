import { describe, expect, it } from 'vitest';
import { parseBpmn, parseTimerCycle, WorkflowEngine } from '../src/index.js';
import type { BpmnModel, EngineState, ProcessModel } from '../src/index.js';
import {
  AD_HOC,
  AD_HOC_SEQUENTIAL,
  CONDITIONAL_BOUNDARY,
  DATA_MAPPING,
  THROW_SIGNAL,
  TIMER_CYCLE,
} from './fixtures.js';

const T0 = Date.parse('2026-08-19T12:00:00.000Z');

async function process(xml: string): Promise<ProcessModel> {
  return (await parseBpmn(xml)).processes[0]!;
}

/** Round-trips the state through JSON, like a database or a queue would. */
function persist(engine: WorkflowEngine): EngineState {
  return JSON.parse(JSON.stringify(engine.getState())) as EngineState;
}

describe('throw events', () => {
  it('a signal thrown inside the process wakes its own catchers', async () => {
    const eng = new WorkflowEngine(await process(THROW_SIGNAL));
    let snap = await eng.start();

    // One branch waits for the signal; the other is about to throw it.
    expect(snap.tokens.find((t) => t.nodeId === 'EsperarPagamento')?.waiting).toBe(true);

    snap = await eng.completeTask(eng.tasks({ nodeId: 'Cobrar' })[0]!.tokenId);

    // Nobody signalled from outside: the throw event did it.
    expect(snap.completedNodes).toContain('EmitirNota');
    expect(snap.status).toBe('completed');
  });
});

describe('conditional boundary event', () => {
  it('fires when the variables make its condition true', async () => {
    const eng = new WorkflowEngine(await process(CONDITIONAL_BOUNDARY), {
      variables: { urgente: false },
    });
    let snap = await eng.start();
    expect(snap.completedNodes).not.toContain('Priorizar');

    // The other branch marks the case as urgent.
    snap = await eng.completeTask(eng.tasks({ nodeId: 'Sinalizar' })[0]!.tokenId, {
      urgente: true,
    });

    expect(snap.completedNodes).toContain('Priorizar');
    // Non-interrupting: the analysis is still open.
    expect(eng.tasks({ nodeId: 'Analisar' })).toHaveLength(1);
  });

  it('does not fire twice for the same activity', async () => {
    const eng = new WorkflowEngine(await process(CONDITIONAL_BOUNDARY), {
      variables: { urgente: true },
    });
    const snap = await eng.start();
    const priorizou = snap.history.filter((entry) => entry.nodeId === 'Priorizar');
    expect(priorizou.filter((entry) => entry.event === 'enter')).toHaveLength(1);
  });
});

describe('cyclic timer', () => {
  it('reads the repetitions of a cycle', () => {
    expect(parseTimerCycle('R3/PT10M')).toEqual({ repetitions: 3, interval: 'PT10M' });
    expect(parseTimerCycle('R/PT1H')).toEqual({ repetitions: null, interval: 'PT1H' });
    expect(parseTimerCycle('PT10M')).toBeUndefined();
  });

  it('fires a non-interrupting boundary once per repetition', async () => {
    let now = T0;
    let cobrancas = 0;
    const eng = new WorkflowEngine(await process(TIMER_CYCLE), { now: () => now });
    eng.registerHandler('Cobrar', () => {
      cobrancas += 1;
    });

    await eng.start();
    for (let hour = 1; hour <= 5; hour++) {
      now = T0 + hour * 3_600_000;
      await eng.tick();
    }

    // R3: three reminders, then it stops even though time keeps passing.
    expect(cobrancas).toBe(3);
    expect(eng.tasks({ nodeId: 'Aguardar' })).toHaveLength(1);
  });
});

describe('ad-hoc subprocess', () => {
  it('runs every activity, with no sequence flow between them', async () => {
    const done: string[] = [];
    const eng = new WorkflowEngine(await process(AD_HOC));
    for (const id of ['Ligar', 'Enviar', 'Registrar']) {
      eng.registerHandler(id, () => {
        done.push(id);
      });
    }

    const snap = await eng.start();

    expect(done.sort()).toEqual(['Enviar', 'Ligar', 'Registrar']);
    expect(snap.completedNodes).toContain('Fechar');
    expect(snap.status).toBe('completed');
  });

  it('stops early when the completion condition holds', async () => {
    const done: string[] = [];
    const eng = new WorkflowEngine(await process(AD_HOC));
    eng.registerHandler('Ligar', () => {
      done.push('Ligar');
      return { resolvido: true }; // resolved on the first call
    });
    for (const id of ['Enviar', 'Registrar']) {
      eng.registerHandler(id, () => {
        done.push(id);
      });
    }

    const snap = await eng.start();

    expect(done).toContain('Ligar');
    expect(snap.completedNodes).toContain('Fechar');
    expect(snap.status).toBe('completed');
  });

  it('sequential ordering runs one activity at a time', async () => {
    const eng = new WorkflowEngine(await process(AD_HOC_SEQUENTIAL));
    await eng.start();

    expect(eng.tasks()).toHaveLength(1);
    expect(eng.tasks()[0]?.nodeId).toBe('Item1');

    await eng.completeTask(eng.tasks()[0]!.tokenId);
    expect(eng.tasks()[0]?.nodeId).toBe('Item2');

    const snap = await eng.completeTask(eng.tasks()[0]!.tokenId);
    expect(snap.status).toBe('completed');
  });
});

describe('data mapping', () => {
  async function model(): Promise<BpmnModel> {
    return parseBpmn(DATA_MAPPING);
  }

  it('maps values in and out of the called process', async () => {
    const m = await model();
    const caller = m.processes.find((p) => p.id === 'Pedido')!;
    const eng = new WorkflowEngine(caller, {
      processes: m.processes,
      variables: { valorPedido: 250, segredoDoChamador: 'nao vaza' },
    });

    let vistoDentro: Record<string, unknown> = {};
    eng.registerHandler('Cobrar', (ctx) => {
      vistoDentro = { ...ctx.variables };
      return { recibo: `NF-${String(ctx.get('valor'))}` };
    });

    const started = await eng.start();
    expect(started.status).toBe('waiting'); // parado na confirmação, dentro do chamado
    const snap = await eng.completeTask(eng.tasks({ nodeId: 'Confirmar' })[0]!.tokenId);

    // Entrou mapeado...
    expect(vistoDentro.valor).toBe(250);
    // ...e o processo chamado não enxerga o resto do chamador.
    expect(vistoDentro.segredoDoChamador).toBeUndefined();
    // ...e só o que foi mapeado volta, com o nome do chamador.
    expect(snap.variables.reciboDaCobranca).toBe('NF-250');
    expect(snap.variables.recibo).toBeUndefined();
    expect(snap.status).toBe('completed');
  });
});

describe('the new constructs survive a restart', () => {
  it('keeps an ad-hoc queue and finishes it in another engine', async () => {
    const p = await process(AD_HOC_SEQUENTIAL);
    const first = new WorkflowEngine(p);
    await first.start();
    await first.completeTask(first.tasks()[0]!.tokenId);

    const second = WorkflowEngine.restore(p, persist(first));
    expect(second.tasks()[0]?.nodeId).toBe('Item2');

    const snap = await second.completeTask(second.tasks()[0]!.tokenId);
    expect(snap.status).toBe('completed');
  });

  it('keeps the isolation of a data-mapped call activity', async () => {
    const model = await parseBpmn(DATA_MAPPING);
    const caller = model.processes.find((p) => p.id === 'Pedido')!;
    const first = new WorkflowEngine(caller, {
      processes: model.processes,
      variables: { valorPedido: 99 },
    });
    // Para na tarefa de usuário do processo chamado.
    first.registerHandler('Cobrar', () => undefined);
    const started = await first.start();
    expect(started.status).toBe('waiting');

    const second = WorkflowEngine.restore(caller, persist(first), {
      processes: model.processes,
    });
    const pendente = second.tasks({ nodeId: 'Confirmar' })[0]!;
    const vistoDentro = pendente.variables;

    const snap = await second.completeTask(pendente.tokenId, { recibo: 'NF-99' });
    expect(snap.status).toBe('completed');
    expect(vistoDentro.valorPedido).toBeUndefined(); // segue isolado
    expect(snap.variables.reciboDaCobranca).toBe('NF-99');
  });

  it('keeps the repetitions left on a cyclic timer', async () => {
    let now = T0;
    const p = await process(TIMER_CYCLE);
    const first = new WorkflowEngine(p, { now: () => now });
    let cobrancas = 0;
    first.registerHandler('Cobrar', () => {
      cobrancas += 1;
    });
    await first.start();
    now = T0 + 3_600_000;
    await first.tick();

    const second = WorkflowEngine.restore(p, persist(first), { now: () => now });
    second.registerHandler('Cobrar', () => {
      cobrancas += 1;
    });
    for (let hour = 2; hour <= 6; hour++) {
      now = T0 + hour * 3_600_000;
      await second.tick();
    }

    expect(cobrancas).toBe(3); // uma antes do restart, duas depois
  });
});
