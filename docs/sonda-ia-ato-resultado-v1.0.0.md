# Sonda de IA do ato — resultado v1.0.0 (Etapa 1)

Documento: `sonda-ia-ato-resultado-v1.0.0` · 10/10/2026 · especificação:
`ia-analise-do-ato-especificacao-v1.0.0` (seções 4 a 7 e 11).
Versão da sonda: **1.0.0**. Versão do produto: **inalterada (0.37.6)** — esta etapa não muda
comportamento de produto, só acrescenta módulos puros, o transporte do gateway (ainda sem uso
no serviço) e a sonda.

Este documento **não contém texto, nome, CPF nem número de processo de caso real**. Tudo o que
está medido aqui veio de código e de capturas já versionadas; **a sonda ainda não foi rodada
contra modelo nenhum** (sem chave do gateway e sem rede neste ambiente). A seção 5 diz o que
isso quer dizer.

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
usuários**. Isso exige abrir o banco de produção, e a especificação (e o pedido) proíbem a sonda
de fazê-lo. Se o dono quiser o número antes da Etapa 2, o caminho seguro é uma **sonda de
contagem somente-leitura** no padrão de `scripts/diagnostico-providencia.mjs` (abre o banco com
`readOnly`, só imprime contagens). Não escrevi — não foi pedido — e deixo a decisão com o dono.

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

### (c) Configuração de chave de gateway de IA

**Não existe.** Nenhuma ocorrência de `AI_GATEWAY`, `VERCEL` ou de variável de IA em `src/`,
`.env.example` ou `DEPLOY.md`. Esta etapa não a acrescenta ao `env.ts`: a sonda lê
`AI_GATEWAY_API_KEY` direto do ambiente (é um script de operador). A validação no arranque do
serviço (`..._IA_HABILITADA`, etc.) é da Etapa 2.

---

## 2. Biblioteca escolhida

**`ai@7.0.137` (AI SDK da Vercel), versão exata, dependência de produção.** `createGateway`
vem do próprio pacote (`@ai-sdk/gateway@4.0.110`, trazido por ele).

Por quê:

- é o caminho **documentado** do gateway, e `providerOptions: { gateway: { zeroDataRetention:
true } }` é a forma nativa de pedir ZDR por requisição — confirmei no tipo
  `GatewayProviderOptions` e **no corpo HTTP que o SDK de fato envia** (teste de fio, seção 4);
- saída estruturada (`Output.object` + Zod) já vem pronta, e `maxRetries: 0` desliga a repetição
  escondida — qualquer repetição passa por código nosso, sempre com ZDR;
- `getAvailableModels()` devolve o preço por token do catálogo, que a sonda usa para estimar custo;
- o Zod do SDK (3.25.x) é compatível com o `^3.23.8` do projeto;
- alternativa descartada: chamar o endpoint do gateway com `fetch` próprio. Evita uma dependência,
  mas reimplementa protocolo, erros e esquema à mão — e o gateway tem protocolo versionado
  (`/v4/ai/language-model`) que o SDK acompanha.

Custo da escolha: a árvore de dependências cresce (`ai`, `@ai-sdk/*`, `@workflow/*`, `undici`,
`eventsource-parser` etc.; 10 pacotes a mais no `npm ci`). Nada nativo, nada para compilar no
Alpine. O CLAUDE.md abre exceção para o Zod; esta é uma segunda dependência de I/O em
`infrastructure/` e **precisa ficar registrada** lá na Etapa 2.

---

## 3. O que foi construído

