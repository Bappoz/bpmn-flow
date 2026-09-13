import {
  decisionsAfter,
  evaluateCondition,
  findExecutableProcess,
  parseBpmn,
  processVariables,
  suggestVariables,
  WorkflowEngine,
  type BpmnModel,
  type DecisionOption,
  type DecisionPoint,
  type EngineMode,
  type ExecutionSnapshot,
  type FlowNode,
  type GatewayDecision,
  type ProcessModel,
  type HistoryEntry,
  type PendingTask,
  type TokenSnapshot,
  type VariableUsage,
  type ValidationResult,
} from '@bpmn-flow/core';
import { BpmnFlowViewer, ExecutionReplay } from '@bpmn-flow/viewer';
import '@bpmn-flow/viewer/styles.css';
import 'bpmn-js/dist/assets/diagram-js.css';
import 'bpmn-js/dist/assets/bpmn-js.css';
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css';
import './style.css';
import { fetchSampleNames, fetchSampleXml, saveSample } from './api.js';
import { BpmnEditor } from './editor.js';
import {
  formatValue,
  StepPrompt,
  type PromptChoice,
  type PromptField,
  type StepAnswer,
  type StepRequest,
} from './prompt.js';

const BUNDLED = import.meta.glob('../../../bpmn-files/*.bpmn', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const els = {
  modeRun: $<HTMLButtonElement>('mode-run'),
  modeEdit: $<HTMLButtonElement>('mode-edit'),
  runToolbar: $<HTMLDivElement>('run-toolbar'),
  editToolbar: $<HTMLDivElement>('edit-toolbar'),
  diagram: $<HTMLElement>('diagram'),
  editorEl: $<HTMLElement>('editor'),
  sample: $<HTMLSelectElement>('sample'),
  file: $<HTMLInputElement>('file'),
  start: $<HTMLButtonElement>('start'),
  autorun: $<HTMLButtonElement>('autorun'),
  reset: $<HTMLButtonElement>('reset'),
  fit: $<HTMLButtonElement>('fit'),
  replay: $<HTMLButtonElement>('replay'),
  metrics: $<HTMLButtonElement>('metrics'),
  newDiagram: $<HTMLButtonElement>('new-diagram'),
  editFile: $<HTMLInputElement>('edit-file'),
  saveName: $<HTMLInputElement>('save-name'),
  validate: $<HTMLButtonElement>('validate'),
  save: $<HTMLButtonElement>('save'),
  editFit: $<HTMLButtonElement>('edit-fit'),
  validation: $<HTMLDivElement>('validation'),
  status: $<HTMLParagraphElement>('status'),
  actions: $<HTMLDivElement>('actions'),
  timers: $<HTMLDivElement>('timers'),
  variableHints: $<HTMLDivElement>('variable-hints'),
  panelToggle: $<HTMLButtonElement>('panel-toggle'),
  appMain: $<HTMLElement>('app-main'),
  variables: $<HTMLTextAreaElement>('variables'),
  variablesView: $<HTMLPreElement>('variables-view'),
  log: $<HTMLOListElement>('log'),
};

const viewer = new BpmnFlowViewer({ container: els.diagram });

let currentXml = '';
let currentModel: BpmnModel | undefined;
let nodesById = new Map<string, FlowNode>();
let engine: WorkflowEngine | undefined;
let unbindViewer: (() => void) | undefined;
let editor: BpmnEditor | undefined;
let replayTimer: number | undefined;
let metricsShown = false;
let editorXml: string | undefined;
let remoteSamples = false;

const prompt = new StepPrompt();
/** Uma execução conduzida está em andamento (botão Run). */
let guiding = false;
let stopRequested = false;
/** O operador pediu para seguir até o fim sem mais perguntas. */
let autoAnswer = false;
/** Passos do histórico já animados na condução atual. */
let shownSteps = 0;
/**
 * Gateways cuja escolha já foi respondida no diálogo da atividade anterior —
 * quando o token chegar neles, decidem pelos dados sem perguntar de novo.
 */
const answeredGateways = new Set<string>();

/** Intervalo entre dois passos da animação, em milissegundos. */
const STEP_MS = 500;
/** Teto de paradas atendidas numa condução, contra processo que nunca acaba. */
const MAX_STEPS = 200;

// --- Sample loading ----------------------------------------------------

async function populateSamples(): Promise<void> {
  els.sample.replaceChildren();
  const names = await fetchSampleNames();
  if (names) {
    remoteSamples = true;
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      els.sample.append(new Option(name, name));
    }
    return;
  }
  remoteSamples = false;
  for (const [path, xml] of Object.entries(BUNDLED).sort(([a], [b]) => a.localeCompare(b))) {
    const name = path.split('/').pop()?.replace('.bpmn', '') ?? path;
    const option = new Option(name, name);
    option.dataset.xml = xml;
    els.sample.append(option);
  }
}

