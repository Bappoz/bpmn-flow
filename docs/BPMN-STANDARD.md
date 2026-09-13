# Aderência ao BPMN 2.0

Este documento registra como o `@bpmn-flow/core` implementa a semântica de
execução da especificação BPMN 2.0 (OMG) e onde ela é deliberadamente
simplificada. Toda divergência precisa estar listada aqui.

Referência de implementação: `packages/core/src/engine/engine.ts`.

## Modelo de execução

A execução é baseada em **tokens**, como na especificação: um token representa
uma linha de controle posicionada em um nó. O motor mantém uma fila de tokens
prontos e a processa até que todos concluam, falhem ou fiquem em espera.

Escopos aninhados representam o processo raiz e cada instância de subprocesso.
Um escopo termina quando não sobra nenhum token nele.

## Eventos

| Elemento                          | Comportamento implementado                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `startEvent`                      | Cria o token inicial do escopo e segue pelos fluxos de saída.                                       |
| `endEvent` (none)                 | Consome o token; o escopo conclui quando não há mais tokens.                                        |
| `endEvent` (terminate)            | Cancela **todos** os tokens do escopo imediatamente.                                                |
| `endEvent` (error)                | Consome o token e levanta o erro no escopo pai, procurando um evento de borda correspondente.       |
| `endEvent` (escalation)           | Propaga a escalation para fora; sem tratador, a execução segue normalmente.                         |
| `endEvent` (cancel)               | Dentro de uma `transaction`: compensa o que foi feito e sai pelo evento de borda de cancelamento.   |
| `endEvent` (compensation)         | Dispara os tratadores de compensação do escopo, em ordem inversa.                                   |
| `intermediateThrowEvent`          | Lança o gatilho (sinal, mensagem, escalation, compensação) e segue adiante.                         |
| `intermediateCatchEvent`          | Estaciona o token (`waitReason: "catchEvent"`) até `signal()` ou até o timer vencer.                |
| `boundaryEvent` interrompente     | Descarta o token da atividade hospedeira (ou o escopo do subprocesso) e segue pelo fluxo do evento. |
| `boundaryEvent` não interrompente | Mantém a atividade em execução e cria um token adicional no fluxo do evento.                        |
| `boundaryEvent` condicional       | Reavaliado a cada quiescência do motor; dispara uma vez por ativação da atividade.                  |

Definições de evento reconhecidas pelo parser: `message`, `timer`, `error`,
`signal`, `escalation`, `conditional`, `compensation`, `cancel`, `terminate` e
`link`. As que exigem gatilho externo são resolvidas por `signal()`, que
**difunde** para todos os assinantes correspondentes — eventos de captura
parados, alternativas de gateway baseado em evento, eventos de borda e event
subprocesses.

Eventos de link são pareados dentro do escopo: um `intermediateThrowEvent` de
link salta para o `intermediateCatchEvent` de mesmo nome, em vez de seguir pelos
fluxos de saída.

### Compensação

Um evento de borda de `compensation` marca a atividade como reversível; a
`bpmn:association` que sai desse evento aponta para a atividade que desfaz o
trabalho (normalmente com `isForCompensation="true"`). O motor guarda cada
atividade compensável concluída e, quando um evento de compensação dispara,
executa os tratadores na **ordem inversa** da conclusão — opcionalmente
restrito a uma atividade via `activityRef`. A compensação termina antes de o
token que a disparou seguir adiante.

`transaction` + `cancelEventDefinition` combinam as duas coisas: cancelar
compensa o que já foi feito, descarta o resto do trabalho da transação e sai
pelo evento de borda de cancelamento.

### Eventos de lançamento

Um evento de lançamento com definição de **sinal** ou **mensagem** entrega o
gatilho na hora, para todos os assinantes correspondentes do próprio processo —
eventos de captura parados, eventos de borda e event subprocesses. É como um
`signal()` externo, disparado de dentro do diagrama.

### Escalation

Uma escalation lançada dentro de um subprocesso procura um evento de borda de
escalation na atividade que hospeda o escopo, subindo a árvore, e depois um
event subprocess de escalation. Diferente do erro, escalation sem tratador não
é falha: o ramo continua.

### Event subprocess

Um subprocesso com `triggeredByEvent` não recebe token: ele começa quando o
gatilho do seu evento de início chega (sinal, mensagem ou erro). Com
`isInterrupting="true"` (padrão) o escopo que o declara tem o trabalho
cancelado; com `false` o subprocesso roda em paralelo. Um erro sem evento de
borda correspondente também procura um event subprocess de erro antes de falhar
a execução.

## Atividades

- `userTask` e `receiveTask` **sem handler** param a execução
  (`waitReason: "userTask"` / `"receiveTask"`) e são retomadas com
  `completeTask()`.
- As demais tarefas sem handler são pass-through — a especificação não define o
  trabalho realizado, apenas o fluxo de controle.
- Com handler registrado, o retorno do handler é mesclado nas variáveis do
  processo. Lançar `BpmnError` procura um evento de borda de erro na atividade;
  sem correspondência, a execução falha.
