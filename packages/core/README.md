# @bpmn-flow/core

Parser BPMN 2.0 e motor de execução por tokens. Isomórfico (Node e navegador),
sem dependências de UI.

## Instalação

```bash
npm install @bpmn-flow/core
```

> Ainda não publicado no npm. Para usar hoje: `npm install github:Bappoz/bpmn-flow`.

## API

### `parseBpmn(xml): Promise<BpmnModel>`

Converte XML BPMN 2.0 em um modelo normalizado e serializável. Reconhece todos
os tipos de nó (eventos e suas definições, tarefas, gateways e subprocessos),
fluxos de sequência com condições e colaboração. A interchange de diagrama (DI)
é ignorada; o `@bpmn-flow/viewer` renderiza a partir do XML.

Lança `BpmnParseError` para XML inválido ou sem processo.

### `processVariables(process)` e `suggestVariables(process)`

Descobrem, a partir das expressões do diagrama, quais variáveis o processo lê —
condições de fluxo, cardinalidade e coleção de multi-instância, condição de
conclusão, condição de ativação, eventos condicionais — com a expressão que as
usa e um valor sugerido pela forma dela. Variáveis que o processo só escreve
(item da multi-instância, coleção de saída) ficam de fora.

```ts
suggestVariables(process); // { pago: true, valor: 1001, itens: ['item-1', 'item-2'] }
```

### `decisionsAfter(process, nodeId): DecisionPoint[]`

Os pontos em que o processo se divide depois daquele nó, com os valores que
mandam a execução por cada caminho. A caminhada segue os fluxos por atividades
automáticas e divisões paralelas, e para em cada nó que decide e em cada estado
de espera — quem conduz a execução vai ser perguntado lá.

```ts
decisionsAfter(process, 'PreencherFormulario');
// [{ nodeId: 'Gateway_1', name: 'Valor > R$ 1000?', kind: 'exclusiveGateway',
//    variables: ['valor'],
//    options: [{ flowId: 'f4', targetId: 'AprovacaoGerencial', label: 'Sim',
//                condition: 'valor > 1000', isDefault: false,
//                assignments: { valor: 1001 } },
//              { flowId: 'f5', targetId: 'Gateway_2', label: 'Não',
//                isDefault: true, assignments: { valor: 1000 } }] }]
```

Cada opção traz sua condição satisfeita e as concorrentes refutadas, então
aplicar `assignments` deixa exatamente aquele caminho aberto. Quando a expressão
não diz nada sobre a forma do valor (uma chamada, uma conta), `assignments` vem
vazio e o valor tem de ser informado.

### `analyzeProcess(process): StaticAnalysisIssue[]`

Analisa o grafo antes de qualquer execução e aponta o que só um token real
descobriria (ou nunca descobriria, por ficar preso antes):

- **`unreachable`**: nó que nenhum evento de início alcança, seguindo fluxos e
  eventos de borda. Não recursa em subprocesso ad-hoc — sem fluxo declarado,
  nada ali é "inalcançável".
- **`cycle-without-exit`**: componente fortemente conexo do grafo sem nenhum
  fluxo saindo dele — um token que entra nunca mais sai. Um laço com uma
  condição de saída real (outro fluxo do gateway leva para fora do ciclo) não é
  apontado.
- **`gateway-without-default`**: gateway exclusivo sem fluxo default em que
  todo fluxo de saída é condicional — se nenhuma condição bater em tempo de
  execução, o motor falha por não ter para onde ir. Um fluxo sem condição não
  conta (o motor já o trata como default implícito).
- **`parallel-join-deadlock`**: junção paralela alimentada por um gateway
  exclusivo, inclusivo ou baseado em evento que só manda o token por um (ou
  alguns) dos ramos que chegam nela — a junção espera token em toda entrada e
  nunca completa.

```ts
analyzeProcess(process);
// [{ kind: 'parallel-join-deadlock', severity: 'error', nodeId: 'Join',
//    causeNodeId: 'Split',
//    message: '"Join" waits for a token on every incoming flow, but "Split" only...' }]
```

Recursa em todo subprocesso do modelo. Não modifica nem executa nada — é leitura
pura do grafo, então pode rodar sobre qualquer `ProcessModel` já parseado, sem
subir um `WorkflowEngine`.

### `criticalPath(process, metrics): CriticalPathResult | undefined`

O caminho do início ao fim mais provável de ser o gargalo, pesando cada
atividade pela duração média de `metrics` (normalmente `engine.metrics()`,
somado de quantas execuções passadas fizer sentido considerar). Um nó sem
métrica pesa zero; um laço é percorrido no máximo uma vez por caminho, então um
processo com ciclos ainda devolve o caminho simples mais longo em vez de um sem
fim.

```ts
criticalPath(process, engine.metrics());
// { path: ['Start', 'Gw', 'AprovacaoGerencial', 'End'], totalMs: 7200000 }
```

`undefined` quando nenhum caminho de um início chega a um fim (por exemplo, um
processo cujos únicos nós depois do início estão presos num
`cycle-without-exit`).

### `addFlowReferences(xml): Promise<string>`

Devolve o mesmo XML com o `<bpmn:incoming>`/`<bpmn:outgoing>` de cada nó
preenchido a partir dos `sourceRef`/`targetRef` dos fluxos. O motor não precisa
disso (deriva tudo dos fluxos), mas ferramentas do ecossistema leem só esses
elementos — o `bpmn-auto-layout`, por exemplo, não desenha nenhuma aresta quando
eles faltam. Idempotente.

