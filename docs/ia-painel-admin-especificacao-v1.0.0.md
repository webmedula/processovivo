# Painel de IA no /admin — especificação v1.0.0 (Fase A) e Fase B

Versão do produto: **0.58.0** (Fase A) e **0.60.0** (Fase B, seção 15). Decisões do dono. Este documento descreve o que cada fase **faz** e o que deixa **de propósito para depois**.

## 1. Objetivo

Dar ao operador (o dono) uma tela no `/admin` para **observar** e **controlar** as três funções de IA — **análise de ato**, **resumo do processo** e **análise de peça** — sem mexer em código, variável de ambiente ou deploy para o que é rotina.

A Fase A **não muda** modelo, prompts, verificação, ZDR, redação, planos, preços, políticas, `exigir()` dos outros recursos nem o calendário.

## 2. Princípios (valem para todas as fases)

1. **A segurança não é editável pela tela.** ZDR, redação, verificação, segredo de justiça e a chave de API do provedor ficam fora do painel.
2. **Toda mudança é registrada e reversível.** O registro guarda quem, quando, o quê, o valor anterior e o novo; para desfazer, volta-se o valor anterior pela própria tela (e isso também é registrado).
3. **ZDR continua falhando fechado.**
4. **A chave do provedor nunca aparece na tela nem no banco.**
5. **Falha do painel não derruba a IA.** Se o painel falhar, vale o padrão do código (o ambiente).
6. **Nada de texto de ato ou de peça, nome de parte, número de processo, e-mail ou chave** no painel, nos logs ou no registro de mudanças.

## 3. Decisões do dono para a Fase A

1. **Só a conta administradora do dono acessa**, pelo mesmo mecanismo do `/admin` (HTTP Basic Auth, fora da tabela de usuários).
2. **Alerta de custo diário padrão: US$ 3,00**, ajustável no painel. O painel mostra também o **custo médio por análise** de cada função.
3. **As variáveis de ambiente são a trava mestra.** A função só funciona se o ambiente permite **e** o painel está ligado. O painel pode desligar; **nunca liga o que o ambiente desligou**. O teto efetivo é o **menor** entre a variável e o painel.

## 4. Precedência

| Ambiente permite? | Painel | Resultado |
|---|---|---|
| não | ligado | **desligada** (e o pedido de ligar é recusado: `ambiente_bloqueia`) |
| não | desligado | desligada |
| sim | desligado | **desligada** |
| sim | ligado | **ligada** |

"Ambiente permite": `ato` e `resumo` = `PROCESSOVIVO_IA_HABILITADA=true`; `peca` = isso **e** (`PROCESSOVIVO_IA_PECAS_HABILITADA=true` ou ao menos um id em `PROCESSOVIVO_IA_PECAS_WORKSPACES`) **e** a Pasta digital de pé.

Tetos (análises por conta e por dia; a peça pesa 5, como sempre):

- **por função:** efetivo = `min(PROCESSOVIVO_IA_MAX_POR_DIA, teto da função no painel)`;
- **total por conta:** continua o da variável (compartilhado entre as funções);
- **global** (todas as contas e funções, por dia): só existe no painel.

O dia é o de **São Paulo** (-03:00 fixo), o mesmo do teto técnico e do calendário.

## 5. Falha segura

`ServicoControleDaIa` lê `ia_config` com **cache de 5 s**. Qualquer falha (banco travado, linha corrompida — teto fora da faixa, alerta absurdo) devolve o **padrão do código**: todas as funções ligadas no painel, nenhum teto do painel, alerta de US$ 3,00. Quem consulta nunca recebe exceção. O aviso vai ao log no máximo **uma vez por minuto**, **sem a mensagem do erro** (pode trazer caminho de arquivo). O `TetoDiario` também ignora um painel que lança. Mudanças feitas pelo próprio serviço valem na hora (o cache é invalidado).

## 6. Dados (tabelas novas, aditivas, sem retrocarga)

| Tabela | Conteúdo |
|---|---|
| `ia_config` | uma linha por função (`ato`, `resumo`, `peca`: `ligada`, `teto_dia_conta`) e a linha `global` (`teto_dia_global`, `alerta_custo_dia_usd`), com `atualizado_em`. **Linha ausente = padrão.** |
| `ia_alteracoes` | **só acréscimo.** `em`, `autor` (id curto), `funcao` (`ato`/`resumo`/`peca`/`global`), `tipo` (`ligada`/`teto_dia_conta`/`teto_dia_global`/`alerta_custo`), `valor_anterior`, `valor_novo` (valores simples: "ligada", "desligada", "200", "sem teto", "3.00"). Gravada na **mesma transação** da mudança. |
| `ia_alertas_custo` | `dia` (PK), `valor_usd`, `limite_usd`, `tentativas`, `enviado_em`. |
| `ia_ocorrencias_dia` | contagem por `dia`, `funcao`, `motivo` (lista fechada). |

