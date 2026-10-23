# Painel de IA no /admin — especificação v1.0.0 (Fase A)

Versão do produto: **0.58.0**. Decisões do dono. Este documento descreve o que a Fase A **faz** e o que deixa **de propósito para depois**.

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

- **Fase B:** trocar o modelo pelo painel (com a lista ZDR, comparação e teto de gasto).
- **Fase C:** editar prompts com teste prévio e reversão.
- **Fase D:** canário (parte do tráfego num modelo/prompt novo).

Nada disso entra sem decisão do dono; a segurança continua fora do painel em todas as fases.

## 13. Divergências registradas

- O `/admin` tem **uma credencial única**, não pessoas. O "autor" de cada mudança é, portanto, um **identificador curto derivado** do usuário configurado (8 hex de um SHA-256), e não "a conta do dono".
- O contador de teto por conta, por função e global é **em memória** (reiniciar zera), como o teto técnico de antes; o que persiste é a **configuração**.

## 14. Verificação

Testes sem rede e sem tempo real: precedência e falha segura; as três funções desligadas (zero chamadas, zero consumo, frase, reativação); segurança do acesso; registro de mudanças; métricas e percentis; igualdade painel × relatório; alerta (uma vez por dia, virada do dia, falha e três tentativas); ausência de dado sensível nas respostas; e, no Chromium, a tela (teclado, confirmação, foco, axe nos dois temas, seis larguras).