- `subProcess`, `transaction` e `adHocSubProcess` criam um escopo filho e
  suspendem o token pai até a conclusão do escopo.
- `callActivity` executa o processo referenciado por `calledElement` quando ele
  é passado ao motor (`options.processes`, normalmente `model.processes`); sem
  isso, continua sendo pass-through.
- Um erro técnico do handler (qualquer coisa que não seja `BpmnError`) pode ser
  repetido (`options.retry`) e, com `onHandlerError: "incident"`, vira um
  incidente que segura o token em vez de derrubar a execução.

## Subprocesso ad-hoc

`adHocSubProcess` não tem fluxo de sequência ligando suas atividades: toda
atividade sem fluxo de entrada é elegível. `ordering="Parallel"` (padrão) inicia
todas de uma vez; `Sequential` executa uma de cada vez, na ordem do documento.
Um `completionCondition` verdadeiro encerra o escopo antes de todas rodarem,
descartando o que sobrou.

## Dados de entrada e saída

`dataInputAssociation` e `dataOutputAssociation` na forma `assignment/from/to`
copiam valores para dentro e para fora de um subprocesso ou call activity:

```xml
<bpmn:callActivity id="Chamar" calledElement="Cobranca">
  <bpmn:dataInputAssociation>
    <bpmn:assignment><bpmn:from>valorPedido</bpmn:from><bpmn:to>valor</bpmn:to></bpmn:assignment>
  </bpmn:dataInputAssociation>
  <bpmn:dataOutputAssociation>
    <bpmn:assignment><bpmn:from>recibo</bpmn:from><bpmn:to>reciboDaCobranca</bpmn:to></bpmn:assignment>
  </bpmn:dataOutputAssociation>
</bpmn:callActivity>
```

Declarar um mapeamento de entrada **isola** o escopo: o processo chamado passa a
enxergar apenas o que foi mapeado, e o que ele escreve fica nele — só o
mapeamento de saída atravessa de volta. Sem mapeamento nenhum, o escopo filho
continua lendo as variáveis do pai pela cadeia de escopos.

## Repetição de atividades

### Multi-instância

`multiInstanceLoopCharacteristics` executa a atividade uma vez por instância,
com `isSequential` decidindo entre paralelo e uma de cada vez.

| Atributo              | Uso                                                                 |
| --------------------- | ------------------------------------------------------------------- |
| `loopCardinality`     | Expressão que devolve o número de instâncias.                       |
| `loopDataInputRef`    | Referência ao elemento de dados cuja **variável** contém a coleção. |
| `inputDataItem`       | Nome da variável local que recebe o item da vez.                    |
| `loopDataOutputRef`   | Variável do processo que recebe uma entrada por instância.          |
| `outputDataItem`      | Variável local lida ao fim de cada instância para compor a saída.   |
| `completionCondition` | Avaliada após cada instância; verdadeira cancela as restantes.      |

Cada instância roda em seu próprio escopo, com `loopCounter` (índice) e o item.
Zero instâncias significa atividade pulada, como manda a especificação.

### Loop padrão

`standardLoopCharacteristics` repete a atividade enquanto `loopCondition` for
verdadeira. `testBefore` avalia a condição antes da primeira iteração;
`loopMaximum` limita as repetições (o padrão do motor é 1000).

## Timers

`timeDuration` (ISO-8601), `timeDate` (data absoluta) e `timeCycle` (só o
intervalo) são resolvidos para uma data de vencimento no momento em que o token
para no evento — ou em que a atividade com evento de borda começa a esperar.
`tick(now?)` dispara o que venceu; anos e meses de duração usam 365 e 30 dias.

Um timer de borda é desarmado quando a atividade termina antes do prazo, e o
vencimento faz parte do estado serializado, então sobrevive a um restart.

Um ciclo (`R3/PT1H`, `R/PT1H`) em evento de borda **não interrompente** rearma a
cada disparo — três lembretes de hora em hora, ou lembretes enquanto a atividade
durar. As repetições restantes também fazem parte do estado.

## Raias e atribuição

`laneSet`/`lane` (incluindo raias aninhadas) associam cada nó a uma raia, cujo
nome vai para `FlowNode.lane`. `potentialOwner` e `performer` viram
`FlowNode.candidates` — a expressão formal é lida como texto e dividida por
vírgula, de modo que `gerentes, diretoria` são dois papéis.

O motor não faz controle de acesso: ele expõe a atribuição em `tasks()` e cabe à
aplicação decidir quem pode concluir a tarefa.

## Dados e escopo de variáveis

O processo, cada subprocesso e cada instância de multi-instância formam uma
cadeia de escopos. A leitura de uma variável sobe a cadeia (o escopo mais
interno vence) e a escrita vai para o escopo que já define a variável, caindo no
escopo do processo quando ela é nova — o comportamento que se espera de
"variável de processo". Um handler pode escrever só no escopo atual com
`ctx.setLocal()`.

