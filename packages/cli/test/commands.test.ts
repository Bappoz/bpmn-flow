import { describe, expect, it } from 'vitest';
import { inspect, run, validate } from '../src/index.js';

const ORDER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="Pedido" isExecutable="true" name="Pedido">
    <bpmn:laneSet id="Lanes">
      <bpmn:lane id="L1" name="Expedicao">
        <bpmn:flowNodeRef>Separar</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:dataObject id="itens" name="itens" />
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Separar" name="Separar itens">
      <bpmn:multiInstanceLoopCharacteristics isSequential="false">
        <bpmn:loopDataInputRef>itens</bpmn:loopDataInputRef>
        <bpmn:inputDataItem id="item" name="item" />
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:userTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Separar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Separar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const BROKEN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:task id="Solta" />
  </bpmn:process>
</bpmn:definitions>`;

describe('validate', () => {
  it('accepts a well-formed diagram', async () => {
    const result = await validate(ORDER);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('valid');
  });

  it('exits non-zero and lists the problems', async () => {
    const result = await validate(BROKEN);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/start event/i);
  });
});

describe('inspect', () => {
  it('summarizes nodes, lanes and repetition', async () => {
    const { output } = await inspect(ORDER);
    expect(output).toContain('process Pedido (Pedido)');
    expect(output).toContain('userTask: 1');
    expect(output).toContain('lanes: Expedicao');
    expect(output).toContain('multi-instance parallel over "itens"');
  });
});

describe('run', () => {
  it('reports where the execution stopped and who owns the work', async () => {
    const result = await run(ORDER, { variables: { itens: ['a', 'b'] } });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('status: waiting');
    expect(result.output).toContain('Separar itens (userTask, Expedicao)');
    expect(result.snapshot.tokens.filter((token) => token.waiting)).toHaveLength(2);
  });

  it('continues from a saved state', async () => {
    const first = await run(ORDER, { variables: { itens: ['a'] } });
    const state = JSON.parse(JSON.stringify(first.state));

    const second = await run(ORDER, { state });
    expect(second.snapshot.status).toBe('waiting'); // same place, nothing lost
    expect(second.output).toContain('Separar itens');
  });

  it('drives a whole process in auto mode', async () => {
    const result = await run(ORDER, { mode: 'auto', variables: { itens: ['a', 'b'] } });
    expect(result.snapshot.status).toBe('completed');
    expect(result.output).toContain('status: completed');
  });
});

const COM_TIMER_E_POOL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:collaboration id="Colab">
    <bpmn:participant id="Cliente" name="Cliente" processRef="P" />
    <bpmn:participant id="Loja" name="Loja" />
    <bpmn:messageFlow id="mf1" name="Pedido" sourceRef="Cliente" targetRef="Loja" />
  </bpmn:collaboration>
  <bpmn:process id="P" isExecutable="true" name="Atendimento">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Esperar">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT15M</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:serviceTask id="Tentar" name="Tentar de novo">
      <bpmn:standardLoopCharacteristics testBefore="false" loopMaximum="3" />
    </bpmn:serviceTask>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Esperar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Esperar" targetRef="Tentar" />
    <bpmn:sequenceFlow id="f2" sourceRef="Tentar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const QUEBRADO = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Integrar" name="Integrar" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Integrar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Integrar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

describe('run and the expression mode', () => {
  /** The guard only routes when the whole JavaScript language is available. */
  const JS_GUARD = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Gw" default="fPadrao" />
    <bpmn:task id="Calculado" />
    <bpmn:task id="Padrao" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Gw" />
    <bpmn:sequenceFlow id="fCalculado" sourceRef="Gw" targetRef="Calculado">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">itens.some((i) =&gt; i &gt; 2)</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fPadrao" sourceRef="Gw" targetRef="Padrao" />
    <bpmn:sequenceFlow id="f1" sourceRef="Calculado" targetRef="End" />
    <bpmn:sequenceFlow id="f2" sourceRef="Padrao" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

  it('reads an expression outside the safe subset as false', async () => {
    const result = await run(JS_GUARD, { variables: { itens: [1, 3] } });
    expect(result.snapshot.completedNodes).toContain('Padrao');
  });

  it('routes on it once --js-expressions is asked for', async () => {
    const result = await run(JS_GUARD, {
      variables: { itens: [1, 3] },
      expressions: 'javascript',
    });
    expect(result.snapshot.completedNodes).toContain('Calculado');
  });
});

describe('inspect, deeper', () => {
  it('lists timers, loops and participants', async () => {
    const { output } = await inspect(COM_TIMER_E_POOL);
    expect(output).toContain('timer PT15M');
    expect(output).toContain('standard loop');
    expect(output).toContain('participants: Cliente, Loja');
  });
});

describe('run with automation', () => {
  it('runs the handlers it is given', async () => {
    const seen: string[] = [];
    const result = await run(QUEBRADO, {
      handlers: {
        Integrar: () => {
          seen.push('Integrar');
          return { integrado: true };
        },
      },
    });
    expect(seen).toEqual(['Integrar']);
    expect(result.snapshot.variables.integrado).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('exits non-zero when a handler blows up', async () => {
    const result = await run(QUEBRADO, {
      handlers: {
        Integrar: () => {
          throw new Error('502 bad gateway');
        },
      },
    });
    expect(result.snapshot.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('reports incidents and retries instead of failing', async () => {
    let attempts = 0;
    const result = await run(QUEBRADO, {
      onHandlerError: 'incident',
      retry: { attempts: 2 },
      handlers: {
        Integrar: () => {
          attempts += 1;
          throw new Error('502 bad gateway');
        },
      },
    });
    expect(attempts).toBe(3);
    expect(result.output).toContain('incidents:');
    expect(result.output).toContain('502 bad gateway');
    expect(result.exitCode).toBe(0);
  });
});
