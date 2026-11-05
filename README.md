# Processo Vivo

**v0.13.0** — histórico em [CHANGELOG.md](./CHANGELOG.md).
Para saber qual versão está rodando: `GET /health` devolve o campo `versao`.

SaaS de consulta e acompanhamento de processos judiciais nos tribunais
brasileiros. Este repositório contém o **núcleo do MVP**: domínio, orquestrador
de busca híbrida, adapters de fonte de dados, uma API HTTP e um CLI.

> Regras de código, convenções e guia de extensão em **[CLAUDE.md](./CLAUDE.md)**.
> Deploy no Easypanel em **[DEPLOY.md](./DEPLOY.md)**.

---

## Por que "híbrido"

Nenhuma fonte sozinha atende um advogado:

- A **API Pública do DataJud (CNJ)** é gratuita e cobre ~91 tribunais, mas só tem
  metadados: **não indexa partes nem advogados** — logo, busca por OAB é
  impossível — e devolve o rótulo do movimento na tabela do CNJ, não o inteiro
  teor do despacho.
- Um **crawler próprio** do tribunal traz partes, advogados e a íntegra das
  decisões, mas cobre um tribunal por vez e depende de o site estar no ar.
- O **MNI** (Modelo Nacional de Interoperabilidade) é o único que entrega as
  **peças** — petição, contestação, laudo, documento juntado pela parte. Nada
  disso é publicado no diário, então nenhuma fonte pública tem. Em troca, exige
  a credencial de quem está habilitado nos autos.

O Processo Vivo põe as duas atrás da mesma interface (`ProcessoProvider`) e as encadeia
com fallback automático. Se o crawler cai, o DataJud responde; a consulta
continua funcionando, com menos detalhe — e o campo `procedencia` diz de onde
veio cada resposta.

---

## Requisitos

- Node.js **24 ou superior** (usa `node:sqlite`, o banco embutido)
- npm 10+

---

## Instalação

```bash
npm install
cp .env.example .env
```

O `.env` já vem funcional: a cadeia padrão é `mock-crawler-tjsp,datajud`, e sem
`DATAJUD_API_KEY` o DataJud é simplesmente omitido da cadeia com um aviso. Ou
seja, **dá para rodar tudo sem credencial nenhuma.**

### Ligando o DataJud (opcional)

1. Pegue a Chave Pública em <https://datajud-wiki.cnj.jus.br/api-publica/acesso/>
2. Cole em `DATAJUD_API_KEY` no `.env` (só a chave; o prefixo `APIKey` é
   adicionado pelo adapter)

---

## Peças do processo (v0.12.0)

O DJEN publica **ato judicial**: despacho, decisão, sentença, intimação. Petição,
contestação, laudo e documento juntado pela parte **nunca são publicados no
diário** — é por isso que um sistema alimentado só por diário mostra decisões e
julgados, e nada do que as partes escreveram.

As peças saem pelo MNI, com a credencial do próprio advogado:

```bash
# 1. gere a chave que cifra as credenciais (uma vez, por instalação)
npm run chave -- --cofre        # → PROCESSOVIVO_CREDENCIAL_CHAVE

# 2. valide o acesso ANTES de cadastrar qualquer coisa
MNI_ID_CONSULTANTE=00000000000 MNI_SENHA_CONSULTANTE=... \
  npm run cli -- pecas 5818922-04.2026.8.09.0011

# 3. cadastre pela API, e as peças passam a sair por rota
curl -X PUT -H "x-api-key: SUA_CHAVE" -H 'content-type: application/json' \
  -d '{"tribunal":"TJGO","identificacao":"00000000000","senha":"..."}' \
  http://localhost:3000/v1/credenciais
```

Três coisas que valem saber antes de usar:

- **Sem procuração nos autos, o teor não vem.** O MNI entrega a ficha do
  documento e omite o arquivo. Não é defeito: é o controle de acesso do processo
  eletrônico. A listagem informa `comTeorDisponivel` justamente para a interface
  poder dizer isso antes de alguém clicar.
- **Sem `PROCESSOVIVO_CREDENCIAL_CHAVE` a funcionalidade não sobe** e as rotas
  respondem 501. Não há caminho que guarde senha de tribunal em claro.
- **Uma tentativa por consulta, sem retry.** O tribunal conta tentativa
  malsucedida para bloquear a conta do advogado.

## API HTTP

```bash
npm run build && npm run start:local
# ou, em desenvolvimento, com reload:
npm run dev
```

Exige `PROCESSOVIVO_API_KEYS` no `.env` — o serviço **se recusa a subir sem chave**,
ou com chave de menos de 24 caracteres (a menos que você declare
`PROCESSOVIVO_AUTH_DISABLED=true`). Gere uma com:

```bash
npm run chave                  # uma chave, com o identificador que sai no log
npm run chave -- 3 --env       # três, já no formato da variável
```

