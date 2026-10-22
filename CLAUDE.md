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
│   ├── entities/                # Processo, Movimentacao, Parte, NumeroCNJ, Oab,
│   │                            #   posicaoDoAto + numeracaoDoProjudi (Pasta digital),
│   │                            #   tipoDaComunicacao + estadoDaPasta/lerProvidencia (cumprido),
│   │                            #   destinatarioDaComunicacao (paraOUsuario),
│   │                            #   AnaliseDoAto + vocabularioDaAnalise (IA),
│   │                            #   prazoEmDias (calculadora, exceção v0.39.0) + atoDoDiario,
│   │                            #   DestinoDePecas + nomeDoArquivoNoDrive (Drive, v0.42.0),
│   │                            #   Pagamento (vocabulário de cobrança; ciclo em Plano, v0.44.0)
│   │                            #   Custo + valorEmReais (centro de custos: lançamento, totais, centavos, v0.47.0),
│   │                            #   Recebimento + HistoricoDeCustos + CatalogoDeCustos (Grupo › Subcategoria, v0.48.0),
│   │                            #   Comprovante (tipo pelos bytes) + CustosPorCliente (chave do cliente, soma de totais, v0.49.0)
│   ├── errors/                  # hierarquia de DomainError
│   ├── ports/                   # ProcessoProvider, RepositorioAcompanhamentos, Cache…
│   └── usecases/                # BuscarProcessoPorNumero, BuscarProcessosPorOab
├── application/
│   ├── politicas/               # redigirParaIA, verificarAnalise, entradaDoModelo,
│   │                            #   limiteDeAnalises (política PURA da análise por IA),
│                            #   selecionarAtosParaResumo + cabecalhoInstitucional + mesmoAtoParaOResumo (resumo, v0.54.0),
│   │                            #   estadosDeConexao (`state` + PKCE do OAuth do Drive)
│   └── services/                # ProcessoSearchService, ServicoAcompanhamento,
│                                #   ServicoVigilanciaOab, ServicoNotificacao,
│                                #   ServicoPecas, ServicoContas,
│                                #   ServicoAssinaturas, ServicoLeitor,
│                                #   ServicoPasta + GuardaDePecas (Pasta digital),
│                                #   ServicoCalendario (+ ingestaoDoCalendario),
│                                #   ServicoResumoDoCalendario (resumo por e-mail dos eventos a confirmar, v0.51.0),
│                                #   ServicoAnaliseDoAto (IA, por botão),
│                                #   ServicoAvisoDoPrazo (aviso no calendário, v0.39.0),
│                                #   ServicoResumoDoProcesso (resumo por IA, por botão, v0.40.0),
│                                #   ServicoDrive + fonteDePecasDaPasta (envio ao Google Drive, v0.42.0),
│                                #   ServicoPagamentos (cobrança recorrente atrás da porta GatewayDePagamento, v0.44.0)
│                                #   ServicoCustos (centro de custos do processo + prestação de contas em PDF, v0.47.0),
│                                #   ServicoCustosPorCliente (visão por cliente, PDF consolidado, CSV, v0.49.0)
├── infrastructure/
│   ├── adapters/
│   │   ├── modelo/              # OpenRouter: transporte (ZDR), lista ZDR 24 h, analisador
│   │   ├── drive/               # GoogleDriveAdapter (REST, sem SDK) + transporte injetável
│   │   ├── pagamento/           # MercadoPagoAdapter (REST, sem SDK) + validação do webhook + GatewayFalso
│   │   ├── datajud/             # adapter + mapper + schemas + aliases
│   │   ├── djen/                # adapter + mapper + limpeza de HTML
│   │   ├── mni/                 # adapter + envelope SOAP + mapper + MTOM
│   │   └── crawler/             # MockCrawlerAdapter + fixtures
│   ├── cache/                   # InMemoryCache, CachedProcessoProvider
│   ├── config/                  # env.ts (validação de configuração)
│   ├── http/                    # HttpClient (timeout + retry)
│   ├── logging/                 # ConsoleLogger
│   ├── persistencia/            # serialização + SQLite (acompanhamentos, vigilâncias),
│   │                            #   reparoDeNovidades + diagnosticoDeProvidencia (sonda, só leitura)
│   ├── notificacao/             # EmailSmtpNotificador, LogNotificador
│   ├── seguranca/               # cofre AES-256-GCM das credenciais de tribunal,
│   │                            #   senha (scrypt) e sessão (token + cookie)
│   ├── agenda/                  # Agendador da varredura
│   ├── arquivos/                # ArmazemEmDisco (guarda temporária do leitor)
│   ├── calendario/              # gerador do feed ICS (RFC 5545)
│   ├── pdf/                     # QpdfMontador (qpdf junta; pdf-lib gera avisos), PrestacaoDeContasPdf (v0.47.0, só pdf-lib)
│   │                            #   PdftotextExtrator (texto por página, interno, Fase 0 da IA de peças, v0.53.0)
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
        └── rotas/               # processos, contas, saúde, interface, leitor, calendário, planosPublicos
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
| `WorkspaceInvalidoError` | `--workspace`/rota admin com id fora do formato (`malformado`, 400) ou que não é de conta, chave ativa nem chave do `.env` (`inexistente`, 404) | nada é gravado; a mensagem não repete o valor |
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
| `CustoInvalidoError` | valor fora de 1 centavo–R$ 1.000.000,00 ou não inteiro, descrição/observação/motivo vazio ou longo, data que não existe, subcategoria inexistente/arquivada/repetida no grupo, grupo inválido, editar registro cancelado, mover subcategoria com lançamentos de/para o Grupo 08 | 400; mensagem curta em português, NUNCA com o valor ou o texto recebidos |
| `CustoNaoEncontradoError` | lançamento, recebimento, subcategoria ou histórico que não existe PARA ESTE workspace | 404; mesma resposta para "não existe" e "é de outra conta" |
| `LimiteDeCustosError` | 500 lançamentos ou 500 recebimentos no processo, 60 subcategorias próprias ativas na conta (v0.48.0) ou 5 comprovantes no lançamento (v0.49.0) | 422 com `detalhes.limite` (`lancamentos` \| `recebimentos` \| `categorias` \| `comprovantes`) |
| `ComprovanteInvalidoError` | o arquivo do comprovante está vazio (`arquivo_vazio`, 400), passa de 5 MB (`arquivo_grande`, 413) ou não é PDF/JPEG/PNG DE VERDADE pelos primeiros bytes, ou o conteúdo não bate com o tipo declarado (`tipo_nao_aceito`, 415) | corpo com `detalhes.motivo`; mensagem do sistema, NUNCA com o nome ou o conteúdo; **zero** chamadas ao Google |
| `ComprovanteNaoEnviadoError` | o Drive não guardou o comprovante: `drive_cheio` / `recusado` (422), `limite_de_uso` (429), `drive_indisponivel` (503) | corpo com `detalhes.motivo`; frase NOSSA, nunca texto do Google; nada é anexado |
| `EventoDeCalendarioNaoEncontradoError` | evento não existe PARA ESTE workspace | 404; mesma resposta para "não existe" e "é de outro" |
| `TransicaoDeEventoInvalidaError` | mexer em evento descartado | 409; descartado é final |
| `FeedDoCalendarioAusenteError` | pediu para alterar o feed e não há feed vigente | 404 na rota autenticada; diz o que falta |
| `ListagemDaPastaAusenteError` | a Pasta digital não tem a lista de peças do processo (a tela ainda não a carregou) | 409; carregar as peças do processo e pedir de novo |
| `PecaDaPastaNaoEncontradaError` | a peça não está na pasta DESTE workspace (não existe, venceu ou é de outro) | 404; mesma resposta para os três casos |
| `PecaSigilosaNaoGuardadaError` | pediu para guardar peça com `nivelSigilo > 0` | 403; o download avulso pela linha do tempo continua |
| `PastaSemPecasParaJuntarError` | montar/baixar sem nenhuma peça guardável (lista vazia ou só sigilosas) | 409; não monta PDF vazio |
| `CalibracaoDeNumeracaoInvalidaError` | número do Projudi informado não serve como âncora (fora dos atos, abaixo da posição, incompatível com os outros, acima de 50) | 400; a mensagem diz qual — conferir o que foi digitado |
| `FeedDoCalendarioNaoEncontradoError` | token do feed inválido, revogado, assinatura bloqueada ou plano sem o recurso | 404 com o MESMO corpo seco nos quatro casos |
| `AcompanhamentoNaoEncontradoError` | pediu algo sobre processo que ESTE workspace não acompanha | 404; mesma resposta para "não existe" e "é de outra conta" |
| `EntradaNaoAnalisavelError` | a análise por IA não se aplica: `sem_plano` (403), `segredo_de_justica` (403), `texto_insuficiente` / `texto_indisponivel` (422), `limite_de_uso` / `limite_diario` (429; o segundo é o teto técnico do dia, v0.50.0), `ato_nao_encontrado` (409) | corpo com `detalhes.motivo`; NENHUM chamou o modelo |
| `ExtracaoDeTextoError` | o texto de um PDF não pôde ser extraído (v0.53.0): `arquivo_vazio`, `arquivo_grande`, `pdf_invalido`, `pdf_protegido`, `tempo_esgotado`, `saida_grande_demais`, `ferramenta_ausente` | módulo INTERNO (sem rota nem mapeamento HTTP na Fase 0); mensagem nossa, NUNCA com texto de peça nem saída do binário |
| `AnaliseNaoEncontradaError` | avaliar análise que não existe PARA ESTE workspace | 404; mesma resposta para "não existe" e "é de outra conta" |
| `PagamentoRecusadoError` | a cobrança não se aplica: `plano_sem_preco` / `plano_nao_vendavel` / `ciclo_nao_suportado` / `termos_nao_aceitos` / `email_do_pagador_invalido` (422), `conta_sem_email` (403, conta de chave de API), `ja_assinante` / `plano_ja_vigente` / `sem_recorrencia` (409), `plano_desconhecido` (400) | corpo com `detalhes.motivo`; NENHUM chamou o gateway |
| `AssinaturaDeWebhookInvalidaError` | o aviso do gateway não se prova dele: assinatura ausente, malformada, adulterada, de outro recurso ou velha (> 5 min) | 401 SEM dizer o motivo (vai ao log); NADA é gravado nem consultado |
| `GatewayDePagamentoIndisponivelError` / `GatewayDePagamentoRecusouError` | rede, timeout, 429, 5xx do gateway / 4xx definitivo ou resposta fora do contrato | **503 / 422** na API (nunca 502: o proxy do Easypanel troca 502/504 por HTML), sempre JSON com `detalhes.motivo` ∈ `email_pagador` / `credencial` / `parametro_invalido` / `indisponivel` / `desconhecido`; no webhook, indisponível sobe (o gateway repete) e recusa vira 200 (repetir não adianta); nenhum carrega token, corpo ou dado do pagador |
| `ZdrIndisponivelError` / `SemProvedorQueAtendaError` | o OpenRouter não achou provedor ZDR (passo da política de dados) / não achou por outro passo | são `ProviderIndisponivelError`; NUNCA repetir a chamada sem ZDR |
| `AtoDaProvidenciaInvalidoError` | "marcar como cumprido" apontou para ato que saiu do retrato ou que não pede providência | 409; a tela recarrega e a pessoa decide de novo |
| `PrazoNaoCalculavelError` | o aviso de prazo a partir da análise não se aplica: `sem_prazo_na_analise`, `ato_fora_do_diario`, `tipo_necessario` (422) ou `ato_nao_encontrado` (409) | corpo com `detalhes.motivo`; NENHUM chamou o modelo e nada foi criado |
| `DriveRecusadoError` | o Drive não pode ser usado agora: `sem_plano` (403), `nao_conectado` / `precisa_reconectar` / `job_em_andamento` / `nada_para_enviar` (409), `estado_invalido` / `conexao_recusada` (400), `limite_global` (429), `job_nao_encontrado` (404, igual para "não existe" e "é de outra conta") | corpo com `detalhes.motivo`; a mensagem é do sistema, nunca do Google; **zero** chamadas ao Google |
| `AutorizacaoDoDestinoRevogadaError` / `AutorizacaoDoDestinoVencidaError` | `invalid_grant` ou permissão da pasta negada (reconectar) / `401` (renova UMA vez e repete) | a conexão vira `precisa_reconectar`; nunca insistir |
| `DestinoSemEspacoError` / `DestinoLimitouError` / `DestinoIndisponivelError` / `DestinoRecusouError` | Drive cheio / 429 (com `Retry-After`) / rede, timeout, 5xx / outro 4xx | cheio e limite PARAM o lote; 429 e 5xx repetem com backoff limitado; 4xx falha só a peça |
| `ArquivoRemovidoNoDestinoError` / `PastaRemovidaNoDestinoError` | o advogado apagou o arquivo / a pasta no Drive | arquivo: "removida no Drive", NÃO reenvia sozinho; pasta: recriada UMA vez |

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
npm run cli -- assinatura liberar --workspace <id> pecas 60   # conta de CHAVE de API (sem e-mail); em produção: node dist/main/cli.js …
npm run cli -- assinatura cancelar ana@escritorio.com.br
npm run cli -- assinatura avisar            # o mesmo que o agendador roda
npm run cli -- pagamento reconciliar [--workspace <id>]   # confere o gateway e corrige aviso perdido (v0.44.0)

npm run build && node scripts/ia-avaliacoes.mjs                         # avaliações da análise por IA (v0.38.0), só leitura
node scripts/sonda-ia-ato.mjs --listar-modelos-zdr=deepseek               # provedores ZDR do modelo (lê a lista do OpenRouter)
node scripts/ia-comparar-modelos.mjs --modelos=a,b                         # comparador (v0.52.0): só ESTIMA; --executar roda, --teto-usd=1 (padrão)
node scripts/ia-comparar-modelos.mjs --tarefa=pecas --modelos=a,b                 # comparador de PEÇAS (v0.53.0, sintéticas); --julgar-revisao=<csv> julga errado/perigoso
node scripts/pecas-medir-texto.mjs                                         # camada de texto das peças guardadas (v0.53.0), só leitura, só agregados
node scripts/diagnostico-resumo.mjs <número do processo>                    # por que o resumo leu (ou não) o ato mais recente (v0.54.0), só leitura, só números
node scripts/ia-comparar-modelos.mjs --tarefa=resumo                         # resumo-1.0.0 × 1.1.0 (v0.54.0, sintéticos): estima; --executar roda
npm run build && node scripts/diagnostico-providencia.mjs --lista-filtro   # sonda (v0.37.6), só leitura
node scripts/diagnostico-providencia.mjs --numeros=<n1,n2> --mostrar        # por que cada um aparece ou não

