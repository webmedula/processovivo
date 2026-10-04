# CLAUDE.md — Processo Vivo

Regras de trabalho neste repositório. Vale para agentes de IA e para pessoas.
Se algo aqui conflitar com o código, **o código está errado ou este arquivo está
desatualizado** — resolva a divergência, não a ignore.

---

## 1. O que é o Processo Vivo

SaaS de consulta e acompanhamento de processos judiciais nos tribunais
brasileiros. O advogado consulta por número CNJ ou pela própria OAB e recebe
metadados, partes e movimentações em um formato único, independentemente da
fonte que respondeu — e, cadastrando o acesso dele no tribunal, também as
**peças**: petição, contestação, laudo e documento juntado pela parte.

**A tese do produto é a busca HÍBRIDA.** Nenhuma fonte isolada resolve:

| Fonte | Custo | Cobertura | Partes/advogados | Inteiro teor | **Peças das partes** | Busca por OAB | Linha do tempo |
|---|---|---|---|---|---|---|---|
| API Pública DataJud (CNJ) | grátis | 27 TJs + 6 TRFs + 24 TRTs + TST | ❌ não indexa | ❌ só rótulo TPU | ❌ | ❌ impossível | ✅ completa |
| DJEN / Comunica API (CNJ) | grátis, sem chave | nacional | ✅ | ✅ do publicado | ❌ | ✅ | ⚠️ só o publicado |
| **MNI 2.2.2** (Projudi/TJGO) | grátis, credencial do advogado | 1 tribunal por endpoint | ✅ | ✅ | ✅ | ❌ | ✅ |
| Crawler próprio (e-SAJ, PJe, Projudi) | infra + manutenção | 1 tribunal por crawler | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Agregadores pagos | R$ por consulta | ampla | ✅ | ✅ | ✅ | ✅ | ✅ |

O sistema combina fontes atrás de uma única interface, faz fallback automático
e — desde a v0.9.0 — **complementa**: achar o processo não encerra a busca, as
fontes seguintes preenchem o que a vencedora não soube. Toda decisão de
arquitetura abaixo existe para servir a isso.

**A segunda regra de ouro, aprendida em 09/2026:** peça de parte NÃO É ATO
PUBLICADO. O diário publica despacho, decisão e sentença; petição, contestação,
laudo e documento juntado pela parte nunca aparecem lá. Um sistema alimentado só
por DJEN mostra "decisões e julgados" e nada mais — e isso é o teto da fonte, não
um bug a caçar. Peça só sai do sistema do tribunal, com a credencial de quem tem
procuração nos autos.

**Regra de ouro das fontes, aprendida do jeito caro:** o DataJud e o DJEN se
completam e nenhum substitui o outro. O DataJud tem a linha do tempo inteira e
nenhuma parte; o DJEN tem partes, advogados e inteiro teor, mas só do que foi
publicado no diário. Deixar o DJEN sozinho responder faz um processo de 361
andamentos aparecer com 8.

---

## 2. Arquitetura

Clean Architecture com Ports & Adapters. **A dependência aponta sempre para
dentro.**

```
        main/  (composition root; adaptadores de entrada: CLI e API HTTP)
          │  monta e injeta
          ▼
   application/  (ProcessoSearchService — orquestração entre fontes)
          │  usa portas
          ▼
      domain/   (entidades, portas, casos de uso, erros)   ← não importa NADA
          ▲
          │  implementa portas
  infrastructure/  (DataJud, crawlers, cache, HTTP, log, config)
```

### Regra de dependência (inegociável)

- `domain/` **não importa** de `application/`, `infrastructure/` ou `main/`, nem
  de biblioteca de I/O (http, fs, driver de banco).
  - Única exceção tolerada hoje: `zod` em `infrastructure/`, nunca em `domain/`.
- `application/` importa de `domain/`. Nunca de `main/`.
- `infrastructure/` implementa portas de `domain/`. Um adapter não conhece outro
  adapter.
- `main/` é o único lugar que faz `new` de classe de infraestrutura.

Se você precisou importar `DataJudAdapter` fora de `main/factories/`, pare: o
desenho quebrou. Use a porta.

### Estrutura de pastas

```
src/
├── domain/                      # o núcleo, sem I/O
│   ├── entities/                # Processo, Movimentacao, Parte, NumeroCNJ, Oab
│   ├── errors/                  # hierarquia de DomainError
│   ├── ports/                   # ProcessoProvider, RepositorioAcompanhamentos, Cache…
│   └── usecases/                # BuscarProcessoPorNumero, BuscarProcessosPorOab
├── application/
│   └── services/                # ProcessoSearchService, ServicoAcompanhamento,
│                                #   ServicoVigilanciaOab, ServicoNotificacao,
│                                #   ServicoPecas, ServicoContas,
│                                #   ServicoAssinaturas, ServicoLeitor,
│                                #   ServicoPasta + GuardaDePecas (Pasta digital),
│                                #   ServicoCalendario (+ ingestaoDoCalendario)
├── infrastructure/
│   ├── adapters/
│   │   ├── datajud/             # adapter + mapper + schemas + aliases
│   │   ├── djen/                # adapter + mapper + limpeza de HTML
│   │   ├── mni/                 # adapter + envelope SOAP + mapper + MTOM
│   │   └── crawler/             # MockCrawlerAdapter + fixtures
│   ├── cache/                   # InMemoryCache, CachedProcessoProvider
│   ├── config/                  # env.ts (validação de configuração)
│   ├── http/                    # HttpClient (timeout + retry)
│   ├── logging/                 # ConsoleLogger
│   ├── persistencia/            # serialização + SQLite (acompanhamentos, vigilâncias)
│   ├── notificacao/             # EmailSmtpNotificador, LogNotificador
│   ├── seguranca/               # cofre AES-256-GCM das credenciais de tribunal,
│   │                            #   senha (scrypt) e sessão (token + cookie)
│   ├── agenda/                  # Agendador da varredura
│   ├── arquivos/                # ArmazemEmDisco (guarda temporária do leitor)
│   ├── calendario/              # gerador do feed ICS (RFC 5545)
│   ├── pdf/                     # QpdfMontador (qpdf junta; pdf-lib gera avisos)
│   └── ratelimit/               # TokenBucketRateLimiter
└── main/
    ├── factories/               # composition root
    ├── cli.ts                   # adaptador de ENTRADA (diagnóstico)
    └── http/                    # adaptador de ENTRADA (API Fastify)
        ├── index.ts             # entrypoint do contêiner
        ├── servidor.ts          # montagem + listen + shutdown gracioso
        ├── erros.ts             # DomainError → status HTTP
        ├── plugins/             # autenticação: sessão (cookie) OU chave de API
        ├── ui/                  # console web (HTML como string, sem build)
        └── rotas/               # processos, contas, saúde, interface, leitor, calendário
tests/                           # espelha src/, + http/, integration/, helpers/
```

CLI e API são dois adaptadores de entrada sobre os **mesmos** casos de uso.
Nenhuma regra vive em um e falta no outro — se você se pegou copiando lógica de
um para o outro, ela pertence ao domínio.

### Padrões em uso e por quê

| Padrão | Onde | Por quê |
|---|---|---|
| **Adapter** | `ProcessoProvider` + implementações | API oficial, crawler e mock entram pela mesma porta |
| **Strategy / Chain of Responsibility** | `ProcessoSearchService` | ordem das fontes e fallback são configuração, não `if` |
| **Composite** | `ProcessoSearchService implements ProcessoProvider` | a cadeia inteira é indistinguível de uma fonte |
| **Decorator** | `CachedProcessoProvider` | cache existe em um lugar só; nenhum adapter sabe dele |
| **Anticorruption Layer** | `datajud.mapper.ts` | o vocabulário do CNJ morre na borda |
| **Value Object** | `NumeroCNJ`, `Oab` | se a instância existe, o dado é válido — não se revalida |

---

## 3. A porta `ProcessoProvider`

```ts
interface ProcessoProvider {
  readonly nome: string;
  readonly capacidades: CapacidadesProvider;
  buscarPorNumero(numeroProcesso: string): Promise<Processo>;
  buscarPorOab(oab: string, uf: string): Promise<Processo[]>;
  healthCheck(): Promise<boolean>;
  diagnosticar?(): Promise<DiagnosticoProvider>;  // opcional
}
```

**Ao criar um adapter novo, cumpra o contrato inteiro:**

1. `nome` estável — vai para log, chave de cache e procedência.
2. `capacidades` **honestas**. Declarar que busca por OAB sem buscar é o pior bug
   possível aqui: o orquestrador confia nessa declaração para decidir a quem
   perguntar.
3. Lance **somente** erros de `domain/errors` (tabela abaixo). `throw new Error()`
   cru é bug.
4. `healthCheck()` **nunca lança** — fonte fora do ar devolve `false`.
5. Implemente `diagnosticar()` se a fonte tem mais de um jeito de falhar. Devolver
   só `false` obriga quem opera a adivinhar entre chave errada, rede e tribunal
   fora do ar. E cuidado com a classificação: **4xx que não é de autenticação
   significa que a fonte respondeu e a chave passou** — reprovar por isso tira da
   cadeia uma fonte que estava funcionando. E **timeout na verificação é
   `lenta`, não "fora do ar"** (v0.31.2): `saudavel: true, lenta: true`, com o
   motivo. Só recusa de conexão, 401/403, 429 e 5xx reprovam. O /ready do
   DataJud reprovava a fonte com 15s de teto enquanto as consultas de 60s do
   mesmo minuto funcionavam — índice frio do CNJ, não indisponibilidade. O teto
   da verificação é `DATAJUD_TIMEOUT_VERIFICACAO_MS` (30s).
6. Devolva `Processo`, nunca o payload da fonte.

### Erros e o que cada um provoca no orquestrador

