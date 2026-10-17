import { validateBpmn, type ValidationResult } from '@bpmn-flow/core';
import type { ElementLike } from 'diagram-js/lib/model/Types.js';
import { ensureLayout } from '@bpmn-flow/viewer';
import BpmnModeler from 'bpmn-js/lib/Modeler';

/** A valid starting point with one start event and diagram interchange. */
const BLANK = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  id="Definitions_new" targetNamespace="http://bpmn-flow">
  <bpmn:process id="Process_new" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Start" />
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
  scrollToElement(element: ElementLike): void;
}

interface ElementRegistry {
  get(id: string): ElementLike | undefined;
}

interface Selection {
  select(element: ElementLike): void;
}

/**
 * Browser BPMN editor for importing, creating, exporting, and validating
 * diagrams. The host application owns persistence and surrounding UI.
 */
export class BpmnEditor {
  private readonly modeler: BpmnModeler;

  constructor(container: HTMLElement) {
    this.modeler = new BpmnModeler({ container });
  }

  /** Replaces the current diagram with a valid BPMN process. */
  async newDiagram(): Promise<void> {
    await this.modeler.importXML(BLANK);
    this.fit();
  }

  /**
   * Imports a diagram, computing layout when it lacks diagram interchange.
   * The input string is never modified; callers persist only exported XML.
   */
  async open(xml: string): Promise<void> {
    await this.modeler.importXML(await ensureLayout(xml));
    this.fit();
  }

  /** Exports the current diagram as formatted BPMN 2.0 XML. */
  async getXml(): Promise<string> {
    const { xml } = await this.modeler.saveXML({ format: true });
    return xml ?? '';
  }

  /** Validates the exported XML with the BPMN Flow core. */
  async validate(): Promise<ValidationResult> {
    return validateBpmn(await this.getXml());
  }

  /**
   * Subscribes to user edits, including undo and redo. Returns an unsubscribe
   * function so the host can clean up when its editing surface is removed.
   */
  onChange(listener: () => void): () => void {
    this.modeler.on('commandStack.changed', listener);
    return () => this.modeler.off('commandStack.changed', listener);
  }

  /** Scrolls to and selects an element by BPMN id. Returns false if absent. */
  focusElement(id: string): boolean {
    const element = this.modeler.get<ElementRegistry>('elementRegistry').get(id);
    if (!element) return false;
    this.modeler.get<Canvas>('canvas').scrollToElement(element);
    this.modeler.get<Selection>('selection').select(element);
    return true;
  }

  /** Fits the modeler canvas to its current viewport. */
  fit(): void {
    this.modeler.get<Canvas>('canvas').zoom('fit-viewport');
  }

  /** Releases the bpmn-js resources attached to the container. */
  destroy(): void {
    this.modeler.destroy();
  }
}