npm test                 # suíte completa (Vitest)
npm run test:watch       # modo watch
npm run test:cov         # cobertura, mínimo 70% no núcleo
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run format           # Prettier
npm run check            # typecheck + lint + test  ← rode antes de commitar
npm run build            # compila para dist/
```

**Antes de qualquer commit: `npm run check` verde** (typecheck + lint + testes + build de produção). Sem exceção.

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
`/v1/senha/recuperar` e `/v1/senha/redefinir`, `/v1/planos` (a vitrine do site de vendas, v0.45.0) (e as rotas `/admin`, que têm
autenticação própria, o feed do calendário `/calendario/feed/:arquivo`, que
se autentica pelo token no próprio caminho, e o webhook do gateway de pagamento
`/v1/pagamentos/webhook/mercadopago`, que se autentica pela assinatura do próprio aviso). As quatro últimas
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
  sobre a carteira que ele montou à mão. **Uma única exceção, a análise por IA
  (v0.38.0, decisão do dono):** o recurso `analiseIa` NÃO passa sem assinatura —
  manda texto a um terceiro e custa dinheiro por chamada. Quem decide é
  `ServicoAssinaturas.temRecursoSemExcecao`, que devolve `false` sem assinatura,
  com assinatura vencida além da carência ou com plano sem o recurso, e é
  usada SÓ por `ServicoAnaliseDoAto` **e, desde a v0.42.0, pelo Drive** (`salvarNoDrive` + `pecas`,
  porque o Drive usa a conta Google da pessoa e chave de API não tem conta). Os outros recursos
  continuam com `exigir()` e a regra acima. Não generalize a exceção.
- **Ações possíveis da análise por IA são providência, sem citação; o rodapé não mostra o modelo**
  (v0.38.5). `acoes_possiveis` = `{ acao }` (Zod strict, sem `trecho`): infinitivo ou imperativo curto,
  dizendo QUEM faz O QUÊ, nunca cópia ou paráfrase do `trecho_chave`; sem providência clara = lista vazia
  e a tela diz "Sem providência indicada no ato." O trecho do ato aparece UMA vez, no `trecho_chave`.
  `verificarAnalise` (regras 1.1.0) rejeita o resultado inteiro (`acao_copiada_do_trecho`, sem texto em
  tela, banco ou log) quando uma ação tem mais de 60% das palavras de conteúdo em comum com o
  `trecho_chave` (contra o maior dos dois conjuntos); o resto da verificação não mudou. Prompt `ato-1.1.0`.
  O rodapé e o selo dizem "Gerado por IA em DATA E HORA. Confira no ato." — o modelo segue gravado em
  `analises_ia`, na API e em `ia-avaliacoes.mjs`. Linha gravada antes com `trecho` na ação não o expõe.
- **A análise por IA pede o formato em TEXTO, não em esquema estrito** (v0.38.4). Em produção o
  filtro "Filter by Parameters" do OpenRouter (por causa de `require_parameters` + `response_format`
  `json_schema`) deixou 0 endpoints: o único endpoint ZDR do modelo não declara saída estruturada
  (404, ~2,6 s). A chamada normal agora usa o formato do degrau C: SEM `require_parameters` e SEM
  `response_format`; a instrução de formato vai no sistema (`INSTRUCAO_DE_FORMATO_EM_TEXTO`), o JSON sai
  por `jsonDoTexto` (tolera cerca de código; chaves ANTES do JSON falham) e o Zod `.strict()` do
  analisador (`lerRespostaDoModelo`) valida. **Nada da proteção do texto foi afrouxado:** `zdr`,
  `data_collection: deny`, `allow_fallbacks: false`, `only` (⊆ permitidos), a conferência do par
  modelo + provedor e `verificarAnalise` valem em toda chamada. O que se perde é só a garantia de forma
  no provedor: resposta fora do formato vira `RespostaInvalidaError`, sem repetir e sem texto em erro
  ou log. Sem "escada" (tentar o estrito antes): o rodízio da 0.38.3 segue como está e se desliga
  sozinho com um provedor só. No diagnóstico em degraus, o A é só comparação (produção até a 0.38.3) e
  o C é a produção.
- **Depois de 429/5xx a análise por IA muda de provedor, sem soltar a lista** (v0.38.3).
  `allow_fallbacks` continua `false`: o OpenRouter não escolhe reserva. Quem roda a lista é o
  `TransporteOpenRouter`: 1ª tentativa com `only` = TODOS os permitidos; após 429/5xx, cada nova
  tentativa leva `only` = UM provedor, em ordem, sem repetir (não depende do corpo do erro dizer
  quem limitou — por isso a 1ª pode cair no mesmo que limitou). Esgotada a lista (1 + N), falha
  com o roteamento da 0.38.2. Esperas 1 s, 3 s e, depois, 3 s. Só 429/5xx rodam; rede repete com
  os mesmos permitidos; um provedor só repete como antes; o degrau D (sem `only`) não roda.
  `zdr`, `data_collection`, `only` ⊆ permitidos e a conferência do par
  modelo + provedor da resposta valem em TODA tentativa (`require_parameters` saiu na 0.38.4). Quem pensar em `allow_fallbacks: true`
  deve ler a nota da sonda (2.1): conferir DEPOIS não impede o texto de sair.
- **O log da análise por IA diz onde a chamada parou, sem texto** (v0.38.2).
  `ProviderIndisponivelError.roteamento` (`status`, `passo`, `funil`) é preenchido só em
  `traduzirErro` (`TransporteOpenRouter`), com o que o OpenRouter devolveu JÁ SANEADO
  (`extrairRoteamento` + `sanearCorpoEnviado`); `ServicoAnaliseDoAto` o põe na linha "análise do
  ato não concluída" (`statusHttp`, `passoDoRoteamento`, `funilDoRoteamento` truncado em 600).
  Corpo cru, mensagem do SDK e `requestBodyValues` NUNCA são copiados — o roteador pode ecoar o
  pedido, que leva texto de ato. Ler o tempo: 400/401/402/403/404 falham na 1ª resposta;
  429/5xx/rede repetem com esperas de 1 s e 3 s (~5 s no total).
- **Plano IA vendável por DADO, teto técnico por dia, e SEM exceção de beta** (v0.50.0, decisões do dono).
  (1) **A venda do plano IA é decidida no `/admin`, nunca em código:** `analiseIa` virou `implementado: true` e
  ganhou `cobradoPorUso: true` (só ela). Plano com recurso cobrado por uso **só vai à venda com preço > 0**
  (`validarPlano`: "Defina o preço antes de colocá-lo à venda") e **nunca é o plano do teste** (`validarRegras`).
  A semente segue com o IA FORA de venda e SEM preço; o operador põe preço e "à venda" (R$ 99,90 é decisão do
  dono, gravada só no banco). Daí em diante o IA é um plano como os outros: `motivoDeNaoContratar`, `GET /v1/planos`,
  checkout, webhook e reconciliação não têm caso especial. IA = Peças + `analiseIa`. Sem cota mensal comercial.
  (2) **Só quem tem `analiseIa` no plano vigente usa** — assinado ou liberado à mão —, por
  `temRecursoSemExcecao` (sem o "workspace sem assinatura passa livre"). O teste de 14 dias continua liberando
  o Peças, SEM a IA. **A exceção de teste fechado (`PROCESSOVIVO_IA_WORKSPACES_LIBERADOS`, v0.38.1) foi
  REMOVIDA**, como este arquivo mandava ao abrir ao público: a variável, `lerWorkspacesLiberados`,
  `workspacesLiberados` e `workspaceLiberado.ts` saíram; se a variável ainda estiver no ambiente, o arranque só
  avisa no log (sem ecoar o valor) e ela não libera nada. `PROCESSOVIVO_IA_HABILITADA` segue sendo a chave geral;
  ZDR falhando fechado, redação, verificação e segredo de justiça não mudaram. (3) **Teto TÉCNICO de segurança**
  `PROCESSOVIVO_IA_MAX_POR_DIA` (padrão 200 análises de ato por conta por dia de São Paulo, em memória —
  reiniciar zera, como os outros freios): **não é limite do plano** e não aparece como tal; atingido, motivo
  `limite_diario` (429), "Muitas análises hoje. Tente de novo amanhã ou fale com a gente." e ZERO chamadas ao
  modelo. Os freios por hora, por conta em andamento e global seguem; o resumo tem só o freio próprio por hora.
  (4) **Aviso de upgrade com oferta do servidor:** `GET /v1/analises/disponibilidade` devolve `oferta`
  (`ver_planos` só para conta com e-mail quando há plano com `analiseIa` CONTRATÁVEL — mesma
  `motivoDeNaoContratar` — com a cobrança ligada; `fale_conosco` para conta de chave de API; `nenhuma` no resto).
  A tela troca a frase só por isso: "Ver planos" leva a "Minha conta"; chave lê "Fale com a gente para contratar.";
  sem plano à venda, a frase de sempre, sem link. (5) **Vitrine:** `GET /v1/planos` ganhou `incluiAnaliseIa`
  (aditivo); o site usa `site/planos-v0.50.0.html` (destaque "Inclui análise com IA" e a nota "O teste grátis de
  14 dias não inclui a análise com IA."); o cartão de planos do app e a confirmação mostram o mesmo destaque. Nada
  em texto de venda sugere cálculo de prazo ou consultoria jurídica. (6) **Custo por análise:** cada análise
  concluída é uma linha de `analises_ia` (modelo, provedor, latência, tokens e custo quando o gateway informa;
  nunca texto do ato) e `scripts/ia-avaliacoes.mjs` mostra o custo médio. **Troca Peças → IA não é automática:**
  com renovação ativa o checkout recusa (`ja_assinante`); a pessoa cancela a renovação do Peças e assina o IA, e a
  aprovação renova a partir do vencimento atual com o plano trocado (`Assinatura.renovada`).
- **Medição da análise por IA: conjunto sintético, comparador MANUAL com teto de gasto e ZDR falhando fechado, avaliação com motivo e resumo no teto diário** (v0.52.0, decisões do dono; **nenhuma troca de modelo, prompt ou regra de verificação**).
  (1) **Conjunto de avaliação** `tests/fixtures/ia-avaliacao/casos.json`: 48 casos 100% inventados (CNJ de 2099, OAB na faixa 9xxxx, nomes de mentira), cada um com `pontos_obrigatorios` (alternativas por trecho, sem acento e caixa) e
  `proibicoes`; `esperado_sem_chamada` TEM de bater com `prepararEntrada().suficiente` (teste). Caso real nunca entra aqui. (2) **Comparador** (`scripts/ia-comparar-modelos.mjs`; núcleo em `src/main/sonda/`:
  `casosDeAvaliacao`, `avaliacaoAutomatica`, `comparadorDeModelos`, `comandoComparadorIa`) **reaproveita `executarSonda`** (a sonda NÃO foi alterada): ZDR por chamada, `provider.only`, par modelo + provedor conferido na
  resposta. É MANUAL: **nunca roda no CI nem no servidor** (há teste que confere o `ci.yml` e o `package.json`). **Sem `--executar` só ESTIMA** (lê a lista ZDR, não envia texto). **Só roda modelo aprovado pela lista oficial de ZDR
  lida na hora; o resto é recusado; lista inalcançável, apelido (`~`) ou variante (`:`) e modelo de produção fora da lista = nada é enviado.** O modelo de produção (`PROCESSOVIVO_IA_MODELO`) entra SEMPRE, em primeiro, como referência.
  **Teto de gasto padrão US$ 1,00 por rodada** (`--teto-usd`, > 0): estimativa acima do teto recusa executar; durante a rodada `TransporteComTeto` soma o gasto (custo da resposta, senão tokens × preço, senão US$ 0,01 conservador;
  chamada que falha também conta) e recusa a PRÓXIMA chamada quando o teto é alcançado, e o relatório diz "rodada incompleta". Chave só por `OPENROUTER_API_KEY` (nunca impressa nem gravada); saída FORA do repositório (`dados/comparador-ia/`
  ou `--saida`). **Preços são estimativa de lista, "não confirmados", e o relatório diz a origem de cada custo** (`openrouter` | `estimativa` | `nao-medido`). (3) **A avaliação automática é um filtro, não um juiz** (pontos por trecho; violações por
  padrão — pode errar nos dois sentidos): por isso sai também o CSV de revisão humana (coluna `avaliacao` vazia; célula que começa com `=`, `+`, `-`, `@` ganha apóstrofo), e **nenhum modelo entra em produção por relatório**: a troca é decisão do dono.
  (4) **Avaliação com motivo:** `POST /v1/analises/:id/avaliacao` e `/v1/resumos/:id/avaliacao` aceitam `motivo` opcional (`erro_de_fato` | `citacao_inventada` | `concluiu_prazo` | `deixou_de_fora` | `outro`), SÓ com `errado`/`perigoso` (Zod `.strict()`);
  coluna `motivo_avaliacao` aditiva, sem retrocarga; Útil nunca guarda motivo; nunca texto livre. A linha "Esta análise foi útil?" / "Este resumo foi útil?" fica logo abaixo do cabeçalho do resultado. `ia-avaliacoes.mjs` (v1.1.0) ganhou custo p50/p95/máximo e a contagem por motivo.
  (5) **O resumo de processo conta no MESMO teto técnico diário por conta** da análise de ato (`TetoDiario`, uma instância no composition root, em memória; `PROCESSOVIVO_IA_MAX_POR_DIA`): o freio de 6 por hora do resumo e a mensagem neutra continuam, e o teto diário NÃO é limite do plano.
- **IA de peças, Fase 0: extração SÓ interna, sem OCR, texto de peça NUNCA persistido, medição somente leitura, comparador manual** (v0.53.0, decisões do dono;
  especificação `docs/ia-analise-de-pecas-especificacao-v1.1.0.md`, resultado em `docs/ia-pecas-fase0-resultado-v1.0.0.md`; **nenhum produto**: sem tela, rota, plano, preço
  nem chamada de IA nova em produção). (1) **Extração** (`ExtratorDeTextoDePdf` / `PdftotextExtrator`, o `poppler-utils` já está na imagem): `pdftotext -layout`, PDF pela
  entrada padrão, `execFile` com argumentos em VETOR, 30 s por peça, 20 MB por arquivo, 8 MB de saída, 40 páginas lidas e 80 mil caracteres, `ExtracaoDeTextoError` em português SEM
  texto de peça. **Sem OCR:** PDF sem camada de texto (menos da metade das páginas com ≥ 50 caracteres) é medido e contado, nunca lido. **O texto extraído só existe em memória:
  nunca em banco, log, relatório ou arquivo** (só contagens e medidas). O módulo não tem rota nem uso em produção; só o comando de medição e os testes o chamam. Não há limite
  de CPU/memória do processo filho (exigiria cgroup/`ulimit`): relatado, não resolvido. (2) **Medição** (`scripts/pecas-medir-texto.mjs`): SOMENTE LEITURA (banco `readOnly` +
  `query_only`, nunca `abrirBanco`), sem rede, só agregados; saída sem texto, nome, número de processo, localizador nem workspace. O medidor no momento do download (b) NÃO existe:
  decisão do dono. (3) **Redação de peça** (`redigirPecaParaIA`, módulo próprio): CEP, RG/CNH com rótulo, nascimento e conta/agência com rótulo, depois da redação do ato (que NÃO mudou).
  **Não cobre endereço nem nome de terceiro fora do retrato — nenhum texto do produto pode prometer isso.** (4) **Comparador de peças** (`--tarefa=pecas`): reaproveita `executarSonda`
  (parâmetro opcional `tarefa`; sem ele nada muda), `TransporteComTeto`, ZDR da lista oficial de agora e o relatório; verificação por (página, trecho); expressão proibida só vale para
  o texto que o MODELO escreve (o trecho é cópia da peça); critério da seção 8 (citação ≥ 95%, zero perigoso, errado ≤ 10%, pedidos principais ≥ 90%). Só peças inventadas
  (`tests/fixtures/ia-pecas`). (5) **Decisões da Fase 1, só registradas:** resultado guardado com citações curtas por até 30 dias (configurável); cada peça vale 5 análises no teto diário;
  peça acima de 40 páginas ou 80 mil caracteres é recusada; o Autran avalia ~20 peças anonimizadas fora do repositório. **Antes de implementar a Fase 1, atualize este arquivo.**
- **Resumo do processo por IA: considera SEMPRE o ato mais recente e as providências do sistema, nunca apresenta ato antigo como situação atual, prompt `resumo-1.1.0`**
  (v0.54.0, decisões do dono; **nenhuma troca de modelo, provedor, ZDR, redação, segredo, plano, teto, prazo, análise do ato, peças ou calendário**; **SUBSTITUI** do item da v0.40.0
  o limite de 5 providências, o rodapé "Lidos com texto: N…" e a frase "A IA não indicou pendências" sem condição). (1) **Seleção** (`selecionarAtosParaResumo`, regras 1.1.0): o ato mais
  recente com texto utilizável entra SEMPRE (limite de caracteres das providências); todas as providências do sistema com texto, até `pendentesMax` = **8**; depois os recentes até 10; título NÃO gasta
  o limite de textos; o ato mais recente, mesmo sem texto, é o primeiro da linha do tempo de títulos. A seleção devolve `maisRecente` (+ `lido`), `providenciasNaoLidas` (com o motivo) e
  `motivosDosNaoLidos`. As regras da 1.0.0 (`REGRAS_DA_SELECAO_1_0_0`) existem só para o comparador. (2) **Mesmo ato em duas fontes, só na SELEÇÃO** (`mesclarMesmoAto`): só-título e com-texto contam
  como um quando são do mesmo dia (São Paulo), da mesma classe pelo começo do título (despacho, decisão, sentença, intimação, citação, ato ordinatório, edital), de fontes DIFERENTES, e há exatamente um de cada
  — na dúvida não junta; o retrato, a tela e as contagens do sistema não mudam. (3) **Cabeçalho** (`removerCabecalhoInstitucional`, pura): só o bloco repetido do COMEÇO (duas linhas curtas seguidas ou mais),
  só se o resto ficar utilizável; o texto enviado é o texto verificado. (4) **A faixa "Ato mais recente" é do SISTEMA, nunca do modelo:** `atualidade` na resposta (ato mais recente + `lido`, providências sem
  leitura com data/tipo/motivo, e `tribunalMaisNovo` lido da listagem da Pasta digital JÁ gravada — nenhuma consulta nova ao tribunal). Ato mais recente sem leitura → a tela diz que o resto vem de atos mais antigos
  e muda o título para "O que os atos lidos mostram"; providência sem leitura → a tela nomeia os atos em vez de "A IA não indicou pendências". (5) **Verificação 1.1.0** (`verificarResumo` com
  `ContextoDaVerificacaoDoResumo`): com o mais recente sem leitura, item de situação "atual/atualmente/no momento/último ato/mais recente" é descartado (`atualidade`); com providência sem leitura, item "não há
  pendências" é descartado (`pendenciaNegada`); pontos de atenção apontam o ato (`{ codigo, ato }`, data/tipo vêm do retrato). (6) **Log só de contagens por motivo** ("resumo do processo montado"): nunca texto, título,
  parte, número de processo ou conta. (7) **Comparador** `--tarefa=resumo` (`resumo-1.0.0` × `resumo-1.1.0`, 8 processos sintéticos em `tests/fixtures/ia-resumo`, mesmas travas do comparador: ZDR da lista de agora, teto,
  estima antes de `--executar`) e **diagnóstico** `scripts/diagnostico-resumo.mjs` (só leitura, só números, número do processo só como argumento). Nenhum prompt entra em produção por relatório do comparador.
- **Cobrança recorrente atrás de uma PORTA, o webhook como única fonte de verdade e o acesso sempre das
  datas** (v0.44.0, parte 1 do Mercado Pago: assinatura recorrente por CARTÃO; Pix e boleto avulsos são a
  parte 2). (1) **Porta `GatewayDePagamento`** (`domain/ports`): criar assinatura (devolve a URL do
  checkout HOSPEDADO), consultar assinatura/cobrança/pagamento, listar as parcelas, cancelar a
  renovação, validar o aviso — e um gancho opcional `criarCobrancaAvulsa` (parte 2) que nenhum adapter
  implementa. O resto do sistema só a conhece; só o composition root faz `new MercadoPagoAdapter`.
  `GatewayFalso` (sem rede) serve a teste e desenvolvimento e NÃO sobe em produção. (2) **O sistema nunca
  recebe nem guarda dado de cartão**: o fluxo é "assinatura sem plano, pagamento pendente"
  (`POST /preapproval` com `status: "pending"`), o comprador paga na página do gateway, e o corpo da
  criação não tem campo de cartão. O e-mail do pagador (o da conta; desde a v0.49.5, o que a pessoa informa na confirmação) vai ao gateway (que o exige) e NÃO é gravado; as
  tabelas `cobrancas_recorrentes`, `pagamentos_processados` e `eventos_de_pagamento` guardam só id,
  estado, valor, datas e o TIPO do meio — há teste que falha se aparecer coluna de cartão, CPF, nome ou
  e-mail. O vínculo com o workspace é o `external_reference`: 24 bytes aleatórios, de uso único, nunca
  o e-mail nem o id do workspace. (3) **O webhook (`POST /v1/pagamentos/webhook/mercadopago`, pública) é
  só um despertador**: a assinatura do aviso (`x-signature` = `ts=<s>,v1=<hex>`; texto
  `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`; HMAC-SHA256 hex; tempo constante; ±300 s; `data.id`
  da query, sem minúsculas) é a fórmula do SDK oficial e inválida = 401 sem gravar nada; o CORPO nunca é
  fonte — o id serve para CONSULTAR o gateway, e só a consulta muda o estado. Responde 200 em até 15 s
  (o gateway espera 22; o resto segue em segundo plano). Falha do gateway sobe como 503 e o gateway
  repete; recusa da consulta (id que não existe) vira 200. (4) **Um caminho só para dar acesso**:
  pagamento aprovado chama `ServicoAssinaturas.liberar` — o MESMO do `assinatura liberar` manual, com
  plano e meses do que foi contratado (nada aqui calcula vencimento). **Idempotente**: o pagamento é
  registrado com chave única (`pg:<pagamento>`; as recusas da mesma parcela são `cob:<parcela>`) ANTES de
  renovar e só quem registra renova; se a renovação falhar, o registro é desfeito para o aviso repetido
  tentar de novo. Fora de ordem funciona: estorno antes da aprovação ocupa a chave e a aprovação depois
  não renova pagamento devolvido. (5) **O acesso é das datas, não do gateway**: cancelar a renovação,
  recusa de cartão e pausa NÃO derrubam o plano (ele vale até o fim do período já pago; a carência e os
  avisos de vencimento seguem); recusa avisa a conta por e-mail (uma vez por parcela, sem dado do
  cartão); cancelamento/pausa PELO GATEWAY avisa que nada mais renova; **estorno e contestação NÃO
  revogam sozinhos**: registram, avisam o operador (`PROCESSOVIVO_PAGAMENTO_AVISO_EMAIL`, só log sem ele)
  e esperam a decisão manual no /admin. `DELETE /v1/assinatura/recorrencia` encerra a renovação e deixa
  o evento na trilha de auditoria (arrependimento de 7 dias é tratado fora do sistema). (6) **Preço é do
  plano**: plano sem preço não se contrata (botão ausente, rota 422), assim como plano pausado e ciclo
  não vendável (`CICLOS_VENDAVEIS`, hoje só `mensal`); o valor da cobrança sai SEMPRE do plano no
  servidor (preço mensal × meses do ciclo), nunca do cliente. O ciclo é coluna nova em `planos`
  (`mensal` por padrão, migração aditiva). Conta de CHAVE de API (sem e-mail) não assina online
  (`conta_sem_email`, 403). (7) **Desligada por padrão** (`PROCESSOVIVO_PAGAMENTO_HABILITADO=false`):
  nenhuma rota de checkout, o webhook responde 404 e a tela não mostra nada. Ligada, o arranque exige
  `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_WEBHOOK_SECRET` (barrados por `pareceValorDeExemplo`) e
  `PROCESSOVIVO_URL_BASE` em https, sem nunca ecoar valor. O ambiente é DECLARADO em
  `PROCESSOVIVO_PAGAMENTO_AMBIENTE` (`teste` | `producao`), obrigatória e SEM padrão (v0.44.1: o Mercado Pago
  emite credencial de teste com `APP_USR-`, então o prefixo do token não identifica nada); ambiente `teste`
  em servidor de produção só com `PROCESSOVIVO_PAGAMENTO_PERMITIR_TESTE=true`, token `TEST-` com `producao`
  não sobe, e o /admin mostra "TESTE" em destaque a partir da variável. (8) **Reconciliação sem agendador**: `pagamento reconciliar` (CLI) e o botão do
  /admin consultam cada recorrência aberta e as parcelas dela e corrigem aviso perdido, pelo mesmo
  caminho idempotente. (9) **Tudo o que é "jeito do Mercado Pago" mora em
  `adapters/pagamento/mercadoPago.constantes.ts`** (caminhos, status, tópicos, tolerância, prefixo do
  token): itens marcados `CONFIRMAR` vieram de documentação lida de segunda mão e se ajustam ali, num
  lugar só. Tela em `ui/pagamento.ts` (`window.__pvPagamento`); `script.ts` não cresceu.
- **Página de vendas: vitrine pública, plano escolhido atravessando o cadastro e aceite dos Termos obrigatório**
  (v0.45.0; o site `processovivo.com.br` é estático, fica em outro servidor e só MOSTRA planos; cadastro, login,
  confirmação e pagamento são do app). (1) **`GET /v1/planos` é pública** (em `rotasPublicas`) e devolve SÓ o que
  o site já mostraria: `slug` (o `codigo` do plano), `nome`, `resumo`, `recursos` (nomes legíveis), `preco`
  (`{valorCentavos, ciclo}` ou `null`), `assinavel` (a MESMA `motivoDeNaoContratar` do checkout) e, no topo,
  `pagamentoDisponivel`. Nenhum id de banco, contagem, ordem ou configuração; plano fora de venda não aparece e
  plano sem preço aparece SEM preço e sem "Assinar agora" (vitrine vazia antes do /admin ter preço seria pior).
  Cache de 60 s e balde de limite de taxa próprio por IP. (2) **CORS manual e só nesta rota**: `PROCESSOVIVO_SITE_URL`
  (a ORIGEM do site, https, sem caminho; valor torto derruba o arranque) é a única origem liberada, só `GET`, sem
  credenciais, `Vary: Origin` sempre, e vazio = nenhum cabeçalho. NÃO se usa `CORS_ORIGINS` para isso: ele é
  global e abriria a API inteira. O site nunca envia nem recebe cookie ou chave do app. (3) **O plano escolhido
  atravessa o cadastro sem rota nem tabela nova** (`ui/planoEscolhido.ts`, `window.__pvPlano`): o site aponta para
  a RAIZ (`/?plano=<slug>&conta=1`, e `&assinar=1` no "Assinar agora"); o parâmetro é lido UMA vez e sai da barra
  (`replaceState`, como o `?recuperar=`); só um slug no formato do catálogo (`^[a-z][a-z0-9-]{1,29}$`, até 30)
  é guardado, no `sessionStorage` por 30 min com reserva em memória — nunca `localStorage`, nunca o servidor
  (antes do login não há sessão nem workspace; guardar lá seria superfície nova numa rota pública). Depois de
  entrar, o plano é conferido contra `GET /v1/planos` (assinável, pagamento ligado); qualquer outro valor cai no
  fluxo normal em silêncio, e o plano nunca é destino de redirecionamento. Conta de chave de API descarta o plano.
  (4) **`assinar=1` NUNCA cobra sozinho:** só vale com plano válido, e abre a confirmação (`__pvPagamento.preparar`);
  sem ele o plano só é DESTACADO ("Plano escolhido", por texto) em "Minha conta". (5) **Um caminho só para assinar:**
  o botão "Assinar" do cartão e o plano do site abrem a MESMA confirmação (valor, ciclo, a frase da renovação,
  Termos, caixa de aceite DESMARCADA, aviso de teste), e `POST /v1/assinatura/checkout` exige `aceiteTermos: true`
  para TODO checkout: sem ele, 422 `termos_nao_aceitos` e nada é criado (nem cobrança, nem aceite, nem chamada
  ao gateway). O aceite é gravado pelo servidor, dentro do checkout, em `aceites_termos` (workspace, versão, plano,
  data — sem e-mail, sem IP), e a versão vem de `PROCESSOVIVO_TERMOS_VERSAO`, obrigatória com a cobrança ligada.
  (6) **Quem já assina não abre outro checkout:** qualquer recorrência autorizada, de QUALQUER plano, é barrada
  (`ja_assinante`: "para trocar de plano, cancele a renovação atual primeiro" — a troca de plano não existe), e
  plano pago e vigente do mesmo plano por liberação manual é `plano_ja_vigente`; o teste de 14 dias não conta.
  (7) **O trecho do site** (`site/planos-v0.45.0.html`; desde a v0.50.0, `site/planos-v0.50.0.html`, um arquivo, sem dependência externa) insere texto da rede
  SÓ por `textContent`, valida o formato do slug, nunca inventa preço (falha ou demora = mensagem neutra e um
  botão) e não traz o rodapé legal. Webhook, adapter, reconciliação e as regras de plano não mudaram.
- **Recusa do gateway: motivo de lista fechada, log saneado, 422/503 e a última falha no /admin** (v0.45.1).
  (1) Todo 4xx do Mercado Pago passa por `lerRecusa` (`adapters/pagamento/recusaDoMercadoPago.ts`, pura): vira um
  `motivoDoGateway` — `email_pagador` | `credencial` | `parametro_invalido` | `indisponivel` | `desconhecido` — e um
  `diagnostico` JÁ SANEADO. A classificação casa por NOME DE CAMPO do contrato e por frases inteiras
  (`mercadoPago.constantes.ts`), nunca por palavra solta; sem evidência é `desconhecido` e o texto saneado está no
  log (mesma lição do diagnóstico de SMTP: palpite errado manda consertar a coisa errada). (2) **O `warn`
  "gateway de pagamento recusou o pedido"** leva operação, status, motivo, `error`, `message`, `code`/`description`
  de cada `cause` e os NOMES dos campos enviados; e-mail mascarado, token apagado, 300 caracteres por texto,
  **nunca corpo bruto, token nem valor do pedido**. (3) **A API responde 422 (recusou) ou 503 (fora do ar), sempre
  JSON** com `detalhes: { situacao, motivo }`; NUNCA 502 — o proxy do Easypanel troca 502/504 (e às vezes 503) por
  uma página HTML e esconde o motivo —, por isso a tela também age só pelo status quando o corpo não é JSON. A frase
  é NOSSA (`FRASE_DO_GATEWAY`); o texto do gateway pode ecoar o e-mail do pagador e nunca sai. (4) **A trilha guarda a
  falha** (`eventos_de_pagamento`, tipo `gateway_falhou`: operação, status, motivo, código curto; sem tabela nova) e
  o `/admin` mostra a última (`ultimaFalha`). (5) **Falha do gateway não é prova de que o fluxo está errado:** com
  credencial de TESTE o `payer_email` precisa ser de um usuário de teste do mesmo país e diferente do vendedor;
  mudar o fluxo do e-mail do pagador é decisão do dono (ver o CHANGELOG da 0.45.1).
- **Assinar uma conta de chave de API é pelo workspace, e nada mais muda** (v0.42.1). Chave não tem
  e-mail: `assinatura liberar|ver --workspace <id>` (CLI) e `/admin/api/workspaces/:workspace/assinatura`
  (admin) usam o MESMO `ServicoAssinaturas.liberar/resumo` — só o identificador difere, e nunca os dois
  juntos. O id passa por `LocalizadorDeWorkspace` (16 hex de chave ou 32 de conta; conta, chave ativa ou
  chave do `.env`), senão `WorkspaceInvalidoError` e nada gravado. Não há exceção de plano por tipo de
  autenticação. **Consequência a lembrar:** dar assinatura a um workspace que hoje passa livre o
  coloca na regra normal — vencida a carência, `exigir()` o barra em TUDO (402) e não sai aviso, por não
  haver e-mail. Plano Peças/IA inclui todo recurso que existe hoje, então durante a vigência nada é
  limitado; liberar por 60 meses e anotar a data.
- **Status de assinatura é DERIVADO das datas, nunca gravado.** Status em
  coluna precisa de alguém que o atualize, e esse alguém é sempre uma tarefa
  agendada que pode não ter rodado — uma assinatura que venceu às 3h e só é
  marcada às 6h são três horas em que o sistema mente. Data comparada com
  `agora` acerta em todo instante, inclusive depois de dois dias fora do ar.
- **Plano que não entrega não se vende.** Desde a v0.28.0 os planos são dado
  (tabela `planos`, editável no painel), então a trava saiu do plano e foi para
  o RECURSO: `RECURSOS` em `domain/entities/Plano.ts` marca `analiseIa` como
  `implementado: false` (até a v0.49.6), e `validarPlano` recusa pôr à venda QUALQUER plano que
  inclua recurso não implementado — o de IA ou um criado amanhã pelo painel.
  `validarRegras` aplica a mesma trava ao plano do teste. Cobrar assinatura
  de funcionalidade ausente, com advogado, não volta como pedido de reembolso —
  volta como reclamação formal. **v0.38.0:** a análise por IA existe, em teste
  fechado, para a conta que o operador liberou à mão no plano IA; `analiseIa`
  seguiu `implementado: false` porque o que a trava impedia era a VENDA, não o uso.
  **v0.50.0:** o dono decidiu vender; `analiseIa` virou `true` e a venda passou a ser decidida
  por dado (preço + "à venda" no /admin), ver o item "Plano IA vendável por DADO".
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
  É UM valor, lido pelo selo da carteira, pelo card do painel (e, até a v0.37.6, pelo bloco da
  tela do processo) — o servidor o entrega à tela, e a tela nunca escreve o
  número. O bloco lista só os atos dentro da janela e conta os anteriores que
  pedem providência ("veja na linha do tempo"); a linha do tempo continua
  marcando todos: sair do topo não é sumir. Não é cálculo de prazo e não se
  apresenta como tal.
- **Grade nunca sem `minmax(0, …)` e `min-width: 0`** (v0.35.1). Item de grade não
  encolhe abaixo do conteúdo: um nome de arquivo de 120 caracteres sem espaço em
  "Peças baixadas" empurrou o trilho para fora da página. Texto vindo de fora
  (nome de arquivo, título) leva `overflow-wrap: anywhere`, e o nome NÃO se trunca
  com "…". `tests/browser/inicio-navegador.spec.ts` mede `scrollWidth` em quatro
  larguras.
- **Avisos da Pasta podem ser compactados, nunca escondidos; a lista da Pasta ocupa
  a altura disponível e rola por dentro** (v0.35.3). A Pasta tem `100dvh`, a página
  por baixo não rola, e só a lista e o visualizador rolam (cada um por dentro). O
  aviso "lista obtida do tribunal… não é consulta ao vivo" e o da numeração (enquanto
  houver número não exato) ficam sempre à vista; a estimativa do "Montar pasta
  completa" mora numa dica junto do botão (foco e mouse), não numa linha fixa.
  `tests/browser/pasta-layout-navegador.spec.ts` mede cinco larguras.
- **A lista da Pasta mostra TODAS as movimentações recebidas** (v0.36.0): as sem peça
  têm o selo "Sem peça", não têm seleção e nunca disparam consulta; contagens dizem
  quantas são de cada tipo. Antes a lista era só de peças e o número "pulava" (386 →
  382), escondendo atos sem aviso. **Dados:** `pasta_listagens.atos` (JSON, uma
  entrada por ato: posição, data/hora, descrição, complemento, identificador interno
  e `vinculoIncerto`) é gravado junto da listagem, a partir da MESMA resposta do MNI
  que já trazia os movimentos — nenhuma consulta nova e nenhum conteúdo de peça.
  Mesma linha da listagem: mesmo workspace, mesmo ciclo de vida e **mesma política de
  segredo** (a listagem de processo sigiloso é gravada e as peças ficam `sigilo`;
  os atos seguem a mesma regra, não há exceção própria). Sem retrocarga, de
  propósito: listagem anterior à 0.36.0 tem `atos` nulo, `todasAsMovimentacoes:
  false`, e a Pasta diz "atualize as peças para carregar todas as movimentações"
  com o botão do fluxo "Atualizar" — nunca tela vazia, nunca consulta por conta
  própria. **Junção:** `linhasDaPasta.ts` (puro) separa os atos sem peça (nenhuma peça
  da listagem aponta para o identificador dele), intercala-os às peças pela posição
  (a ordem das peças da lista é mantida; ato com várias peças continua em várias
  linhas) e `GET …/pasta` devolve `atosSemPeca`, `lacunas` e `linhas` (a ordem). O
  identificador interno nunca sai. Identificador REPETIDO na resposta marca
  `vinculoIncerto`: a linha diz "Peça não vinculada", não "Sem peça" — afirmar
  ausência de peça sem saber é a mesma confusão de "não existe" × "não consegui
  ver". **Tela:** "M linhas" inclui as sem peça ("X de M linhas · P peças · S sem
  peça"); o chip "Sem peça (N)" FILTRA (não marca nada); "só disponíveis" esconde as
  sem peça e a contagem diz quantas; Todas/Nenhuma/Baixar PDF/Montar atuam só sobre
  peças; a busca casa descrição e número das sem peça (não o rótulo genérico
  "Movimentação"). **Lacuna de numeração:** `lacunasDeNumeracao` só afirma quando os
  dois atos vizinhos têm número EXATO e o número salta mais de 1 ("nº 368 · ato não
  recebido do tribunal (provavelmente bloqueado)"); nunca em faixa, estimado ou
  posição; o marcador não é linha (não conta, não abre, não tem foco) e só aparece
  sem filtro — a contagem diz quando ficou de fora. Largura da lista:
  `clamp(440px, 32vw, 520px)` (era 400 px), com o divisor arrastável de antes; sem
  virtualização (1.000 linhas medidas em ~1 s, teste de navegador).
- **A lista da Pasta não exibe índice sequencial; o número exibido à esquerda é
  sempre o da movimentação** (v0.35.2), nos formatos `386`, `380–381`, `~386` ou a
  posição, e "—" quando não há número — nunca o índice (que segue como chave
  interna de ordenação). O cabeçalho do visualizador é "Mov. N · rótulo". Vale a
  regra do número: nunca `identificadorMovimento`, nunca "oficial", aviso do topo
  enquanto houver número não exato.
- **O "há N dias" da lista de Atualizações é a detecção, nunca a data do ato; a
  tela diz "detectado há"** (v0.35.2). O cartão "Pedem providência" fala em "ato
  que pede providência", nunca em prazo.
- **Atualizações mostram só o TRECHO do texto do ato** (v0.35.1) — **SUBSTITUÍDO na v0.46.0:** a célula
  Atualização não traz mais trecho nenhum, ver o item da v0.46.0 mais abaixo (`ui/trechoDeTexto.ts` foi
  removido). A decisão histórica era: ~220 caracteres, em limite de palavra, só a exibição encurta; dado e API
  seguem inteiros e nenhuma atualização some.
- **Atualizações: uma linha por processo, janela de 15 dias** (v0.32.1; desde a v0.37.3 a janela é filtro opcional, desligado por padrão, e a aba lista todos os processos; desde a v0.37.0 a linha é uma linha de TABELA, ver a regra da v0.37.0,
  `NOVIDADES_JANELA_DIAS`). A tela diz quantas atualizações mais antigas ficaram de
  fora da janela e oferece "Todas" (o "+N anteriores" da v0.32.1 saiu na v0.37.1). A janela
  decide pela hora em que o sistema PERCEBEU (`detectadaEm`), nunca pela data do
  ato — a primeira varredura de um processo antigo detecta atos de meses atrás.
  `exigeAcao` só marca; o único critério que tira atualização da tela é o tempo.
- **A página inicial é uma TABELA, uma linha por processo; filtros com contador
  substituem os cartões; o histórico de peças baixadas vive na Pasta** (v0.37.0).
  Saíram os quatro cartões e a coluna "Peças baixadas" (a tela não usa mais
  `cards` nem `pecasBaixadas` de `GET /v1/painel`; a rota segue devolvendo os dois,
  e nenhum dado foi apagado). Regras que ficam: (1) os filtros de Situação contam
  **processos**, sobre a base já escolhida (período + tribunal) — "Não lidas" é
  processo com atualização ainda não vista; "Pedem providência" é `estadoDaPasta ===
  'PROVIDENCIA'`, a MESMA regra e a MESMA janela do selo da carteira (o servidor a
  entrega pronta em `grupos[].processo.pedeProvidencia` e a janela em
  `pendenciaJanelaDias`; a tela nunca escreve o número), e o texto do filtro nunca
  fala em prazo; (2) a tela só ordena, filtra por escolha da pessoa e pagina, e
  **diz quantos ficaram de fora** ("Mostrando X de Y processos", "N atualizações mais
  antigas não mostradas · Ver todas") — `exigeAcao` continua só marcando; (3) **Partes e Classe vêm do retrato que o acompanhamento já
  guarda** (`processo.partes` do DJEN, `processo.classe` do DataJud): sem consulta nova
  ao tribunal, sem migração, sem dedução do texto de peça — fonte que não trouxe
  mostra "—", e um polo só mostra "A × —", nunca "A × B" inventado; (4) "Data do ato"
  e "Detectado" são colunas separadas e rotuladas, e a janela de 15 dias decide por
  `detectadaEm`; (5) **o estado dos filtros, da página e da ordenação vive na página
  (variável do módulo), nunca em `localStorage`** — recarregar volta ao padrão;
  (6) as regras puras (contar, filtrar, ordenar, paginar, texto
  das partes) moram em `ui/tabelaAtualizacoes.ts` e vão ao navegador por `toString()`,
  como `descricaoDoAto`: o teste exercita a MESMA função — por isso cada uma é
  autocontida; (7) `script.ts` não cresceu (encolheu): a tela mora em
  `ui/atualizacoes.ts` + `ui/estilosAtualizacoes.ts`. Em 1024–1279 px a lateral de
  256 px come a largura e a coluna Classe vira linha sob o Tribunal; abaixo de 1024
  cada processo é um bloco empilhado. O texto de apoio da tela usa `--tinta2` (o
  `--tinta3` global mede 4,2:1). **Histórico de peças baixadas na Pasta:** botão
  "Peças baixadas" abre uma gaveta (`ui/scriptPastaBaixadas.ts`) com rótulo, tamanho,
  data e hora e "há N dias", SÓ do processo aberto (`GET /v1/pecas-baixadas?numero=`,
  isolado por workspace e por processo, só metadado). É o registro dos downloads
  AVULSOS pela linha do tempo — a peça aberta pela Pasta tem o estado dela na lista —,
  diz que o arquivo não fica guardado ali e não oferece baixar de novo (seria outra
  consulta com a senha do advogado). "Abrir pasta" na tabela pede a Pasta
  (`pedirAbertura`, validade de 60 s e um processo só) e a Pasta abre quando a tela
  do processo desenha o botão dela.
- **A busca por número da aba Atualizações respeita os filtros e diz quantos casam fora deles** (v0.41.0).
  Só o número do processo (dígitos, por trecho, a partir de 4 dígitos; abaixo disso não filtra nem avisa) —
  nunca parte, classe, tribunal nem texto do ato; uma linha por processo continua, as atualizações anteriores
  seguem em "Abrir processo". Combina com Situação, Período, Tribunal e ordenação, e **nunca diz "nada
  encontrado" quando o processo existe em outro filtro**: uma frase por motivo, só se o número for maior que
  zero, cada uma com "Ver" que desfaz AQUELE filtro e mantém a busca (mesma regra de "mostrando X de Y"). Processo
  fora por mais de um motivo conta UMA vez, no primeiro da ordem Situação, Período, Tribunal. Situação só se
  afirma sobre quem o navegador tem (Período e Tribunal são filtrados no servidor); dos de fora a tela só tem o
  número — `numerosForaDaJanela` e `numerosEmOutroTribunal` em `GET /v1/novidades`, só números, da própria conta,
  vazios sem filtro — e a Situação deles aparece depois do "Ver". O campo mora FORA da área redesenhada (`#nvt-barra`
  e `#nvt-corpo`): digitar nunca perde foco nem cursor. O termo vive na página (nunca `localStorage`); a regra pura
  está em `filtrarPorNumero` e `contarForaDosFiltros` (`ui/tabelaAtualizacoes.ts`).
