import { describe, expect, it } from 'vitest';
import { parseBpmn, WorkflowEngine } from '@bpmn-flow/core';
import type { BpmnModel, DecisionPoint, GatewayDecision, ProcessModel } from '@bpmn-flow/core';
import {
  flattenNodes,
  gatewayRequest,
  gatewayStep,
  labelOf,
  matchingOption,
  nextStep,
  timerOf,
  type GuidedContext,
} from '../src/guided.js';

const APPROVAL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:laneSet id="Lanes">
      <bpmn:lane id="L1" name="Gerencia">
        <bpmn:flowNodeRef>Aprovar</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Aprovar" name="Aprovar pedido" />
    <bpmn:exclusiveGateway id="Gw" name="Aprovado?" default="fNao" />
    <bpmn:task id="Emitir" name="Emitir nota" />
    <bpmn:task id="Recusar" name="Recusar" />
    <bpmn:endEvent id="Fim" />
    <bpmn:endEvent id="FimRecusa" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aprovar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aprovar" targetRef="Gw" />
    <bpmn:sequenceFlow id="fSim" name="Sim" sourceRef="Gw" targetRef="Emitir">
      <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">aprovado === true</bpmn:conditionExpression>
    </bpmn:sequenceFlow>
    <bpmn:sequenceFlow id="fNao" name="Nao" sourceRef="Gw" targetRef="Recusar" />
    <bpmn:sequenceFlow id="f2" sourceRef="Emitir" targetRef="Fim" />
    <bpmn:sequenceFlow id="f3" sourceRef="Recusar" targetRef="FimRecusa" />
  </bpmn:process>
</bpmn:definitions>`;

const EVENT_GATEWAY = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:eventBasedGateway id="Escolha" name="O que vier primeiro" />
    <bpmn:intermediateCatchEvent id="Resposta" name="Resposta do cliente">
      <bpmn:messageEventDefinition />
    </bpmn:intermediateCatchEvent>
    <bpmn:intermediateCatchEvent id="Prazo" name="Prazo estourou">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT30M</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="FimA" />
    <bpmn:endEvent id="FimB" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Escolha" />
    <bpmn:sequenceFlow id="fResp" sourceRef="Escolha" targetRef="Resposta" />
    <bpmn:sequenceFlow id="fPrazo" sourceRef="Escolha" targetRef="Prazo" />
    <bpmn:sequenceFlow id="f1" sourceRef="Resposta" targetRef="FimA" />
    <bpmn:sequenceFlow id="f2" sourceRef="Prazo" targetRef="FimB" />
  </bpmn:process>
</bpmn:definitions>`;

const TIMER_CATCH = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Esperar" name="Esperar SLA">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT2H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Esperar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Esperar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const FAILING = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Cobrar" name="Cobrar cartao" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Cobrar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Cobrar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

async function context(
  xml: string,
  options: { variables?: Record<string, unknown>; onHandlerError?: 'fail' | 'incident' } = {},
  handlers: Record<string, () => unknown> = {},
): Promise<{ ctx: GuidedContext; model: BpmnModel; process: ProcessModel }> {
  const model = await parseBpmn(xml);
  const process = model.processes[0]!;
  const engine = new WorkflowEngine(process, options);
  for (const [selector, handler] of Object.entries(handlers)) {
    engine.registerHandler(selector, handler);
  }
  return { ctx: { engine, process, nodesById: flattenNodes(model) }, model, process };
}

describe('flattenNodes e labelOf', () => {
  it('indexa os nós do modelo pelo id', async () => {
    const model = await parseBpmn(APPROVAL);
    const nodes = flattenNodes(model);
    expect(nodes.get('Aprovar')?.name).toBe('Aprovar pedido');
    expect(labelOf(nodes, 'Aprovar')).toBe('Aprovar pedido');
  });

  it('cai no id quando o nó não tem nome', async () => {
    const nodes = flattenNodes(await parseBpmn(APPROVAL));
    expect(labelOf(nodes, 'Start')).toBe('Start');
    expect(labelOf(nodes, 'nao-existe')).toBe('nao-existe');
  });
});

