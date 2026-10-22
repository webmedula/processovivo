# Calendário — especificação — v1.1.0

Documento: `calendario-especificacao-v1.1.0` · 02/10/2026 · para o repositório `webmedula/processovivo`
(base: **v0.31.1**, já com o leitor na `main`; o calendário entra na próxima versão menor, **0.32.0**).

## 1. Objetivo

Dar ao advogado uma agenda dos eventos dos seus processos (audiência, perícia, prazo, reunião) em
**uma tela do sistema** e em um **feed ICS** que ele assina no Google Agenda, Outlook ou Apple
Calendário. A agenda mistura duas origens, sempre distinguíveis:

- **Detectado:** data lida de um andamento já recebido (ex.: "audiência designada para 12/11/2026
  às 14:30"). Nasce como **sugerido**.
- **Manual:** criado ou editado pelo advogado. Nasce **confirmado**.

O advogado **confirma** um sugerido para ele valer. O sistema nunca afirma um prazo: lê datas que
estão escritas no andamento e mostra de onde vieram.

## 2. Decisões do dono (fechadas em 01/10/2026)

| Tema | Decisão |
|---|---|
| Conteúdo | Ambos: datas lidas de andamentos **e** eventos criados/confirmados pelo advogado |
| Formato | Tela no sistema **+** feed ICS |
| Plano | Recurso do **Acompanhamento**, ou seja, todos os planos |
| Ordem | Depois do leitor (feito: v0.31.1 na `main`) |

## 3. Fora do escopo (não fazer)

Cálculo automático de prazo (vale o `CLAUDE.md`: só como calculadora de cálculo visível, nunca como
afirmação), alertas por e-mail/push/WhatsApp, sincronização de mão dupla, OAuth com Google ou
Microsoft, convites a terceiros, eventos recorrentes, anexos, escritório com vários membros, análise
por IA, chamada nova ao MNI ou a qualquer tribunal (a detecção usa só o que já foi gravado).

## 4. Modelo de domínio

Entidade `EventoDeCalendario` (nomes em português, em `src/domain/entities/`):

- `id` (UUID), `workspace`, `numeroProcesso` (CNJ, 20 dígitos), `tribunal`.
- `tipo`: `audiencia | pericia | prazo | reuniao | outro`.
- `titulo` (texto curto, até 140), `observacao` opcional (até 1000, **só do advogado**).
- Quando: `dataLocal` (`AAAA-MM-DD`), `horaLocal` opcional (`HH:MM`), `duracaoMin` opcional.
  Sem hora = **dia inteiro**. Fuso fixo `America/Sao_Paulo`. **Nunca** converter data sem hora por
  UTC (erro clássico que desloca o dia).
- `origem`: `detectado | manual`.
- `estado`: `sugerido | confirmado | descartado`.
- `procedencia` (só em `detectado`): `{ movimentacaoId, dataDoAndamento, trecho }`, com `trecho` de
  até 200 caracteres do andamento **sem nomes de partes** (ver seção 10).
- `sequencia` (inteiro, sobe a cada alteração; usado no ICS), `criadoEm`, `atualizadoEm`,
  `confirmadoEm?`.

Regras: descartado nunca reaparece como sugerido (a deduplicação cobre descartados); alterar um
detectado confirmado mantém a procedência; `dataLocal` precisa ser data válida do calendário.

## 5. Detecção (função pura em `domain/`)

`detectarEventosNoAndamento(andamento): EventoSugerido[]`, **sem rede, sem relógio, sem I/O**.

- Reconhece **somente data explícita** no texto: `dd/mm/aaaa` (e `dd/mm/aa`), com hora `HH:MM` ou
  `HHhMM`, junto de palavra-gatilho: `audiência` (e variações: conciliação, instrução, julgamento,
  una), `perícia`/`pericial`, `sessão de julgamento`, `designad*`/`redesignad*`.
- Mapeia `tipo`: audiência/perícia conforme o gatilho; `prazo` só quando houver **data final
  escrita** ("até 20/10/2026"). **"Prazo de 15 dias" sem data não gera evento** (calcular seria
  afirmar prazo). Nesse caso a triagem existente continua sinalizando o andamento como hoje.
- "Cancelada", "retirada de pauta", "redesignada" no mesmo andamento: não cria sugestão nova; se
  houver evento detectado antes **para o mesmo processo e tipo**, marca-o para revisão (campo
  `revisar: true`, mostrado como "o andamento mais recente sugere mudança; confira").
- Várias datas no mesmo texto: gerar só as que estiverem coladas a um gatilho; na dúvida, **não
  gerar** (falso negativo é aceitável, falso positivo confiante não).
- **Idempotência:** chave de deduplicação
  `(workspace, numeroProcesso, movimentacaoId, tipo, dataLocal, horaLocal)`. Reprocessar o mesmo
  andamento não duplica.
- Data anterior a hoje (relógio injetado) **não gera evento**, inclusive no preenchimento retroativo
  da seção 6.

Testes de tabela com **textos sintéticos** (repositório público: nada de texto, nome ou número reais
de processos).

## 6. Quando a detecção roda

1. **Em ingestão:** quando o sync/vigilância gravar andamentos novos (ponto único, depois de gravar,
   dentro da mesma unidade de trabalho; falha da detecção **não** pode derrubar o sync: registra em
   log e segue).
2. **Preenchimento retroativo** (6.2) ao ativar o calendário numa conta: andamentos dos últimos 180 dias já
   gravados, rodado em lote pelo `Agendador`, sem rede.

Nenhuma chamada nova a tribunal.

## 7. Persistência

Tabelas novas na migração do `banco.ts` (mesmo estilo de `ALTER`/`CREATE IF NOT EXISTS` existente):

- `eventos_calendario` com as colunas da seção 4, índice `(workspace, dataLocal)` e índice único de
  deduplicação da seção 5.
- `calendario_feeds`: `workspace`, `tokenHash` (SHA-256), `incluiSugeridos` (0/1), `criadoEm`,
  `revogadoEm?`. **O token em claro nunca é gravado**; aparece uma única vez na criação.

Porta `RepositorioDeEventos` em `application/ports`, adaptador SQLite em `infrastructure/`. **Toda**
consulta filtra por `workspace` (isolamento inegociável; teste explícito de que o workspace B não lê
nem altera evento do A, nem pelo feed).

## 8. Plano e recurso

Acrescentar `'calendario'` a `RecursoDoPlano`/`RECURSOS` (`src/domain/entities/Plano.ts`) e incluir
no plano base (Acompanhamento) e, por herança já existente, nos demais. Teste que fixa a lista de
recursos deve ser atualizado na mesma PR. Plano vencido/sem o recurso: as rotas da tela respondem
403 padrão do sistema; o **feed** responde 404 (não revela que o token existiu).

## 9. Rotas (Zod nas bordas; sem `try/catch`; erros só de `domain/errors`)

Sessão autenticada (gate do recurso):

- `GET /calendario/eventos?de=AAAA-MM-DD&ate=AAAA-MM-DD&estado=...` (intervalo máximo 400 dias).
- `POST /calendario/eventos` (manual → `confirmado`).
- `PATCH /calendario/eventos/:id` (editar; `confirmar` = mudar estado para `confirmado`).
- `POST /calendario/eventos/:id/descartar`.
- `POST /calendario/feed` (cria ou **regenera** o token; devolve a URL completa uma única vez).
- `GET /calendario/feed` (diz se existe feed, desde quando, `incluiSugeridos`; **nunca** a URL).
- `DELETE /calendario/feed` (revoga).

Pública, só pelo token:

- `GET /calendario/feed/:token.ics` → `text/calendar; charset=utf-8`, `Cache-Control: private,
  max-age=300`, **comparação do hash em tempo constante**, limitador de taxa por IP, sem cookie, sem
  cabeçalho de identificação do workspace. Token inválido, revogado ou plano sem o recurso: **404**
  igual em todos os casos.

Atualizar o teste que fixa as chaves/rotas da API, se houver.

## 10. Feed ICS (RFC 5545)

- `PRODID:-//Processo Vivo//Calendario//PT-BR`, `VERSION:2.0`, `CALSCALE:GREGORIAN`,
  `X-WR-CALNAME:Processo Vivo`, `REFRESH-INTERVAL;VALUE=DURATION:PT1H` (e `X-PUBLISHED-TTL`).
- Linhas com **CRLF**, **dobra em 75 octetos** (contando UTF-8, não caracteres), escape de `\`, `;`,
  `,` e quebra de linha.
- `UID:<id>@processovivo.com.br` **estável**; `SEQUENCE` = `sequencia`; `DTSTAMP` = `atualizadoEm`
  em UTC.
- Dia inteiro: `DTSTART;VALUE=DATE:AAAAMMDD` (`DTEND` = dia seguinte). Com hora:
  `DTSTART;TZID=America/Sao_Paulo:AAAAMMDDTHHMMSS` com `VTIMEZONE` fixo `-0300` (o Brasil não tem
  horário de verão desde 2019; documentar isso no código).
- Janela: de 30 dias atrás a 365 dias à frente.
- Quem entra: `confirmado` sempre; `sugerido` só se `incluiSugeridos` (padrão **desligado**, com
  `SUMMARY` prefixado "[sugerido]"); `descartado` entra como `STATUS:CANCELLED` por 30 dias, para o
  app do advogado apagar de vez, depois sai.
- **Privacidade (o feed sai do nosso controle):** `SUMMARY` = `<Tipo> — <número CNJ>`; **sem nomes de
  partes, sem trecho do andamento, sem observação**. `DESCRIPTION` = link para o processo no sistema
  + "Origem: lido do andamento de dd/mm/aaaa" ou "Criado por você". Processo com
  `segredoJustica === true`: `SUMMARY` = "<Tipo> (processo sigiloso)", **sem número**, sem link com
  número.
- Procedência e honestidade: o texto da descrição diz que a data foi lida do andamento e deve ser
  conferida no processo. Nunca "prazo fatal" nem equivalente.

## 11. Tela (arquivo próprio, **não** inflar `script.ts` de ~2.500 linhas)

`src/main/http/ui/calendario.ts` (módulo próprio, servido como os demais, sem build, sem CDN).

- Entrada no menu: "Calendário".
- Visões: **Agenda** (lista por dia, padrão, melhor no celular) e **Mês** (grade). Navegação
  anterior/próximo/hoje.
- Sugeridos em estilo distinto (rótulo "Sugerido", **não só por cor**), com a procedência ("lido do
  andamento de 03/10/2026") e link para o andamento na linha do tempo. Ações: **Confirmar**,
  **Editar**, **Descartar**. Evento com `revisar: true` mostra o aviso.
- Criar evento manual: formulário com tipo, título, processo (busca entre os processos do
  workspace), data, hora opcional, observação.
- Painel "Assinar no meu calendário": cria/regenera/revoga o feed, copia a URL (mostrada uma única
  vez), opção "incluir sugeridos", e texto claro: "quem tiver esta URL vê estes eventos; regenere se
  vazar". Instruções curtas para Google Agenda, Outlook e Apple.
- Acessibilidade: foco visível, navegação por teclado, rótulos reais, contraste. Datas exibidas em
  `dd/mm/aaaa`, semana começando no domingo, nomes em português.
- Estados vazios e erros honestos; nunca "carregando" sem fim.
- Sem o recurso no plano: mensagem padrão de recurso indisponível; o resto do sistema não muda.

## 12. Testes (sem rede, sem tempo real: relógio injetado)

1. **Detecção** (tabela): formatos de data/hora, gatilhos, "prazo de N dias" sem data **não** gera,
   data passada não gera, cancelamento/redesignação marca revisão, múltiplas datas, texto sem
   gatilho, idempotência.
2. **Domínio:** estados e transições válidas/inválidas, descartado não reaparece.
3. **Repositório:** isolamento por workspace (A × B) em leitura, escrita e feed; deduplicação.
4. **ICS:** CRLF, dobra de 75 octetos com acentos, escapes, `UID` estável, `SEQUENCE` sobe, dia
   inteiro (sem deslocar o dia), `TZID` com `VTIMEZONE`, `CANCELLED`, janela, **sem nome de parte e
   sem trecho**, sigilo sem número. Validar a saída com parser ICS **como dependência de
   desenvolvimento** ou, se preferir não adicionar, com verificador próprio e casos conhecidos.
5. **Feed:** token válido/inválido/revogado/regenerado (o antigo morre), plano sem recurso → 404
   idêntico, comparação em tempo constante, limitador de taxa, token em claro nunca no banco.
6. **Rotas:** Zod, intervalo máximo, 403 sem recurso, isolamento.
7. **Ingestão:** falha na detecção não derruba o sync; retroativo idempotente.
8. **Teste que falha** se o módulo do calendário importar adaptador de rede/MNI/DataJud.

## 13. Decisões em aberto (recomendação entre parênteses)

1. `incluiSugeridos` no feed: desligado por padrão (**sim**).
2. Descartado entra como `CANCELLED` por 30 dias no feed (**sim**).
3. Backfill de 180 dias ao ativar (**sim**; 365 se preferir).
4. Alertas por e-mail de audiência próxima: **versão futura** (Resend já existe). A v1.1.0 (seção 17) entregou só o RESUMO dos eventos a confirmar; o aviso de evento próximo segue futuro.
5. Eventos de prazo: só com data explícita; ligação com a calculadora de prazo fica para depois.
6. Janela do feed: -30/+365 dias (**ok**).

## 14. Histórico de versões

- **v1.1.0 (22/10/2026):** acrescenta a seção 17 — lembretes (`VALARM`) no feed e resumo por e-mail dos eventos a confirmar (v0.51.0). A seção 17 só ACRESCENTA: nada nas seções 4 a 12 mudou.
- **v1.0.3 (02/10/2026):** acrescenta a seção 16 — redesignação com data nova gera sugestão; rota
  para alterar só "incluir sugeridos" do feed; o console passa a abrir `/?processo=<número>`. Onde a
  seção 16 e a seção 5 divergem, vale a 16.
- **v1.0.2 (02/10/2026):** acrescenta a seção 15, "Decisões de implementação" — as quatro
  divergências entre esta especificação e o código/`CLAUDE.md`, decididas pelo dono. Onde a seção
  15 e as seções 7 a 9 divergem, vale a 15.
- **v1.0.1 (01/10/2026):** base passa a v0.31.1 e versão-alvo 0.32.0 (leitor já mergeado); sem mudança de regra.
- **v1.0.0 (01/10/2026):** primeira versão (substituída).

## 15. Decisões de implementação (dono, 02/10/2026)

Valem mais que as seções anteriores onde divergirem.

1. **Plano.** O calendário é recurso do Acompanhamento, ou seja, de **todos** os planos. Como os
   planos são dado desde a v0.28.0 (a semente só entra com a tabela vazia, e cada plano gravado
   guarda a lista completa de recursos — não há herança no banco), pôr o recurso só na semente não
   bastaria: seria a mesma lição de "cobrança que entra sem retrocarga é bloqueio em massa". Por
   isso: retrocarga idempotente no arranque que acrescenta `'calendario'` a todo plano já gravado
   (uma vez por banco, com marca em `estado`, para não desfazer depois uma decisão do operador), e
   plano criado depois pelo painel o inclui por padrão. Testes: assinatura de plano gravado antes
   enxerga o calendário depois da migração; segunda execução não duplica.
2. **Porta.** `RepositorioDeEventos` fica em `domain/ports`, como o `CLAUDE.md` e todas as outras
   portas. O "`application/ports`" da seção 7 não vale.
3. **Rotas.** As rotas de dados ficam sob `/v1/calendario/...` (eventos e gestão do feed). A URL
   pública do feed fica **fora** do `/v1`: `/calendario/feed/:token.ics`, porque quem assina no
   Google ou no Outlook guarda essa URL por anos e um prefixo versionado a quebraria. Ela entra em
   `rotasPublicas`, com limitador de taxa e teste.
4. **Erros e autenticação.** Segue o sistema: vencido além da carência = 402
   (`AssinaturaInativaError`); plano sem o recurso = 403 (`RecursoNaoIncluidoNoPlanoError`); sessão
   e chave de API resolvem para o mesmo workspace e a rota não distingue; workspace sem assinatura
   (chave de API) passa livre; status derivado das datas, como no resto. No feed público, para não
   revelar nada, token inválido, revogado, assinatura bloqueada ou plano sem o recurso respondem o
   **mesmo** 404, sem corpo informativo.

## 16. Acréscimos do dono (02/10/2026, v1.0.3)

Valem mais que as seções anteriores onde divergirem (em especial a seção 5, que mandava
"redesignada: não cria sugestão nova").

1. **Redesignação com data nova gera sugestão.** Audiência, perícia (ou sessão de julgamento)
   REDESIGNADA com data nova e explícita — "redesignada para o dia 20/11/2026 às 14h" — passa a
   gerar sugestão nova, e o evento detectado antes (mesmo processo e tipo) continua marcado para
   revisão. Se houver duas datas na frase, vale apenas a que vem logo depois de "para", "para o dia"
   ou "para a data de"; se isso não for claro (nenhuma ou mais de uma data depois de "para", ou
   gatilhos de tipos diferentes na frase), não gera. Cancelada, retirada de pauta, adiada e
   desmarcada continuam sem gerar sugestão.
2. **"Incluir sugeridos" sem trocar o token.** `PATCH /v1/calendario/feed` com
   `{ "incluiSugeridos": true|false }` altera só essa opção do feed vigente; a URL já assinada
   continua valendo. Sem feed vigente: 404 `FEED_DO_CALENDARIO_AUSENTE` (rota autenticada — aqui
   não há o que esconder do dono da agenda).
3. **Link do evento.** O console passa a interpretar `/?processo=<número CNJ>`: abre a tela do
   processo (depois do login, se a pessoa chegou deslogada) e apaga o parâmetro da barra de
   endereço. Só número de 20 dígitos; o resto é ignorado. É o link que a descrição do evento no
   feed já usava.

## 17. Lembretes no feed e resumo por e-mail (v0.51.0, decisões do dono, 22/10/2026)

**Fora desta versão (não implementar):** e-mail de "audiência amanhã" para evento confirmado, push, WhatsApp, SMS,
qualquer cálculo de prazo, mudança na detecção. O texto nunca afirma prazo: "data lida do andamento de dd/mm,
confira no processo"; nada de "prazo fatal" nem "urgente".

### 17.1 Lembretes no feed (camada 1)

1. **Preferência por feed**, aditiva: `lembretes = { umDiaAntes, umaHoraAntes }`, padrão `false`/`false`. Colunas
   novas em `calendario_feeds` (`lembrete_um_dia`, `lembrete_uma_hora`, `revisao_lembretes`,
   `lembretes_alterados_em`). Rotas: `POST` (cria/regenera, aceita `lembretes`), `GET` e `PATCH`
   `/v1/calendario/feed` (o `PATCH` aceita `incluiSugeridos` e/ou `lembretes`, `.strict()`, ao menos um campo).
2. **No ICS:** `BEGIN:VALARM`, `ACTION:DISPLAY`, `DESCRIPTION` = `SUMMARY` do evento, `TRIGGER`. **Só** em evento
   `confirmado` que ainda não começou (com hora: o início é depois de agora; dia inteiro: o dia é hoje ou depois);
   nunca em `sugerido`, nunca em `CANCELLED`. Respeita a janela do feed (-30/+365), a dobra de 75 octetos e o CRLF.
3. **`TRIGGER`:** com hora, relativo ao início (`-P1D`, `-PT1H`). Dia inteiro, **absoluto em UTC**, no fuso fixo
   de São Paulo: "1 dia antes" = 12:00Z do dia anterior (09:00 SP); "1 hora antes" = 11:00Z do próprio dia (08:00 SP).
   Motivo: `DTSTART` de dia inteiro é uma DATA, e o cliente leria "meia-noite" no fuso do aparelho.
4. **Mudar a preferência chega ao aplicativo sem regravar evento:** `SEQUENCE` = `e.sequencia + revisao_lembretes`
   e `DTSTAMP` = o maior entre `atualizadoEm` e `lembretes_alterados_em`; o `UID` não muda. Salvar a mesma
   escolha não sobe a revisão. (Não é provado que cada aplicativo reaplica o alarme por isso; ver 17.4.)
5. **Texto do painel** (honesto): "Apple Calendário e Outlook costumam mostrar estes lembretes. O Google Agenda
   pode ignorá-los em calendários assinados por URL; se precisar, configure notificações dele em Configurações do
   calendário > Notificações."

### 17.2 Resumo por e-mail dos eventos a confirmar (camada 2)

1. **Um e-mail por conta, no máximo um por dia**, a partir das 08:00 de São Paulo e até as 12:00 (servidor fora do
   ar de manhã não manda o resumo à noite). Só se houver item **novo**: evento `detectado`, não descartado, com data
   de hoje em diante, que é `sugerido` (motivo `novo`) ou tem `revisar` (motivo `revisar`, com a data da revisão como
   chave: andamento de mudança mais novo é item novo). Um item nunca é avisado duas vezes.
2. **Texto:** assunto "Processo Vivo: N evento(s) para você confirmar". Até 10 itens (tipo, data e hora ou "dia
   inteiro", número CNJ; sigilo: "processo sigiloso", sem número), depois "e mais N". Cada item: "Data lida do
   andamento de dd/mm, confira no processo." ou, com `revisar`, "O andamento mais recente sugere mudança, confira.".
   Link "Revisar no calendário" (`/?calendario=resumo`) e a frase "Para deixar de receber este resumo: Calendário >
   Resumo por e-mail." Sem nome de parte, trecho, título livre nem observação.
3. **Controle:** `GET`/`PUT /v1/calendario/resumo` (`{ disponivel, ativo }`), padrão ligado (sem linha na tabela de
   preferências = ligado), só para quem usa o calendário (tem o recurso e ao menos um evento detectado). Descadastro
   só pelo painel nesta versão; **não há rota pública de descadastro**.
4. **Chave global** `PROCESSOVIVO_CALENDARIO_RESUMO_HABILITADO`, padrão desligada. Sem SMTP de verdade o serviço
   não é montado ("log não é entrega"). Conta de chave de API (sem e-mail) não recebe.
5. **Idempotência e falhas:** tabelas `calendario_resumo_preferencias`, `calendario_resumo_itens` e
   `calendario_resumo_envios` (só ids, datas e contagens). Envio com falha não marca nada como avisado, soma uma
   tentativa por item (no máximo 3) e não derruba o agendador nem as outras contas; o log leva só contagens.
6. **CLI:** `calendario resumo-previa` (só leitura): contas e itens que receberiam o resumo agora, sem e-mail nem
   conteúdo.

### 17.3 Onde entraria o futuro "aviso de evento próximo" (não implementado)

No mesmo agendador de 15 min, lendo `eventos.listar` pelo relógio injetado, com um registro de "já avisado" por
evento (a tabela de itens serve de modelo) e a mesma chave global/opt-out. Os dados já existem (`dataLocal`,
`horaLocal`, `estado`, `segredoJustica`, `numeroProcesso`).

### 17.4 O que os testes provam e o que não provam

Provam: formato do ICS (inclusive o parse pelo ical.js), regras de quando o alarme sai, `SEQUENCE`/`DTSTAMP`/`UID`,
regras e horários do resumo, idempotência, limites, isolamento e privacidade. **Não provam** o comportamento real
do Apple Calendário, do Outlook nem do Google Agenda diante do `VALARM` (se o exibem, se reaplicam ao mudar a
preferência, a que horas); isso só se confere abrindo o feed no aplicativo.
