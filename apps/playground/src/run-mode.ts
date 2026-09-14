import { findExecutableProcess, parseBpmn, WorkflowEngine } from '@bpmn-flow/core';
import type {
  BpmnModel,
  EngineMode,
  ExecutionSnapshot,
  FlowNode,
  HistoryEntry,
  ProcessModel,
} from '@bpmn-flow/core';
import type { BpmnFlowViewer } from '@bpmn-flow/viewer';
import type * as DiagramView from './diagram-view.js';
import type { Elements } from './elements.js';
import { flattenNodes, labelOf, type GuidedContext } from './guided.js';
import { GuidedRun } from './guided-run.js';
import type { Panel } from './panel.js';

/**
 * O modo executar: carrega um diagrama, cria o motor e mantém o painel e o
 * desenho em dia com a execução.
 *
 * Tudo que antes eram variáveis soltas no módulo — diagrama atual, modelo,
 * motor, viewer, se as métricas estão à mostra — é estado desta classe.
 */
export class RunMode {
  private xml = '';
  private model: BpmnModel | undefined;
  private nodesById = new Map<string, FlowNode>();
  private engine: WorkflowEngine | undefined;
  private unbindViewer: (() => void) | undefined;
  private metricsShown = false;

  /**
   * O viewer entra por `import()`: traz uma biblioteca de renderização inteira
   * e só é preciso quando há um diagrama para desenhar.
   */
  private viewerModule: typeof DiagramView | undefined;
  private viewer: BpmnFlowViewer | undefined;

  readonly guided: GuidedRun;

  constructor(
    private readonly els: Elements,
    private readonly panel: Panel,
  ) {
    this.guided = new GuidedRun(
      panel,
      {
        engine: () => (this.engine ??= this.newEngine('automation', this.panel.readVariables())),
        context: (engine) => this.contextFor(engine),
        paint: (frame) => this.viewer?.applyReplayFrame(frame),
        replayOf: (history: HistoryEntry[]) =>
          this.viewerModule ? new this.viewerModule.ExecutionReplay(history) : undefined,
        settle: () => this.settleAfterGuidedRun(),
        takeOverPainting: () => {
          this.unbindViewer?.();
          this.unbindViewer = undefined;
          this.viewer?.clear();
        },
        label: (nodeId) => this.label(nodeId),
      },
      els.replay,
    );
  }

  /** XML do diagrama carregado, que o modo editar abre. */
  currentXml(): string {
    return this.xml;
  }

  private label(nodeId: string): string {
    return labelOf(this.nodesById, nodeId);
  }

  /**
   * O processo que o playground executa e descreve. Uma colaboração costuma
   * declarar pools black-box antes do pool que roda de fato, então o primeiro
   * processo do arquivo não serve.
   */
  private mainProcess(): ProcessModel | undefined {
    return this.model ? findExecutableProcess(this.model) : undefined;
  }

  private contextFor(engine: WorkflowEngine): GuidedContext {
    return { engine, process: this.mainProcess(), nodesById: this.nodesById };
  }

  private async ensureViewer(): Promise<BpmnFlowViewer> {
    this.viewerModule ??= await import('./diagram-view.js');
    this.viewer ??= new this.viewerModule.BpmnFlowViewer({ container: this.els.diagram });
    return this.viewer;
  }

  async loadDiagram(xml: string): Promise<void> {
    this.xml = xml;
    this.model = await parseBpmn(xml);
    this.nodesById = flattenNodes(this.model);
    this.panel.describe({ nodesById: this.nodesById, process: this.mainProcess() });
    await (await this.ensureViewer()).load(xml);
    this.teardownEngine();
    this.guided.reset();
    this.metricsShown = false;
    this.panel.clearExecution();
    const loaded = this.mainProcess();
    this.panel.status(`Diagrama carregado: ${loaded?.name ?? loaded?.id ?? 'processo'}.`);
  }

  /** Recarrega o diagrama atual, descartando a execução. */
  async reload(): Promise<void> {
    if (this.xml) await this.loadDiagram(this.xml);
  }

  fit(): void {
    this.viewer?.fit();
  }

  private teardownEngine(): void {
    this.unbindViewer?.();
    this.unbindViewer = undefined;
    this.engine = undefined;
  }

  private newEngine(mode: EngineMode, variables: Record<string, unknown>): WorkflowEngine {
    const process = this.mainProcess();
    if (!process) throw new Error('Nenhum processo executável no diagrama.');
    const created = new WorkflowEngine(process, {
      mode,
      variables,
      // `this.engine` já está atribuído quando um gateway pergunta: o motor é
      // guardado antes de `start()` correr.
      decide: (decision) => this.guided.onGatewayDecision(this.engine, decision),
    });
    this.unbindViewer = this.viewer?.bindEngine(created);
    created.on('node.enter', (e) => this.panel.log(`Entrou: ${this.label(e.nodeId)}`));
    created.on('wait', (e) => this.panel.log(`Aguardando: ${this.label(e.nodeId)} (${e.reason})`));
    created.on('process.end', (e) => this.panel.log(`Processo ${e.status}.`));
    return created;
  }

  private render(snapshot: ExecutionSnapshot): void {
    this.viewer?.applySnapshot(snapshot);
    this.panel.showSnapshot(snapshot, this.engine?.tasks() ?? [], this.engine?.dueTimers() ?? []);
  }

  /** Devolve o diagrama ao estado real da execução e religa a pintura ao vivo. */
  private settleAfterGuidedRun(): void {
    if (!this.engine) return;
    this.unbindViewer ??= this.viewer?.bindEngine(this.engine);
    this.render(this.engine.snapshot());
  }

  async start(): Promise<void> {
    await this.command(async () => {
      this.engine = this.newEngine('automation', this.panel.readVariables());
      return this.engine.start();
    });
  }

  async autorun(): Promise<void> {
    await this.command(async () => {
      this.engine = this.newEngine('auto', this.panel.readVariables());
      return this.engine.start();
    });
  }

  async complete(tokenId: string): Promise<void> {
    const engine = this.engine;
    if (engine) await this.command(() => engine.completeTask(tokenId));
  }

  async signal(name: string): Promise<void> {
    const engine = this.engine;
    if (engine) await this.command(() => engine.signal(name));
  }

  /** Adianta o relógio até o próximo vencimento, para a demonstração. */
  async fastForward(): Promise<void> {
    const engine = this.engine;
    const next = engine?.nextTimerAt();
    if (!engine || next === undefined) return;
    await this.command(() => engine.tick(next));
  }

  /** Liga/desliga as etiquetas de tempo médio por atividade. */
  toggleMetrics(): void {
    if (!this.engine) return;
    const metrics = this.engine.metrics();
    if (this.metricsShown) this.viewer?.clearMetrics(metrics);
    else this.viewer?.showMetrics(metrics);
    this.metricsShown = !this.metricsShown;
  }

  /** Roda um comando do motor e pinta o resultado, ou o erro. */
  private async command(run: () => Promise<ExecutionSnapshot>): Promise<void> {
    try {
      this.render(await run());
    } catch (error) {
      this.panel.fail(error);
    }
  }
}
