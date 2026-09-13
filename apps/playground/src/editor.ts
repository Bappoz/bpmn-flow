import { validateBpmn, type ValidationResult } from '@bpmn-flow/core';
import { ensureLayout } from '@bpmn-flow/viewer';
import BpmnModeler from 'bpmn-js/lib/Modeler';

/** Blank diagram with a single start event, ready to be extended. */
const BLANK = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  id="Definitions_new" targetNamespace="http://bpmn-flow">
  <bpmn:process id="Process_new" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Início" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_new">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="180" y="160" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

interface Canvas {
  zoom(mode: string): void;
}

/**
 * Wraps a bpmn-js modeler to create and edit BPMN diagrams, exporting valid
 * BPMN 2.0 XML (with diagram interchange) and validating it with the core.
 */
export class BpmnEditor {
  private readonly modeler: BpmnModeler;

  constructor(container: HTMLElement) {
    this.modeler = new BpmnModeler({ container });
  }

  async newDiagram(): Promise<void> {
    await this.modeler.importXML(BLANK);
    this.fit();
  }

  /**
   * Importa um diagrama no editor. O `bpmn-js` exige interchange de diagrama,
   * entao diagramas sem layout sao posicionados antes da importacao.
   */
  async open(xml: string): Promise<void> {
    await this.modeler.importXML(await ensureLayout(xml));
    this.fit();
  }

  async getXml(): Promise<string> {
    const { xml } = await this.modeler.saveXML({ format: true });
    return xml ?? '';
  }

  async validate(): Promise<ValidationResult> {
    return validateBpmn(await this.getXml());
  }

  fit(): void {
    // `get` is generic over the module's type: name it instead of asserting.
    this.modeler.get<Canvas>('canvas').zoom('fit-viewport');
  }

  destroy(): void {
    this.modeler.destroy();
  }
}