async function loadSelectedSample(): Promise<void> {
  const name = els.sample.value;
  if (!name) return;
  const xml = remoteSamples
    ? await fetchSampleXml(name)
    : els.sample.selectedOptions[0]?.dataset.xml;
  if (xml) await loadDiagram(xml);
}

// --- Execution (run mode) ---------------------------------------------

function flattenNodes(model: BpmnModel): Map<string, FlowNode> {
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

const label = (nodeId: string): string => nodesById.get(nodeId)?.name ?? nodeId;

function log(message: string): void {
  const item = document.createElement('li');
  item.textContent = message;
  els.log.prepend(item);
}

async function loadDiagram(xml: string): Promise<void> {
  currentXml = xml;
  currentModel = await parseBpmn(xml);
  nodesById = flattenNodes(currentModel);
  renderVariableHints();
  await viewer.load(xml);
  teardownEngine();
  stopGuided();
  metricsShown = false;
  els.log.replaceChildren();
  els.actions.replaceChildren();
  els.variablesView.textContent = '';
  els.timers.replaceChildren();
  const loaded = mainProcess();
  els.status.textContent = `Diagrama carregado: ${loaded?.name ?? loaded?.id ?? 'processo'}.`;
}

/**
 * O processo que o playground executa e descreve. Uma colaboracao costuma
 * declarar pools black-box antes do pool que roda de fato, entao o primeiro
 * processo do arquivo nao serve.
 */
function mainProcess(): ProcessModel | undefined {
  return currentModel ? findExecutableProcess(currentModel) : undefined;
}

function teardownEngine(): void {
  unbindViewer?.();
  unbindViewer = undefined;
  engine = undefined;
}

function readVariables(): Record<string, unknown> {
  const raw = els.variables.value.trim();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function newEngine(mode: EngineMode, variables: Record<string, unknown>): WorkflowEngine {
  const process = mainProcess();
  if (!process) throw new Error('Nenhum processo executável no diagrama.');
  const created = new WorkflowEngine(process, { mode, variables, decide: onGatewayDecision });
  unbindViewer = viewer.bindEngine(created);
  created.on('node.enter', (e) => log(`Entrou: ${label(e.nodeId)}`));
  created.on('wait', (e) => log(`Aguardando: ${label(e.nodeId)} (${e.reason})`));
  created.on('process.end', (e) => log(`Processo ${e.status}.`));
  return created;
}

function render(snapshot: ExecutionSnapshot): void {
  viewer.applySnapshot(snapshot);
  els.status.textContent = `Status: ${snapshot.status} - ${snapshot.tokens.length} token(s) ativos, ${snapshot.completedNodes.length} nó(s) concluídos.`;
  els.variablesView.textContent = JSON.stringify(snapshot.variables, null, 2);
  renderActions(snapshot.tokens);
  renderTimers();
}

function renderActions(tokens: TokenSnapshot[]): void {
  els.actions.replaceChildren();
  const tasks = engine?.tasks() ?? [];
  if (tasks.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'Nenhuma ação pendente.';
    els.actions.append(none);
    return;
  }
  for (const task of tasks) addTaskCard(task);
  // Gateways baseados em evento pedem um gatilho por alternativa.
  for (const token of tokens) {
    if (token.waitReason === 'eventBasedGateway') addEventGatewayButtons(token);
  }
}

/** Cartão de tarefa: quem executa, por que parou e o que a instância enxerga. */
function addTaskCard(task: PendingTask): void {
  const card = document.createElement('div');
  card.className = 'task';

  const title = document.createElement('p');
  title.className = 'task-title';
  title.textContent = task.name ?? task.nodeId;
  card.append(title);

  const badges = document.createElement('p');
  badges.className = 'task-badges';
  for (const text of [task.lane, ...task.candidates].filter(Boolean)) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = text as string;
    badges.append(badge);
  }
  const reason = document.createElement('span');
  reason.className = 'badge badge-muted';
  reason.textContent = task.reason;
  badges.append(reason);
  card.append(badges);

  // Numa atividade multi-instância, mostra o que é próprio desta instância.
  const loop = nodesById.get(task.nodeId)?.loop;
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
    if (task.reason === 'catchEvent') void signal(task.nodeId);
    else void complete(task.tokenId);
  });
  card.append(button);
  els.actions.append(card);
}