| Peça                                                              | Onde                                                               | Observação                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Vocabulário fechado (`parece_pedir`, códigos de atenção, limites) | `domain/entities/vocabularioDaAnalise.ts`                          | sem imports; contrato entre modelo, verificação e tela     |
| `redigirParaIA` / `criarRedator`                                  | `application/politicas/redigirParaIA.ts`                           | pura; seção 5                                              |
| `verificarAnalise`                                                | `application/politicas/verificarAnalise.ts`                        | pura; seção 6; `VERSAO_DAS_REGRAS_DE_VERIFICACAO = 1.0.0`  |
| `prepararEntrada` (suficiência, truncamento, prompt)              | `application/politicas/entradaDoModelo.ts`                         | `VERSAO_PROMPT = ato-1.0.0`                                |
| Esquema Zod fechado                                               | `infrastructure/adapters/modelo/esquemaDaAnalise.ts`               | `.strict()`, sem limites de tamanho no que vai ao provedor |
| `TransporteGateway` (ZDR fixo)                                    | `infrastructure/adapters/modelo/TransporteGateway.ts`              | injetável; ZDR não tem parâmetro que o desligue            |
| Preços do catálogo                                                | `infrastructure/adapters/modelo/catalogoDoGateway.ts`              | só metadados públicos                                      |
| `ZdrIndisponivelError`                                            | `domain/errors/index.ts`                                           | subclasse de `ProviderIndisponivelError`                   |
| Núcleo, métricas, planilha, julgamento                            | `main/sonda/sondaIaAto.ts`, `comandoSondaIa.ts`, `casosDaSonda.ts` | adaptador de entrada: pode importar tudo                   |
| Comando                                                           | `scripts/sonda-ia-ato.mjs`                                         | fino, no padrão das outras sondas                          |
| 12 casos sintéticos                                               | `tests/fixtures/ia-ato/casos-sinteticos.json`                      | tudo inventado; CNJ com DV válido                          |

A Etapa 2 **importa** estes módulos (`redigirParaIA`, `verificarAnalise`, `prepararEntrada`,
`TransporteGateway`, esquema); nada deles precisa ser movido ou copiado.

Decisões de desenho que a especificação deixava abertas (todas reversíveis, todas testadas):

1. **`indeterminado` sem citação é resultado legítimo**, mostrado sem resumo. A seção 3.3 diz que
   "sem citação para o ponto principal o resultado é 'não foi possível analisar'", e a 3.4 que
   "indeterminado é uma resposta legítima" — as duas só convivem se `indeterminado` com
   `trecho_chave` vazio passar. Qualquer outro valor com citação inválida vira "não verificado".