describe('nextStep', () => {
  it('pergunta a tarefa parada, com a raia como etiqueta', async () => {
    const { ctx } = await context(APPROVAL);
    const snapshot = await ctx.engine.start();
    const step = nextStep(ctx, snapshot)!;

    expect(step.request.title).toBe('Aprovar pedido');
    expect(step.request.badges).toContain('Gerencia');
    expect(step.request.confirmLabel).toBe('Concluir');
  });

  it('já oferece o caminho do gateway que vem depois da tarefa', async () => {
    const { ctx } = await context(APPROVAL);
    const step = nextStep(ctx, await ctx.engine.start())!;

    expect(step.request.choices.map((choice) => choice.id)).toEqual(['fSim', 'fNao']);
    expect(step.request.fields.map((field) => field.name)).toEqual(['aprovado']);
    expect(step.decided).toEqual(['Gw']);
  });

  it('aplica a resposta e continua a execução', async () => {
    const { ctx } = await context(APPROVAL);
    const step = nextStep(ctx, await ctx.engine.start())!;
    const after = await step.apply({ action: 'confirm', values: { aprovado: true } });

    expect(after.completedNodes).toContain('Emitir');
    expect(after.status).toBe('completed');
  });

  it('prioriza o incidente sobre qualquer outra parada', async () => {
    const { ctx } = await context(
      FAILING,
      { onHandlerError: 'incident' },
      {
        Cobrar: () => {
          throw new Error('cartao recusado');
        },
      },
    );
    const step = nextStep(ctx, await ctx.engine.start())!;

    expect(step.request.title).toBe('Cobrar cartao');
    expect(step.request.reason).toContain('cartao recusado');
    expect(step.request.confirmLabel).toBe('Tentar de novo');
  });

  it('oferece disparar agora quando a parada é um timer', async () => {
    const { ctx } = await context(TIMER_CATCH);
    const step = nextStep(ctx, await ctx.engine.start())!;
    expect(step.request.reason).toContain('PT2H');
    expect(step.request.confirmLabel).toBe('Disparar agora');

    const after = await step.apply({ action: 'confirm', values: {} });
    expect(after.status).toBe('completed');
  });

  it('não pergunta nada quando a execução terminou', async () => {
    const { ctx } = await context(APPROVAL);
    const snapshot = await ctx.engine.start();
    const step = nextStep(ctx, snapshot)!;
    const after = await step.apply({ action: 'confirm', values: { aprovado: false } });
    expect(nextStep(ctx, after)).toBeUndefined();
  });
});

describe('gatewayStep', () => {
  it('oferece um caminho por gatilho do gateway de evento', async () => {
    const { ctx } = await context(EVENT_GATEWAY);
    const snapshot = await ctx.engine.start();
    const token = snapshot.tokens.find((t) => t.waitReason === 'eventBasedGateway')!;
    const step = gatewayStep(ctx, token);

    expect(step.request.title).toBe('O que vier primeiro');
    expect(step.request.choices).toEqual([
      { id: 'Resposta', label: 'Resposta do cliente' },
      { id: 'Prazo', label: 'Prazo estourou' },
    ]);
    expect(step.request.selected).toBe('Resposta');
  });

  it('sinaliza o gatilho escolhido', async () => {
    const { ctx } = await context(EVENT_GATEWAY);
    const snapshot = await ctx.engine.start();
    const token = snapshot.tokens.find((t) => t.waitReason === 'eventBasedGateway')!;
    const after = await gatewayStep(ctx, token).apply({
      action: 'confirm',
      values: {},
      choiceId: 'Prazo',
    });

    expect(after.completedNodes).toContain('FimB');
    expect(after.completedNodes).not.toContain('FimA');
  });

  it('usa a primeira alternativa quando ninguém escolheu', async () => {
    const { ctx } = await context(EVENT_GATEWAY);
    const snapshot = await ctx.engine.start();
    const token = snapshot.tokens.find((t) => t.waitReason === 'eventBasedGateway')!;
    const after = await gatewayStep(ctx, token).apply({ action: 'confirm', values: {} });
    expect(after.completedNodes).toContain('FimA');
  });
});

