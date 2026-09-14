# BPMN Flow

[![CI](https://github.com/Bappoz/bpmn-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/Bappoz/bpmn-flow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#requisitos)

Biblioteca modular para transformar diagramas BPMN 2.0 em automação de
processos. Faz o parsing do BPMN para um modelo normalizado, executa o processo
com um motor baseado em **tokens** e permite visualizar a execução de forma
interativa no navegador. Cada camada é um pacote independente e reutilizável em
qualquer projeto.

O diagrama não é documentação: a especificação da OMG define semântica de
execução para cada símbolo. É essa semântica — divisão e sincronização de
gateways, eventos de borda, escopos de subprocesso, cancelamento por terminate —
que o motor implementa.

![Execução passo a passo de um processo de compras](docs/media/execucao-passo-a-passo.png)

## Índice

- [Arquitetura](#arquitetura)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Início rápido: usar como biblioteca](#início-rápido-usar-como-biblioteca)
- [Automação com handlers](#automação-com-handlers)
- [Visualização interativa](#visualização-interativa)
- [Playground](#playground)
- [Servidor HTTP e API REST](#servidor-http-e-api-rest)
- [Expressões e confiança](#expressões-e-confiança)
- [Padrões BPMN suportados](#padrões-bpmn-suportados)
- [Limitações conhecidas](#limitações-conhecidas)
- [Desenvolvimento](#desenvolvimento)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Licença](#licença)

## Arquitetura

O repositório é um monorepo (npm workspaces) com quatro módulos:

| Pacote                  | Responsabilidade                                                             | Ambiente       |
| ----------------------- | ---------------------------------------------------------------------------- | -------------- |
| `@bpmn-flow/core`       | Parser BPMN 2.0, modelo normalizado e motor de execução por tokens.          | Node e browser |
| `@bpmn-flow/viewer`     | Renderização interativa sobre `bpmn-visualization` com overlays de execução. | Browser        |
| `@bpmn-flow/server`     | API REST sobre o `core` e host estático para servir uma UI numa porta.       | Node           |
| `@bpmn-flow/cli`        | `bpmn-flow validate/inspect/run` para usar o motor no terminal.              | Node           |
| `@bpmn-flow/playground` | Aplicação Vite para carregar, visualizar e executar processos no navegador.  | Browser        |

Fluxo de dados: `XML BPMN -> parseBpmn -> ProcessModel -> WorkflowEngine ->
ExecutionSnapshot -> BpmnFlowViewer`.

O `core` não depende de nenhuma biblioteca de UI, o que permite executar
processos tanto no backend quanto no frontend com o mesmo código. Detalhes de
design em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); a aderência à
especificação, elemento por elemento, em
[`docs/BPMN-STANDARD.md`](docs/BPMN-STANDARD.md).

## Requisitos

- Node.js 20 ou superior
- npm 10 ou superior

## Instalação

Para desenvolver neste repositório:

```bash
npm install
npm run build
```

Os pacotes ainda **não estão publicados no npm**. Para consumi-los em outro
projeto hoje, use o repositório direto:

```bash
npm install github:Bappoz/bpmn-flow
```

Quando forem publicados, a instalação será por pacote (`@bpmn-flow/core`,
`@bpmn-flow/viewer`).

## Início rápido: usar como biblioteca

```ts
import { parseBpmn, WorkflowEngine } from '@bpmn-flow/core';

const model = await parseBpmn(xml);
const [process] = model.processes;

const engine = new WorkflowEngine(process, {
  variables: { valor: 2500 },
});

const snapshot = await engine.start();
console.log(snapshot.status); // "completed" | "waiting" | "terminated" | ...
console.log(snapshot.completedNodes);
console.log(snapshot.variables);
```

Se o processo tiver uma tarefa de usuário ou um evento de captura, a execução
pausa (`status: "waiting"`) e informa os tokens parados. Retome-a assim:

```ts
const waiting = snapshot.tokens.find((t) => t.waiting);
if (waiting?.waitReason === 'userTask') {
  await engine.completeTask(waiting.id, { aprovado: true });
} else if (waiting?.waitReason === 'catchEvent') {
  await engine.signal(waiting.nodeId);
}
```

### Pausar e retomar

A execução inteira é serializável, então um processo pode atravessar um restart,
uma fila ou um banco de dados:

```ts
const state = engine.getState(); // JSON puro: tokens, escopos, buffers de junção
await db.save(id, state);

// Em outro processo, mais tarde:
const retomado = WorkflowEngine.restore(process, await db.load(id));
retomado.registerHandler('serviceTask', handler); // handlers não são serializáveis
await retomado.completeTask(tokenId);
```

`getState()` guarda o que o `snapshot()` não guarda: contagem de chegadas em
junção paralela, tokens em espera numa junção inclusiva, alternativas armadas de
gateway baseado em evento e a árvore de escopos de subprocesso.

Exemplo executável de ponta a ponta (handler, gateway condicional e retomada de
tarefa): [`examples/quickstart.mjs`](examples/quickstart.mjs).

```bash
npm run build && node examples/quickstart.mjs
```

## Caixa de entrada: quem executa o quê

Raias e `potentialOwner` viram atribuição, e o motor expõe a lista de trabalho
pendente — a caixa de entrada que uma UI renderiza:

```ts
engine.tasks();
// [{ tokenId, nodeId: 'Aprovar', name: 'Aprovar pagamento',
//    lane: 'Financeiro', candidates: ['gerentes'], reason: 'userTask',
//    variables: { pedido: 42 } }]

engine.tasks({ role: 'gerentes' }); // só o que esse papel pode executar
```

O filtro casa tanto com a raia quanto com os papéis declarados. Numa atividade
multi-instância, cada instância aparece como uma tarefa própria, com o seu item:

![Três tarefas de aprovação, uma por aprovador](docs/media/multi-instancia-tarefas.png)

No servidor, `GET /api/tasks?role=gerentes` faz o mesmo atravessando todas as
sessões.

## Quando algo falha: retry e incidentes

Um erro de negócio (`BpmnError`) vai para o evento de borda de erro. Um erro
técnico — a API caiu, o banco recusou — não deveria matar o processo:

```ts
const engine = new WorkflowEngine(process, {
  onHandlerError: 'incident', // segura em vez de falhar
  retry: { attempts: 3, delay: 'PT30S' }, // tenta de novo antes disso
});

engine.incidentList(); // [{ nodeId: 'Cobrar', message: 'ECONNRESET', attempts: 4 }]
await engine.retryTask(tokenId); // roda de novo
await engine.resolveIncident(tokenId, { cobrado: true }); // ou segue em frente
```

O padrão continua sendo falhar a execução, então nada muda para quem já usa a
biblioteca. As retentativas com `delay` usam o mesmo relógio dos timers.

## Compensação: desfazer o que já foi feito

Um evento de borda de compensação, ligado por associação à atividade que desfaz
o trabalho, permite reverter na ordem inversa — e um evento de cancelamento
dentro de uma `transaction` faz isso automaticamente antes de sair pelo evento
de borda de cancelamento:

```
Reservar voo ──▶ Reservar hotel ──▶ Pagou? ──não──▶ (compensação)
     ⊗                  ⊗                                │
Cancelar voo      Cancelar hotel   ◀── desfaz hotel, depois voo
```

## Métricas e replay

`engine.metrics()` diz onde o tempo foi parar, atividade por atividade, e o
viewer sabe desenhar isso e reprisar a execução passo a passo:

```ts
engine.metrics();
// [{ nodeId: 'Aprovação Gerencial', started: 1, completed: 1, totalMs: 7200000, ... }]

viewer.showMetrics(engine.metrics()); // etiqueta de tempo em cada atividade

const replay = new ExecutionReplay(snapshot.history);
let frame;
while ((frame = replay.next())) viewer.applyReplayFrame(frame);
```

![Tempo médio por atividade sobreposto ao diagrama](docs/media/metricas-por-atividade.png)

## O diagrama diz quais variáveis ele precisa

Um gateway com `pago === true` só abre com essa variável — e quem abre o
processo pela primeira vez não tem como adivinhar. O core lê as expressões do
próprio diagrama e responde:

```ts
processVariables(process);
// [{ name: 'pago', kind: 'condition', expressions: ['pago === true'],
//    usedBy: ['Pagamento aprovado?'], suggestion: true }]

suggestVariables(process); // { pago: true, valor: 1001 }
```

A sugestão sai da forma da expressão (`valor > 1000` sugere 1001, `status ===
"ok"` sugere `"ok"`, uma coleção de multi-instância sugere dois itens). O
playground usa isso para já abrir a caixa de variáveis preenchida com algo que
faz o processo andar, e lista cada variável com a expressão que a consome.

A mesma leitura responde a pergunta seguinte: **para onde o processo vai depois
desta atividade, e o que decide isso?**

```ts
decisionsAfter(process, 'PreencherFormulario');
// [{ nodeId: 'Gateway_1', name: 'Valor > R$ 1000?', variables: ['valor'],
//    options: [{ label: 'Sim', condition: 'valor > 1000', assignments: { valor: 1001 } },
//              { label: 'Não', isDefault: true, assignments: { valor: 1000 } }] }]
```

Cada opção já vem com sua condição satisfeita e as concorrentes refutadas, então
aplicar `assignments` abre exatamente aquele caminho. No playground, o botão
"Run" usa isso para conduzir a execução: a cada parada abre um diálogo com o que
depende de uma pessoa — concluir a atividade, informar um valor, escolher o
caminho — em vez de decidir sozinho e mostrar só o resultado.

Um processo sem nenhuma tarefa não tem onde parar, e mesmo assim decide: para
esses, o motor aceita um `decide` e pergunta no próprio gateway.

```ts
new WorkflowEngine(process, {
  decide: async ({ name, options, suggested }) => {
    // options traz cada ramo com sua condição; suggested, o que os dados diriam
    return await perguntarAoOperador(name, options, suggested);
  },
});
```

Sem essa opção nada muda: o gateway decide pelos dados, como manda a
especificação.

![Diálogo do passo a passo perguntando o valor e o caminho a seguir](docs/media/passo-a-passo-decisao.png)

## Análise estática do grafo

`analyzeProcess` lê o grafo sem executar nada e aponta o que só apareceria
depois — ou nunca apareceria, por travar antes: nó inalcançável a partir de
qualquer início, ciclo sem fluxo de saída, gateway exclusivo sem default que
falha se nenhuma condição bater, e junção paralela alimentada por um gateway
que só manda o token por um dos ramos.

```ts
analyzeProcess(process);
// [{ kind: 'parallel-join-deadlock', severity: 'error', nodeId: 'Join',
//    causeNodeId: 'Split',
//    message: '"Join" waits for a token on every incoming flow, but "Split" only...' }]
```

`criticalPath` usa as métricas de execuções anteriores (`engine.metrics()`)
para achar o caminho do início ao fim com a maior soma de duração média — o
gargalo mais provável do processo:

```ts
criticalPath(process, engine.metrics());
// { path: ['Start', 'Gw', 'AprovacaoGerencial', 'End'], totalMs: 7200000 }
```

Detalhes de cada verificação em [`packages/core/README.md`](packages/core/README.md),
seção `analyzeProcess`.

## Timers

Eventos de timer viram data de vencimento. O motor não tem relógio próprio: ele
calcula o vencimento e alguém decide quando conferir — o que mantém o `core`
testável e determinístico.

```ts
const engine = new WorkflowEngine(process); // `now` injetável para testes
await engine.start();

engine.nextTimerAt(); // epoch ms do próximo vencimento
await engine.tick(); // dispara o que venceu e continua a execução
```

Funciona com duração (`PT5M`), data absoluta (`2026-08-20T10:00:00Z`) e ciclo
(`R3/PT10M`, disparando uma vez), tanto em evento de captura quanto em evento de
borda — um prazo de atendimento que escala sozinho, por exemplo. O
`@bpmn-flow/server` já faz esse `tick` periodicamente.

![Tarefa com raia e papel, e o timer do SLA correndo](docs/media/timer-e-atribuicao.png)

## Repetição: multi-instância e loop

Uma atividade multi-instância roda uma vez por item de uma coleção (ou uma
quantidade fixa), em paralelo ou uma de cada vez. Cada instância ganha o **seu
próprio escopo de variáveis**, então `item` e `loopCounter` não vazam para o
processo:

```xml
<bpmn:dataObject id="itens" name="itens" />
<bpmn:dataObject id="separados" name="separados" />

<bpmn:serviceTask id="SepararItem" name="Separar Item">
  <bpmn:multiInstanceLoopCharacteristics isSequential="false">
    <bpmn:loopDataInputRef>itens</bpmn:loopDataInputRef>
    <bpmn:inputDataItem id="item" name="item" />
    <bpmn:loopDataOutputRef>separados</bpmn:loopDataOutputRef>
    <bpmn:outputDataItem id="separado" name="separado" />
  </bpmn:multiInstanceLoopCharacteristics>
</bpmn:serviceTask>
```

```ts
engine.registerHandler('SepararItem', (ctx) => ({
  separado: `${ctx.get('item')} separado`, // vira um item de "separados"
}));

const snapshot = await engine.start(); // uma instância por item de "itens"
snapshot.variables.separados; // ["teclado separado", "mouse separado", ...]
```

A coleção de saída acompanha a **ordem da coleção de entrada**: `separados[2]` é
sempre o resultado de `itens[2]`, mesmo quando as instâncias paralelas terminam
fora de ordem. Uma condição de conclusão que corta o resto simplesmente deixa a
coleção mais curta, sem buracos.

Variáveis seguem escopo: a leitura sobe a cadeia (instância → subprocesso →
processo) e a escrita vai para onde a variável já existe, caindo no processo
quando ela é nova. Um handler pode forçar o escopo local com `ctx.setLocal()`.

Diagrama de exemplo: [`bpmn-files/processo-pedido-itens.bpmn`](bpmn-files/processo-pedido-itens.bpmn).

## Automação com handlers

Um handler executa o trabalho real por trás de uma atividade. Registre-o por id
do elemento, por tipo de elemento ou com o coringa `*`. A resolução segue da
regra mais específica para a mais genérica.

```ts
engine.registerHandler('serviceTask', async (ctx) => {
  const total = await cobrarCartao(ctx.get('valor'));
  ctx.set('total', total);
  return { pago: true }; // valores retornados são mesclados nas variáveis
});

engine.registerHandler('reservarEstoque', (ctx) => {
  if (!temEstoque()) throw new BpmnError('SEM_ESTOQUE');
});
```

Lançar `BpmnError` dispara um evento de borda de erro (error boundary event)
correspondente, se existir. Erros comuns falham a execução.

## Visualização interativa

No navegador, combine o motor com o viewer para acompanhar a execução:

```ts
import { WorkflowEngine } from '@bpmn-flow/core';
import { BpmnFlowViewer } from '@bpmn-flow/viewer';
import '@bpmn-flow/viewer/styles.css';

const viewer = new BpmnFlowViewer({ container: 'diagram' });
viewer.load(xml);

const engine = new WorkflowEngine(process, { mode: 'automation' });
viewer.bindEngine(engine); // anima a execução ao vivo
viewer.applySnapshot(await engine.start()); // aplica o estado autoritativo
```

Estilos aplicados: nós concluídos, tokens ativos, atividades em espera e fluxos
percorridos.

Um gateway paralelo divide o fluxo em vários tokens simultâneos, e a junção só
libera quando todos chegam:

![Três tokens simultâneos após um gateway paralelo](docs/media/tokens-paralelos.png)

## Playground

Aplicação de demonstração com dois modos: executar e editar.

```bash
npm install
npm run build
npm run dev          # http://localhost:5173
```

No modo **executar**, escolha um diagrama de `bpmn-files/`, informe variáveis em
JSON e use `Iniciar` (pausa em cada tarefa de usuário) ou `Executar tudo`
(resolve as esperas automaticamente). O processo de compras reage às variáveis:

| Variáveis                              | Caminho                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `{ "valor": 500, "aprovado": true }`   | Pula a aprovação gerencial → **Compra Realizada**     |
| `{ "valor": 2500, "aprovado": true }`  | Passa pela aprovação gerencial → **Compra Realizada** |
| `{ "valor": 2500, "aprovado": false }` | Passa pela aprovação gerencial → **Compra Rejeitada** |

### Demo pública

O workflow [`Demo`](.github/workflows/pages.yml) publica o playground no GitHub
Pages a cada push na `master` — o build é estático (os exemplos vão embutidos e
a execução roda no navegador), só o botão "Salvar no repositório" precisa do
servidor. Para ligar: **Settings → Pages → Source: GitHub Actions**. A partir
daí o endereço é `https://<usuário>.github.io/<repo>/`.

No modo **editar**, o diagrama é criado com `bpmn-js`, validado pelo
`@bpmn-flow/core` e pode ser salvo no diretório de exemplos do servidor:

![Editor com o resultado da validação estrutural](docs/media/editor-validacao.png)

## Linha de comando

```bash
bpmn-flow validate processo.bpmn   # sai 1 se o diagrama for inválido
bpmn-flow inspect  processo.bpmn   # nós por tipo, raias, multi-instância, timers
bpmn-flow run      processo.bpmn --vars '{"valor":2500}'
```

`run` aceita `--mode auto`, `--save estado.json` e `--state estado.json`, então
dá para pausar uma execução e retomá-la depois. `--js-expressions` troca o
avaliador seguro pela linguagem inteira, para diagramas próprios (ver
[Expressões e confiança](#expressões-e-confiança)). Detalhes em
[`packages/cli`](packages/cli/README.md).

## Servidor HTTP e API REST

O `@bpmn-flow/server` expõe a execução por HTTP e pode servir a interface numa
porta.

```bash
npm run build
node packages/server/dist/bin.js --static apps/playground/dist --samples bpmn-files --port 3000
```

Acesse `http://localhost:3000`. Variáveis de ambiente equivalentes: `PORT`,
`STATIC_DIR`, `SAMPLES_DIR`.

Endpoints principais:

| Método e rota                     | Descrição                                        |
| --------------------------------- | ------------------------------------------------ |
| `POST /api/parse`                 | Recebe `{ xml }` e retorna o modelo normalizado. |
| `POST /api/validate`              | Valida a estrutura do diagrama.                  |
| `POST /api/sessions`              | Cria uma sessão de execução e a inicia.          |
| `GET /api/sessions/:id`           | Retorna o snapshot atual da sessão.              |
| `POST /api/sessions/:id/complete` | Conclui uma tarefa de usuário (`{ tokenId }`).   |
| `POST /api/sessions/:id/signal`   | Entrega um sinal/evento (`{ name }`).            |
| `GET /api/samples`                | Lista os arquivos `.bpmn` disponíveis.           |

Com `--data <dir>` cada sessão é gravada em disco e reconstruída sob demanda, de
modo que reiniciar o servidor não perde execuções em andamento.

O XML que chega pela API é tratado como não confiável: as expressões do diagrama
passam pelo avaliador seguro, como descrito a seguir.

## Expressões e confiança

Condição de fluxo, cardinalidade, condição de conclusão e mapeamento de dados
são expressões que vêm dentro do diagrama. Por padrão elas passam por um
**avaliador seguro**: um subconjunto de JavaScript que é lido, transformado em
árvore e interpretado — nunca compilado. Não há `eval` nem `new Function` no
caminho.

```
valor > 1000 && cliente.plano === "premium"
itens.length > 2 ? "lote" : "simples"
Math.max(a, b) === 5
pedido.entrega?.prazo === undefined
```

Só existem os globais que a allowlist expõe (`Math`, `JSON`, `Number`,
`Array.isArray`, `Object.keys/values/entries`, `Date.now`, `String`, `Boolean`,
`parseInt`, `parseFloat`) e, sobre os seus próprios dados, os métodos de
consulta (`includes`, `indexOf`, `slice`, `join`, `toLowerCase`, ...).
`process`, `globalThis`, `require` e `Function` não existem para uma expressão;
`constructor` e `__proto__` são recusados; não há atribuição, `new`, função
anônima nem statement — uma expressão também não consegue escrever nas
variáveis do processo. Por isso `POST /api/sessions` pode receber XML de
qualquer origem sem que uma condição execute código no servidor.

Uma expressão que o avaliador não entende vale `undefined`, e como condição vale
`false`. Para descobrir isso antes de executar, `validateBpmn` reporta uma issue
de severidade `warning` para cada expressão fora do subconjunto.

Quem escreve os próprios diagramas e quer a linguagem inteira liga o modo
JavaScript, que confia na definição tanto quanto no código ao redor:

```ts
new WorkflowEngine(processo, { expressions: 'javascript' });

// No servidor a escolha é de quem sobe o processo, nunca do request:
createApp({ expressions: 'javascript' });
```

## Padrões BPMN suportados

- Eventos: início, fim (none, terminate, error, **cancel**, **escalation**,
  **compensation**), intermediários de lançamento e de captura, eventos de borda
  (interrompentes e não interrompentes), eventos de link pareados e **event
  subprocess** (interrompente ou não).
- Definições de evento: message, timer, error, signal, escalation, conditional,
  compensation, cancel, terminate e link — **várias por evento**, como um
  boundary que é mensagem _e_ prazo ao mesmo tempo.
- Sinais são **difundidos**: um `signal()` acorda todos os assinantes, inclusive
  receive tasks que esperam aquela mensagem.
- Atividades: task, userTask, serviceTask, scriptTask, businessRuleTask,
  sendTask, receiveTask, manualTask, subprocessos embutidos, **transaction**,
  **adHocSubProcess** (paralelo ou sequencial, com condição de conclusão) e
  **callActivity executando o processo referenciado**.
- **Mapeamento de dados** de entrada e saída, que isola o processo chamado: ele
  só enxerga o que foi mapeado, e só o mapeamento de saída volta.
- Eventos de lançamento **entregam o gatilho** (sinal, mensagem, escalation,
  compensação) para os assinantes do próprio processo.
- Gateways: exclusivo (com fluxo default), paralelo (junção sincronizada),
  inclusivo (junção por alcançabilidade), baseado em evento e **complexo com
  condição de ativação** (quórum).
- Repetição: multi-instância paralela e sequencial (por coleção ou cardinalidade,
  com condição de conclusão e coleção de saída) e loop padrão.
- **Compensação**: evento de borda de compensação ligado por associação à
  atividade que desfaz o trabalho, disparada em ordem inversa.
- Fluxos de sequência com condições e raias (lanes) com os papéis de
  `potentialOwner`.
- **Colaboração**: `CollaborationEngine` executa todos os pools executáveis do
  diagrama e roteia cada `messageFlow` do nó de origem para o de destino, ponto
  a ponto. `bpmn-flow run` usa isso sozinho quando o arquivo tem mais de um pool
  executável. Pool black-box não roda, e mensagem cujo destino ainda não
  assinou fica em trânsito até assinar.

## Limitações conhecidas

- **Ciclos de timer repetem só em evento de borda não interrompente**
  (`R3/PT1H` = três lembretes), que é onde repetir faz sentido.
- **Expressões são um subconjunto de JavaScript**: o avaliador seguro não tem
  função anônima, atribuição, `new` nem chamada fora da allowlist, então uma
  condição que dependa disso precisa do modo `expressions: 'javascript'` (só
  para diagramas próprios). Variável inexistente lê como `undefined`; expressão
  que lança, ou que o avaliador recusa, é tratada como `false`.
- **`ioSpecification` formal não é interpretado**: o mapeamento de dados é lido
  na forma `assignment/from/to`.
- **Correlação de mensagem por chave** cobre a forma que as ferramentas BPMN
  escrevem em `extensionElements` (`correlationKey="=pedidoId"`): `correlate()`
  entrega só para a instância cuja chave bate, e `POST /api/messages` roteia sem
  o chamador saber a sessão. O mecanismo padrão da spec
  (`correlationSubscription`/`correlationPropertyBinding`) não é lido; sem chave
  declarada a entrega volta a ser por nome.
- **O servidor HTTP roda um pool por sessão**: `CollaborationEngine` é a API de
  colaboração; `SessionStore` ainda cria uma sessão por processo executável.
- **DMN está fora de escopo**: `businessRuleTask` é o ponto de extensão — ligue
  um handler ao seu motor de decisão.

## Desenvolvimento

```bash
npm run build       # compila todos os pacotes
npm test            # executa a suíte Vitest
npm run typecheck   # checagem de tipos em todo o monorepo
npm run lint        # ESLint
npm run format      # Prettier
npm run dev         # sobe o playground em modo de desenvolvimento
```

```bash
npm run verify      # build + format + lint + typecheck + test, falhando no primeiro erro
```

`verify` é exatamente o que o CI roda, na mesma ordem — o build vem primeiro
porque os pacotes se checam pelos tipos gerados uns dos outros, e os workspaces
são compilados em ordem de dependência (`core` antes de quem o consome). O CI
executa isso no Node 20 e 22.

### Publicando

Os quatro pacotes publicáveis já declaram `publishConfig`, `repository` e
`files`:

```bash
npm run build
npm run release:dry     # confere o conteúdo do tarball de cada pacote
npm publish --workspaces --access public
```

## Estrutura do repositório

```
packages/
  core/        modelo, parser e motor de execução
  viewer/      renderização interativa com overlays
  server/      API REST e host estático
  cli/         linha de comando
apps/
  playground/  aplicação interativa (Vite)
examples/      scripts executáveis de uso da biblioteca
bpmn-files/    diagramas .bpmn de exemplo
docs/          documentação complementar
```

## Licença

MIT. Veja [LICENSE](LICENSE).
