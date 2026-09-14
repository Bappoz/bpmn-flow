import { fetchSampleNames, fetchSampleXml } from './api.js';

/**
 * De onde saem os diagramas de exemplo.
 *
 * Com o `@bpmn-flow/server` na frente, a lista vem dele e pode mudar (o botão
 * "Salvar no repositório" grava lá). Sem servidor — a demo estática do GitHub
 * Pages — os arquivos de `bpmn-files/` vêm embutidos no bundle.
 */
export class SampleSource {
  /** Verdadeiro quando a lista veio do servidor. */
  private remote = false;

  constructor(
    private readonly select: HTMLSelectElement,
    private readonly bundled: Record<string, string>,
  ) {}

  /** Preenche o seletor, preferindo o servidor quando ele responde. */
  async populate(): Promise<void> {
    this.select.replaceChildren();
    const names = await fetchSampleNames();
    if (names) {
      this.remote = true;
      for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
        this.select.append(new Option(name, name));
      }
      return;
    }
    this.remote = false;
    for (const [path, xml] of Object.entries(this.bundled).sort(([a], [b]) => a.localeCompare(b))) {
      const name = path.split('/').pop()?.replace('.bpmn', '') ?? path;
      const option = new Option(name, name);
      // O XML embutido viaja no próprio option: sem servidor, não há de onde buscar.
      option.dataset.xml = xml;
      this.select.append(option);
    }
  }

  /** XML do exemplo selecionado, ou `undefined` quando não há seleção. */
  async read(): Promise<string | undefined> {
    const name = this.select.value;
    if (!name) return undefined;
    return this.remote ? await fetchSampleXml(name) : this.select.selectedOptions[0]?.dataset.xml;
  }

  /** Seleciona um exemplo pelo nome, depois de salvá-lo por exemplo. */
  choose(name: string): void {
    this.select.value = name;
  }
}
