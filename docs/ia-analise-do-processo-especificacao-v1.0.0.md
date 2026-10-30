# Análise do processo pelas peças, por IA — especificação v1.0.0

Decisões do dono de 29/10/2026. A discussão completa (opções avaliadas, riscos e a Fase 2) está no documento
de trabalho do projeto; este arquivo registra o que a versão 1 (v0.66.0) implementa e o que ficou de fora.

## 1. O que é

O advogado escolhe peças na Pasta digital e a IA as "lê em conjunto": cada peça passa pela análise de peça
que já existe (v0.55.0) e, depois, uma segunda etapa — a **síntese** — cruza só os resultados JÁ VERIFICADOS
das peças. A síntese nunca recebe o texto das peças: recebe os itens verificados, com marcadores no lugar de
nome, cada um com um identificador (`P2.pedido1`). Tudo o que ela escreve aponta para esses identificadores, e
a citação (trecho e página) mostrada na tela é copiada pelo sistema do resultado da peça.

Escolhas rejeitadas: um pedido único com o texto das peças principais (caro, sem verificação por peça) e o
processo inteiro automático (consultas ao MNI e custo sem controle). O Google Drive como fonte foi descartado
(escopo `drive.file`, regra "só de ida", Política).

## 2. Decisões do dono

| Tema | Decisão |
|---|---|
| Formato | Síntese das análises de peça (etapa 1 por peça + etapa 2 de cruzamento). |
| Plano | Plano IA atual (`analiseIa`, por `temRecursoSemExcecao`). Sem preço novo. |
| Resultado | Mostra tudo: quadro do caso, pedidos × defesa × decisões, linha do tempo das teses, pontos controvertidos, determinações, documentos e valores, o que ficou de fora. |
| Limite | Até **20 peças** por análise (mínimo 2). |
| Teto diário | A síntese pesa **5**; cada peça NOVA pesa 5 (como sempre). Peça reaproveitada não pesa. |
| Atalho | "Marcar peças principais": inicial, contestação, réplica, decisões, sentença, acórdão, recursos e embargos. **O laudo não entra** (dado de saúde): só se marcado à mão. |
| Abertura | Só a uma **lista de contas** até a Política de Privacidade v1.6. Não há chave "para todos". |
| Entrega | v1 = etapa 1 + síntese com os sete blocos + comparador sintético. O link na capa do processo vem depois. |
| Fase 2 | Envio direto do PDF de peças de outros tribunais, só em memória, sigilo declarado pelo advogado. **Depois da v1.** |

## 3. Versão 1 (v0.66.0)

**Quem usa.** `PROCESSOVIVO_IA_PROCESSO_WORKSPACES` (vazia = desligada, rotas ausentes) E a análise de peça
liberada para a conta E o plano IA. O interruptor do painel de IA para a função **peça** desliga também a
análise do processo (503 `desligada`).

**Fluxo.** `POST …/analise-do-processo/estimativa` (não grava nada: total, sigilosas, a buscar no tribunal, já
analisadas, peso máximo) → `POST …/analise-do-processo` (202, job em memória, um por conta) → consulta por
`GET /v1/analises-do-processo/:id` a cada 1,5 s → `DELETE` cancela. Recusas antes de qualquer chamada:
processo fora da carteira, segredo de justiça, listagem da Pasta ausente, tribunal fora do TJGO, seleção
inválida (ids repetidos, fora da listagem, menos de 2 ou mais de 20).

**Etapa 1.** Uma peça por vez, pelo `ServicoAnaliseDePeca` de produção (mesmas travas, redação, verificação,
guarda de 30 dias e reaproveitamento). Peça fora da guarda de 24 h é pedida à fila da Pasta (sem retry).
Credencial recusada ou bloqueio do tribunal: as demais peças não vão ao tribunal. Teto do dia atingido: as
restantes ficam de fora. Peça que não pôde ser lida fica no bloco "O que ficou de fora", com o motivo.
Dentro da análise do processo as peças não consomem o freio por hora da peça; o freio é o do processo
(`PROCESSOVIVO_IA_PROCESSO_MAX_POR_HORA`, 2).

**Etapa 2 (síntese).** Com pelo menos 2 peças lidas. Prompt `processo-1.0.0` (`entradaDaSintese.ts`):
P1 é a peça mais antiga; cada peça leva só tipo verificado, data e lado (autor, réu, juízo, não identificado)
— o rótulo do tribunal não vai. Esquema fechado (`esquemaDaSintese.ts`), uma repetição fora do esquema.
Mesmo modelo e mesma `ModeloComZdr` da peça (ZDR falhando fechado).

**Verificação** (`verificarSintese.ts`, regras 1.0.0), item a item:
1. referência tem de existir na entrada (senão `referencia`);
2. pedido só de `.pedido`; defesa só de alegação ou preliminar da parte ré (ou de lado não identificado);
   decisão só de peça do juízo; ponto controvertido com itens de duas peças de lados diferentes (senão `forma`);
3. número, valor ou data escritos têm de estar nos itens apontados (senão `numero`);
4. expressão proibida da peça, e também o juízo de procedência na voz do modelo ("o pedido é procedente",
   "deve ser julgado improcedente"), fazem o item sair (`proibida`). Descrever o pedido ("pede que seja
   julgado procedente") continua valendo;
5. sem objeto verificado: "não verificada" — a tela manda ler as peças.

**Guarda.** `sinteses_processo_ia` (migração aditiva): resultado COM marcadores, ids das análises de peça,
contagens, modelo, custo e latência, por 30 dias (`PROCESSOVIVO_IA_PECAS_RESULTADO_DIAS`), limpo pelo
`Agendador`. Reaproveitada quando a mesma seleção de análises, o mesmo prompt e o mesmo modelo se repetem.
Nunca texto de peça. Avaliação por polegar (`POST /v1/sinteses-do-processo/:id/avaliacao`).

**Tela.** `ui/analiseProcessoIA.ts` (`window.__pvProcessoIA`): botão "Analisar processo com IA (N)" na barra da
Pasta (só para conta liberada), diálogo modal com o atalho, a estimativa e a confirmação, o progresso com
Cancelar e o resultado em sete blocos, cada item com "Ver trecho · peça (data), pág. N". Aviso fixo: "Análise
automática das peças escolhidas, apoio à leitura. Não avalia mérito nem conta prazo. Confira nas peças."
Toda frase de recusa é fixa na tela.

**Comparador.** `node scripts/ia-comparar-modelos.mjs --tarefa=processo`: 8 processos inventados
(`tests/fixtures/ia-processo`, quatro categorias, inclusive instrução injetada), mesma entrada e mesma
verificação da produção, ZDR da lista oficial de agora, teto de gasto, estimativa antes de `--executar`.

## 4. Fora da versão 1

- **Função própria no painel de IA** (interruptor, teto, modelo e instruções editáveis): a síntese segue a
  função "peça". O teste obrigatório da Fase B mede a análise de peça, não a síntese — trocar o modelo da peça
  troca o da síntese; meça com o comparador antes.
- Link na capa do processo; abertura a todas as contas (espera a Política v1.6); Fase 2 (PDF de outros
  tribunais); OCR.