As métricas de uso vêm das tabelas que já existiam — `analises_ia`, `resumos_ia`, `analises_pecas_ia` — lidas **sem o conteúdo do resultado** (só o campo `estado`). A tabela da peça apaga a linha em 30 dias; a série da peça é a das vigentes.

**Motivos de ocorrência** (lista fechada): `chamada_falhou`, `formato_fora_do_esquema`, `tempo_esgotado`, `repeticao_automatica`, `citacao_invalida`, `numero_invalido`, `expressao_proibida`, `acao_copiada_do_trecho`, `sem_item_verificado`, `ato_recente_fora`, `pendencia_negada`, `atualidade`, `forma`, `pagina_invalida`. Registrar nunca lança.

## 7. O interruptor

Cada serviço consulta o controle **antes de qualquer outra coisa** (plano, retrato, vaga no limite, modelo). Com a função desligada:

- **zero chamadas ao provedor** e **zero consumo do teto** (a vaga nem é reservada);
- erro **503** com a frase fixa **"Este recurso está indisponível no momento."** e `detalhes.motivo = "desligada"` (`ENTRADA_NAO_ANALISAVEL` no ato e no resumo; `ANALISE_DE_PECA_RECUSADA` na peça);
- o botão some para **todas as contas**: `GET /v1/analises/disponibilidade` ganha `funcoes: { ato, resumo }` **somente quando o painel desligou uma das duas** (o contrato de antes não muda; as duas desligadas = `{ habilitada: false }`), e `GET /v1/analises-de-peca/disponibilidade` passa a `{ liberado: false }`;
- nenhuma outra frase de erro existente muda;
- avaliar (polegar) uma análise que já existe continua funcionando.

Ligar de novo restaura. **Desligar** exige a confirmação na tela **e** `confirmado: true` no pedido (sem ela, 409).

## 8. API (todas sob o Basic Auth do /admin; 501 sem credenciais configuradas)

| Rota | O que faz |
|---|---|
| `GET /admin/api/ia?periodo=hoje\|7d\|30d` | painel completo (funções, métricas, contas, custo do dia, últimas 50 mudanças) |
| `GET /admin/api/ia/alerta` | `{ usd, alertaUsd, acima }` — alimenta o aviso de qualquer aba |
| `PUT /admin/api/ia/alerta` `{ valorUsd }` | limite do alerta (US$ 0,01–10.000) |
| `PUT /admin/api/ia/funcoes/:funcao` `{ ligada, confirmado? }` | liga/desliga |
| `PUT /admin/api/ia/funcoes/:funcao/teto` `{ teto: inteiro 1–100.000 \| null }` | teto da função |
| `PUT /admin/api/ia/teto-global` `{ teto: inteiro 1–100.000 \| null }` | teto global do dia |

Erros: `ConfiguracaoDeIaRecusadaError` — `funcao_desconhecida` e `valor_invalido` (400), `confirmacao_necessaria` e `ambiente_bloqueia` (409). A mensagem nunca repete o valor recebido.

## 9. A tela "IA" (`ui/iaAdmin.ts`, módulo próprio)

Período (Hoje / 7 dias / 30 dias); um cartão por função com: estado efetivo (**ambiente × painel**, com a razão quando o ambiente bloqueia), análises, polegar para cima/baixo e motivos, "não foi possível" (e a taxa), não verificadas, **falhas de verificação por motivo**, repetições automáticas, **custo total / médio / p50 / p95 / máximo**, tempo p50/p95, liga/desliga com confirmação na tela e teto da função; seção com custo do dia, limite do alerta e teto global; contas que mais usaram (**id curto**); últimas 50 mudanças. Acessibilidade: teclado, rótulos, foco só no controle que a pessoa usou, região `aria-live` discreta, temas claro e escuro, sem rolagem horizontal de 390 a 1920 px.

## 10. Alerta de custo diário

Tick de 15 minutos; relógio injetado; dia de São Paulo. Custo do dia = soma de `custo_usd` das três tabelas desde 00:00 (SP). Acima do limite: **banner** no `/admin` (qualquer aba) e **um** e-mail por dia — **só** data, valor do dia, limite e o link `/admin#ia`. Falha de envio: soma tentativa (**máximo 3 por dia**), log sem dado pessoal, nova tentativa só no próximo ciclo; nunca derruba o agendador. Sem SMTP de verdade ("log não é entrega") ou sem e-mail do operador (`PROCESSOVIVO_ADMIN_EMAIL`, com fallback em `PROCESSOVIVO_PAGAMENTO_AVISO_EMAIL`): nenhum envio e nenhuma tentativa gasta; o banner continua.