- **A tabela não tem "+N anteriores" nem aviso de anterior; "Detectado" é enxuto; a
  descrição do ato perde a repetição só na EXIBIÇÃO** (v0.37.1, decisão do dono). (1)
  Cada processo é UMA linha com a atualização mais recente e mais nada: saíram o
  expansor, a lista de anteriores, o "mostrar mais 20" e o "há anterior que pede
  providência". A regra de ouro ficou em UMA frase no nível da página ("Cada processo
  mostra a atualização mais recente. As anteriores estão no processo: clique no número." desde a v0.49.4), sem
  contagem por processo, e só aparece quando algum processo da lista tem mais de uma
  atualização no período; a mensagem "N atualizações mais antigas não mostradas (fora
  dos últimos 15 dias) · Ver todas" continua. "Não lida" (atualização não vista do
  processo) e "Pede providência" (`estadoDaPasta`, janela de 10 dias) não mudaram.
  (2) **`GET /v1/novidades` não envia mais as anteriores:** `grupos[].anteriores`
  saiu e entrou `grupos[].quantidade` (atualizações do processo no período); `novidades`
  (achatado) traz só a mais recente de cada processo. `total`, `naoVistas` e
  `foraDaJanela` continuam contando ATUALIZAÇÕES, então os contadores não mudam —
  um processo com 300 atualizações trafega 1 item. (3) A coluna "Detectado" mostra só
  "hoje" / "há 1 dia" / "há N dias"; a frase completa ("detectado há 11 dias") vai no
  `title` e em texto para leitor de tela, e no empilhado do celular o rótulo vem do
  `data-rotulo`. (4) **`descricaoDoAto`** (`domain/entities/descricaoDoAto.ts`, pura e
  autocontida, injetada por `toString()`): `A — A - detalhe` vira `A - detalhe` e
  `A — A` vira `A`, comparando sem caixa, acento e espaço repetido; nunca corta,
  resume ou reescreve além disso. É usada na lista da Pasta (peças e movimentações
  sem peça), no cabeçalho do visualizador e no título da atualização na tabela. **O
  original continua no `title`/tooltip, na busca (casa com o original e o enxuto),
  nos dados guardados e na API** — nada muda no banco nem no contrato.
