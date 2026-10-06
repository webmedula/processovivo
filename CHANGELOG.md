# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento semântico: enquanto estiver em `0.x`, mudanças incompatíveis
entram como *minor*.

**Como descobrir qual versão você tem:** `node -p "require('./package.json').version"`
na raiz do projeto, ou o campo `versao` na resposta de `GET /health`.

---

## [0.36.0] — 2026-10-06

A lista da Pasta digital passa a mostrar **todas as movimentações** do processo, não
só as que têm peça. Num processo de 386 movimentações no Projudi (385 recebidas) a
lista tinha 279 linhas e a numeração parecia pular (386 → 382): atos sem documento
— conclusos, intimações, certidões — ficavam escondidos sem aviso.

### Adicionado

- **Uma linha por movimentação.** A movimentação sem peça é igual à de peça — número
  (exato / faixa / estimado / posição, "✓ conferido", "informar nº"), data e
  descrição —, com o selo "Sem peça" no lugar do estado e sem caixa de seleção.
  Atos com várias peças seguem em várias linhas, com o mesmo número. A ordem é a da
  lista de antes; o ato sem peça entra na posição cronológica dele.
- **Clique em movimentação sem peça:** cabeçalho "Mov. N · Movimentação" e a
  mensagem "Esta movimentação não tem peça (documento) anexada." Nenhuma consulta
  ao tribunal; a calibração do número continua disponível.
- **Contagem e filtros que dizem quantos são de cada tipo:** "X de M linhas · P
  peças · S sem peça"; chip "Sem peça (N)" (filtra); "só disponíveis" esconde as
  sem peça e informa quantas; a busca casa a descrição e o número delas. Todas,
  Nenhuma, Baixar PDF e Montar pasta completa continuam só sobre peças.
- **Lacuna de numeração, só quando provada:** entre dois atos vizinhos com número
  EXATO e salto maior que 1, uma linha discreta "nº 368 · ato não recebido do
  tribunal (provavelmente bloqueado)". Nunca em faixa ou estimado; não é linha
  (não conta, não abre) e some quando há filtro, dizendo quantas ocultou.
- **Listagem anterior à 0.36.0:** aviso "Esta lista tem só as peças" com o botão
  "Atualizar as peças" (o fluxo de sempre), sem erro e sem tela vazia.
- **Dados:** coluna `pasta_listagens.atos` (migração explícita, sem retrocarga):
  posição, data/hora, descrição e complemento de cada ato, gravados da mesma
  resposta do MNI. Só metadado do ato; mesmo workspace, mesma linha e mesma
  política de segredo da listagem. `GET …/pasta` ganha `todasAsMovimentacoes`,
  `atosSemPeca`, `lacunas`, `linhas` e `totais.atosSemPeca`.

### Alterado

- **Lista mais larga:** de 400 px fixos para `clamp(440px, 32vw, 520px)` (440 em
  1366 px, 520 de 1625 px em diante); o divisor arrastável continua. O visualizador
  mantém no mínimo 320 px. Sem rolagem horizontal em 1366, 1280, 1024, 768 e 390.
- **Descrição em até 2 linhas** (texto inteiro no mouse, no foco da linha e no
  cabeçalho do visualizador) e **placeholder da busca** encurtado para "Buscar
  rótulo, movimentação ou nº", sem corte em 1366 px.

### Não mudou

Cálculo da numeração (0.35.0), fila, limitador, cache de peças, isolamento por
workspace, PDF montado, leitor, calendário e planos.

---

## [0.35.3] — 2026-10-06

Layout da Pasta digital, pedido pelo dono depois de usar a Pasta com um processo
de ~280 peças: a lista começava na metade de baixo da janela.

### Alterado

- **A lista sobe e ocupa a altura da janela.** A Pasta passa a ter `100dvh` e a
  página por baixo deixa de ter altura além da janela (`documentElement.scrollHeight
  <= clientHeight`): rolam só a lista e o visualizador, cada um por dentro. Onde a
  primeira linha começava (1366×768 / 1920×1080, medido com 40 peças sintéticas
  a mais): **553 → 277 px** e **534 → 277 px**; linhas inteiras visíveis:
  **2 → 5** e **5 → 10** (a massa de teste tem descrições de 2 linhas; com linhas
  compactas cabem 6 em 768 px).
- **Avisos compactados, sem perder nenhum.** Mesmo texto, fonte de 12 px e
  espaçamento menor numa faixa só. "Lista obtida do tribunal… não é consulta ao
  vivo" e o aviso da numeração (0.34.0/0.35.0) continuam sempre à vista; nada foi
  recolhido.
- **A estimativa do "Montar pasta completa" saiu da faixa de avisos** e foi para
  uma dica ao lado do botão: aparece no mouse e no foco do teclado, descreve o
  botão (`aria-describedby`, `role="tooltip"`) e fecha com Escape. O texto é o
  mesmo.
- **Busca e "só disponíveis" na mesma linha; ações (Todas/Nenhuma/Baixar PDF),
  chips menores e o contador "N marcadas de M · mostrando X de M" no mesmo fluxo**,
  sem rolagem horizontal. A linha da lista ficou mais baixa (padding menor).
- Cabeçalho da Pasta, avisos, "Conferir numeração", busca e ações ficam fixos; só
  as linhas rolam. A barra do visualizador (zoom, página, buscar no texto, baixar)
  já era fixa, e agora há teste. A região da lista passou a se chamar "Lista de
  peças" e o visualizador, "Visualizador da peça".

### Testes

- `tests/browser/pasta-layout-navegador.spec.ts`: 1920×1080, 1366×768, 1024×768,
  768×1024 e 390×844 (sem rolagem horizontal, página parada, lista rolando por
  dentro, primeira linha no alto), avisos obrigatórios à vista, dica por foco,
  lista que não pula ao marcar, barra do visualizador fixa e axe nos dois temas.

## [0.35.2] — 2026-10-06

Três ajustes de interface pedidos pelo dono: um na Pasta digital, dois na página inicial.

### Alterado

- **Pasta digital: o número da movimentação ocupa o lugar do índice.** A lista
  mostrava um índice sequencial (1, 2, 3…) que o advogado lia como o número do ato
  no Projudi. Agora a coluna à esquerda do rótulo é o número da movimentação, nos
  formatos já calculados pela 0.35.0: exato `386` (com "✓ conferido"), faixa
  `380–381` (nunca arredondada), estimado `~386` e posição `385` (com o aviso do
  topo da 0.34.0). O "mov. N" repetido saiu da linha de metadados; "faixa" e
  "estimado" aparecem por extenso ao lado do rótulo. Peça sem número mostra "—",
  nunca o índice. O cabeçalho do visualizador passou de "13. Certidão" para
  "Mov. 369 · Certidão" (e "Mov. 380–381", "Mov. ~386"), e o "Ver tudo seguido"
  diz "Mov. N" em vez de "peça N". Coluna de largura fixa (8ch, fonte tabular), sem
  rolagem horizontal em 1280/1024/768/390 px. Leitor de tela: "Movimentação 386,
  conferida" / "faixa 380 a 381" / "estimada 386" / "sem número". Várias peças do
  mesmo ato seguem como linhas separadas com o mesmo número. O índice continua
  existindo como chave interna de ordenação; só deixou de ser exibido. Sem mudança
  em API, banco ou no cálculo do número.
- **Página inicial: "há N dias" virou "detectado há N dias"** (singular "detectado
  há 1 dia"; "detectado hoje") na atualização em destaque e nas anteriores. A
  contagem sempre foi desde a detecção, não desde a data do ato (que está no
  quadro à esquerda); agora a tela diz isso, e o tooltip explica. Janela,
  ordenação e contagem não mudaram.
- **Cartão "Pedem providência"**: "ato dos últimos 10 dias que abre prazo" →
  "…que pede providência", coerente com a regra de não anunciar prazo.

## [0.35.1] — 2026-10-06

Página inicial — dois ajustes pedidos pelo dono depois de usar o sistema.

### Alterado

- **"Últimas atualizações" mostra só o começo do texto do ato**: até ~220
  caracteres, cortado em limite de palavra, com "…" (em `aria-hidden`) e no
  máximo 3 linhas. O texto completo continua nos dados e na API; quem quer ler
  abre o processo ("Abrir processo", que só aparece quando houve corte). Vale
  para a atualização em destaque e para as anteriores expandidas. Não mudou
  contagem de não lidas, janela de 15 dias, "+N anteriores", "pede providência"
  nem a ordem, e nenhuma atualização deixa de aparecer. A função é pura e mora em
  `ui/trechoDeTexto.ts`; o console recebe o texto dela (`toString()`), então o
  teste exercita a mesma função que roda no navegador. `script.ts` não cresceu.

### Corrigido

- **"Peças baixadas" empurrava a coluna da direita para fora da página** quando o
  nome do arquivo era comprido e sem espaço. Causa: item de grade não encolhe
  abaixo do conteúdo (`min-width: auto`). Correção: `minmax(0, …)` nas colunas de
  `.duas-colunas` e de `.app`, `min-width: 0` nos filhos e `overflow-wrap:
  anywhere` no nome do arquivo, na linha de metadados e no título da atualização.
  O nome continua inteiro na tela, quebrado em linhas (sem truncar).

### Testes

- `tests/http/trecho-de-texto.spec.ts` (unidade) e
  `tests/browser/inicio-navegador.spec.ts` (Chromium: decisão de ~3.000
  caracteres mostra só o trecho; nome de 120 caracteres sem rolagem horizontal
  em 1280, 1024, 768 e 390 px; axe nos temas claro e escuro). Os testes de largura
  falham sem a correção de CSS.

---

## [0.35.0] — 2026-10-04

Pasta digital — **calibração do número da movimentação com o Projudi, feita pelo
advogado**. O número do Projudi conta também os atos bloqueados, que o MNI não
entrega; a 0.34.0 mostrava a posição com aviso, e isso não bastava. Agora o
advogado informa um ou mais números que vê no Projudi, e a tela mostra o número
exato SEMPRE QUE ISSO PUDER SER PROVADO — e uma faixa honesta quando não puder.

### Adicionado

- **Âncoras**: par (posição do ato, número no Projudi) informado pelo advogado.
  Regra: `número = posição + atos bloqueados antes`; o deslocamento
  `d = número − posição` é ≥ 0 e nunca diminui. Âncora que contradiz as outras é
  recusada ("Esse número não é compatível com os outros que você informou.").
  Até 50 por processo.
- **`numeroDoProjudi` (domínio, função pura)**: o próprio ato ancorado → exato;
  entre duas âncoras de mesmo `d` → exato; entre duas de `d` diferente → faixa
  `min–max`; antes da primeira → exato se `d = 0`, senão faixa `[pos, pos+d]`;
  depois da última → estimado (`pos + d`). Faixa nunca é arredondada. Sem âncora:
  a posição, como na 0.34.0.
- **API** (sem consulta ao tribunal): `PUT /v1/processos/:numero/pasta/calibracao`
  (`{ numeroProjudi, posicao? }`; sem `posicao` = o último ato recebido, o atalho
  "último número que você vê no Projudi"), `DELETE …/calibracao` e
  `DELETE …/calibracao/:posicao`. `GET …/pasta` traz `movimentacao.numero`
  (`{tipo: posicao|exato|faixa|estimado, …}`) por peça e `calibracao`
  (âncoras, quantos atos exatos/faixa/estimados, âncoras invalidadas) no topo.
  Erro novo: `CalibracaoDeNumeracaoInvalidaError` → 400.
- **Tela** (`ui/scriptPastaCalibracao.ts`; `script.ts` não cresce): bloco
  "Conferir numeração com o Projudi" no topo; "informar nº" na linha (mouse),
  tecla **N** na linha focada e botão no cabeçalho do visualizador abrem o mesmo
  editor. Exato = "mov. 382 ✓ conferido"; faixa = "mov. 380–381"; estimado =
  "mov. ~386"; sem calibração = "mov. 385" como antes. O aviso do topo muda
  ("Calibrada por você com N números…") e não some enquanto houver número não
  exato. Busca por número casa por igualdade e, numa faixa, quando o número está
  dentro dela (a linha vem rotulada). "Limpar calibração" e remoção individual.
- **Banco**: tabela `pasta_ancoras` (por workspace) com a `dataHora` do ato;
  colunas `pasta_listagens.datas_dos_atos` e `ancoras_invalidadas` (migração
  explícita, sem retrocarga: as datas só existem na resposta do tribunal).
  Âncora cujo ato mudou de data numa listagem nova é descartada e a tela avisa
  "Calibração anterior invalidada".

### Detalhes

- Nada é escondido por causa da calibração; "mostrando X de M" segue valendo.
- Sem calibração a tela é a da 0.34.0. Listagem gravada antes da 0.35.0 não tem
  as datas: para calibrar é preciso recarregar as peças do processo.
- Não detecta ato bloqueado sozinha, não usa DataJud e não lê o texto das peças.
- PUT exige o plano com peças, como o resto da Pasta; remover não exige.

---

## [0.34.0] — 2026-10-04

Pasta digital — **o número da movimentação volta, agora como a POSIÇÃO do ato**,
com aviso claro da limitação. Decisão do dono (04/10/2026) depois de ver a tela
do Projudi e a sonda de numeração.

### Adicionado

- **`mov. N` na linha da peça** (N = posição 1-based do ato na ordem cronológica
  dos atos que o MNI entregou; desempate estável por `dataHora` e
  `identificadorMovimento`). Tooltip: "Número calculado pela ordem dos atos
  recebidos do tribunal. Pode ficar abaixo do número do Projudi se o processo
  tiver atos bloqueados."
- **Aviso fixo no topo da Pasta** enquanto houver número na lista: "Numeração das
  movimentações calculada pelo Processo Vivo a partir de N atos recebidos do
  tribunal. Se o último número que você vê no Projudi for maior que N, há atos
  bloqueados que não recebemos…".
- **Cabeçalho do visualizador**: "Movimentação nº N · data — descrição", com o
  aviso curto ao lado.
- **Busca por número**: "382" ou "mov. 382" casa por igualdade com a posição
  ("382" não acha "1382"); placeholder e `aria-label` voltam a citar o número.
- `GET …/pasta`: `totalAtosRecebidos` no topo e `movimentacao.posicao` por peça.
  `identificadorMovimento` continua sem sair como número.
- Banco: coluna `pasta_listagens.total_atos_recebidos` (migração explícita, sem
  retrocarga: só o tribunal sabe o N). Listagens gravadas antes ganham os campos
  na próxima vez que a tela recarrega as peças — sem consulta nova ao tribunal.

### Detalhes

- A posição é calculada sobre a lista COMPLETA de movimentos que já vem na
  resposta do MNI à listagem de peças (`movimentos: true`), não só os que têm
  documento. Nenhuma consulta nova.
- **Limite honesto:** o Projudi conta também atos bloqueados que o MNI não
  entrega, então a posição só iguala o número do Projudi até o primeiro desses
  atos. Não há detecção nem calibração (fora do escopo). O mapper do MNI descarta
  movimento sem `dataHora`, que então também não entra na contagem.
- `CLAUDE.md`: a regra "não há mov. N" (0.33.3) foi substituída pela regra da
  posição, preservando o histórico do erro da 0.33.2.

## [0.33.3] — 2026-10-03

Pasta digital — **corrige o "mov. N" da 0.33.2, que estava errado**. O número
mostrado (ex.: 516017862) era o `identificadorMovimento` do MNI, um identificador
INTERNO do tribunal; o que o advogado vê no Projudi é a numeração sequencial do
ato. Usamos o campo errado e a 0.33.2 foi aprovada sem conferir contra o tribunal.

### Corrigido

- **Nenhum número de movimentação é mais exibido**: saiu da linha da lista, do
  cabeçalho do visualizador ("Movimentação · data — descrição") e da busca (que
  não procura mais por número; placeholder e `aria-label` ajustados). A descrição
  do ato, que estava correta, continua.
- `GET …/pasta`: `movimentacao` deixa de trazer `numero` (`data`, `descricao`,
  `complemento`). Quem consumia o campo deve parar.

### Detalhes

- **Por que remover e não derivar:** nenhuma resposta do MNI mapeada pelo projeto
  traz o número sequencial (atributos de `<movimento>`: `identificadorMovimento`,
  `dataHora`, `nivelSigilo`, filhos de classificação e `complemento`; de
  `<documento>`: `idDocumento`, `movimento`, `descricao`, `mimetype`, `dataHora`,
  `nivelSigilo`). Derivar pela posição exigiria conferir contra o Projudi — a
  verdade de campo não foi informada — e depender de que o sistema receba todos
  os atos (atos internos podem não vir). Sem confirmação, fica sem número.
- O `identificadorMovimento` continua sendo a chave INTERNA do vínculo peça → ato.
- Regressão: teste com identificador longo (516017862) que não pode aparecer na
  tela, no cabeçalho, na busca nem na resposta da API.

## [0.33.2] — 2026-10-03

Pasta digital — **cada peça mostra o ato a que pertence**. Pedido do dono: 111 de
279 peças de um processo real chegam rotuladas só "Outros", e o advogado não
tinha como identificá-las na lista.

### Adicionado

- **Descrição e número da movimentação em cada peça da lista.** Rótulo, data e
  estado como antes; abaixo, a descrição do ato em até 2 linhas e "mov. N" ao lado.
  Texto inteiro no mouse, com a linha em foco (teclado) e no cabeçalho do
  visualizador. Várias peças do mesmo ato repetem a descrição (sem agrupar).
- **A busca da lista procura também na descrição e no número da movimentação**
  (o número casa por igualdade: "382" não acha 1382). O contador "mostrando X de M
  (K escondidas pelos filtros)" segue valendo.
- `GET …/pasta`: cada peça traz `movimentacao` (`numero`, `data`, `descricao`,
  `complemento`) ou `null`. Procedência `aoVivo:false` em toda resposta.

### Detalhes

- **Fonte dos campos (MNI, tribunal):** vínculo `documento@movimento` ↔
  `movimento@identificadorMovimento` da mesma resposta; descrição =
  `movimentoLocal@descricao` (ou `descricao`); complementos = `complemento`s do
  ato; número = `identificadorMovimento`. Nenhuma consulta nova: os dados já vêm
  na listagem que a tela do processo grava, e agora ela grava também o ato.
- **Não se inventa:** sem os dois lados do vínculo (peça aponta ato que a resposta
  não trouxe, número repetido, ato sem data) a linha fica como era, sem bloco
  vazio. Número citado dentro da descrição é texto, nunca link nem número do ato.
- **Listagens gravadas antes desta versão** não têm o ato; ele aparece na próxima
  vez que a tela do processo carregar as peças (sem consulta automática ao
  tribunal para recuperar).
- Sem conteúdo de peça lido, sem mudança na fila, no limitador, no cache nem no
  isolamento por workspace.

---

## [0.33.1] — 2026-10-03

Pasta digital — **a tela** (Parte 2). Fecha a entrega da 0.33.0: o backend já
estava na tag anterior. Especificação: `docs/ajustes-e-pasta-digital-especificacao-v1.0.0.md`
(seções 5 a 8).

### Adicionado

- **Pasta digital** (`ui/scriptPasta.ts`, `ui/estilosPasta.ts`): lista de todas as
  peças à esquerda — ordem dos autos, rótulo, data, estado (não baixada, na fila,
  baixando, disponível, não obtida com motivo, sob sigilo), intervalo `p. N–M` quando
  o PDF montado existe, caixas de marcar, atalhos por tipo, "Todas (N)" /
  "Nenhuma", contador "N marcadas de M · mostrando X de M (K escondidas pelos
  filtros)", busca por rótulo, filtro "só disponíveis" e teclado completo
  (setas, Home/End, Enter abre, Espaço marca) — e o visualizador PDF.js à direita.