## 11. Relatório por linha de comando

`scripts/ia-avaliacoes.mjs` continua existindo e **usa a mesma função de cálculo** do painel (`metricasDoConjunto`, com `percentil`/`média` de `estatistica.ts`). Nada de percentil ou custo duplicado.

## 12. Fora de escopo — **futuro, NÃO implementado**

- **Fase B:** trocar o modelo pelo painel — **implementada na v0.60.0, ver a seção 15**.
- **Fase C:** editar prompts com teste prévio e reversão.
- **Fase D:** canário (parte do tráfego num modelo/prompt novo).

Nada disso entra sem decisão do dono; a segurança continua fora do painel em todas as fases.

## 13. Divergências registradas

- O `/admin` tem **uma credencial única**, não pessoas. O "autor" de cada mudança é, portanto, um **identificador curto derivado** do usuário configurado (8 hex de um SHA-256), e não "a conta do dono".
- O contador de teto por conta, por função e global é **em memória** (reiniciar zera), como o teto técnico de antes; o que persiste é a **configuração**.

## 14. Verificação

Testes sem rede e sem tempo real: precedência e falha segura; as três funções desligadas (zero chamadas, zero consumo, frase, reativação); segurança do acesso; registro de mudanças; métricas e percentis; igualdade painel × relatório; alerta (uma vez por dia, virada do dia, falha e três tentativas); ausência de dado sensível nas respostas; e, no Chromium, a tela (teclado, confirmação, foco, axe nos dois temas, seis larguras).


---

## 15. Fase B (v0.60.0): o modelo de cada função, com teste obrigatório

**O que muda para o operador:** na tela "IA", cada função (`ato`, `resumo`, `peca`) mostra o modelo em uso e de onde ele vem (painel ou ambiente), deixa escolher outro modelo **da lista permitida**, testá-lo contra o atual, publicá-lo se o teste permitir e reverter em um clique.
**O que não muda:** prompts, verificação de citação, ZDR, redação, segredo de justiça, planos, preços, política, termos, calendário, o comportamento da Fase A (liga/desliga, tetos, alerta). **O modelo em produção continua o mesmo** (`deepseek/deepseek-v4-flash`).

### 15.1 Princípios

1. A lista de modelos mora **no código** (`src/infrastructure/ia/modelos-permitidos.ts`, validada por Zod no arranque), nunca no banco nem na tela. Incluir um modelo ou provedor é mudança de código por PR e **exige o dono revisar a Política de Privacidade antes**; a tela diz isso.
2. **Nenhuma chamada sai sem ZDR**, qualquer que seja o modelo escolhido: toda chamada passa pela peça comum (`ModeloComZdr`), que exige `zdr: true`, `data_collection: deny`, `provider.only` com os provedores da lista oficial e a conferência do par modelo + provedor da resposta. O painel não tem como desligá-la.
3. Falha do painel não derruba a IA: vale o modelo do ambiente.
4. Nada de texto de ato, de peça, de fixture, de resposta do modelo, nome, número de processo, e-mail ou chave no painel, nos logs ou no registro.

### 15.2 A lista permitida

Cada item: `id` (real, sem `~` nem `:`), `provedor`, `apelido`, `confirmacao`, `zdrConfirmadoEm` e `zdrFonte`, `precoEntradaPorMTokens` e `precoSaidaPorMTokens` (US$ por milhão de tokens), `janelaContexto`, `funcoesPermitidas` e `status` (`ativo` | `descontinuado`).

- `confirmacao: 'confirmada'` exige ZDR com data (AAAA-MM-DD) e fonte, os dois preços (> 0) e a janela: **só esses itens podem ser candidatos**. O Zod recusa item confirmado a que falte qualquer um, e há teste sobre a lista de verdade.
- `confirmacao: 'pendente'` é o modelo que **já roda** e ainda não teve a confirmação registrada (preço e ZDR nulos): vale como modelo atual (o ambiente manda) e **nunca** é oferecido como troca.
- **Lista inicial:** só o modelo de produção, como `pendente`. O ambiente de desenvolvimento não alcança o OpenRouter, então preço e ZDR dos outros modelos que o comparador já avaliou (`google/gemini-3.8-flash`, `openai/gpt-5.4-mini`, `anthropic/claude-haiku-5.5`, `anthropic/claude-sonnet-5.5`, `qwen/qwen3.8-flash`) continuam **não confirmados** (na rodada de 11/10 quatro deles voltaram "SEM ZDR", resultado depois reclassificado como palpite). Para um modelo entrar: ler a lista ZDR no Console, registrar data e fonte, **rever a Política de Privacidade** e abrir PR.

