import type {
  ExecutionSnapshot,
  GatewayDecision,
  HistoryEntry,
  WorkflowEngine,
} from '@bpmn-flow/core';
import type * as DiagramView from './diagram-view.js';
import { gatewayRequest, nextStep, type GuidedContext, type Step } from './guided.js';
import type { Panel } from './panel.js';
import { StepPrompt, type StepAnswer } from './prompt.js';

/** Intervalo entre dois passos da animação, em milissegundos. */
const STEP_MS = 500;
/** Teto de paradas atendidas numa condução, contra processo que nunca acaba. */
const MAX_STEPS = 200;

/** O que a condução precisa do modo executar, que é quem tem o motor. */
export interface GuidedRunPorts {
  /** O motor atual, criado sob demanda se a execução ainda não começou. */
  engine(): WorkflowEngine;
  context(engine: WorkflowEngine): GuidedContext;
  /** Pinta um quadro da animação no diagrama. */
  paint(frame: DiagramView.ReplayFrame): void;
  /** Módulo do viewer, já carregado quando há um diagrama na tela. */
  replayOf(history: HistoryEntry[]): DiagramView.ExecutionReplay | undefined;
  /** Devolve o diagrama ao estado real e religa a pintura ao vivo. */
  settle(): void;
  /** Desliga a pintura por eventos enquanto a animação conduz. */
  takeOverPainting(): void;
  label(nodeId: string): string;
}

/**
 * A execução conduzida: anima no diagrama o que o motor já fez e, a cada
 * parada, pergunta o que só uma pessoa decide.
 *
 * O estado da condução — se está rodando, se pediram para parar, o que já foi
 * animado, quais gateways já foram respondidos — vive aqui, e não espalhado
 * pelo módulo.
 */
export class GuidedRun {
  private readonly prompt = new StepPrompt();
  private running = false;
  private stopRequested = false;
  /** O operador pediu para seguir até o fim sem mais perguntas. */
  private autoAnswer = false;
  /** Passos do histórico já animados na condução atual. */
  private shownSteps = 0;
  /**
   * Gateways cuja escolha já foi respondida no diálogo da atividade anterior —
   * quando o token chegar neles, decidem pelos dados sem perguntar de novo.
   */
  private readonly answeredGateways = new Set<string>();
  private timer: number | undefined;

  constructor(
    private readonly panel: Panel,
    private readonly ports: GuidedRunPorts,
    private readonly button: HTMLButtonElement,
  ) {}

  get active(): boolean {
    return this.running;
  }

  /** Zera a animação, ao carregar outro diagrama. */
  reset(): void {
    this.shownSteps = 0;
    this.answeredGateways.clear();
    this.stop();
  }

  /** Interrompe a condução: para a animação e fecha um diálogo aberto. */
  stop(): void {
    this.stopRequested = true;
    this.prompt.close();
  }

  /** Clicar de novo no botão interrompe o que estava conduzindo. */
  async toggle(): Promise<void> {
    if (this.running) {
      this.stop();
      return;
    }
    await this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    this.stopRequested = false;
    this.autoAnswer = false;
    this.button.textContent = 'Parar';
    try {
      const engine = this.ports.engine();
      // Enquanto conduz, quem pinta é a animação — não os eventos do motor.
      this.ports.takeOverPainting();

      this.shownSteps = 0;
      this.answeredGateways.clear();
      let snapshot = engine.snapshot();
      if (snapshot.status === 'idle') snapshot = await engine.start();
      for (let step = 0; step < MAX_STEPS && !this.stopRequested; step++) {
        this.shownSteps = await this.animateFrom(snapshot.history, this.shownSteps);
        if (this.stopRequested || snapshot.status !== 'waiting') break;
        // O painel acompanha a parada, para o diálogo e a lateral contarem a
        // mesma história.
        this.panel.showActions(engine.tasks(), snapshot.tokens);
        this.panel.showTimers(engine.dueTimers());
        const next = await this.answerStep(engine, snapshot);
        if (!next) break;
        snapshot = next;
        this.panel.showVariables(snapshot.variables);
      }
    } catch (error) {
      this.panel.fail(error);
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    this.running = false;
    this.stopRequested = false;
    this.autoAnswer = false;
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    this.prompt.close();
    this.button.textContent = 'Run';
    this.ports.settle();
  }

  /** Percorre o histórico do passo `from` até o fim; devolve quantos já foram. */
  private animateFrom(history: HistoryEntry[], from: number): Promise<number> {
    const replay = this.ports.replayOf(history);
    if (!replay || replay.length <= from) return Promise.resolve(from);
    replay.seek(from - 1);
    return new Promise<number>((resolve) => {
      this.timer = window.setInterval(() => {
        const frame = this.stopRequested ? undefined : replay.next();
        if (!frame) {
          window.clearInterval(this.timer);
          this.timer = undefined;
          resolve(replay.position + 1);
          return;
        }
        this.ports.paint(frame);
        this.panel.status(
          `Passo ${frame.index + 1}/${replay.length}: ${this.ports.label(frame.entry.nodeId)} (${frame.entry.event})`,
        );
      }, STEP_MS);
    });
  }

  /** Pergunta a parada atual (ou responde sozinho) e devolve o estado seguinte. */
  private async answerStep(
    engine: WorkflowEngine,
    snapshot: ExecutionSnapshot,
  ): Promise<ExecutionSnapshot | undefined> {
    const step: Step | undefined = nextStep(this.ports.context(engine), snapshot);
    if (!step) return undefined;
    const answer: StepAnswer = this.autoAnswer
      ? { action: 'confirm', values: step.defaults, choiceId: step.request.selected }
      : await this.prompt.ask(step.request);
    if (answer.action === 'stop') return undefined;
    if (answer.action === 'auto') this.autoAnswer = true;
    // O gateway logo à frente não precisa perguntar de novo: acabou de ser
    // respondido aqui, e os valores informados é que vão decidir.
    for (const nodeId of step.decided) this.answeredGateways.add(nodeId);
    return step.apply(answer);
  }

  /**
   * O gateway pergunta antes de rotear o token. Só durante a condução, e só
   * quando a escolha não foi respondida no diálogo da atividade anterior — fora
   * disso o processo decide pelos dados, como manda a especificação.
   */
  async onGatewayDecision(
    engine: WorkflowEngine | undefined,
    decision: GatewayDecision,
  ): Promise<string | undefined> {
    if (!engine || !this.running || this.stopRequested) return undefined;
    if (this.answeredGateways.delete(decision.nodeId)) return undefined;
    // Alcança o gateway no diagrama antes de perguntar sobre ele.
    this.shownSteps = await this.animateFrom(engine.snapshot().history, this.shownSteps);
    if (this.stopRequested || this.autoAnswer) return undefined;

    this.panel.showTimers(engine.dueTimers());
    const answer = await this.prompt.ask(
      gatewayRequest(this.ports.context(engine).nodesById, decision),
    );
    if (answer.action === 'stop') {
      this.stopRequested = true;
      return undefined;
    }
    if (answer.action === 'auto') this.autoAnswer = true;
    return answer.choiceId;
  }
}