| Erro | Significado | Efeito |
|---|---|---|
| `ProcessoNaoEncontradoError` | a fonte respondeu, não tem o processo | tenta a próxima; se **todas** disserem isso, o resultado final é "não encontrado" |
| `OperacaoNaoSuportadaError` | limitação permanente da fonte | **pula** sem contar como falha |
| `ProviderIndisponivelError` | rede, timeout, 5xx, captcha, tribunal fora | dispara o **fallback** |
| `RespostaInvalidaError` | respondeu, payload fora do contrato | dispara o fallback |
| `NumeroCNJInvalidoError` / `OabInvalidaError` | entrada do usuário inválida | propaga; nenhuma fonte é consultada |
| `TodasAsFontesFalharamError` | a cadeia acabou | 5xx na API; carrega o histórico das tentativas |
| `CredencialTribunalAusenteError` | o workspace não cadastrou o acesso | 428; a pessoa precisa cadastrar |
| `CredencialTribunalInvalidaError` | o tribunal recusou usuário/senha | 424; **não retentar** — marca a credencial como recusada |
| `TeorNaoAutorizadoError` | respondeu e não liberou o arquivo | 403; em geral falta procuração nos autos |
| `CredenciaisInvalidasError` | e-mail ou senha errados | 401; mensagem IDÊNTICA nos dois casos, de propósito |
| `SessaoInvalidaError` | sessão ausente, expirada ou encerrada | 401; a pessoa entra de novo |
| `EmailJaCadastradoError` | já existe conta com este e-mail | 409; o pedido é válido, o estado é que conflita |
| `WorkspaceNaoResolvidoError` | requisição sem ambiente identificado | 401; só acontece com autenticação desligada |
| `AssinaturaInativaError` | venceu e passou da carência, ou foi cancelada | 402; pagar o que já foi contratado |
| `RecursoNaoIncluidoNoPlanoError` | está em dia, o plano não cobre | 403; trocar de plano — outra ação, outro código |
| `PlanoDesconhecidoError` | código de plano que não existe | 400; letra trocada no comando, não bug |
| `SemHabilitacaoNosAutosError` | o tribunal devolveu só o cabeçalho, sem conteúdo | 403; conferir de quem é a credencial — NÃO é processo vazio |
| `MniBloqueadoError` | o tribunal respondeu 403: disjuntor aberto, MNI inteiro em pausa | 503 com a hora de retomada; é um `ProviderIndisponivelError` — quem tratava indisponibilidade continua tratando |
| `JobDoLeitorNaoEncontradoError` | job do leitor não existe PARA ESTE workspace | 404; mesma resposta para "não existe" e "é de outro" |
| `LeitorAindaNaoProntoError` | pediu PDF ou índice de job que não terminou | 409; a tela consulta o progresso |
| `LimiteDeArmazenamentoExcedidoError` | cota do PDF ou do workspace na guarda temporária | 413; dividir a seleção ou esperar o prazo |
| `SegredoDeJusticaNaoGuardadoError` | processo sob sigilo não tem PDF combinado guardado | 403; as peças avulsas continuam |
| `PdfInvalidoError` | a contagem de páginas do PDF gerado não bate com a soma das peças | o job falha; índice desalinhado é pior que nenhum |
| `PdfDoLeitorExpiradoError` | pediu recorte de um PDF combinado que já saiu do disco | 410; a tela diz que expirou — NÃO baixa de novo do tribunal sem a pessoa pedir |
| `PecasForaDoPdfError` | pediu recorte com peça que não está naquele PDF | 400 |
| `EventoDeCalendarioInvalidoError` | data que não existe, hora fora do relógio, intervalo acima de 400 dias, processo fora da carteira | 400 |
| `EventoDeCalendarioNaoEncontradoError` | evento não existe PARA ESTE workspace | 404; mesma resposta para "não existe" e "é de outro" |
| `TransicaoDeEventoInvalidaError` | mexer em evento descartado | 409; descartado é final |
| `FeedDoCalendarioAusenteError` | pediu para alterar o feed e não há feed vigente | 404 na rota autenticada; diz o que falta |
| `ListagemDaPastaAusenteError` | a Pasta digital não tem a lista de peças do processo (a tela ainda não a carregou) | 409; carregar as peças do processo e pedir de novo |
| `PecaDaPastaNaoEncontradaError` | a peça não está na pasta DESTE workspace (não existe, venceu ou é de outro) | 404; mesma resposta para os três casos |
| `PecaSigilosaNaoGuardadaError` | pediu para guardar peça com `nivelSigilo > 0` | 403; o download avulso pela linha do tempo continua |
| `PastaSemPecasParaJuntarError` | montar/baixar sem nenhuma peça guardável (lista vazia ou só sigilosas) | 409; não monta PDF vazio |
| `FeedDoCalendarioNaoEncontradoError` | token do feed inválido, revogado, assinatura bloqueada ou plano sem o recurso | 404 com o MESMO corpo seco nos quatro casos |

**A distinção que sustenta o produto:** "esse processo não existe" ≠ "não
consegui ver esse processo". Colapsar as duas coisas faz o sistema dizer ao
advogado que o processo dele não existe toda vez que o TJSP sair do ar. Nunca
faça isso.

---

## 4. Convenções de código

### Idioma

- **Domínio em português**: `Processo`, `Movimentacao`, `buscarPorNumero`,
  `numeroProcesso`. O vocabulário jurídico brasileiro não tem tradução boa e
  traduzir cria ambiguidade com o cliente. Comentários e mensagens de erro
  também em português.
- **Termos técnicos consagrados em inglês** ficam em inglês: `Cache`, `Logger`,
  `HttpClient`, `RateLimiter`, `healthCheck`, `Adapter`, `Provider`.
- Nomes de arquivo seguem o que exportam: `PascalCase.ts` para classe,
  `camelCase.ts` para função/módulo (`datajud.mapper.ts`).

### TypeScript

- `strict` ligado, mais `noUncheckedIndexedAccess` e
  `exactOptionalPropertyTypes`. Índice de array é `T | undefined` — trate.
  Propriedade opcional se omite (`...(x ? { x } : {})`), não se atribui
  `undefined`.
- **`any` é proibido.** Dado externo entra como `unknown` e é validado com Zod.
- `import type` para tipos (regra de lint ativa).
- Imports relativos **com extensão `.js`** — é ESM + `NodeNext`. `./Processo.js`
  aponta para `Processo.ts`. Sem isso, não roda compilado.
- Retorno explícito em função exportada.

### Estilo

- Entidades **imutáveis** (`Object.freeze` no construtor, `readonly` nos campos).
  Alteração produz cópia (`comAlteracoes`).
- Sem herança entre entidades. Composição.
- Data é sempre `Date` no domínio; `string` ISO só ao serializar.
- Prettier decide formatação: aspas simples, vírgula final, 90 colunas.
- `console.*` só no CLI e no logger — o lint bloqueia no resto.
- **stdout é dado, stderr é log.** Não misture: quebra `npm run cli -- ... > x.json`.

### Comentários

Comente **por que**, não **o que**. `// incrementa i` não ajuda ninguém.
`// laço em vez de sleep único: outra corrotina pode tomar o token antes` ajuda.
Onde uma decisão parece estranha, o comentário explica a restrição que a causou.

---

## 5. Comandos

```bash
npm install              # dependências
cp .env.example .env     # configuração local (defina PROCESSOVIVO_API_KEYS)

npm run dev              # API com reload
npm run build && npm run start:local   # API a partir do build
docker compose up --build              # a MESMA imagem que vai para o VPS

npm run chave            # gera chave de API + o identificador que sai no log
npm run chave -- 3 --env # três chaves no formato da variável de ambiente

npm run cli -- processo 1234567-47.2023.8.26.0100
npm run cli -- processo 12345674720238260100 --json
npm run cli -- oab 234567 SP
npm run cli -- saude
npm run cli -- email eu@meudominio.com.br   # testa o SMTP de verdade

npm run cli -- assinatura ver                            # todas, em tabela
npm run cli -- assinatura ver ana@escritorio.com.br
npm run cli -- assinatura liberar ana@escritorio.com.br pecas 12 --obs "Pix 22/09"
npm run cli -- assinatura cancelar ana@escritorio.com.br
npm run cli -- assinatura avisar            # o mesmo que o agendador roda

npm test                 # suíte completa (Vitest)
npm run test:watch       # modo watch
npm run test:cov         # cobertura, mínimo 70% no núcleo
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run format           # Prettier
npm run check            # typecheck + lint + test  ← rode antes de commitar
npm run build            # compila para dist/
```

**Antes de qualquer commit: `npm run check` verde.** Sem exceção.

---

## 6. Testes

- Vitest. Arquivos em `tests/`, espelhando `src/`, sufixo `.spec.ts`.
- **Nenhum teste toca a rede.** `HttpClient` é dublado por subclasse;
  `MockCrawlerAdapter` já é o dublê da camada de crawler.
- **Nenhum teste depende de tempo real.** `Clock` e a função aleatória são
  injetáveis — use `ClockFalso` e `aleatorio: () => 0.1` em vez de `sleep`.
- **Comportamento de fonte externa se testa contra CAPTURA REAL**, nunca contra
  fixture inventado. `tests/fixtures/datajud-tjgo-real.json` é a resposta que o
  CNJ devolveu de fato; ao mexer no adapter ou no mapper do DataJud, o teste que
  vale é `datajud-payload-real.spec.ts`. O motivo está gravado: 161 testes verdes
  não pegaram que `dataAjuizamento` vem em `yyyyMMddHHmmss` e não em ISO, porque
  eu havia escrito o fixture, o parser e a asserção — um circuito fechado que não
  tocava a realidade. Ao capturar payload novo, salve como fixture e não edite os
  valores.
- **Exceção registrada (v0.30.0): resposta do MNI COM DOCUMENTOS não entra como
  captura.** O repositório é público, e a resposta real carrega petição de
  processo real, com nome de parte e de advogado. A ESTRUTURA verificada no TJGO
  (envelope, multipart/XOP, atributos de `<documento>`, `<outroParametro>`) é
  reproduzida por `tests/helpers/mniSintetico.ts`, com bytes sintéticos e nada de
  nome — e o comentário dele diz de onde veio cada forma. PDF de teste se gera
  com biblioteca (`tests/helpers/leitor.ts`). A regra "não editar fixture de
  captura" continua valendo para tudo o que é capturado; isto aqui não é
  captura, e não finge ser.
- **Os testes do leitor rodam o `qpdf` e o `pdftotext` de verdade** (CI:
  `apt-get install qpdf poppler-utils`; local: instale os pacotes). É a única forma de provar que o índice bate com o
  arquivo montado.
- **Teste de navegador** (v0.33.1): `tests/browser/` roda a Pasta digital num
  Chromium de verdade (`playwright-core`, `axe-core`) contra o servidor real e um
  tribunal falso — é o único lugar que prova, por exemplo, que cinco cliques
  rápidos viram UM lote no tribunal. Pula sozinho sem Chromium (`PV_CHROMIUM` ou
  `/opt/pw-browsers/chromium`); no CI, instale o navegador para rodá-lo. Peças e
  números são sintéticos, como em todo o repositório.
- Fixtures usam números CNJ com **dígito verificador válido**. Um DV inválido na
  massa faz a suíte passar sem nunca exercitar `NumeroCNJ`, e o bug só aparece
  contra o tribunal de verdade. Helper para gerar: veja o fim de
  `tests/domain/NumeroCNJ.spec.ts`.
- O nome do teste descreve o **comportamento**, não o método:
  `'cai para a fonte seguinte quando a primária está indisponível'`, não
  `'testa buscarPorNumero'`.
- Todo caminho de erro do orquestrador tem teste. Fallback sem teste é fallback
  que não existe.

---

## 7. Como estender

### Adicionar um tribunal ao DataJud

1. Sigla em `TRIBUNAIS_SUPORTADOS` (`infrastructure/adapters/datajud/tribunais.ts`).
2. Par `J.TR` no mapa `SIGLAS_POR_SEGMENTO_TRIBUNAL` em
   `domain/entities/NumeroCNJ.ts`.
3. Teste com um número real daquele tribunal.

São esses três passos e mais nada: a chave do CNJ é a mesma para todos os
tribunais e o endereço sai da sigla. **Confira esta lista antes de dizer que o
produto não atende um segmento.** A Justiça do Trabalho ficou de fora por meses
— e a resposta a um advogado trabalhista era "tribunal não suportado" — quando o
que faltava eram 31 linhas de configuração. "O produto não atende X" às vezes é
uma lista desatualizada se passando por limitação de arquitetura.

### Adicionar uma fonte nova

1. `infrastructure/adapters/<fonte>/` com adapter + mapper + schemas Zod.
2. **Capture uma resposta REAL antes de escrever o mapper** e salve em
   `tests/fixtures/`. Sem isso você testa o seu palpite contra ele mesmo.
3. Declare `capacidades` honestas, inclusive `retornaLinhaDoTempoCompleta` —
   é ela que decide se o orquestrador continua perguntando às outras fontes.
4. Registre no `switch` de `main/factories/makeProcessoSearchService.ts`, no
   schema de `infrastructure/config/env.ts` e no `.env.example`.

### Criar um crawler de verdade

1. `infrastructure/adapters/crawler/<Tribunal>CrawlerAdapter.ts`, implementando
   `ProcessoProvider`.
2. Declare capacidades reais e lance apenas erros de domínio.
3. Espelhe a suíte de `MockCrawlerAdapter.spec.ts` — o mock é o **gêmeo de
   contrato** do crawler real; os dois devem passar nos mesmos testes de
   comportamento.