- **A classe é normalizada SÓ na exibição; o original fica no `title`, no banco e na
  API** (v0.37.2). `nomeDaClasse` (`domain/entities/nomeDaClasse.ts`, pura e
  autocontida, injetada por `toString()` como `descricaoDoAto`) faz `PROCEDIMENTO COMUM
  CíVEL` (DJEN) e `Procedimento Comum Cível` (DataJud) terem o mesmo texto; vazio é "—",
  classe nunca se inventa. Há UMA função: o `titulo()` do console saiu. Montagem em um só
  lugar por tela (`classeDaLinha` em Atualizações, `tabelaDaCarteira` em Meus processos).
  **Facetas agrupadas:** `GET /v1/facetas` devolve uma opção por classe normalizada e o
  filtro `classe` casa com todas as grafias cruas que normalizam igual
  (`variantesDaClasse`), sem migrar dado. **Coluna Classe de Atualizações:** 12,5% da
  largura, palavras inteiras (`overflow-wrap: break-word`), até 2 linhas; o que passar
  vira reticências e o `title` tem a classe toda — o teste de navegador mede em 1920,
  1366 e 1280 px. **Meus processos não tem rodapé "N de N":** sem filtro o subtítulo diz
  o total; com filtro só o aviso "Mostrando X de Y" conta (Y sem filtro) — a contagem não
  se repete na aba (a da lateral, `cont-processos`, é o mesmo total sem filtro).