Divergência: a especificação modela dados com `ioSpecification`, `dataObject` e
associações formais. Aqui, `loopDataInputRef` é lido como o **nome da variável**
que contém a coleção, o que mantém os diagramas legíveis sem exigir uma
especificação de I/O completa.

## Gateways

### Exclusivo (XOR)

Avalia os fluxos de saída na ordem do documento e toma o **primeiro** cuja
condição é verdadeira, ignorando o fluxo default. Se nenhum casar, usa o
default. Sem default e sem condição verdadeira, a execução falha — conforme a
especificação, que trata isso como erro de modelagem.

### Paralelo (AND)

- **Divisão**: cria um token em cada fluxo de saída.
- **Junção**: contabiliza um token por fluxo de entrada e só prossegue quando
  todos chegaram, consumindo exatamente um de cada (o excedente permanece
  contabilizado para uma próxima rodada, como manda a semântica de instâncias
  múltiplas de um mesmo fluxo).

### Inclusivo (OR)

- **Divisão**: toma **todos** os fluxos cuja condição é verdadeira; se nenhum
  for, toma o default.
- **Junção**: os tokens ficam em buffer, e a junção dispara quando o motor
  atinge quiescência e **nenhum outro token do escopo consegue mais alcançar o
  nó de junção** (análise de alcançabilidade sobre o grafo). É a leitura da
  especificação que evita tanto deadlock quanto disparo prematuro; contar
  fluxos de entrada não funciona quando a divisão foi condicional.

### Baseado em evento

Arma todos os eventos-alvo dos fluxos de saída. O primeiro gatilho recebido
vence, e as alternativas são canceladas.

### Complexo

Com `activationCondition`, a junção dispara quando a expressão fica verdadeira —
o número de tokens que chegaram é exposto como `arrived`, o que dá quórum
("2 de 3 aprovadores"). Sem a expressão, comporta-se como inclusivo.

## Fluxos de sequência

Condições (`conditionExpression`) são avaliadas sobre as variáveis visíveis no
escopo do token, com suporte ao invólucro `${ ... }`. O avaliador padrão lê um
subconjunto de JavaScript — sem função anônima, atribuição, `new` ou chamada
fora da allowlist — e o interpreta sem compilar código; `expressions:
'javascript'` troca isso pela linguagem inteira, para diagramas confiáveis.
Variável inexistente lê como `undefined` em vez de lançar — `pago !== true` é
verdadeiro antes de alguém definir `pago`, como num avaliador FEEL. Uma
expressão que lança, que o avaliador seguro recusa, ou que não retorna `true`, é
tratada como falsa (fail-closed).

## Divergências assumidas

1. **O motor não tem relógio próprio.** Ele calcula o vencimento e o host chama
   `tick()` — o `@bpmn-flow/server` faz isso em intervalo configurável. Um ciclo
   (`R3/PT10M`) repete só em evento de borda não interrompente, que é onde
   repetir faz sentido.
2. **Gateway complexo sem `activationCondition`** cai no comportamento
   inclusivo, em vez de recusar o diagrama.
3. **Modo `auto`.** Fora da especificação, existe para simular execuções:
   resolve automaticamente qualquer espera e, quando um gateway não tem default
   nem condição verdadeira, toma o primeiro fluxo de saída. O modo `automation`
   (padrão) segue a especificação.
4. **Mapeamento de dados por `assignment`.** As data associations são lidas na
   forma `assignment/from/to` (expressões); `ioSpecification` com data inputs e
   outputs formais não é interpretado.
5. **Correlação de mensagem por chave.** `signal(name)` continua sendo o
   broadcast que a spec define para sinal. Para mensagem, `correlate(name, chave)`
   entrega ponto a ponto: a chave vem de `extensionElements`
   (`correlationKey="=pedidoId"`, como as ferramentas BPMN escrevem) e é avaliada
   contra as variáveis da instância. O mecanismo padrão
   (`correlationSubscription` + `correlationPropertyBinding`) não é lido, e um
   assinante sem chave declarada aceita a mensagem pelo nome.
6. **DMN está fora de escopo.** `businessRuleTask` executa o handler que você
   registrar, e é por ali que um motor de decisão entra.
7. **`options.decide`.** Extensão opcional: quando registrada, o gateway
   exclusivo/inclusivo pergunta ao host antes de rotear, e a resposta se sobrepõe
   às condições. Serve a simulação e a decisão humana; sem ela nada muda, o
   gateway decide pelos dados como manda a especificação.

## Medição

O histórico grava `enter` e `complete` com carimbo de tempo do relógio do motor
(`options.now`) e uma sequência explícita. `metrics()` pareia os dois por nó e
devolve tempo total, médio e máximo por atividade — uma atividade
multi-instância reporta uma entrada por instância, e não uma para o conjunto.

## Layout e renderização

O modelo normalizado ignora a interchange de diagrama (DI). A renderização usa o
XML original; diagramas sem DI recebem posicionamento automático no viewer
(`bpmn-auto-layout`). O editor `bpmn-js` do playground, porém, exige DI.