4. Registre no `switch` de `main/factories/makeProcessoSearchService.ts` e
   documente o nome em `.env.example`.
5. Rate limiting **obrigatório**. Crawler sem limite derruba o tribunal e queima
   o IP.

### Adicionar uma fonte de PEÇAS

Implemente `ProvedorDePecas` (não `ProcessoProvider`) e registre em
`montarServicoPecas`, no composition root. A porta é separada por três razões
que estão escritas nela, e a mais concreta é esta: `CachedProcessoProvider`
indexa por número de processo, **sem workspace na chave** — uma fonte com
credencial dentro da cadeia serviria ao assinante seguinte a resposta obtida com
a credencial do anterior.

Ao mexer no MNI, o teste que vale é `tests/infrastructure/mni-mtom.spec.ts`, que
roda contra a captura real do TJGO. Para o caminho em lote do leitor,
`tests/infrastructure/mni-lote.spec.ts` (estrutura real, bytes sintéticos).

Fonte que entrega VÁRIAS peças numa chamada implementa também
`obterConteudosEmLote` — é o que o leitor (e, depois, o ZIP) usam. Peça que falta
numa resposta com sucesso não é erro: vai em `ausentes` ou `semTeor`.

### Trocar o cache por Redis

Implemente `domain/ports/Cache.ts` em `infrastructure/cache/RedisCache.ts` e
troque uma linha no composition root. Nada mais muda. Se você precisou mexer em
outro arquivo, a porta está errada.

### Adicionar uma rota HTTP

Em `main/http/rotas/`. A rota traduz HTTP → caso de uso → JSON e **não** trata
erro: o `errorHandler` do servidor centraliza a tradução para status. Se você
escreveu `try/catch` com `reply.code(...)` dentro de uma rota, mova o caso novo
para `main/http/erros.ts` — é assim que o mesmo erro deixa de virar 404 numa
rota e 500 na outra.

Rota que dispensa autenticação precisa entrar em `rotasPublicas` ao registrar o
plugin de autenticação: hoje `/health`, `/ready`, o console, as fontes do
console (`/ui/fontes/:arquivo`), `/v1/contas`, `/v1/sessoes`,
`/v1/senha/recuperar` e `/v1/senha/redefinir` (e as rotas `/admin`, que têm
autenticação própria, e o feed do calendário `/calendario/feed/:arquivo`, que
se autentica pelo token no próprio caminho). As quatro últimas
são públicas por necessidade — são as rotas de quem ainda não tem, ou acabou de
perder, como se autenticar. Pedir chave nelas seria pedir a chave a quem perdeu
a chave.

---

## 8. Restrições operacionais e jurídicas

Não são detalhes — moldam o código.

- **Chave do DataJud é compartilhada.** A API Pública usa uma Chave Pública única
  do CNJ. Estourar a cota prejudica todos que usam a mesma chave e pode gerar
  bloqueio. Por isso o rate limiter é do **nosso** lado, e não uma reação ao 429.
- **Nunca commite `.env`.** A chave vai em variável de ambiente.
- **Crawler é um convidado no servidor alheio.** Respeite intervalo entre
  requisições, horário de menor movimento e `robots.txt`. Sem paralelismo
  agressivo contra tribunal.
- **CAPTCHA é um "não" do tribunal. Não se contorna.** A consulta pública do
  Projudi/TJGO exige token do Cloudflare Turnstile a cada busca (script em modo
  `render=explicit`, botão Buscar `disabled` até o token chegar). Vencer isso
  exigiria serviço pago de resolução — custo por consulta, quebra a cada ajuste
  da Cloudflare, e posição indefensável se o tribunal reclamar. Quando uma fonte
  se fecha assim, a resposta é **procurar outra fonte oficial**, não um jeitinho.
  Foi assim que o DJEN entrou no projeto.
- **O campo `sistema` do DataJud não é confiável.** Ele diz `Eproc` para
  processos do TJGO, que roda **Projudi** — não existe host de eproc no TJGO.
  Antes de escrever adapter para um sistema, confirme que o sistema existe
  naquele tribunal (DNS e página de verdade), não pelo metadado.
- **Segredo de justiça:** `processo.segredoJustica === true` significa que
  partes e movimentações podem estar suprimidas na origem. Não tente
  complementar por outra fonte, e nunca exiba para quem não é parte.
- **Dado pessoal (LGPD):** documentos de parte vêm mascarados da fonte pública.
  Guarde como veio — não desmascare, não complete, não infira.
- **A API não pode ficar aberta.** A chave do CNJ é compartilhada; um endpoint
  público transforma o VPS em proxy gratuito para a cota alheia. Por isso
  `main/http/index.ts` **recusa subir** sem `PROCESSOVIVO_API_KEYS`, a menos que
  `PROCESSOVIVO_AUTH_DISABLED=true` seja declarado. Não remova essa guarda.
- **Chave nunca vai para o log nem para a resposta.** O log registra o
  `identificarChave()` — 8 hex do SHA-256, não reversível e imune a prefixo
  comum. Nunca troque por um prefixo da chave: vaza segredo e colapsa todas as
  chaves que compartilhem convenção de nome. O handler de erro devolve mensagem
  genérica em 500 porque a original pode conter URL interna ou trecho de payload.
- **Nunca escreva placeholder no lugar de um valor.** Em bloco de configuração
  pronto para copiar, a linha vai vazia e a instrução vai em comentário. Um
  `COLE_AQUI_...` não é vazio: passa por toda checagem de presença e vira
  credencial de mentira, que só falha lá na frente. `pareceValorDeExemplo()`
  (em `infrastructure/config/placeholder.ts`) é a rede de segurança, não a
  desculpa para voltar a usar placeholder.
- **Configuração de autenticação é validada no arranque** (`main/http/chaves.ts`):
  sem chave, chave com menos de `TAMANHO_MINIMO_CHAVE`, chave repetida, ou
  `PROCESSOVIVO_AUTH_DISABLED` junto com chaves preenchidas — todos derrubam a
  montagem. Chave fraca é pior do que nenhuma: passa sensação de proteção.
- **Duas autenticações, um workspace.** Pessoa entra por e-mail e senha (sessão
  em cookie); integração entra por chave de API. As duas resolvem para o mesmo
  `workspace`, e nenhuma rota de dados sabe qual delas trouxe a requisição — é
  isso que impede a autenticação de vazar para dentro do domínio. **A sessão tem
  precedência sobre a chave**: com as duas presentes, vence a pessoa, senão a
  carteira dela "some" conforme a aba.
- **Senha nunca vira dependência nativa.** `scrypt` do `node:crypto`, com os
  parâmetros gravados junto do hash. bcrypt e argon2 exigiriam compilar módulo
  nativo no Alpine — o mesmo motivo que escolheu `node:sqlite`.
- **O banco guarda o HASH do token de sessão, nunca o token.** Vazamento de
  banco não pode virar sessão aberta. E o token não volta no corpo da resposta:
  vive só no cookie HttpOnly, fora do alcance de qualquer script da página.
- **Em HTTPS o cookie se chama `__Host-processovivo_sessao`.** O prefixo é uma regra
  que o navegador aplica: só grava com `Secure`, `Path=/` e sem `Domain`. Sem
  ele, quem controlasse um subdomínio plantaria um cookie de `Path` mais
  específico, seria lido primeiro, e o advogado trabalharia dentro do ambiente
  do atacante. É fixação de sessão que sobrevive a `HttpOnly` e a `SameSite`.
- **Rota que dispara varredura é ESCOPADA a quem pediu.** A varredura global
  existe e é a agendada. Deixar a rota HTTP disparar aquela permitia a qualquer
  conta mandar o servidor consultar o tribunal sobre a carteira de todos os
  assinantes, gravando nos dados deles — e nada do conteúdo alheio voltava na
  resposta, que é o que faz esse tipo de falha passar despercebido. Toda rota
  nova que varre, notifica ou sincroniza nasce com `workspace` no parâmetro.
- **`trustProxy` conta UM salto, nunca `true`.** Com `true` o Fastify aceita a
  cadeia inteira de `X-Forwarded-For`, que o cliente escreve: um IP novo por
  requisição cai num balde novo de rate limit e anula o limite. Na rota de
  login, que é pública e gasta scrypt, isso é força bruta sem teto.
- **Cadastro é ABERTO**, por decisão de produto: o Processo Vivo é vendido a
  advogados pelo Brasil, e convite não combina com isso. (Até a v0.13.x este
  arquivo dizia o contrário — a regra estava escrita e o código não existia.)
  O que protege a cota compartilhada do CNJ passa a ser o rate limiter do NOSSO
  lado, dentro dos adapters, e não o número de contas. Duas consequências
  aceitas conscientemente: o 409 do cadastro revela se um e-mail já é
  assinante, e não há teto por conta no plano gratuito. Se o abuso aparecer, os
  caminhos são confirmação por e-mail antes da primeira consulta e limite de
  consultas por plano — não fechar o cadastro.
- **"E-mail não encontrado" e "senha incorreta" são a MESMA resposta**, e a
  verificação gasta o mesmo tempo nos dois casos. Respostas diferentes
  transformam a tela de login num verificador de quem é cliente.
- **Peça exige habilitação, e isso não se contorna.** O MNI devolve documentos
  conforme o perfil de acesso do consultante: sem procuração nos autos, vem o
  metadado e não vem o arquivo. Não é limitação técnica a resolver — é o controle
  de acesso do processo eletrônico. Trate como resposta legítima
  (`TeorNaoAutorizadoError`), nunca como erro de download.
- **Credencial de tribunal nunca vai para log, resposta ou mensagem de erro.**
  Nem em `debug`, nem dentro de objeto de contexto. É o vazamento que não aparece
  em auditoria de código, porque parece inofensivo na linha em que é escrito. E
  nunca há caminho que a grave em claro: sem `PROCESSOVIVO_CREDENCIAL_CHAVE` a
  funcionalidade inteira não sobe.
- **No MNI não há retry, e é deliberado.** A requisição carrega a senha do
  advogado, e o tribunal conta tentativa malsucedida para bloquear a conta. Uma
  senha desatualizada com retry vira três recusas por consulta; com a vigilância
  de hora em hora, isso é bloqueio no mesmo dia — e o advogado perde o acesso ao
  próprio processo por culpa nossa.
- **No Projudi, sem `movimentos=true` não vem peça nenhuma** — nem na listagem,
  nem pedindo um documento pelo id. O tribunal responde `sucesso: true` com o
  cabeçalho e mais nada, sem aviso, e o sintoma é indistinguível de "processo
  sem documentos". Medido no mesmo processo, mesma credencial, mesmo
  `incluirDocumentos=true`: `false` → 4 KB e 0 documentos; `true` → 280 KB e 278.
  Baixando uma peça: `false` → 800 bytes e nada; `true` → 501 KB com o PDF em
  anexo MTOM. Os ~250 KB de movimentos são pedágio, não desperdício.
- **A listagem do MNI NUNCA traz o teor**, nem para quem tem procuração —
  `conteudoDisponivel` é sempre `false` ali. Tratar isso como "o tribunal não
  liberou" esconde o download de um processo inteiro ao qual o advogado tem
  acesso pleno. Quem responde "posso ver?" é a tentativa de baixar, com
  `TeorNaoAutorizadoError`.
- **O rótulo da peça no Projudi chega em `descricao`**, não em
  `tipoDocumentoLocal` — esse atributo não existe na resposta real. Nome e tipo
  do arquivo moram em `<outroParametro nome="NomeArquivo">` e `"ArquivoTipo"`.
