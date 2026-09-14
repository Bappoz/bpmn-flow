/**
 * Ponto de entrada do pedaço pesado do bundle.
 *
 * `bpmn-visualization` (e o `mxgraph` por baixo dele) é a maior parte do
 * playground. Isolar o import aqui faz o Vite emitir um chunk próprio, baixado
 * quando um diagrama é carregado — não junto do HTML.
 */
import '@bpmn-flow/viewer/styles.css';

export { BpmnFlowViewer, ExecutionReplay } from '@bpmn-flow/viewer';