function addEventGatewayButtons(token: TokenSnapshot): void {
  const node = nodesById.get(token.nodeId);
  for (const flowId of node?.outgoing ?? []) {
    const flow = mainProcess()?.sequenceFlows.find((f) => f.id === flowId);
    if (flow) actionButton(`Sinalizar ${label(flow.targetRef)}`, () => signal(flow.targetRef));
  }
}

function actionButton(text: string, onClick: () => void): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', onClick);
  els.actions.append(button);
}

/**
 * Mostra as variáveis que o diagrama realmente lê — com a expressão que as usa —
 * e preenche a caixa JSON com um valor que faz cada caminho acontecer.
 */
function renderVariableHints(): void {
  els.variableHints.replaceChildren();
  const process = mainProcess();
  if (!process) return;

  const usages = processVariables(process);
  if (usages.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'Este processo não lê nenhuma variável.';
    els.variableHints.append(none);
  } else {
    for (const usage of usages) els.variableHints.append(hintCard(usage));
  }

  // A caixa JSON começa com o que faz o processo andar, em vez de "{}".
  els.variables.value = JSON.stringify(suggestVariables(process), null, 2);
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

/** Timers pendentes, com atalho para adiantar o relógio na demonstração. */
function renderTimers(): void {
  els.timers.replaceChildren();
  const timers = engine?.dueTimers() ?? [];
  if (timers.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = 'Nenhum timer pendente.';
    els.timers.append(none);
    return;
  }
  for (const timer of timers) {
    const line = document.createElement('p');
    line.className = 'timer';
    const remaining = Math.max(0, Math.round((timer.dueAt - Date.now()) / 1000));
    line.textContent = `${label(timer.nodeId)} · ${timer.definition} · faltam ${remaining}s`;
    els.timers.append(line);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Adiantar relógio';
  button.addEventListener('click', () => void fastForward());
  els.timers.append(button);
}

/**
 * Executa passo a passo. Anima no diagrama o que a engine já fez e, a cada
 * parada, abre um diálogo com o que só uma pessoa decide: concluir a atividade,
 * informar um valor, escolher o caminho. Clicar de novo interrompe.
 */
async function guidedRun(): Promise<void> {
  if (guiding) {
    stopGuided();
    return;
  }
  guiding = true;
  stopRequested = false;
  autoAnswer = false;
  els.replay.textContent = 'Parar';
  try {
    engine ??= newEngine('automation', readVariables());
    // Enquanto conduz, quem pinta é a animação — não os eventos da engine.
    unbindViewer?.();
    unbindViewer = undefined;
    viewer.clear();

    shownSteps = 0;
    answeredGateways.clear();
    let snapshot = engine.snapshot();
    if (snapshot.status === 'idle') snapshot = await engine.start();
    for (let step = 0; step < MAX_STEPS && !stopRequested; step++) {
      shownSteps = await animateFrom(snapshot.history, shownSteps);
      if (stopRequested || snapshot.status !== 'waiting') break;
      // O painel acompanha a parada, para o diálogo e a lateral contarem a
      // mesma história.
      renderActions(snapshot.tokens);
      renderTimers();
      const next = await answerStep(snapshot);
      if (!next) break;
      snapshot = next;
      els.variablesView.textContent = JSON.stringify(snapshot.variables, null, 2);
    }
  } catch (error) {
    fail(error);
  } finally {
    finishGuided();
  }
}

/** Percorre o histórico do passo `from` até o fim; devolve quantos já foram. */
function animateFrom(history: HistoryEntry[], from: number): Promise<number> {
  const replay = new ExecutionReplay(history);
  if (replay.length <= from) return Promise.resolve(from);
  replay.seek(from - 1);
  return new Promise<number>((resolve) => {
    replayTimer = window.setInterval(() => {
      const frame = stopRequested ? undefined : replay.next();
      if (!frame) {
        window.clearInterval(replayTimer);
        replayTimer = undefined;
        resolve(replay.position + 1);
        return;
      }
      viewer.applyReplayFrame(frame);
      els.status.textContent = `Passo ${frame.index + 1}/${replay.length}: ${label(
        frame.entry.nodeId,
      )} (${frame.entry.event})`;
    }, STEP_MS);
  });
}

/** Interrompe a condução: para a animação e fecha um diálogo aberto. */
function stopGuided(): void {
  stopRequested = true;
  prompt.close();
}

/** Devolve o diagrama ao estado real da execução e religa a pintura ao vivo. */
function finishGuided(): void {
  guiding = false;
  stopRequested = false;
  autoAnswer = false;
  if (replayTimer !== undefined) window.clearInterval(replayTimer);
  replayTimer = undefined;
  prompt.close();
  els.replay.textContent = 'Run';
  if (!engine) return;
  unbindViewer ??= viewer.bindEngine(engine);
  render(engine.snapshot());
}

/** O que perguntar numa parada, e o que fazer com a resposta. */
interface Step {
  request: StepRequest;
  /** Resposta usada quando o operador pediu para seguir sem perguntar. */
  defaults: Record<string, unknown>;
  /** Gateways adiante cuja escolha este diálogo já cobre. */
  decided: string[];
  apply: (answer: StepAnswer) => Promise<ExecutionSnapshot>;
}

/** Pergunta a parada atual (ou responde sozinho) e devolve o estado seguinte. */
async function answerStep(snapshot: ExecutionSnapshot): Promise<ExecutionSnapshot | undefined> {
  const step = nextStep(snapshot);
  if (!step) return undefined;
  const answer: StepAnswer = autoAnswer
    ? { action: 'confirm', values: step.defaults, choiceId: step.request.selected }
    : await prompt.ask(step.request);
  if (answer.action === 'stop') return undefined;
  if (answer.action === 'auto') autoAnswer = true;
  // O gateway logo à frente não precisa perguntar de novo: acabou de ser
  // respondido aqui, e os valores informados é que vão decidir.
  for (const nodeId of step.decided) answeredGateways.add(nodeId);
  return step.apply(answer);
}

/** A primeira parada que depende de alguém de fora. */
function nextStep(snapshot: ExecutionSnapshot): Step | undefined {
  if (!engine) return undefined;
  const active = engine;

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
  if (task) return taskStep(active, task);

  const gateway = snapshot.tokens.find((token) => token.waitReason === 'eventBasedGateway');
  if (gateway) return gatewayStep(active, gateway);

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
function taskStep(active: WorkflowEngine, task: PendingTask): Step {
  const trigger = task.reason === 'catchEvent' || task.reason === 'receiveTask';
  const timer = timerOf(nodesById.get(task.nodeId));
  const ahead = decisionPrompt(task.nodeId, task.variables);
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
      selected: ahead.selected,
      confirmLabel: timer ? 'Disparar agora' : trigger ? 'Sinalizar' : 'Concluir',
    },
    defaults: ahead.defaults,
    decided: ahead.decided,
    apply: (answer) =>
      trigger
        ? active.signal(task.nodeId, answer.values)
        : active.completeTask(task.tokenId, answer.values),
  };
}

/** Definição do timer do nó, quando ele espera o relógio. */
function timerOf(node: FlowNode | undefined): string | undefined {
  for (const detail of node?.events ?? (node?.event ? [node.event] : [])) {
    if (detail.kind === 'timer') return detail.timer ?? 'timer';
  }
  return undefined;
}

/** Gateway baseado em evento: a escolha é qual gatilho chega primeiro. */
function gatewayStep(active: WorkflowEngine, token: TokenSnapshot): Step {
  const flows = mainProcess()?.sequenceFlows ?? [];
  const choices: PromptChoice[] = [];
  for (const flowId of nodesById.get(token.nodeId)?.outgoing ?? []) {
    const flow = flows.find((candidate) => candidate.id === flowId);
    if (flow) choices.push({ id: flow.targetRef, label: label(flow.targetRef) });
  }
  const first = choices[0]?.id;
  return {
    request: {
      title: label(token.nodeId),
      reason: 'Gateway baseado em evento: o primeiro gatilho a chegar decide o caminho.',
      badges: [],
      choices,
      fields: [],
      selected: first,
      confirmLabel: 'Sinalizar',
    },
    defaults: {},
    decided: [],
    apply: (answer) => active.signal(answer.choiceId ?? first ?? token.nodeId),
  };
}

/**
 * O gateway pergunta antes de rotear o token. Só durante a condução, e só
 * quando a escolha não foi respondida no diálogo da atividade anterior — fora
 * disso o processo decide pelos dados, como manda a especificação.
 */
async function onGatewayDecision(decision: GatewayDecision): Promise<string | undefined> {
  if (!guiding || stopRequested || !engine) return undefined;
  if (answeredGateways.delete(decision.nodeId)) return undefined;
  // Alcança o gateway no diagrama antes de perguntar sobre ele.
  shownSteps = await animateFrom(engine.snapshot().history, shownSteps);
  if (stopRequested || autoAnswer) return undefined;

  renderTimers();
  const answer = await prompt.ask(gatewayRequest(decision));
  if (answer.action === 'stop') {
    stopRequested = true;
    return undefined;
  }
  if (answer.action === 'auto') autoAnswer = true;
  return answer.choiceId;
}

/** O diálogo de um gateway: os caminhos, e o que os dados escolheriam. */
function gatewayRequest(decision: GatewayDecision): StepRequest {
  const byData = decision.options.find((option) => option.flowId === decision.suggested[0]);
  const name = (option: (typeof decision.options)[number]): string =>
    option.name ?? label(option.targetId);
  return {
    title: decision.name ?? decision.nodeId,
    reason: byData
      ? `Pelas condições o processo iria para "${name(byData)}"; a escolha aqui vale mais.`
      : 'Nenhuma condição fecha: escolha por onde seguir.',
    badges: [],
    choices: decision.options.map((option) => ({
      id: option.flowId,
      label: name(option),
      hint: option.condition ?? (option.isDefault ? 'caminho padrão' : undefined),
    })),
    selected: decision.suggested[0],
    fields: [],
    confirmLabel: 'Seguir',
  };
}

/**
 * As escolhas e os valores que a execução vai encontrar logo depois deste nó.
 * Só o primeiro ponto de decisão vira opções de caminho — os seguintes ainda
 * dependem do que for respondido aqui, então entram apenas como valores.
 */
function decisionPrompt(
  nodeId: string,
  variables: Record<string, unknown>,
): {
  choices: PromptChoice[];
  fields: PromptField[];
  defaults: Record<string, unknown>;
  decided: string[];
  selected?: string;
} {
  const process = mainProcess();
  const decisions = process ? decisionsAfter(process, nodeId) : [];
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
          hint: option.condition ?? (option.isDefault ? 'caminho padrão' : undefined),
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
    selected,
  };
}

