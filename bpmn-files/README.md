# Diagramas de exemplo

Arquivos `.bpmn` usados pelo playground e pelo `@bpmn-flow/server`. O playground
embute estes arquivos no build (`import.meta.glob`) e, quando há servidor, lista
os que estiverem neste diretório (`GET /api/samples`).

| Arquivo                            | Processo            | O que exercita                                                                                | Layout (DI) |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| `diagram.bpmn`                     | Process_1           | Menor caso possível: início → tarefa → fim.                                                   | sim         |
| `processo-simples.bpmn`            | Processo Simples    | Gateway exclusivo com dois fins (aprovado / rejeitado).                                       | sim         |
| `processo-compras.bpmn`            | Processo de Compras | Tarefa de usuário, service task e **dois gateways exclusivos com condições** sobre variáveis. | sim         |
| `processo-gestao-projeto.bpmn`     | Gestão de Projeto   | 13 tarefas de usuário, **gateways paralelos** (divisão e junção) e um subprocesso embutido.   | não         |
| `processo-pedido-itens.bpmn`       | Processo de Pedido  | **Multi-instância** sobre a coleção `itens`, com coleção de saída e gateway condicional.      | sim         |
| `processo-aprovacao-coletiva.bpmn` | Aprovação Coletiva  | Multi-instância de **tarefa de usuário**: uma aprovação por pessoa de `aprovadores`.          | sim         |
| `processo-suporte-sla.bpmn`        | Atendimento com SLA | **Timer de borda** (`PT2H`), raias e papéis (`potentialOwner`).                               | sim         |
| `processo-viagem-compensacao.bpmn` | Reserva de Viagem   | **Compensação**: pagamento reprovado desfaz hotel e voo, nessa ordem.                         | sim         |

## Executando o processo de compras

As condições estão nos fluxos de saída dos gateways (`valor > 1000` e
`aprovado === true`), então o caminho muda conforme as variáveis informadas:

| Variáveis                              | Caminho                                           |
| -------------------------------------- | ------------------------------------------------- |
| `{ "valor": 500, "aprovado": true }`   | Pula a aprovação gerencial → Compra Realizada     |
| `{ "valor": 2500, "aprovado": true }`  | Passa pela aprovação gerencial → Compra Realizada |
| `{ "valor": 2500, "aprovado": false }` | Passa pela aprovação gerencial → Compra Rejeitada |

## Executando o processo de pedido

`SepararItem` é multi-instância sobre a variável `itens`: uma instância por
item, cada uma com `item` e `loopCounter` próprios, agregando `separados`.

| Variáveis                                      | Resultado                                                  |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `{ "itens": ["teclado", "mouse"] }`            | 2 instâncias, segue direto para a nota fiscal              |
| `{ "itens": ["teclado", "mouse", "monitor"] }` | 3 instâncias e passa pela conferência (`itens.length > 2`) |

## Executando os processos novos

| Diagrama                           | Variáveis                                  | O que acontece                                              |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `processo-aprovacao-coletiva.bpmn` | `{ "aprovadores": ["ana", "bob", "cid"] }` | 3 tarefas simultâneas, uma por aprovador                    |
| `processo-suporte-sla.bpmn`        | `{}`                                       | Para em "Atender Chamado"; o timer de 2h escala se estourar |

No playground, o botão **Adiantar relógio** no painel de timers força o
vencimento sem esperar as duas horas.

## Executando a reserva de viagem

Com `{ "pago": false }` o evento de compensação desfaz o que já tinha sido
reservado, na ordem inversa (hotel e depois voo). Com `{ "pago": true }` o
processo segue direto para "Viagem Confirmada" e nada é desfeito. Pela linha de
comando, com automação de verdade:

```bash
bpmn-flow run bpmn-files/processo-viagem-compensacao.bpmn \
  --vars '{"pago":false}' --handlers ./handlers.mjs
```

## Executando a colaboração

`processo-colaboracao-pedido.bpmn` tem dois pools que rodam ao mesmo tempo. O
`bpmn-flow run` percebe isso e usa o `CollaborationEngine`:

```bash
bpmn-flow run bpmn-files/processo-colaboracao-pedido.bpmn
```

```
status: waiting
pool Cliente (Processo_Cliente): waiting
  path: Cliente_Inicio -> Cliente_Enviar
pool Loja (Processo_Loja): waiting
  path: Loja_Inicio -> Loja_Receber
messages:
  Pedido: Processo_Cliente -> Processo_Loja (Loja_Receber)
pending:
  Processo_Cliente: [t2] Confirmação recebida (catchEvent)
  Processo_Loja: [t2] Separar itens (userTask)
```

O pedido já atravessou o message flow; concluir "Separar itens" faz a loja
confirmar e o cliente receber a confirmação, fechando os dois pools.

No playground, que executa um pool por vez, este arquivo carrega o processo do
**Cliente** (o primeiro executável) — o pool da Loja aparece no desenho mas não
recebe token.

## Diagramas sem layout

`processo-gestao-projeto.bpmn` não tem interchange de diagrama (DI). O viewer
calcula o layout automaticamente (`bpmn-auto-layout`), mas o editor `bpmn-js` do
playground exige DI e não consegue abri-lo.

## Adicionando um arquivo

Basta salvar o `.bpmn` neste diretório — não há índice para atualizar. Pelo
playground, o botão "Salvar no repositório" valida o diagrama e grava aqui
(requer o `@bpmn-flow/server` em execução com `--samples bpmn-files`).

O formato esperado é BPMN 2.0 padrão, com `<bpmn:process>` e ids únicos. O
`<bpmndi:BPMNDiagram>` é opcional para o viewer e obrigatório para o editor.
