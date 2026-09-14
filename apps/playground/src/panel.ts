import { processVariables, suggestVariables } from '@bpmn-flow/core';
import type {
  ExecutionSnapshot,
  FlowNode,
  PendingTask,
  ProcessModel,
  TimerState,
  TokenSnapshot,
  ValidationResult,
  VariableUsage,
} from '@bpmn-flow/core';
import type { Elements } from './elements.js';
import { labelOf } from './guided.js';

/** O que o painel pede de volta quando alguém clica num dos seus botões. */
export interface PanelPorts {
  complete(tokenId: string): void;
  signal(nodeIdOrName: string): void;
  fastForward(): void;
}

/** O diagrama que o painel está descrevendo no momento. */
interface Described {
  nodesById: Map<string, FlowNode>;
  process: ProcessModel | undefined;
}

/**
 * A lateral: estado, ações pendentes, timers, dicas de variáveis, log e
 * validação.
 *
 * Só desenha. Tudo que ela sabe do diagrama chega por {@link describe} e todo
 * clique volta pelos {@link PanelPorts} — o painel nunca toca no motor.
 */
export class Panel {
  private described: Described = { nodesById: new Map(), process: undefined };

  constructor(
    private readonly els: Elements,
    private readonly ports: PanelPorts,
  ) {}

  /** Troca o diagrama descrito e repõe as dicas de variáveis. */
  describe(described: Described): void {
    this.described = described;
    this.showVariableHints();
  }

  private label(nodeId: string): string {
    return labelOf(this.described.nodesById, nodeId);
  }

  status(text: string): void {
    this.els.status.textContent = text;
  }

  fail(error: unknown): void {
    this.status(`Erro: ${error instanceof Error ? error.message : String(error)}`);
  }

  log(message: string): void {
    const item = document.createElement('li');
    item.textContent = message;
    this.els.log.prepend(item);
  }

  /** Limpa tudo que pertence a uma execução, ao carregar outro diagrama. */
  clearExecution(): void {
    this.els.log.replaceChildren();
    this.els.actions.replaceChildren();
    this.els.variablesView.textContent = '';
    this.els.timers.replaceChildren();
  }

  /** Estado, variáveis, ações e timers de um instante da execução. */
  showSnapshot(snapshot: ExecutionSnapshot, tasks: PendingTask[], timers: TimerState[]): void {
    this.status(
      `Status: ${snapshot.status} - ${snapshot.tokens.length} token(s) ativos, ${snapshot.completedNodes.length} nó(s) concluídos.`,
    );
    this.els.variablesView.textContent = JSON.stringify(snapshot.variables, null, 2);
    this.showActions(tasks, snapshot.tokens);
    this.showTimers(timers);
  }

  showVariables(variables: Record<string, unknown>): void {
    this.els.variablesView.textContent = JSON.stringify(variables, null, 2);
  }