/** O caminho que as variáveis de agora já escolheriam. */
function matchingOption(
  decision: DecisionPoint,
  variables: Record<string, unknown>,
): DecisionOption | undefined {
  const conditional = decision.options.filter((option) => !option.isDefault);
  const match = conditional.find(
    (option) => !option.condition || evaluateCondition(option.condition, variables),
  );
  return match ?? decision.options.find((option) => option.isDefault) ?? decision.options[0];
}

/** Liga/desliga as etiquetas de tempo médio por atividade. */
function toggleMetrics(): void {
  if (!engine) return;
  const metrics = engine.metrics();
  if (metricsShown) viewer.clearMetrics(metrics);
  else viewer.showMetrics(metrics);
  metricsShown = !metricsShown;
}

async function fastForward(): Promise<void> {
  if (!engine) return;
  const next = engine.nextTimerAt();
  if (next === undefined) return;
  try {
    render(await engine.tick(next));
  } catch (error) {
    fail(error);
  }
}

async function start(): Promise<void> {
  try {
    engine = newEngine('automation', readVariables());
    render(await engine.start());
  } catch (error) {
    fail(error);
  }
}

async function autorun(): Promise<void> {
  try {
    engine = newEngine('auto', readVariables());
    render(await engine.start());
  } catch (error) {
    fail(error);
  }
}