### 15.3 Precedência

`painel (se válido, na lista, ativo, confirmado e da função) → ambiente → padrão do código` (o ambiente já traz o padrão). Modelo do painel que saiu da lista, foi descontinuado ou não serve mais à função cai no ambiente **sem erro**, registra a ocorrência `modelo_do_painel_invalido` (uma por chamada) e a tela avisa. O modelo é resolvido **a cada chamada**; o resultado grava o modelo **servido** (o da resposta), não o configurado.

### 15.4 O teste obrigatório

- **Conjuntos:** os mesmos sintéticos do comparador — `tests/fixtures/ia-avaliacao` (ato, 48 casos), `ia-resumo` (resumo) e `ia-pecas` (peça). **As três funções têm conjunto; nenhuma ficou sem troca pelo painel.** O resumo roda a versão de produção do prompt (`resumo-1.2.0`); a peça roda com o prompt, o esquema e a verificação de **produção** (o comparador manual usa os da Fase 0; ganhou uma opção aditiva `entradaDeProducao`).
- **Reaproveitamento:** `ExecutorDoTesteDeModeloComSonda` (`src/main/sonda/executorDoTesteDeModelo.ts`) chama `compararModelos`, `compararPecas` e `compararResumos` e só normaliza o resultado em `MetricasDoModelo` (números). Para o resumo, "citação verificada" é a taxa de itens que passaram na verificação (mantidos ÷ mantidos + descartados).
- **Antes de rodar:** estimativa de chamadas e de custo (preço de lista × tokens estimados, sem rede) e confirmação. Estimativa acima do teto da rodada recusa. **Teto de gasto por rodada: US$ 1,00** (constante no código). Passou do teto durante a execução: para, marca `falhou` (`teto_de_gasto`) e não dá veredito.
- **Um por vez** no sistema inteiro; cancelar aborta as chamadas em voo; reinício do servidor marca `falhou` (`reiniciado`), nunca retoma.
- **ZDR primeiro:** a lista oficial é lida na hora; sem ela, nada é enviado (`falhou`, `zdr_indisponivel`); modelo (candidato ou atual) sem endpoint com ZDR nela: nada é enviado e o teste conclui `bloqueado` (`sem_zdr`).

### 15.5 As regras do veredito (constantes no código; a tela as mostra)

| Classe | Regra | Efeito |
|---|---|---|
| Bloqueio duro | modelo sem ZDR confirmado | não publica, sem aprovação manual |
| Bloqueio duro | violações (prazo calculado, valor, data ou nome inventado) acima das do modelo atual **na mesma rodada** | idem |
| Bloqueio duro | citação verificada abaixo de **95%** em termos absolutos (94,9% bloqueia; 95% passa) | idem |
| Bloqueio duro | falhas de formato acima das do atual em mais de **2,0 pontos percentuais** (2,0 passa) | idem |
| Bloqueio duro | teste incompleto, interrompido ou com erro do provedor; métrica que não pôde ser medida | idem |
| Queda tolerável | pontos obrigatórios com queda de até **3,0 pontos percentuais** | `aprovado_com_ressalva` |
| Queda tolerável | latência p95 até **+30%** | idem |
| Queda tolerável | custo médio por chamada maior (qualquer valor), com o impacto estimado por dia no volume dos últimos 30 dias | idem |
| Tudo igual ou melhor | — | `aprovado` |

Decisões de leitura (registradas): (a) passar dos limites tolerados (queda de pontos > 3,0 pontos; latência p95 > +30%) **também bloqueia** — a "queda tolerável" é, por definição, a que está dentro do limite; (b) qualquer piora **dentro** do limite (inclusive citação menor que a do atual ainda ≥ 95%, e falhas de formato até +2,0 pontos) vira ressalva, para o "aprovado" significar de fato "igual ou melhor"; (c) custo não medido exige aprovação (não bloqueia). O veredito é **recalculado** das métricas guardadas na hora de publicar.

### 15.6 Publicar e reverter

