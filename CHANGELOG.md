# Changelog

Cada pacote publicável tem o seu próprio changelog, gerado a partir dos
changesets:

- [`@bpmn-flow/core`](packages/core/CHANGELOG.md)
- [`@bpmn-flow/viewer`](packages/viewer/CHANGELOG.md)
- [`@bpmn-flow/server`](packages/server/CHANGELOG.md)
- [`@bpmn-flow/cli`](packages/cli/CHANGELOG.md)

Os quatro carregam a **mesma versão**: o `server` e o `cli` dependem do
comportamento exato do motor, então publicar um sem o outro só produz
combinações não testadas. A configuração está em
[`.changeset/config.json`](.changeset/config.json).

## Como uma mudança chega ao changelog

```bash
npx changeset          # descreve a mudança e escolhe o tipo de bump
```

O arquivo gerado em `.changeset/` entra no mesmo PR da mudança. Um PR que só
mexe em CI, teste ou documentação interna não precisa de changeset.

Antes de 1.0, **`minor` é o bump de quebra de compatibilidade** e `patch` é
correção sem mudança de contrato.

## Como uma versão é publicada

O workflow [`release.yml`](.github/workflows/release.yml) roda a cada push em
`master` e tem duas saídas:

| Situação                             | O que acontece                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Há changesets pendentes              | Abre (ou atualiza) o PR **"chore(release): version packages"** com os bumps e os changelogs. |
| Não há (o PR de versão foi mergeado) | Publica os pacotes no npm com provenance e cria as tags.                                     |

Precisa do secret `NPM_TOKEN` (token de automação com permissão de publish na
org `@bpmn-flow`). Sem ele o passo de publish falha e o de versionamento
continua funcionando.

Para conferir localmente o que iria no tarball de cada pacote:

```bash
npm run build
npm run release:dry
```
