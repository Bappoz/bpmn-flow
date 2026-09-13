# Política de segurança

## Reportando uma vulnerabilidade

Use **[Security advisories](https://github.com/Bappoz/bpmn-flow/security/advisories/new)**
do GitHub (divulgação privada). Não abra issue pública para vulnerabilidade.

Inclua o diagrama BPMN mínimo que reproduz o problema, a versão dos pacotes e o
impacto que você conseguiu demonstrar. Resposta em até 7 dias.

## Modelo de confiança

O ponto sensível deste projeto é que **um diagrama BPMN contém expressões** —
condições de fluxo, cardinalidade de multi-instância, condição de conclusão — e
executar um diagrama significa avaliar essas expressões.

| Modo                        | Como avalia                                            | Quando usar                                           |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| `expressions: 'safe'`       | Interpreta um subconjunto de JavaScript, sem compilar  | **Padrão.** Qualquer diagrama de origem desconhecida. |
| `expressions: 'javascript'` | `new Function` — confia no diagrama como no seu código | Só para diagramas que você mesmo escreveu.            |

O avaliador seguro (`packages/core/src/engine/safe-expression.ts`) não tem
função anônima, atribuição, `new`, nem chamada fora da allowlist. Uma expressão
que ele recusa lê como `undefined` (a guarda simplesmente não abre) em vez de
executar.

`@bpmn-flow/server` aceita XML de quem chamar e por isso **nunca** deixa o
chamador escolher o modo: `SessionStoreOptions.expressions` é decisão do host
(`packages/server/src/sessions.ts`). Regressão coberta em
`packages/server/test/untrusted-xml.test.ts`.

### O que o motor não protege

- **Handlers são seu código.** Um `TaskHandler` roda com os privilégios do
  processo; validar o que ele recebe é responsabilidade de quem o registra.
- **Consumo de recursos.** `maxSteps` (100.000 por padrão) barra laço infinito,
  e loop padrão sem `loopMaximum` tem teto de 1.000 iterações — mas um diagrama
  hostil ainda pode ser caro. Rode execução não confiável com limite de tempo.
- **Persistência.** `FileSessionStorage` grava um JSON por sessão com as
  variáveis em claro. Dado sensível em variável de processo precisa de storage
  próprio.
- **DoS no HTTP.** O servidor não tem rate limit nem limite de tamanho de corpo;
  isso é trabalho do proxy à frente dele.

## Vulnerabilidades conhecidas em dependências

| Dependência                                     | Situação                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `mxgraph` (via `bpmn-visualization`, no viewer) | XSS em `setTooltips`, **sem correção upstream**. O viewer não chama essa função. Aceito e monitorado; o CI falha em `high`/`critical`. |

O CI roda `npm audit --audit-level=high` a cada PR e o Dependabot abre PR
semanal (`.github/dependabot.yml`).

## Versões suportadas

Pré-1.0: correção de segurança sai na última versão publicada de cada pacote.
Node 20 e 22 são as versões verificadas no CI.
