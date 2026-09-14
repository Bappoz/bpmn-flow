import type { BpmnEditor } from './editor.js';
import type { Elements } from './elements.js';
import type { Panel } from './panel.js';
import { saveSample } from './api.js';
import type { SampleSource } from './samples.js';

/** O que o modo editar precisa saber do modo executar. */
export interface EditModePorts {
  /** XML atualmente carregado no modo executar, para abrir no editor. */
  currentXml(): string;
  /** Recarrega a lista de exemplos depois de gravar um. */
  refreshSamples(): Promise<void>;
}

/**
 * O modo editar: um `bpmn-js` carregado sob demanda, validado pelo core e
 * gravado no repositório de exemplos quando há servidor.
 *
 * O editor e o XML que ele tem aberto são estado desta classe — antes eram
 * duas variáveis soltas no módulo, e era por isso que "o editor mostra um
 * diagrama antigo" virava um bug difícil de ver.
 */
export class EditMode {
  private editor: BpmnEditor | undefined;
  /** XML que o editor abriu por último, para saber quando reabrir. */
  private openedXml: string | undefined;

  constructor(
    private readonly els: Elements,
    private readonly panel: Panel,
    private readonly samples: SampleSource,
    private readonly ports: EditModePorts,
  ) {}

  /**
   * O editor, carregado na primeira vez que o modo é aberto — é a metade
   * pesada do bundle, e quem só executa processos nunca baixa.
   */
  async ensure(): Promise<BpmnEditor> {
    if (!this.editor) {
      const { BpmnEditor } = await import('./editor.js');
      this.editor = new BpmnEditor(this.els.editorEl);
    }
    const xml = this.ports.currentXml();
    // Reabre sempre que o diagrama do modo executar mudou desde a última
    // abertura, para o editor nunca mostrar um diagrama antigo.
    if (xml && xml !== this.openedXml) {
      try {
        await this.editor.open(xml);
        this.openedXml = xml;
      } catch (error) {
        await this.editor.newDiagram();
        this.openedXml = undefined;
        this.panel.validationMessage(
          `Não foi possível abrir o diagrama no editor: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (!xml && this.openedXml === undefined) {
      await this.editor.newDiagram();
    }
    return this.editor;
  }

  async newDiagram(): Promise<void> {
    const active = await this.ensure();
    await active.newDiagram();
    this.openedXml = this.ports.currentXml();
    this.panel.validationMessage('Novo diagrama criado.', true);
  }

  async open(xml: string): Promise<void> {
    await (await this.ensure()).open(xml);
    this.openedXml = xml;
  }

  async fit(): Promise<void> {
    (await this.ensure()).fit();
  }

  async validate(): Promise<void> {
    this.panel.showValidation(await (await this.ensure()).validate());
  }

  /** Valida e grava no diretório de exemplos do servidor. */
  async save(): Promise<void> {
    const name = this.els.saveName.value.trim();
    if (!name) {
      this.panel.validationMessage('Informe um nome para o arquivo.');
      return;
    }
    const active = await this.ensure();
    const result = await active.validate();
    this.panel.showValidation(result);
    if (!result.valid) return;
    try {
      const saved = await saveSample(name, await active.getXml());
      await this.ports.refreshSamples();
      this.samples.choose(saved.name);
      this.panel.showValidation(result, `Salvo como ${saved.name}.bpmn no repositório.`);
    } catch (error) {
      this.panel.validationMessage(error instanceof Error ? error.message : String(error));
    }
  }
}