- **SOAP do tribunal responde HTTP 200 em erro.** `sucesso: false` mora no corpo.
  Confiar em `resposta.ok` faz "Usuário ou Senha inválida." virar consulta bem
  sucedida com zero peças, indistinguível de "processo sem documentos".
- **A resposta do MNI é multipart, e o teor não é base64.** Vem em
  `multipart/related` com XOP/MTOM: o XML traz `<xop:Include href="cid:...">` e o
  arquivo é uma parte binária separada. Ler o corpo como texto corrompe todo
  binário sem lançar erro — por isso `HttpClient.postXml` devolve bytes.
- **Notificação é uma promessa.** A partir do primeiro aviso enviado, o
  advogado para de conferir manualmente e passa a ler silêncio como "não houve
  nada". Por isso `ServicoNotificacao` tem DUAS obrigações, e a segunda não é
  opcional: avisar quando há novidade **e avisar quando não conseguimos
  verificar**. Nunca entregue a primeira sem a segunda — trocaria uma incerteza
  conhecida por falsa segurança.
- **O `upper()` do SQLite é ASCII-only.** `upper('José')` devolve `JOSé` —
  medido, não suposto. Normalização de texto para busca vive em
  `infrastructure/persistencia/normalizacaoBusca.ts` e é a MESMA na gravação,
  na retrocarga e na consulta. Divergir faz o filtro achar uns nomes e não
  outros, sem erro em lugar nenhum. E dobre o acento: ninguém digita acento
  numa busca.
- **Coluna nova em tabela que já existe exige migração explícita.**
  `CREATE TABLE IF NOT EXISTS` não acrescenta coluna, e `ALTER TABLE ADD
  COLUMN` estoura se ela já está lá — a checagem no `PRAGMA table_info` precede
  a alteração (ver `migrarColunas` em `sqlite/banco.ts`). Coluna derivada de
  dado já guardado precisa de RETROCARGA no arranque: sem ela o filtro novo
  enxerga só o que foi sincronizado depois da atualização, e fica calado sobre
  o resto.
- **Toda listagem filtrável devolve o total SEM filtro junto do filtrado**, e
  toda tela que esconde linha diz quantas escondeu. Os filtros do console vivem
  em variável global da página: sobrevivem a trocar de aba e só somem quando a
  página recarrega. Um filtro esquecido fez a carteira parecer ter um processo
  em vez de três, e "sair e entrar" resolveu — conserto que não explica nada e
  deixa a desconfiança. O custo da prevenção é um COUNT.
- **Triagem ordena, nunca esconde.** `exigeAcao === false` serve para destacar o
  que importa, jamais para filtrar andamento fora da tela. Sumir com um ato
  porque a expressão regular não reconheceu o verbo é exatamente como se perde
  prazo, e nenhuma heurística merece esse poder. E toda triagem exibida vem
  acompanhada de "confira no ato completo".
