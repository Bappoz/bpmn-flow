# Arquitetura

Este documento descreve as decisões de design do BPMN Flow.

## Objetivos

- Separar semântica (parsing e execução) de apresentação (renderização).
- Manter o núcleo isomórfico, executável no backend e no frontend.
- Oferecer uma API pequena e previsível, fácil de embutir em qualquer projeto.

## Camadas

```
XML BPMN
   |  parseBpmn (bpmn-moddle)
   v
ProcessModel  ---- ProcessGraph (índices O(1))
   |  WorkflowEngine
   v
ExecutionSnapshot  ----> BpmnFlowViewer (bpmn-visualization)
                   ----> API REST (@bpmn-flow/server)
```

### Modelo (`@bpmn-flow/core/model`)

Estrutura de dados simples e serializável. Cada elemento BPMN é mapeado para um
`FlowNode` tipado por `kind`, evitando que as camadas superiores toquem em nomes
de tipo do XML. A interchange de diagrama (posições, tamanhos) é omitida de
propósito: o viewer renderiza direto do XML original.

`ProcessGraph` indexa nós, fluxos e eventos de borda para acesso constante
durante a execução.

`variables.ts` e `decisions.ts` leem o diagrama sem executá-lo: o primeiro
descobre quais variáveis as expressões consomem, o segundo transforma os
gateways à frente de um nó em pergunta ("por qual caminho?") mais os valores que
respondem cada alternativa. É o que permite uma UI perguntar antes do token
chegar lá, em vez de mostrar só o caminho já escolhido.

### Parser (`@bpmn-flow/core/parser`)

Usa `bpmn-moddle` para ler o XML. O wiring de entrada/saída de cada nó é
derivado dos próprios fluxos de sequência, e não dos arrays opcionais do nó,
tornando o parsing robusto a diagramas inconsistentes. Subprocessos são lidos
recursivamente como escopos aninhados.

O contrário também existe: `addFlowReferences` escreve de volta o
`<bpmn:incoming>`/`<bpmn:outgoing>` de cada nó. É redundante para o motor, mas
o resto do ecossistema lê só esses elementos — o `bpmn-auto-layout` posiciona as
caixas e não desenha aresta nenhuma sem eles.

### Motor (`@bpmn-flow/core/engine`)

Execução por tokens. Um token representa uma linha de controle posicionada em um
nó. O laço principal (`drain`) processa tokens prontos um a um; handlers podem
ser assíncronos, e tarefas de usuário, eventos de captura e gateways baseados em
evento parametrizam estados de espera.

Decisões por construção:

- Gateway exclusivo: primeira condição verdadeira, senão o fluxo default.
- Gateway paralelo: junção conta um token por fluxo de entrada antes de seguir,
  depois divide em todas as saídas.
- Gateway inclusivo: a junção dispara quando nenhum outro token do escopo ainda
  consegue alcançar o nó de junção (análise de alcançabilidade no grafo).
- Gateway baseado em evento: arma os eventos seguintes; o primeiro gatilho vence
  e cancela as alternativas.
- Subprocessos: criam um escopo filho e suspendem o token pai até a conclusão;
  eventos de borda (interrompentes e não) podem desviar o fluxo.
- Evento de fim terminate: cancela todos os tokens do escopo.
- Event subprocess: sem token de entrada — o gatilho cria um escopo filho e, se
  o evento de início for interrompente, cancela o trabalho do escopo que o
  declara.
- Multi-instância: cada instância roda num escopo próprio (com `loopCounter` e o
  item), o token da atividade fica suspenso até todas terminarem, e a coleção de
  saída é montada instância a instância. Um evento de borda pertence à atividade
  como um todo: dispará-lo cancela todas as instâncias.
- Compensação: cada atividade compensável concluída entra numa pilha do escopo;
  um evento de compensação executa os tratadores na ordem inversa antes de o
  token seguir. `transaction` + cancel faz isso e sai pelo evento de borda de
  cancelamento.
