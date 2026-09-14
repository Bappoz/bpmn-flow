# @bpmn-flow/playground

Aplicação interativa para carregar, visualizar e executar processos BPMN no
navegador. Combina `@bpmn-flow/core` (execução) e `@bpmn-flow/viewer`
(renderização). Os arquivos de exemplo em `bpmn-files/` são embutidos no build.

## Desenvolvimento

Na raiz do repositório:

```bash
npm install
npm run build            # compila core e viewer (dependências)
npm run dev              # sobe o playground em http://localhost:5173
```

## Build e publicação numa porta

```bash
npm run build --workspace @bpmn-flow/playground
node packages/server/dist/bin.js --static apps/playground/dist --samples bpmn-files --port 3000
```

## Como usar a interface

Há dois modos, alternados pelos botões "Executar" e "Editar".

### Executar

- Selecione um exemplo ou use "Carregar arquivo" para abrir um `.bpmn` próprio.
- "Iniciar" executa em modo automation: a execução pausa em tarefas de usuário e
  eventos de captura, exibindo botões para concluir ou sinalizar.
- "Executar tudo" roda em modo auto até o fim.
- Informe variáveis em JSON para influenciar os gateways condicionais. No
  `processo-compras`, `{ "valor": 2500, "aprovado": false }` leva à rejeição e
  `{ "valor": 500, "aprovado": true }` pula a aprovação gerencial.
- O painel de **ações pendentes** mostra um cartão por tarefa, com a raia, os
  papéis (`potentialOwner`) e — numa atividade multi-instância — o item daquela
  instância.
- O painel de **timers** lista os prazos pendentes; "Adiantar relógio" força o
  vencimento do próximo, útil para demonstrar um SLA sem esperar.
- O painel mostra status, variáveis e o histórico da execução; o diagrama
  destaca nós concluídos, tokens ativos, atividades em espera e fluxos
  percorridos.
- "Run" conduz a execução passo a passo: anima o caminho no diagrama e, a cada
  parada, abre um diálogo com o que depende de uma pessoa — concluir a
  atividade, informar um valor, escolher o caminho do gateway seguinte (as
  opções vêm das condições do próprio diagrama, e marcar uma preenche os valores
  que levam até ela). Num processo sem tarefa nenhuma — o
  `processo-viagem-compensacao`, por exemplo — a pergunta acontece no próprio
  gateway, quando o token chega nele: a escolha vale mais que a condição. "Seguir sem perguntar" responde o resto sozinho e "Parar"
  interrompe, devolvendo o diagrama ao estado real. Durante a condução o botão
  vira "Parar". "Métricas" liga etiquetas de tempo médio em cada atividade.
- O painel **Variáveis do processo** lista o que o diagrama lê, com a expressão
  que consome cada variável, e a caixa JSON já vem preenchida com valores que
  fazem o processo andar.
- O botão na borda do painel recolhe e expande a lateral; a escolha fica
  guardada entre sessões.
- Diagramas sem layout são posicionados automaticamente; use "Ajustar" para
  enquadrar e o mouse para navegar (arrastar) e dar zoom (roda).

### Editar

- Cria e edita diagramas com o editor `bpmn-js` (paleta à esquerda).
- "Novo" começa um diagrama em branco; "Abrir arquivo" carrega um `.bpmn`.
- "Validar" verifica a estrutura BPMN com o `@bpmn-flow/core` e lista erros e
  avisos.
- "Salvar no repositório" valida e grava o `.bpmn` no diretório de exemplos do
  servidor (`--samples`). A gravação exige o `@bpmn-flow/server` em execução.
  Nomes aceitam apenas letras, números, hífen e sublinhado.

Limitações conhecidas do modo editar: o `bpmn-js` exige interchange de diagrama
(DI), então diagramas sem layout — como `processo-gestao-projeto.bpmn` — não
abrem no editor, e o editor mantém em memória o primeiro diagrama aberto na
sessão.

## Como o bundle é dividido

As duas bibliotecas de renderização são a maior parte do peso, e nenhuma das
duas precisa estar no primeiro download:

| Chunk                   | Conteúdo                                     | Quando é baixado                     |
| ----------------------- | -------------------------------------------- | ------------------------------------ |
| `index-*.js` (~207 kB)  | Interface, motor (`@bpmn-flow/core`), estado | No carregamento da página            |
| `dist-*.js` (~1,0 MB)   | `@bpmn-flow/viewer` + `bpmn-visualization`   | Ao carregar o primeiro diagrama      |
| `editor-*.js` (~495 kB) | `bpmn-js` e o CSS do editor                  | Só quando o modo **Editar** é aberto |

`src/diagram-view.ts` existe para isso: concentra o `import` do viewer (e o CSS
dele) num módulo carregado por `import()`, o que faz o Vite emitir o chunk
separado. O editor segue o mesmo caminho, por `import('./editor.js')` dentro de
`ensureEditor()`.

Quem abre a demo e só executa processos nunca baixa o editor.

## Estrutura do código

Cada módulo tem o seu próprio estado; `main.ts` só monta e liga os eventos.

| Módulo            | Responsabilidade                                                         |
| ----------------- | ------------------------------------------------------------------------ |
| `main.ts`         | Resolve os elementos, monta os módulos, liga os eventos. Sem lógica.     |
| `elements.ts`     | Os nós do HTML, resolvidos uma vez e passados por parâmetro.             |
| `samples.ts`      | De onde vêm os exemplos: do servidor, ou embutidos no bundle.            |
| `run-mode.ts`     | Diagrama carregado, motor, viewer e os comandos de execução.             |
| `guided-run.ts`   | A condução: animação, diálogo por parada e os gateways já respondidos.   |
| `guided.ts`       | Qual é a próxima parada e o que perguntar nela — função pura, com teste. |
| `panel.ts`        | A lateral inteira. Só desenha; todo clique volta por um port.            |
| `edit-mode.ts`    | O editor `bpmn-js`, a validação e a gravação do exemplo.                 |
| `diagram-view.ts` | Concentra o import do viewer para ele virar um chunk próprio.            |

O que dá para testar sem DOM está em `guided.ts`, coberto em
`test/guided.test.ts`; o resto é ligação com a página.