async function complete(tokenId: string): Promise<void> {
  if (!engine) return;
  try {
    render(await engine.completeTask(tokenId));
  } catch (error) {
    fail(error);
  }
}

async function signal(name: string): Promise<void> {
  if (!engine) return;
  try {
    render(await engine.signal(name));
  } catch (error) {
    fail(error);
  }
}

function fail(error: unknown): void {
  els.status.textContent = `Erro: ${error instanceof Error ? error.message : String(error)}`;
}

// --- Editor (edit mode) ------------------------------------------------

async function ensureEditor(): Promise<BpmnEditor> {
  editor ??= new BpmnEditor(els.editorEl);
  // Reabre sempre que o diagrama do modo executar mudou desde a ultima abertura,
  // para o editor nunca mostrar um diagrama antigo.
  if (currentXml && currentXml !== editorXml) {
    try {
      await editor.open(currentXml);
      editorXml = currentXml;
    } catch (error) {
      await editor.newDiagram();
      editorXml = undefined;
      validationMessage(
        `Nao foi possivel abrir o diagrama no editor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (!currentXml && editorXml === undefined) {
    await editor.newDiagram();
  }
  return editor;
}

function renderValidation(result: ValidationResult, extra?: string): void {
  els.validation.replaceChildren();
  const header = document.createElement('p');
  header.className = result.valid ? 'valid-ok' : 'valid-err';
  header.textContent = result.valid ? 'Diagrama válido.' : 'Diagrama inválido.';
  els.validation.append(header);
  for (const issue of result.issues) {
    const item = document.createElement('p');
    item.className = `issue issue-${issue.severity}`;
    item.textContent = `${issue.severity === 'error' ? 'Erro' : 'Aviso'}: ${issue.message}`;
    els.validation.append(item);
  }
  if (extra) {
    const note = document.createElement('p');
    note.className = 'valid-ok';
    note.textContent = extra;
    els.validation.append(note);
  }
}

function validationMessage(message: string, ok = false): void {
  els.validation.replaceChildren();
  const p = document.createElement('p');
  p.className = ok ? 'valid-ok' : 'valid-err';
  p.textContent = message;
  els.validation.append(p);
}

async function validate(): Promise<void> {
  const result = await (await ensureEditor()).validate();
  renderValidation(result);
}

async function save(): Promise<void> {
  const name = els.saveName.value.trim();
  if (!name) {
    validationMessage('Informe um nome para o arquivo.');
    return;
  }
  const active = await ensureEditor();
  const result = await active.validate();
  renderValidation(result);
  if (!result.valid) return;
  try {
    const saved = await saveSample(name, await active.getXml());
    await populateSamples();
    els.sample.value = saved.name;
    renderValidation(result, `Salvo como ${saved.name}.bpmn no repositório.`);
  } catch (error) {
    validationMessage(error instanceof Error ? error.message : String(error));
  }
}

// --- Mode switching ----------------------------------------------------

async function setMode(mode: 'run' | 'edit'): Promise<void> {
  const editing = mode === 'edit';
  els.modeEdit.classList.toggle('active', editing);
  els.modeRun.classList.toggle('active', !editing);
  els.runToolbar.classList.toggle('hidden', editing);
  els.editToolbar.classList.toggle('hidden', !editing);
  els.diagram.classList.toggle('hidden', editing);
  els.editorEl.classList.toggle('hidden', !editing);
  for (const block of document.querySelectorAll<HTMLElement>('[data-mode]')) {
    block.hidden = block.dataset.mode !== mode;
  }
  if (editing) {
    const active = await ensureEditor();
    active.fit();
  }
}

// --- Wiring ------------------------------------------------------------

els.sample.addEventListener('change', () => void loadSelectedSample());
els.file.addEventListener('change', async () => {
  const file = els.file.files?.[0];
  if (file) await loadDiagram(await file.text());
});
els.start.addEventListener('click', () => void start());
els.autorun.addEventListener('click', () => void autorun());
els.reset.addEventListener('click', () => {
  if (currentXml) void loadDiagram(currentXml);
});
els.fit.addEventListener('click', () => viewer.fit());
els.replay.addEventListener('click', () => void guidedRun());
els.panelToggle.addEventListener('click', () => togglePanel());
els.metrics.addEventListener('click', () => toggleMetrics());

els.modeRun.addEventListener('click', () => void setMode('run'));
els.modeEdit.addEventListener('click', () => void setMode('edit'));
els.newDiagram.addEventListener('click', async () => {
  const active = await ensureEditor();
  await active.newDiagram();
  editorXml = currentXml;
  validationMessage('Novo diagrama criado.', true);
});
els.editFile.addEventListener('change', async () => {
  const file = els.editFile.files?.[0];
  if (!file) return;
  const xml = await file.text();
  await (await ensureEditor()).open(xml);
  editorXml = xml;
});
els.validate.addEventListener('click', () => void validate());
els.save.addEventListener('click', () => void save());
els.editFit.addEventListener('click', () => void ensureEditor().then((e) => e.fit()));

const PANEL_KEY = 'bpmn-flow:panel-collapsed';

/** Recolhe ou expande o painel lateral, reenquadrando o diagrama depois. */
function togglePanel(collapsed = !els.appMain.classList.contains('panel-collapsed')): void {
  els.appMain.classList.toggle('panel-collapsed', collapsed);
  els.panelToggle.textContent = collapsed ? '‹' : '›';
  els.panelToggle.title = collapsed ? 'Expandir painel' : 'Recolher painel';
  els.panelToggle.setAttribute('aria-expanded', String(!collapsed));
  localStorage.setItem(PANEL_KEY, String(collapsed));
  // A área do canvas mudou de tamanho: reenquadra depois da transição.
  window.setTimeout(() => {
    if (els.editorEl.classList.contains('hidden')) viewer.fit();
    else void ensureEditor().then((active) => active.fit());
  }, 220);
}

async function init(): Promise<void> {
  togglePanel(localStorage.getItem(PANEL_KEY) === 'true');
  await populateSamples();
  await loadSelectedSample();
}

void init();