  /** As variáveis digitadas na caixa JSON. @throws se o JSON for inválido. */
  readVariables(): Record<string, unknown> {
    const raw = this.els.variables.value.trim();
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  showActions(tasks: PendingTask[], tokens: TokenSnapshot[]): void {
    this.els.actions.replaceChildren();
    if (tasks.length === 0) {
      this.els.actions.append(muted('Nenhuma ação pendente.'));
      return;
    }
    for (const task of tasks) this.addTaskCard(task);
    // Gateways baseados em evento pedem um gatilho por alternativa.
    for (const token of tokens) {
      if (token.waitReason === 'eventBasedGateway') this.addEventGatewayButtons(token);
    }
  }

  /** Cartão de tarefa: quem executa, por que parou e o que a instância enxerga. */
  private addTaskCard(task: PendingTask): void {
    const card = document.createElement('div');
    card.className = 'task';

    const title = document.createElement('p');
    title.className = 'task-title';
    title.textContent = task.name ?? task.nodeId;
    card.append(title);

    const badges = document.createElement('p');
    badges.className = 'task-badges';
    for (const text of [task.lane, ...task.candidates].filter((value): value is string =>
      Boolean(value),
    )) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = text;
      badges.append(badge);
    }
    const reason = document.createElement('span');
    reason.className = 'badge badge-muted';
    reason.textContent = task.reason;
    badges.append(reason);
    card.append(badges);

    // Numa atividade multi-instância, mostra o que é próprio desta instância.
    const loop = this.described.nodesById.get(task.nodeId)?.loop;
    if (loop) {
      const names = [loop.elementVariable, 'loopCounter'].filter(
        (name): name is string => typeof name === 'string',
      );
      const detail = document.createElement('p');
      detail.className = 'task-vars';
      detail.textContent = names
        .map((name) => `${name}=${JSON.stringify(task.variables[name])}`)
        .join(' · ');
      card.append(detail);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = task.reason === 'catchEvent' ? 'Sinalizar' : 'Concluir';
    button.addEventListener('click', () => {
      if (task.reason === 'catchEvent') this.ports.signal(task.nodeId);
      else this.ports.complete(task.tokenId);
    });
    card.append(button);
    this.els.actions.append(card);
  }

  private addEventGatewayButtons(token: TokenSnapshot): void {
    const node = this.described.nodesById.get(token.nodeId);
    for (const flowId of node?.outgoing ?? []) {
      const flow = this.described.process?.sequenceFlows.find((f) => f.id === flowId);
      if (!flow) continue;
      this.actionButton(`Sinalizar ${this.label(flow.targetRef)}`, () =>
        this.ports.signal(flow.targetRef),
      );
    }
  }

  private actionButton(text: string, onClick: () => void): void {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', onClick);
    this.els.actions.append(button);
  }

  /** Timers pendentes, com atalho para adiantar o relógio na demonstração. */
  showTimers(timers: TimerState[]): void {
    this.els.timers.replaceChildren();
    if (timers.length === 0) {
      this.els.timers.append(muted('Nenhum timer pendente.'));
      return;
    }
    for (const timer of timers) {
      const line = document.createElement('p');
      line.className = 'timer';
      const remaining = Math.max(0, Math.round((timer.dueAt - Date.now()) / 1000));
      line.textContent = `${this.label(timer.nodeId)} · ${timer.definition} · faltam ${remaining}s`;
      this.els.timers.append(line);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Adiantar relógio';
    button.addEventListener('click', () => this.ports.fastForward());
    this.els.timers.append(button);
  }

  /**
   * Mostra as variáveis que o diagrama realmente lê — com a expressão que as
   * usa — e preenche a caixa JSON com um valor que faz cada caminho acontecer.
   */
  private showVariableHints(): void {
    this.els.variableHints.replaceChildren();
    const process = this.described.process;
    if (!process) return;

    const usages = processVariables(process);
    if (usages.length === 0) {
      this.els.variableHints.append(muted('Este processo não lê nenhuma variável.'));
    } else {
      for (const usage of usages) this.els.variableHints.append(hintCard(usage));
    }

    // A caixa JSON começa com o que faz o processo andar, em vez de "{}".
    this.els.variables.value = JSON.stringify(suggestVariables(process), null, 2);
  }

  showValidation(result: ValidationResult, extra?: string): void {
    this.els.validation.replaceChildren();
    const header = document.createElement('p');
    header.className = result.valid ? 'valid-ok' : 'valid-err';
    header.textContent = result.valid ? 'Diagrama válido.' : 'Diagrama inválido.';
    this.els.validation.append(header);
    for (const issue of result.issues) {
      const item = document.createElement('p');
      item.className = `issue issue-${issue.severity}`;
      item.textContent = `${issue.severity === 'error' ? 'Erro' : 'Aviso'}: ${issue.message}`;
      this.els.validation.append(item);
    }
    if (extra) {
      const note = document.createElement('p');
      note.className = 'valid-ok';
      note.textContent = extra;
      this.els.validation.append(note);
    }
  }

  validationMessage(message: string, ok = false): void {
    this.els.validation.replaceChildren();
    const line = document.createElement('p');
    line.className = ok ? 'valid-ok' : 'valid-err';
    line.textContent = message;
    this.els.validation.append(line);
  }
}

function muted(text: string): HTMLElement {
  const line = document.createElement('p');
  line.className = 'muted';
  line.textContent = text;
  return line;
}

function hintCard(usage: VariableUsage): HTMLElement {
  const card = document.createElement('div');
  card.className = 'hint';

  const name = document.createElement('p');
  name.className = 'hint-name';
  name.textContent =
    usage.suggestion === undefined
      ? usage.name
      : `${usage.name} = ${JSON.stringify(usage.suggestion)}`;
  card.append(name);

  const usedBy = document.createElement('p');
  usedBy.className = 'hint-usage';
  if (usage.kind === 'collection') {
    usedBy.textContent = `coleção da multi-instância em ${usage.usedBy.join(', ')}`;
  } else {
    const expression = document.createElement('span');
    expression.className = 'hint-expression';
    expression.textContent = usage.expressions[0] ?? '';
    usedBy.append(expression, ` · ${usage.usedBy.join(', ')}`);
  }
  card.append(usedBy);
  return card;
}