- **Clicar baixa só a peça.** O clique espera 400 ms (outro clique troca o
  agendado) antes de pedir; peça já guardada abre sem pedido. Estados honestos no
  visualizador: pedindo, **aguardando a fila do tribunal** (com a explicação de
  que há uma montagem andando e a pausa de 3 s), baixando, pausado pelo tribunal
  até HH:MM, sem habilitação nos autos, não obtida com o motivo, sob sigilo, e
  "obtida em dd/mm hh:mm, não é consulta ao vivo". Nunca "carregando" sem fim:
  limites de 120 s (peça) e 30 s (abrir PDF), e três falhas de consulta param a
  tela com "tentar de novo".
- **Montar pasta completa** (estimativa antes, confirmação acima de
  `LEITOR_CONFIRMAR_ACIMA_DE`, leitura enquanto monta, progresso e pausa do tribunal
  com a hora), **Ver tudo seguido** (PDF combinado; clicar numa peça com `p. N` leva
  até a página) e **Baixar PDF (N)** das marcadas, que antes mostra "serão
  buscadas K peças no tribunal (~tempo)" e baixa `processo-<n>-pecas-selecionadas.pdf`.
- Listagem ausente (409): mensagem clara e "Tentar de novo", que carrega as peças
  do processo e repete. Sem listagem ao abrir, a tela carrega as peças do processo.
- Divisor arrastável (e por teclado), largura lembrada e sempre limitada à janela;
  no celular a lista ocupa a tela e a peça abre em tela cheia com "voltar".
- Teste de navegador (Chromium, `playwright-core`, `axe-core` como dependências de
  desenvolvimento): cliques rápidos geram UM lote no tribunal falso; montagem com
  clique no meio; 403; 409; teclado; celular; divisor; axe nos temas claro e escuro.

### Alterado

- **Substitui o painel "Ler peças ao lado".** O botão do cartão das peças agora é
  "Pasta digital". Saíram `scriptLeitor.ts`, `estilosLeitor.ts`, as caixas de marcar
  na linha do tempo, "Reabrir o PDF já pronto" e o recorte por extratos na
  interface (as rotas da API continuam).
- O servidor só diz **"baixando"** quando a consulta ao tribunal de fato saiu; antes
  disso o pedido está "na fila" (um job em andamento, a pausa de 3 s).
  `ServicoLeitor.consultarLote` ganhou o aviso de início.
- O job do leitor confere a guarda por peça antes de CADA lote: uma peça aberta por
  clique durante a montagem não é baixada duas vezes.

---

## [0.33.0] — 2026-10-03

Pasta digital — **backend** (Parte 1). A tela (lista à esquerda, visualizador à
direita) vem na Parte 2; até lá o botão "Ler peças ao lado" continua como era.
Especificação: `docs/ajustes-e-pasta-digital-especificacao-v1.0.0.md` (seções 5 a
10). Medições: `docs/pasta-digital-medicoes-v0.33.0.md`.

### Adicionado

- **Abrir UMA peça ao clique.** `POST /v1/processos/:numero/pasta/pecas/:pecaId`
  pede só aquela peça ao tribunal (método em lote, lote de 1), guarda e serve em
  `GET …/arquivo` (PDF com `Range`, para o PDF.js). 200 = já estava em guarda,
  nenhuma chamada ao tribunal; 202 = na fila. HTML do tribunal vira texto no
  servidor e imagem vira página de PDF **na entrada** — o original não fica.
- **O clique não é uma chamada.** `ServicoPasta` guarda um pedido pendente por
  (workspace, processo): clique em peça diferente troca o pendente e só o último,
  depois de `PASTA_DEBOUNCE_MS` (400 ms), vai ao tribunal. Sem pré-busca; sem
  retry (a falha vira o estado da peça, com o motivo; 403 carrega a hora de volta).
- **Guarda por peça** (`GuardaDePecas`, `pasta_pecas`): por workspace, nome
  aleatório, fora do diretório servido e do backup, TTL de `LEITOR_TTL_HORAS`,
  limpeza pelo `Agendador`, e a MESMA cota por workspace do PDF combinado — a
  regra de substituição da v0.31.1 agora vale para os dois (e nunca tira o que um
  job em andamento usa). Peça e processo sob sigilo nunca são guardados.
- **Lista da Pasta** (`GET …/pasta`): todas as peças na ordem dos autos com
  estado (`nao_baixada`, `na_fila`, `baixando`, `disponivel`, `nao_obtida`
  com motivo, `sigilo`), intervalo de páginas quando o PDF montado existe, totais
  SEM filtro, pausa do tribunal e procedência (`aoVivo: false`). Não consulta o
  tribunal: lê a listagem gravada quando a tela carrega as peças do processo
  (`pasta_listagens`).
- **Montar pasta completa** (`POST …/pasta/montar`): job do leitor para todas as
  peças; só as não sigilosas fora da guarda vão ao tribunal, e o estado de cada
  peça muda conforme os lotes chegam. Idempotente.
- **Baixar as marcadas** (`POST …/pasta/baixar`, e `…/baixar/previa` para dizer
  antes quantas peças serão buscadas): junta na ordem dos autos, com índice
  próprio, usando a guarda e buscando só o que falta — tudo em guarda custa zero
  consultas. Nome: `processo-<número>-pecas-selecionadas.pdf`.
- Erros de domínio: `ListagemDaPastaAusenteError` (409),
  `PecaDaPastaNaoEncontradaError` (404, igual para "não existe" e "é de outro"),
  `PecaSigilosaNaoGuardadaError` (403), `PastaSemPecasParaJuntarError` (409).
- Motivos de peça não obtida: `sem_habilitacao` e `bloqueio_do_tribunal`.
- `PASTA_DEBOUNCE_MS` em `.env.example`.

### Alterado

- **Toda chamada ao tribunal sai por uma fila só** (`ServicoLeitor.consultarLote`):
  a pausa de 3 s passa a valer entre TODAS as chamadas — as do job e as dos
  cliques —, não só entre as do mesmo job. Continua um único `MniAdapter`, um
  balde, um disjuntor de 403.
- **O leitor guarda cada peça baixada na guarda por peça** (já como PDF) em vez da
  pasta de trabalho do job: a peça pode ser aberta antes de o combinado ficar
  pronto, e peça já guardada não volta ao tribunal. O índice continua dizendo
  `convertida`/`html_convertida`. O job ganhou `finalidade`
  (`pasta_completa` | `selecionadas`; ausente = seleção livre da v0.31).
- `visaoDoJob` ganhou `finalidade`. `ProvedorDePecas` ganhou `pausadoAte?()`
  opcional. `ArmazemDoLeitor` ganhou `gravarArquivo`, `apagarArquivo` e
  `removerTemporarios`.

### Observação de capacidade

Uma pasta completa ocupa **o dobro** do PDF combinado em disco (peças em guarda +
combinado). Com o teto de 300 MB por PDF, até ~600 MB dos 1 GB da conta. Ver
`docs/pasta-digital-medicoes-v0.33.0.md`.

---

## [0.32.1] — 2026-10-02

Três ajustes pedidos por advogados que usaram o sistema. Especificação:
`docs/ajustes-e-pasta-digital-especificacao-v1.0.0.md` (seções 2 a 4).

### Alterado

- **Atualizações: uma linha por processo.** A atualização mais recente fica em
  destaque e as anteriores do mesmo processo ficam atrás de "+N anteriores", que
  expande na própria linha. A janela padrão é de 15 dias (`NOVIDADES_JANELA_DIAS`),
  com a alternância "Últimos 15 dias | Todas" e o aviso "N atualizações mais
  antigas não mostradas". Nada é descartado, e `exigeAcao` não filtra: ele só
  MARCA — uma anterior que pede providência avisa no botão fechado e continua
  marcada depois de aberto. Menu e painel seguem contando atualizações não
  vistas, não linhas. `GET /v1/novidades` ganhou `grupos`, `janelaDias`,
  `janelaPadraoDias` e `foraDaJanela` (`?janela=todas` desliga a janela); o campo
  `novidades` continua, achatado. A tela mora em `ui/atualizacoes.ts`.
- **Tela do processo:** o card "Peças do processo" vem logo depois dos dados do
  processo (capa e ficha). Os demais blocos mantêm a ordem relativa.
- **"Pede providência": janela de 30 para 10 dias**, configuração única
  `PENDENCIA_JANELA_DIAS` lida pelo selo da carteira, pelo card do painel e pelo
  bloco da tela do processo (o servidor entrega o valor: `cards.pendenciaJanelaDias`
  em `/v1/painel` e `pendenciaJanelaDias` em `/v1/facetas`). O bloco lista só os
  atos dentro da janela e diz quantos atos anteriores que pedem providência ficaram
  de fora ("veja na linha do tempo"), que continua marcando todos. Não é cálculo
  de prazo.

### Adicionado

- `NOVIDADES_JANELA_DIAS` (15) e `PENDENCIA_JANELA_DIAS` (10) em `.env.example`.
- `domain/entities/agruparNovidades.ts` (agrupamento e janela, relógio injetado).

---

## [0.32.0] — 2026-10-02

Calendário: agenda por workspace, com eventos lidos dos andamentos (sugeridos,
a confirmar) e eventos criados pelo advogado, numa tela do console e num feed
ICS assinável. Especificação: `docs/calendario-especificacao-v1.0.3.md`.

### Adicionado

- **Detecção de eventos nos andamentos** (`domain/entities/deteccaoDeEventos.ts`),
  função pura: só data EXPLÍCITA (`dd/mm/aaaa`, `dd/mm/aa`), com hora opcional
  (`14:30`, `14h30`, `14h`, `14 horas`), colada a um gatilho na mesma frase —
  audiência (conciliação, instrução, julgamento, una…), perícia/pericial,
  sessão de julgamento. Prazo só com data final escrita ("até 20/10/2026");
  **"prazo de N dias" não gera evento** — o sistema não calcula prazo. Data
  passada, data que não existe, ano a mais de 3 anos, dois tipos de gatilho na
  mesma frase e data alternativa presa ao mesmo gatilho não geram nada.
  "Cancelada", "retirada de pauta", "redesignada", "adiada" e "desmarcada" não
  criam sugestão: marcam para revisão os eventos detectados antes, do mesmo
  processo e tipo. O trecho guardado como procedência sai sem nome de parte
  nem de advogado e sem CPF/CNPJ.
- **Ingestão sem poder derrubar o sync.** Um decorator sobre a porta das pastas
  (`application/services/ingestaoDoCalendario.ts`) roda a detecção depois de
  toda gravação de retrato — varredura, "acompanhar" e vigilância por OAB —,
  relendo os andamentos dos últimos 180 dias. Falha vai para o log; a
  sincronização segue. Idempotente pelo índice único da chave de detecção, que
  cobre também os descartados.
- **Redesignação com data nova vira sugestão** (decisão do dono, spec v1.0.3):
  "audiência redesignada para o dia 20/11/2026 às 14h" sugere a data nova e
  mantém a antiga marcada para revisão. Duas datas na frase: vale só a que vem
  logo depois de "para"; se não for claro, não gera.
- **Tela do calendário** (`ui/calendario.ts`, arquivo próprio — `script.ts`
  não cresceu): item "Calendário" no menu; visões Agenda (padrão) e Mês, com
  anterior/próximo/hoje; sugerido com rótulo escrito "Sugerido", procedência
  ("lido do andamento de dd/mm/aaaa"), trecho e "ver o andamento" (abre o
  processo e destaca o andamento na linha do tempo); Confirmar, Editar,
  Descartar; aviso de revisão; descartados fora da lista com a contagem dita;
  formulário de evento com busca na carteira; painel "Assinar no meu
  calendário" (criar, regenerar, revogar, copiar a URL mostrada uma vez,
  incluir sugeridos, instruções para Google, Outlook e Apple). Sem o recurso no
  plano, a mensagem do servidor e o resto do console igual.
- **`/?processo=<número>`** abre a tela do processo — é o link da descrição do
  evento no feed.
- **`PATCH /v1/calendario/feed`** altera só "incluir sugeridos", sem trocar o
  token.
- **Preenchimento retroativo** pelo `Agendador` (de hora em hora, só banco):
  relê os andamentos já gravados de cada workspace uma vez.
- **Rotas** `GET/POST /v1/calendario/eventos`, `PATCH /v1/calendario/eventos/:id`
  (editar; `estado: "confirmado"` confirma), `POST .../:id/descartar`,
  `POST/GET/DELETE /v1/calendario/feed`. Intervalo máximo de 400 dias; a
  listagem devolve `totalNoIntervalo` (sem o filtro de estado) junto.
- **Feed ICS público** em `/calendario/feed/<token>.ics` — fora do `/v1`, porque
  a URL vive anos no calendário de quem assina. Token de 32 bytes, só o SHA-256
  no banco, URL completa mostrada uma vez, comparação em tempo constante,
  limite de 120 requisições/min por IP, `Cache-Control: private, max-age=300`,
  sem cookie. Token inválido, revogado, assinatura bloqueada ou plano sem o
  recurso: o MESMO 404. RFC 5545: CRLF, dobra em 75 octetos, escapes, `UID`
  estável, `SEQUENCE`, `VTIMEZONE` fixo em -03:00, dia inteiro sem deslocar o
  dia, `CANCELLED` por 30 dias, janela de -30/+365 dias. O feed leva só tipo e
  número do processo — sem nome de parte, trecho ou observação; processo em
  segredo de justiça vai sem número.
- **Recurso `calendario`** em todos os planos: na semente e, por retrocarga
  ÚNICA no arranque (marca em `estado`), em todo plano já gravado. Plano criado
  pelo painel o inclui por padrão. O operador pode tirá-lo depois; o arranque
  seguinte respeita.

### Alterado

- O log de acesso registra o PADRÃO da rota do feed (`/calendario/feed/:arquivo`)
  em vez do caminho: o caminho é o token.

### Dependência de desenvolvimento

- `ical.js` (o parser de iCalendar do Thunderbird), só nos testes, para validar
  o feed com um leitor independente.

## [0.31.2] — 2026-10-02

