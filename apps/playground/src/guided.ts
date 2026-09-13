import {
  decisionsAfter,
  evaluateCondition,
  type BpmnModel,
  type DecisionOption,
  type DecisionPoint,
  type ExecutionSnapshot,
  type FlowNode,
  type GatewayDecision,
  type PendingTask,
  type ProcessModel,
  type TokenSnapshot,
  type WorkflowEngine,
} from '@bpmn-flow/core';
import {
  formatValue,
  type PromptChoice,
  type PromptField,
  type StepAnswer,
  type StepRequest,
} from './prompt.js';

/**
 * A lógica da execução conduzida: qual é a próxima parada, o que perguntar
 * nela e o que fazer com a resposta.
 *
 * Tudo aqui é função pura sobre o contexto recebido — nada de DOM, nada de
 * estado de módulo — porque é a parte que precisa de teste.
 */

/** O que perguntar numa parada, e o que fazer com a resposta. */
export interface Step {
  request: StepRequest;
  /** Resposta usada quando o operador pediu para seguir sem perguntar. */
  defaults: Record<string, unknown>;
  /** Gateways adiante cuja escolha este diálogo já cobre. */
  decided: string[];
  apply: (answer: StepAnswer) => Promise<ExecutionSnapshot>;
}

/** O diagrama carregado e a execução em curso. */
export interface GuidedContext {
  engine: WorkflowEngine;
  /** Processo executado; de onde saem os fluxos e os pontos de decisão. */
  process: ProcessModel | undefined;
  /** Todos os nós do modelo, inclusive os de subprocesso. */
  nodesById: Map<string, FlowNode>;
}

/** Todos os nós do modelo por id, descendo em cada subprocesso. */
export function flattenNodes(model: BpmnModel): Map<string, FlowNode> {
  const map = new Map<string, FlowNode>();
  const walk = (nodes: FlowNode[]): void => {
    for (const node of nodes) {
      map.set(node.id, node);
      if (node.process) walk(node.process.flowNodes);
    }
  };
  for (const process of model.processes) walk(process.flowNodes);
  return map;
}

/** Nome legível de um nó, com o id como último recurso. */
export function labelOf(nodesById: Map<string, FlowNode>, nodeId: string): string {
  return nodesById.get(nodeId)?.name ?? nodeId;
}

/** A primeira parada que depende de alguém de fora. */
export function nextStep(ctx: GuidedContext, snapshot: ExecutionSnapshot): Step | undefined {
  const active = ctx.engine;
  const label = (nodeId: string): string => labelOf(ctx.nodesById, nodeId);

  const incident = active.incidentList()[0];
  if (incident) {
    return {
      request: {
        title: label(incident.nodeId),
        reason: `A atividade falhou: ${incident.message}`,
        badges: [`${incident.attempts} tentativa(s)`],
        choices: [],
        fields: [],
        confirmLabel: 'Tentar de novo',
      },
      defaults: {},
      decided: [],
      apply: () => active.retryTask(incident.tokenId),
    };
  }

  // tasks() também devolve gateway de evento e incidente; aqui só interessa o
  // que uma pessoa conclui ou dispara.
  const task = active.tasks({ reason: ['userTask', 'receiveTask', 'catchEvent'] })[0];
  if (task) return taskStep(ctx, task);

  const gateway = snapshot.tokens.find((token) => token.waitReason === 'eventBasedGateway');
  if (gateway) return gatewayStep(ctx, gateway);

  const timer = active.nextTimerAt();
  if (timer === undefined) return undefined;
  return {
    request: {
      title: 'Timer pendente',
      reason: 'A execução só continua quando o relógio chegar lá.',
      badges: [],
      choices: [],
      fields: [],
      confirmLabel: 'Adiantar relógio',
    },
    defaults: {},
    decided: [],
    apply: () => active.tick(timer),
  };
}

/** Tarefa parada: concluir (ou sinalizar) e responder o que vem logo depois. */
export function taskStep(ctx: GuidedContext, task: PendingTask): Step {
  const trigger = task.reason === 'catchEvent' || task.reason === 'receiveTask';
  const timer = timerOf(ctx.nodesById.get(task.nodeId));
  const ahead = decisionPrompt(ctx, task.nodeId, task.variables);
  return {
    request: {
      title: task.name ?? task.nodeId,
      reason: timer
        ? `Esperando o relógio: ${timer}.`
        : trigger
          ? 'Esperando um gatilho externo (mensagem, sinal).'
          : 'Esperando alguém concluir a atividade.',
      badges: [task.lane, ...task.candidates].filter((text): text is string => Boolean(text)),
      choices: ahead.choices,
      fields: ahead.fields,
      ...(ahead.selected ? { selected: ahead.selected } : {}),
      confirmLabel: timer ? 'Disparar agora' : trigger ? 'Sinalizar' : 'Concluir',
    },
    defaults: ahead.defaults,
    decided: ahead.decided,
    apply: (answer) =>
      trigger
        ? ctx.engine.signal(task.nodeId, answer.values)
        : ctx.engine.completeTask(task.tokenId, answer.values),
  };
}

