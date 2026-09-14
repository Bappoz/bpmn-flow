import './style.css';
import { queryElements } from './elements.js';
import { EditMode } from './edit-mode.js';
import { Panel } from './panel.js';
import { RunMode } from './run-mode.js';
import { SampleSource } from './samples.js';

/**
 * Montagem da aplicação: resolve os elementos, monta os módulos e liga os
 * eventos a eles.
 *
 * Nada de lógica aqui — carregamento de exemplos, execução, condução, painel e
 * edição são cada um o seu módulo, com o seu próprio estado.
 */

const BUNDLED = import.meta.glob<string>('../../../bpmn-files/*.bpmn', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const els = queryElements();
const samples = new SampleSource(els.sample, BUNDLED);

const panel: Panel = new Panel(els, {
  complete: (tokenId) => void run.complete(tokenId),
  signal: (nodeId) => void run.signal(nodeId),
  fastForward: () => void run.fastForward(),
});

const run = new RunMode(els, panel);
const edit = new EditMode(els, panel, samples, {
  currentXml: () => run.currentXml(),
  refreshSamples: () => samples.populate(),
});

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
  if (editing) await edit.fit();
}

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
    if (els.editorEl.classList.contains('hidden')) run.fit();
    else void edit.fit();
  }, 220);
}

// --- Wiring ------------------------------------------------------------

/** Carrega o exemplo selecionado no seletor. */
async function loadSelectedSample(): Promise<void> {
  const xml = await samples.read();
  if (xml) await run.loadDiagram(xml);
}

els.sample.addEventListener('change', () => void loadSelectedSample());
els.file.addEventListener('change', () => {
  void (async () => {
    const file = els.file.files?.[0];
    if (file) await run.loadDiagram(await file.text());
  })();
});
els.start.addEventListener('click', () => void run.start());
els.autorun.addEventListener('click', () => void run.autorun());
els.reset.addEventListener('click', () => void run.reload());
els.fit.addEventListener('click', () => run.fit());
els.replay.addEventListener('click', () => void run.guided.toggle());
els.panelToggle.addEventListener('click', () => togglePanel());
els.metrics.addEventListener('click', () => run.toggleMetrics());

els.modeRun.addEventListener('click', () => void setMode('run'));
els.modeEdit.addEventListener('click', () => void setMode('edit'));
els.newDiagram.addEventListener('click', () => void edit.newDiagram());
els.editFile.addEventListener('change', () => {
  void (async () => {
    const file = els.editFile.files?.[0];
    if (file) await edit.open(await file.text());
  })();
});
els.validate.addEventListener('click', () => void edit.validate());
els.save.addEventListener('click', () => void edit.save());
els.editFit.addEventListener('click', () => void edit.fit());

async function init(): Promise<void> {
  togglePanel(localStorage.getItem(PANEL_KEY) === 'true');
  await samples.populate();
  await loadSelectedSample();
}

void init();