- **O único filtro que ESCONDE decide pelo positivo.** A partir da v0.24.0 há
  "Apenas andamentos principais", e ele não contradiz a regra acima — foi
  desenhado contra ela. `!exigeAcao` continua proibido como critério de
  ocultação, porque é falso em dois casos muito diferentes: "movimento de
  cartório reconhecido" e "a heurística não reconheceu o verbo". Filtrar por
  ele esconderia preferencialmente aquilo sobre o que o sistema menos sabe.
  `ehRuido` casa com a lista de cartório e mais nada; o desconhecido fica na
  tela; ato que exige ação ou que ENTREGA DOCUMENTO nunca some (um "Juntada de
  Petição de Contestação" é a peça da outra parte chegando aos autos); o filtro
  nasce desligado; e a tela diz quantas linhas sumiram.
- **A junção peça↔andamento só existe DENTRO da resposta do MNI.** Cada
  `<documento>` aponta para o `identificadorMovimento` de um `<movimento>` da
  mesma resposta — chave afirmada pelo tribunal, sem custo de consulta, porque
  `movimentos: true` já é obrigatório para as peças virem. Correlacionar `Peca`
  com a linha do DataJud ou do DJEN continua impossível e continua proibido:
  numerações e vocabulários diferentes, sem campo em comum, e casar por data
  pendura a contestação embaixo do despacho errado. Ao mexer nisso, o teste que
  vale é `tests/domain/linha-do-tempo.spec.ts`.
- **A régua degrada, nunca quebra.** Se nenhuma peça casar com movimento
  nenhum, `montarLinhaDoTempo` devolve `espinha: 'fontes-publicas'` e a tela
  volta ao desenho anterior. A tela só troca a linha do tempo quando a espinha
  é a do tribunal — em modo degradado ela manteria os andamentos que já tinha,
  porque uma régua vazia (consulta às fontes públicas falhando no servidor)
  apagaria a tela inteira. Entre exibir a régua e não perder andamento, não
  perder andamento.
- **Reconciliar duas linhas do tempo NUNCA pode diminuir a contagem de atos.**
  A comparação é por balde — mesmo dia, mesmo código da TPU (ou, sem código,
  mesmo título normalizado) — e só se descarta a linha da fonte pública
  enquanto o tribunal tiver pelo menos tantas linhas naquele balde. Três
  juntadas no DataJud contra duas do tribunal: a terceira fica. Mesma razão que
  está em `fusaoProcessos.ts` — duas linhas para o mesmo ato é incômodo visual;
  uma linha ausente é prazo perdido.
- **Redesenhar a tela do processo NÃO pode consultar o tribunal de novo.** O
  redesenho passa por `carregarPecas`, e cada consulta ao MNI são dezenas de
  segundos e mais uma oportunidade de recusa contra a conta do advogado. A
  régua fica em cache na página, com botão explícito para atualizar. Qualquer
  caminho novo que chame `redesenharDetalhe` herda isso — confira antes de
  ligar um botão a ele.
- **Evento que entrega documento não se agrupa em "×N".** O agrupador colapsa
  linhas iguais consecutivas, e colapsar aqui esconderia quatro botões de
  download distintos atrás de um contador — o problema que a régua veio
  resolver.
- **Varredura que falhou não se marca como feita.** `registrarFalha` NÃO toca em
  `varrida_em`: a próxima execução precisa cobrir a janela que esta não
  conseguiu ler. Marcar abriria um buraco silencioso no período exato em que a
  fonte esteve fora.
- **Placeholder também chega de fora.** O DJEN devolve
  `ARQUIVOS DIGITAIS INDISPONÍVEIS (NÃO SÃO DO TIPO PÚBLICO)` no lugar do teor —
  em 69% das publicações do processo de teste. Aviso de fonte não é conteúdo:
  reconheça e marque (`teorIndisponivel`), não repasse como se fosse o despacho.
- **Segredo na URL vira segredo no log.** O link de recuperação chega como
  `GET /?recuperar=<token>`, e o log de acesso registrava a URL inteira em
  nível `info` — token válido, de uso único, no log do contêiner, que costuma
  seguir para coletor de terceiro. O log guarda o CAMINHO, sem query string, em
  toda rota. Lista de parâmetros proibidos não serve: a próxima rota com
  segredo na URL entra sem ninguém lembrar de acrescentá-la.
- **Log não é entrega.** O `LogNotificador` se declara `habilitado` de
  propósito, e para a vigilância isso é certo: exercita o caminho inteiro e
  mostra no log o que teria saído. Para a recuperação de senha é o contrário —
  o "envio" seria um token que ninguém recebe, com a tela dizendo "confira seu
  e-mail". Funcionalidade que depende de ENTREGA só é montada com SMTP de
  verdade (`entregaDeVerdade`, no composition root).
- **Em rota pública, nada caro antes da conferência barata.** `guardar` do
  scrypt gasta ~50ms de CPU e 16 MB, bloqueando o event loop. Na redefinição de
  senha ele vinha antes de olhar o token — 50ms de graça por token inventado,
  contra um processo de thread única. A ordem é: validar (de graça), conferir o
  token, e só então pagar o hash. É por isso que `HashDeSenha` tem `validar`
  separado de `guardar`.
- **Poda só apaga o que a poda criou.** O filtro de backups era "começa com
  `processovivo-` e termina em `.db`", e alcançava a cópia manual que alguém guardou
  antes de uma migração — a que mais importava. O padrão é o nome exato que o
  gerador produz, e o log registra QUAIS arquivos sumiram, não só quantos.
- **Entre subir vazio e não subir, NÃO SUBIR.** Aconteceu em produção na
  v0.18.0: o caminho padrão do banco mudou no `Dockerfile`, o SQLite criou um
  arquivo novo e vazio, o serviço subiu saudável, o health check passou, e a
  carteira apareceu em branco com os dados intactos no arquivo ao lado. Nada
  produziu erro. `abrirBanco` agora recusa iniciar quando o banco configurado
  está vazio e há um banco antigo com dados na mesma pasta — em DUAS passagens,
  porque depois do primeiro deploy o arquivo vazio já existe e só a contagem de
  linhas denuncia. Serviço fora do ar dez minutos é incidente comum; serviço no
  ar com a carteira em branco é o cliente achando que perdeu o trabalho dele.
- **Valor padrão dentro da imagem é configuração que ninguém lembra que
  existe.** Renomear variável no painel é visível e o operador confere; mudar um
  `ENV` do `Dockerfile` muda o comportamento de toda instalação que não declara
  aquela variável, sem sinal nenhum. Ao mexer em `ENV` de caminho, credencial ou
  porta, trate como mudança que quebra — e escreva a proteção junto.
- **O console é JavaScript que nenhuma ferramenta lê.** `ui/script.ts` é um
  `String.raw`: para o `tsc` e para o ESLint aquilo é texto, não código. Um
  bloco copiado de uma tela para outra referenciou um `f` que só existia na
  origem, e a aba inicial passou a morrer com `ReferenceError` — depois de
  pintar o conteúdo, então o `catch` trocava a tela por uma caixa de erro.
  Passou por typecheck limpo, lint limpo e 486 testes verdes.
  `tests/http/console-script.spec.ts` roda o ESLint DENTRO da string e é o
  único lugar que enxerga esse código. Ao mexer no console, rode-o.
- **O console não carrega nada de fora — nem fonte.** Há teste que falha se a
  página tiver `<script src>` ou `<link href="http…">`: o console precisa abrir
  atrás do firewall de um fórum. As fontes (Plus Jakarta Sans e JetBrains
  Mono, v0.29.0) vêm dos pacotes `@fontsource`, que são dependência de
  PRODUÇÃO, e são servidas pela rota `/ui/fontes/:arquivo` a partir de uma
  lista fechada de nomes — o parâmetro nunca vira caminho de disco. Mover esses
  pacotes para `devDependencies` quebra o deploy no arranque (de propósito:
  melhor que o console cair na fonte do sistema sem ninguém notar).
- **Cores do console têm UM significado cada** (v0.29.0, a partir do logo):
  verde = verificado/em dia, azul = novidade, âmbar = pede providência,
  vermelho = erro, sigilo, verificação que falhou. O verde do logo (`#00C853`)
  não serve para texto sobre branco (contraste ~2:1): texto verde usa
  `--verde-tinta`. Selo verde só aparece quando a verificação está de pé —
  um "tudo certo" sem ter olhado é a mesma mentira que o aviso de silêncio
  existe para impedir.
- **Concatenação sem `+` é sintaxe VÁLIDA, e some com a tela.** `h+='<a>'`
  seguido de `'<b>'+'<c>';` compila, roda, e joga o segundo bloco fora: o HTML
  desaparece sem erro nenhum, os `id` que os listeners procuram não existem, e o
  `$('x').addEventListener` estoura DEPOIS de a tela ter sido pintada. Aconteceu
  na v0.26.0, no painel. A trava é `no-unused-expressions` em
  `console-script.spec.ts` — nenhuma das outras regras pega, porque não há
  variável indefinida nem sintaxe quebrada.
- **Erro de programação não pode se disfarçar de erro do servidor.** Um
  TypeError lançado dentro de um `.then` é engolido pelo `.catch` da tela e
  chega em `erroBloco` como se fosse resposta de API. A versão antiga imprimia a
  mensagem dele DUAS VEZES — como título e como explicação, porque `explicar()`
  cai em `e.message` quando não há status — e quem relatava o problema não tinha
  onde. Erro com `status` ou `codigo` é do servidor; o resto é defeito nosso, é
  anunciado como tal, e leva a primeira linha da pilha junto.
- **Tradução de erro que chuta é pior que o erro cru.** O nodemailer usa
  `ESOCKET` tanto para falha de TLS quanto para conexão recusada — consertos
  opostos. A primeira versão do diagnóstico de SMTP via o código e culpava o
  TLS, mandando quem lê mexer em `SMTP_SECURE` enquanto o problema era a porta
  fechada. Ao traduzir erro de biblioteca: decida pela MENSAGEM e não só pelo
  código, carregue o texto original junto SEMPRE, e quando não houver evidência
  para o palpite, entregue o texto cru em vez de inventar uma causa.
  **E case pela FRASE, não por palavra solta.** A correção acima passou a
  decidir pela mensagem, mas casando `certificate` — e contra um certificado
  VENCIDO no servidor de e-mail mandou de novo mexer em `SMTP_SECURE`. Duas
  vezes a mesma função, o mesmo erro um nível mais fundo: palavra solta é chute
  com outro nome. `certificate has expired`, `self-signed`, `altnames` e
  `wrong version number` são quatro problemas com quatro consertos.
- **Conseguir enviar não é conseguir entregar.** O e-mail do sistema sai por
  provedor transacional (Resend), e não pelo servidor de e-mail próprio — mesmo
  com o certificado perfeito, um IP de VPS sem histórico de envio cai em spam,
  e o e-mail que MAIS precisa chegar é justamente o da recuperação de senha,
  pedido por quem está trancado para fora. A troca no código é zero: o
  `EmailSmtpNotificador` fala SMTP com qualquer um. Custou dois dias descobrir
  isso porque eu tratava "a conexão falha" e "a mensagem não chega" como o
  mesmo problema. Ao configurar: `SMTP_FROM` é OBRIGATÓRIO com provedor
  transacional — o `SMTP_USER` ali é um nome de serviço (`resend`), não um
  endereço, e vazio o envio morre com `EENVELOPE`.
- **Certificado autoassinado não anuncia que é autoassinado.** O CyberPanel cai
  nesse fallback em silêncio quando a validação ACME falha, e o sintoma chega no
  cliente como erro de TLS genérico. Os três marcadores que identificam:
  `subjectAltName` ausente, validade de 10 anos e emissor sem cadeia. Um
  certificado sem SAN é recusado por qualquer cliente moderno mesmo vindo de
  autoridade real — conferir só o CN é conferir um campo que ninguém mais usa.
- **Cobrança não pode calar a vigilância.** A assinatura vencida entra em
  CARÊNCIA com tudo funcionando, e cada etapa — 3 dias antes, carência,
  bloqueio — manda um e-mail. O motivo é o mesmo que governa
  `ServicoNotificacao`: a partir do primeiro aviso enviado, o advogado para de
  conferir à mão e lê silêncio como "não houve nada". Parar de vigiar por
  inadimplência e não contar transforma "você não pagou" em "você perdeu um
  prazo porque nós paramos e não avisamos". O aviso de bloqueio diz
  literalmente que não receber e-mail deixou de significar que nada aconteceu.
- **Workspace SEM assinatura passa livre, de propósito.** Chave de API não tem
  conta e nunca terá assinatura — são as integrações do próprio operador.
  Tratar ausência como bloqueio derrubaria o n8n no dia do deploy, sem ninguém
  ter comprado nada. Quem garante que assinante de verdade tenha assinatura é a
  retrocarga no arranque e o teste criado junto com a conta, nunca uma negativa
  por omissão. E **cobrança que entra sem retrocarga é bloqueio em massa**: o
  advogado que usou o sistema ontem abre hoje e vê "sua assinatura venceu"
  sobre a carteira que ele montou à mão.
- **Status de assinatura é DERIVADO das datas, nunca gravado.** Status em
  coluna precisa de alguém que o atualize, e esse alguém é sempre uma tarefa
  agendada que pode não ter rodado — uma assinatura que venceu às 3h e só é
  marcada às 6h são três horas em que o sistema mente. Data comparada com
  `agora` acerta em todo instante, inclusive depois de dois dias fora do ar.
- **Plano que não entrega não se vende.** Desde a v0.28.0 os planos são dado
  (tabela `planos`, editável no painel), então a trava saiu do plano e foi para
  o RECURSO: `RECURSOS` em `domain/entities/Plano.ts` marca `analiseIa` como
  `implementado: false`, e `validarPlano` recusa pôr à venda QUALQUER plano que
  inclua recurso não implementado — o de IA ou um criado amanhã pelo painel.
  `validarRegras` aplica a mesma trava ao plano do teste. Há teste que falha
  se alguém virar `implementado` antes de a análise existir. Cobrar assinatura
  de funcionalidade ausente, com advogado, não volta como pedido de reembolso —
  volta como reclamação formal.
- **Planos são dado; recursos são código.** Nome, descrição, preço, combinação
  de recursos, ordem e "à venda" moram na tabela `planos` e mudam pelo painel
  sem deploy. O que cada RECURSO faz (e se existe) continua em código, porque
  nenhum formulário cria funcionalidade. Não há remoção de plano: as
  assinaturas apontam para o código dele, e pausar (`disponivelParaContratacao
  = false`) é o jeito de tirar da oferta sem deixar ninguém órfão. A semente
  (`PLANOS_INICIAIS`) entra UMA vez, com a tabela vazia — depois disso o
  catálogo é do operador. Regras de teste e carência (tabela
  `regras_assinatura`) não são retroativas: teste vale para conta nova,
  carência a partir da próxima liberação.
- **Liberação de assinatura também existe por HTTP agora (v0.27.0), na área
  administrativa** — mas a regra que gerou este parágrafo continua de pé: o
  que mudou foi COMO a rota se autentica, não a premissa. `/admin/*` usa HTTP
  Basic Auth com credencial fixa em `PROCESSOVIVO_ADMIN_USUARIO`/`_SENHA`,
  validada por um hook próprio (`plugins/autenticacaoAdmin.ts`) inteiramente
  à parte de `ServicoContas` e da tabela `usuarios` — nenhum campo booleano,
  nenhum papel gravado em linha de assinante. Continua valendo: uma rota que
  desse esse poder a uma sessão de usuário normal, ou que adicionasse
  "administrador" como campo em `usuarios`, seria a escalada de privilégio
  que este parágrafo sempre quis evitar, porque o cadastro daquela tabela é
  aberto. `assinatura ver/liberar/cancelar/avisar` no CLI continua existindo,
  igual — a rota HTTP é um segundo caminho para o mesmo operador, não uma
  substituição.
- **Sucesso com o cabeçalho e sem a linha do tempo é NEGATIVA DE ACESSO.** O
  MNI responde `sucesso: true` e devolve `dadosBasicos` completo — partes,
  vara, valor da causa — com ZERO movimentos quando o consultante não consta
  como representante nos autos. Sem código, sem mensagem, sem sigilo
  declarado. Medido no TJGO em 09/2026, mesma consulta e mesmo processo: 3 KB
  e zero movimentos para quem não é representante; 273 KB, 381 movimentos e
  278 documentos para quem tem procuração. Tratar isso como "processo sem
  peças" diz ao advogado que os autos estão vazios — é a mesma confusão entre
  "não existe" e "não consegui ver", aplicada ao conteúdo. A guarda é
  `tribunalEntregouOConteudo`, e ela olha movimento OU documento: só movimento
  reprovaria resposta legítima que traz o arquivo sem a linha do tempo; só
  documento acusaria falta de habilitação em processo recém-distribuído.
- **Rótulo de botão em lote diz o NÚMERO.** "Acompanhar todos" ao lado de um
  título com o total sem filtro, acompanhando só os filtrados, é três números
  na tela e um botão que não se explica. E o alvo é lido no clique, nunca
  congelado na hora de ligar o evento — com a lista congelada, marcar uma caixa
  depois de desenhar manda o conjunto antigo, e o botão faz o que não disse.
- **Anexo não tem rótulo, mas tem MOVIMENTO.** O TJGO manda
  `descricao="Outros"` nos documentos anexos — 111 de 278 num processo real,
  40% da lista caindo em "origem não identificada". Classificar por texto não
  tem como resolver isso. O que resolve é o atributo `movimento`: anexo e
  petição compartilham o número porque foram juntados no mesmo ato, e isso é
  relação afirmada pela fonte, não semelhança de nome. `herdarOrigemPorMovimento`
  só preenche vazio, recusa deduzir quando o mesmo movimento tem origens
  conflitantes, e marca o resultado em `origemDeduzida` — conclusão do sistema
  nunca se apresenta como afirmação do tribunal.
- **Coluna nova SEM retrocarga precisa dizer por quê, no código.** A regra de
  retrocarregar vale para coluna DERIVADA de dado já guardado: sem ela, o filtro
  novo enxerga só o sincronizado depois da atualização e fica calado sobre o
  resto. `cliente` é a exceção e o comentário está junto da migração — o
  tribunal entrega as partes sem dizer qual delas o consultante representa, e
  deduzir pela OAB poria o nome do ADVERSÁRIO na coluna "Cliente". Vazio ali é a
  verdade, não esquecimento. Há teste que fixa a ausência, para ninguém
  "consertar" depois.
- **Selo que o sistema não consegue sustentar não se põe na tela.** A referência
  que originou a carteira em tabela trazia "Audiência" e "Trânsito em julgado", e
  os dois exigiriam ler código da TPU que nunca apareceu numa resposta real
  deste projeto. Selo errado na tela de um advogado é pior que coluna nenhuma:
  ele não confere o que o sistema afirmou com convicção. Os quatro que existem
  (`estadoDaPasta`) saem de dado que temos, e cada um carrega o `motivo` que o
  produziu.
- **O aviso de "não verificado" nunca disputa lugar com o estado da pasta.** São
  duas informações que coexistem — o que fazer hoje e por que não confiar no
  silêncio — e um selo só teria de escolher qual esconder. Por isso
  `EstadoDaPasta` tem `rotulo` e `naoVerificado` separados, e a tabela desenha os
  dois. Mesma raiz da regra do `ServicoNotificacao`.
- **Janela nas heurísticas que marcam pendência.** "Pede providência" olha os
  últimos 10 dias (`PENDENCIA_JANELA_DIAS`; era 30 até a v0.32.0, e a carteira de
  um escritório ativo vivia marcada). Sem janela, um "intime-se" de 2019
  deixaria a pasta marcada para sempre, toda linha da carteira antiga ficaria
  vermelha, e o selo passaria a ser ignorado justamente quando estiver certo.
  É UM valor, lido pelo selo da carteira, pelo card do painel e pelo bloco da
  tela do processo — o servidor o entrega à tela, e a tela nunca escreve o
  número. O bloco lista só os atos dentro da janela e conta os anteriores que
  pedem providência ("veja na linha do tempo"); a linha do tempo continua
  marcando todos: sair do topo não é sumir. Não é cálculo de prazo e não se
  apresenta como tal.
- **Atualizações: uma linha por processo, janela de 15 dias** (v0.32.1,
  `NOVIDADES_JANELA_DIAS`). "+N anteriores" expande na própria linha, a tela diz
  quantas atualizações mais antigas ficaram de fora e oferece "Todas". A janela
  decide pela hora em que o sistema PERCEBEU (`detectadaEm`), nunca pela data do
  ato — a primeira varredura de um processo antigo detecta atos de meses atrás.
  `exigeAcao` só marca; o único critério que tira atualização da tela é o tempo.
- **Encerramento se decide pelo ato MAIS RECENTE, nunca pelo histórico.**
  Processo arquivado e depois desarquivado tem os dois atos nos autos; procurar
  "existe arquivamento" marcaria como encerrada a pasta que voltou a correr — e
  o advogado deixaria de olhar justamente essa.
- **O download avulso da linha do tempo não fica no nosso disco; o PDF
  COMBINADO fica, por pouco tempo — e, desde a v0.33.0, a PEÇA aberta pela Pasta
  digital também** (v0.30.0, decisão do dono de 29/09/2026 — até a v0.29 a regra
  era "nenhum arquivo de peça no disco"; a guarda por peça é decisão de
  02/10/2026, ver o item da Pasta digital abaixo). O download avulso continua indo do
  tribunal direto para a máquina do advogado, e `pecas_baixadas` guarda só
  metadado (há teste que fixa as chaves). O PDF combinado do leitor é guardado
  porque remontá-lo a cada abertura custaria minutos de consulta contra a conta
  do advogado — e a guarda tem contrapartidas que não se afrouxam: **por
  workspace** (toda leitura confere o dono no banco, e o caminho em disco sai do
  hash do workspace — há teste de que o B nunca lê o arquivo do A); **prazo**
  (`LEITOR_TTL_HORAS`, 24 h, limpo pelo `Agendador`); **cota** por PDF e por
  workspace; **nome aleatório, fora do diretório servido e fora do backup**
  (o backup copia o banco, não `leitor/`); **NÃO apagado no logout** (sair num
  aparelho apagaria o PDF que a pessoa lê em outro — decisão do dono,
  01/10/2026); **apagado na exclusão de conta**
  (`ServicoLeitor.apagarDoWorkspace`); e **processo em segredo de justiça não é
  guardado** — nem peça com `nivelSigilo > 0`. Os arquivos de trabalho (as peças
  baixadas para montar) são apagados assim que o PDF fica pronto.
- **Pasta digital: a peça guardada por peça segue a MESMA regra do PDF combinado**
  (v0.33.0). `GuardaDePecas`: **por workspace** (linha e caminho conferem o dono;
  teste A × B), **nome aleatório** (não deriva do id da peça), **mesma raiz do
  leitor — fora do diretório servido e fora do backup**, **TTL de
  `LEITOR_TTL_HORAS`** limpo pelo mesmo `Agendador`, **MESMA cota por workspace**
  (a pasta do workspace é uma só: peça e PDF combinado somam) e a **mesma regra de
  substituição** da v0.31.1, agora sobre os dois — saem os mais antigos de OUTROS
  processos primeiro, nunca o que um job em andamento ainda vai usar. **Processo
  ou peça sob sigilo nunca é guardado** (o pedido confere o id contra a
  LISTAGEM gravada do tribunal, nunca contra o que o navegador diz). O arquivo
  guardado é SEMPRE PDF: imagem e HTML do tribunal são convertidos na entrada e o
  original é apagado na hora (sobra `.tmp` é varrida). **Ocupa o dobro de disco
  numa pasta completa** (peças + combinado — medido, ver
  `docs/pasta-digital-medicoes-v0.33.0.md`): com o teto de 300 MB por PDF, uma
  pasta completa ocupa até ~600 MB dos 1 GB da conta.
- **O clique não é uma chamada ao tribunal** (v0.33.0). `ServicoPasta` guarda UM
  pedido pendente por (workspace, processo): clique em peça diferente TROCA o
  pendente — o intermediário morre antes de sair do servidor —, e só o que
  sobrevive a `PASTA_DEBOUNCE_MS` (400 ms) vai ao tribunal, em lote de 1, pelo
  método em lote do MNI. Peça em guarda não chama o tribunal. **Sem pré-busca:**
  nada é buscado sem o advogado ter pedido aquela peça, a pasta completa ou o
  "Baixar PDF". **Sem retry:** a falha vira o estado da peça (com motivo;
  bloqueio carrega a hora de volta) e quem tenta de novo é a pessoa. **A Pasta
  não conhece o adapter nem balde algum:** toda ida ao tribunal é
  `ServicoLeitor.consultarLote`, que enfileira as chamadas com a pausa de 3 s
  valendo entre TODAS (as do job e as dos cliques). Há teste que falha se
  `ServicoPasta`, `GuardaDePecas` ou a rota importarem adapter, rate limiter ou o
  provedor, e se o composition root montar um segundo adapter, leitor, pasta ou
  armazém.
- **A lista da Pasta nunca consulta o tribunal.** A listagem do MNI (dezenas de
  segundos) é gravada (`pasta_listagens`) quando a tela do processo carrega as
  peças; abrir a Pasta, ler o estado e montar/baixar partem DESSE retrato — e
  "Baixar PDF" com tudo em guarda custa zero consultas. Retrato velho é o preço
  (a régua da página é igual): peça nova só aparece quando as peças do processo
  são recarregadas. Estado de falha por peça fica em memória (evapora no
  redeploy); o que é verdade durável — a peça guardada — está no banco.
- **Seleção nova não apaga o PDF anterior; a cota é que decide** (v0.31.1). Peça
  que já está num PDF guardado deste processo, no prazo, NÃO volta ao tribunal:
  as páginas são copiadas de lá (`reaproveitada.deJob`), e só a peça realmente
  nova vira consulta — o mesmo caminho do "Atualizar". O PDF novo é outro
  arquivo; o antigo fica até o próprio prazo. Só a ATUALIZAÇÃO substitui (e
  apaga) o PDF de que partiu. A REGRA DE SUBSTITUIÇÃO quando a cota da conta
  enche (`abrirEspaco`): saem os PDFs mais antigos pela hora em que ficaram
  prontos, os de OUTROS processos primeiro e os deste por último (são deles
  que a seleção nova copia páginas); nunca sai o PDF de que um job em andamento
  ainda vai copiar páginas — e a limpeza do prazo também espera esse job. Se
  nada puder sair, o pedido é recusado (413) antes de qualquer consulta. Origem
  que sumiu entre a listagem e a montagem vira página de aviso
  (`origem_expirada`), nunca erro.
- **"Baixar só algumas" recorta, não consulta** (v0.31.1). O PDF das peças
  marcadas sai do combinado guardado (`qpdf --pages`, argumentos em vetor,
  linearizado), na ordem dos autos, com índice próprio contado do arquivo
  gerado; mora na pasta do job (mesmo dono, mesmo prazo, mesma cota; no máximo
  3 por PDF). Combinado já apagado → `PdfDoLeitorExpiradoError` (410): a tela
  diz que expirou e manda montar de novo pela "Nova seleção" — remontar em
  silêncio seria consultar o tribunal com a senha do advogado sem ele pedir.
- **O painel nunca passa da largura da janela** (v0.31.1). A largura do divisor
  é guardada no navegador, e numa janela menor ela é cortada (`min(...,
  100vw)` no CSS e `ajustarLargura` no script, que não apaga a preferência).
  Controle dentro do painel tem `min-width: 0`: um `<select>` mede a opção mais
  longa, e o "Ir para a peça" com rótulos reais do TJGO tinha ~730 px — era ele
  que empurrava "Baixar PDF" para fora da tela.
- **Um MNI, um balde, um disjuntor.** Peça avulsa, régua e leitor usam a MESMA
  instância de `MniAdapter`: dois baldes de 30/min somariam acima do teto
  relatado do tribunal, e o bloqueio é do IP, de todos os assinantes. O leitor
  não tem rate limiter; tem só a PAUSA entre as próprias chamadas (3 s). Há teste
  que falha se aparecer um segundo `new MniAdapter` no composition root ou um
  rate limiter no leitor. E o 403 abre um **disjuntor no adapter**
  (`MNI_PAUSA_APOS_403_MIN`): enquanto ele estiver aberto, nenhuma consulta MNI
  sai — nem ficha do balde se gasta —, e os jobs ficam `pausado_por_bloqueio`,
  retomando sozinhos. Em memória: redeploy fecha o disjuntor, e o contêiner novo
  reabre na primeira consulta.
- **O leitor nunca insiste.** Credencial recusada, 403, `sucesso: false`,
  timeout, 5xx: o job para e entrega o que tem como `parcial`, com cada peça
  faltante no índice e o motivo. A única repetição é a peça AUSENTE numa resposta
  de lote que deu certo — pedida UMA vez, sozinha, no fim; não é insistência
  contra recusa, é conferir uma omissão. Credencial já marcada como recusada nem
  vira job.
- **Lote se adapta por BYTES.** A listagem não diz o tamanho de nada (2 KB a
  3,9 MB, medido); só a resposta anterior informa. Passou de
  `LEITOR_LOTE_MAX_RESPOSTA_MB` → o próximo lote cai pela metade e nunca mais
  cresce naquele job. O PRIMEIRO lote é de 5 peças (`LEITOR_LOTE_INICIAL`): é o
  único pedido às cegas, e 10 peças de 3,9 MB dariam ~150 MB de pico; só dobra
  (10, 20) depois de uma resposta leve. E **um job do leitor por vez no
  processo inteiro** — trava de módulo em `ServicoLeitor.processarFila`, para
  dois jobs de credenciais diferentes não somarem os picos; há teste que falha
  se dois lotes correrem juntos. A conta da memória (pico ≈ 3 × resposta + 30 MB) está em
  `docs/leitor-medicoes-v0.30.0.md`, e depende de o leitor de MTOM devolver
  VISTAS da resposta em vez de cópias — há teste que fixa isso.
- **Página do índice é contada, nunca estimada.** O qpdf conta cada parte antes
  de juntar e o arquivo gerado depois; se não bater, o job falha. O índice é a
  base da navegação do painel e das citações da análise — índice desalinhado
  manda o advogado ler a peça errada achando que leu a certa. Peça não obtida
  ocupa UMA página de aviso, com o motivo: nunca some do índice.
- **HTML do tribunal vira TEXTO no servidor e não chega cru a lugar nenhum**
  (estratégia A, decisão do dono de 01/10/2026, depois da sonda: fragmentos só
  com `p`, `span`, `strong`, `br`, `hr`, `u` e imagens `data:`, sem tabela).
  `htmlDoTribunal.ts` é um tokenizador tolerante, sem DOM: ignora todo
  atributo, descarta script/iframe/form com o conteúdo, decodifica entidades e
  lê UTF-8 com recuo para windows-1252 (à mão — o `TextDecoder` do Node lê esse
  rótulo como ISO-8859-1). O `QpdfMontador` desenha o texto com pdf-lib. O que
  não entra — imagem, tabela achatada em "célula | célula", caractere trocado
  por "?" — vai para o `motivo` da linha `html_convertida` do índice, e a
  página diz que é conversão. Há teste (com `pdftotext`) que procura marcação,
  script, atributo e base64 no PDF, no job, no índice e no log.
- **PDF.js é a ÚNICA dependência de front do console** (v0.31.0), e vem do
  próprio servidor: `/ui/pdfjs/:arquivo`, lista fechada montada no arranque a
  partir do `pdfjs-dist` (dependência de PRODUÇÃO). Entra por `import()` no
  script do painel, então a regra "a página não tem `<script src>`" continua de
  pé. Usa o build **legacy**: o padrão do pdfjs-dist 6 chama
  `Map.prototype.getOrInsertComputed` e, em navegador sem esse recurso, a
  página fica em branco sem erro nenhum — há teste que confere o polyfill.
- **A Pasta digital vive em arquivo próprio e só age aberta** (v0.33.1; substituiu
  o painel "Ler peças ao lado", cujos arquivos `scriptLeitor.ts`/`estilosLeitor.ts`
  saíram). `ui/scriptPasta.ts` fala com o console por `window.__pv` (o que ele usa
  do console) e `window.__pvPasta` (os ganchos que o console chama). Fechada, a
  tela do processo é a de antes, com o botão "Pasta digital": o gancho só liga o
  botão, e NADA é injetado na linha do tempo (há teste de navegador que compara o
  HTML antes e depois de abrir e fechar). O CSS só age sob `#pasta`,
  `body.com-pasta` ou `body.pasta-lendo` (há teste que confere cada regra). A Pasta
  nunca insere conteúdo de peça no DOM — o HTML do tribunal já virou texto dentro
  do PDF.
- **A linha da Pasta mostra o ATO que juntou a peça, e o número é a POSIÇÃO do
  ato — calculada, avisada, nunca "oficial"** (v0.33.2; número refeito na
  v0.34.0). O vínculo é o mesmo da régua: `<documento movimento="N">` ↔
  `<movimento identificadorMovimento="N">`, DENTRO da mesma resposta do MNI.
  **Histórico, que não se apaga:** a 0.33.2 mostrou o `identificadorMovimento`
  (ex.: 516017862) como "mov. N" e estava errada — é id INTERNO do tribunal, não o
  número que o advogado vê; foi aprovada sem conferir contra o tribunal, e a
  0.33.3 removeu o número. A sonda e a tela do Projudi (04/10/2026) mostraram a
  regra real: o número do Projudi é sequencial, em ordem cronológica crescente, e
  **conta também os atos bloqueados** ("Movimentação Bloqueada", "Não
  disponível") que o MNI não entrega — num processo real o MNI deu 385 atos e o
  Projudi tinha 386; os anteriores ao ato bloqueado batem exatamente, os
  posteriores ficam 1 abaixo. Decisão do dono (04/10/2026): mostrar o número
  calculado, com aviso. **Regras do número:** (1) o número exibido é SEMPRE a
  posição do ato (1-based) na ordem cronológica dos atos que o MNI entregou
  (`dataHora`, desempate por `identificadorMovimento`, depois ordem de chegada —
  `calcularPosicoesDosAtos`), contada sobre a lista COMPLETA de movimentos da
  resposta, não só os que têm documento; **nunca** o `identificadorMovimento`,
  que a API não devolve (`movimentacao` traz `posicao`, `data`, `descricao`,
  `complemento`; nunca `numero`). (2) O **aviso de atos bloqueados é obrigatório**
  e nunca se esconde enquanto houver número na lista: aviso fixo no topo da Pasta
  ("calculada a partir de N atos recebidos… se o último número no Projudi for
  maior que N, há atos bloqueados…", com `totalAtosRecebidos` do `GET …/pasta`),
  tooltip no "mov. N" e aviso curto ao lado de "Movimentação nº N" no cabeçalho do
  visualizador. (3) **Não se apresenta o número como "oficial"**, em lugar nenhum
  — ele só iguala o do Projudi até o primeiro ato bloqueado. (4) Sem posição
  (listagem anterior à 0.34.0, ou vínculo ambíguo) a linha fica como antes: sem
  "mov." e sem aviso; sem detecção de bloqueados nem calibração — fora do escopo.
  Limite conhecido: o mapper descarta movimento sem `dataHora`, que então não
  entra na contagem. A busca por "nº" casa por IGUALDADE sobre a posição ("382"
  não acha "1382"); a descrição casa por trecho. Número lido do texto: "ev. 382"
  ou "movimentação nº 382" na descrição é texto do cartório (ou da parte),
  aparece como texto, não vira link e não vira o número. A descrição é a do
  tribunal, só aparada. Os dois lados têm de existir: peça que aponta para ato
  que a resposta não trouxe (ou identificador repetido, ou ato sem data) fica SEM
  bloco — descrição errada sobre uma peça é pior que descrição nenhuma. O dado
  vai gravado na listagem (`pasta_listagens.pecas`, campos `movimentacao` e
  `posicao`; coluna `total_atos_recebidos`), então abrir a Pasta continua sem
  consultar o tribunal; listagem gravada antes da 0.34.0 não tem os campos e a
  linha é a de antes até a próxima carga das peças do processo (sem retrocarga: o
  tribunal é a única fonte, e consultá-lo sem a pessoa pedir é o que a regra do
  MNI proíbe). Várias peças do mesmo ato repetem a descrição: agrupar fica para
  decisão do dono.
- **A tela da Pasta não deixa a pessoa olhando um "carregando" sem fim** (v0.33.1).
  Cada espera tem nome e limite: "pedindo esta peça" (a janela do debounce de
  400 ms), "aguardando a fila do tribunal" (o pedido já saiu da tela e espera a
  vez — um job em andamento, a pausa de 3 s), "baixando" (SÓ quando a consulta
  saiu de fato: `consultarLote` avisa quando começa), "abrindo o PDF". Passados
  120 s de espera por uma peça, ou 30 s para abrir um PDF, ou três falhas
  seguidas de consulta, a tela PARA de consultar e oferece "tentar de novo". A
  consulta de andamento lê só o nosso banco (nunca o tribunal). Listagem ausente
  (409) vira mensagem clara e "Tentar de novo", que carrega as peças do processo.
  Acessibilidade fixada por teste de navegador (axe nos temas claro e escuro,
  listbox com teclado completo, foco visível).
- **qpdf com argumentos em VETOR.** `execFile`, nunca string de shell: uma
  montagem são centenas de caminhos, e uma aspa no lugar errado viraria execução
  de comando. Há teste com `$(...)` e aspas no nome do arquivo.
- **Bloco de tela só nasce com conteúdo.** A terceira coluna do painel é montada
  apenas quando há o que pôr nela; sem isso a página fica de uma coluna. Vão em
  branco reservado não é lido como "ainda não há dados" — é lido como defeito.
  Foi o que aconteceu na v0.22.0, com 96px reservados para as peças numa tela
  que nunca as carregava.
- **Não anuncie prazo enquanto não houver prazo.** O painel conta "pedem
  providência", que é o ato que ABRE um prazo; a referência visual que originou
  a tela dizia "prazos em 48h". São coisas diferentes, e um sistema que anuncia
  contagem de prazo sem contar prazo, para advogado, não volta como reclamação
  de interface. `tests/http/painel.spec.ts` falha se a palavra entrar no
  contrato da rota por descuido.
- **O calendário LÊ datas; não calcula prazo** (v0.32.0). Evento detectado só
  nasce de data EXPLÍCITA no texto do andamento, colada a um gatilho na mesma
  frase, e nasce `sugerido` — vale quando o advogado confirma. Tipo `prazo` só
  com data final escrita ("até 20/10/2026"); "prazo de 15 dias" NÃO vira
  evento, porque transformar isso em data é contar dias úteis, suspensão e
  recesso, e apresentar a conta como fato. Redesignação com data nova escrita
  logo depois de "para" vira sugestão nova, e a antiga fica marcada para
  revisão (spec v1.0.3). Na dúvida (duas datas no mesmo
  gatilho, data solta na frase, dois tipos de gatilho), não gera: falso
  negativo continua no andamento que o advogado também recebe; falso positivo
  confiante vira compromisso na agenda dele. O teste que vale é
  `tests/domain/deteccao-de-eventos.spec.ts` — textos sintéticos, sempre.
- **A detecção nunca derruba a sincronização.** Ela roda num decorator da porta
  das pastas (`comDeteccaoDoCalendario`), DEPOIS de gravar o retrato, e falha
  vai para o log. É o ponto único: varredura, "acompanhar" e vigilância gravam
  por ali. Ela relê os 180 dias inteiros a cada sincronização (cobre a
  primeira, que não gera novidade) e é idempotente pela chave de detecção,
  gravada no nascimento e nunca recalculada — recalcular faria a sugestão
  original renascer ao lado da que o advogado corrigiu. O índice único cobre
  os DESCARTADOS: sugestão recusada não volta. Nenhum módulo do calendário
  importa adaptador de rede; `tests/main/calendario-sem-rede.spec.ts` percorre
  o grafo de imports.
- **O feed ICS sai do nosso controle, e leva o mínimo.** `SUMMARY` é tipo e
  número do processo — nunca o título livre, o trecho do andamento, nome de
  parte ou a observação do advogado. Processo em segredo de justiça vai sem
  número, nem no link. A URL é `/calendario/feed/<token>.ics`, FORA do `/v1`
  (fica anos no Google Agenda de quem assina); só o SHA-256 do token vai ao
  banco; token inválido, revogado, assinatura bloqueada e plano sem o recurso
  são o MESMO 404. E o log de acesso registra o PADRÃO dessa rota, não o
  caminho — o caminho é o token (`ROTAS_COM_SEGREDO_NO_CAMINHO` em
  `servidor.ts`; rota nova com segredo no caminho entra ali).
- **A tela do calendário tem o próprio contraste.** O `--tinta3` do console
  sobre o fundo claro mede 4,2–4,4:1 (axe-core), abaixo dos 4,5:1 para texto
  pequeno; dentro de `.cal` nota e selo neutro usam `--tinta2`. O resto do
  console continua com o valor antigo — trocar a variável global mexe em todas
  as telas e é decisão à parte.
- **Data de calendário não passa por UTC.** Evento guarda `dataLocal`
  (`AAAA-MM-DD`) e `horaLocal`, no fuso fixo de São Paulo (-03:00, sem horário
  de verão desde 2019). Dia inteiro sai no ICS como `VALUE=DATE` direto da
  string; converter para instante e de volta joga a audiência para o dia
  anterior em qualquer cliente a oeste de Greenwich.
- **Recurso que entra em todos os planos precisa de retrocarga nos planos
  gravados** — a semente só vale para banco vazio. O calendário entrou assim
  (`acrescentarCalendarioAosPlanos`, UMA vez por banco, marca em `estado`, para
  não desfazer depois a decisão do operador que o tirar pelo painel), e
  `ServicoPlanos.criar` o inclui por padrão.
- **Prazo processual é responsabilidade do advogado.** A `procedencia` (fonte +
  `consultadoEm` + `deCache`) acompanha todo `Processo` justamente para que a
  interface possa mostrar quando o dado foi visto. Nunca apresente dado de cache
  como se fosse consulta ao vivo.

---

## 9. Versionamento

A versão vive **só** no `package.json` — `src/infrastructure/config/versao.ts` a
lê em tempo de execução, e ela sai no log de arranque e em `GET /health`. Nunca
duplique o número numa constante: no dia em que divergir, será exatamente quando
você estiver olhando um log tentando descobrir se o deploy pegou.

Toda entrega que muda comportamento: bump no `package.json` **e** entrada no
`CHANGELOG.md`, na mesma PR.

---

## 10. Estado atual e próximos passos

**Pronto:** domínio, portas, casos de uso, `DataJudAdapter`, `DjenAdapter`
(busca por OAB, partes, advogados, inteiro teor), `MockCrawlerAdapter`,
`ProcessoSearchService` com fallback **e enriquecimento entre fontes**,
`fundirProcessos`, acompanhamento com SQLite e varredura agendada, cache com
TTL/LRU, rate limiter, config validada, CLI, API HTTP (Fastify) com chave de API
e rate limit, **contas de assinante com senha, sessão em cookie e ambiente
isolado por conta** (v0.14.0), **cadastro progressivo com trilha de liberação**,
**painel inicial**,
**identidade visual e tema claro**, **vigilância contínua por OAB**, **peças do processo via MNI com cofre de
credenciais**, **recuperação de senha por e-mail** e **backup automático do
banco com verificação de integridade** (v0.17.0),
**triagem do que exige ação**,
**notificação por e-mail com aviso de silêncio**, console web com busca por OAB,
acompanhar em lote e tela do processo orientada a providência,
**área administrativa** com gestão de assinaturas e de chaves de API por HTTP
Basic Auth (v0.27.0), **catálogo de planos editável com preço e regras de
teste e carência** (v0.28.0), **visual novo a partir do logo** (v0.29.0),
**leitor de peças, Etapa 1: PDF combinado com índice** (v0.30.0),
**Etapa 2: ler ao lado, com PDF.js servido pelo próprio servidor** (v0.31.0),
**remarcar com reaproveitamento e "baixar só algumas"** (v0.31.1),
**calendário: detecção, agenda, tela e feed ICS** (v0.32.0),
**ajustes dos advogados: Atualizações por processo, peças no topo, providência em 10 dias** (v0.32.1),
**Pasta digital: backend (v0.33.0) e tela (v0.33.1) — peça aberta ao clique, guarda por peça, montar pasta completa, baixar marcadas**,
**ato (movimentação) de cada peça na lista da Pasta, com descrição** (v0.33.2) **e o número da movimentação calculado pela posição do ato, com aviso de atos bloqueados** (v0.34.0; a 0.33.3 havia removido o número errado da 0.33.2),
Dockerfile multi-stage, CI, 1168 testes.

**Pasta digital (v0.33.0, backend):** `GET /v1/processos/:numero/pasta` (lista +
estado de cada peça + intervalos de página + totais SEM filtro + procedência
`aoVivo:false`), `POST …/pasta/pecas/:pecaId` (200 em guarda / 202 na fila),
`GET …/pasta/pecas/:pecaId/arquivo` (PDF com Range), `POST …/pasta/montar`,
`POST …/pasta/baixar/previa` e `POST …/pasta/baixar`. Montar e baixar são jobs do
leitor (`finalidade`: `pasta_completa` | `selecionadas`), e o PDF/índice saem
pelas rotas `/leitor/:jobId` — o "Baixar PDF" das marcadas se chama
`processo-<número>-pecas-selecionadas.pdf`. **Tela (v0.33.1):** lista à esquerda
(ordem dos autos, estado, `p. N–M`, caixas, atalhos por tipo, busca, "só
disponíveis", teclado) e visualizador PDF.js à direita, "Montar pasta completa",
"Ver tudo seguido", "Baixar PDF" das marcadas com aviso do que será buscado;
divisor arrastável; no celular, lista em tela cheia e peça em tela cheia com
"voltar" (`ui/scriptPasta.ts`, `ui/estilosPasta.ts`). **Não existe mais** o
painel "Ler peças ao lado", a seleção na linha do tempo, "Reabrir o PDF já
pronto" nem o recorte por extratos na interface — as rotas `/leitor/…/extratos`
continuam na API. Especificação:
`docs/ajustes-e-pasta-digital-especificacao-v1.0.0.md` (seções 5 a 10).

**Calendário (v0.32.0):** eventos por workspace — detectados nos andamentos
(sugeridos, a confirmar, com procedência) e manuais (confirmados) — em
`/v1/calendario/eventos`, e o feed ICS em `/calendario/feed/<token>.ics`
(criar/regenerar/revogar/alterar "incluir sugeridos" em `/v1/calendario/feed`).
Recurso `calendario` em todos os planos. Retroativo de 180 dias pelo
`Agendador`, sem rede. A tela mora em `ui/calendario.ts` (Agenda e Mês, feed,
formulário) e fala com o console só por `window.__pv`,
`window.__pvCalendario` e `window.__pvAoIniciar`; o mesmo arquivo atende o
link `/?processo=<número>` que o feed põe na descrição de cada evento.
`script.ts` NÃO cresce — há teste que fixa o tamanho. Especificação e as
decisões do dono: `docs/calendario-especificacao-v1.0.3.md`.

**Leitor de peças, ajustes (v0.31.1):** o painel abre com "Nova seleção" ao lado
de "Reabrir o PDF já pronto" (com data e hora); a seleção nova começa vazia,
com "Limpar seleção" sempre à mão e "Repetir a seleção anterior" como botão;
peça já guardada não volta ao tribunal (a estimativa conta só as novas); "Baixar
selecionadas (N)" recorta do PDF guardado (`POST
/v1/processos/:numero/leitor/:jobId/extratos`, arquivo em
`.../extratos/:extratoId/pdf`); e o painel nunca passa da janela.

**Leitor de peças, Etapa 2 (v0.31.0):** botão "Ler peças ao lado" no cartão
das peças abre um painel à direita (divisor arrastável; tela cheia no celular).
Nele: marcar peças na própria linha do tempo, selecionar todas, atalhos por
rótulo, estimativa em faixa vinda do servidor e confirmação acima de 150; o
progresso com estados honestos; e o PDF lido por trechos, com "p. N" ao lado de
cada peça da régua, destaque da peça ao rolar, busca, zoom e download.

**Leitor de peças, Etapa 1 (v0.30.0):** `POST /v1/processos/:numero/leitor` com
os ids das peças cria um job (fila mínima em SQLite, `jobs_leitor`, um job por
vez, retomável depois de redeploy); o executor baixa em lote adaptativo pelo
MESMO `MniAdapter` das peças, monta com qpdf na ordem dos autos (PDF como veio,
imagem vira página, HTML vira páginas de texto, o que falhou vira página de
aviso) e entrega o PDF
linearizado com `Range` e o índice de páginas. "Atualizar" consulta
`consultarAlteracao` e baixa só o que falta, reaproveitando as páginas do PDF
anterior. Medições, a sonda de HTML e a conversão em
`docs/leitor-medicoes-v0.30.0.md`. **Pendente:** a medição da camada de texto
(OCR) e a Etapa 3 (análise), que depende de decisão do dono. O leitor fica atrás do plano
`pecas`; um recurso próprio `leitor` no catálogo fica para depois (decisão do
dono, 01/10/2026). Não há exclusão de conta no
produto ainda: `apagarDoWorkspace` existe e está testado para quando houver.

**Visual (v0.29.0):** logo do dono do produto (limpo do arquivo do CorelDRAW,
letras convertidas em desenho) na lateral azul-marinho e na tela de entrada;
cores tiradas do logo com um significado por cor; tela de entrada dividida
(marca e promessa à esquerda, formulário à direita); painel com saudação, selo
de verificação e quatro cards; carteira com linha de altura fixa (partes em
coluna própria, cortadas com reticências) e filtros recolhidos em "Mais
filtros". Tema: automático (segue o sistema do advogado), claro ou escuro,
escolhido na lateral e guardado no navegador (v0.29.1). As
telas de busca, processo, vigilância, acessos e conta herdaram cores e fontes,
sem mudança de estrutura.

**Planos editáveis (v0.28.0):** aba Planos no `/admin` — visão geral com
quantos assinantes cada plano tem (por status derivado), criar plano
combinando recursos existentes, editar nome/descrição/preço/recursos/ordem,
pausar e voltar à venda, e ajustar dias de teste, plano do teste e dias de
carência. O preço (em centavos, `null` = sem preço publicado) aparece para o
assinante em `GET /v1/assinatura` e na tela da conta.

**Área administrativa (v0.27.0):** página própria em `/admin`, protegida por
HTTP Basic Auth (`PROCESSOVIVO_ADMIN_USUARIO`/`PROCESSOVIVO_ADMIN_SENHA`) —
sem senha configurada, a área nem existe (responde 501). Abas de
assinaturas (listar, consultar por e-mail, liberar plano, cancelar, disparar
os avisos de vencimento na hora) e chaves de API (emitir, listar, revogar —
sem editar `.env` nem reiniciar o serviço). Chave emitida aqui autentica nas
rotas do assinante exatamente como uma chave de `PROCESSOVIVO_API_KEYS`: as
duas calculam `identificador`/`workspace` a partir do mesmo hash SHA-256, e o
plugin de autenticação principal aceita as duas fontes. Nenhum campo novo em
`usuarios` — ver o parágrafo sobre "administrador" acima.

**Entrega de e-mail (19/09/2026):** em produção via Resend, domínio
`processovivo.com.br` verificado com DKIM próprio (`resend._domainkey`),
CNAMEs de retorno (`send`, `rsend`) e DMARC `p=none`. O MX e o SPF da raiz
continuam apontando para o CyberPanel, que é onde mora a caixa
`contato@processovivo.com.br` — enviar pelo Resend e receber no servidor
próprio convivem sem conflito porque os registros do provedor ficam todos em
subdomínios.

**Painel (v0.26.0):** data por extenso, hora e a frase da última verificação no
topo; três cards (ativos, pedem providência, peças baixadas hoje); e um trilho à
direita com o que já foi puxado do tribunal, montado só quando tem conteúdo. O
registro de downloads que sustenta isso também marca "já baixado" na régua, o
que evita repetir uma consulta ao MNI de dezenas de segundos.

**Casca e carteira (v0.25.0):** barra lateral fixa com contagem, conteúdo até
1100px, e a carteira em tabela com rótulo de cliente editável na linha, filtro
por cliente e um estado derivado por pasta (providência, novidade, arquivado,
em curso) mais o aviso de "não verificado" ao lado. Veio de uma referência
visual trazida pelo dono do produto; o tema escuro fixo, a tipografia de
display e o botão de "baixar peças do dia" ficaram de fora, com o motivo de
cada um no CHANGELOG.

**Régua temporal (v0.24.0):** com a resposta do MNI, a linha do tempo é a
espinha da tela do processo — cada evento entrega os documentos daquele ato,
a decisão salta aos olhos e há filtro de ruído que esconde só o cartório
reconhecido. A lista de peças no rodapé guarda apenas o que não pôde ser
pendurado em evento nenhum.

**Cobrança (v0.21.0):** três planos (Acompanhamento, Peças, IA — o último
modelado e fora de venda), teste de 14 dias no plano Peças para conta nova,
carência de 7 dias, avisos por e-mail em três etapas e liberação manual pelo
comando `assinatura` do CLI. (Desde a v0.28.0, planos, teste e carência são
editáveis no painel; esses são os valores iniciais.) Gateway de pagamento **não** entra ainda: com zero
assinantes, o Pix com liberação à mão ensina o domínio antes de apostar num
provedor, e o gateway depois é um adapter atrás de uma porta.

**Não implementado (decisão consciente do MVP):** gateway de pagamento, convite de
membros para um mesmo escritório, crawler real, **cópia de backup fora do VPS**
(as cópias automáticas ficam no mesmo volume do banco — protegem contra erro de
operação, não contra perder o volume; o procedimento manual está em DEPLOY.md),
**WhatsApp** (adiado: exige template aprovado pela Meta e conta business
verificada — e a biblioteca não oficial que resolveria numa tarde viola os
termos e derruba o número, levando junto o aviso de prazo de todos os
assinantes), **cálculo de prazo** (dias úteis do art. 219 do CPC, recesso,
suspensões — alto valor e alto risco: só entra como calculadora com as contas à
vista, nunca como afirmação), página do processo para o cliente do advogado,
alerta de evento do calendário por e-mail/push, sincronização de mão dupla
com Google/Outlook, fila de jobs genérica (a do leitor é mínima e só dele). O cache é em memória — uma instância, e evapora no redeploy.

Ao implementar qualquer um deles, **atualize este arquivo na mesma PR.**
