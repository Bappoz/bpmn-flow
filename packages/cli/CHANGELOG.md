# @bpmn-flow/cli

## 0.2.0

### Minor Changes

- f70cb76: `restore()` preserva o modo de expressão.

  `WorkflowEngine.restore()` aceitava `expressions` na assinatura e não repassava
  ao construtor, e `EngineState` não guardava o modo — então todo motor
  restaurado voltava para `safe` em silêncio. Um processo publicado com
  `expressions: 'javascript'` decidia gateways de um jeito antes de um restart e
  de outro depois, porque a condição que o avaliador seguro recusa lê como
  `undefined` e o token sai pelo fluxo padrão. `CollaborationEngine.restore()`
  repassava a opção e perdia igual.

  `expressions` agora faz parte de `EngineState` e é restaurado como `mode` e
  `maxSteps` já eram: o valor gravado vale, e a opção do chamador tem
  precedência.

  **Quebra de compatibilidade** — `ENGINE_STATE_VERSION` vai de 9 para 10, porque
  `EngineState` ganhou o campo obrigatório `expressions`. Estado serializado por
  uma versão anterior é recusado por `restore()`.

- a5b3374: Estado de espera para job externo.

  Uma service task, send task ou outra atividade automática marcada no diagrama
  como job externo agora **espera** um worker em vez de passar direto. A marcação
  é lida de `zeebe:taskDefinition` (`type`, `retries` opcional) sob
  `extensionElements`, ou do `camunda:type="external"` com `camunda:topic` do
  Camunda 7. Ela aparece em `FlowNode.job`.

  Novo `WaitReason: 'job'`; `PendingTask.job` carrega a fila do worker;
  `engine.tasks({ reason: 'job' })` lista o trabalho pendente. Um handler
  registrado localmente continua ganhando da espera por job — é o que deixa um
  teste dublar um worker sem subir infraestrutura nenhuma.

  `engine.failJob(tokenId, error)` deixa um worker reportar falha: um
  `BpmnError` dispara o error boundary event correspondente; qualquer outro erro
  segue o mesmo caminho retry → incidente que um handler que lança já seguia.

  `WorkflowEngine.restore` passa a aceitar também `onHandlerError` e `retry`.
  Isso importa na prática: nenhuma das duas opções faz parte de `EngineState`,
  então quem restaura sem repassá-las volta com o motor no padrão `'fail'` e sem
  tentativas automáticas.

  **`ENGINE_STATE_VERSION` não mudou** — estado gravado por versões anteriores
  continua sendo restaurável.

  De carona, duas correções: `incidentList()` deixa de reportar uma atividade
  que falhou mas já foi reenfileirada para outra tentativa, e `completeTask`
  agora limpa a contabilidade de incidente do token que ela conclui.

- 67b4f6b: Collaboration, message correlation and a round of correctness fixes.

  **Colaboração** — `CollaborationEngine` executa todos os pools executáveis de um
  diagrama e roteia cada `messageFlow` do nó de origem para o de destino, ponto a
  ponto. `bpmn-flow run` usa isso sozinho quando o arquivo tem mais de um pool
  executável.

  **Correlação de mensagem** — `engine.correlate(nome, chave)` e
  `engine.subscribedTo(nome, chave?)` entregam uma mensagem só para a instância
  cuja chave bate, lida de `extensionElements` (`correlationKey="=pedidoId"`).
  `SessionStore.correlate` e `POST /api/messages` roteiam sem o chamador saber a
  sessão. `signal()` continua sendo o broadcast que a spec define.

  **Novo no modelo** — `dataObject`, `dataObjectReference`, `dataStore` e
  `dataStoreReference` viram `ProcessModel.dataElements` e `BpmnModel.dataStores`;
  `parallelMultiple` passa a ser respeitado (o evento múltiplo espera todos os
  gatilhos); `BpmnModel.unsupported` registra o que o parser vê e não modela.

  **Correções** — o motor roda o primeiro processo _executável_ em vez do primeiro
  declarado; `getState()` serializa as boundaries condicionais já disparadas (um
  boundary não interrompente deixa de disparar duas vezes depois de `restore()`);
  o servidor serializa o acesso ao engine por sessão e responde 400 em corpo JSON
  inválido; `validate()` detecta referência de fluxo pendurada, `attachedToRef`
  inválido e `calledElement` sem processo, e avisa sobre o que o motor ignora.

  **Servidor** — índice em memória em vez de reler o diretório de sessões a cada
  segundo, e cache limitado (`maxCachedSessions`) em vez de crescer sem fim.

  **Quebra de compatibilidade** — `ENGINE_STATE_VERSION` vai de 7 para 9: estado
  serializado por uma versão anterior é recusado por `restore()`. `BpmnModel`
  ganhou os campos obrigatórios `dataStores` e `unsupported`.

### Patch Changes

- a60e4d7: `failJob` com `BpmnError` deixa de emitir `activity.end` para um job parado,
  que nunca emitiu `activity.start`. O viewer marcava a atividade como concluída
  quando ela tinha sido interrompida pelo erro.
- Updated dependencies [9a7870b]
- Updated dependencies [f70cb76]
- Updated dependencies [a60e4d7]
- Updated dependencies [a5b3374]
- Updated dependencies [67b4f6b]
  - @bpmn-flow/core@0.2.0