Diagnóstico do DataJud: o `GET /ready` reprovava a fonte ("timeout ao contatar
a API do CNJ") enquanto as consultas reais funcionavam no mesmo minuto.

### Alterado

- **Timeout na verificação de saúde do DataJud vira "lenta", não "fora do
  ar".** O diagnóstico devolve `saudavel: true, lenta: true` e um motivo que
  explica o índice frio do CNJ (20,5s medidos) e o teto maior das consultas.
  Falha de rede (conexão recusada, DNS), chave recusada, 429 e 5xx continuam
  reprovando. O `/ready` mostra `lenta: true` na fonte e segue 200; `cli saude`
  imprime `LENTA`.
- **Teto da verificação de 15s para 30s**, configurável em
  `DATAJUD_TIMEOUT_VERIFICACAO_MS` (novo, em `.env.example`). As consultas
  continuam com `DATAJUD_TIMEOUT_MS` (60s).

O resultado da verificação só informa (`/ready`, `cli saude`): a escolha da
fonte numa consulta não depende dele (`verificarSaude` está desligado no
composition root).

## [0.31.1] — 2026-10-02

Ajustes do leitor de peças pedidos depois do teste do dono com a 0.31.0.

### Alterado

- **Remarcar.** "Ler peças ao lado" abre com **"Nova seleção"** e, quando há
  um PDF guardado no prazo, **"Reabrir o PDF já pronto"** com a data e a hora
  em que foi montado. A seleção nova começa com **todas as caixas desmarcadas**
  (antes vinha com a seleção anterior, e remarcar virava desmarcar uma a uma);
  **"Limpar seleção"** fica sempre à mão, e **"Repetir a seleção anterior"** é
  um botão separado. O botão do topo do painel passou de "Marcar peças" a
  "Nova seleção".
- **Peça já guardada não volta ao tribunal.** Numa seleção nova, a peça que
  está em algum PDF deste processo ainda no prazo tem as páginas copiadas de
  lá; só a realmente nova é pedida — o mesmo caminho do "Atualizar". A tela diz
  quantas das marcadas são reaproveitadas, e a estimativa de tempo conta só as
  outras. `GET /v1/processos/:numero/leitor` passou a devolver também `pronto`
  (o PDF guardado mais recente) e `reaproveitaveis` (ids).
- **A seleção nova gera PDF NOVO e o anterior fica** até o próprio prazo (24 h).
  Só a atualização substitui o PDF de que partiu. **Regra de substituição pela
  cota:** com a conta no limite, saem primeiro os PDFs mais antigos de OUTROS
  processos, depois os deste; nunca um PDF de que uma combinação em andamento
  ainda vai copiar páginas (a limpeza do prazo também espera). Se nada puder
  sair, 413 antes de qualquer consulta. Antes, cota cheia era sempre recusa.

### Adicionado

- **"Baixar selecionadas (N)"**, no painel do PDF pronto ("Baixar só algumas
  peças deste PDF"): gera um PDF só com as páginas das peças marcadas,
  **recortadas do PDF guardado** — nenhuma consulta ao tribunal. Ordem dos
  autos, índice próprio contado do arquivo gerado, linearizado, nome
  `processo-<numero>-pecas-selecionadas.pdf`. Mesmo isolamento por workspace,
  mesma cota e mesmo prazo do PDF de origem (até 3 recortes por PDF). Rotas:
  `POST /v1/processos/:numero/leitor/:jobId/extratos` e
  `GET .../extratos/:extratoId/pdf` (com `Range`).
- `PdfDoLeitorExpiradoError` (**410**): o PDF de origem já saiu do disco. A tela
  diz isso e manda montar de novo pela "Nova seleção" — nunca baixa de novo em
  silêncio. `PecasForaDoPdfError` (400) para peça que não está naquele PDF.
- Motivo `origem_expirada` no índice: a peça seria reaproveitada de um PDF que
  foi apagado entre a listagem e a montagem — vira página de aviso, não erro.

### Corrigido

- **"Fechar" e "Baixar PDF" cortados na borda direita.** Medido no Chromium: o
  `<select>` "Ir para a peça" tem a largura da opção mais longa (728 px com
  rótulo longo do TJGO) e passava da borda do painel em qualquer janela, de
  1500 a 600 px de largura; e a largura arrastada no divisor, guardada no
  navegador, podia ser maior que a janela atual. Agora o painel usa
  `min(largura, 100vw)`, a largura guardada é ajustada à janela (sem perder a
  preferência), e nada dentro do painel empurra a borda (`min-width: 0`).
- Fechar e reabrir o painel sem a tela redesenhar deixava a seleção sem peças
  ("0 peças marcadas" ao clicar nas caixas).
- Um PDF novo que ficava pronto com outro PDF aberto no painel não era
  carregado: o painel continuava mostrando o anterior.

## [0.31.0] — 2026-10-01

Leitor de peças, **Etapa 2 — ler ao lado** (especificação
`leitor-e-analise-especificacao-v1.2.1`, seção 5). O PDF combinado da 0.30.0
abre num painel à direita da linha do tempo.

### Adicionado

- **Botão "Ler peças ao lado"** no cartão das peças do processo. Sem clicar
  nele, a tela do processo é exatamente a de antes (decisão do dono: o painel
  abre por botão).
- **Marcar peças na linha do tempo**: uma caixa ao lado de cada peça, "Selecionar
  todas (N)" com o número do processo inteiro (não só o da tela filtrada),
  atalhos por rótulo do tribunal (Petição, Certidão, Decisão…), contador e
  **estimativa de tempo em faixa** calculada no servidor com os números medidos
  (lote crescendo 5, 10, 20 até lote sem crescer), dita como ordem de
  grandeza. Acima de `LEITOR_CONFIRMAR_ACIMA_DE` peças (150), confirmação.
  Peça sob sigilo aparece desmarcável e com o motivo.
- **Painel à direita** com divisor arrastável (largura guardada no navegador);
  no celular, tela cheia com "← linha do tempo" e botão flutuante para voltar.
  Em arquivo próprio (`ui/scriptLeitor.ts`, `ui/estilosLeitor.ts`), fora do
  `script.ts`.
- **PDF.js servido pelo próprio servidor** (`/ui/pdfjs/:arquivo`, lista fechada,
  pública por ser biblioteca sem dado), carregado por `import()` — a página
  continua sem `<script src>`. Usa o build **legacy** do `pdfjs-dist`: o padrão
  usa `Map.getOrInsertComputed`, recurso de 2025, e a página ficava em branco
  sem erro em navegador não atualizado.
- **Leitura por trechos** (`Range`, sem baixar o resto em segundo plano) e
  **renderização preguiçosa**: só as páginas perto da tela são desenhadas, no
  máximo 24 ficam na memória. Largura ajustada por página (o PDF mistura A4 e
  outros tamanhos), com a rolagem compensada quando uma página acima muda de
  altura.
- **Navegação pela linha do tempo**: ao lado de cada peça que está no PDF, um
  atalho "p. N" pula para ela; rolar o PDF destaca a peça na linha do tempo e
  mostra rótulo, posição e páginas. Lista "Ir para a peça…", busca de texto
  (sem acento e sem caixa; diz que página digitalizada não é pesquisável),
  zoom e "Baixar PDF".
- **Estados honestos**: na fila; baixando com progresso; montando; sem progresso
  há mais de 3 minutos ("sem progresso desde HH:MM"); pausado pelo tribunal
  com o horário previsto de retomada; parcial com a lista do que faltou e por
  quê; pronto com data e hora — sempre com "não é consulta ao vivo" e até
  quando fica guardado. Três falhas seguidas ao consultar o progresso param a
  consulta e oferecem um botão, em vez de girar para sempre.
- `GET /v1/leitor/estimativa?pecas=N` e `GET /v1/processos/:numero/leitor`
  (o último PDF deste processo, do próprio workspace).

### Testes

- ESLint roda dentro do script do painel, como no do console.
- O painel foi conferido num Chromium de verdade contra um servidor local com
  MNI falso e PDFs sintéticos: marcar, montar, abrir, pular para a página,
  destaque na régua, busca, divisor, celular e fechar (que devolve a tela ao
  estado original). Esse roteiro não está na suíte (exigiria navegador no CI).

## [0.30.0] — 2026-10-01

Leitor de peças, **Etapa 1 — combinar** (especificação
`leitor-e-analise-especificacao-v1.2.1`, seções 4, 7 e 8). O advogado marca
peças e o sistema entrega **um PDF único**, na ordem dos autos, com índice de
páginas. A tela (Etapa 2: painel ao lado, PDF.js) ainda não existe — esta
entrega é a API e o motor.

### Adicionado

- **Rotas do leitor**: `POST /v1/processos/:numero/leitor` (cria o job, 202,
  com estimativa de tempo pela medição), `GET .../leitor/:jobId` (progresso:
  baixadas, total, recusadas com o motivo, estado), `GET .../pdf` (com
  `Range`/`Accept-Ranges: bytes`, PDF linearizado), `GET .../indice` e
  `POST .../atualizar`. Toda resposta traz a procedência (MNI, quando foi
  baixado, identificador não reversível da credencial, `aoVivo: false`).
- **Download em lote adaptativo**: `obterConteudosEmLote` na porta
  `ProvedorDePecas`, várias peças numa consulta MNI (medido até 20). O
  primeiro lote é de 5 peças — o único pedido sem saber o tamanho das
  respostas —, e só dobra (10, 20) depois de uma resposta leve; resposta acima
  de `LEITOR_LOTE_MAX_RESPOSTA_MB` corta o próximo pela metade, e ele nunca
  volta a crescer. Peça ausente numa resposta
  com sucesso é pedida uma vez sozinha no fim; se continuar ausente, fica no
  índice como não obtida.
- **Disjuntor global de 403** no `MniAdapter`: um 403 pausa TODAS as consultas
  MNI por `MNI_PAUSA_APOS_403_MIN` (padrão 30), sem gastar nem ficha do balde.
  Jobs ficam `pausado_por_bloqueio` e retomam sozinhos; a rota avulsa responde
  503 com a hora de retomada.
- **Fila mínima em SQLite** (`jobs_leitor`): um job do leitor por vez no
  processo INTEIRO (trava de módulo, não só por credencial — dois jobs em
  paralelo somariam o pico de memória), sobrevive a redeploy sem baixar de
  novo o que já veio. O PDF não é apagado no logout, só pelo prazo ou na
  exclusão de conta.
- **Peças HTML viram páginas de texto** (estratégia A, decidida pelo dono
  depois da sonda de HTML). Tokenizador tolerante no servidor, sem DOM: `p` e
  `br` quebram linha, `hr` vira separador, negrito e sublinhado sobrevivem,
  entidades são decodificadas, UTF-8 com recuo para windows-1252, atributos
  ignorados, script/iframe descartados. Imagens não entram e a página diz
  quantas eram; caractere sem equivalente na fonte vira "?"; tabela vira
  "célula | célula". Tudo isso vai para o `motivo` da linha `html_convertida`
  do índice. 84 HTMLs de ~19 KB convertem em ~1,3 s.
- **Montagem com qpdf** (argumentos em vetor, linearizado): PDF entra como
  veio, imagem vira página, e o que não deu — vazio, corrompido, protegido,
  recusado, sigiloso, formato estranho — vira **página de aviso** com o
  motivo. As páginas do índice são contadas do arquivo gerado e conferidas.
- **Guarda temporária em disco** (`/dados/leitor`), por workspace, com prazo
  (24 h), cota (300 MB por PDF, 1 GB por workspace), nome aleatório, fora do
  backup, limpeza horária e registro do uso de disco no log.
- `qpdf` e `poppler-utils` na imagem.
- `scripts/sonda-html.mjs` (mede só a FORMA de 2–3 HTMLs reais, 2 requisições;
  `--seco` e `--help`; o histograma só imprime nomes de tag conhecidos) e
  `scripts/medir-conversao-html.mjs`.
- `pdftotext` (poppler) no CI, para os testes lerem o texto do HTML convertido. e `scripts/medir-memoria-lote.mjs`.
- `docs/leitor-medicoes-v0.30.0.md`: as medições (qpdf 37 MB contra +357 MB do
  pdf-lib para 160 MB de PDFs; memória do lote) e a proposta para HTML.

### Mudado

- **O PDF combinado fica em disco** — decisão do dono (29/09/2026) que reverte
  "nenhum arquivo de peça no nosso disco". A peça avulsa continua sem guarda.
  CLAUDE.md §8 reescrito; o teste que fixa as chaves do registro de downloads
  passa a dizer que vale para a peça avulsa.
- O leitor de MTOM devolve **vistas** sobre a resposta em vez de copiar cada
  anexo: ler um lote de 48 MB passou de +75 MB para +8 MB de memória.
- O 403 do MNI agora é `MniBloqueadoError` (continua sendo
  `ProviderIndisponivelError`, continua 503).

### Testes

- Os testes do leitor usam números de processo SINTÉTICOS (`9999901-96.2026.8.09.9999`),
  nenhum nome de pessoa e PDFs gerados por biblioteca. A primeira versão desta
  entrega reaproveitava um número real do TJGO de um teste antigo; foi trocado.

### Ainda não

- Processo em **segredo de justiça** não tem PDF guardado (padrão da
  especificação até decisão do dono).
- Não há exclusão de conta no produto; a limpeza do leitor para ela existe
  (`apagarDoWorkspace`) e está testada.

## [0.29.1] — 2026-09-29

Dois ajustes relatados pelo dono do produto logo depois de instalar a v0.29.0.

### Adicionado

- **Escolha de tema na lateral**: automático (segue o computador, como antes),
  claro ou escuro. Com o computador em modo escuro, não havia como ver o tema
  claro. A escolha fica guardada no navegador e é aplicada no `<head>`, antes
  de a página ser pintada — sem piscar do escuro para o claro ao abrir. A área
  administrativa respeita a mesma escolha.

### Corrigido

- **"+ rotular cliente" não fazia nada.** A edição do rótulo na própria linha
  era ligada só na tela de Atualizações, que não tem botão de rotular; na
  carteira, onde o botão aparece, o clique ficava sem resposta. O defeito vinha
  da v0.25.0 e ficou mais visível na v0.29.0, que transformou o texto das
  partes num botão tracejado. Agora a rotulagem é ligada na carteira, e há
  teste que falha se ela sair de lá.

## [0.29.0] — 2026-09-29

Visual novo, a partir do logo do Processo Vivo. Aprovado primeiro num
protótipo (entrada, painel e lista de processos, em tema claro e escuro) e só
depois levado ao código.

### Adicionado

- **Logo no sistema**: na lateral e na tela de entrada, e o símbolo como ícone
  da aba (sobre um quadrado branco, para não sumir na aba escura do
  navegador). O SVG original era a página inteira do CorelDRAW com cinco
  rascunhos e o texto em Verdana sem converter; a versão final foi separada e
  as letras viraram desenho com a própria fonte que vinha no arquivo — sem
  isso, "PROCESSO VIVO" aparecia em outra fonte em Linux e em parte dos
  celulares.
- **Fontes Plus Jakarta Sans e JetBrains Mono** (números de processo), servidas
  pelo próprio servidor em `/ui/fontes/…`. Nada vem de fora: o console continua
  abrindo atrás de firewall, e há teste para isso.
- **Tela de entrada dividida**: marca, o que o sistema faz e a promessa do
  aviso de silêncio à esquerda; formulário à direita. No celular, empilha.
  Recuperar senha, redefinir e entrar com chave usam a mesma casca.
- **Painel**: saudação com a data, selo de verificação ao lado do título
  (verde só quando a verificação está de pé; âmbar com a contagem de processos
  sem verificação), quarto card com as novidades não lidas, feed com bloco de
  data, e a trilha de liberação com barra de progresso e um botão por passo.
- **Lateral** azul-marinho nos dois temas, com ícones, e um cartão no pé com
  quem está dentro e até quando vai o teste.

### Mudado

- **Cores tiradas do logo, com um significado cada**: verde = verificado/em
  dia, azul = novidade, âmbar = pede providência, vermelho = erro e sigilo.
  "Pede providência" era vermelho e passou a âmbar: vermelho fica para o que
  é falha.
- **Lista de processos compacta**: linha de altura fixa, textos cortados com
  reticências (o texto inteiro aparece ao parar o mouse). As **partes ganharam
  coluna própria**, sempre visível — antes dividiam a coluna Cliente e sumiam
  quando a pasta ganhava rótulo. Pasta sem cliente mostra "+ rotular cliente".
- **Filtros da lista recolhidos**: à vista ficam a busca, Tribunal, Cliente,
  "Mais filtros" e "Com novidade". Parte, classe, período e ordem ficam em
  "Mais filtros", que mostra quantos estão valendo e não fecha enquanto houver
  algum ativo.
- No celular a navegação vira só ícones (o texto continua para leitor de
  tela), e a página não rola mais para o lado por causa da tabela.
- A área administrativa usa a mesma casca e o mesmo logo.

### Mantido de propósito

- **Tema escuro**, seguindo o computador do advogado, como antes.
- As telas de busca, processo, vigilância, acessos e conta receberam as cores e
  as fontes novas, sem mudança de estrutura.

## [0.28.0] — 2026-09-28

Planos de assinatura controlados pelo painel. Até aqui os três planos estavam
fixos no código, sem preço, e mudar qualquer coisa neles era deploy.

### Adicionado

- **Aba Planos na área administrativa**, com:
  - **Visão geral**: cada plano com preço, recursos, situação (à venda ou
    pausado) e quantos assinantes tem — ativos, em teste, em carência,
    vencidos e cancelados, pelo status derivado no instante da consulta.
  - **Editar** nome, descrição, preço mensal, recursos incluídos e ordem na
    lista. Vale na hora para quem já tem o plano; ao mudar recursos de um
    plano com assinantes, o painel pergunta antes de gravar.
  - **Criar plano** combinando os recursos que existem (consulta,
    acompanhamento, vigilância por OAB, peças).
  - **Pausar e colocar à venda.** Pausar tira da oferta; quem já tem o plano
    continua com ele, e ele ainda pode ser liberado à mão.
  - **Teste e carência**: dias de teste, qual plano o teste libera e dias de
    carência depois do vencimento.
- **Preço no plano**, em centavos (vazio = sem preço publicado). Aparece em
  `GET /v1/assinatura` (na lista de planos à venda e no resumo da assinatura)
  e na tela "Minha conta" do console, que também passou a mostrar os recursos
  pelo nome em vez do código interno.
- O seletor de plano da aba Assinaturas agora vem do catálogo, com a marca
  "(pausado)" e o preço de cada um.

### Mudado

- **Planos saíram do código para o banco** (tabelas `planos` e
  `regras_assinatura`). Na primeira subida, os três planos atuais entram como
  semente, com os mesmos códigos — nenhuma assinatura existente muda. Depois
  disso o catálogo é seu: a semente não é reaplicada.
- **A trava do plano de IA foi para o recurso.** Em vez de um `false` fixo no
  plano, o recurso "análise com IA" está marcado como ainda não implementado,
  e nenhum plano que o inclua pode ir à venda nem ser o plano do teste —
  inclusive um criado pelo painel.
- A mensagem de "seu plano não inclui" sugere o menor plano **à venda** que
  resolve, e não mais um plano pausado.
- As regras não são retroativas: o teste novo vale para contas criadas depois
  da mudança; a carência nova, a partir da próxima liberação de cada
  assinante.

### Corrigido

- **Quem assinava depois do teste ficava com zero dias de carência.** O teste
  não tem carência, e a renovação copiava a de quem renovava — então o
  primeiro vencimento de um assinante convertido cortava a vigilância na
  hora, sem os 7 dias que existem justamente para isso. Agora a liberação
  grava a carência das regras vigentes.
- **Mensagem da área administrativa desligada.** Saía como "O provider
  "admin" não suporta a operação "acessar"…"; agora diz direto o que fazer.

### Notas de migração

Nada a fazer. As tabelas novas são criadas e preenchidas na subida. Os planos
começam sem preço — preencha pelo painel quando quiser que o valor apareça
para o advogado.

## [0.27.0] — 2026-09-28

Área administrativa: um lugar único para o operador do sistema gerenciar
assinatura e chave de API pela web, sem depender de CLI nem de editar `.env` e
reiniciar o serviço.

### Adicionado

- **Painel `/admin`**, protegido por HTTP Basic Auth
  (`PROCESSOVIVO_ADMIN_USUARIO`/`PROCESSOVIVO_ADMIN_SENHA`). Autenticação
  inteiramente separada da sessão de assinante — hook próprio
  (`autenticacaoAdmin`), zero linha tocando `usuarios` ou `sessoes`. Sem as
  duas variáveis definidas, a área nem existe: `/admin` e `/admin/api/*`
  respondem 501 em vez de 404 ou de pedir credencial.
- **Aba Assinaturas**: listar todas com e-mail da conta, consultar por
  e-mail, liberar plano por N meses (mesma validação de plano e prazo do
  comando `assinatura liberar` do CLI), cancelar, e disparar os avisos de
  vencimento na hora — o mesmo que o agendador roda sozinho, sem esperar o
  próximo ciclo.
- **Aba Chaves de API**: emitir chave nova (o valor em texto puro aparece uma
  única vez, na resposta da emissão — nunca mais volta a aparecer, nem no
  log), listar (identificador e rótulo, nunca a chave) e revogar. Uma chave
  emitida aqui autentica nas rotas do assinante exatamente como uma chave de
  `PROCESSOVIVO_API_KEYS`: as duas calculam `identificador`/`workspace` a
  partir do mesmo hash SHA-256 (`chavesDeApi.hash`), e o plugin de
  autenticação principal aceita as duas fontes. Revogar derruba a
  autenticação daquela chave imediatamente.

### Por que Basic Auth, e não sessão de cookie

O `CLAUDE.md` já registrava por que este sistema nunca cria um campo
"administrador" booleano na tabela `usuarios` — o cadastro é aberto, e isso
seria construir, sem perceber, uma escalada de privilégio. Reaproveitar
`ServicoContas` e a sessão de assinante para o operador puxaria a mesma
mistura para dentro do código, ainda que sem o campo. Basic Auth resolve com
uma credencial fixa, um hook, e nenhuma linha tocando `usuarios` ou
`sessoes`: o navegador pede a senha uma vez e guarda para as chamadas
seguintes da mesma origem.

### Notas de segurança

- A senha administrativa precisa de pelo menos 16 caracteres — validado no
  arranque, junto com o resto da configuração. É a única credencial desta
  área, sem 2FA.
- `assinatura ver/liberar/cancelar/avisar` no CLI continua existindo, igual —
  a rota HTTP é um segundo caminho para o mesmo operador, não uma
  substituição.

## [0.26.1] — 2026-09-24

Conserto de um defeito que eu introduzi na v0.26.0, e a trava para a família
inteira dele.

### Corrigido

- **O painel quebrava ao carregar**, exibindo "Cannot read properties of null
  (reading 'addEventListener')" duas vezes. A causa foi um `+` perdido no fim de
  `h+='<div class="filtros">'` ao montar a tela nova: as linhas seguintes viraram
  uma expressão solta, o motor avaliou e descartou, e o bloco dos filtros nunca
  entrou no HTML. Os `id` que os listeners procuravam não existiam.
- **A caixa de erro disfarçava defeito nosso de falha do servidor.** Um
  TypeError solto dentro de um `.then` era engolido pelo `.catch`, e `erroBloco`
  imprimia a mensagem dele duas vezes — como título e como explicação, porque
  `explicar()` cai em `e.message` quando não há status. Era exatamente por isso
  que a mensagem chegava sem dizer onde. Agora ela distingue erro com `status`
  (do servidor) de erro de programação, diz que a falha é da interface e mostra
  a primeira linha da pilha.
- Data do painel montada por partes: o formato pronto do pt-BR dava
  "quinta-feira, 24 de set. de 2026", que em versalete espaçado vira uma linha
  de conectivo. Agora sai "quinta · 24 set 2026 · 18:26".

### A trava

`no-unused-expressions` entrou nas regras que `console-script.spec.ts` roda
DENTRO da string do console, com teste próprio. Nenhuma das outras pegava este
caso: não há variável indefinida, não há sintaxe quebrada, e para o `tsc` aquilo
é texto. Verificado reintroduzindo o bug — a regra aponta a linha exata.

O conserto também foi conferido num navegador de verdade, com Playwright, e não
só pelo teste.

## [0.26.0] — 2026-09-24

A tela inicial, a partir da mesma referência visual da v0.25.0. Dos quatro
pedidos, dois tinham dado e dois não tinham — um destes virou funcionalidade e o
outro continua fora.

### Adicionado

- **Data por extenso e hora no topo do painel**, com a frase que decide se dá
  para confiar na tela: "verificado às 08:12, há 40 min". A referência põe ali a
  edição do diário; para nós o número que importa é quando a carteira foi vista
  pela última vez. Se alguma pasta está com a verificação falhando, a contagem
  aparece na mesma linha, e o texto diz o que isso significa — que o silêncio
  daquelas deixou de querer dizer "nada aconteceu".
- **Três cards**: Processos ativos (arquivados fora da conta), Pedem
  providência e Peças baixadas hoje.
- **"Últimas atualizações"** como título do feed, que é o que ele sempre foi.
- **Registro das peças baixadas** — tabela nova, gravada no momento do
  download. Guarda METADADO e nunca o arquivo: são autos de processo, muitos em
  segredo de justiça, e custodiá-los criaria uma obrigação de guarda que o
  produto não precisa assumir. Destrava o card, o trilho da direita e:
- **"Já baixado" na régua temporal.** O ganho não é estético: baixar uma peça
  custa dezenas de segundos e uma requisição que carrega a senha do advogado,
  contando para o bloqueio da conta dele no tribunal. Quem não lembra se já
  puxou a contestação clicava de novo e pagava tudo outra vez. O botão continua
  clicável — a pessoa pode ter perdido o arquivo.
- **Terceira coluna**, com o que já foi puxado do tribunal. Ela só é montada
  quando há conteúdo para pôr nela; sem baixa nenhuma, a página fica de uma
  coluna só. Reservar espaço para bloco vazio foi erro meu na v0.22.0, e vão em
  branco no meio da página não é lido como "ainda não há dados".
- **`GET /v1/painel`** e **`GET /v1/pecas-baixadas`**.

### O que continua fora

**"Prazos em 48h" e "Prazos de hoje".** Não existe prazo cadastrado em lugar
nenhum do sistema — é a próxima entrega da fila. O que temos perto disso é
"pedem providência", que é o ato que ABRE um prazo, não o prazo, e o card diz
exatamente isso. Há teste que falha se a palavra entrar no contrato por
descuido. O segundo bloco do trilho nasce quando os prazos nascerem.

## [0.25.0] — 2026-09-24

A casca do console mudou de forma, a partir de um sistema de referência que o
dono do produto trouxe. O que veio de lá é a ESTRUTURA — lateral fixa, carteira
em tabela, um estado por pasta. O que ficou de fora veio junto na referência e
não entrou de propósito, com motivo em cada caso (ver o fim desta entrada).

### Adicionado

- **Barra lateral fixa** no lugar das abas na barra de cima. Não rola para fora
  da tela, cabe crescer, e mostra a contagem ao lado de cada destino — que era
  informação que exigia abrir a tela para descobrir. A contagem da carteira vem
  da resposta que a tela já pedia; nenhuma requisição nova. Abaixo de 900px ela
  volta a ser barra superior: numa tela estreita, 228px fixos comeriam um quarto
  da largura útil da tabela. O conteúdo passou de 900px para 1100px.
- **A carteira virou tabela** — Processo · Cliente · Tribunal · Última
  movimentação · Estado. O número em fonte monoespaçada com numeral tabular:
  os dígitos alinham e o olho acha o processo sem ler. Os cartões empilhados
  funcionavam com dez pastas e viravam rolagem com cento e quarenta.
- **Rótulo de cliente por pasta**, editável na própria linha (Enter grava, Esc
  cancela, vazio apaga), com filtro e busca livre. Rotular cento e quarenta
  processos é trabalho de uma sentada; um ida-e-volta por pasta viraria uma
  tarde.
- **Estado derivado por pasta**: providência, novidade, arquivado, em curso —
  mais um aviso de **não verificado** que corre por FORA do selo, porque uma
  pasta pode ter prazo aberto e estar três dias sem verificação, e as duas
  informações importam. Derivado na resposta, nunca gravado em coluna: mesma
  razão do status de assinatura.

### O que veio na referência e NÃO entrou

- **Selos de "Audiência" e "Trânsito em julgado".** Exigiriam ler código da TPU
  que nunca apareceu numa resposta real deste projeto. Um selo que erra na tela
  de um advogado é pior que coluna nenhuma — ele não confere o que o sistema
  afirmou com convicção. Entram quando houver captura que os sustente.
- **Tema escuro fixo e tipografia serifada de display.** O console segue a
  preferência do sistema, e muito advogado trabalha em sala clara. A serifada
  come ~120px de altura por título: num app usado o dia inteiro isso é uma
  linha de tabela por dia. Esse tom vai para a landing page.
- **Botão "baixar peças do dia".** Prometeria o que não se entrega: cada
  consulta ao MNI são dezenas de segundos e uma tentativa que conta para o
  bloqueio da conta do advogado no tribunal. Em 142 processos isso não existe.

### Notas de migração

A coluna `cliente` entra pelo `migrarColunas` e **não tem retrocarga**, ao
contrário do que a regra geral manda. A regra vale para coluna DERIVADA de dado
já guardado — `partes_texto` sai do JSON do processo, e sem retrocarga o filtro
enxergaria só o sincronizado depois. `cliente` não sai de lugar nenhum: o
tribunal entrega as partes sem dizer qual delas o consultante representa, e
deduzir pela OAB poria o nome do adversário na coluna. Vazio significa "ainda
não rotulado", que é a verdade. Há teste que fixa isso.

### Achado, não corrigido

O campo `apelido` existe em `acompanhamentos` desde o começo, é aceito pela rota
de acompanhar e entra na busca textual — e **não há nenhum lugar no console que
o preencha**. Segue como está; `cliente` não o substitui (apelido nomeia o caso,
cliente nomeia a pessoa, e só o segundo agrupa).

## [0.24.0] — 2026-09-24

A crítica veio de um advogado em exercício usando a tela, e é sobre rotina, não
sobre estética: ler "14/09 · Petição da parte" no andamento, memorizar a data e
rolar a página até o rodapé para caçar o arquivo no meio de 278 peças não
acontece na correria de um escritório. A lista de anexos no rodapé está
aposentada; a linha do tempo virou a espinha dorsal da tela.

### O obstáculo que eu tinha declarado — e por que ele era o obstáculo errado

Nas versões anteriores eu disse que casar peça com andamento não era
confiável. A razão continua correta: `Peca.movimento` é o identificador do
movimento **no MNI**, e a linha do tempo da tela vem do DataJud e do DJEN, que
numeram movimento de outro jeito e não têm campo em comum. Casar por data
penduraria a contestação embaixo do despacho errado.

O que faltava ver: **a resposta do MNI que traz as peças também traz os
movimentos** — 381 num processo real — e o mapper os descartava. Cada
`<documento>` aponta para o `identificadorMovimento` do `<movimento>` que o
juntou. A junção não atravessa fontes: é uma chave que o tribunal afirmou,
dentro de um único XML, sem consulta nova.

### Adicionado

- **Régua temporal: cada evento entrega o documento na própria linha.** Com a
  resposta do tribunal, a linha do tempo passa a ser montada dos movimentos do
  MNI, cada um já com os seus documentos e um botão de baixar por documento.
  `domain/entities/linhaDoTempo.ts`.
- **Filtro "Apenas andamentos principais".** Decide pelo POSITIVO — some só o
  que foi *identificado* como cartório (juntada, expedição, conclusão,
  remessa). Nasce desligado, diz quantas linhas escondeu, e nunca esconde ato
  que exige providência nem ato que entrega documento.
- **Destaque da decisão.** Sentença, decisão, acórdão, despacho e homologação
  ganham fundo e selo próprios; o que pede providência ganha a régua de acento
  à esquerda, o mesmo recurso do cartão de alerta. "Juntada de cópia da
  decisão" NÃO é destacada: é cartório levando a decisão aos autos.
- **Nome do movimento emprestado da TPU.** O MNI manda `codigoNacional` e nem
  sempre a descrição; o DataJud manda o nome. Mesma tabela do CNJ, então
  emprestar não é dedução — é ler a tabela numa fonte que a tem. Sem isto a
  régua exibiria "Movimento 12265".
- **`listarAtos` na porta `ProvedorDePecas`** (opcional): peças e movimentos na
  mesma resposta. Fonte que não a implementa segue pelo caminho antigo.
- **`scripts/sonda-movimentos.mjs`**, para verificar a correspondência no
  tribunal real. Banco em `readOnly`, uma tentativa sem repetição, recusa de
  rodar sobre credencial já marcada como recusada.

### Corrigido

- **Clicar num filtro da linha do tempo consultava o MNI de novo.** Redesenhar
  o detalhe chamava `carregarPecas`, e cada chamada são dezenas de segundos e
  mais uma oportunidade de recusa contra a conta do advogado no tribunal. A
  régua agora fica em cache na página, com botão "Atualizar" para forçar.
- **Evento que entrega documento não é mais agrupado em "×4".** O contador
  esconderia quatro botões de download diferentes atrás de um número.

### Degradação deliberada

A correspondência `documento.movimento` ↔ `identificadorMovimento` está na
especificação do MNI 2.2.2 e foi vista num Projudi. O próximo tribunal pode
numerar de outro jeito, e nesse dia o sistema fica **pior, nunca quebrado**:
sem casar peça nenhuma, a tela volta a ser exatamente a anterior — linha do
tempo das fontes públicas e todas as peças na lista. Há teste para isso.

E a contagem de atos nunca diminui: a reconciliação entre a linha do tribunal e
a das fontes públicas é por balde (mesmo dia, mesmo código da TPU) e só
descarta enquanto o tribunal tiver pelo menos tantas linhas quanto a fonte
pública. Se o DataJud tem três juntadas num dia e o tribunal mandou duas, a
terceira fica. Duas linhas para o mesmo ato é incômodo visual; uma linha
ausente é prazo perdido.

## [0.23.0] — 2026-09-23

Tudo aqui saiu de UM processo real com 278 peças. A v0.22.0 pôs o resumo no
lugar certo e mostrou que o conteúdo dele não servia.

### Corrigido

- **"Origem não identificada" em 111 das 278 peças.** O classificador só olhava
  o texto do rótulo, e o TJGO manda `descricao="Outros"` nos anexos — 40% da
  lista sem origem, todas PDF, todas na data de uma petição. Agora a origem é
  deduzida pelo atributo **`movimento`**, que diz a qual ato o documento
  pertence: anexo e petição compartilham o número porque foram juntados no
  mesmo ato. Não é mais um chute de texto — é uma relação que a fonte afirma.

  Três regras mantêm isso honesto: só preenche o que está vazio, movimento com
  origens conflitantes não deduz nada, e peça sem `movimento` continua
  desconhecida. A tela diz quantas foram deduzidas, porque o que o tribunal
  afirmou e o que o sistema concluiu não podem virar a mesma coisa.

- **O resumo mostrava "Outros" quatro vezes.** As 5 mais recentes do processo
  medido eram 1 petição e 4 documentos sem rótulo — logo abaixo da frase que
  promete as peças das partes. O cartão passa a mostrar **as das partes**, que
  é o que ele existe para mostrar.

- **"baixar text/html"** no botão dos documentos do juízo. O rótulo tirava o
  prefixo `application/` do mimetype, o que resolve PDF e deixa o resto falando
  jargão. Agora sai PDF, HTML, imagem, documento ou texto.

## [0.22.1] — 2026-09-23

### Corrigido

- **Vão em branco na busca por número.** O resumo de peças da v0.22.0 reserva
  altura para não empurrar o texto quando a consulta ao tribunal volta — mas a
  busca avulsa por número nunca carregou peças (só a tela de processo
  acompanhado carrega), e o espaço reservado ficava vazio entre "Última
  movimentação" e "Partes".

  A correção não é carregar peças em toda busca: cada consulta ao MNI leva
  dezenas de segundos e carrega a linha do tempo inteira como pedágio, então
  quem digitasse cinco números seguidos dispararia cinco chamadas ao tribunal
  sem ter pedido peça nenhuma. Agora a busca avulsa **oferece** — um cartão com
  o botão "Buscar peças", que preenche o espaço e só chama o tribunal quando
  alguém pede.

## [0.22.0] — 2026-09-23

### Corrigido

- **"Nenhuma peça" deixou de ser dito quando o caso é falta de habilitação.**
  O MNI devolve `sucesso: true` com o cabeçalho completo e ZERO movimentos
  quando o acesso cadastrado não consta como representante nos autos — sem
  código de erro, sem aviso. Medido no TJGO: 3 KB para quem não é
  representante, 273 KB com 278 documentos para quem tem procuração, mesma
  consulta. A tela dizia "o tribunal não devolveu nenhuma peça", e o advogado
  concluía que o processo estava vazio. Agora responde **403
  `SEM_HABILITACAO_NOS_AUTOS`**, com a mensagem que diz o que conferir.
- **O botão de acompanhar em lote dizia "Acompanhar todos" e acompanhava os
  FILTRADOS.** Com um filtro ativo a tela mostrava três números — o total no
  título, "mostrando X de Y" no aviso e o botão — e só o botão não se
  explicava. Agora o rótulo conta: *"Acompanhar 7 selecionados"*, *"Acompanhar
  os 12 filtrados"*, *"Acompanhar os 130"*.

### Adicionado

- **Resumo das peças no topo da página do processo**, logo abaixo da última
  movimentação. Antes elas ficavam depois de até 381 andamentos: quem não
  rolasse até o fim concluía que o sistema não tinha peças — a conclusão mais
  cara possível, porque é o que distingue o produto. O bloco tem altura
  reservada, para não empurrar o texto quando a consulta ao tribunal volta.
- **As peças passam a ser ordenadas por data**, da mais recente para a mais
  antiga. Nem o serviço nem a tela ordenavam; elas saíam na ordem do tribunal,
  que não é cronológica.
- **Lista completa agrupada por origem** — juntadas pelas partes primeiro, que
  é a pergunta que traz o advogado às peças. "Origem não identificada" continua
  visível: sumir com peça porque a heurística não decidiu é como se perde
  prazo.
- **Seleção por caixa na busca por OAB**, com "marcar os N visíveis", selo
  **já acompanhando** em quem está na carteira (marcado e travado) e
  confirmação a partir de 20 processos — acompanhar 130 significa 130 consultas
  ao tribunal por varredura, contra a cota compartilhada do CNJ.

### Notas

- A linha do resultado da busca deixou de ser um `<button>` único: caixa de
  seleção dentro de botão é HTML inválido e os cliques se atropelam. Agora são
  duas áreas irmãs — a caixa e o corpo, que continua abrindo o processo.
- Nenhuma variável de ambiente nova, nenhuma migração de banco.

## [0.21.0] — 2026-09-22

### Adicionado

- **Planos e assinatura.** Três planos: **Acompanhamento** (consulta, carteira,
  vigilância por OAB e avisos), **Peças** (tudo isso mais as peças do processo)
  e **IA** (análise com sugestões). O de IA está modelado e **não está à venda**
  — a funcionalidade ainda não existe, e um teste automatizado falha no dia em
  que alguém mudar isso sem querer.
- **Teste de 14 dias em toda conta nova**, no plano Peças. É o plano que mostra
  o diferencial: um teste que só dá acompanhamento mostra ao advogado
  exatamente o que o concorrente também faz.
- **Carência de 7 dias** depois do vencimento, com tudo funcionando. Cortar a
  vigilância no minuto do vencimento — que costuma ser cartão recusado, não
  decisão de cancelar — faz o advogado deixar de receber aviso de prazo sem
  saber que deixou.
- **Avisos por e-mail** em três etapas: 3 dias antes de vencer, ao entrar em
  carência e ao ser bloqueado. Uma vez por etapa, e a etapa só é marcada depois
  que o envio é confirmado. O aviso de bloqueio diz, com todas as letras, que a
  partir dali **não receber e-mail deixou de significar que nada aconteceu**.
- `GET /v1/assinatura`: plano em vigor, status, vencimento e os planos à venda.
- Comando `assinatura` no CLI: `ver`, `liberar`, `cancelar` e `avisar`. A
  liberação é manual, depois do Pix — **não há rota HTTP para isso**, e é
  deliberado: ela exigiria um papel de administrador que o sistema não tem, e
  inventar "administrador" numa API de cadastro aberto é como se constrói uma
  escalada de privilégio sem perceber.
- Tarja de assinatura na tela inicial (só quando há o que dizer) e cartão
  permanente do plano em Minha conta.

### Alterado

- As rotas de peças e de credenciais de tribunal passam a exigir o recurso no
  plano: **403** com o nome do plano que resolve. Assinatura vencida devolve
  **402**, que é outra conversa — pagar o que já foi contratado, e não trocar
  de plano.
- `DELETE /v1/credenciais/:tribunal` continua liberado sem plano. Exigir plano
  para apagar credencial seria "pague para poder tirar seus dados".

### Migração

- **Toda conta que já existia ganha assinatura ativa no arranque**, no plano
  Peças, por um ano, sem ser teste. Sem isso a entrega viraria um bloqueio em
  massa: o advogado que usou o sistema ontem abriria hoje e encontraria "sua
  assinatura venceu" sobre a carteira que ele montou à mão. A retrocarga é
  idempotente e não toca em quem já tem assinatura.
- **Workspace sem assinatura não é bloqueado.** É o caso das chaves de API, que
  não têm conta e nunca terão assinatura — tratá-las como bloqueadas derrubaria
  as integrações no dia do deploy.
- Nenhuma variável de ambiente nova.

## [0.20.2] — 2026-09-18

**A mesma tradução enganou de novo, um nível mais fundo.**

Contra um servidor de e-mail com certificado TLS **vencido**, o diagnóstico da
v0.20.1 respondeu "quase sempre é SMTP_SECURE trocado" — uma variável sem
nenhuma relação com o problema. Encontrado em produção, não em teste.

A v0.20.1 já tinha corrigido a versão que decidia só pelo código do erro,
passando a olhar a mensagem. Mas casava a **palavra solta** `certificate`, e
por isso agrupou sob "porta TLS errada" tudo que mencionasse certificado.
Palavra solta é chute com outro nome.

### Corrigido

Quatro falhas de TLS que se pareciam e agora se distinguem, cada uma com o seu
conserto:

- `certificate has expired` → o certificado do servidor de e-mail está vencido;
  renove **no servidor**, não há o que configurar aqui.
- `self-signed` / `unable to verify` → certificado não confiável ou cadeia
  incompleta.
- `altnames` / `does not match certificate` → o nome do certificado não bate
  com o `SMTP_HOST`.
- `wrong version number` / `packet length` → aí sim é `SMTP_SECURE` trocado.

### A regra, agora completa

Ao traduzir erro de biblioteca: decida pela mensagem e não pelo código; case
pela **frase**, não por palavra solta; carregue o texto original junto sempre; e
sem evidência para o palpite, entregue o texto cru.

### Testes

De 499 para 502. O novo par decisivo põe `certificate has expired` e
`wrong version number` lado a lado e exige que só o segundo mencione
`SMTP_SECURE` — o teste que a v0.20.1 teria reprovado.

---

## [0.20.1] — 2026-09-18

**O comando `email` agora diz POR QUE falhou, em vez de apontar para o log.**

A v0.19.0 entregou um diagnóstico que, na falha, dizia "o motivo está no log
acima" — inútil para quem está num terminal de contêiner com o log em outra aba,
ou com `LOG_LEVEL` alto. Diagnóstico que depende de outro lugar não é
diagnóstico.

### Adicionado

- `Notificador.diagnosticar()` (opcional, no mesmo espírito do `diagnosticar()`
  do `ProcessoProvider`): abre a conexão, autentica e desliga, **sem mandar
  mensagem**. A maioria das falhas de SMTP acontece antes de a mensagem existir
  — porta bloqueada, senha errada, TLS na porta errada —, e tentar enviar para
  descobrir isso mistura dois problemas.
- O comando `email` confere a conexão antes de enviar e imprime a causa
  provável com o campo a mexer.

### Duas traduções estavam ERRADAS, e do jeito pior

Encontradas testando contra falhas reais, não em revisão de código:

- **`ESOCKET` era traduzido como falha de TLS.** O nodemailer usa esse mesmo
  código para conexão recusada. Contra uma porta fechada, a mensagem mandava
  mexer em `SMTP_SECURE` enquanto o problema era a porta — meia hora no lugar
  errado. Agora a decisão olha a MENSAGEM (`ECONNREFUSED`, `ETIMEDOUT`,
  `wrong version number`), não só o código.
- **`EDNS` não estava na lista.** É o código que o nodemailer usa para nome que
  não resolve; `ENOTFOUND` aparece só dentro do texto.

A regra que fica: **tradução que chuta é pior que o erro cru**, porque o erro
cru ao menos não desperdiça tempo. O texto original agora vai junto sempre, e o
palpite só aparece quando há evidência para ele.

### Testes

De 492 para 499, incluindo os dois casos de `ESOCKET` lado a lado — o teste que
a versão anterior teria reprovado.

---

## [0.20.0] — 2026-09-18

**Justiça do Trabalho: 24 TRTs e o TST.**

Verificado contra número real: `0011242-47.2021.5.18.0016`, TRT da 18ª Região.

O que faltava era **só configuração**. A chave pública do CNJ é a mesma para
todos os tribunais e o endereço de cada um é montado a partir da sigla
(`api_publica_trt18`). Não havia credencial nova, adapter novo nem acordo com
ninguém — havia duas listas desatualizadas: as siglas suportadas e o mapa J.TR
do número CNJ.

Durante meses a resposta a um advogado trabalhista foi "tribunal não suportado",
e isso passou por limitação de arquitetura quando era uma lista por atualizar.
Fica registrado no CLAUDE.md como coisa a conferir antes de dizer que o produto
não atende um segmento.

### Adicionado

- `TRT1` a `TRT24` e `TST` em `TRIBUNAIS_SUPORTADOS`.
- Mapa do segmento 5 (`5.01`…`5.24`, e `5.00` para o TST) em `NumeroCNJ`.

### O que isso muda no produto

Advogado trabalhista passa a ter consulta por número, acompanhamento, vigilância
por OAB e aviso de movimentação — **sem credencial nenhuma**, porque nada disso
depende de senha de tribunal. O que ele não tem é peça, que exige o endereço MNI
daquele tribunal e a credencial de um advogado habilitado nos autos; hoje só o
TJGO está montado assim.

### Testes

De 489 para 492. Entre eles, o número real do TRT18 e a conferência das 24
regiões uma a uma — a numeração do CNJ é posicional, e um erro de deslocamento
mandaria a consulta ao tribunal errado, que responderia "não encontrado",
indistinguível de processo inexistente.

Um teste **mudou de exemplo**: `recusa tribunal fora da lista suportada` usava a
Justiça do Trabalho como caso de tribunal não atendido. Passou a usar o segmento
9, que não existe na Resolução 65 do CNJ — assim ele mede o que sempre quis
medir, recusar antes de ir à rede, e não precisa de conserto a cada vez que a
cobertura crescer.

### Pendente de verificação

O TST (`5.00`) entrou pelo padrão, sem número real para conferir. Se o alias
`api_publica_tst` não existir, a consulta cai no fallback e o DJEN responde —
nada quebra, mas vale um teste com número real quando aparecer um.

---

## [0.19.0] — 2026-09-18

**`npm run cli -- email <destinatario>`: testar o envio sem gastar um link.**

Até aqui, a única forma de saber se o SMTP estava certo era pedir uma
recuperação de senha de verdade. E ela é, por decisão de segurança, a pior
ferramenta de diagnóstico possível: responde exatamente a mesma coisa tendo
enviado ou não, justamente para não contar nada a um curioso. O efeito colateral
é que também não contava nada a quem estava configurando o servidor.

O comando novo é o contrário: barulhento e específico.

```
remetente ..... contato@processovivo.com.br
servidor ...... processovivo.com.br:587 (STARTTLS)
endereço base . https://app.processovivo.com.br
canal ......... email-smtp

Enviado para eu@exemplo.com.br. Confira a caixa de entrada E o spam.

Recuperação de senha: LIGADA.
```

Ele imprime a configuração que está valendo, envia de fato, e separa os três
estados que antes se confundiam: SMTP ausente (código 2, com o que definir),
envio recusado pelo servidor de e-mail (código 2, com as causas comuns), e envio
aceito. Também avisa quando o SMTP funciona mas `PROCESSOVIVO_URL_BASE` está
vazia — caso em que a recuperação continua desligada, porque link relativo em
e-mail não leva a lugar nenhum.

### Adicionado

- Comando `email` no CLI.
- `Aplicacao.notificador` — o canal de saída cru, exposto para diagnóstico. O
  `ServicoNotificacao` decide QUANDO avisar; este é por onde a mensagem sai.

### Detalhe que já quebrou uma vez

A checagem de "o SMTP está configurado?" usa a mesma condição do composition
root — host e remetente definidos —, e **não** o nome do canal. A primeira
versão comparava com a string `'smtp'`, e o notificador se chama `email-smtp`:
o comando recusava uma configuração perfeitamente válida. Comparar com string
mágica o que já existe como condição é assim que se escreve um diagnóstico que
mente.

---

## [0.18.2] — 2026-09-18

**Conserta a aba Atualizações, que quebrava com "f is not defined".**

A tela inicial do console pintava o conteúdo e, logo em seguida, lançava
`ReferenceError`. O `catch` do carregamento trocava a tela inteira por uma caixa
de erro — por isso a barra de navegação aparecia certa e o conteúdo sumia.

### Corrigido

- Removido de `verNovidades()` um bloco de restauração de foco copiado da tela
  de processos. Lá existe um `f` com o estado do filtro; aqui esse `f` nunca foi
  declarado. Essa tela não tem campo de texto — só um chip e um select —, então
  não há foco a restaurar e o bloco não tinha o que fazer ali.
- O defeito entrou na v0.16.0 e só apareceu agora porque a produção pulou da
  v0.14.0 direto para a v0.18.0.

### A lacuna que o permitiu, agora fechada

O console é JavaScript dentro de um `String.raw`. Isso é decisão de arquitetura,
e boa: sem build, sem bundler, sem `node_modules` na imagem. O preço é que **nem
o `tsc` nem o ESLint enxergam uma linha dele** — para as duas ferramentas aquilo
é texto. O bug passou por `typecheck` limpo, `lint` limpo e 486 testes verdes.

`tests/http/console-script.spec.ts` agora extrai a string e roda o ESLint dentro
dela, com os globais de navegador, checando `no-undef`, erro de sintaxe e
parentes próximos. Não substitui um teste de navegador, mas pega a família
inteira de erros que este bug representa: variável não declarada, nome digitado
errado, sintaxe quebrada. Verificado reintroduzindo o defeito — o teste aponta a
linha e o nome da variável.

### Testes

De 486 para 489.

---

## [0.18.1] — 2026-09-18

**Corrige a falha que a v0.18.0 causou em produção: banco vazio, em silêncio.**

A v0.18.0 trocou o caminho padrão do banco no `Dockerfile`, de
`/dados/lexflow.db` para `/dados/processovivo.db`. A compatibilidade que eu tinha
escrito cobria as variáveis declaradas no painel — e não cobria o padrão da
imagem, que é justamente de onde a instalação em produção tirava o valor.

O resultado foi o pior modo de falhar que este sistema tem: o SQLite criou um
arquivo NOVO e VAZIO, o serviço subiu saudável, o health check passou, e a
carteira apareceu em branco — com 1,2 MB de dados intactos no arquivo ao lado,
invisíveis. Nada produziu erro. Foi preciso consultar o banco para descobrir.

### Corrigido

- **`abrirBanco` recusa iniciar** quando o banco configurado não existe, ou
  existe e está sem nenhum dado, **e** há um banco com o nome antigo na mesma
  pasta com dados dentro. A mensagem traz os dois caminhos e as três saídas
  possíveis, prontas para copiar.
- A verificação acontece em **duas passagens**, e a segunda é a que importa:
  antes de abrir, o sinal é "o arquivo não existe"; depois de abrir e criar o
  esquema, o sinal é "o arquivo existe e está vazio". Sem a segunda, a proteção
  valeria no primeiro deploy e ficaria calada em todos os seguintes — ou seja,
  justamente em quem já tropeçou.
- `PROCESSOVIVO_BANCO_NOVO=true` reconhece um banco novo proposital e desliga a
  checagem.

### A regra que fica

**Entre subir vazio e não subir, não subir.** Um serviço fora do ar por dez
minutos é um incidente comum; um serviço no ar mostrando a carteira em branco é
o cliente achando que perdeu o trabalho dele — e essa diferença é confiança no
produto, que não volta com um redeploy.

O corolário para renomeações futuras: **valor padrão dentro da imagem é
configuração que ninguém lembra que existe.** Renomear uma variável no painel é
visível; mudar o `ENV` do `Dockerfile` muda o comportamento de toda instalação
que não a declara, sem nenhum sinal.

### Testes

De 478 para 486. Entre eles, o segundo arranque com o arquivo vazio já criado —
o estado exato da produção quando o problema apareceu.

---

## [0.18.0] — 2026-09-17

**O produto agora se chama Processo Vivo.**

O domínio `processovivo.com.br` foi comprado, e o nome mudou em todo lugar:
interface, e-mails, cookie de sessão, cabeçalhos HTTP, nomes de arquivo de
backup, variáveis de ambiente, `package.json`, CLI e documentação.

Feito AGORA, e não depois, por um motivo específico: três destas coisas ficam
caras assim que houver o primeiro assinante. Trocar o nome do cookie desconecta
todo mundo; trocar o caminho do banco exige mexer no arquivo dentro do volume; e
trocar as variáveis de ambiente arrisca um deploy quebrado. Hoje não há
assinante, então o custo é meia hora. Em um mês seria um aviso a clientes.

### Mudou

- `LexFlow` → `Processo Vivo` em toda a interface e em todos os e-mails.
- Cookie de sessão: `lexflow_sessao` → `processovivo_sessao` (e
  `__Host-lexflow_sessao` → `__Host-processovivo_sessao` em HTTPS). **Isto
  desconecta todas as sessões abertas, uma vez.**
- Cabeçalhos de procedência: `x-lexflow-fonte` e `x-lexflow-cache` →
  `x-processovivo-fonte` e `x-processovivo-cache`.
- Variáveis de ambiente: prefixo `LEXFLOW_` → `PROCESSOVIVO_`.
- Arquivo do banco, por padrão: `lexflow.db` → `processovivo.db`.
- Arquivos de backup: `lexflow-<data>.db` → `processovivo-<data>.db`.
- `PROCESSOVIVO_URL_BASE` passa a apontar para `app.processovivo.com.br`: o
  sistema vive no subdomínio e a raiz fica para a página de vendas. Os links dos
  e-mails de recuperação valem uma hora — não podem apontar para um endereço que
  ainda vai ser reformado.

### Compatibilidade, de propósito

- **As variáveis `LEXFLOW_*` continuam funcionando**, e o log avisa em `warn`
  qual trocar. Com as duas definidas, vence a nova. Sem isso, uma variável
  esquecida no painel derrubaria ou corromperia o deploy — e cada uma falharia
  de um jeito diferente: sem a chave de API o processo nem sobe; sem a chave do
  cofre as peças somem em silêncio; sem o caminho do banco o sistema abre um
  arquivo NOVO e vazio ao lado do que tem os dados, e a carteira parece ter
  evaporado.
- **A poda de backup continua reconhecendo `lexflow-<data>.db`.** Sem isso, a
  pasta guardaria as sete cópias novas MAIS todas as antigas, para sempre,
  enchendo justamente o volume onde mora o banco.

### Documentação

- Nova seção no `DEPLOY.md`: **"Migrar uma instalação que era LexFlow"** — passo
  a passo com os dois lugares onde dá para perder dados sem receber erro nenhum
  (renomear o volume no Easypanel, e apontar o caminho do banco para um arquivo
  que não existe).
- A aba Domains agora documenta o app no subdomínio e explica por que a landing
  não divide origem com a tela onde o advogado digita a senha.

### Testes

De 472 para 478. Os novos cobrem a compatibilidade das variáveis (nome antigo
aceito, nome novo tendo precedência, variável vazia não contando como definida)
e a poda das cópias de backup com o nome antigo.

---

## [0.17.0] — 2026-09-17

**Backup do banco e recuperação de senha — o que faltava para vender.**

Até aqui, duas coisas travavam a venda por motivos que não são técnicos: um
assinante que esquecesse a senha só voltava se eu mexesse no banco dele, e o
dia em que o volume do VPS falhasse seria o dia em que a carteira de todos os
clientes deixaria de existir. Nenhuma das duas aparece numa demonstração, e as
duas aparecem no primeiro problema real.

### Adicionado

- **Backup automático do banco**, ligado por padrão: uma cópia por dia, sete
  guardadas, em `/dados/backups/`. `BACKUP_INTERVALO_HORAS` e `BACKUP_MANTER`
  controlam; 0 desliga. Também sob demanda: `npm run cli -- backup`.
- **Recuperação de senha por e-mail.** Link de uso único, válido por uma hora,
  no máximo cinco pedidos por conta por hora. Quem redefine já entra, e todas
  as sessões anteriores caem.
- **Telas de "esqueci minha senha" e "escolher nova senha"** no console.
- `GET /v1/senha/recuperar` diz se **esta instalação** consegue enviar e-mail.
  É o que permite a interface esconder o link em vez de prometer o que não vai
  cumprir.
- **Seção 6 do DEPLOY.md**: procedimento de restauração passo a passo, custódia
  da `PROCESSOVIVO_CREDENCIAL_CHAVE` e o que fazer para tirar a cópia do VPS.

### Decisões que moldaram o código

- **A cópia é feita com `VACUUM INTO`, não copiando o arquivo.** Em modo WAL,
  uma escrita recente vive no `-wal` até o checkpoint: copiar o `.db` cru
  devolveria um arquivo que abre, parece íntegro e está desatualizado. Há teste
  que prova a diferença.
- **Toda cópia é aberta e conferida** (`PRAGMA integrity_check` + contagem de
  contas) antes de ser aceita; a que não passa é apagada. Backup que ninguém
  abriu é suposição.
- **O backup mora no mesmo volume do banco, e isso está escrito como limite, não
  como recurso.** Protege contra erro de operação e arquivo corrompido; não
  protege contra perder o volume. O CLI avisa isso em toda execução, por stderr.
- **O pedido de recuperação responde sempre 202, com a mesma mensagem** — conta
  existente, inexistente, e-mail malformado, limite estourado ou SMTP fora do
  ar. Qualquer diferença observável transformaria uma rota pública e sem senha
  no verificador de assinantes do Processo Vivo.
- **Link inválido, vencido e já usado dão a mesma resposta.** Distinguir "já
  usado" contaria a quem achou o e-mail meses depois que aquele link foi real.
- **A senha nova é validada antes de o link ser consumido.** Do contrário um
  erro de digitação queimaria o link, e o limite de cinco por hora transformaria
  isso em ficar de fora da própria conta.
- **O token sai da barra de endereço assim que a página carrega**
  (`history.replaceState`). Na URL ele entraria no histórico, num favorito, numa
  captura de tela e no cabeçalho `Referer` de toda requisição externa.
- **Trocar a senha pelo painel mata os links de recuperação pendentes.** É
  justamente quem desconfia de invasão que troca a senha.
- **O endereço do link vem de `PROCESSOVIVO_URL_BASE`, nunca do cabeçalho `Host`.**
  Senão bastaria mandar outro `Host` para o servidor enviar, com a nossa cara,
  um link apontando para o endereço de quem atacou.
- **Sem SMTP a funcionalidade não existe, e a interface não a oferece.** Aceitar
  o pedido, dizer "enviamos um e-mail" e não enviar nada é pior do que não ter.

### Testes

De 446 para 472. Entre eles, um que **restaura de fato**: apaga o banco e os
arquivos do WAL, copia o backup por cima e sobe pelo mesmo `abrirBanco` da
produção, conferindo que as contas, os `workspace` e a carteira voltaram — e que
o banco restaurado aceita escrita nova. Procedimento de restauração que ninguém
executou é um palpite, e a hora de descobrir que ele não funciona não pode ser a
hora em que o banco sumiu.

### Achados de uma revisão de segurança adversarial, todos corrigidos

Antes de fechar a versão, o fluxo inteiro foi revisado por um segundo par de
olhos com a instrução de tentar quebrá-lo. Achou seis coisas. As duas primeiras
eram graves e teriam ido para produção:

- **O token de recuperação ia para o log de acesso.** O link é
  `GET /?recuperar=<token>`, e o servidor registrava a URL inteira em nível
  `info` — token válido, de uso único, com uma hora de vida, escrito no log do
  contêiner, que costuma seguir para um coletor de terceiro. Agora o log guarda
  só o caminho, sem query string, para toda rota: uma lista de parâmetros
  proibidos envelheceria mal e a próxima rota com segredo na URL entraria calada.
- **A recuperação se declarava disponível sem SMTP.** Sem `SMTP_HOST`, o sistema
  cai no notificador de log, que se declara habilitado de propósito — certo para
  a vigilância, desastroso aqui: o "envio" era um token que ninguém recebia, e a
  pessoa via "confira seu e-mail", gastava o link e, após cinco tentativas,
  ficava uma hora travada. O composition root agora só entrega o notificador à
  recuperação quando ele entrega de verdade.
- **O scrypt era pago antes de conferir o token** em `/v1/senha/redefinir`, que
  é pública: ~50ms de CPU e 16 MB por requisição, de graça, para qualquer token
  inventado. A ordem virou validar (de graça) → conferir o token → hash. A
  porta `HashDeSenha` ganhou um `validar` justamente para separar as duas coisas.
- **A poda de backups apagava arquivos que não eram dela.** O filtro era "começa
  com `processovivo-` e termina em `.db`", e alcançava a cópia manual que alguém
  guardou antes de uma migração. Agora só apaga o nome exato que ela própria
  gera — e registra no log QUAIS apagou, não só quantas.
- **Permissões da cópia**: 0700 na pasta, 0600 no arquivo. O backup é o banco
  inteiro num volume que pode ser montado noutro lugar.
- **`limparSessoesExpiradas` estava implementada, testada e nunca era chamada.**
  Entrou de carona na varredura que já roda.

Um sétimo ponto foi **documentado em vez de corrigido**: sobra uma diferença de
tempo de ~0,14 ms entre pedir recuperação para um e-mail cadastrado e para um
desconhecido. Está abaixo do jitter de qualquer rede, exigiria milhares de
amostras por endereço contra um teto de 60 requisições por minuto, e o 409 do
cadastro já revela o mesmo fato de graça por decisão de produto. O comentário no
código agora diz isso, em vez de afirmar uma simetria que não existe.

### Corrigido

- **O envio do e-mail de recuperação não é mais aguardado dentro da
  requisição.** Encontrado num teste de fumaça contra um SMTP inalcançável: com
  `await`, o pedido de um e-mail cadastrado ficava pendurado até o timeout do
  nodemailer, enquanto o de um endereço desconhecido voltava na hora. Status
  igual, mensagem igual — e o relógio contando quem é assinante. A enumeração
  que a rota inteira existe para impedir, entrando por outro canal. Agora os
  dois caminhos voltam em milissegundos, e há teste com um notificador que
  nunca responde.
- `.env.example` ainda descrevia o cadastro como fechado por convite, regra que
  deixou de valer na v0.14.0.

---

## [0.16.0] — 2026-09-17

**A carteira agora mostra as partes, e filtra por cliente em SQL.**

A v0.15.0 fez isso na busca por OAB, onde a lista está em memória. Aqui é
outra história: a carteira mora no banco, pode ter milhares de processos, e o
filtro precisa acontecer em SQL. Alguns advogados têm carteira grande, e achar
"os processos do cliente X" rolando a tela não é achar.

### Adicionado

- **As partes em cada linha de "Meus processos"** — nome e polo em palavra
  (`autor`, `réu`, `outra parte`), até quatro por linha, o resto como `+N`.
- **Campo "Parte"**, com filtro no servidor: `GET /v1/acompanhamentos?parte=`.
- **A vara na linha**, junto de tribunal e classe.
- **Rótulos na barra de filtros.** Eram seis caixas mudas em fila; na tela do
  dono do produto elas apareceram como "TribunalTJGOTRT18", indistinguíveis de
  conteúdo. Filtro que não se anuncia é filtro que ninguém usa.
- O foco volta para o campo depois de cada filtragem, com o cursor no fim —
  antes a tela era redesenhada e quem digitava perdia o campo no meio da
  palavra.

### A coluna nova, e a primeira migração de coluna do projeto

`partes_texto` guarda os nomes das partes normalizados. Desnormalizada pelo
mesmo motivo de `tribunal` e `classe`: resolver o filtro com `json_each` sobre
o processo inteiro desserializaria ~100 KB por linha **a cada tecla digitada**.
Numa carteira de 2.000 processos, 200 MB de JSON por busca.

Foi também a primeira coluna acrescentada a uma tabela que já existe em
produção, e isso exigiu migração de verdade: `CREATE TABLE IF NOT EXISTS` não
acrescenta coluna nenhuma num banco que já tem a tabela, e `ALTER TABLE ADD
COLUMN` estoura se a coluna já está lá. A checagem no `PRAGMA table_info`
precede a alteração.

Há **retrocarga no arranque**: sem ela o filtro acharia apenas os processos
sincronizados depois da atualização e ficaria calado sobre os outros — o erro
que a v0.14.2 já custou. Ela tolera JSON corrompido numa linha sem derrubar a
subida do servidor, e marca com texto vazio o processo que realmente não tem
parte, para ele sair da fila em vez de voltar a cada arranque.

### O `upper()` do SQLite é ASCII-only, e isso quase passou

A primeira retrocarga era SQL puro, elegante, com `group_concat` e
`json_each`. O teste reprovou: `upper('José')` devolve **`JOSé`** — o "é" fica
intacto. A retrocarga gravaria uma forma e as sincronizações seguintes outra, e
o advogado que buscasse "josé" acharia metade dos processos, sem erro nenhum em
lugar nenhum.

A correção virou `paraBusca`, num módulo próprio usado nos **três** pontos que
precisam concordar — gravação, retrocarga e consulta. Ela também dobra o
acento, porque ninguém digita acento numa busca: quem procura "José Antônio"
escreve "jose antonio", e um filtro que exige o acento correto parece dizer que
o cliente não tem processo.

### Nota sobre os dois campos de busca

`Parte` e `Busca livre` respondem perguntas diferentes, e é de propósito.
`Busca livre` varre o JSON inteiro e casa com qualquer menção — inclusive
dentro de um despacho, trazendo processo em que o cliente é apenas citado.
`Parte` casa somente com quem consta como parte. O primeiro é útil; o segundo
é preciso.

---

## [0.15.0] — 2026-09-17

**As partes já vinham na resposta e eram jogadas fora.**

Uma busca por OAB devolveu 130 processos. A pergunta do dono foi imediata: *"em
quais deles esse advogado representa o Condomínio Sunsquare?"* — e a resposta
já estava na tela, invisível. O DJEN manda os destinatários de cada intimação,
o mapper os consolida em `partes`, a rota devolve tudo, e a lista desenhava
apenas número, tribunal, classe e último andamento.

Carteira de 130 processos sem mostrar quem é a parte obriga o advogado a abrir
um por um para achar os do cliente X. É exatamente o trabalho que ele esperava
que o sistema fizesse.

### Adicionado — tela de resultado da busca por OAB

- **As partes em cada linha**, com o polo em palavra de advogado: `autor`,
  `réu`, `outra parte`. `OUTROS` não virou "terceiro": a fonte não disse isso,
  e ali pode estar o MP, um assistente ou um perito.
- **Filtro por parte, classe ou número**, aplicado **localmente** sobre a lista
  já em mãos. Refazer a consulta a cada letra digitada gastaria uma ida ao DJEN
  por tecla.
- **Filtro por tribunal**, montado a partir dos tribunais que apareceram.
- **"Mostrando X de Y"** sempre que houver recorte, com botão de limpar — a
  regra que ficou do filtro fantasma da v0.14.2.

### Corrigido — a CAIXA ALTA do DJEN

A tela mostrava `AçãO TRABALHISTA - RITO ORDINáRIO`. Não é defeito de
codificação: o DJEN manda caixa alta com os caracteres acentuados em
minúscula, e é assim que chega. Agora a exibição normaliza para
`Ação Trabalhista - Rito Ordinário`, com as preposições em minúscula.

O detalhe que fez a primeira tentativa falhar: testar "está todo em maiúsculas"
nunca dá verdadeiro nesse texto, justamente por causa dos acentos. O corte é
**70% de maiúsculas entre as letras**, o que reconhece o caso real e deixa
intacto o texto escrito normalmente. O dado guardado continua como veio, como
manda a regra do projeto — a normalização é só da camada de exibição.

### Decisão de estado

O filtro vive em `estado.buscaOab`, e **não** numa variável global da página:
nasce com a busca e morre com ela. Foi a lição da v0.14.2, onde um filtro em
variável global sobreviveu a trocar de aba e só morreu com o recarregamento —
convencendo o dono de que o sistema tinha perdido processos.

### O que isso NÃO resolve

Busca por **CNPJ** continua fora. O DJEN dá nome e polo da parte, sem
documento, e nem informa se é pessoa física ou jurídica. O MNI dá
`numeroDocumentoPrincipal` e `tipoPessoa` — e hoje esse dado chega e é
descartado, porque o `MniAdapter` só produz `Peca`. Aproveitá-lo é trabalho
pequeno, limitado ao TJGO, e depende de uma decisão: o MNI devolve **CPF
completo**, sem máscara, e guardar documento de pessoa física de quem não é
cliente do assinante muda o perfil de risco do Processo Vivo na LGPD. A recomendação
registrada é guardar CNPJ e descartar CPF na entrada.

Também não muda o teto da fonte: o DJEN lista como partes os destinatários das
intimações **publicadas**. Processo em que o cliente não foi intimado na janela
consultada pode não trazer o nome. O resultado do filtro é piso, não teto.

---

## [0.14.2] — 2026-09-17

**Um filtro esquecido, e a carteira parecia ter um processo em vez de três.**

A v0.14.1 tratou metade do problema — a tela inicial não dizia quantos
processos existem. Mas o relato seguinte foi decisivo: *"eu saí e entrei e
apareceram os processos"*. Sair e entrar recarrega a página, e recarregar a
página apaga as variáveis globais onde os filtros da tela de processos moram.

Ou seja: havia um filtro ativo. Ele sobrevivia a trocar de aba, a abrir
processo, a voltar — só morria com um recarregamento. E a tela mostrava o
subconjunto sem dizer que era um subconjunto.

"Sair e entrar resolveu" é o pior tipo de conserto: não explica nada e deixa a
desconfiança de pé para a próxima vez que algo parecer estranho.

### Corrigido

- **O botão de limpar filtros não limpava.** `Object.assign({}, filtros, {})`
  mantém tudo — o ramo de reset construía um objeto vazio e mesclava, o que é
  uma operação nula. Estava ali desde que a tela existe, aparentando funcionar.
- **`GET /v1/acompanhamentos` passa a devolver `totalSemFiltro`.** O total real
  da carteira acompanha toda listagem, sempre.
- **A tela avisa quando está escondendo algo**: "Mostrando 1 de 3 processos —
  há filtro ativo", com o botão de limpar ao lado. Interface que mostra um
  subconjunto calada é como se perde a confiança no dado.

### A regra que fica

Toda listagem filtrável devolve o total **sem filtro** junto do filtrado, e
toda tela que esconde linha diz quantas escondeu. Vale para processos,
novidades e o que vier — o custo é um COUNT, e o preço de não fazer foi o dono
do produto achando que o sistema tinha perdido os dados dele.

---

## [0.14.1] — 2026-09-17

**A tela inicial convenceu o dono de que o sistema tinha perdido dados.**

Ele cadastrou três processos numa conta nova, abriu o Processo Vivo, viu **um** item e
concluiu que só um tinha sido salvo. O banco tinha os três, íntegros, com
tribunal, classe e retrato completo. A consulta que a tela faz devolvia os três.

O que acontecia: a tela inicial mostra movimentação **nova**, e processo
recém-adicionado não gera nenhuma — a primeira sincronização é o retrato
inicial, e transformá-la em novidade encheria o feed de dezenas de avisos
falsos no primeiro dia. Dos três processos, só um tinha sido varrido uma
segunda vez pelo agendador; só ele tinha novidade; só ele aparecia.

Nada estava quebrado, e era esse o problema: a interface não dava como
distinguir "não tenho processo" de "tenho processos e nada mudou". Perda de
confiança no dado é mais cara do que perda de dado — a segunda se conserta.

### Corrigido

- `GET /v1/novidades` passa a devolver **`acompanhados`**, a contagem de
  processos do assinante (COUNT próprio, não `listar().length`, que
  desserializaria dezenas de KB de JSON por linha a cada abertura da tela).
- A tela inicial mostra esse número no subtítulo, **antes** do de movimentações.
- O estado vazio virou três estados, que antes eram dois e se confundiam:
  - nenhum processo → convite para adicionar o primeiro;
  - processos sem movimentação nova → **"Seus N processos foram verificados e
    nada mudou"**, com atalho para Meus processos. Silêncio verificado é
    informação, não ausência dela — é a mesma regra que obriga a notificação a
    avisar quando NÃO conseguimos verificar;
  - filtro ativo escondendo tudo → dizer que é o filtro.

### Verificado com o tribunal, não deduzido

O MNI do TJGO entrega peça **somente onde o advogado está habilitado nos
autos**. Medido com a mesma credencial em dois processos: no dele, 278
documentos e PDF baixando; no de outro advogado, sem acesso às peças. O
controle é do tribunal, e o Processo Vivo não precisa — nem deve — replicá-lo.
Para a venda: "as peças dos **seus** processos".

---

## [0.14.0] — 2026-09-16

**Cada advogado com o seu ambiente.**

Até aqui, entrar no Processo Vivo era colar uma chave de API — o que serve para uma
integração e não para uma pessoa. Agora há conta com e-mail e senha, e cada
conta nasce com o próprio ambiente: processos, vigilâncias e acesso ao tribunal
separados por assinante, na mesma instalação.

### O cadastro é progressivo, e isso é a decisão central

Pedir OAB e a senha do Projudi na primeira tela custaria a maior parte dos
cadastros — é muita confiança para quem ainda não viu o sistema funcionar.
Então:

1. **Nome, e-mail e senha** — já consulta qualquer processo por número,
   acompanha e recebe as atualizações.
2. **OAB e UF** — o sistema passa a achar sozinho os processos no nome da
   pessoa e a avisar de publicação nova.
3. **Acesso ao tribunal** — as peças das partes: petição, contestação, laudo.

A tela inicial mostra a trilha enquanto houver passo pendente, e cada passo diz
o que DESTRAVA, não o que exige. A trilha some quando tudo está pronto:
lembrete permanente vira ruído e ensina a ignorar a área mais importante da
tela.

### Adicionado

- **Contas** (`POST /v1/contas`), **sessão** (`POST`/`DELETE /v1/sessoes`) e
  **perfil** (`GET`/`PATCH /v1/eu`, `POST /v1/eu/senha`).
- **Telas de entrar e criar conta**, aba **Minha conta** e a trilha de
  liberação no topo das Atualizações.
- `COOKIE_SECURE` na configuração — deixe `true` em produção; `false` apenas
  para desenvolvimento em `http://localhost`, onde o navegador descarta cookie
  `Secure` em silêncio.

### Como a segurança foi montada

- **Senha com scrypt do `node:crypto`**, parâmetros gravados junto do hash —
  dá para encarecer no futuro sem invalidar senha de quem já é assinante. Sem
  dependência nativa, pelo mesmo motivo que escolheu `node:sqlite`: Alpine.
- **O banco guarda o HASH do token de sessão, nunca o token.** Vazamento do
  banco não vira sessão aberta.
- **O token não volta no corpo da resposta** — só no cookie `HttpOnly`. Se
  voltasse, a tela poderia guardá-lo no `localStorage` e desfazer a proteção.
- Em HTTPS o cookie se chama **`__Host-processovivo_sessao`**. O prefixo obriga o
  navegador a recusar gravação por subdomínio, o que fecha a fixação de sessão
  por subdomínio esquecido — ataque que sobrevive a `HttpOnly` e `SameSite`.
- **"E-mail não encontrado" e "senha incorreta" são a MESMA resposta**, e a
  verificação gasta o mesmo tempo nos dois casos, inclusive para e-mail
  malformado. Respostas diferentes transformariam o login num verificador de
  quem é cliente.
- **Trocar a senha encerra as outras sessões.** Quem troca costuma estar
  tirando alguém de dentro.
- **Sessão tem precedência sobre chave de API.** Com as duas presentes vence a
  pessoa; o contrário faria alguém ver a carteira da integração por baixo da
  própria conta, conforme a aba.

### Corrigido — achados de uma revisão de segurança

Nenhum destes veio de relato de uso; todos vieram de uma revisão dirigida ao
código novo. Os dois primeiros já existiam antes das contas.

- **`POST /v1/sincronizar` e `POST /v1/vigilancias/varrer` eram GLOBAIS.**
  Qualquer chamador autenticado disparava a varredura de TODOS os assinantes:
  consulta ao tribunal sobre a carteira alheia, escrita nos dados deles e
  gasto da cota compartilhada do CNJ em nome deles. Nada do conteúdo alheio
  voltava na resposta, que é justamente o que fazia isso passar despercebido.
  Agora as duas rotas são escopadas a quem pediu; a varredura agendada
  continua global, e há teste para os dois lados.
- **`trustProxy` aceitava a cadeia inteira de `X-Forwarded-For`**, que o
  cliente escreve. Um IP diferente por requisição caía num balde novo de rate
  limit e anulava o limite — na rota de login, que é pública e gasta scrypt,
  isso é força bruta sem teto e consumo de memória ao mesmo tempo. Agora só o
  salto que o nosso próprio proxy acrescenta é considerado.
- **`?ultimosDias=x` virava 500.** `Number('x')` era NaN, `new Date(NaN)`
  estourava `RangeError`, e uma query digitada errada acendia alarme de
  produção.
- **`PROCESSOVIVO_AUTH_DISABLED=true` estava quebrado**: sem chave nem sessão as
  rotas de dados não tinham ambiente e respondiam 500. O modo documentado agora
  funciona, com um ambiente fixo.
- **Servidor sem banco respondia 401 "sua sessão expirou"** nas rotas de conta,
  mandando a pessoa fazer login num laço infinito. Agora responde 501.

### Sabendo do risco

- **O cadastro é aberto, por decisão de produto** — o Processo Vivo vai ser vendido a
  advogados pelo Brasil, e formulário fechado por convite não combina com isso.
  Duas consequências ficam registradas: qualquer pessoa pode descobrir se um
  e-mail já é assinante (o 409 do cadastro denuncia), e a cota compartilhada do
  CNJ passa a depender do limitador do nosso lado, não do número de contas.
  Se o abuso aparecer, os caminhos são confirmação por e-mail antes da primeira
  consulta e teto de consultas no plano gratuito.
- **A varredura manual usa uma trava global.** Escopada, ela dura poucos
  segundos, mas enquanto roda a varredura agendada responde 409. Aceitável
  agora; vira trava por ambiente quando houver volume.
- Continua de pé a dívida do fixture de sucesso do MNI.

---

## [0.13.2] — 2026-09-16

**O download das peças, fechado contra o tribunal de verdade.**

A v0.13.1 fez as 278 peças aparecerem. Faltava o arquivo. A causa era a mesma
de antes, no outro caminho: pedir um documento pelo id com `movimentos=false`
devolve 800 bytes e nenhum documento. Com `movimentos=true`, 501.753 bytes,
o documento pedido e o PDF em anexo MTOM.

### Corrigido

- **`obterConteudo` pede a linha do tempo**, como `listarPecas` já fazia. O
  recorte por id continua: sem ele viriam as 278 peças a cada download.
- **O botão de download aparece em todas as peças.** A interface só o mostrava
  quando `conteudoDisponivel`, que na listagem do MNI é `false` para todas —
  inclusive as que baixam sem problema. Um processo inteiramente acessível
  aparecia com a mensagem "nenhuma peça liberada" e zero botões.
- **403 e 424 têm mensagem própria no download.** Antes qualquer falha virava
  "falhou — tentar de novo", o que fazia o advogado clicar dez vezes numa peça
  que ele não tem direito de ver. Agora: falta de procuração nos autos, ou
  senha recusada com o caminho para "Meus acessos".
- **O nome do arquivo é o do tribunal** (`certidaosistemadigital.pdf`), lido de
  `<outroParametro nome="NomeArquivo">`, e só então um nome montado por nós.

### Mudado

- `GET /v1/processos/:n/pecas` troca `comTeorDisponivel` por **`comArquivo`**.
  O primeiro contava "quantas vieram com o teor junto" — zero sempre, no MNI — e
  a tela lia isso como "quantas eu consigo abrir". São perguntas diferentes, e a
  segunda não tem resposta antes da tentativa.
- A tela e o CLI passam a destacar **quantas peças são das partes**, que é a
  informação que motivou tudo isso. No processo medido: 58 petições e 2
  procurações entre 278.

### Aprendido

- A forma da resposta de sucesso está verificada contra o TJGO ao vivo e
  documentada no teste: `<documento>` é filho de `<processo>` e carrega o
  `movimento` que o originou; `<movimento>` aponta de volta por
  `<idDocumentoVinculado>`; o teor vem por `xop:Include`, nunca inline.
- Dívida que continua: os BYTES da resposta de sucesso não estão versionados. A
  captura real tem 501 KB e carrega petição com dado de parte. Fechar isso exige
  `npm run cli -- pecas <n> --capturar` num processo escolhido para esse fim.

---

## [0.13.1] — 2026-09-16

**As peças apareciam como zero, e o tribunal não reclamava.**

Com a credencial do advogado cadastrada e correta, `GET /v1/processos/:n/pecas`
respondia `total: 0` num processo com 278 documentos. Nem erro, nem log, nem
teste vermelho: o TJGO devolvia `sucesso: true` e a resposta simplesmente vinha
sem a lista.

### Corrigido

- **`listarPecas` agora pede a linha do tempo** (`movimentos=true`). No Projudi
  o documento nasce pendurado num movimento, e sem pedir os movimentos o
  tribunal devolve só o cabeçalho — com sucesso. Medido no mesmo processo, mesma
  credencial, mesmo `incluirDocumentos=true`:

  | `movimentos` | resposta | `<documento>` |
  |---|---|---|
  | `false` | 4.122 bytes | 0 |
  | `true` | 279.653 bytes | 278 |

  Há teste travando a linha no envelope, porque é o tipo de mudança que se
  desfaz sem querer e volta a falhar em silêncio.

- **Classificação de origem ajustada pelo censo real** de um processo do TJGO
  (278 peças): "Ato Ordinatório" (17) e "Ementa" (1) caíam em `DESCONHECIDA` e
  agora são `JUIZO`.

### Aprendido

- No Projudi o rótulo da peça chega em `descricao`, **não** em
  `tipoDocumentoLocal` — esse atributo não existe na resposta real.
- `DESCONHECIDA` não é falha da heurística: 111 das 278 peças vêm rotuladas
  literalmente como "Outros" pelo próprio tribunal.

### Em aberto

- **Download do teor ainda não funciona.** Pedir um `<documento>` específico com
  `movimentos=false` devolve resposta sem documento nenhum (800 bytes sem
  cabeçalho, 4.122 com). Falta medir a combinação `movimentos=true` +
  `documento=<id>`. Enquanto isso, `obterConteudo` está sem caminho de sucesso
  verificado contra o tribunal.
- Continua de pé a dívida do fixture: os testes de sucesso do MNI rodam contra
  payload derivado do WSDL, não contra captura real.

---

## [0.13.0] — 2026-09-11

**A interface que faltava.**

A v0.12.0 entregou as peças pela API e parou aí. Do lado de quem usa, nada tinha
mudado: nenhum campo para o advogado informar o acesso dele, nenhuma peça em
tela. Funcionalidade que só existe para quem chama com `curl` não existe.

### Adicionado

- **Aba "Meus acessos"** — cadastro do acesso do advogado no tribunal, com
  tribunal, CPF e senha. Lista o que está cadastrado e o estado de cada um:
  usado com sucesso, ainda não usado, ou **recusado pelo tribunal** com a data.
  Esse último é o que evita a vigilância falhar em silêncio quando a senha muda.
- **Peças na tela do processo**, com a origem de cada uma (da parte / do juízo),
  data, assinantes e botão de download.
- O download vai por `fetch` e não por link direto: a rota exige o header
  `x-api-key`, que um `<a href>` não tem como mandar.

### Decisões que a tela carrega

- **As peças carregam DEPOIS do processo, em requisição separada.** A consulta
  ao MNI autentica no tribunal e pode levar dezenas de segundos; amarrada à
  principal, faria o advogado esperar por ela para ver as movimentações que já
  estavam prontas.
- **O 428 vira convite, não erro.** Sem credencial cadastrada, a tela explica que
  petição e documento de parte não são publicados no diário e oferece o botão de
  cadastrar — em vez de mostrar um código na cara de quem só queria ler a peça.
- **"Nenhuma peça com arquivo" é explicado na hora.** É o caso mais comum de
  todos — falta de procuração naquele processo — e o que mais parece defeito
  nosso sem uma frase dizendo o que é.
- **O campo de senha nasce sempre vazio**, inclusive com acesso já cadastrado: o
  servidor guarda cifrado e não devolve. A tela avisa, senão parece que não salvou.

---

## [0.12.0] — 2026-09-10

**As peças das partes.**

Até aqui o sistema mostrava decisões e julgados, e só. Não era limitação do
código: era o teto da fonte. O DJEN é o diário, e diário publica ato judicial —
petição, contestação, laudo e documento juntado pela parte **nunca são
publicados**. O DataJud não tem documento nenhum. Faltava a fonte que tem.

### Adicionado — MNI 2.2.2 do Projudi/TJGO

- **`MniAdapter`**, contra `https://projudi.tjgo.jus.br/IntercomunicacaoService`.
  O TJGO implementa MNI, ao contrário do que a ausência de `pje.tjgo.jus.br`
  sugere — o endereço só não segue o padrão `/intercomunicacao` do PJe, que ali
  responde 404. O link está na página inicial do próprio Projudi.
- **Autenticação por `idConsultante` + `senhaConsultante`**: usuário e senha do
  advogado, dentro do envelope SOAP. Não passa pela tela de login, então não há
  CAPTCHA nem código por e-mail no caminho, e este tribunal não exige
  certificado digital.
- **Entidade `Peca`** separada de `Movimentacao`: a movimentação diz que algo
  aconteceu, a peça é o arquivo. O TEOR não mora na entidade — `Peca` é metadado
  e circula barato; o arquivo sai por rota própria, uma peça por vez, senão uma
  listagem despejaria dezenas de MB na resposta.
- **Porta `ProvedorDePecas`, deliberadamente separada de `ProcessoProvider`.**
  Não é purismo: `CachedProcessoProvider` indexa por número de processo, **sem
  workspace na chave**. Uma fonte com credencial dentro da cadeia serviria ao
  assinante seguinte a resposta obtida com a credencial do anterior.
- Rotas `GET /v1/processos/:numero/pecas` e
  `GET /v1/processos/:numero/pecas/:id` (download como anexo).
- `npm run cli -- pecas <numero>` lendo a credencial do AMBIENTE, não do banco:
  serve para validar o acesso antes de cadastrar ninguém. Com `--capturar`,
  grava a resposta crua do tribunal.

### Adicionado — cofre de credenciais

- **`credenciais_tribunal`, com a senha cifrada em AES-256-GCM.** É o dado mais
  sensível do banco: a chave de API só abre o Processo Vivo, esta abre o processo no
  tribunal. GCM e não CBC porque o GCM autentica — adulterar a coluna dá erro de
  decifração, e não um "segredo" corrompido que só falha lá no tribunal
  parecendo senha errada do usuário.
- **Sem `PROCESSOVIVO_CREDENCIAL_CHAVE`, o acesso a peças não é montado** e as rotas
  respondem 501 com a instrução. Não existe caminho que guarde senha em claro.
- Chave gerada por `npm run chave -- --cofre`.
- Rotas `GET/PUT/DELETE /v1/credenciais`. A senha nunca volta na resposta — nem
  mascarada: `***` convidaria a interface a exibir um campo "preenchido" que não
  pode ser reenviado, e o próximo salvamento gravaria os asteriscos como senha.

### Descoberto na captura real, e que teria custado caro

Duas armadilhas que nenhum fixture escrito por quem implementa revelaria. As
duas estão gravadas em `tests/fixtures/mni-tjgo-credencial-invalida-real.txt`:

- **A resposta não é XML puro.** Vem em `multipart/related` (Apache CXF, com
  XOP/MTOM). Quem chamar o parser direto sobre o corpo recebe lixo.
- **O teor dos documentos não vem em base64**, embora o WSDL declare
  `xs:base64Binary`. Vem como parte binária separada, referenciada por
  `<xop:Include href="cid:...">`. Um mapper que lesse `conteudo` como base64
  acharia string vazia e concluiria "o tribunal não liberou o arquivo" — com o
  arquivo ali, na parte seguinte da mesma resposta.
- **Recusa vem com HTTP 200.** `sucesso: false` no corpo. Confiar em
  `resposta.ok` faria "Usuário ou Senha inválida." virar consulta bem-sucedida
  com zero peças — indistinguível de "processo sem documentos".

### Segurança e limites, explícitos

- **Uma tentativa, sem retry.** Diferente de todos os outros adapters, e de
  propósito: a requisição carrega a senha do advogado, e o Projudi conta
  tentativa malsucedida para bloquear conta. Retry transformaria senha
  desatualizada em três recusas por consulta, e a vigilância de hora em hora
  levaria ao bloqueio no mesmo dia.
- **30 requisições/minuto**, metade do teto relatado antes de bloqueio de IP de
  datacenter (403, espera de ~30 min). Num VPS o IP é de todos os assinantes.
- **A trava que nenhum código contorna:** o MNI devolve as peças conforme o
  perfil de acesso do consultante. Sem procuração nos autos, o metadado vem e o
  conteúdo não. Daí `TeorNaoAutorizadoError` ter nome próprio: a interface diz
  "você não está habilitado neste processo", e não "erro ao baixar".
- Status HTTP novos, escolhidos para dizer o que fazer: **428** (falta
  cadastrar credencial — não 401, que mandaria refazer login à toa), **424** (o
  tribunal recusou a credencial — nem 401 nem 502), **403** (respondeu e negou o
  arquivo — não 404, que diria que a peça não existe).

### Corrigido

- **`.env.example` estava desatualizado e sabotava a busca por OAB.** Trazia
  `PROCESSOVIVO_PROVIDER_CHAIN=mock-crawler-tjsp,datajud` e `DATAJUD_TIMEOUT_MS=8000`.
  Quem seguisse o README (`cp .env.example .env`) subia sem DJEN na cadeia: a
  vigilância respondia 501 e a busca por OAB devolvia zero. O arquivo correto
  tinha virado `env.example` (sem ponto) num dos uploads, e o antigo ficou.
- Removidos do repositório `download` (um `.dockerignore` antigo),
  `download (1)` (um `.gitignore` antigo) e `prettierrc.json`, duplicata de
  `.prettierrc.json`.
- README anunciava v0.8.0 com o `package.json` em 0.11.0.

### Dívida assumida, declarada aqui para não ser esquecida

O caminho de SUCESSO do MNI **ainda não tem captura real**: exige a credencial
de um advogado habilitado nos autos, e não havia nenhuma disponível. Os testes
de sucesso rodam contra um payload montado a partir do WSDL real — que é
exatamente o circuito fechado que o CLAUDE.md manda evitar. Na primeira consulta
bem-sucedida, use `npm run cli -- pecas <numero> --capturar` e substitua o bloco
`xmlComDocumentos` de `tests/infrastructure/MniAdapter.spec.ts` pela resposta de
verdade.

---

## [0.11.0] — 2026-09-07

**O Processo Vivo passa a parecer o que já era.**

A crítica que originou esta versão foi simples: a tela estava bem construída,
mas parecia ferramenta interna, não produto que se vende. O que denunciava não
era acabamento — era, em ordem, a porta de entrada, a ausência de painel e a
falta de identidade.

### Adicionado — contas de verdade

- **Entrada com e-mail e senha.** "Cole sua chave de API" era o momento mais
  evidente de que aquilo não era um produto: nenhum advogado entende a
  expressão. Agora é login, como qualquer serviço que se paga.
- **Senha com `scrypt` do próprio Node.** Não é bcrypt nem argon2 pela mesma
  razão que levou ao `node:sqlite` no lugar do `better-sqlite3`: **zero
  dependência nativa** — a imagem é Alpine e compilar módulo nativo lá exige
  python, make e g++. Os parâmetros vão gravados junto do hash, para o custo
  poder subir no futuro sem invalidar as senhas antigas.
- **Sessão em cookie HttpOnly**, com o HASH do token no banco — nunca o token.
  Se o banco vazar, o que está lá não abre conta nenhuma. `SameSite=Lax` para
  que chegar pelo link do e-mail de aviso não caia na tela de login, e `Secure`
  apenas sob HTTPS (marcar sempre faria o navegador descartar o cookie em
  `localhost`, com o sintoma "faço login e volto para o login").
- **Cadastro por código de acesso**, que é uma das chaves de `PROCESSOVIVO_API_KEYS`.
  Não é burocracia: a chave do CNJ é compartilhada por todo o país, e um
  formulário aberto na internet transforma o VPS em proxy gratuito para a cota
  alheia — quem leva o bloqueio é a chave. Distribuir uma chave por cliente vira,
  de quebra, o mecanismo natural de onboarding e revogação.
- **A chave de API continua valendo** para integração (n8n, CLI, scripts). Os
  dois caminhos resolvem para o mesmo `workspace`, e nenhuma rota de dados sabe
  qual dos dois trouxe a requisição. A sessão tem precedência: com os dois
  presentes, vence a pessoa — do contrário a carteira "sumiria" conforme a aba.

### Adicionado — painel e primeiro uso

- **Painel como tela inicial.** Antes o usuário caía numa lista. Lista não
  responde à pergunta que ele traz ao abrir — "tem alguma coisa me esperando?".
  Quatro números: novidades não lidas, processos acompanhados, inscrições
  vigiadas e **quando foi a última verificação**. O último é o que quase nenhum
  concorrente mostra, e é o que separa "nada aconteceu" de "o sistema parou de
  olhar".
- **Primeira execução guiada**, em três passos, começando pelo que dá resultado
  sem digitar número nenhum (cadastrar a OAB). Um painel zerado é a pior
  primeira impressão possível de um SaaS.

### Alterado — identidade visual

- **Tema claro** com fundo levemente quente, verde-petróleo como marca e serifa
  nos títulos. A escolha é comercial, não estética: escuro lê como ferramenta de
  programador, e praticamente todo software jurídico brasileiro é azul — o
  petróleo mantém a seriedade sem se confundir com os concorrentes.
- **Marca em SVG inline** (também usada como favicon), sistema de cor em tokens,
  hierarquia tipográfica e estados vazios desenhados.
- Tudo continua **sem nenhum recurso externo**: fonte do sistema, zero CDN, zero
  build. Um teste garante isso — carregar Google Fonts quebraria o console de
  quem estiver atrás do firewall de um fórum.

### Corrigido

- **Campos de filtro sem estilo.** Os `input` e `select` das telas de processos,
  atualizações e busca não usavam a classe do sistema de design e apareciam com
  a aparência nativa do navegador no meio de uma interface desenhada. Foi visto
  em captura de tela real, não no código.
- **Rodapé flutuando no meio da página** sempre que o conteúdo era curto — que é
  exatamente o caso de quem acabou de assinar.
- **501 logado como erro, com stack trace.** Vigilância por OAB sem o DJEN na
  cadeia não é falha, é configuração; a cada abertura da aba o log ganhava um
  stack. É assim que se aprende a ignorar o log, que é o único lugar onde o 500
  de verdade aparece. Virou aviso, sem stack.

### Migração

A primeira conta criada **adota o workspace derivado da primeira chave de API**.
Sem isso, você criaria sua conta e encontraria a carteira vazia, achando que o
deploy apagou os dados. Sai uma linha no log quando acontece.

---

## [0.10.0] — 2026-09-05

**O sistema deixa de vigiar o que você digitou e passa a vigiar o seu nome.**

Até aqui era preciso saber o número do processo para acompanhá-lo — ou seja, era
preciso já saber que o processo existe. Esta versão inverte isso e fecha o ciclo:
detecta sozinho, separa o que pede providência, e avisa.

### Adicionado

- **Vigilância contínua por OAB.** O advogado cadastra a inscrição uma vez; toda
  publicação nova no nome dele entra sozinha na carteira. Novas rotas
  `/v1/vigilancias` e aba **Vigilância** no console.
  - A primeira varredura olha **30 dias**, não o histórico inteiro: um advogado
    com 1.871 publicações veria a carteira toda entrar como "novidade" e o aviso
    de verdade sumiria no meio.
  - As seguintes retomam com **2 dias de sobreposição**, porque o DJEN indexa
    com atraso e varrer do exato ponto de parada perderia publicação — que é
    perder prazo.
  - Roda **de hora em hora**, contra as 12h da varredura de processos. Pode,
    porque só toca o DJEN (200ms, sem chave). Amarrar as duas no mesmo relógio
    fazia a fonte lenta ditar o ritmo da rápida, e é na rápida que estão as
    publicações que abrem prazo.
- **Notificação por e-mail**, via SMTP (`Notificador` como porta, para o
  WhatsApp entrar depois sem mexer no resumo). Um e-mail por ciclo, agrupado por
  processo, com o trecho do teor — não um e-mail por movimentação.
- **Aviso de que NÃO conseguimos verificar.** Se a última varredura bem-sucedida
  passar de 26h, sai um alerta. É metade da funcionalidade, não um extra:
  notificação é uma promessa, e a partir do primeiro aviso o advogado passa a
  ler silêncio como "não houve nada". Um sistema que só avisa novidade é pior do
  que não ter notificação, porque troca incerteza conhecida por falsa segurança.
- **Triagem do que exige ação** (`domain/entities/triagem.ts`): separa o ato que
  abre prazo ou pede providência (`INTIME-SE`, `MANIFESTE-SE`, "prazo de N
  dias", sentença, decisão, acórdão) do registro de cartório (juntada,
  expedição, conclusão). Aplicada uma vez, na construção do `Processo`, para que
  API, e-mail e tela concordem. **Nunca esconde andamento** — só ordena e
  destaca.
- **Modo log do notificador**: sem SMTP configurado, o caminho inteiro continua
  sendo exercitado e o log mostra o que teria saído.

### Alterado — a tela do processo

O topo respondia "o que é este processo?" quando a pergunta do advogado ao abrir
é "o que eu preciso fazer?". A ordem mudou:

1. **Pede providência** — o que abre prazo, com trecho do texto
2. **Última movimentação** — agora com o inteiro teor, não só o rótulo
   ("Ato ordinatório" é categoria, não informação)
3. **Partes** — quem está do outro lado importa mais que a data de distribuição
4. Ficha cadastral, com **hora** na verificação (verificado às 03h e às 14h são
   coisas diferentes quando se conta prazo) e as fontes que responderam
5. Andamentos, com filtros (tudo / pede providência / com inteiro teor) e
   **"ler o ato inteiro"** por andamento

### Corrigido

- **O DJEN devolve um aviso no lugar do inteiro teor** quando o documento não é
  público: `ARQUIVOS DIGITAIS INDISPONÍVEIS (NÃO SÃO DO TIPO PÚBLICO)`. São
  **43 das 62 publicações** do processo de teste — 69%. O mapper guardava esse
  aviso como se fosse o despacho, e a tela exibiria 43 andamentos com um
  "inteiro teor" que só diz que não há inteiro teor. Agora é reconhecido, marcado
  como `teorIndisponivel` e acompanhado do link para o tribunal. Efeito colateral
  desejado: com o teor legitimamente ausente, o orquestrador volta a considerar
  que falta conteúdo e continua perguntando às outras fontes.
- **Corpo de requisição inválido virava HTTP 500.** `ZodError` não estava
  mapeado, então um campo faltando acendia alarme de produção em vez de dizer ao
  cliente qual campo corrigir. Agora é 400, com o nome do campo.
- **Resumo reenviado a cada ciclo.** O filtro do repositório é
  `detectada_em >= desde`, e usar o instante do último envio reincluía a novidade
  detectada no mesmo milissegundo. O usuário receberia o mesmo aviso para sempre
  e pararia de confiar no aviso.

### Notas de arquitetura

- `Movimentacao` ganhou `teorIndisponivel`, `exigeAcao`, `fonte` e `url`.
- Falha de varredura **não** marca a inscrição como varrida: marcar abriria um
  buraco silencioso exatamente no período em que a fonte esteve fora.
- A vigilância **funde** o retrato guardado com o que o DJEN traz, nunca
  substitui — o DJEN não tem os andamentos internos, e substituir faria um
  processo de 361 andamentos aparecer com 8.
- `nodemailer` é a primeira dependência de runtime nova desde o Fastify.

### ⚠️ Ação necessária no deploy

Se `PROCESSOVIVO_PROVIDER_CHAIN` estiver preenchida no Easypanel com o valor antigo,
**troque para `datajud,djen`**. Valor explícito ganha do padrão do código — foi
por isso que o DJEN não entrou na v0.9.0. Sem `djen` na cadeia, a vigilância por
OAB responde 501.

---

## [0.9.0] — 2026-09-05

**A busca por OAB passa a existir — e o processo passa a vir inteiro.**

Até aqui o Processo Vivo enxergava metade de cada processo: o DataJud entrega
metadados e a linha do tempo codificada, mas não indexa parte nem advogado, e
por isso `buscarPorOab` só sabia lançar `OperacaoNaoSuportadaError`. Esta versão
fecha o buraco com uma segunda fonte oficial.

### Como cheguei aqui — e por que NÃO tem crawler

O plano era escrever um crawler do tribunal. Investiguei antes de codar, e a
investigação matou o plano duas vezes:

1. **O TJGO não usa eproc.** O campo `sistema` do DataJud diz `Eproc`, mas
   nenhum host de eproc do TJGO existe (`eproc.tjgo.jus.br`, `eproc1`, `eproc2`
   — todos sem DNS). O sistema real é o **Projudi**. Um adapter escrito a partir
   daquele campo teria sido escrito contra um sistema que o tribunal não usa.
2. **A consulta pública do Projudi é protegida por Cloudflare Turnstile.** O
   formulário carrega `challenges.cloudflare.com/turnstile/v0/api.js` em modo
   `render=explicit` e o botão Buscar nasce `disabled`, só habilitando com token
   válido. Não é rate limit: é desafio anti-bot em toda consulta. E o formulário
   **não tem campo de OAB** — mesmo vencido o desafio, a funcionalidade
   pretendida não estava lá.

Contornar CAPTCHA está fora de cogitação: é o tribunal dizendo que não quer
robô, e dependeria de serviço pago de resolução, com custo por consulta e
quebra a cada ajuste da Cloudflare.

A saída foi outra fonte oficial.

### Adicionado

- **`DjenAdapter`** — Diário de Justiça Eletrônico Nacional, via Comunica API do
  CNJ (`comunicaapi.pje.jus.br`). Sem chave, sem CAPTCHA, cobertura nacional.
  Traz o que faltava:
  - **busca por OAB de verdade** (`numeroOab` + `ufOab`), a funcionalidade que
    faz um advogado assinar;
  - **partes**, com polo;
  - **advogados**, com número e UF da inscrição;
  - **inteiro teor** do ato publicado, não só o rótulo.
- **Enriquecimento entre fontes** no `ProcessoSearchService`. Achar o processo
  deixou de encerrar a busca: as fontes seguintes que sabem algo que a vencedora
  não sabe são consultadas e os resultados são fundidos. É o que torna a
  arquitetura híbrida de fato híbrida, e não só uma cadeia de fallback.
- **`fundirProcessos`** (`domain/entities/fusaoProcessos.ts`) — regra de
  precedência entre fontes: a preferida vence em campo escalar, a complementar
  só preenche buraco, e as linhas do tempo se unem sem duplicar.
- **Capacidade `retornaLinhaDoTempoCompleta`** na porta `ProcessoProvider`.
  Sem ela o orquestrador via um resultado do DJEN com partes e teor, concluía
  que não faltava nada, e nunca perguntava ao DataJud — um processo com 361
  andamentos apareceria com 8.
- **`Movimentacao.idExterno`, `.url` e `.fonte`.** O `idExterno` conserta um bug
  latente na detecção de novidades: a chave era `data|titulo`, e o DJEN informa
  só o dia, então duas decisões publicadas no mesmo dia no mesmo processo
  viravam uma só e a segunda nunca era avisada.
- **Acompanhar em lote** na tela: o resultado da busca por OAB ganhou o botão
  *Acompanhar todos*. Digitar a própria inscrição uma vez e sair com a carteira
  inteira sob vigilância é o fluxo que fecha o produto.
- `tests/fixtures/djen-comunica-real.json` — captura real, com as armadilhas
  anotadas no cabeçalho.
- Suíte de integração `hibrido-datajud-djen.spec.ts`, que roda a cadeia contra
  as duas capturas reais e falha se o enriquecimento parar de acontecer.

### Corrigido

- **Enriquecimento não reabre fonte já descartada.** Uma fonte que acabou de dar
  timeout, que não cobre o tribunal ou que reprovou no health check não é
  consultada de novo na etapa de complemento.
- **O tribunal considerado no complemento é o do número CONSULTADO**, não o do
  processo devolvido — senão uma fonte que responde errado passa a decidir quem
  mais é chamado.
- `HttpClient.get` passou a aceitar `OpcoesRequisicao` (timeout e tentativas por
  chamada), como o `postJson` já aceitava.
- Duas mensagens da interface afirmavam que busca por OAB e inteiro teor
  "dependem do crawler do tribunal". Virou mentira quando o DJEN entrou, e
  mensagem desatualizada manda o usuário procurar defeito onde não há.

### Alterado

- **`PROCESSOVIVO_PROVIDER_CHAIN` mudou de `mock-crawler-tjsp,datajud` para
  `datajud,djen`.** O mock saiu do padrão: em produção ele inventaria processo.
  Sem `DATAJUD_API_KEY` a cadeia degrada sozinha para só o DJEN — que não exige
  chave, então o serviço sobe e funciona sem nenhuma configuração de fonte.

### Limites honestos desta fonte

- O DJEN só conhece o que foi **publicado no diário**. Juntada, conclusão e
  expediente de cartório não aparecem — para isso o DataJud continua na cadeia.
- Histórico curto: consulta a 2020 devolve zero. O DJEN concentra as publicações
  nacionais a partir de 2023/2024.
- `destinatarios` e `destinatarioadvogados` vêm como listas irmãs, sem ligação
  entre si. Com um destinatário — o caso comum — a associação é inequívoca; com
  vários, os advogados são atribuídos a todas as partes daquela comunicação.
- O DJEN não informa se a parte é pessoa física ou jurídica. Fica
  `DESCONHECIDO`; adivinhar por sufixo erra com espólio e condomínio.

---

## [0.8.0] — 2026-09-05

**O Processo Vivo deixa de ser consulta avulsa e vira produto de acompanhamento.**

### ⚠️ Ação necessária no deploy

Monte um **volume em `/dados`** no Easypanel (aba Mounts). Sem ele, o banco vive
dentro do contêiner e é apagado a cada redeploy — a carteira do usuário some.
Ver [DEPLOY.md](./DEPLOY.md).

A imagem passou para **Node 24**, exigido pelo `node:sqlite`.

### Adicionado

- **Acompanhamento de processos.** O usuário marca um processo e o Processo Vivo passa
  a verificá-lo sozinho. A primeira consulta acontece na hora de adicionar, para
  o processo já aparecer preenchido na lista.
- **Feed de atualizações.** Só o que apareceu DEPOIS de você começar a
  acompanhar, em ordem cronológica, com marcação de lido. Para um advogado, é
  provavelmente a tela mais útil: não "meus 40 processos", e sim "o que mudou".
- **Varredura automática em segundo plano**, a cada 12h por padrão, com disparo
  manual pela tela. Sequencial e com pausa entre consultas — paralelizar contra
  a chave compartilhada do CNJ queimaria a cota de todo o país.
- **Navegação de verdade**: Atualizações, Meus processos e Buscar, com detalhe do
  processo e volta.
- **Filtros** na lista (texto, tribunal, classe, período, só com novidade,
  ordenação) e no feed (não lidas, tribunal), alimentados por facetas reais do
  banco.
- **Espaços isolados por chave de API.** Enquanto não há contas de usuário, cada
  chave é um assinante com sua própria carteira. A coluna `workspace` já existe
  no banco, então migrar para login não mexe no modelo.
- Persistência em **SQLite** via `node:sqlite` — sem dependência nativa, sem
  toolchain de compilação no Alpine, sem serviço extra para subir.
- 34 testes novos (total: 218), incluindo isolamento entre workspaces, detecção
  de novidade entre duas varreduras e idempotência da sincronização.

### Decisões que vale registrar

**Por que banco agora, depois de eu ter recusado.** Recusei quando o motivo era
"guardar processos" — não havia o que guardar além de ficção. Duas medidas
mudaram isso: a consulta fria ao CNJ leva ~20s (medido: `took: 20514`), então o
usuário não pode esperar pela fonte; e "o que mudou desde ontem" é irrespondível
sem ter o ontem. O banco deixou de ser preferência de arquitetura e virou
requisito medido.

**Primeira sincronização não gera novidade.** O histórico inteiro seria "novo";
despejar 361 avisos em quem acabou de adicionar o processo não ajuda ninguém.

**Movimentação que some da fonte não vira alarme.** Tribunal reescreve e remove
andamento; tratar ausência como evento geraria alarme falso a cada oscilação, e
alarme falso corrói a confiança no aviso que importa.

**Falha ao adicionar não desfaz o acompanhamento.** O processo fica na lista com
o motivo, e a varredura tenta de novo — senão o usuário teria que readicionar
toda vez que o tribunal saísse do ar.

---

## [0.7.0] — 2026-09-05

Foco: a tela mostrar o que importa, e a data certa.

### Corrigido

- **A data de distribuição aparecia um dia antes.** O formato compacto do CNJ
  (`"20150826000000"`) não declara fuso, e eu o interpretava como UTC — que,
  exibido em horário de Brasília, volta para 25/08. Aparecia na tela como
  "Distribuição 25/08/2015" para um processo distribuído em 26/08. Agora é
  interpretado como UTC−03:00, que é como o CNJ carimba. Teste novo verifica a
  data **exibida**, não só a existência dela: o teste anterior passava com a data
  errada.

### Adicionado

- **Cabeçalho com o estado do processo**: número em destaque, classe e assunto,
  selos de tribunal/grau/fonte, e um bloco "última movimentação" com o tempo
  decorrido em linguagem natural ("há 2 meses").
- **Linha do tempo organizada**, no lugar da lista plana de 361 itens:
  - agrupada por ano, com o ano fixo no topo enquanto se rola;
  - repetições idênticas no mesmo dia colapsadas em um item com `×N` — o CNJ
    registra "Confirmada" duas e três vezes seguidas;
  - **andamentos internos recolhidos por padrão** (confirmações, expedições,
    juntadas de documento). Numa resposta real de 361 andamentos, isso reduz a
    124 o que aparece de primeira — 66% do volume é registro de cartório que não
    muda o estado do processo;
  - **marcos em destaque** (distribuição, sentença, trânsito em julgado, alvará,
    decurso de prazo).
- Metadados em grade, com contagem total de andamentos.

### Importante sobre o que fica recolhido

Nada é descartado. A contagem do que foi recolhido fica sempre visível, um
clique reverte, e a escolha é lembrada no navegador. Sumir com movimentação em
silêncio é como se perde prazo — o mesmo princípio que fez a data em formato
desconhecido passar a falhar alto na v0.5.0.

A classificação entre "interno" e "marco" usa códigos da Tabela Processual
Unificada observados numa resposta real do TJGO, mas quem decide o que importa é
quem advoga. Se estiver errada, é a tabela que muda — o dado continua todo lá.

---

## [0.6.0] — 2026-09-04

**O sistema passou a ter tela.**

### Adicionado

- **Console web em `/`**, servido pela própria API. Abrir o domínio no navegador
  agora abre o sistema: campo para a chave, consulta por número CNJ ou por OAB,
  e o processo renderizado com partes e movimentações.

  Motivo: até aqui o Processo Vivo era só API. Digitar a URL no navegador devolvia
  `{"erro":"NAO_AUTENTICADO"}`, porque navegador não manda header customizado —
  e do lado de quem usa, isso é indistinguível de "não funciona". Servindo da
  mesma origem, a página manda o `x-api-key` sozinha: sem CORS, sem PowerShell,
  sem curl.

- A tela mostra **cronômetro e aviso durante a espera**, porque a consulta fria
  ao CNJ leva até um minuto — sem isso, a página pareceria travada.
- Cada código de erro vira explicação em português, incluindo o 501 de busca por
  OAB (que o DataJud não faz) e o 502 de fonte externa lenta ou fora.
- A ausência de partes é dita na tela em vez de aparecer como espaço vazio: a
  base do CNJ não publica partes nem advogados.
- 8 testes novos (total: 180), incluindo que a raiz abre sem chave, que as rotas
  de dados **continuam** protegidas, e que a página não carrega nada de fora.

### Notas

O console é uma ferramenta de operação para conferir o serviço, não o produto
final: a chave de API fica no navegador de quem opera. O produto terá contas de
usuário, e a chave nunca chegará ao navegador do advogado.

Sem framework, sem build, sem recurso externo — a página é uma string que o
servidor devolve. Nada para compilar e nada que quebre em deploy.

---

## [0.5.0] — 2026-09-04

**Primeira versão validada contra uma resposta real da API do CNJ.** Até aqui,
todo o adapter do DataJud tinha sido escrito e testado contra um fixture que eu
inventei a partir da documentação. A primeira captura real derrubou duas
suposições no primeiro minuto.

### Corrigido

- **`dataAjuizamento` não é ISO.** Vem como `"20150826000000"`
  (`yyyyMMddHHmmss`), enquanto `movimentos[].dataHora` no MESMO documento vem em
  ISO 8601. O mapper fazia `new Date()` nos dois: o compacto virava
  `Invalid Date`, que virava `undefined`, e o processo era entregue "com
  sucesso" **sem data de distribuição**. Nenhum dos 161 testes pegou, porque
  todos validavam a minha suposição contra ela mesma.
- **Timeout curto demais fazia toda consulta fria falhar.** O Elasticsearch
  público do CNJ reportou `took: 20514` — 20,5 segundos — numa busca por número
  em índice frio. O teto era 8s. O erro saía como "timeout ao contatar a API do
  CNJ", que parece problema de rede e mandou a investigação para o lado errado.
  Consultas: 60s e 2 tentativas. Health check: 15s (era 5s) e 1 tentativa.

### Alterado

- **Data em formato desconhecido agora falha alto** (`RespostaInvalidaError`,
  nomeando campo e valor) em vez de virar `undefined`. Num produto onde a data
  decide prazo, entregar campo vazio é pior que recusar a resposta — o
  orquestrador ainda pode tentar outra fonte, mas ninguém reage a um campo que
  sumiu em silêncio. Campo AUSENTE continua sendo ausência, não erro.
- `tests/fixtures/datajud-tjgo-real.json` substitui o fixture inventado.
  Captura real do TJGO, valores intocados, lista de movimentos reduzida
  mantendo um exemplar de cada forma. Daqui em diante, o comportamento do CNJ se
  testa contra o que ele devolve.

### Confirmado pelo dado real

- Zero partes, zero advogados, zero inteiro teor. A busca por OAB não sai do
  DataJud — é o que sustenta a existência do crawler próprio no desenho.
- O processo do TJGO usado na captura roda em **eproc**
  (`"sistema": {"nome": "Eproc"}`), não Projudi.

### Em aberto

60 segundos é tempo demais para um usuário esperando numa tela. Este release
torna a consulta possível, não confortável. A saída é buscar em segundo plano e
servir do armazenamento, com o usuário fora do caminho crítico da fonte — e é
essa lentidão medida, não uma preferência de arquitetura, que passa a justificar
um banco.

---

## [0.4.2] — 2026-09-03

Foco: o health check do DataJud dava timeout contra a API real.

### Corrigido

- **A consulta de verificação era `match_all` no índice do TJSP** — o maior
  tribunal do país. Mesmo com `size: 0`, isso faz o Elasticsearch percorrer e
  contar o índice inteiro: a query mais cara possível, disparada a cada
  `/ready`. Contra a API pública compartilhada e sob carga, dava timeout, e o
  Processo Vivo concluía "fonte fora do ar" com a fonte no ar. Agora a consulta casa
  com zero documentos (um número CNJ de vinte zeros), que responde a mesma
  pergunta — "consigo falar com a fonte e ela me aceita?" — de graça.
- **O health check herdava a política de retry das consultas de usuário**
  (3 tentativas × 8s + backoff): o `/ready` podia levar mais de 25 segundos só
  para dizer que a fonte estava fora — tempo suficiente para um orquestrador de
  contêiner concluir que o serviço inteiro morreu. Agora é tentativa única com
  teto de 5s.

### Adicionado

- `OpcoesRequisicao` no `HttpClient`: `timeoutMs` e `tentativas` por chamada,
  sobrepondo o padrão do cliente. Nem toda requisição merece a mesma política —
  consulta de usuário compensa esperar e insistir, health check não.
- 7 testes novos, incluindo a política de retry do `HttpClient` contra `fetch`
  dublado (total: 161).

---

## [0.4.1] — 2026-09-03

Foco: impedir que texto de exemplo vire credencial.

### Corrigido

- **O bloco de configuração do `DEPLOY.md` trazia placeholders não vazios**
  (`DATAJUD_API_KEY=COLE_AQUI_A_CHAVE_DO_CNJ_OU_DEIXE_VAZIO`). Colado como
  estava, o valor passava em toda checagem de presença: o adapter do DataJud
  subia com uma credencial de mentira, entrava na cadeia e só falhava com 401 —
  aparecendo no `/ready` como problema de disponibilidade, não de configuração.
  Os blocos agora vêm com os valores realmente vazios e a instrução em
  comentário.

### Adicionado

- `pareceValorDeExemplo()` — detecta placeholder não substituído. A heurística é
  conservadora de propósito (só maiúsculas/dígitos/`_`/`-` **e** termo suspeito),
  porque falso positivo aqui recusaria credencial legítima.
  - `DATAJUD_API_KEY` com placeholder → fonte tratada como **ausente**, com aviso
    dizendo o que fazer, em vez de virar credencial quebrada.
  - `PROCESSOVIVO_API_KEYS` com placeholder → serviço **recusa subir**. Um placeholder
    de 35 caracteres passaria no mínimo de 24 e viraria a chave de produção.
- 9 testes novos, incluindo o valor exato do incidente (total: 154).

---

## [0.4.0] — 2026-09-02

Foco: tornar `/ready` capaz de explicar o que está errado.

### Corrigido

- **`healthCheck` do DataJud reprovava fonte que estava disponível.** Qualquer
  resposta fora do 2xx marcava a fonte como morta — inclusive um 4xx que não é
  de autenticação, que na verdade significa "cheguei, a chave foi aceita, só a
  consulta de verificação foi recusada". Na prática isso tirava o DataJud da
  cadeia de fallback com ele funcionando. Agora 4xx não-autenticação conta como
  saudável, com uma ressalva no motivo.

### Adicionado

- `diagnosticar()` na porta `ProcessoProvider` — opcional, para não forçar
  migração de adapter existente; quem não implementa cai no `healthCheck`.
- `GET /ready` e `npm run cli -- saude` agora trazem o **motivo** por fonte:
  chave rejeitada (com o link da chave vigente), limite excedido (com o
  parâmetro a ajustar), API do CNJ fora do ar, timeout ou falha de rede.
  Antes, `saudavel: false` era um beco sem saída.
- 9 testes novos cobrindo cada classificação (total: 145).

---

## [0.3.0] — 2026-09-02

Foco: geração e proteção das chaves de API.

### Adicionado

- `npm run chave` — gera chaves de API sem depender de `openssl` (que não existe
  no Windows fora do Git Bash/WSL). Imprime o valor **e** o identificador que
  aparece nos logs, para você anotar qual chave é de qual consumidor.
- Validação de autenticação no arranque (`src/main/http/chaves.ts`): recusa subir
  sem chave, com chave de menos de 24 caracteres, com chaves repetidas, ou com
  `PROCESSOVIVO_AUTH_DISABLED=true` junto de chaves preenchidas.
- Seção completa no `DEPLOY.md` sobre gerar, guardar e rotacionar chaves sem
  downtime.
- 11 testes novos (total: 135).

### Alterado

- **Identificador de chave nos logs agora é hash** (8 hex do SHA-256) em vez dos
  4 primeiros caracteres da chave. O prefixo vazava parte do segredo e deixava
  de distinguir qualquer coisa se as chaves compartilhassem convenção de nome.
- `GET /health` agora informa a versão do serviço.

### Corrigido

- Documentação recomendava `openssl rand -hex 32` sem alternativa para Windows.
- Item de troubleshooting sobre "espaço na variável" estava errado: espaços em
  volta das vírgulas sempre foram tolerados.

---

## [0.2.0] — 2026-09-02

Foco: tornar o projeto publicável em servidor.

### Adicionado

- **API HTTP** (Fastify) como segundo adaptador de entrada, sobre os mesmos
  casos de uso do CLI:
  - `GET /v1/processos/:numero`
  - `GET /v1/advogados/:uf/:oab/processos`
  - `GET /health` (liveness, não consulta fonte externa)
  - `GET /ready` (readiness, com diagnóstico por fonte)
- Autenticação por chave de API (`x-api-key` ou `Authorization: Bearer`).
- Rate limit por chave, com health checks fora da cota.
- Mapeamento centralizado de erro de domínio para status HTTP, separando culpa
  do cliente (4xx), falha rio acima (502/503) e bug nosso (500).
- Desligamento gracioso em SIGTERM — redeploy não derruba requisição em voo.
- `Dockerfile` multi-stage, `.dockerignore`, `docker-compose.yml`.
- `DEPLOY.md`: runbook do Easypanel.
- CI no GitHub Actions (typecheck, lint, testes, build da imagem).
- 23 testes de API (total: 124).

### Alterado

- `npm run dev` e `npm start` agora sobem a API. O CLI segue em `npm run cli`.

---

## [0.1.0] — 2026-09-02

Núcleo do MVP.

### Adicionado

- Domínio: `Processo`, `Movimentacao`, `Parte`, e os value objects `NumeroCNJ`
  (com validação de dígito verificador, ISO 7064 MOD 97-10) e `Oab`.
- Porta `ProcessoProvider` com declaração de capacidades por fonte.
- `DataJudAdapter` — API Pública do CNJ, com mapper anticorrupção e validação de
  payload por Zod.
- `MockCrawlerAdapter` — crawler simulado do e-SAJ (TJSP), com falha configurável
  para exercitar o fallback.
- `ProcessoSearchService` — orquestrador com cadeia ordenada, fallback automático
  e distinção entre "não encontrado" e "fonte fora do ar".
- Cache em memória com TTL e LRU, aplicado por decorator.
- Token bucket para autolimitar as chamadas ao DataJud.
- CLI (`processo`, `oab`, `saude`).
- `CLAUDE.md` com regras de código e arquitetura.
- 101 testes.