### `validateBpmn(xml): Promise<ValidationResult>`

Valida a estrutura do diagrama (processo sem evento de início ou de fim, nós
desconectados, fluxos órfãos) e devolve erros e avisos.

### `new WorkflowEngine(process, options?)`

Executa um `ProcessModel` movimentando tokens pelo grafo.

Opções:

- `mode`: `"automation"` (padrão) pausa em tarefas de usuário/captura;
  `"auto"` resolve todas as esperas para simular uma execução completa.
- `decide`: chamado antes de um gateway exclusivo/inclusivo rotear o token, para
  uma pessoa (ou outro sistema) escolher o ramo. Recebe as alternativas com suas
  condições e o que os dados escolheriam; devolver `undefined` mantém a decisão
  do motor. Sem essa opção, o gateway decide pelos dados, como manda a
  especificação.
- `processes`: demais processos do arquivo, para `callActivity` executar o
  processo referenciado (normalmente `model.processes`).
- `onHandlerError`: `"fail"` (padrão) derruba a execução; `"incident"` segura o
  token para alguém retomar.
- `retry`: `{ attempts, delay? }` — tentativas automáticas antes do incidente.
- `now`: relógio usado para agendar timers (padrão `Date.now`); injete um falso
  para testar sem esperar.
- `variables`: variáveis iniciais do processo.
- `maxSteps`: limite de transições (proteção contra loops infinitos).
- `expressions`: `"safe"` (padrão) interpreta as expressões do diagrama num
  subconjunto de JavaScript, com globais em allowlist e sem compilar código —
  seguro para diagrama de origem desconhecida; `"javascript"` compila com
  `new Function` e libera a linguagem inteira, confiando na definição tanto
  quanto no código ao redor.

Métodos:

- `registerHandler(selector, handler)`: registra automação por id do nó, tipo
  de elemento ou `*`.
- `start(): Promise<ExecutionSnapshot>`: inicia e roda até concluir ou bloquear.
- `completeTask(tokenId, output?)`: conclui uma tarefa parada e prossegue.
- `signal(nameOrId, output?)`: entrega um gatilho (catch event, gateway baseado
  em evento ou boundary event).
- `on(event, listener)`: observa `node.enter`, `node.leave`, `activity.start`,
  `activity.end`, `flow.take`, `wait`, `process.start`, `process.end`, `error`.
- `snapshot()`: estado atual (status, variáveis, tokens, nós concluídos,
  histórico) — read model para UI.
- `getState()`: estado completo e serializável da execução, incluindo buffers de
  junção, escopos e eventos armados.
- `resume()`: continua uma execução restaurada até concluir ou bloquear.
- `tasks(filter?)`: trabalho pendente (tarefa de usuário, receive task, evento
  de captura, incidente) com raia, papéis e variáveis visíveis; filtra por
  `role`, `reason` e `nodeId`.
- `incidentList()`: atividades cujo handler falhou, com mensagem e tentativas.
- `retryTask(tokenId)` / `resolveIncident(tokenId, output?)`: roda de novo ou
  segue em frente.
- `metrics()`: tempo total/médio/máximo por atividade, do mais lento para o mais
  rápido.
- `tick(now?)`: dispara os timers vencidos e continua a execução.
- `dueTimers()` / `nextTimerAt()`: timers pendentes e o próximo vencimento.

### `WorkflowEngine.restore(process, state, options?)`

Reconstrói um motor a partir de um `EngineState` produzido por `getState()`,
para retomar depois de um restart. O modelo do processo precisa ser o mesmo;
handlers e listeners não são serializados e devem ser registrados de novo.

```ts
const state = engine.getState();
const retomado = WorkflowEngine.restore(process, JSON.parse(JSON.stringify(state)));
```

### Repetição e escopo de variáveis

Uma atividade com `multiInstanceLoopCharacteristics` ou
`standardLoopCharacteristics` é expandida em instâncias pelo motor. Cada
instância roda num escopo próprio com `loopCounter` e o item da coleção, e a
coleção de saída é montada a partir da variável de saída de cada instância.

```ts
engine.registerHandler('SepararItem', (ctx) => ({
  separado: `${ctx.get('item')} separado`,
}));
```

No `HandlerContext`, `set()` escreve onde a variável já existe (caindo no escopo
do processo) e `setLocal()` mantém o valor apenas no escopo atual.

### Handlers

```ts
import { BpmnError } from '@bpmn-flow/core';

engine.registerHandler('serviceTask', async (ctx) => {
  ctx.set('resultado', await fazerTrabalho(ctx.get('entrada')));
  return { concluido: true };
});
```

Retornar um objeto mescla valores nas variáveis. Lançar `BpmnError(code)`
dispara um error boundary event correspondente.

## Padrões suportados

Eventos (start/end/intermediate/boundary), definições message/timer/error/
signal/escalation, todas as tarefas, subprocessos, call activities e gateways
exclusivo/paralelo/inclusivo/baseado em evento/complexo. A semântica de cada um
e as divergências assumidas estão em
[`docs/BPMN-STANDARD.md`](../../docs/BPMN-STANDARD.md).

## Licença

MIT.