2. **Expressão proibida derruba o resultado inteiro** (a seção 6.3 diz "resultado com elas é
   descartado"); número inventado e citação inválida de **ação** derrubam só o item.
   Número inventado no **resumo** descarta o resumo e mantém `parece_pedir` + citação.
3. **A lista de proibidas vale para o que o modelo escreve** (resumo e ação), **não para a
   citação** — a citação é literal do ato, e o ato pode legitimamente dizer "recorra".
4. **Número verificado por token com separador** ("10/11/2026" tem de aparecer assim, ou por
   extenso "10 de novembro de 2026"). Dígitos soltos que existem em outro lugar do texto não
   absolvem uma data inventada.
5. **Marcadores de pessoa seguem a ordem do retrato**, não a ordem de aparição: o texto redigido
   (e, na Etapa 2, a chave de cache) não varia conforme quais nomes o ato cita.
6. **Só o corpo do ato é verificado.** Classe, tribunal e os títulos anteriores vão num bloco
   `<contexto>` fora do campo `<ato>`; citar deles não verifica.
7. **A saída é validada duas vezes**: o SDK valida com o esquema, e a verificação confere forma
   (280/160 caracteres, 3 ações, 2 pontos). Os limites **não vão no esquema do provedor**: alguns
   recusam `maxLength` em saída estruturada, e a recusa derrubaria o modelo inteiro da comparação.

---

## 4. O que foi medido (sem rede)

Testes novos: **98** (arquivos de `redigirParaIA`/`verificarAnalise`/`entradaDoModelo`/transporte

- a sonda), todos verdes, sem rede e sem tempo real.

* **Redação:** cada padrão (CNJ formatado e corrido, CPF formatado/mascarado/corrido, CNPJ, e-mail,
  quatro formas de telefone, quatro de OAB), texto sem nada a redigir, prazo/data/valor
  **intactos**, nome parcial, caixa e acento, dois pedaços do mesmo nome → um marcador, palavra que
  só contém o nome, passada única, restauração, mesmo mapa entre ato e títulos.
* **Verificação:** citação com acento/caixa/espaço diferentes, inexistente, vazia, curta; número de
  dias, hora, data por extenso e numérica, número inventado em resumo e em ação; as expressões
  proibidas (incluindo a palavra que só _contém_ a proibida); limites de forma; saída que obedece
  à injeção.
* **ZDR:** (i) toda chamada ao SDK leva `zeroDataRetention: true`, temperatura 0 e nenhuma
  repetição automática; (ii) **no fio** — o SDK real, com o HTTP dublado — o **corpo da requisição**
  leva `providerOptions.gateway.zeroDataRetention: true`, o esquema fechado e nenhuma ferramenta;
  (iii) HTTP 400 `no_providers_available` vira `ZdrIndisponivelError` com **uma única
  requisição**; HTTP 500 também não é repetido pelo SDK; (iv) a sonda tira o modelo da comparação e
  nunca chama de novo; (v) todos os modelos sem ZDR → código de saída 3 e aviso.
* **Sonda:** recusa sem chave e com valor de exemplo (`pareceValorDeExemplo`), nunca imprime a
  chave; `--stdin` e `--arquivo` não gravam **nada** dentro do repositório (CSV real dentro do
  repositório é recusado; saída dentro do repositório é recusada, com a exceção de `dados/`, que
  já está no `.gitignore` e é o volume); o texto do caso real não aparece na planilha nem nas
  métricas; resposta crua só de caso sintético; os dados pessoais dos 12 casos sintéticos **não
  aparecem em nenhum prompt** enviado ao modelo dublado.
* **Injeção:** o texto sintético `s06` tenta fechar o campo (`</ato>`), mandar um valor fora do
  vocabulário, acrescentar um campo e fazer o modelo dizer "prazo fatal de 3 dias". O campo
  não é fechável (`<`/`>` neutralizados); valor fora do vocabulário e campo extra falham no esquema
  `.strict()`; "prazo fatal", número inventado e citação inventada falham na verificação.
  A sonda ainda conta o _canário_ (`CANARIO-7731`) para saber se o modelo **obedeceu**.

**Não medido (precisa de chamada real):** qual modelo atende, se a ZDR funciona **na conta**,
roteamento (quais provedores atenderam), latência p50/p95, tokens e custo por análise, taxa de
citações verificadas, taxa de descarte, taxa de "não verificado"/"indeterminado" **de cada
modelo**, comportamento real nos casos de injeção e o julgamento do Autran. Os números dessas
colunas só existem depois da rodada real.

---

## 5. O que a sonda não consegue medir, e riscos que ficam abertos

1. **Formato real do `providerMetadata.gateway`.** O SDK tipa esse campo como JSON livre. A sonda
   lê `routing.finalProvider`, `generationId` e `cost` (número ou texto numérico) e grava o objeto
   `routing` inteiro como veio, mas **o formato foi suposto**, não observado. Se vier diferente, o
   custo cai para a tabela de preços do catálogo (e a tabela diz a fonte) e o roteamento aparece
   como "—". Isso é para ser olhado na primeira rodada real.
2. **O corpo do erro `no_providers_available`** é reconhecido por texto (`type`, `code`, mensagem,
   corpo) porque o SDK não tem classe própria; o teste usa um corpo plausível. Se o gateway
   mudar o texto, o erro cai em "indisponível" genérico — **continua sem repetir e sem
   retenção**, mas deixa de ser rotulado como "sem ZDR". Também a ser conferido na rodada real.
3. **Plano da Vercel.** A seção 10 exige conta Pro ou Enterprise para ZDR por requisição. A sonda
   não consegue distinguir "plano insuficiente" de "modelo sem provedor ZDR": ambos podem aparecer
   como `no_providers_available`. **O dono precisa confirmar o plano** (decisão 13.5).
4. **Preço.** A tabela de preços sai do catálogo no momento da rodada (a data é impressa). Não há
   preço fixo no código.
5. **Truncamento de nomes parciais.** Quando um nome aparece só pelo primeiro nome ou por um
   pedaço, a restauração de marcador devolve o nome **completo do retrato**, que pode não casar
   caractere a caractere com o texto original do ato. Na Etapa 2, o destaque da citação ao lado do
   texto precisa degradar para "mostrar a citação restaurada, sem marca de posição" quando não
   achar o trecho no original.
6. **Sobre-redação deliberada.** Nome isolado de pessoa física com 4+ letras é redigido em todo o
   texto ("Silva" some mesmo quando é parte de outra palavra de nome comum). É o lado seguro; o
   custo é o modelo ler `[PARTE A]` onde havia um sobrenome comum. A rodada real mostra se atrapalha.

---

## 6. Divergências entre a especificação e o código

1. **Workspace sem assinatura passa livre** (`ServicoAssinaturas.exigir` devolve sem lançar
   quando não há assinatura — decisão registrada no `CLAUDE.md` para não derrubar integrações por
   chave de API). A especificação diz que "sem o recurso do plano IA, nenhuma chamada ao
   modelo". Aplicado literalmente, **uma chave de API sem assinatura chamaria o modelo sem plano
   nenhum**, gastando a cota do operador. Proposta para a Etapa 2: para `analiseIa` exigir
   assinatura **explícita** (não passar livre), além da cota mensal. **Preciso da sua decisão** —
   isso contradiz uma regra do CLAUDE.md e por isso não vou assumir.
2. **Cota "por workspace"** vs. workspaces de chave de API: mesma questão; a cota por workspace
   existe, mas o workspace da chave de API é o do operador.
3. **O CSV do Autran tem 4 colunas**, e a variante "com os títulos anteriores" precisa dos títulos
   anteriores. A sonda aceita uma 5ª coluna **opcional** `anteriores` (títulos separados por `|`).
   Sem ela, a variante "com títulos" só roda nos casos sintéticos. É uma extensão do formato que
   você pediu; ver o passo a passo para o Autran.
4. **A planilha tem uma coluna a mais:** `id;modelo;variante;resultado;avaliacao` (o pedido listava
   `id;modelo;resultado; avaliacao`). Sem `variante` não dá para saber de qual das duas rodadas é
   cada linha. A coluna `avaliacao` fica vazia, como pedido (valores: `util`, `errado`, `perigoso`).
5. **A spec cita `..._IA_HABILITADA` e semelhantes** com o "prefixo em vigor": o prefixo em vigor
   no `env.ts` para variáveis do produto é `PROCESSOVIVO_` (as de fonte usam `DATAJUD_`, `MNI_`,
   `LEITOR_`…). A Etapa 2 usará `PROCESSOVIVO_IA_HABILITADA`, `PROCESSOVIVO_IA_MODELO`,
   `PROCESSOVIVO_IA_COTA_MENSAL` e `PROCESSOVIVO_IA_ZDR`. O nome `AI_GATEWAY_API_KEY` é o do
   gateway e fica como está.

Nada na especificação conflita com o código no restante.

---

## 7. Recomendação

**Ainda não há recomendação de modelo nem de variante — e eu não vou inventar uma.** Sem rodar a
sonda não existe número de qualidade, ZDR ou custo, e a especificação diz que o modelo é escolhido
pela sonda.

O que posso recomendar sobre **como escolher os modelos** a comparar (nomes saem do catálogo do
gateway no dia; não fixo nenhum):

- um **pequeno/barato**, um **médio** e um **maior**, todos com **saída estruturada** e todos
  que o catálogo deixe usar com ZDR;
- começar pela **variante sem títulos anteriores**: ela é mais barata, tem menos superfície para
  o modelo citar o que não deve, e a variante com títulos só compensa se melhorar `parece_pedir`
  de forma visível no julgamento do Autran;
- rodar primeiro **só os casos sintéticos** (sem `--arquivo`), para ver o roteamento, a ZDR, o
  formato de custo e gerar as fixtures da Etapa 2; só depois os casos do Autran.

Critério (seção 11): citações verificadas ≥ 95%, zero "perigoso", "errado" ≤ 10%; vence o modelo
mais barato que cumprir. A sonda aplica exatamente isso em `--avaliacao`.

---

## 8. Como rodar (para quem não é técnico)

### O CSV que o Autran prepara

Um arquivo de texto, salvo como **CSV com ponto e vírgula (`;`)**, em UTF-8, com esta primeira linha:

```
id;tipo_comunicacao;classe;texto
```

- `id`: um código curto que **ele** inventa (`c01`, `c02`…), sem número de processo e sem nome.
  Aparece na planilha de volta, para ele reconhecer o caso.
- `tipo_comunicacao`: `Intimação`, `Citação` ou vazio.
- `classe`: a classe processual, como aparece na tela (ou vazio).
- `texto`: o texto do ato **já anonimizado por ele** (sem nome de parte, de advogado, CPF, número de
  processo, e-mail, telefone). Se o texto tiver `;` ou quebra de linha, vai entre aspas duplas
  (`"..."`); uma aspa dentro do texto vira duas (`""`). Excel e Planilhas Google fazem isso sozinhos ao
  salvar como CSV.
- Opcionais, se ele quiser: `titulo`, `data` (dd/mm/aaaa), `anteriores` (os títulos dos 5 andamentos
  anteriores, separados por `|` — **sem isso a variante "com títulos" não roda para o caso**) e `injecao`
  (`sim` nos casos com instrução injetada).
- Cerca de 20 linhas, cobrindo: intimação para manifestar, determinação a cumprir, audiência designada,
  apenas ciência, despacho sem providência, texto com instrução injetada, texto curto, texto longo e
  ato com nomes/CPF (a redação automática é testada nesse último).

Esse arquivo **nunca** vai para o GitHub, nem por e-mail em claro: é entregue ao dono, que o coloca no
servidor.

### Como o dono coloca o CSV no servidor (duas formas)

**Forma 1 — arquivo no volume.** No painel do servidor (Console / Terminal do contêiner `processovivo`):

1. Envie o arquivo para a pasta de dados do serviço (a mesma do banco, normalmente `/dados`). No
   CyberPanel, é o Gerenciador de Arquivos da pasta do volume; no terminal do VPS, `scp casos.csv
usuario@servidor:/caminho/do/volume/`.
2. Confira que chegou: `ls -l /dados/casos.csv`.
3. Rode a sonda apontando para ele (passo seguinte).
4. Quando terminar, **apague**: `rm /dados/casos.csv`.

**Forma 2 — sem criar arquivo (`--stdin`).** No Console do serviço, cole o conteúdo do CSV direto no
terminal:

```
node scripts/sonda-ia-ato.mjs --modelos=a,b,c --stdin
```

Cole o texto do CSV, tecle Enter e depois **Ctrl+D** (isso diz "acabou"). O texto não fica gravado em
arquivo nenhum.

### O comando

Primeiro, **só com os casos inventados** (sem arquivo), para ver se a conta do gateway e a ZDR
funcionam e para gerar as fixtures da Etapa 2:

```
AI_GATEWAY_API_KEY=<a chave, definida no ambiente do serviço> \
node scripts/sonda-ia-ato.mjs --modelos=<modelo-pequeno>,<modelo-medio>,<modelo-maior>
```

(Os nomes dos modelos são os do catálogo do AI Gateway, no formato `provedor/modelo`. A sonda não traz
nome nenhum fixo.) Depois, **com os casos do Autran**:

```
node scripts/sonda-ia-ato.mjs --modelos=<a>,<b>,<c> --arquivo=/dados/casos.csv
```

A sonda imprime a tabela (taxa de citações verificadas, descartes, "não verificado", "indeterminado",
latência p50/p95, tokens, custo por análise, injeção) e grava, na pasta `sonda-ia-ato/` ao lado do banco:
`planilha-AAAA-MM-DD.csv` (para o Autran) e `metricas.json`.

### A avaliação do Autran e o veredito

O Autran abre `planilha-AAAA-MM-DD.csv`, lê a coluna `resultado` e preenche `avaliacao` com `util`,
`errado` ou `perigoso` (uma palavra por linha). Devolvida a planilha, o veredito sai com:

```
node scripts/sonda-ia-ato.mjs --avaliacao=/dados/sonda-ia-ato/planilha-AAAA-MM-DD.csv
```

(o `metricas.json` precisa estar ao lado da planilha). A saída diz, por modelo e variante, se cumpre o
critério e qual é o mais barato que cumpre.
