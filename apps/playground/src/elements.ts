/**
 * Os nós do HTML que a aplicação manipula, resolvidos uma vez.
 *
 * Ficam num módulo só para que os outros recebam o que precisam por parâmetro,
 * em vez de procurarem no documento por conta própria.
 */
export interface Elements {
  modeRun: HTMLButtonElement;
  modeEdit: HTMLButtonElement;
  runToolbar: HTMLDivElement;
  editToolbar: HTMLDivElement;
  diagram: HTMLElement;
  editorEl: HTMLElement;
  sample: HTMLSelectElement;
  file: HTMLInputElement;
  start: HTMLButtonElement;
  autorun: HTMLButtonElement;
  reset: HTMLButtonElement;
  fit: HTMLButtonElement;
  replay: HTMLButtonElement;
  metrics: HTMLButtonElement;
  newDiagram: HTMLButtonElement;
  editFile: HTMLInputElement;
  saveName: HTMLInputElement;
  validate: HTMLButtonElement;
  save: HTMLButtonElement;
  editFit: HTMLButtonElement;
  validation: HTMLDivElement;
  status: HTMLParagraphElement;
  actions: HTMLDivElement;
  timers: HTMLDivElement;
  variableHints: HTMLDivElement;
  panelToggle: HTMLButtonElement;
  appMain: HTMLElement;
  variables: HTMLTextAreaElement;
  variablesView: HTMLPreElement;
  log: HTMLOListElement;
}

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

/** @throws quando o HTML não tem algum dos elementos esperados. */
export function queryElements(): Elements {
  return {
    modeRun: byId('mode-run'),
    modeEdit: byId('mode-edit'),
    runToolbar: byId('run-toolbar'),
    editToolbar: byId('edit-toolbar'),
    diagram: byId('diagram'),
    editorEl: byId('editor'),
    sample: byId('sample'),
    file: byId('file'),
    start: byId('start'),
    autorun: byId('autorun'),
    reset: byId('reset'),
    fit: byId('fit'),
    replay: byId('replay'),
    metrics: byId('metrics'),
    newDiagram: byId('new-diagram'),
    editFile: byId('edit-file'),
    saveName: byId('save-name'),
    validate: byId('validate'),
    save: byId('save'),
    editFit: byId('edit-fit'),
    validation: byId('validation'),
    status: byId('status'),
    actions: byId('actions'),
    timers: byId('timers'),
    variableHints: byId('variable-hints'),
    panelToggle: byId('panel-toggle'),
    appMain: byId('app-main'),
    variables: byId('variables'),
    variablesView: byId('variables-view'),
    log: byId('log'),
  };
}
