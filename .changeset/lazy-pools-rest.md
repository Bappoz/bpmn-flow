---
'@bpmn-flow/core': patch
---

`validate()` deixa de exigir evento de início de um pool caixa-preta. Um
participante não executável é desenhado justamente para dizer "não modelo o que
acontece aqui dentro" — não ter nó é a notação funcionando, não defeito. O aviso
de que o pool não roda continua; processo executável continua sendo cobrado.