/** Definição do timer do nó, quando ele espera o relógio. */
export function timerOf(node: FlowNode | undefined): string | undefined {
  for (const detail of node?.events ?? (node?.event ? [node.event] : [])) {
    if (detail.kind === 'timer') return detail.timer ?? 'timer';
  }
  return undefined;
}

/** Gateway baseado em evento: a escolha é qual gatilho chega primeiro. */
export function gatewayStep(ctx: GuidedContext, token: TokenSnapshot): Step {
  const flows = ctx.process?.sequenceFlows ?? [];
  const choices: PromptChoice[] = [];
  for (const flowId of ctx.nodesById.get(token.nodeId)?.outgoing ?? []) {
    const flow = flows.find((candidate) => candidate.id === flowId);
    if (flow) choices.push({ id: flow.targetRef, label: labelOf(ctx.nodesById, flow.targetRef) });
  }
  const first = choices[0]?.id;
  return {
    request: {
      title: labelOf(ctx.nodesById, token.nodeId),
      reason: 'Gateway baseado em evento: o primeiro gatilho a chegar decide o caminho.',
      badges: [],
      choices,
      fields: [],
      ...(first ? { selected: first } : {}),
      confirmLabel: 'Sinalizar',
    },
    defaults: {},
    decided: [],
    apply: (answer) => ctx.engine.signal(answer.choiceId ?? first ?? token.nodeId),
  };
}

/** O diálogo de um gateway: os caminhos, e o que os dados escolheriam. */
export function gatewayRequest(
  nodesById: Map<string, FlowNode>,
  decision: GatewayDecision,
): StepRequest {
  const byData = decision.options.find((option) => option.flowId === decision.suggested[0]);
  const name = (option: (typeof decision.options)[number]): string =>
    option.name ?? labelOf(nodesById, option.targetId);
  return {
    title: decision.name ?? decision.nodeId,
    reason: byData
      ? `Pelas condições o processo iria para "${name(byData)}"; a escolha aqui vale mais.`
      : 'Nenhuma condição fecha: escolha por onde seguir.',
    badges: [],
    choices: decision.options.map((option) => ({
      id: option.flowId,
      label: name(option),
      ...((option.condition ?? option.isDefault)
        ? { hint: option.condition ?? 'caminho padrão' }
        : {}),
    })),
    ...(decision.suggested[0] ? { selected: decision.suggested[0] } : {}),
    fields: [],
    confirmLabel: 'Seguir',
  };
}

/**
 * As escolhas e os valores que a execução vai encontrar logo depois deste nó.
 * Só o primeiro ponto de decisão vira opções de caminho — os seguintes ainda
 * dependem do que for respondido aqui, então entram apenas como valores.
 */
export function decisionPrompt(
  ctx: GuidedContext,
  nodeId: string,
  variables: Record<string, unknown>,
): {
  choices: PromptChoice[];
  fields: PromptField[];
  defaults: Record<string, unknown>;
  decided: string[];
  selected?: string;
} {
  const decisions = ctx.process ? decisionsAfter(ctx.process, nodeId) : [];
  const choices: PromptChoice[] = [];
  const fields: PromptField[] = [];
  const defaults: Record<string, unknown> = {};
  let selected: string | undefined;

  decisions.forEach((decision, index) => {
    const current = matchingOption(decision, variables);
    if (index === 0) {
      selected = current?.flowId;
      for (const option of decision.options) {
        choices.push({
          id: option.flowId,
          label: option.label,
          ...((option.condition ?? option.isDefault)
            ? { hint: option.condition ?? 'caminho padrão' }
            : {}),
          assignments: option.assignments,
        });
      }
    }
    for (const name of decision.variables) {
      if (fields.some((field) => field.name === name)) continue;
      const value = Object.hasOwn(variables, name) ? variables[name] : current?.assignments[name];
      if (value !== undefined) defaults[name] = value;
      fields.push({
        name,
        value: formatValue(value),
        hint: `lido em ${decision.name ?? decision.nodeId}`,
      });
    }
  });
  return {
    choices,
    fields,
    defaults,
    decided: decisions.map((decision) => decision.nodeId),
    ...(selected ? { selected } : {}),
  };
}

/** O caminho que as variáveis de agora já escolheriam. */
export function matchingOption(
  decision: DecisionPoint,
  variables: Record<string, unknown>,
): DecisionOption | undefined {
  const conditional = decision.options.filter((option) => !option.isDefault);
  const match = conditional.find(
    (option) => !option.condition || evaluateCondition(option.condition, variables),
  );
  return match ?? decision.options.find((option) => option.isDefault) ?? decision.options[0];
}
