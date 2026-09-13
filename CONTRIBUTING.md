# Contribuindo

Obrigado pelo interesse. Este é um monorepo npm workspaces com quatro pacotes
(`core`, `viewer`, `server`, `cli`) e um playground — a arquitetura está em
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) e a aderência ao padrão em
[`docs/BPMN-STANDARD.md`](docs/BPMN-STANDARD.md).

## Começando

```bash
git clone https://github.com/Bappoz/bpmn-flow.git
cd bpmn-flow
npm ci           # instala e builda (script `prepare`)
npm run verify   # build + format + lint + typecheck + test
npm run dev      # playground (o Vite imprime a URL)
```

Node 20 ou 22 — o `.nvmrc` fixa 22, e o CI verifica as duas. O `npm ci` já
builda porque o playground e os testes de tipo consomem os `dist/` uns dos
outros; o build vem antes do typecheck pelo mesmo motivo.

## O gate

`npm run verify` é exatamente o que o CI roda, na mesma ordem. **Um PR com
`verify` vermelho não entra** — cole a saída se estiver travado em vez de
contornar.

```bash
npm run build        # compila todos os pacotes, em ordem de dependência
npm run format       # Prettier escreve
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit em cada workspace
npm test             # Vitest (packages/* e apps/*)
npm run coverage     # com relatório de cobertura
```

## Fluxo

1. Abra (ou comente em) uma issue antes de um PR grande, para não duplicar
   trabalho.
2. Branch a partir de `master`: `feat/`, `fix/`, `docs/`, `refactor/`,
   `test/`, `chore/`.
3. **Um commit por mudança lógica**, em
   [Conventional Commits](https://www.conventionalcommits.org/):
   `fix(server): answer 400 on malformed bodies`. Escopo é o pacote
   (`core`, `viewer`, `server`, `cli`, `playground`, `deps`, `ci`).
4. Descreva no corpo o _porquê_, não o _o quê_ — o diff já diz o quê.
   `Closes #N` fecha a issue.
5. Abra o PR com o template preenchido.

## Bug e teste

Correção de bug entra com o **teste que falha antes dela**. Se a suíte atual não
pega o bug, esse teste é a primeira parte do PR — é o que impede a regressão de
voltar.

Teste comportamento e contrato, não implementação. As fixtures BPMN ficam em
`packages/core/test/fixtures.ts`, uma por padrão de execução, sem layout
(interchange de diagrama) — o motor só precisa da semântica.

## Estilo

- **Corretude > performance > estilo.** O linter e o Prettier do repo mandam;
  não reformate arquivo inteiro numa mudança pontual.
- TypeScript `strict`, sem `any` novo (`unknown` + narrowing), sem `as` para
  calar o compilador.
- Comentário explica o **porquê** quando ele não é óbvio no código. Os
  comentários existentes são a referência de tom.
- Sem dependência nova sem justificar. Preferir a stdlib quando o custo é
  aceitável: o `core` não tem dependência de runtime além do `bpmn-moddle`.
- Docstring em inglês no código; o README e os docs estão em PT-BR.

## Mudança que toca o motor

- **Semântica BPMN**: diga qual parte da especificação ela implementa e
  atualize `docs/BPMN-STANDARD.md`, que documenta a aderência elemento por
  elemento (inclusive as divergências assumidas).
- **Estado serializado**: mudar a forma de `EngineState` exige bumpar
  `ENGINE_STATE_VERSION` (`packages/core/src/engine/state.ts`) — `restore()`
  recusa versão diferente de propósito.
- **Expressões**: qualquer coisa que amplie o que o avaliador seguro aceita é
  mudança de segurança. Leia [`SECURITY.md`](SECURITY.md) antes.

## Adicionando um diagrama de exemplo

Salve o `.bpmn` em `bpmn-files/` e adicione a linha na tabela de
`bpmn-files/README.md`. Layout (DI) é opcional para o viewer e obrigatório para
o editor do playground.

## Segurança

Vulnerabilidade **não** vai para issue pública: siga
[`SECURITY.md`](SECURITY.md).
