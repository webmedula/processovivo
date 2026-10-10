# Sonda de IA do ato — resultado v1.0.1 (Etapa 1, transporte OpenRouter)

Documento: `sonda-ia-ato-resultado-v1.0.0` (o nome do arquivo não muda; o conteúdo está na **v1.0.1**) ·
10/10/2026 · especificação: `ia-analise-do-ato-especificacao-v1.0.0` (seções 4 a 7 e 11, mais a
"Errata v1.0.1").
Versão da sonda: **1.1.0** (era 1.0.0, com o AI Gateway da Vercel). Versão do produto:
**inalterada (0.37.6)** — esta etapa não muda comportamento de produto, só acrescenta módulos
puros, o transporte (ainda sem uso no serviço) e a sonda.

**Por que a v1.0.1:** o dono não usará o AI Gateway da Vercel — a retenção zero por chamada exige
plano Pro ou Enterprise e a conta dele é Hobby. O transporte passou a ser o **OpenRouter**
(`provider.zdr: true`). Redação, verificação, esquema de saída, casos sintéticos, planilha do
Autran, critérios e a regra "ZDR falha fechada, sempre" **não mudaram**.

Este documento **não contém texto, nome, CPF nem número de processo de caso real**. Tudo o que
está medido aqui veio de código e de capturas já versionadas; **a sonda ainda não foi rodada
contra modelo nenhum** (sem chave e sem rede neste ambiente) e **o OpenRouter nunca foi
chamado**. A seção 6 diz o que isso quer dizer.

---

## 1. Respostas às perguntas da Etapa 1

### (a) Que texto o retrato guarda por ato, e quantos atos têm texto suficiente

O retrato do acompanhamento (`Processo.movimentacoes`, serializado inteiro em JSON na linha de
`acompanhamentos`) guarda, **por ato**, o que a `Movimentacao` carrega:

| Campo              | DJEN                                                                                                            | DataJud                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `titulo`           | `tipoDocumento` ("Decisão"), senão `tipoComunicacao` ("Intimação"), senão a 1ª linha do texto                   | nome do movimento na TPU ("Juntada de petição")                                          |
| `conteudo`         | **inteiro teor da publicação**, HTML limpo e entidades decodificadas (`limparTextoDoAto`)                       | **nunca** — a API pública devolve só o rótulo                                            |
| `complementos`     | —                                                                                                               | `["tipo_de_documento: petição"]` (rótulos da TPU, 31–44 caracteres nos casos da captura) |
| `tipoComunicacao`  | sim ("Intimação", "Citação"…)                                                                                   | —                                                                                        |
| `teorIndisponivel` | sim, quando o DJEN manda o aviso "arquivos digitais indisponíveis" no lugar do teor (o `conteudo` é descartado) | —                                                                                        |

A tabela `novidades` repete `titulo` e `conteudo` por novidade. **Em nenhum lugar há descrição ou
complemento livre além disso**: só o DJEN tem texto de verdade.

Números (contados por código, sem imprimir texto):

- **Captura real do DJEN versionada** (`tests/fixtures/djen-comunica-real.json`): contém **1**
  comunicação. Ela tem teor próprio (470 caracteres após a limpeza), tipo "Intimação" e passa na
  regra de texto suficiente. **Uma amostra de 1 não mede taxa nenhuma.**
- **Captura real do DataJud** (`datajud-tjgo-real.json`): **8 movimentos**, 2 com complemento
  (31 e 44 caracteres), **0 com texto suficiente**. É o esperado: o DataJud não tem texto de ato.