- **A aba Atualizações ABRE no filtro "Pedem providência"; "Todas" está a um clique**
  (v0.37.4, decisão do dono, opção A — EXCEÇÃO registrada à regra "filtro nasce
  desligado"). Não contradiz "triagem ordena, nunca esconde": o filtro é escolhido pelo
  POSITIVO (`estadoDaPasta === 'PROVIDENCIA'`, a mesma regra e a mesma janela de 10 dias
  do selo), a frase "Mostrando m de N processos acompanhados: só os que pedem providência
  · Ver todos" está sempre à vista (sem "Ver todos" quando m = N), m = 0 mostra o bloco
  "Nenhum processo pede providência agora." com a saída, e `exigeAcao` continua só
  marcando. O período segue desligado por padrão. A escolha vale na sessão (variável da
  página, nunca `localStorage`); recarregar volta ao padrão (`SITUACAO_PADRAO` em
  `ui/tabelaAtualizacoes.ts`). O aviso "Leitura automática do andamento, não é contagem de
  prazo. Confira no processo." ficava junto do chip (SAIU na v0.46.1, ver o item da caixa em Ações). Processo acompanhado SEM movimentação
  conhecida não tem dado para ser lido: não conta como providência e a tela diz quantos
  ficaram fora do filtro (`contarSemLeitura`) — nunca se inventa providência. Eventos de
  calendário NÃO entram como critério (fora de escopo). Menu lateral e `/v1/painel` não mudam.
- **Atualizações lista TODOS os processos acompanhados; o período é filtro opcional,
  desligado por padrão; o estado de verificação é por conta** (v0.37.3, decisão do
  dono; substitui a "janela de 15 dias" que escondia por padrão). (1) A aba só listava
  processo com novidade, e a primeira sincronização guarda o retrato SEM gerar novidade
  (regra que não muda): o processo recém-acompanhado sumia sem aviso — "triagem ordena,
  nunca esconde" aplicada a PROCESSO, não só a ato. `GET /v1/novidades` ganhou dois
  campos e nenhum mudou: `semNovidade` (acompanhados sem novidade registrada, com a
  `ultimaMovimentacao` do retrato; vazio com `naoVistas=true`, porque "sem novidade"
  só se afirma sobre a lista completa) e `processosForaDaJanela`. **Nenhuma novidade
  falsa é criada**: a linha é lida do retrato, sem consulta ao tribunal, sem migração e
  sem retrocarga. (2) A linha sem novidade mostra a última movimentação conhecida (mesma
  `descricaoDoAto` e mesmo trecho), "Detectado" = "—" ("sem detecção registrada"),
  situação vazia — só "Pede providência" pelo `estadoDaPasta`, como na carteira — e, sem
  movimentação, "Nenhuma movimentação conhecida". **Segredo de justiça: rótulo e data,
  nunca o texto do ato** (o servidor nem o envia). Ordem padrão: com atualização
  detectada primeiro, depois os demais pela data do ato; data ausente vai para o fim em
  qualquer direção. (3) O período ("Últimos 15 dias") nasce desligado; ligado, a tela
  diz quantos PROCESSOS tirou ("N processos sem atualização nos últimos 15 dias · Ver
  todos"), e o console só pede a janela quando a pessoa a liga. As regras puras
  (`montarLinhas`) ficam em `ui/tabelaAtualizacoes.ts`. (4) **"Verificando agora" é DA
  CONTA.** `ServicoAcompanhamento.estadoDa(workspace)` deriva o estado dos processos
  daquela conta ainda pendentes na rodada (a varredura global enche e esvazia o
  conjunto item a item); `GET /v1/sincronizacao` e `verificacao` do painel devolvem só
  `{ emAndamento, pendentes, desde, demorando }` — **nenhum número da fila global e
  nenhum dado de outra conta**. `POST /v1/sincronizar` (`solicitar`) nunca dispara uma
  segunda verificação da mesma conta e não dá 409 por varredura alheia: espera a vez
  (continua UMA varredura por vez no processo, por causa da cota do CNJ). Passados 5
  minutos (`LIMITE_VERIFICACAO_DEMORADA_MS`) a conta está `demorando` e a tela para de
  girar e diz que as fontes estão lentas. Falha no meio da fila não deixa a conta
  "verificando" para sempre (o conjunto é limpo no `finally`).
- **Fonte nova no retrato NÃO despeja o passado como novidade** (v0.37.5, a
  "avalanche"). A vigilância por OAB grava o processo só com o DJEN; na primeira
  varredura regular o retrato vira DataJud+DJEN e `detectarNovidades` tratava a linha
  do tempo inteira do DataJud como nova (log real: 892 novidades em 4 processos, ato
  de 2024 "detectado há 2 dias"). A regra (em `detectarNovidades`, então vale para as
  três portas de entrada): movimentação de uma fonte que o retrato ANTERIOR não tinha
  (`procedencia.provider` separado por `+`, `fonte` do andamento) e anterior ao ato
  MAIS RECENTE que o retrato anterior já conhecia é linha de base, não novidade —
  ato posterior a ele continua avisando (na dúvida, avisa; é o caso da publicação do
  DJEN que chega a um processo que só tinha o DataJud). Retrato anterior sem nenhum ato
  usa o início do dia da consulta. Cobre também fonte que cai e volta (o
  retrato é regravado só com a outra). Não há campo novo de "completude": a procedência
  já é essa informação, e um campo a mais seria uma segunda verdade para manter em
  sincronia. A unicidade das novidades não mudou e **nada foi apagado**: o que a
  avalanche já gravou fica, e o reparo é uma ferramenta do operador — `npm run cli --
  novidades reparar` é **dry-run por padrão** (só conta, por workspace, sem número de
  processo); `--aplicar` apenas marca como lidas as novidades ANTIGAS de lotes
  suspeitos (nunca apaga; um ato recente no meio do lote continua não lido) e grava os
  `id` para `--desfazer <arquivo>`. Quem decide aplicar é o dono.
- **Intimação/citação do Diário pede providência por 30 dias ou até o "cumprido"**
  (v0.37.5). O DJEN informa `tipoComunicacao`; o mapper guarda SÓ o tipo em
  `Movimentacao.tipoComunicacao` (a data é a de disponibilização e o id da comunicação
  já é o `idExterno`) — sem texto a mais, sem migração de esquema, preenchido na
  próxima sincronização. `tipoDaComunicacao()` classifica intimação / citação / outro
  (pelo começo da palavra: "Edital de citação" é edital) e `triar` marca esses atos
  `exigeAcao` mesmo como "Ato ordinatório". A janela deles é
  `PENDENCIA_INTIMACAO_JANELA_DIAS` (30); os demais atos seguem em 10. **Não é prazo**:
  o sistema não sabe quanto tempo o ato deu (a "data limite" do Projudi não chega por
  fonte nenhuma que usamos; `consultarAvisosPendentes` do MNI devolveu 50 avisos — 49
  `VIS` — para uma tela de 10 e nenhum campo de prazo, então NÃO é a fonte desta lista).
  Vencida a janela sem marca, o processo sai do filtro, continua em "Todas" e a tela diz
  quantos saíram ("N sem marca há mais de 30 dias") — sumir calado seria perder o ato.
- **"Cumprido" é por ATO, e ler não é cumprir** (v0.37.5). A marca vive na linha de
  `acompanhamentos` (`cumprido_chave`, `cumprido_ate`, `cumprido_em`, `cumprido_por`;
  migração aditiva, sem retrocarga: ninguém marcou, NULL é a verdade) e guarda a chave
  do ato (`chaveDaMovimentacao`) e a data dele: **cobre os atos até aquela data,
  inclusive** (o DJEN só dá o dia: ato do mesmo dia fica coberto); ato posterior que
  exija ação volta a pedir sozinho. Só atos que de fato pedem providência podem ser
  marcados, o ato vem da tela (não o escolhemos no servidor) e a marca nunca recua.
  NÃO toca a detecção de novidades nem a "não lida". Rotas `POST`/`DELETE
  /v1/acompanhamentos/:numero/cumprido` (Zod; isolamento por workspace; a resposta traz
  o `processo` recalculado, então a tela não recarrega a lista); `GET /v1/novidades`
  ganhou `processo.providencia` (`situacao` `pede`|`cumprida`|`venceu`, `motivo`
  {rotulo, data, chave, tipo}, `cumpridoEm`) e `pendenciaIntimacaoJanelaDias` — aditivo.
  `estadoDaPasta` usa a marca, então a carteira e o painel concordam com a tela. **Tela:**
  o selo se calcula sobre o retrato inteiro; desde a v0.37.6 a linha mostra o PRÓPRIO ato
  que gera a providência (a "Pede providência por:" saiu) e o último andamento, se for
  outro, vai em "Último andamento: …" (rótulo e data, nunca texto de ato nem prazo;
  segredo de justiça mostra só isso). O chip conta
  só os que AINDA pedem; "N marcados como cumpridos · Ver" lista os marcados. **A forma de
  marcar e desmarcar é a da v0.43.0 (item "Situação como texto", logo abaixo):** a caixa
  "Cumprido" e o aviso "Desfazer" substituíram o botão e a confirmação na célula. Ação num
  componente só, `ui/providencia.ts` (`window.__pvProvidencia`). Foco: depois de marcar vai ao
  vizinho; `aria-live` discreto.
  **Hoje só a tabela de Atualizações tem o controle**: a Pasta não tem selo de providência
  e a tela do processo não mostra bloco de providência desde a v0.41.1.
- **A caixa "Cumprido" mora na coluna Ações, sem coluna própria; sem o selo "outro destinatário" e sem a frase fixa sob o filtro** (v0.46.1, decisões do dono; só apresentação —
  detecção, regras e chamadas de "cumprido", `/v1/novidades`, `/v1/painel` e a busca não mudaram). (1) A coluna "Cumprido" da v0.46.0 deixou de existir: a caixa é o PRIMEIRO controle
  de `td.c-acoes` (antes de abrir, pasta e "Analisar com IA"), desenhada por `__pvProvidencia.celula`; linha sem providência não tem caixa e leva só uma vaga (`sit-vaga`, `aria-hidden`)
  para os ícones ficarem alinhados. No empilhado (< 1024 px) o rótulo "Cumprido" aparece ao lado da caixa. (2) **Partes ganhou a largura da coluna extinta** (1920 px: 315 px; Atualização, a
  coluna "auto", 332 px) e quebra em palavras, até duas linhas, antes de cortar. "Nome acessível e `title`" seguem com o texto inteiro. (3) **"Não lida" e "sem marca há mais de N dias" passaram
  para o fim da célula Atualização** (`selosDaLinha`). (4) **O selo "Intimação a outro destinatário" NÃO existe mais na linha. O filtro `outros` continua** e é explicado pela frase "N com
  intimação a outro destinatário · Ver" (com `title`) e pelo resumo da lista aberta pelo "Ver"; a regra "o processo nunca sai do alcance sem a frase e o Ver" (v0.37.6) segue valendo, só a
  terceira peça (o selo na linha) saiu. (5) **A frase fixa "Leitura automática do andamento, não é contagem de prazo. Confira no processo." saiu de baixo do filtro de Situação**
  (isto SUBSTITUI o que a v0.37.4 dizia sobre ela ficar junto do chip). "Confira no ato completo" continua em `title`: no chip, no cabeçalho Ações e na etiqueta Intimação/Citação — a
  triagem exibida segue acompanhada dele, só não mais por texto sempre visível. A palavra "prazo" continua fora do texto da tela.
- **A coluna Situação mostra o estado como TEXTO e a caixa "Cumprido" é o ÚNICO controle** (v0.43.0; **o texto de estado saiu na v0.46.0 e a coluna passou a se chamar "Cumprido", só com a caixa — ver o item da v0.46.0 logo abaixo; o resto deste item segue valendo: caixa real, otimista com reversão, aviso "Desfazer" de 6 s, mesmas rotas**,
  decisão do dono; só apresentação e controle: a regra de "pede providência", a de "cumprido", as
  rotas e as contagens são as de antes). (1) **Estado = texto, nunca botão:** "● Pede providência"
  (âmbar), "✓ Cumprido" (verde discreto, linha um pouco mais apagada: só o título perde peso, nada
  some e o contraste não cai) e "—" (sem providência); sem fundo, sem borda, sem hover de clique;
  ícone e texto sempre juntos (não depende de cor); texto nos tons `--atencao` e `--verde-tinta`,
  4,5:1 nos dois temas (axe). Os outros avisos da célula (não lida, "sem marca há mais de N dias",
  "intimação a outro destinatário") seguem abaixo do estado. A decisão de qual estado e se há caixa é
  `situacaoDaLinha` (`ui/tabelaAtualizacoes.ts`, pura): caixa só com ato marcável (`pede` com chave) ou
  já cumprido (para desmarcar) — nunca se inventa chave. (2) **Caixa = `<input type="checkbox">` real**
  com `<label>` visível "Cumprido", alvo de 32 px (44 px abaixo de 1024), foco visível, Espaço, nome
  acessível "Cumprido: processo …". Marcar e desmarcar chamam as MESMAS duas rotas de antes (`POST` com
  `{ chaveDoAto }`, `DELETE`), pelo `prov().marcar/remover`; **desmarcar a caixa é o desfazer** (a
  confirmação "Sim, desfazer" e o botão "Marcar como cumprido" saíram). (3) **Otimista com reversão:** a
  linha muda na hora (`pintarOtimista`); lista, contadores e filtros se refazem quando o servidor
  responde; na falha, o redesenho devolve a linha ao que os dados dizem e a tela diz "Não foi possível
  salvar. Tente de novo." (só o 409 acrescenta a mensagem do servidor, porque o ato que saiu do retrato
  não se resolve repetindo). Uma segunda mudança na mesma linha durante o salvamento é ignorada.
  (4) **Aviso "Marcado como cumprido. Desfazer"** por 6 s (`TEMPO_DO_AVISO_MS`), em `role="status"`,
  FORA da tabela e da área redesenhada, sem prender o foco (Esc fecha; se o foco estava nele, vai à
  caixa); o "Desfazer" é um botão e faz a mesma chamada de desmarcar. Teste: relógio falso do
  Playwright, nunca espera real. (5) A coluna Ações não mudou (abrir, pasta, "Analisar com IA"). Nada
  de "prazo" em texto novo. `script.ts` não cresceu.
- **Tabela de Atualizações mais limpa: Atualização em UMA linha, datas estreitas, coluna "Cumprido" só com a caixa e a dica** (v0.46.0, decisões do dono; só
  apresentação e controle — detecção de "pede providência", regras de "cumprido", `GET /v1/novidades`, `/v1/painel`, calendário, Pasta, IA e a busca
  não mudaram). (1) **Atualização = tipo do ato (negrito) + etiqueta (Intimação/Citação) + link "Abrir processo"** (e "Último andamento" quando o ato
  da linha é outro). O trecho transcrito saiu da TABELA: era montado só por `notaDoAto` em `ui/atualizacoes.ts` (via `trechoDeTexto`, que foi removido) e
  nada mais o consumia. **Nada foi apagado:** `conteudo` segue no retrato e na API; o texto do ato continua na tela do processo, na Pasta e na análise por
  IA (que lê o ato do servidor). O link aparece em TODA linha (antes só quando o trecho cortava). (2) **"Data do ato" e "Detectado" têm largura fixa**
  (5,25 rem; 4,75 rem em 1024–1279 px), medida para `dd/mm/aaaa` e "há N dias" sem quebra; Atualização é a coluna `auto` (fica com o resto) e Partes ganhou
  espaço; há teste que fixa "sem quebra", "Atualização e Partes não menores que antes" e "sem rolagem horizontal" nas seis larguras. (3) **Coluna "Cumprido"
  (antes "Situação"): só a caixa, sem texto de estado.** A caixa existe onde há providência (desmarcada) ou cumprida (marcada, para desmarcar); sem
  providência a célula não tem caixa nem traço — a presença da caixa É o sinal. Os selos de outra informação (Não lida, "sem marca há mais de N dias",
  "Intimação a outro destinatário") continuam na célula: cada um é a saída de um filtro. "Pede" sem chave de ato (servidor antigo) mostra a caixa
  DESABILITADA, para o sinal não sumir sem inventar chave. Linha cumprida: caixa marcada e título mais apagado (`--tinta2`, ≥ 4,5:1 nos dois temas).
  (4) **A dica** (`role="tooltip"`, `aria-describedby` na caixa, nunca só `title`): desmarcada "Pede providência. Marque quando cumprida."; marcada
  "Cumprida. Clique para desmarcar."; aparece com mouse e foco, some com Esc (sem tirar o foco), não recebe o mouse, fica abaixo da caixa e não aumenta
  a linha. Ancora à direita da caixa (a coluna fica na ponta da tabela; ancorar à esquerda criava rolagem horizontal em 1024 px). **Toque:** a dica aparece
  depois de marcar/desmarcar (o foco volta à caixa) e, no empilhado, o rótulo "Cumprido" já vem acima da caixa; não há "tocar e segurar". O cabeçalho tem
  `title` com "leitura automática… confira no ato completo" (a triagem nunca sem essa frase). (5) **Módulo isolado para o futuro (categorias escolhidas
  pelo advogado, NÃO implementadas — sem tabela, rota nem campo):** tudo o que a coluna sabe sobre "cumprido" mora em `ui/providencia.ts`
  (`__pvProvidencia`: `celula`, `pintar`, `ligar`, `marcar`, `remover`); a tabela só entrega `situacaoDaLinha` e escuta `change` em `[data-cx]`.
- **Conferir com o Projudi: a sonda, a linha do ato da providência e o destinatário**
  (v0.37.6). (1) **`scripts/diagnostico-providencia.mjs` é SOMENTE LEITURA**: abre o banco
  com `readOnly` e `query_only` e **nunca por `abrirBanco`** (que cria esquema e migra),
  não usa rede, não lê senha nem XML, recusa rodar sem `--workspace` quando há mais de um,
  mascara os números sem `--mostrar` e só grava em `os.tmpdir()` uma tabela de contagens e
  booleanos. Ela usa a MESMA `estadoDaPasta` da rota — as regras não se reescrevem para
  explicar — e avalia, um a um, os predicados do filtro da tela (acompanhado, tribunal,
  Período por `detectadaEm`, Situação). Um processo que pede providência e some do filtro
  SÓ pelo Período é o sintoma típico de "pendente e nunca detectado": a primeira
  sincronização guarda o retrato sem novidade, e o Período decide pela detecção. (2) **A
  linha fala do ato que gera a providência** (`atoExibido`): rótulo, selo, data e, só
  quando é a própria atualização, o trecho; o último andamento, se for outro, vai em
  "Último andamento: …". Antes a linha mostrava um ato e o selo vinha de outro, e a coluna
  "Data do ato" contradizia o "Pede providência por". Ordenar por "Data do ato" usa a data
  exibida. O "Detectado" mostra a data absoluta quando está a mais de 7 dias do ato — o "há
  2 dias" sozinho parecia ato novo —, sem tocar na ordenação nem em `detectadaEm`. (3)
  **Intimação de outro destinatário não é intimação para quem acompanha.** O DJEN informa os
  advogados da comunicação (nome, OAB, UF) e a consulta por número devolve também as
  dirigidas à outra parte. O mapper deixa as inscrições EM MEMÓRIA
  (`Movimentacao.destinatariosOab`, transitório) e `comIndicadorDeDestinatario` — o ponto
  único das cinco gravações, por fora do decorator do calendário — as troca por
  `paraOUsuario` (`sim` | `nao` | `desconhecido`) comparando com as OABs do workspace (a do
  cadastro e as das vigilâncias, `OabsDoWorkspace`). **Inscrição de terceiro NUNCA vai ao
  banco nem à API** (`serializarProcesso` as tira; só o cache em memória as preserva, porque
  a sincronização que lê dele precisa delas; `Processo.toJSON` as tira). Sem OAB cadastrada
  ou sem advogado legível na comunicação é `desconhecido` — nunca "de outro" — e mantém o
  comportamento anterior. `nao` volta à regra comum do ato (não pede mais "por intimação"),
  e a tela DIZ: "N com intimação a outro destinatário · Ver", o selo na linha (SAIU na v0.46.1) e a lista.
  **`nao` é cálculo por inscrição e pode errar** (um sócio do escritório com outra OAB não
  cadastrada aparece como `nao`): por isso o processo nunca sai do alcance sem a frase e o
  "Ver", e o texto manda conferir no processo. Sem retrocarga: o dado só existe na
  comunicação que a próxima sincronização trouxer; resposta sem inscrições não apaga o que
  já se sabia. Nada aqui é prazo: o Projudi mostra "Possível Data Limite" e o sistema
  continua sem informá-la.
- **A tela do processo NÃO tem bloco "Pede providência" nem "Última movimentação"**
  (v0.41.1, decisão do dono). Repetiam o cabeçalho do tribunal e não serviam para
  entender o ato — isso se faz na Pasta digital. Ordem: cabeçalho → Peças do processo →
  Partes → Linha do tempo. Saiu só a APRESENTAÇÃO: a detecção, o selo e o filtro de
  Atualizações, o "cumprido" e as contagens são os mesmos, e a linha do tempo segue
  marcando todo ato que pede providência (selo e chip "Pede providência"), então sair do
  topo da tela não é sumir. Não reintroduza um resumo de providência no detalhe sem decisão
  do dono; `tests/browser/detalhe-limpo-navegador.spec.ts` fixa a ausência.
- **Análise por IA: por botão, só o texto que o sistema já tem, redigida, com
  citação verificada, ZDR falhando fechado, desligada por padrão, plano IA sem
  exceção** (v0.38.0; especificação `docs/ia-analise-do-ato-especificacao-v1.0.0.md`,
  Errata v1.1.0). (1) **Só por clique**, um ato por vez, nunca em lote nem
  automática: nada é enviado a um terceiro sem a pessoa pedir aquele ato. (2) **O
  texto vem do servidor**: o pedido carrega só a `chaveDoAto`; `ServicoAnaliseDoAto`
  lê o ato do retrato da PRÓPRIA conta, e texto vindo do cliente nunca é aceito. Só o
  que já está guardado — nada de peça, PDF ou consulta ao tribunal. (3) **Redigida
  antes de sair** (`application/politicas/redigirParaIA.ts`: nomes de parte e
  advogado, CPF/CNPJ, e-mail, telefone, OAB e número de processo viram marcadores) e
  **verificada ao voltar** (`verificarAnalise.ts`: citação tem de existir no texto
  enviado; número inventado ou expressão proibida descarta o resultado). O banco
  guarda o resultado COM marcadores, nunca o texto do ato nem os valores originais;
  os valores voltam só na resposta, da própria conta. (4) **Segredo de justiça, texto
  insuficiente (< 80 caracteres), teor indisponível (`teorIndisponivel`) e conta sem o
  plano IA não chamam o modelo** — e há teste de ZERO chamadas ao adaptador.
  "Indisponível" e "insuficiente" têm frases diferentes: uma manda abrir o processo no
  tribunal, a outra manda ler o ato. (5) **ZDR falha fechada e não tem chave de
  desligar** (nenhuma variável, nenhum degrau): toda chamada leva `zdr: true`,
  `data_collection: deny`, `allow_fallbacks: false` e `provider.only` com os provedores
  ZDR do modelo (após 429/5xx, um provedor por tentativa — v0.38.3; sem `require_parameters` nem `response_format` desde a v0.38.4); lista inalcançável, vazia ou sem provedor = nenhuma chamada;
  resposta de provedor fora do conjunto é descartada e o log leva só nomes; 4xx e
  "sem provedor" nunca geram segunda chamada sem ZDR; modelo é id real (sem `~`/`:`).
  `PROCESSOVIVO_IA_PROVEDORES_PERMITIDOS` só restringe (interseção). (6) **Desligada
  por padrão** (`PROCESSOVIVO_IA_HABILITADA=false`); ligada, o arranque exige
  `OPENROUTER_API_KEY` real (barrada por `pareceValorDeExemplo`), que nunca vai a log,
  resposta ou erro; a mensagem de erro do SDK nunca é copiada (pode ecoar o pedido). (7)
  **Apoio à leitura, não decisão**: a IA não altera "pede providência", "não lida",
  ordem, contagens, painel nem calendário — **única exceção (v0.39.0): o aviso criado
  pelo advogado, depois do clique de confirmar, ver o item do aviso no calendário**;
  nenhuma ação depende do resultado; a tela traz o aviso fixo e a palavra "prazo" só nele,
  no ponto de atenção "conferir o prazo no processo" e no bloco do aviso (prazo escrito
  no ato, prévia e confirmação). (8) **Freio de uso em memória** (limite por hora por conta, uma em
  andamento por conta, teto global baixo): reiniciar zera — o teto real de gasto é o
  limite da chave no OpenRouter. Sem cota mensal, sem cache, sem tabela de uso: clique
  repetido analisa de novo. (9) **A qualidade se mede em uso real** pelos botões Útil /
  Errado / Perigoso (sem texto livre) e se lê com `scripts/ia-avaliacoes.mjs`. A sonda
  (`scripts/sonda-ia-ato.mjs`) segue só com casos SINTÉTICOS: caso real nunca entra no
  repositório nem em log. (10) A lista ZDR e o transporte moram em
  `infrastructure/adapters/modelo/`; a sonda e o serviço compartilham a MESMA política
  (`application/politicas/`), sem duplicação.
- **Resumo do processo por IA: por clique, só o retrato da conta, UM redator, verificação
  item a item, separado do "Pede providência"** (v0.40.0, Etapa 2 da "IA como secretária"; só o
  servidor, a tela é a 0.40.1; errata v1.4.0 da especificação). (1) `POST
  /v1/acompanhamentos/:numero/resumo`, sem corpo: `ServicoResumoDoProcesso` lê os atos do retrato
  da PRÓPRIA conta (nada de peça, PDF ou consulta ao tribunal) e as MESMAS travas da análise de
  ato valem: plano IA sem exceção (`exigirPlanoIa` reaproveita `ServicoAnaliseDoAto.exigirPlano`,
  sem a lista do teste fechado desde a v0.50.0), segredo de justiça e processo sem ato com texto utilizável
  encerram ANTES de qualquer chamada ao modelo (há teste de zero chamadas). (2) **Seleção**
  (`selecionarAtosParaResumo`): providências em aberto (`atosQuePedemProvidencia`, a mesma regra e
  janela de `lerProvidencia`), os atos recentes com texto, uma linha do tempo só de títulos e a
  contagem do que ficou de fora; os números de `ORCAMENTO_DO_RESUMO` são ESTIMATIVA até se medir
  preço e contexto reais na lista ZDR. (3) **UM redator para o pedido inteiro**: o mesmo nome
  vira o mesmo marcador em todos os atos; o banco (`resumos_ia`) guarda COM marcadores, nunca o
  texto dos atos. **Não há "reabrir o último resumo"**: os marcadores dependem da ordem de
  aparição do pedido. (4) **`verificarResumo` (regras 1.0.0), item a item**: identificador de ato
  enviado, trecho no texto DAQUELE ato, número ou data presentes nele, texto que não copia o
  trecho; o item que falha é descartado e contado, expressão proibida derruba o resultado, e sem
  item de situação sobrevivente o resultado é "não verificado". (5) **Resumo e providência são
  coisas separadas**: a resposta traz `contagens.providenciasDoSistema` e `providenciasNaoCitadas`
  (atos que o sistema marca como pedem providência e a IA não citou); a IA não altera selo,
  ordem, contagem nem calendário. (6) A peça comum `ModeloComZdr` serve aos dois adaptadores:
  ZDR, lista de provedores e conferência do par modelo + provedor são UM código só — não se
  afrouxa um sem o outro. Limite de uso em memória, instância própria
  (`PROCESSOVIVO_IA_RESUMO_MAX_POR_HORA`, 6); avaliação Útil / Errado / Perigoso em `POST
  /v1/resumos/:id/avaliacao`; `ia-avaliacoes` lê `analises_ia` e `resumos_ia` em seções
  separadas.
- **Tela do resumo do processo: botão na capa, estado só na página, sem reabrir, sem criar nada**
  (v0.40.1; arquivo `ui/resumoIA.ts`, `window.__pvResumoIA`). (1) **O botão "Resumir este processo
  com IA" só existe para processo ACOMPANHADO** (nasce ao lado de `#parar`; a consulta avulsa não
  o tem) **e só com a IA disponível** — a MESMA pergunta única a `GET /v1/analises/disponibilidade`
  da análise de ato (`__pvAnaliseIA.carregar`); IA desligada = nenhum botão na página. (2) **Gancho
  mínimo em `script.ts`, que não cresceu**: `ligarBotoesDetalhe` chama `aposDesenhar(numero,
  acompanhado)` e `render()` chama `sair()` quando a tela deixa de ser a de um processo. (3) **O
  estado vive na página, enquanto a pessoa fica NESTE processo, e é apagado ao sair** (voltar, trocar
  de aba, abrir outro processo): não há "reabrir resumo anterior" — vale a regra do servidor, e o
  nada-em-`localStorage` da tela de Atualizações. O redesenho da tela do processo (a régua do
  tribunal chegando) NÃO apaga o painel nem repete o pedido: `aposDesenhar` devolve o painel e o
  botão a partir do estado em memória. (4) **O pedido não tem corpo nem `content-type`** (o Fastify
  recusa JSON vazio); a avaliação usa `POST /v1/resumos/:id/avaliacao`. (5) **Estados**: resumindo
  (aviso de "até 2 minutos" e Cancelar, que aborta a requisição e, no servidor, a chamada ao modelo),
  resultado, "Não foi possível resumir com segurança. Leia os atos." (não verificado), erro genérico,
  sem plano, limite de uso, segredo de justiça, sem texto utilizável e "não acompanha" — **toda frase
  de recusa é fixa na tela, nunca texto do servidor ou do modelo**. (6) **O resultado separa o que é
  da IA do que é do sistema**: "Situação do processo" e "Pendências segundo a IA" são blocos do
  resumo, cada item com o ato de origem (rótulo, data e tipo da comunicação vêm do RETRATO, não do
  modelo) e o trecho citado; o bloco "Pede providência" do sistema não é tocado (há teste que
  compara o HTML antes e depois). A tela diz quantos atos o sistema marca como pedem providência e a
  IA não citou, quantos atos ficaram de fora do resumo (e quantos entraram só pelo título) e quantos
  itens foram descartados na verificação — **só a contagem, nunca o texto descartado**. (7) **Link do
  ato**: leva ao andamento da linha do tempo com a mesma data e o mesmo rótulo (`.ev[data-quando]`,
  como o calendário); se ele está recolhido ou filtrado, a tela DIZ isso em vez de rolar para lugar
  nenhum. (8) **Rodapé "Gerado por IA em DATA E HORA. Confira nos atos." sem o nome do modelo**; aviso
  fixo "Apoio à leitura, não substitui a leitura dos atos nem a contagem de prazo." — a palavra
  "prazo" só aparece nele e no ponto de atenção "conferir o prazo no processo". (9) **Nada é criado**:
  nenhum aviso, evento ou marca (há teste que confere que os únicos POST são o resumo e a avaliação).
  (10) **Acessibilidade** fixada por teste de navegador: axe nos temas claro e escuro (sobre a capa e
  o painel), foco no painel ao abrir e no botão ao fechar, Esc, região `aria-live` no `<body>` (nunca
  trocada), `aria-busy` enquanto resume, sem rolagem horizontal de 390 a 1920 px.