describe('matchingOption', () => {
  const decision: DecisionPoint = {
    nodeId: 'Gw',
    nodeKind: 'exclusiveGateway',
    name: 'Aprovado?',
    variables: ['aprovado'],
    options: [
      {
        flowId: 'fSim',
        targetId: 'Emitir',
        label: 'Sim',
        condition: 'aprovado === true',
        isDefault: false,
        assignments: { aprovado: true },
      },
      {
        flowId: 'fNao',
        targetId: 'Recusar',
        label: 'Nao',
        isDefault: true,
        assignments: {},
      },
    ],
  };

  it('escolhe a condição que fecha com as variáveis atuais', () => {
    expect(matchingOption(decision, { aprovado: true })?.flowId).toBe('fSim');
  });

  it('cai no caminho padrão quando nenhuma condição fecha', () => {
    expect(matchingOption(decision, { aprovado: false })?.flowId).toBe('fNao');
    expect(matchingOption(decision, {})?.flowId).toBe('fNao');
  });

  it('sem caminho padrão, a primeira opção sem condição é a saída', () => {
    const semPadrao: DecisionPoint = {
      ...decision,
      options: [decision.options[0]!, { ...decision.options[1]!, isDefault: false }],
    };
    expect(matchingOption(semPadrao, { aprovado: false })?.flowId).toBe('fNao');
  });

  it('sem padrão e sem condição que feche, não escolhe nada além da primeira', () => {
    const todasCondicionais: DecisionPoint = {
      ...decision,
      options: [decision.options[0]!],
    };
    expect(matchingOption(todasCondicionais, { aprovado: false })?.flowId).toBe('fSim');
  });

  it('uma opção sem condição serve para qualquer dado', () => {
    const semCondicao: DecisionPoint = {
      ...decision,
      options: [{ ...decision.options[0]!, condition: undefined }],
    };
    expect(matchingOption(semCondicao, {})?.flowId).toBe('fSim');
  });
});

describe('gatewayRequest', () => {
  it('diz para onde os dados iriam e deixa a escolha por cima', async () => {
    const nodes = flattenNodes(await parseBpmn(APPROVAL));
    const decision: GatewayDecision = {
      nodeId: 'Gw',
      nodeKind: 'exclusiveGateway',
      name: 'Aprovado?',
      options: [
        {
          flowId: 'fSim',
          targetId: 'Emitir',
          name: 'Sim',
          condition: 'aprovado === true',
          isDefault: false,
        },
        { flowId: 'fNao', targetId: 'Recusar', isDefault: true },
      ],
      suggested: ['fSim'],
      variables: { aprovado: true },
    };
    const request = gatewayRequest(nodes, decision);

    expect(request.reason).toContain('"Sim"');
    expect(request.selected).toBe('fSim');
    expect(request.choices[1]).toEqual({
      id: 'fNao',
      label: 'Recusar',
      hint: 'caminho padrão',
    });
  });

  it('avisa quando nenhuma condição fecha', async () => {
    const nodes = flattenNodes(await parseBpmn(APPROVAL));
    const request = gatewayRequest(nodes, {
      nodeId: 'Gw',
      nodeKind: 'exclusiveGateway',
      options: [{ flowId: 'fSim', targetId: 'Emitir', isDefault: false }],
      suggested: [],
      variables: {},
    });
    expect(request.reason).toContain('Nenhuma condição');
  });
});

describe('timerOf', () => {
  it('devolve a definição do timer do nó', async () => {
    const nodes = flattenNodes(await parseBpmn(EVENT_GATEWAY));
    expect(timerOf(nodes.get('Prazo'))).toBe('PT30M');
    expect(timerOf(nodes.get('Resposta'))).toBeUndefined();
    expect(timerOf(undefined)).toBeUndefined();
  });
});