Funciona em Windows sem depender de `openssl`. Os detalhes — quantas chaves
criar, onde guardar, como rotacionar sem downtime — estão no
[DEPLOY.md](./DEPLOY.md#1-gere-as-chaves-de-api).

| Método | Rota | Auth |
|---|---|---|
| GET | `/` — **console web**: abra no navegador e use o sistema | não |
| GET | `/v1/acompanhamentos` — carteira, com filtros | sim |
| POST | `/v1/acompanhamentos` — passar a acompanhar | sim |
| DELETE | `/v1/acompanhamentos/:numero` | sim |
| GET | `/v1/novidades` — feed do que mudou | sim |
| POST | `/v1/sincronizar` — disparar a varredura | sim |
| GET | `/health` — processo vivo, sem tocar em fonte externa | não |
| GET | `/ready` — consegue atender? lista o estado das fontes | não |
| GET | `/v1/processos/:numero` | sim |
| GET | `/v1/advogados/:uf/:oab/processos` | sim |
| GET | `/v1/processos/:numero/pecas` — **peças do processo** | sim |
| GET | `/v1/processos/:numero/pecas/:id` — baixar a peça | sim |
| GET | `/v1/credenciais` — acessos de tribunal cadastrados | sim |
| PUT | `/v1/credenciais` — cadastrar acesso do advogado | sim |
| DELETE | `/v1/credenciais/:tribunal` | sim |

```bash
curl -H "x-api-key: SUA_CHAVE" \
  http://localhost:3000/v1/processos/1234567-47.2023.8.26.0100
```

`Authorization: Bearer <chave>` também funciona. Toda resposta de processo traz
`x-processovivo-fonte` e `x-processovivo-cache`, para você saber de onde veio o dado e se
foi servido da memória.

Os códigos de status separam **culpa do cliente** (400/404), **falha rio acima**
(502/503) e **bug nosso** (500) — a tabela completa está no
[DEPLOY.md](./DEPLOY.md#códigos-de-status). Tribunal fora do ar nunca vira 500,
para não afogar o alarme em ruído que não é seu.

---

## Uso pelo CLI

O CLI continua valendo como ferramenta de diagnóstico — mesmos casos de uso, sem
servidor no meio.

```bash
# consulta por número CNJ (com ou sem máscara)
npm run cli -- processo 1234567-47.2023.8.26.0100
npm run cli -- processo 12345674720238260100 --json

# carteira do advogado
npm run cli -- oab 234567 SP

# estado das fontes
npm run cli -- saude
```

Números disponíveis na massa de teste do crawler mock:

| Número | Situação |
|---|---|
| `1234567-47.2023.8.26.0100` | processo completo, com partes e inteiro teor |
| `0007652-12.2022.8.26.0224` | execução, penhora via SISBAJUD |
| `1000234-92.2024.8.26.0011` | juizado especial, audiência designada |
| `5551234-79.2021.8.26.0053` | **segredo de justiça** |
| `0000832-35.2018.4.01.3202` | TRF1 — fora do crawler, exige DataJud |

OABs com carteira: `234567/SP`, `198432/SP`, `311204/SP`, `150900/SP`.

**Convenção de saída:** dados em stdout, log em stderr. Então
`npm run cli -- processo <n> --json > processo.json` produz JSON puro.

---

## Verificando os comportamentos que importam

### Fallback automático

Force o crawler a falhar em 100% das chamadas. Com `DATAJUD_API_KEY`
configurada, a resposta vem do DataJud:

```bash
MOCK_CRAWLER_FAILURE_RATE=1 npm run cli -- processo 1234567-47.2023.8.26.0100
```

Repare no log em stderr: `fonte falhou, acionando fallback`. Sem chave do
DataJud, a cadeia se esgota e o erro é `TODAS_AS_FONTES_FALHARAM` — com o
histórico de cada tentativa.

### "Não encontrado" ≠ "sistema fora do ar"

```bash
npm run cli -- processo 0000001-84.2020.8.26.0001   # → PROCESSO_NAO_ENCONTRADO
```

O número é válido e o crawler respondeu — só não tem esse processo. Erro
diferente, mensagem diferente, código de saída diferente. Confundir os dois
faria o produto dizer ao advogado que o processo dele não existe sempre que um
tribunal saísse do ar.

### Validação do número CNJ antes de gastar requisição

```bash
npm run cli -- processo 1234567-48.2023.8.26.0100   # DV trocado de propósito
# → NUMERO_CNJ_INVALIDO: dígito verificador 48 não confere (esperado 47)
```

Nenhuma fonte é consultada. O dígito verificador (ISO 7064 MOD 97-10) pega o erro
de digitação mais comum antes de custar uma requisição.

### Cache

Rode a mesma consulta duas vezes na mesma sessão e observe que o campo
`Fonte` ganha o sufixo `(cache)`. O cache embrulha o orquestrador inteiro, então
um acerto não gasta nem cota do DataJud nem uma ida ao tribunal.

---

## Deploy

Docker multi-stage pronto: Node 24, imagem final sem TypeScript nem Vitest,
usuário não-root, `HEALTHCHECK` e SIGTERM tratado (redeploy não derruba
requisição em voo).

```bash
docker compose up --build   # valida local a MESMA imagem que vai para o VPS
```

O passo a passo no Easypanel — App por Dockerfile, porta alvo, variáveis,
domínio com HTTPS, webhook de deploy e o que fazer quando der 502 — está em
**[DEPLOY.md](./DEPLOY.md)**.

---

## Testes

```bash
npm test          # 218 testes
npm run test:cov  # com cobertura
npm run check     # typecheck + lint + testes — rode antes de commitar
```

A suíte **não toca a rede** e **não depende de tempo real**: o `HttpClient` é
dublado, e `Clock` e a fonte de aleatoriedade são injetáveis. Roda offline, em
menos de 3 segundos.

O que está coberto:

- **Domínio** — dígito verificador CNJ (validado contra um número real publicado
  pelo CNJ), normalização de OAB, imutabilidade das entidades
- **Orquestrador** — fallback, cadeia esgotada, "não encontrado" vs. "fora do
  ar", pular fonte que não cobre o tribunal, agregação e dedupe na busca por OAB,
  resultado parcial quando uma fonte falha
- **DataJudAdapter** — montagem da URL por tribunal, header `APIKey`, mapeamento
  do payload, 401/429/5xx, payload fora do contrato, campo novo do CNJ não quebra
- **Cache** — TTL, LRU, reidratação de `Date`, marcação de procedência
- **API HTTP** — autenticação, rate limit, cada código de status, health vs.
  ready (via `inject()`, sem abrir porta)
- **Chaves de API** — recusa de chave fraca, repetida ou configuração ambígua;
  identificador de log estável e não reversível
- **Fluxo completo** — cadeia real montada, com e sem falha do primário

---

## Estrutura

```
src/
├── domain/          entidades, portas, casos de uso, erros  (sem I/O)
├── application/     ProcessoSearchService — orquestração e fallback
├── infrastructure/  DataJud, crawler mock, cache, HTTP, rate limit, config
└── main/            composition root + dois adaptadores de entrada:
    ├── cli.ts       CLI
    └── http/        API Fastify
tests/               espelha src/, mais http/, integration/ e helpers/
```

CLI e API são adaptadores de **entrada** sobre os mesmos casos de uso — nenhuma
regra é duplicada entre eles.

A dependência aponta sempre para dentro: o domínio não sabe que DataJud existe.

---

## Configuração

Todas as variáveis estão documentadas em [`.env.example`](./.env.example). As que
mais mudam comportamento:

| Variável | Padrão | Efeito |
|---|---|---|
| `PROCESSOVIVO_API_KEYS` | vazio | chaves de `x-api-key`, separadas por vírgula. **Sem ela o serviço não sobe** |
| `HTTP_PORT` / `HTTP_HOST` | `3000` / `0.0.0.0` | em contêiner, host tem que ser `0.0.0.0` |
| `PROCESSOVIVO_PROVIDER_CHAIN` | `mock-crawler-tjsp,datajud` | ordem da cadeia: o primeiro é primário, os demais são fallback |
| `DATAJUD_API_KEY` | vazio | sem ela, o DataJud sai da cadeia |
| `DATAJUD_RATE_LIMIT_PER_MINUTE` | `60` | autolimite; a chave do CNJ é compartilhada |
| `MOCK_CRAWLER_FAILURE_RATE` | `0` | de 0 a 1 — use `1` para exercitar o fallback |
| `CACHE_TTL_SECONDS` | `900` | TTL da consulta por número |
| `LOG_LEVEL` | `info` | `debug` mostra a decisão de cada fonte |

Trocar a fonte primária em produção é mudar uma variável de ambiente — não
redeploy de código.

---

## Fora do escopo deste MVP

Persistência em banco, multi-tenant (hoje a chave de API autentica, mas não
separa clientes), crawler real, monitoramento com notificação de novas
movimentações e fila de jobs. O cache é em memória: serve a uma instância e
evapora no redeploy. O desenho já acomoda cada um desses passos; veja "Como
estender" em [CLAUDE.md](./CLAUDE.md).

---

## Referências

- [API Pública do DataJud — CNJ](https://www.cnj.jus.br/sistemas/datajud/api-publica/)
- [Datajud Wiki — acesso e endpoints](https://datajud-wiki.cnj.jus.br/api-publica/)
- Resolução CNJ nº 65/2008 — numeração única de processos