- **Prazo do aviso: nenhuma opção de "úteis ou corridos" vem pré-marcada, e "Calcular" só ativa depois
  da escolha** (v0.40.1, fecha o pendente da 0.39.0). Quando o ato não diz o tipo, **não há tipo
  padrão**: os dois rádios nascem desmarcados e o botão "Calcular" nasce `disabled`; escolher ativa o
  botão no lugar (sem redesenhar, o foco fica no rádio) e só o clique em "Calcular" pede a prévia. A
  escolha DA PESSOA volta marcada se o painel for redesenhado; Cancelar e reabrir voltam ao estado
  limpo. Ato que já diz o tipo calcula direto, sem rádio. O servidor continua recusando `tipo_necessario`.
- **Google Drive: escopo `drive.file` ÚNICO, sentido ÚNICO, sigilo fora, só por botão, tokens no
  cofre, desligado por padrão, planos Peças e IA** (v0.42.0, decisões do dono; especificação
  `docs/drive-pecas-especificacao-v1.0.0.md`). (1) **Escopo único, nunca mais amplo:**
  `https://www.googleapis.com/auth/drive.file`, constante em `GoogleDriveAdapter` (`ESCOPO_DO_DRIVE`) e
  sem variável de ambiente — o sistema só enxerga o que ele mesmo criou, e há teste que falha se outro
  escopo aparecer em `src/`. O consentimento granular é conferido: sem a permissão da pasta a conexão é
  recusada. (2) **Sentido único:** o sistema grava. Não lista, não busca pasta pelo nome (o escopo não
  deixa, e procurar duplicaria — os ids ficam guardados), não lê de volta, não apaga, não renomeia, não
  compartilha; a porta `DestinoExternoDePecas` nem oferece esses verbos. A única leitura é "o que EU
  criei ainda existe?", pelo id guardado. (3) **Sigilo fica fora:** peça com `nivelSigilo > 0` e processo
  em segredo de justiça NUNCA chegam ao Drive (zero chamadas), como na Pasta digital; o resultado conta
  quantas ficaram de fora. (4) **Só por botão:** nenhum agendador, serviço ou CLI chama
  `ServicoDrive.iniciarEnvio` (há teste de grafo). Sem plano, ou com o recurso desligado, **nenhuma
  chamada ao Google** — inclusive `GET /v1/drive`, que nunca fala com o Google. (5) **Tokens no cofre
  existente** (`RepositorioDoDriveSqlite` cifra com o MESMO AES-256-GCM das credenciais de tribunal, por
  workspace); nunca em log, resposta, erro ou CHANGELOG — nenhum erro do adapter carrega texto do Google
  (só `reason` e status), e o retorno OAuth nunca põe código ou token em URL (o log de acesso guarda só o
  caminho). Renovação sob demanda, UMA por vez por workspace. O `state` é assinado, de uso único, com
  validade de 10 min e amarrado ao workspace; o retorno exige sessão (cookie `SameSite=Lax` vai em
  navegação de topo). (6) **Idempotência por (workspace, processo, peça)** com hash SHA-256: igual =
  "já estava"; hash novo = atualiza o MESMO arquivo; arquivo apagado pelo advogado (404/`trashed`) NÃO é
  reenviado sozinho — "removida no Drive", e reenviar é outro clique. Peça que já foi enviada e saiu da
  guarda de 24 h NÃO volta ao tribunal só para comparar hash: confere-se só se o arquivo existe.
  (7) **Sem consulta nova ao tribunal além da que a Pasta já faz:** peça sem registro e fora da guarda é
  pedida por `ServicoPasta.solicitar` (debounce, fila, pausa de 3 s, disjuntor) e só porque o advogado
  clicou; credencial do tribunal ausente/recusada ou bloqueio PARAM o lote, sem retry. (8) **Uma peça por
  vez, backoff LIMITADO:** 4 tentativas, `Retry-After` respeitado até 60 s (acima disso o lote para),
  3 falhas seguidas do Drive encerram o lote, Drive cheio o encerra na hora; um envio por workspace e
  `PROCESSOVIVO_DRIVE_MAX_SIMULTANEOS` no servidor inteiro. O job é em MEMÓRIA (não usa `FilaDeJobs`, que
  é do leitor e guarda índice de PDF): redeploy o perde, e clicar de novo continua de onde parou porque a
  idempotência faz as já enviadas virarem "já estavam". (9) **Desligado por padrão**
  (`PROCESSOVIVO_DRIVE_HABILITADO=false`); ligado, o arranque exige `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET` (barrados por `pareceValorDeExemplo`), `PROCESSOVIVO_URL_BASE` em https (o
  retorno é ela + `/v1/drive/retorno`) e `PROCESSOVIVO_CREDENCIAL_CHAVE`, sem nunca ecoar valor; sem a
  Pasta digital (qpdf) o Drive não sobe. Sem o SDK `googleapis`: REST com `HttpClient.requisitar`
  (cabeçalhos na resposta, `tentativas: 1` — a política de repetição é nossa). (10) **Plano:** recurso
  `salvarNoDrive` nos planos Peças e IA (retrocarga UMA vez, só nesses dois códigos, marca em `estado`);
  plano criado pelo painel não o ganha sozinho; o plano IA ficou fora de venda até a v0.50.0 (agora decidido
  por dado no /admin). (11) **Tela** (`ui/drive.ts`, `window.__pvDrive`): cartão em "Meus acessos"
  (desconectado, conectado, precisa reconectar, sem plano, e nada com o recurso desligado) e botão
  "Salvar no Drive" na Pasta, que diz o número ("Salvar no Drive (N)" / "Salvar todas no Drive"), com
  progresso, Cancelar e resumo ("12 enviadas · 3 já estavam · 2 sigilosas ficaram de fora · 1 falhou").
  Toda frase é fixa na tela; `script.ts` não cresceu. Nome do arquivo: `NNNN - Rótulo - dd-mm-aaaa.pdf`
  (`nomeDoArquivoNoDrive`), com o número do ato COMO A PASTA O MOSTRA — nunca "oficial".
  **(v0.42.1) O retorno do OAuth usa o workspace do `state` assinado, nunca o cookie.** O retorno do
  Google é uma navegação sem JavaScript: não leva `x-api-key` e a conta de chave não tem cookie. Por
  isso `GET /v1/drive/retorno` é rota pública (`ROTA_DRIVE_RETORNO`, em `rotasPublicas`) e o dono da
  conexão sai do `w` dentro da parte ASSINADA do `state` (emitido por `POST /v1/drive/conexao`, esse
  autenticado). Cookie presente de OUTRO workspace = recusado, sem gastar o `state`. A regra de plano é
  a mesma para cookie e chave (`temRecursoSemExcecao`): conta de chave só usa o Drive com assinatura.
  **(v0.42.2) O console desenha a aba mais de uma vez ao abrir, e a resposta tardia de uma aba NUNCA repinta
  outra** (`verNovidades` confere `estado.aba`; o cartão do Drive remove o anterior; a mensagem do retorno vive
  até a primeira ação no cartão) — sem isso a volta do Google podia não mostrar "conectado". O CLI é testado em
  processo (`executar` em `cli.ts`), com um único spawn de verdade.
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
  que a API não devolve (`movimentacao` traz `posicao`, `numero` — o objeto com o grau de certeza da
  v0.35.0, NUNCA o identificador interno —, `data`, `descricao`, `complemento`). (2) O **aviso de atos bloqueados é obrigatório**
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
- **O número só é EXATO quando provado por âncoras do advogado** (v0.35.0, a
  extensão da regra acima). Âncora = par (posição, número no Projudi) que o
  ADVOGADO leu na tela do Projudi; `numeroDoProjudi` (`domain/entities/
  numeracaoDoProjudi.ts`) é a função pura que decide, e a tela só mostra o que
  ela devolveu, com o rótulo: **exato** (o próprio ato ancorado, ou entre duas
  âncoras de MESMO deslocamento `d = número − posição`; antes da primeira com
  `d = 0`), **faixa** `min–max` (entre âncoras de `d` diferente, ou antes da
  primeira com `d > 0` — nunca arredondada, nunca "o mais provável"),
  **estimado** (depois da última âncora: pode haver ato novo e novo bloqueado) e
  **posição** (sem âncora, o texto da 0.34.0 com o aviso). Invariantes: `d ≥ 0`
  e não decrescente — âncora que os contradiz é recusada (400), nunca guardada;
  no máximo 50 por processo; por workspace (toda consulta filtra por ele).
  **Nunca "oficial"**, em lugar nenhum: só `exato` leva o selo "✓ conferido", e
  o aviso do topo NÃO some enquanto houver número que não seja exato.
  **Motivo (histórico, não se apaga):** a 0.33.2 mostrou o `identificadorMovimento`
  como número e foi aprovada sem conferir; a sonda e a tela do Projudi
  (04/10/2026) mostraram que o número do Projudi conta os atos bloqueados que o
  MNI não entrega; a 0.34.0 mostrou a posição com aviso, e o dono quis o número
  do Projudi — que só quem olha o Projudi sabe. Por isso o dado vem do
  advogado, não de heurística: **sem detectar bloqueado sozinho, sem DataJud,
  sem extrair "ev. 382" do texto das peças, sem consulta nova ao tribunal.** A
  âncora guarda a `dataHora` do ato (a listagem guarda a de TODOS os atos em
  `datas_dos_atos`); se numa listagem nova o ato naquela posição tem outra
  data, a âncora é descartada e a tela diz "calibração anterior invalidada" —
  número exato sobre âncora que mudou de lugar é pior que posição com aviso.
  Calibrar exige listagem com as datas (anterior à 0.35.0: recarregar as peças).
  A ação "informar nº" na linha é só para o mouse (`aria-hidden`: botão dentro
  de `option` é controle aninhado); o teclado usa a tecla N e o botão do
  cabeçalho do visualizador.
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
- **Aviso no calendário a partir da análise por IA, com calculadora de prazo: EXCEÇÃO
  REGISTRADA à regra "o calendário não calcula prazo"** (v0.39.0, decisão do dono, Etapa 1 da
  "IA como secretária"). (1) **A IA nunca escreve data.** O esquema ganhou `prazo` opcional
  (`{ dias, tipo }`, `tipo` = `uteis` | `corridos` | `null`); o prompt `ato-1.2.0` manda COPIAR o
  número que o ato escreve. `verificarAnalise` (regras 1.2.0) descarta SÓ o prazo — a análise segue —
  quando o número não está escrito no texto enviado (colado a "dia(s)", em dígitos ou por extenso),
  está fora de 1–365 ou o tipo é desconhecido. (2) **Quem calcula é o nosso código**
  (`domain/entities/prazoEmDias.ts`, pura): sábado e domingo, feriados NACIONAIS fixos (1/1, 21/4, 1/5,
  7/9, 12/10, 2/11, 15/11, 20/11 desde 2024, 25/12), Sexta-feira Santa (pela Páscoa) e o recesso de
  20/12 a 20/01. Termo inicial: publicação no primeiro dia útil depois da disponibilização, contagem a
  partir do primeiro dia útil depois da publicação (dia 1); em dias corridos, vencimento em dia sem
  expediente passa ao primeiro dia útil seguinte. **Não sabe**, e diz: feriado estadual, municipal ou
  do tribunal, ponto facultativo, suspensão por ato do tribunal, prazo em dobro, regras de juizado.
  (3) **Só roda depois do clique, só para ato do Diário** (`atoDoDiario`: `idExterno` `djen:…`, a única
  fonte com data de disponibilização); nos outros atos o botão não calcula e a tela manda criar o aviso
  manualmente. Ato que não diz úteis ou corridos: a tela pede a escolha, **não há tipo padrão**.
  (4) **Duas rotas, ambas exigem `analiseIa` E `calendario`** e nenhuma chama o modelo (o serviço nem
  tem analisador): `POST /v1/analises/:id/aviso/previa` NÃO GRAVA NADA e devolve data, premissas e o
  aviso "a conferir"; `POST /v1/analises/:id/aviso` recalcula DE NOVO no servidor (o que o navegador viu
  não é fonte), aceita a data calculada ou uma editada (formato AAAA-MM-DD, senão 400) e cria o evento
  `prazo`, dia inteiro, `origem: manual`, com a observação das premissas. Sem o clique de confirmar,
  nada nasce. (5) **Marcador `calculado`** no evento (coluna `calculado`, migração aditiva, sem
  retrocarga): o feed diz "Data calculada pelo Processo Vivo: confira no processo." Editar a data — no
  aviso ou depois, no calendário — apaga o marcador: o feed não pode dizer "calculada" de data que o
  advogado mexeu. (6) **Privacidade:** o título sai só de campos estruturados ("Prazo de 15 dias úteis
  (a conferir)"), sem texto da IA e sem nome de parte; o feed continua levando só tipo e número do
  processo (ou "sigiloso"), nunca título, observação nem trecho. Ver `PrazoNaoCalculavelError`.
- **Sincronização em pool pequeno, progresso real na tela e aviso de "demorando" só sem avanço** (v0.49.3, decisões do dono).
  (1) `ServicoAcompanhamento.executar` roda um pool de `SYNC_CONCORRENCIA` trabalhadores (padrão 3, MÁXIMO 4; inválida →
  padrão + aviso no log, nunca derruba): continua UMA rodada por vez (flag `sincronizando`), a mesma ordem da fila, 200 por
  varredura, `SYNC_PAUSA_MS` por trabalhador após cada item e limitadores/cache compartilhados — o teto por fonte NÃO muda. O mesmo
  número de processo nunca é buscado em paralelo. Fora de escopo, por decisão: disjuntor por fonte, prioridade da conta que clicou
  e mudança do cache de 15 min. (2) `GET /v1/sincronizacao` ganhou `situacao` (`ociosa|na_fila|em_andamento`), `total`, `concluidos`,
  `ultimoProgressoEm`; **`demorando` só quando nada avançou por mais de 5 min**. A tela (`ui/verificacao.ts`,
  `window.__pvVerificacao`) mostra "Verificando X de N" / "Na fila" e a região `aria-live` anuncia o X no máximo a cada 10 s. (3) Uma
  linha de log `processo verificado` por item (sem partes nem texto de ato) e a `varredura concluída` com média e concorrência.
  (4) `acompanhamentos.tentado_em` (aditiva, sem retrocarga) ordena a fila por `COALESCE(tentado_em, sincronizado_em)`: quem falha
  sempre vai para o fim; `sincronizado_em` segue sendo só o último sucesso.
- **Atualização em UMA linha na tabela, sem o link "Abrir processo"; o botão só nos cartões** (v0.49.4, decisões do dono; só apresentação —
  detecção, "cumprido", filtros, contagens, `/v1/novidades`, `/v1/painel`, verificação e IA não mudaram; **substitui** o "link Abrir processo" da
  célula Atualização das v0.46.0 e v0.49.2). (1) Na tabela (>= 1024 px) a célula é `nowrap`: ponto azul, tipo do ato (`.nvt-tipo`, com reticências
  e `title` quando falta largura), etiqueta, selo "Não lida" e o aviso "Sem atualização detectada" (pequeno, secundário, cortado com reticências e
  com o texto inteiro no `title`/DOM). Altura da linha de 48 a 56 px nos três tipos em 1920, 1366 e 1280 px. (2) **O número do processo (`a.nvt-num`)
  é o link que abre o processo, e o ícone "abrir" de Ações também; o "Abrir processo" não existe na tabela** (o botão fica no DOM com `display:none`, fora
  de tela, Tab e leitor). Nos **cartões (< 1024 px)** ele aparece com o texto e 44 px, e o selo e o aviso podem ocupar mais de uma linha; a célula
  tem `height:auto` ali (o 48px da tabela a fazia transbordar sobre a seguinte). (3) A frase acima da tabela é "Cada processo mostra a atualização mais
  recente. As anteriores estão no processo: clique no número." (4) Ordem do Tab: número, copiar, caixa "Cumprido", abrir, pasta, IA. O ponto azul é
  pseudo-elemento (não é lido) e "Não lida" é o texto lido uma vez. Teste: `tests/browser/atualizacao-uma-linha-navegador.spec.ts`.
- **E-mail do pagador informado pelo usuário e checkout que substitui a assinatura pendente** (v0.49.5, decisão do dono, depois de
  um teste real em 21/10/2026). **Por quê:** o Mercado Pago recusa o pagamento ("Seu e-mail não corresponde ao da assinatura") quando o e-mail
  de quem paga não é o `payer_email` da assinatura, e a página dele não deixa trocar. Mandar sempre o e-mail da conta do Processo Vivo
  prendia quem tem outro e-mail no Mercado Pago. (1) `POST /v1/assinatura/checkout` aceita `emailDoPagador` (Zod `.strict()`, aditivo): aparado,
  validado por `normalizarEmail` (a regra do cadastro), até 200 caracteres; ausente = o da conta; inválido = 422 `email_do_pagador_invalido` ANTES de
  gravar o aceite ou chamar o gateway, sem repetir o valor. **Esse e-mail vai ao gateway e NÃO é gravado em lugar nenhum** (cobrança, trilha, `/admin`,
  log): continua valendo a regra da v0.44.0, e há teste que procura o valor em tudo. (2) **Um checkout novo SUBSTITUI o pendente** (`substituirPendentes`):
  para cada pendente da conta, consulta o gateway; se já está `autorizada`, a conta já assinou (sincroniza e recusa `ja_assinante`, nada é cancelado);
  senão cancela (`PUT /preapproval/{id}` `cancelled`) e marca a linha `cancelada`. Falha ao consultar ou cancelar NÃO impede o checkout novo: vai à trilha
  (`gateway_falhou`, `pendente_nao_substituida`) sem dado pessoal e a linha segue `pendente` para a reconciliação, que não mudou. Nunca duas assinaturas
  vivas por conta; isolamento por workspace. (3) **Tela** (`ui/pagamento.ts`): campo "E-mail da sua conta do Mercado Pago" (pré-preenchido com
  `pagamento.emailDaConta`, a PRÓPRIA conta, só para isso), na confirmação e no aviso "Seu pagamento não foi concluído?" com "Tentar de novo" quando há
  pendente; a conferência automática não refaz a tela com o foco no campo. A volta do Mercado Pago (`back_url`) continua só um indicador. (4) A Política de
  Privacidade fala em enviar "o seu e-mail"; passa a ser "o e-mail que você informar para o pagamento" (texto do dono, fora do repositório).
  **(v0.49.6) Os textos do checkout não sugerem conta no Mercado Pago:** o rótulo é "E-mail para o pagamento" e a ajuda diz que não é
  preciso ter conta para pagar com cartão (o que o Mercado Pago exige é o MESMO e-mail na página de pagamento). Mantêm-se as frases que só
  dizem que o pagamento é processado pelo Mercado Pago. Há teste que falha se "conta do Mercado Pago" voltar a `ui/pagamento.ts`.
- **Login informa que as peças valem só para o TJGO, por enquanto** (v0.50.1, decisão do dono; só texto e layout). O terceiro
  benefício do painel da esquerda ("Peças das partes", `molduraDeEntrada` em `ui/script.ts`) leva o aviso `.beneficio-aviso`:
  "Por enquanto, o acesso às peças vale apenas para o Tribunal de Justiça de Goiás (TJGO). Em breve, será estendido a todos
  os tribunais do Brasil." Dentro do texto do benefício, sem check, sem link, **sem data nem prazo** (a mesma razão de não
  prometer o que o sistema não faz hoje). O painel é o mesmo em "Entrar" e "Criar conta"; até 900 px a lista de benefícios
  inteira fica escondida e o aviso vai junto. **REMOVER o aviso (e o teste `login-aviso-pecas-navegador.spec.ts`) quando houver
  peças em outro tribunal.** Outras telas que falam de peças (cadastro de acesso ao tribunal, resumo do plano Peças) não
  foram alteradas: replicar o aviso ali é decisão do dono.
