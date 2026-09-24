---
'@bpmn-flow/core': patch
'@bpmn-flow/viewer': patch
'@bpmn-flow/server': patch
'@bpmn-flow/cli': patch
---

`failJob` com `BpmnError` deixa de emitir `activity.end` para um job parado,
que nunca emitiu `activity.start`. O viewer marcava a atividade como concluída
quando ela tinha sido interrompida pelo erro.