- **Publicar** só com teste `concluido`, do **mesmo par** função + candidato, feito há **no máximo 24 h**, cuja referência **ainda é** o modelo em uso. `aprovado`: um clique + confirmação. `aprovado_com_ressalva`: a palavra `PUBLICAR` digitada + motivo de lista fechada (`custo_aceitavel`, `qualidade_aceitavel`, `latencia_aceitavel`, `modelo_atual_com_problema`, `outro`) + observação curta opcional (≤ 80 caracteres, só letras, números e pontuação simples, no máximo 4 dígitos). `bloqueado`: nunca, nem com a aprovação digitada.
- Publicar grava `modelo`, `modelo_anterior` (o modelo efetivo até então) e `modelo_desde`, e o registro `modelo_publicado` (com o id do teste e a aprovação) **na mesma transação**; o cache da configuração é invalidado.
- **Reverter** (um clique + confirmação, sem novo teste) volta ao `modelo_anterior` e registra `modelo_revertido`. Se o anterior era o do ambiente, a função volta a seguir o ambiente. Sem anterior, o botão fica desabilitado; anterior que saiu da lista (e não é o do ambiente) é recusado.

### 15.7 Dados (aditivos; sem remoção nem renomeação)

| Onde | O quê |
|---|---|
| `ia_config` | colunas `modelo`, `modelo_anterior`, `modelo_desde` (nulas = vale o ambiente) |
| `ia_alteracoes` | colunas `teste_id` e `aprovacao`; tipos novos `modelo_publicado`, `modelo_revertido`, `teste_modelo_iniciado` |
| `ia_testes_modelo` | id, função, candidato, referência, estado (`na_fila` \| `executando` \| `concluido` \| `falhou` \| `cancelado`), instantes, chamadas previstas e feitas, estimativa, gasto, métricas dos dois modelos (JSON de números), veredito, bloqueios e ressalvas (códigos), motivo da falha |
| `ia_ocorrencias_dia` | novo motivo `modelo_do_painel_invalido` (fora da lista de "falhas de verificação" da tela) |

### 15.8 API (todas sob o Basic Auth do /admin)

`GET /admin/api/ia/modelos` · `POST /admin/api/ia/modelos/:funcao/estimativa` `{candidato}` · `POST /admin/api/ia/modelos/:funcao/testes` `{candidato, confirmado}` (202) · `GET /admin/api/ia/modelos/testes/:id` · `POST /admin/api/ia/modelos/testes/:id/cancelar` · `POST /admin/api/ia/modelos/:funcao/publicar` `{testeId, confirmado, palavra?, motivo?, observacao?}` · `POST /admin/api/ia/modelos/:funcao/reverter` `{confirmado}`. Erros: `ModeloDeIaRecusadoError` (ver o `CLAUDE.md`), sempre com `detalhes.motivo` e frase nossa; o id recebido nunca é repetido. `GET /admin/api/ia` ganhou `porModelo` em cada função (as mesmas métricas quebradas pelo modelo que serviu) e `testeId`/`aprovacao` nas mudanças.

### 15.9 A tela

Módulo próprio `ui/iaAdminModelos.ts`; o `iaAdmin.ts` só ganhou um espaço por cartão e a linha "por modelo". Por função: modelo em uso, origem e data da troca; seletor com preço, janela e data/fonte do ZDR; "Testar este modelo" → estimativa (chamadas, custo, teto) → confirmar; progresso (`role="progressbar"` e região `aria-live` única); tabela atual × novo com a diferença em cada medida (texto "melhor/pior/igual", não só cor); bloqueios e ressalvas em frases fixas; "Publicar este modelo"; "Reverter para o modelo anterior"; aviso fixo e "Regras desta decisão". Teclado completo, foco devolvido ao gatilho, temas claro e escuro, sem rolagem horizontal de 390 a 1920 px.

### 15.10 Verificação

Sem rede e sem tempo real: matriz do veredito nos limites exatos; lista permitida (Zod); precedência e falha segura; ZDR hostil (nenhuma configuração produz chamada sem ZDR; `no_providers_available` não gera segunda chamada); job (um por vez, cancelar, teto, reinício, estimativa antes, nada de texto gravado); publicar/reverter; segurança do acesso e ausência de dado sensível nas respostas; migração aditiva (banco da versão anterior); e, no Chromium, o fluxo completo, teclado, axe nos dois temas e as seis larguras.

### 15.11 Divergências registradas

- **Lista inicial só com o modelo de produção, como `pendente`:** preço e ZDR de lista não foram confirmados (fonte inalcançável a partir do ambiente de desenvolvimento) e a regra do dono é não inventar. Por isso, **até a primeira PR que registre um modelo confirmado, o seletor não oferece candidato**.
- O comparador manual de peças usa o prompt da Fase 0; o teste do painel usa o de produção (`peca-1.1.0`).
- Fases C e D seguem **futuro, não implementado**.