- **Centro de custos do processo: valores sempre em centavos inteiros, custos independentes do acompanhamento, PDF que
  nunca grava e nunca traz dado do processo** (v0.47.0, decisões do dono; versão 1 é MANUAL — sem receita, honorário,
  parcela, integração bancária nem comprovante). **Ampliado na v0.48.0 — ver o item seguinte, que SUBSTITUI nesta
  descrição: o "Ressarcido" por lançamento (itens 2 e 3), a lista de categorias (itens 2 e 5) e o "excluir é
  definitivo" (item 8). O resto segue valendo.** (1) **Valor é inteiro em centavos, em toda camada**: `valor_centavos
  INTEGER CHECK > 0` no banco, `valorCentavos` inteiro na API, e a conversão do que a pessoa digita (`1.234,56`,
  `1234,56`) é por TEXTO, nunca por multiplicação de decimal (`domain/entities/valorEmReais.ts`: funções puras,
  autocontidas, injetadas no console por `toString()` — o navegador, o servidor e os testes exercitam a MESMA). O
  ponto só vale como milhar (`1234.56` é recusado: adivinhar erra o valor sem avisar); teto de R$ 1.000.000,00 por
  lançamento (`VALOR_MAXIMO_CENTAVOS`). (2) **Modelo**: `custos_processo` (workspace, id, `numero` = 20 dígitos do
  CNJ, data `AAAA-MM-DD` sem fuso, descrição ≤ 200, categoria, valor, reembolsável, `ressarcido_em` opcional) e
  `categorias_custo` (workspace, id, nome único por conta SEM acento e caixa, arquivada). Lista base FIXA em código
  (`CATEGORIAS_BASE`); categoria própria tem código `c-<id>`. Chaves começam por `workspace`; lançamento de outra conta
  é 404 igual a "não existe". Limites: 500 lançamentos por processo, 30 categorias próprias ativas por conta. Categoria
  própria nunca se exclui: **arquiva** (o lançamento antigo mantém o nome; lançamento novo não a usa; criar o mesmo
  nome de uma arquivada a reativa). (3) **Totais só em `calcularTotais`**, aritmética de inteiro: gasto, reembolsável,
  ressarcido (só despesa reembolsável pode ser ressarcida; desmarcar "Cobrar do cliente" apaga o ressarcimento) e saldo
  a cobrar = reembolsável − ressarcido; a tela, a API e o PDF mostram o que ela devolveu e não refazem a conta. (4)
  **Os custos NÃO dependem de o processo estar acompanhado**: não há vínculo com `acompanhamentos`; deixar de
  acompanhar não apaga nada (o gasto existiu e a prestação de contas continua devida). Apagar a CONTA apaga tudo, pelo
  `apagarDoWorkspace` (como os demais dados por workspace; a exclusão de conta ainda não existe no produto). (5)
  **Recurso `custosDoProcesso`** no catálogo, em TODOS os planos (retrocarga única com marca em `estado`, como o
  calendário; `RECURSOS_PADRAO_DE_PLANO_NOVO` o inclui) — restringir depois é tirá-lo do plano no `/admin`. Todas as
  rotas passam por `exigir()`: conta de chave de API (sem assinatura) usa, como nos demais recursos; não há exceção. (6)
  **O PDF da prestação de contas NUNCA grava e NUNCA traz dado do processo além do número, do tribunal e do rótulo de
  cliente**: `DocumentoDePrestacao` (a porta) não tem campo para parte, texto de ato nem segredo de justiça — o que
  não está no tipo não chega ao arquivo que o advogado envia para fora. Os bytes nascem na resposta (`Cache-Control:
  no-store`), o gerador (`PrestacaoDeContasPdf`, só pdf-lib, que o leitor já usava) não importa `fs`, e o nome do
  arquivo é `prestacao-de-contas-<número>-<data>.pdf`. Leva também nome e OAB do advogado da SESSÃO (conta de chave de
  API não tem pessoa: sem a linha). Datas `dd/mm/aaaa`, moeda `R$ 1.234,56`, A4, cabeçalho da tabela repetido,
  totais inteiros na última página. Caractere que a fonte não desenha vira `?` em vez de derrubar a geração. (7)
  **Dado de custo é do cliente do advogado** (ele é o controlador): nada de valor, descrição ou nome de categoria em
  log, e-mail, erro, `/v1/novidades`, painel, calendário ou rota pública; a mensagem de `CustoInvalidoError` não
  repete o que foi enviado. (8) **Excluir é definitivo no servidor (sem lixeira)**; o "Excluído. Desfazer" de 6 s da
  tela RECRIA o lançamento com um POST (novo id), não restaura. (9) **Tela** em `ui/custos.ts` (`window.__pvCustos`;
  `script.ts` não cresceu): botão "Custos" na capa, painel que só existe no DOM aberto, lista que vira cartões abaixo
  de 1100 px, caixa "Ressarcido" com as classes `sit-*` da "Cumprido" (otimista com reversão). A dica da caixa cresce
  para a ESQUERDA (`.cust .sit-dica`): a de Atualizações cresce para a direita no empilhado e criaria rolagem horizontal.
  Teste de navegador: `tests/browser/custos-navegador.spec.ts`.
- **Centro de custos, ampliação da v0.48.0: recebimentos do cliente, quem pagou, depósito derivado do grupo, cancelar em
  vez de excluir com histórico somente de acréscimo, catálogo em dois níveis** (decisões do dono; continua um advogado só:
  **fora de escopo, não implementar:** honorários, multas, contas a pagar, vencimentos, previsto × pago, alertas, integração
  bancária, cálculo de custas, perfis, permissões, multiusuário e **eventos de depósito** — levantamento, restituição e
  conversão ficam na descrição/observação). (1) **Recebimentos** (`recebimentos_processo`, por processo, `valor_centavos`
  inteiro > 0, observação ≤ 200): substituem o `ressarcido_em` por lançamento (coluna mantida, sem uso; nada é apagado).
  **Saldo a cobrar = reembolsável − recebido, nunca negativo; o excedente é "Crédito do cliente", jamais saldo
  negativo.** `calcularTotais` segue o ÚNICO lugar que soma (despesas, pago pelo escritório, pago pelo cliente,
  reembolsável, recebido, saldo, crédito e o bloco de depósitos). (2) **`pago_por`** (`escritorio` | `cliente`): despesa paga
  pelo cliente conta nas despesas e NÃO gera reembolsável nem saldo — o servidor desliga "Cobrar do cliente" à força.
  (3) **Depósito = Grupo 08, derivado do grupo** (`ehGrupoDeDeposito`), nunca um campo solto: fica fora do total de
  despesas e dos subtotais, em bloco próprio; depósito adiantado e cobrado entra no saldo, identificado. Subcategoria
  própria com lançamentos NÃO muda entre o 08 e os demais grupos (reclassificaria totais já prestados). (4) **Cancelar em
  vez de excluir:** `cancelado_em` + motivo opcional (≤ 200); nenhuma rota nem tela apaga lançamento ou recebimento; o
  cancelado fica fora de totais, PDFs e (0.49.0) CSV, aparece só em "Mostrar cancelados" e se reativa; o "Cancelado.
  Desfazer" de 6 s só reativa o MESMO registro. **Só a exclusão da conta (`apagarDoWorkspace`) apaga, e leva junto o histórico;
  cancelados e histórico ficam guardados enquanto a conta existir e entram no backup (DEPLOY.md).** Registro cancelado não
  se edita (reative antes); o teto de lançamentos conta só os ativos e reativar o confere. (5) **Histórico**
  (`historico_custos`) é SOMENTE DE ACRÉSCIMO: o repositório só insere e lê, e grava o evento na MESMA transação da mudança;
  guarda criou/editou/cancelou/reativou e, nas edições, os campos com o valor anterior e o novo (valor, data, subcategoria,
  pago por, cobrar do cliente); texto livre (descrição, observação) vira "alterada", sem copiar o texto. Sem usuário: só há
  um por conta. (6) **Catálogo em dois níveis, Grupo › Subcategoria, com códigos PERMANENTES** (`CatalogoDeCustos.ts`):
  grupos 01–08, 11 e 12 (**não existem 09 Multas nem 10 Honorários**), 45 subcategorias pré-cadastradas FIXAS (nunca se
  apaga nem se renumera código), próprias em qualquer grupo (`c-<id>`, até 60 ativas, nome ≤ 60, único DENTRO do grupo pela
  chave `<grupo>:<nome sem acento>`; arquivam, reativam e mudam de grupo). **O catálogo é um cadastro de classificação: não
  afirma que determinada cobrança seja exigível em um processo (isso depende da lei, da tabela do tribunal e da situação
  processual) e não calcula custas.** Migração única e idempotente (`migrarCustosPara048`, marca
  `migracao:custos-0.48.0` em `estado`): categorias antigas → CUS-020, PER-001, DIL-001, ADM-001, ADM-004, DIL-010 (Publicações:
  a antiga era genérica) e OUT-001; próprias → Grupo 12; cada lançamento reembolsável ressarcido gera UM recebimento
  ("Migrado da versão anterior", id derivado do lançamento). O servidor ainda traduz os códigos antigos. (7) **PDF** (continua
  sem partes, sem texto de ato, sem gravar): categoria "Grupo › Subcategoria", "pago por", depósitos em bloco à parte,
  recebimentos, saldo e crédito; cancelados nunca aparecem. **Fica para a v0.49.0:** tela "Custos" por cliente (depende do
  rótulo de cliente, que só existe em processo ACOMPANHADO — sem ele o processo cai em "Sem cliente"; "Deixar de acompanhar"
  avisa disso), PDF consolidado, CSV e comprovantes — **tudo isso foi feito na v0.49.0, no item seguinte**.
- **Centro de custos, ampliação da v0.49.0: tela "Custos" por cliente, PDF consolidado, CSV e comprovantes no Drive**
  (decisões do dono; o mesmo escopo fechado da v0.48.0 — um advogado só, sem honorário, multa, vencimento, previsto,
  alerta, custas calculadas, perfis nem multiusuário). (1) **Cliente = o RÓTULO da pasta do processo**
  (`acompanhamentos.cliente`, lido por `rotulosDeCliente`, sem carregar o retrato). **Os custos NÃO copiam o rótulo**
  (seria uma segunda verdade para manter em sincronia): processo sem rótulo, ou que deixou de ser acompanhado (o rótulo
  mora na pasta), cai em **"Sem cliente"** — e a tela AVISA quantos processos estão assim; "Deixar de acompanhar" pergunta,
  quando o processo tem custos, antes de apagar o rótulo ("o custo não se perde"). A chave de agrupamento ignora acento,
  caixa e espaços repetidos (`chaveDoCliente`); o nome mostrado é o do processo de MENOR número daquele grupo, estável.
  (2) **Saldo e crédito são POR PROCESSO** (recebimento é por processo): o consolidado de um cliente soma inteiros que
  `calcularTotais` já devolveu (`somarTotais`) e nunca refaz a regra do saldo. Toda lista diz "Mostrando X de Y" com Y sem
  filtro; cancelado nunca entra. (3) **PDF consolidado** (`gerarConsolidado`, mesma classe e mesmo desenho do PDF por
  processo): uma seção por processo, depósitos à parte, recebimentos, totais do processo e totais gerais; sem partes, sem
  texto de ato, sem gravar. (4) **CSV** (`application/politicas/csvDeCustos.ts`): UTF-8 com BOM, `;`, vírgula decimal sem
  separador de milhar, `dd/mm/aaaa`, CRLF; coluna **Tipo** (Despesa | Depósito | Recebimento) e **Situação** (Ativo |
  Cancelado — cancelado só entra com `incluirCancelados`, marcado); **toda célula de TEXTO que começa com `=`, `+`, `-`,
  `@`, tabulação ou retorno de carro ganha um apóstrofo** (injeção de fórmula); o motivo do cancelamento e nome de
  arquivo/link do Drive nunca saem. **Sem XLSX:** não há biblioteca de zip/planilha e dependência nova está vetada.
  (5) **Comprovantes** (`comprovantes_custo`: id do arquivo no Drive, link, nome, tamanho, data): ≤ 5 por lançamento,
  PDF/JPEG/PNG, ≤ 5 MB. **O tipo vem dos primeiros bytes** (`detectarTipoDoComprovante`), nunca da extensão; o `Content-Type`
  declarado tem de bater. **O arquivo NUNCA é gravado no servidor**: o corpo binário (parser só da rota, teto de 5 MB só
  nela — sem multipart nem dependência nova) passa pela memória até `ServicoDrive.anexar`, que o envia a
  `Processo Vivo/<número>/Custos` (a subpasta usa a tabela de pastas com a chave `custos:<número>`). Valem TODAS as regras
  do Drive: só por clique, só de ida (nem lista, nem lê, nem apaga), `salvarNoDrive` + `pecas` sem a exceção do "workspace
  sem assinatura" (conta de chave de API só anexa com assinatura), `PROCESSOVIVO_DRIVE_HABILITADO`, tokens no cofre, backoff
  limitado, renovação UMA vez, autorização revogada pede reconexão sem insistir, zero chamadas ao Google quando não há
  plano/conexão. **"Remover" apaga só o vínculo** (o arquivo continua no Drive do advogado, e a tela diz). Histórico
  `anexou`/`removeu` sem nome de arquivo; **nome de arquivo e tamanho nunca vão a log**; PDF e CSV levam só "Comprovantes: N".
  O link "Abrir no Drive" só aparece para endereço do domínio do Google, em nova aba, `rel="noopener noreferrer"`. A tela
  explica o caminho em "Meus acessos" (onde mora o cartão do Drive), com frases fixas — nunca texto do servidor ou do Google.
  Telas: `ui/custosPorCliente.ts` (`window.__pvCustosCliente`, aba `custos` do menu, logo depois de "Calendário") e `ui/custos.ts`
  (comprovantes, CSV, `avisoAoParar`, `abrirPainelDe`); `script.ts` não cresceu (só linhas já existentes ganharam código).
- **Painel de Custos: ações em ÍCONES com dica e nome acessível, texto visível nos cartões, colunas de conteúdo e grade no formulário**
  (v0.49.1, decisões do dono; só apresentação — nenhuma regra, rota, total, PDF ou CSV mudou). (1) **Cada ação é um `<button
  type="button">` de verdade** (28×28 px, alvo ≥ 24) com `aria-label` próprio e SEM repetir a descrição do lançamento (a linha da
  tabela já a dá): "Editar lançamento", "Cancelar lançamento", "Anexar comprovante" / "Anexar comprovante (N anexados)",
  "Histórico do lançamento" ("…recebimento" na outra tabela; "Reativar …" nos cancelados). O ícone de cancelar é um círculo
  cortado, **nunca lixeira**: o sistema cancela e guarda, não apaga. O selo de contagem do clipe é `aria-hidden` e não muda o
  tamanho do botão. Quem acha o botão no código continua achando por `data-cust`/`data-id`/`data-tipo`. (2) **A dica é UMA só
  no console:** `__pvProvidencia.comDica` / `ligar` (`ui/providencia.ts`), a mesma da caixa "Cumprido" — `role="tooltip"`,
  `aria-describedby`, aparece com mouse e foco, Esc a fecha **sem fechar o painel** (o 2º Esc volta a fechar o que fechava), não
  recebe o mouse e não depende de `title`. Quem precisar de dica em controle novo usa `comDica`; não se desenha outra. (3) **Sem
  mouse não há dica:** abaixo de 900 px (a lista vira cartões) o texto da ação aparece ao lado do ícone e a dica some. (4) **Colunas
  de conteúdo:** data, valor, pago por, cobrar e ações em largura de conteúdo e SEM quebra; Subcategoria numa linha com reticências
  (texto inteiro no DOM, em `title` e no nome acessível — o corte é visual); Descrição até 2 linhas e só então reticências, com
  `title`. De 900 a 1439 px as colunas estreitas encolhem; a Subcategoria só vai a 2 linhas abaixo de 1280 px. Teste de
  navegador: `tests/browser/custos-layout-navegador.spec.ts`. (5) **O formulário é uma grade CSS** (`.cust-campos`, quatro faixas;
  campo comum = 1, `cust-grande` = 2) com início alinhado: rótulo, caixa e altura iguais na linha; o texto de apoio (prévia do
  valor) mora ABAIXO da caixa em altura reservada. A ordem do DOM e do Tab não muda.
- **Atualizações: linha compacta, número do processo SEM quebra, Ações numa fileira de ícones com dica (inclusive "Analisar com IA") e
  texto visível nos cartões** (v0.49.2, decisões do dono; só apresentação — detecção, "pede providência", "cumprido", filtros, contagens,
  `/v1/novidades`, `/v1/painel`, calendário e o painel de IA não mudaram). (1) **A linha típica tem de 48 a 56 px** em 1920, 1366 e
  1280 px; o CNJ é `white-space:nowrap` com o ícone de copiar colado a ele; Partes quebra em até 2 linhas (title com o texto inteiro);
  Tribunal e Classe, uma linha com reticências (abaixo de 1600 px a Classe é a linha de baixo da célula do Tribunal). Data do ato e
  Detectado não quebram: o cabeçalho mostra "Data" e o nome completo ("Data do ato") fica no `aria-label`/`title` do botão de ordenar.
  (2) **A célula Atualização é UMA linha** (`.nvt-ato`: ato, etiqueta, link "Abrir processo", "Não lida" e o aviso "Sem atualização
  detectada"), que só quebra quando falta largura; "Última movimentação conhecida" mora no `title` e em texto para leitor de tela.
  (3) **Ações = uma fileira** de controles de 28 px: caixa "Cumprido", abrir, pasta e "Analisar com IA" (ícone, `aria-label="Analisar com
  IA"`, mesmo clique e mesmas regras; o botão ou existe ou não existe, e o painel guarda o carregamento). Todos usam a dica ÚNICA do console
  (`__pvProvidencia.comDica`/`ligar`, ver o item dos Custos da v0.49.1): não se desenha outra e não se põe `title` em ícone. (4) **Cartões
  (< 1024 px, ponto de quebra inalterado):** o texto da ação aparece ao lado de cada ícone, a dica dos ícones some (a da caixa "Cumprido"
  continua). Em 1024–1279 px a tabela cabe sem rolagem horizontal, mas é apertada. Teste: `tests/browser/atualizacoes-layout-navegador.spec.ts`.