- Falha de handler: `BpmnError` é erro de negócio (evento de borda/event
  subprocess); qualquer outro erro passa por `retry` e, com
  `onHandlerError: "incident"`, vira incidente em vez de matar a execução.

Timers viram data de vencimento (`resolveTimerDueAt`) quando o token para no
evento — ou quando a atividade com evento de borda começa a esperar. O motor não
tem relógio: `tick(now?)` dispara o que venceu, e `now` é injetável, o que deixa
o teste de timer determinístico e sem `sleep`.

O modo `auto` resolve automaticamente qualquer estado de espera, útil para
simular e animar uma execução sem handlers ou gatilhos externos.

Variáveis vivem por escopo: processo, subprocesso e instância de multi-instância
formam uma cadeia. Leitura sobe a cadeia, escrita vai para quem já define a
variável (senão para o processo), e `ctx.setLocal()` força o escopo atual.

Avaliação de condições: as expressões do diagrama são avaliadas sobre as
variáveis visíveis no escopo, em um de dois modos (`EngineOptions.expressions`).

O padrão é `safe` (`engine/safe-expression.ts`): a expressão é tokenizada,
transformada em árvore por um parser de precedência e interpretada. Nada é
compilado, então um diagrama de origem desconhecida — o caso do servidor, que
aceita XML por HTTP — não alcança o processo. O alcance de uma chamada é
delimitado por duas allowlists: os globais expostos membro a membro (`Math`,
`JSON`, `Number`, `Array.isArray`, ...) e os métodos de consulta chamáveis sobre
um valor das variáveis. Leitura de propriedade é livre, exceto os nomes que
voltam para código (`constructor`, `prototype`, `__proto__`, `call`, `apply`,
`bind`). Não há atribuição, `new`, função anônima nem statement.

O modo `javascript` compila a expressão com `new Function` e avalia sobre um
`Proxy` que cobre o `with`. Ele confia na definição tanto quanto no código ao
redor, e por isso é opt-in.

Em ambos, um identificador desconhecido lê como `undefined` e uma expressão que
lança — ou que o modo seguro recusa — é tratada como `false` (fail-closed), de
modo que um guard malformado nunca derruba a execução. `validateBpmn` sinaliza
com `warning` a expressão que o modo seguro não consegue ler.

### Viewer (`@bpmn-flow/viewer`)

Envolve `bpmn-visualization`. Aplica o estado por `ExecutionSnapshot` (fonte de
verdade) e/ou anima incrementalmente via eventos do motor. Os ids dos elementos
do modelo coincidem com os ids no diagrama, então o mapeamento é direto.
Diagramas sem interchange de diagrama (DI) são posicionados com
`bpmn-auto-layout` antes da renderização.

### Servidor (`@bpmn-flow/server`)

Aplicação Hono. Mantém sessões de execução em cache, cada uma com uma instância
do motor, permitindo dirigir um processo passo a passo por HTTP. Com um
`SessionStorage` configurado (implementação em arquivo incluída), cada mudança é
gravada e uma sessão fora do cache é reconstruída por `WorkflowEngine.restore()`.
Serve também exemplos `.bpmn` e assets estáticos com fallback de SPA.

## Limitações conhecidas

- Timers não avançam sozinhos no modo automation; são disparados via `signal`
  (ou resolvidos no modo auto). Não há agendador.
- Call activity não resolve `calledElement`: a atividade é tratada como uma
  tarefa comum, sem instanciar o processo chamado.
- A junção inclusiva usa alcançabilidade estrutural, adequada para modelos bem
  formados; topologias muito irregulares podem exigir revisão.
- Mapeamento de dados (`ioSpecification`), correlação de mensagem por chave e
  DMN continuam fora do escopo do motor.
- O editor do playground (`bpmn-js`) exige DI no XML. Diagramas sem layout
  abrem no viewer (auto-layout), mas não no editor.
