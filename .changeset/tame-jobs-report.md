---
'@bpmn-flow/core': minor
'@bpmn-flow/viewer': minor
'@bpmn-flow/server': minor
'@bpmn-flow/cli': minor
---

Estado de espera para job externo.

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