- **O calendário LÊ datas; não calcula prazo** (v0.32.0; **exceção registrada na v0.39.0: o aviso
  a partir da análise por IA, item acima — fora dele a regra segue valendo**). Evento detectado só
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
- **Lembretes no feed só para confirmados; resumo por e-mail sem prazo e sem dado pessoal; chave global desligada por padrão**
  (v0.51.0, decisões do dono; detecção, estados, deduplicação e a privacidade do `SUMMARY`/`DESCRIPTION` não mudaram).
  (1) **Lembretes (`VALARM`)**: escolha por feed (`lembretes.umDiaAntes`/`umaHoraAntes`, padrão NENHUM, `PATCH`/`GET`/`POST
  /v1/calendario/feed`). Saem só em evento `confirmado` e ainda no futuro — nunca em `sugerido`, nunca em `CANCELLED` —, com
  `DESCRIPTION` igual ao `SUMMARY` (sem parte, trecho ou observação; sigilo sem número). Com hora: `TRIGGER` relativo (`-P1D`,
  `-PT1H`); dia inteiro: **absoluto em UTC** (12:00Z = 09:00 SP no dia anterior; 11:00Z = 08:00 SP no dia), porque `DTSTART` de
  dia inteiro é uma DATA e o cliente a leria no fuso do aparelho. Mudar a escolha sobe `revisao_lembretes` do FEED
  (`SEQUENCE` = `e.sequencia + revisao`; `DTSTAMP` = o maior entre o evento e a mudança): nenhum evento é regravado e o `UID` não
  muda. **O que o teste prova é o FORMATO; o que Apple, Outlook e Google fazem com o alarme não é provado** — a tela diz que o
  Google Agenda pode ignorá-lo em calendário assinado por URL, e não se promete lembrete no aplicativo de ninguém.
  (2) **Resumo por e-mail dos eventos a confirmar** (`ServicoResumoDoCalendario` + `mensagemDoResumoDoCalendario`, pura): um por
  conta, no máximo um por dia, de 08:00 a 12:00 de São Paulo (tick de 15 min, relógio injetado), só com item NOVO (`sugerido` ou
  `revisar`, detectado, de hoje em diante, ainda não avisado); até 10 itens e "e mais N"; **nunca afirma prazo** ("data lida do
  andamento de dd/mm, confira no processo"; nada de "urgente" ou "prazo fatal"); sem nome de parte, trecho, título livre nem
  observação; sigilo = "processo sigiloso", sem número. Vai ao e-mail de LOGIN; conta de chave de API não recebe.
  (3) **Chave `PROCESSOVIVO_CALENDARIO_RESUMO_HABILITADO`, desligada por padrão**, e só com SMTP de verdade (`entregaDeVerdade`:
  log não é entrega); a opção por conta (`GET`/`PUT /v1/calendario/resumo`, padrão ligado) só aparece com a chave ligada.
  **Descadastro só pelo painel (Calendário > Resumo por e-mail); não há rota pública de descadastro** — se um dia houver, será
  decisão à parte, com token assinado. (4) Registro (`calendario_resumo_itens`/`_envios`/`_preferencias`) só com ids, datas e
  contagens; falha de envio soma tentativa por item (máximo 3), não derruba o agendador e o log leva só contagens. (5) `calendario
  resumo-previa` (CLI) é SÓ LEITURA: contas e itens, sem e-mail nem conteúdo. (6) O aviso de "evento próximo" para confirmado
  NÃO existe; se vier, entra no mesmo agendador, com a mesma chave e o mesmo opt-out (spec v1.1.0, 17.3).
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
**ato (movimentação) de cada peça na lista da Pasta, com descrição** (v0.33.2) **e o número da movimentação calculado pela posição do ato, com aviso de atos bloqueados** (v0.34.0; a 0.33.3 havia removido o número errado da 0.33.2), **calibração do número com o Projudi feita pelo advogado: exato quando provado, faixa ou estimado quando não** (v0.35.0), **página inicial: Últimas atualizações mostra só o trecho do texto e o trilho de peças baixadas não estoura a largura** (v0.35.1), **Pasta: número da movimentação no lugar do índice; página inicial: "detectado há N dias" e cartão "pede providência"** (v0.35.2), **Pasta: lista em altura total com avisos compactados** (v0.35.3), **Pasta: todas as movimentações na lista, inclusive as sem peça, com lacuna de numeração provada e lista mais larga** (v0.36.0), **página inicial: tabela de últimas atualizações, uma linha por processo, com filtros que contam no lugar dos cartões; histórico de peças baixadas dentro da Pasta** (v0.37.0), **tabela sem "+N anteriores", "Detectado" enxuto e descrição do ato sem repetição na exibição** (v0.37.1), **classe legível e agrupada no filtro, última movimentação sem repetição e carteira sem rodapé redundante** (v0.37.2), **Atualizações lista todos os processos acompanhados, período como filtro opcional e verificação por conta** (v0.37.3), **Atualizações abre em "Pedem providência", com a lista completa a um clique** (v0.37.4), **intimação do Diário pede providência por 30 dias ou até "cumprido", marca por ato, correção da avalanche de novidades e reparo só com dry-run** (v0.37.5), **conferência com o Projudi: sonda de diagnóstico só de leitura, linha do ato da providência, "Detectado" legível e intimação a outro destinatário** (v0.37.6), **"Analisar com IA": por botão, texto redigido, citação verificada, ZDR falhando fechado, desligada por padrão e só no plano IA** (v0.38.0; sonda de IA v1.2.0 e `ia-avaliacoes.mjs` v1.0.0), **exceção de teste fechado da IA por variável (`PROCESSOVIVO_IA_WORKSPACES_LIBERADOS`), removida na v0.50.0** (v0.38.1), **log da análise por IA com status HTTP, passo e funil do roteamento** (v0.38.2), **análise por IA: rodízio por provedor depois de 429/5xx, sem `allow_fallbacks`** (v0.38.3), **análise por IA: formato da resposta em texto, sem `require_parameters` nem `response_format`, ZDR e lista intactas** (v0.38.4), **análise por IA: ações possíveis como providência sem citação, rejeição de ação que copia o trecho-chave e rodapé sem o nome do modelo** (v0.38.5), **IA como secretária, Etapa 1: prazo escrito no ato, calculadora de prazo (exceção registrada) e "Criar aviso no calendário" com prévia e confirmação** (v0.39.0), **IA como secretária, Etapa 2 (só o servidor): resumo do processo por IA, por clique, com verificação item a item e a contagem das providências do sistema que a IA não citou** (v0.40.0), **tela do resumo do processo: botão na capa, painel com estados, link do ato à linha do tempo e correção do prazo sem opção pré-marcada** (v0.40.1), **Atualizações: busca pelo número do processo, que respeita os filtros e diz quantos casam fora deles** (v0.41.0),
**tela do processo sem os blocos "Pede providência" e "Última movimentação", Partes logo abaixo das peças** (v0.41.1), **Google Drive: conectar a conta do advogado e salvar as peças da Pasta digital numa pasta "Processo Vivo", por botão, escopo `drive.file`, desligado por padrão, planos Peças e IA** (v0.42.0), **Drive: o retorno do OAuth usa o workspace do `state` assinado e a conta de chave de API também conecta** (v0.42.1), **testes estáveis no CI e a volta do Google sem corrida no console** (v0.42.2), **Atualizações: situação como texto e caixa "Cumprido" como único controle, com aviso para desfazer** (v0.43.0), **cobrança recorrente pelo Mercado Pago, parte 1: assinatura por cartão atrás da porta de pagamento, webhook idempotente, reconciliação e ciclo no plano** (v0.44.0), **ambiente do pagamento declarado em `PROCESSOVIVO_PAGAMENTO_AMBIENTE`, não deduzido do token** (v0.44.1),
**página de vendas: vitrine pública `GET /v1/planos`, plano escolhido atravessando cadastro e login, confirmação de assinatura com aceite dos Termos obrigatório e trecho para o site** (v0.45.0), **recusa do gateway com motivo de lista fechada, log saneado, 422/503 em JSON e a última falha no /admin** (v0.45.1), **tabela de Atualizações mais limpa: Atualização em uma linha, datas estreitas e coluna "Cumprido" só com a caixa e a dica** (v0.46.0),
**tabela de Atualizações: caixa "Cumprido" na coluna Ações, Partes mais larga, sem o selo "outro destinatário" na linha e sem a frase fixa sob o filtro** (v0.46.1),
**centro de custos do processo: lançamentos manuais por processo, categorias próprias, totais no servidor, caixa "Ressarcido" e prestação de contas em PDF para o cliente** (v0.47.0), **custos: recebimentos do cliente com saldo e crédito, quem pagou, depósitos fora das despesas, cancelar com histórico e catálogo Grupo › Subcategoria** (v0.48.0), **custos por cliente: tela no menu, PDF consolidado, CSV, comprovantes no Google Drive do advogado e aviso ao deixar de acompanhar** (v0.49.0), **painel de Custos: colunas de conteúdo, ações em ícones com dica e formulário em grade** (v0.49.1), **Atualizações: linha compacta, número do processo sem quebra e Ações em ícones com dica, inclusive "Analisar com IA"** (v0.49.2), **sincronização mais rápida: pool de até 3 (máx. 4) processos, progresso real "Verificando X de N" e fila sem processo que sempre falha na frente** (v0.49.3), **Atualizações: coluna Atualização em uma linha, sem o link "Abrir processo" na tabela (só nos cartões)** (v0.49.4), **checkout do Mercado Pago: e-mail do pagador informado na tela e checkout novo que substitui a assinatura pendente** (v0.49.5), **textos do checkout sem sugerir conta no Mercado Pago** (v0.49.6), **plano IA vendável por dado (preço + "à venda" no /admin), sem a exceção de teste fechado, com teto técnico diário e aviso de upgrade com "Ver planos"** (v0.50.0), **login avisa que as peças valem só para o TJGO por enquanto** (v0.50.1), **calendário: lembretes no feed ICS (só confirmados) e resumo por e-mail dos eventos a confirmar, desligado por padrão** (v0.51.0), **medição da análise por IA: 48 casos sintéticos, comparador manual de modelos com teto de gasto e ZDR falhando fechado, avaliação com motivo logo abaixo do resultado e resumo no teto diário compartilhado** (v0.52.0), **IA de peças, Fase 0: extração de texto só interna e sem OCR, medição somente leitura da camada de texto, redação extra para peças, 24 peças sintéticas e comparador de peças** (v0.53.0), **resumo do processo: ato mais recente e providências sempre considerados, faixa do sistema, prompt `resumo-1.1.0` e comparador do resumo** (v0.54.0),
Dockerfile multi-stage, CI, 3561 testes.

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
decisões do dono: `docs/calendario-especificacao-v1.1.0.md`.

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

**Painel (v0.26.0; os cartões e o trilho saíram na v0.37.0 — ver a regra da página inicial em §8):** data por extenso, hora e a frase da última verificação no
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
editáveis no painel; esses são os valores iniciais.) O gateway entrou na v0.44.0 como adapter atrás de
uma porta (ver "Cobrança recorrente" em §8); a liberação manual (Pix por fora) continua funcionando
exatamente como antes.

**Não implementado (decisão consciente do MVP):** Pix e boleto avulsos por período (parte 2 do gateway; a porta já tem o gancho), assinatura online para conta de chave de API, convite de
membros para um mesmo escritório, crawler real, **cópia de backup fora do VPS**
(as cópias automáticas ficam no mesmo volume do banco — protegem contra erro de
operação, não contra perder o volume; o procedimento manual está em DEPLOY.md),
**WhatsApp** (adiado: exige template aprovado pela Meta e conta business
verificada — e a biblioteca não oficial que resolveria numa tarde viola os
termos e derruba o número, levando junto o aviso de prazo de todos os
assinantes), **cálculo de prazo** (dias úteis do art. 219 do CPC, recesso,
suspensões — alto valor e alto risco: só entra como calculadora com as contas à
vista, nunca como afirmação; **a v0.39.0 trouxe uma calculadora mínima, só para ato do
Diário e só depois do clique, sem feriado local, suspensão nem prazo em dobro**), página do processo para o cliente do advogado,
alerta de evento do calendário por e-mail/push, sincronização de mão dupla
com Google/Outlook, fila de jobs genérica (a do leitor é mínima e só dele). O cache é em memória — uma instância, e evapora no redeploy.

Ao implementar qualquer um deles, **atualize este arquivo na mesma PR.**