- **O único número populacional que o repositório registra** está no `CLAUDE.md` (§8, "Placeholder
  também chega de fora"): num processo de teste, **43 das 62 publicações do DJEN (69%) são o
  aviso "arquivos digitais indisponíveis"**, sem teor. Para esse tipo de ato o botão deve dizer
  "sem texto suficiente" e **não chamar o modelo**.
- **Regra adotada** (`MINIMO_DE_CARACTERES_DO_TEXTO = 80`, em `entradaDoModelo.ts`): o corpo do
  ato (conteúdo, ou os complementos quando não há conteúdo) precisa ter ao menos 80 caracteres.
  O título sozinho nunca basta.

**O que eu não consegui medir:** a taxa real de atos com texto suficiente **na carteira dos
usuários**: exige abrir o banco de produção, e a sonda de IA não o faz. Para isso existe a sonda
de contagem **somente leitura** `scripts/diagnostico-texto-por-ato.mjs` (seção 9), que o dono
roda no Console do serviço e que devolve só números.

Consequência para a Etapa 2: o corpo do ato deve ser lido **no servidor**, do retrato
(`acompanhamentos` / `novidades`), e não do que a tela recebe — a tela recebe só os primeiros
600 caracteres nas linhas sem novidade e encurta ainda mais ao exibir.

### (b) O plano IA hoje

- **Recurso:** `analiseIa`, em `RECURSOS` (`domain/entities/Plano.ts`), com `implementado: false`.
- **Plano:** semente `ia` ("IA", ordem 30, sem preço), com `BASE + pecas + analiseIa` e
  `disponivelParaContratacao: false`.
- **A trava:** `validarPlano` recusa pôr à venda qualquer plano com recurso não implementado
  (`PlanoInvalidoError`, "ainda não existe"). Testes que a fixam:
  `tests/domain/Assinatura.spec.ts` (`'a análise com IA está marcada como AINDA NÃO EXISTENTE'`,
  `'recusa colocar à venda um plano com recurso que não existe'`, e a lista fechada de recursos
  com `['analiseIa', false]`), `tests/application/ServicoPlanos.spec.ts` e `tests/http/admin.spec.ts`.
  **A Etapa 2 não vira `implementado` para `true`**: o botão checa o recurso sem exigir a venda.
- **Como o dono atribui o plano a uma conta:** no `/admin`, aba de assinaturas, "Liberar /
  renovar" (`POST /admin/api/assinaturas/:email/liberar`, plano + meses). `ServicoAssinaturas.liberar`
  só confere que o código do plano **existe** — **plano pausado (fora de venda) pode ser
  liberado à mão**, e a lista do formulário traz todos os planos, à venda ou não. Também existe
  `npm run cli -- assinatura liberar <e-mail> ia <meses>`.
- **Teste de 14 dias:** usa o plano `pecas` (`planoDoTeste`), que **não inclui** `analiseIa`.
  Conta nova, portanto, não tem IA — o que casa com a recomendação da seção 13.1 da especificação.
- **Aviso de plano já usado:** `ServicoAssinaturas.exigir` lança `RecursoNaoIncluidoNoPlanoError`
  (HTTP 403) com o nome do plano atual e o menor plano que traz o recurso.

### (c) Configuração de chave de IA

**Não existe** na aplicação. Nenhuma variável de IA em `src/`, `.env.example` ou `DEPLOY.md`. A
sonda lê `OPENROUTER_API_KEY` direto do ambiente (é um script de operador; nome nativo de
terceiros, como era `AI_GATEWAY_API_KEY`). A validação no arranque do serviço
(`PROCESSOVIVO_IA_HABILITADA`, etc.) é da Etapa 2.

---

## 2. OpenRouter: o que a documentação diz (as 6 investigações)

**Limite desta investigação, dito de início:** neste ambiente o acesso a `openrouter.ai` está
fechado (DNS/proxy) — não consegui abrir as páginas da documentação, nem chamar a API. O que está
abaixo vem de (i) **resumos de busca** sobre as páginas oficiais, consultados em **10/10/2026**,
(ii) o **código-fonte do pacote do SDK** instalado (`@openrouter/ai-sdk-provider@3.1.0`), e (iii)
testes de fio com HTTP dublado. Cada item diz qual das três o sustenta e o que **ficou sem
confirmação**. Páginas consultadas (via busca):

- `https://openrouter.ai/docs/guides/routing/provider-selection` (campos do objeto `provider`);
- `https://openrouter.ai/docs/features/zdr` (Zero Data Retention);
- `https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints-zdr` (lista de endpoints ZDR);
- `https://openrouter.ai/docs/guides/administration/usage-accounting` (uso e custo);
- `https://openrouter.ai/docs/api-reference/limits` (limites e créditos por chave);
- `https://openrouter.ai/blog/insights/ai-data-residency/` (comportamento de `allow_fallbacks: false`).

### 2.1 Como exigir ZDR por chamada

- `provider.zdr` (booleano): "restringe o roteamento apenas a endpoints ZDR"; sem valor padrão. É um
  **OU** com a configuração ZDR da conta e de guardrails — a chamada **só pode ligar** a ZDR, nunca
  desligar a da conta. _(documentação, via busca)_
- `provider.data_collection` **existe**, com `"allow"` (padrão) ou `"deny"`; `"deny"` exclui endpoints
  que guardam dado de forma não transitória ou podem treinar com ele. _(documentação, via busca; e os
  tipos do SDK: `data_collection?: 'allow' | 'deny'`)_ → **a sonda usa os dois**.
- `provider.allow_fallbacks` (padrão `true`): com `false`, se nenhum provedor da lista estiver
  disponível o serviço devolve **erro** em vez de rotear para um não conforme. _(blog de residência
  de dados, via busca)_
- **Os provedores de reserva respeitam a ZDR? A documentação consultada não o afirma com todas as
  letras.** O que ela diz é que `zdr` restringe o roteamento a endpoints ZDR (ou seja, o conjunto de
  candidatos já nasce filtrado), mas isso é inferência minha, não frase da página.
  **Decisão:** a sonda envia `allow_fallbacks: false` (sem reserva) e, ainda assim, confere depois
  quem serviu (2.3 e 2.4). Se o teste mostrar que a reserva respeita a ZDR, a restrição pode ser
  relaxada — é uma constante (`PREFERENCIAS_DE_PROVEDOR`).
- `provider.require_parameters: true` também vai em toda chamada: só admite endpoint que cumpra
  `response_format` (saída estruturada). Sem isso o esquema fechado poderia ser ignorado em
  silêncio por um endpoint que não o suporta.
- **Verificado no fio** (SDK real, `fetch` dublado): o corpo enviado a `POST /api/v1/chat/completions`
  leva `"provider": {"zdr": true, "data_collection": "deny", "allow_fallbacks": false,
"require_parameters": true}`, `response_format` com `json_schema` estrito e a chave **só** no
  cabeçalho `authorization`.

### 2.2 O que o OpenRouter faz quando nenhum provedor ZDR atende — **NÃO CONFIRMADO**

A documentação não diz. A única pista (fonte de terceiros, não oficial) é que um **404 "No
endpoints found"** aparece quando todos os provedores atrás de um modelo ficam fora dos filtros.
**O código HTTP e o corpo reais não foram obtidos**, porque o teste exige uma chamada de rede, que
não fiz (pedido expresso). Entreguei o comando que a faz com texto sintético
(`--teste-falha-fechada`, seção 8): ele imprime o status e o corpo do erro, e diz se o
comportamento foi "falhou fechado" (esperado), "erro de outro tipo" (me mande o status e o corpo
para eu ajustar a classificação) ou **"respondeu mesmo assim" (bloqueante)**.

Como o código se protege **sem depender desse conhecimento**:

1. toda tentativa — inclusive as repetições — leva `zdr: true`; nenhum caminho do código envia sem ele;
2. qualquer 4xx (inclusive 404 e 400) **nunca é repetido**; só 429, 5xx e falha de rede, no máximo 2
   vezes, com espera crescente (1 s, 3 s) e a MESMA `zdr: true`;
3. 400/404 com uma frase de "sem provedor" (`no endpoints found`, `no allowed providers`, `zdr`,
   `data policy`…) vira `ZdrIndisponivelError` — o modelo sai da comparação, com o erro mostrado;
4. mesmo que o OpenRouter responda ignorando a ZDR, a resposta só vale se quem serviu consta na
   lista ZDR do modelo (2.3/2.4); senão é **descartada** e o modelo para.

### 2.3 Como saber quem atendeu — **o campo existe no SDK; falta ver numa resposta real**

As páginas de documentação que consegui ler pela busca **não** descrevem um campo de provedor na
resposta de chat completions. Já o **esquema de resposta do SDK** tem `provider?: string` no nível
superior e o expõe em `providerMetadata.openrouter.provider`; o teste de fio confirma que a sonda
o lê. A sonda registra por chamada **só** esse nome (e o usa para a conferência 2.4).
**Se a resposta real não trouxer o campo, toda resposta é tratada como "provedor não confirmado" e
descartada** — falha fechada, ao custo de a sonda não servir até se achar o campo (o teste de falha
fechada e a primeira rodada sintética mostram isso na hora).

### 2.4 Lista pública de endpoints com ZDR

- Rota: `GET https://openrouter.ai/api/v1/endpoints/zdr` (a página da ZDR a cita como forma
  programática; a lista "é atualizada automaticamente quando a política de dados de um provedor muda").
- **Precisa de chave:** a especificação OpenAPI da rota marca o cabeçalho `Authorization: Bearer
<chave>` como obrigatório. A sonda o envia — e por isso **a listagem usa a chave, mas não envia
  texto de caso nenhum**. _(uma réplica de terceiros diz que o recurso pode depender de habilitação
  na conta; não confirmado.)_
- Formato: `{ "data": [ { name, model_id, model_name, context_length, pricing, provider_name, tag,
quantization, max_completion_tokens, … } ] }` — **um item por endpoint** (modelo × provedor). _(página
  da rota e réplica, via busca; **nenhuma captura real**)_
- Por modelo: sim — agrupa-se por `model_id`; "modelo com ao menos um endpoint ZDR" = aparece na lista.
- **Como a sonda lida com a incerteza do formato:** o esquema é frouxo (`passthrough`, campos
  opcionais). Se a lista vier mas nenhum item tiver `model_id` e `provider_name`/`tag`, a sonda **para**
  e imprime só os **nomes** dos campos do primeiro item (nunca valores), para o ajuste ser de uma linha.
  `--listar-modelos-zdr` mostra os ids; `--modelos=…` **recusa a rodada inteira** se algum modelo
  não estiver na lista; a conferência do provedor que serviu compara (sem caixa nem pontuação) com
  `provider_name`, `tag` e o trecho da `tag` antes da `/`.

### 2.5 Custo

- O `usage` vem **sempre** na resposta (`usage: {include: true}` e `stream_options.include_usage`
  estão **obsoletos e sem efeito**): tokens de entrada/saída, `cost` (o que foi cobrado da conta,
  em créditos ≈ USD) e `cost_details.upstream_inference_cost` (só para BYOK). _(documentação de uso, via busca)_
  O SDK entrega isso em `providerMetadata.openrouter.usage.cost` — lido e testado no fio.
- A tabela diz a **fonte** (`openrouter` = `usage.cost` da resposta) e a data da rodada. Se faltar o
  custo, a sonda **estima** `tokens × preço` com o **maior** preço entre os endpoints ZDR do modelo
  (da própria lista) e rotula como **`estimativa`**.
- **Limite de gasto:** existe **por chave** (cota de créditos opcional, com `limit_reset` para
  zerar periodicamente); passar dele devolve **HTTP 402**; `GET /api/v1/key` informa limite e saldo.
  Há também o saldo da conta (créditos pré-pagos). _(página de limites, via busca; os passos exatos
  da tela de chaves **não** foram confirmados — a seção 8 os dá com a ressalva.)_

### 2.6 Biblioteca escolhida

**`@openrouter/ai-sdk-provider@3.1.0`**, versão exata, dependência de produção, junto de `ai@7.0.137`
(já usado na 1.0.0).

| Critério                                               | `@openrouter/ai-sdk-provider@3.1.0`                         | `@ai-sdk/openai-compatible@3.0.67`               | `fetch` direto + Zod |
| ------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------ | -------------------- |
| Compatível com `ai@7`                                  | sim (`peerDependencies: ai ^7`)                             | sim                                              | n/a                  |
| Dependências próprias                                  | **nenhuma** (só peers: `ai`, `zod`)                         | 2 (`@ai-sdk/provider`, `@ai-sdk/provider-utils`) | nenhuma              |
| `provider.zdr` / `data_collection` / `allow_fallbacks` | **tipados** no `chat(modelo, { provider })`                 | só via corpo extra, sem tipo                     | à mão                |
| Provedor que serviu                                    | `providerMetadata.openrouter.provider`                      | não mapeia o campo                               | à mão                |
| Custo (`usage.cost`)                                   | `providerMetadata.openrouter.usage.cost`                    | não mapeia                                       | à mão                |
| Saída estruturada                                      | `response_format: json_schema` estrito, via `Output.object` | idem                                             | à mão                |
| Injeção de `fetch` para teste de fio                   | sim                                                         | sim                                              | sim                  |

Escolhi o primeiro: é o único que passa `provider.zdr` **tipado**, devolve o provedor e o custo e
não acrescenta dependência transitiva. Verificado no fio (teste automatizado). O pacote do gateway
da Vercel deixou de ser usado: o código não o importa; `ai` o traz como dependência transitiva
(`@ai-sdk/gateway`), mas **nenhuma chamada passa por ele**.

---

## 3. O que foi construído

| Peça                                                              | Onde                                                               | Observação                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Vocabulário fechado (`parece_pedir`, códigos de atenção, limites) | `domain/entities/vocabularioDaAnalise.ts`                          | sem imports; **inalterado**                                            |
| `redigirParaIA` / `criarRedator`                                  | `application/politicas/redigirParaIA.ts`                           | pura; **inalterada**                                                   |
| `verificarAnalise`                                                | `application/politicas/verificarAnalise.ts`                        | pura; **inalterada**                                                   |
| `prepararEntrada`, `temTextoSuficiente`                           | `application/politicas/entradaDoModelo.ts`                         | `VERSAO_PROMPT = ato-1.0.0`; **inalterada**                            |
| Esquema Zod fechado                                               | `infrastructure/adapters/modelo/esquemaDaAnalise.ts`               | `.strict()`; **inalterado**                                            |
| **`TransporteOpenRouter`** (ZDR fixo)                             | `infrastructure/adapters/modelo/TransporteOpenRouter.ts`           | **novo**; substitui `TransporteGateway`                                |
| **Lista ZDR e conferência do provedor**                           | `infrastructure/adapters/modelo/endpointsZdr.ts`                   | **novo**; usa o `HttpClient` do projeto; substitui `catalogoDoGateway` |
| `ZdrIndisponivelError`                                            | `domain/errors/index.ts`                                           | subclasse de `ProviderIndisponivelError`; texto atualizado             |
| Núcleo, métricas, planilha, julgamento                            | `main/sonda/sondaIaAto.ts`, `comandoSondaIa.ts`, `casosDaSonda.ts` | provedor + `zdrConfirmado` por chamada                                 |
| Comando                                                           | `scripts/sonda-ia-ato.mjs` (**v1.1.0**)                            | `--listar-modelos-zdr`, `--teste-falha-fechada`, `--fixtures-saida`    |
| 12 casos sintéticos                                               | `tests/fixtures/ia-ato/casos-sinteticos.json`                      | inalterados; agora também copiados para a imagem (`Dockerfile`)        |

**Mudança na imagem:** uma linha no `Dockerfile` (`COPY tests/fixtures/ia-ato ./tests/fixtures/ia-ato`)
para a sonda achar, dentro do contêiner, os casos **sintéticos** (inventados). Não toca `ENV`, porta,
caminho do banco nem credencial. Sem ela, os comandos (b) e (e) da seção 8 não funcionariam no Easypanel.

Removidos de vez: `TransporteGateway.ts`, `catalogoDoGateway.ts`, `AI_GATEWAY_API_KEY` e
`providerOptions.gateway` (nada de código morto; o único resquício textual é a palavra "gateway" em
comentários históricos do `CLAUDE.md` sobre pagamento, que é outro assunto).

### Decisões de desenho (todas reversíveis, todas testadas)

As sete da v1.0.0 (verificação) continuam valendo. Novas:

1. **Pré-checagem obrigatória:** sem conseguir a lista ZDR (rede, chave recusada, formato
   inesperado), **nada é enviado** — a ZDR não pode ser confirmada.
2. **Modelo fora da lista recusa a rodada inteira** (não só aquele modelo): um erro de digitação não
   pode reduzir a comparação em silêncio.
3. **Provedor não confirmado = resposta descartada + modelo parado + aviso alto.** O texto do caso já
   saiu da máquina nesse momento; por isso o aviso diz que, se se repetir com a ZDR ligada, é bloqueante.
4. **`allow_fallbacks: false`** (2.1).
5. **Metadado por chamada** (`chamadas-AAAA-MM-DD.json`, no volume): modelo, variante, estado, provedor,
   latência, tokens, custo, `zdrConfirmado` sim/não e a ordem na rodada — **nunca** o id do caso nem texto.
6. **Teste de falha fechada** só com o caso sintético `s01`, e só ali o status e o corpo do erro vão ao
   terminal (`aoFalhar` não é ligado em rodada com caso real).

---

## 4. O que foi medido (sem rede)

Testes de unidade, sem rede e sem tempo real (transporte e HTTP dublados):

- **ZDR no fio** (SDK real, `fetch` dublado): o corpo leva `provider.zdr: true` e `data_collection:
deny`; a **chave só no cabeçalho**; 429 pela rede gera nova tentativa **também com `zdr: true`**;
  404 "No endpoints found" vira `ZdrIndisponivelError` com **uma única requisição**; resposta fora do
  esquema vira `RespostaInvalidaError` sem repetir; resposta sem `provider` chega como "não informado".
- **Transporte:** toda chamada ao SDK carrega `provider.zdr: true`; chamada **sem** `zdr` (ou sem
  `data_collection: deny`) lança `ProviderIndisponivelError` **antes de qualquer rede** (o executor
  não é chamado); "sem provedor" não gera segunda chamada; 429 repete com 1 s; 5xx repete no máximo 2
  vezes com 1 s e 3 s, todas com ZDR; 401/402/404/400 comuns não repetem; a mensagem do erro nunca
  copia o corpo nem a chave.
- **Lista ZDR:** leitura, filtro por texto, `modeloTemZdr`, conferência do provedor (caixa,
  pontuação, `tag`), preço estimado, formato inesperado (só nomes de campo), chave só no cabeçalho e
  nunca em mensagem de erro, falha de rede com mensagem fixa.
- **Sonda:** recusa sem `OPENROUTER_API_KEY` e com valor de exemplo, **antes de qualquer rede**; a
  chave nunca aparece no terminal nem nos arquivos; **modelo fora da lista recusa a rodada**; lista
  indisponível ou sem os campos esperados não envia nada; provedor fora da lista **descarta a
  resposta** e para só aquele modelo; `--fixtures-saida`; metadado por chamada sem texto; teste de
  falha fechada nos três desfechos (fechou / erro de outro tipo / respondeu = bloqueante).
- Mantidos da v1.0.0: redação, verificação, `--arquivo`/`--stdin` sem gravar nada no repositório,
  resposta crua só de caso sintético, planilha e julgamento.

**Não medido (precisa de chamada real, e eu não fiz nenhuma):** o status e o corpo reais de "sem
provedor ZDR"; se o campo `provider` vem na resposta; o formato real da lista ZDR; qual modelo atende
com ZDR na conta; latência, tokens e custo; taxa de citações verificadas, descarte, "não verificado" e
"indeterminado" de cada modelo; o comportamento real nos casos de injeção; o julgamento do Autran.

---

## 5. Divergências entre a especificação e o código

1. **Workspace sem assinatura passa livre** (`ServicoAssinaturas.exigir`) — **resolvida pelo dono:**
   a errata v1.0.1 da especificação registra que o plano IA é **obrigatório, sem exceção**. A
   Etapa 2 implementa a exceção ao `CLAUDE.md` (que hoje deixa a chave de API sem assinatura passar
   livre) e **registra a decisão no `CLAUDE.md`**.
2. **O CSV do Autran tem 4 colunas**, e a variante "com títulos" precisa dos títulos anteriores: a sonda
   aceita uma 5ª coluna **opcional** `anteriores` (títulos separados por `|`). Sem ela, a variante só
   roda nos casos sintéticos.
3. **A planilha tem uma coluna a mais:** `id;modelo;variante;resultado;avaliacao`.
4. **Prefixo das variáveis da Etapa 2:** `PROCESSOVIVO_IA_HABILITADA`, `_IA_MODELO`, `_IA_COTA_MENSAL`,
   `_IA_ZDR`. A chave do transporte é `OPENROUTER_API_KEY`.
5. **A especificação cita o AI Gateway e `zeroDataRetention`** nas seções 3.7, 8 e 10: a "Errata
   v1.0.1" no fim dela corrige o transporte; o resto não foi reescrito.
6. **O dono não precisa mais de conta Vercel Pro/Enterprise** (decisão 13.5 da especificação),
   mas precisa **ligar a ZDR na conta do OpenRouter** (seção 8) — a chamada só pode ligar a ZDR, nunca
   desligar a da conta.

Nada mais conflita com o código ou o `CLAUDE.md`.

---

## 6. O que a sonda não consegue medir, e riscos abertos

1. **Documentação lida por resumo, não na fonte** (2). Cada afirmação da seção 2 diz de onde vem.
   O que decide está nos testes de fio (SDK) e no comando de falha fechada.
2. **Formato real da lista ZDR e do campo `provider` da resposta** (2.3, 2.4): se diferirem, a sonda
   **recusa** (não adivinha) e diz o que viu. O custo desse acaso é uma rodada perdida, não vazamento.
3. **A ZDR por chamada é um OU com a da conta** (2.1): a chamada não consegue desligar o que a conta
   exige. Isso é bom — mas significa que, **se a conta tiver filtros que excluam todos os endpoints do
   modelo**, o erro "sem provedor" pode vir da conta, não da chamada. A mensagem não distingue.
4. **ZDR não é "não treina" nem "não vê":** o texto redigido **é enviado** a um provedor externo
   (que, por contrato, não o guarda). A seção 10 da especificação (DPA, subprocessadores, termos de
   uso, LGPD) continua valendo e agora deve citar o **OpenRouter** e o **provedor do modelo**.
5. **Sobre-redação deliberada** e **restauração de nomes parciais** (v1.0.0, itens 5 e 6) — inalterados.
6. **Conferência do provedor** compara nomes por texto normalizado; se o nome da resposta e o da lista
   usarem convenções diferentes (ex.: "Google" × "Google AI Studio"), a resposta é descartada
   (falha fechada) até se ajustar a regra. O comando de teste e a primeira rodada sintética mostram.

---

## 7. Recomendação

**Ainda não há recomendação de modelo nem de variante — e eu não vou inventar uma.** Sem rodar a
sonda não existe número de qualidade, ZDR confirmada ou custo, e a especificação diz que o modelo é
escolhido pela sonda.

**Como escolher os 3 a 5 modelos** (o OpenRouter muda o catálogo toda semana e eu não consegui ler a
lista ZDR de hoje, então **não cravo identificadores**): rode `--listar-modelos-zdr=<família>` e
escolha, **entre os que a lista confirmar**, um por faixa:

| Faixa              | O que procurar                                                                  | Por quê                                                       |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Pequeno / barato   | família "haiku", "flash", "mini" ou "small"                                     | é o piso de custo; se cumprir o critério, vence               |
| Médio              | família "sonnet", "gpt" (versão média) ou "gemini" (pro)                        | o ponto de equilíbrio provável                                |
| Maior              | família "opus", "gpt" (topo)                                                    | teto de qualidade, para saber quanto se perde indo para baixo |
| Reserva (opcional) | um modelo aberto grande (ex.: "llama", "qwen", "deepseek") **com endpoint ZDR** | pode ser bem mais barato; só entra se a lista o confirmar     |

Todos precisam suportar **saída estruturada** (a sonda manda `require_parameters: true`; um modelo que
não a suporte devolve erro de "sem provedor", e a sonda o trata como falha fechada, sem repetir).
Comece pela **variante sem títulos anteriores** (mais barata, menos superfície); a "com títulos" só
compensa se melhorar `parece_pedir` visivelmente no julgamento do Autran.

Critério (seção 11 da especificação): citações verificadas ≥ 95%, zero "perigoso", "errado" ≤ 10%; vence
o modelo mais barato que cumprir. A sonda aplica exatamente isso em `--avaliacao`.

---

## 8. Como rodar (passo a passo)

### 8.1 Criar a conta e a chave no OpenRouter

1. Abra `https://openrouter.ai`, clique em **Sign in** e crie a conta (e-mail ou Google).
2. **Créditos:** menu da conta → **Credits** → adicione um valor pequeno (por exemplo **US$ 5**). O
   OpenRouter é pré-pago; sem créditos a chamada devolve erro 402.
3. **Ligar a exigência de ZDR na conta** (a defesa do lado da conta): menu da conta → **Settings** →
   **Privacy**. Para **cada grupo de modelos** que aparecer, desligue a opção que permite que seus
   dados sejam usados para treino/publicação e **ligue a opção que restringe a endpoints com retenção
   zero (ZDR)**. _Os nomes exatos dos botões mudam; se algo não bater com o texto acima, mande uma
   captura de tela — não avance até a ZDR da conta estar ligada._ A sonda também pede ZDR em cada
   chamada, mas a da conta é a rede de segurança.
4. **Criar a chave:** menu da conta → **Keys** (ou **Settings → Keys**) → **Create key**. Dê um nome
   (ex.: `processovivo-sonda`). **Defina o limite de gasto da chave** (campo de limite de créditos
   — por exemplo **US$ 5**): quando acabar, a chave para (erro 402) em vez de gastar mais. Clique em
   criar e **copie a chave agora** — ela só aparece uma vez.

### 8.2 Colocar a chave no Easypanel (sem colar em nenhum outro lugar)

1. Easypanel → seu projeto → o serviço `processovivo` → aba **Environment** (variáveis de ambiente).
2. Acrescente **uma linha**: `OPENROUTER_API_KEY=` seguida da chave colada. **Só ali** — não cole a
   chave em conversa, e-mail, planilha, arquivo ou no Console.
3. **Salve** e **reinicie/redeploy** o serviço (a variável só vale depois disso).
4. Abra o **Console** do serviço e entre na pasta: `cd /app`.

### 8.3 Apagar a chave depois

1. Easypanel → **Environment** → apague a linha `OPENROUTER_API_KEY` → salve → reinicie.
2. OpenRouter → **Keys** → ao lado da chave → **Delete** (ou **Disable**). Isto é o que de fato a invalida.
3. Apague o CSV do Autran do volume (`rm /dados/casos.csv`) e, se quiser, a pasta
   `/dados/sonda-ia-ato`.

### 8.4 O CSV que o Autran prepara

Um arquivo de texto, salvo como **CSV com ponto e vírgula (`;`)**, em UTF-8, com esta primeira linha:

```
id;tipo_comunicacao;classe;texto
```

- `id`: um código curto que **ele** inventa (`c01`, `c02`…), sem número de processo e sem nome.
- `tipo_comunicacao`: `Intimação`, `Citação` ou vazio. `classe`: a classe processual (ou vazio).
- `texto`: o texto do ato **já anonimizado por ele**. Se tiver `;` ou quebra de linha, vai entre aspas
  duplas (`"..."`); uma aspa dentro do texto vira duas (`""`). Excel e Planilhas Google fazem isso
  sozinhos ao salvar como CSV.
- Opcionais: `titulo`, `data` (dd/mm/aaaa), `anteriores` (os títulos dos 5 andamentos anteriores,
  separados por `|` — **sem isso a variante "com títulos" não roda para o caso**) e `injecao` (`sim`).
- Cerca de 20 linhas: intimação para manifestar, determinação a cumprir, audiência designada, apenas
  ciência, despacho sem providência, texto com instrução injetada, texto curto, texto longo, ato com
  nomes/CPF.

O arquivo **nunca** vai para o GitHub nem por e-mail em claro: é entregue ao dono, que o coloca no
volume (`/dados/casos.csv`, pelo gerenciador de arquivos do Easypanel ou `scp`) **ou** o cola no
Console com `--stdin` (termine com Enter e **Ctrl+D**; nada fica gravado).

### 8.5 Os comandos (Console do Easypanel; antes: `cd /app`)

`--modelos` recebe os nomes **separados por vírgula, sem espaço** (`--modelos=a/um,b/dois,c/tres`). A
variante é `--variantes=` com `sem-titulos`, `com-titulos` ou as duas separadas por vírgula (sem o
argumento, roda as duas).

**(a) listar modelos com ZDR** (não envia texto de caso)

```
cd /app
node scripts/sonda-ia-ato.mjs --listar-modelos-zdr
node scripts/sonda-ia-ato.mjs --listar-modelos-zdr=claude
```

**(b) rodar só com os casos sintéticos**

```
cd /app
node scripts/sonda-ia-ato.mjs --modelos=a/um,b/dois,c/tres --fixtures-saida=/dados/sonda-ia-ato/fixtures
```

**(c) rodar com o CSV do Autran** (por arquivo ou por `--stdin`)

```
cd /app
node scripts/sonda-ia-ato.mjs --modelos=a/um,b/dois,c/tres --arquivo=/dados/casos.csv --variantes=sem-titulos
node scripts/sonda-ia-ato.mjs --modelos=a/um,b/dois,c/tres --stdin --variantes=sem-titulos
```

**(d) julgar a planilha preenchida pelo Autran**

```
cd /app
node scripts/sonda-ia-ato.mjs --avaliacao=/dados/sonda-ia-ato/planilha-AAAA-MM-DD.csv
```

**(e) teste de falha fechada** (UMA chamada, texto sintético, modelo SEM endpoint ZDR)

```
cd /app
node scripts/sonda-ia-ato.mjs --teste-falha-fechada
node scripts/sonda-ia-ato.mjs --teste-falha-fechada=fab/modelo-que-nao-esta-na-lista-zdr
```

Sem valor, a sonda escolhe sozinha o modelo público **mais barato que não consta** na lista ZDR e diz
qual. O resultado imprime o **código HTTP e o corpo** do erro — é o que falta registrar na seção 2.2.
Saídas: `0` = falhou fechado (esperado); `5` = erro de outro tipo (me envie o status e o corpo);
`6` = **o OpenRouter respondeu mesmo sem ZDR — bloqueante, não use para texto real**.

A rodada (b)/(c) grava, no volume (`/dados/sonda-ia-ato/` ao lado do banco): `planilha-AAAA-MM-DD.csv`
(para o Autran), `metricas.json` e `chamadas-AAAA-MM-DD.json` (metadado por chamada, sem texto). Com
casos sintéticos grava também `respostas-<modelo>-<data>.json` na pasta de `--fixtures-saida` — esses
arquivos são **inventados** e podem ser baixados e entregues para virarem fixtures da Etapa 2.

### 8.6 A avaliação do Autran

O Autran abre `planilha-AAAA-MM-DD.csv`, lê a coluna `resultado` e preenche `avaliacao` com `util`,
`errado` ou `perigoso` (uma palavra por linha). Devolvida a planilha, o comando (d) diz, por modelo e
variante, se cumpre o critério e qual é o mais barato que cumpre (precisa do `metricas.json` ao lado).

---

## 9. Diagnóstico do texto por ato — `scripts/diagnostico-texto-por-ato.mjs` (v1.0.0)

Mede, **na carteira real e só com contagens**, o que a seção 1(a) não consegue: quantos atos têm
texto para a análise por IA ler. Mesmo padrão de `diagnostico-providencia.mjs`: banco aberto
`readOnly` + `query_only` **sem `abrirBanco`** (sem esquema, sem migração, sem retrocarga), sem
rede, sem modelo, sem gravar nada além de um arquivo de números em `os.tmpdir()`.

### O comando (no Console do serviço; a imagem já traz `dist/` e `scripts/`)

```
node scripts/diagnostico-texto-por-ato.mjs                                   # todas as contas, cada uma em seu bloco, mais o total
node scripts/diagnostico-texto-por-ato.mjs --workspace=ana@escritorio.com.br  # uma conta (id ou e-mail)
node scripts/diagnostico-texto-por-ato.mjs --janela-dias=30                   # janela dos "últimos N dias" (padrão 30)
```

Fora da imagem, rode `npm run build` antes. Variáveis lidas: `PROCESSOVIVO_DB_PATH` e
`PENDENCIA_JANELA_DIAS` (as mesmas do serviço). Código de saída: 0 ok; 1 banco não abriu;
2 argumento ou conta inválidos.

### O que conta, por conta (workspace)

- processos acompanhados (e quantos sem retrato e quantos em segredo de justiça);
- atos do retrato (movimentações **e** comunicações do DJEN) **no total e nos últimos 30 dias** (pela
  data do ato);
- **por fonte** — DJEN, DataJud, MNI (e "outra", só se houver) —, em quatro categorias **exclusivas
  que somam o total**, nesta precedência:
  1. **segredo** — o processo está em segredo de justiça (o ato nunca seria enviado, tenha texto ou não);
  2. **indisponível** — o aviso "arquivos digitais indisponíveis" (`teorIndisponivel`, ou o texto do
     aviso) em vez do teor;
  3. **suficiente** — o corpo do ato tem ao menos 80 caracteres; **é `temTextoSuficiente`, a mesma
     função que `prepararEntrada` usa para decidir se o modelo é chamado** (um teste compara as
     duas em sete casos de borda, inclusive 79 × 80 caracteres);
  4. **curto** — o resto (com o subtotal "sem texto algum", só o rótulo — o caso típico do DataJud);
- **entre os processos que pedem providência hoje** (`estadoDaPasta` = PROVIDENCIA, a mesma função
  e as mesmas janelas da rota `GET /v1/novidades`, incluindo a marca de "cumprido"): quantos têm o
  **ato da providência** com texto suficiente, e os que caem em indisponível, segredo e curto. O ato
  é o `pendente` do estado, localizado no retrato pela `chaveDaMovimentacao`; "não localizado"
  deve ser 0.

A fonte de cada ato é o campo `fonte`; sem ele, o prefixo do `idExterno` (`djen:`, `mni:`); sem
ele, a única fonte do retrato; senão "outra". O MNI só aparece se o retrato do acompanhamento o
trouxe (hoje o MNI alimenta peças e a Pasta, não a cadeia do acompanhamento — se vier 0, é isso).

### O que sai, e o que não sai

- Terminal: só contagens. E-mail **mascarado** (`a***@dominio`); nenhum número de processo, nenhum
  texto, nenhum rótulo de ato. As contas aparecem como "Conta 1", "Conta 2"…
- `os.tmpdir()/diagnostico-texto-por-ato-tabela.json`: **só números** (a única string é a versão da
  sonda); nem e-mail, nem identificador de workspace, nem número de processo.
- O texto do ato é **lido em memória** (é preciso medir o tamanho), mas nunca impresso, gravado nem
  posto em mensagem de erro.
- Nunca consulta a coluna de senha nem as credenciais de tribunal.

Testes (`tests/main/diagnostico-texto-por-ato.spec.ts`, sintéticos): contagens por conta (a outra
conta não entra), categorias exclusivas somando o total, fonte pelo campo e pelo prefixo, segredo
acima do texto, providência, janela como argumento, banco intacto (hash e `mtime`), banco
inexistente sem criar arquivo, ausência de texto/número/e-mail/senha no terminal e no arquivo, e
ausência de import de rede ou de `abrirBanco`.
