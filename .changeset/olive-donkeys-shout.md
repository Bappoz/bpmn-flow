---
'@bpmn-flow/core': minor
'@bpmn-flow/viewer': minor
'@bpmn-flow/server': minor
'@bpmn-flow/cli': minor
---

`restore()` preserva o modo de expressão.

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
