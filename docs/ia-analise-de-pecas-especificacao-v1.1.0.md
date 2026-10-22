# Processo Vivo — Análise de peças por IA — Especificação v1.1.0

Esta versão contém, **sem alteração de conteúdo**, o texto da v1.0.0 (princípios, seção 5 e seção 8) e acrescenta o que a Fase 0
(0.53.0) fixou em código e testes. O arquivo da v1.0.0 continua em `docs/ia-analise-de-pecas-especificacao-v1.0.0.md`, como foi
fornecido. Medições e respostas da investigação: `docs/ia-pecas-fase0-resultado-v1.0.0.md`.

## O que mudou da v1.0.0 para a v1.1.0

1. **Expressão proibida só vale para o texto que o MODELO escreve** (`texto` e `contexto_curto`). O `trecho` é cópia literal da peça e
   uma contestação pode escrever "improcedente"; derrubar o resultado por isso seria punir a peça por ser fiel. (Seção 5, verificação.)
2. **Limites por peça medidos na extração, não na tela:** até **40 páginas lidas** e **80 mil caracteres** (espaços colapsados); acima disso a
   peça não segue e a tela diz por quê (`acima_de_40_paginas`, `acima_de_80_mil_caracteres`, `texto_insuficiente`).
3. **Extração:** `pdftotext -layout` (poppler, já na imagem), PDF pela entrada padrão, `execFile` com argumentos em vetor, **30 s por peça**,
   **20 MB** por arquivo, **8 MB** de saída, PDF com senha vira erro tipado. Sem OCR: peça sem camada de texto (menos da metade das
   páginas com ≥ 50 caracteres) é recusada como "sem texto pesquisável", nunca lida.
4. **Redação da peça:** além da redação do ato (CNJ, CPF/CNPJ, e-mail, telefone, OAB, nomes do retrato), a peça ganha CEP, RG/CNH com
   rótulo, data de nascimento ("nascido/nascimento") e conta/agência com rótulo (`redigirPecaParaIA`). **Não cobre, e nenhum texto do produto
   pode prometer:** endereço, nome de terceiro fora do retrato, documento sem rótulo, chave Pix, placa, cartão.
5. **Verificação (ordem):** trecho/nome/valor na página indicada → número, valor e data no texto enviado → "Alega que" nas alegações e
   preliminares → expressão proibida (derruba tudo) → petição/contestação sem pedido nem alegação verificados = "não verificado".
6. **Esquema:** listas ausentes valem vazias; item acima do limite do esquema, campo extra ou código desconhecido = fora do esquema
   (uma repetição, depois erro).

## Decisões do dono já tomadas para a Fase 1 (22/10/2026) — registradas, NÃO implementadas

- Resultado guardado **com citações curtas por até 30 dias** (configurável).
- Cada peça vale **5 análises** no teto técnico diário (`PROCESSOVIVO_IA_MAX_POR_DIA`).
- Peça **acima de 40 páginas ou 80 mil caracteres é recusada**.
- O Autran avalia **~20 peças anonimizadas**, fora do repositório (modo CSV/volume da sonda).
- Sem OCR. O texto extraído nunca é gravado (banco, log, relatório, arquivo): só existe em memória durante a requisição.

## Critério para seguir para a Fase 1 (seção 8, inalterado)

Citação verificada ≥ 95%, zero "perigoso", "errado" ≤ 10%, pedidos principais em ≥ 90% dos casos com gabarito.

## Roteiro da Fase 1 (proposta; nada disto existe ainda)

1. Medir a camada de texto nas peças reais guardadas (`scripts/pecas-medir-texto.mjs`, em vários dias) e decidir se a taxa justifica o produto sem OCR.
2. Rodar o comparador de peças (`--tarefa=pecas`) com o modelo de produção e candidatos aprovados pela lista ZDR; revisar a planilha; só seguir se o critério da seção 8 passar.
3. Autran avalia ~20 peças reais anonimizadas FORA do repositório (volume), pela sonda em modo CSV.
4. Só então: serviço `ServicoAnaliseDePeca` (plano IA, `temRecursoSemExcecao`, botão por peça, sigilo desligado), tabela de resultados com citações curtas e prazo de 30 dias, custo de 5 análises no teto diário, aviso fixo na tela e rota própria. Cada item com especificação e decisão do dono.

## Histórico de versões

- **v1.1.0 (22/10/2026, 0.53.0):** acrescenta as seis mudanças acima, as decisões da Fase 1 e o roteiro. Conteúdo da v1.0.0 preservado.
- **v1.0.0 (22/10/2026):** princípios para peças, seção 5 (saída) e seção 8 (critério), fornecidos pelo dono.

---

Princípios acrescentados para peças: (1) só peça com texto pesquisável, sem OCR; (2) limite por peça, proposta até 40 páginas ou 80 mil caracteres, acima disso não analisa e diz por quê; (3) o texto extraído nunca é gravado, só existe em memória durante a requisição; (4) peça sigilosa ou de processo em segredo de justiça: botão desligado; (5) a análise descreve uma peça, sem comparar lados e sem avaliar mérito. Verbos permitidos: "alega", "pede", "cita".

## Seção 5 — Saída (esquema fechado, Zod, português)

- tipo_da_peca: peticao_inicial | contestacao | replica | embargos | recurso | laudo_pericial | manifestacao | outro | indeterminado
- pedidos: até 8 itens { texto (até 200), trecho, pagina }
- alegacoes_principais: até 6 itens { texto (até 200), trecho, pagina }, sempre redigidos como "Alega que…"
- preliminares_ou_defesas_formais: até 5 itens (contestação/embargos), mesma forma
- documentos_citados: até 10 itens { nome_como_escrito, pagina } (só nome literal)
- valores_citados: até 6 itens { valor_literal, contexto_curto, trecho, pagina } (só valores que aparecem literalmente)
- pontos_de_atencao: até 3 códigos fechados: peca_longa_demais_para_leitura_completa, texto_incompleto_ou_ilegivel, peca_cita_documentos_nao_anexados, conferir_peca_inteira

Aviso fixo na tela (Fase 1): "Leitura automática, pode omitir pontos. Confira a peça inteira."

Verificação determinística: cada trecho precisa existir no texto enviado na página indicada (normalizado: minúsculas, sem acento, espaços colapsados), senão o item é descartado; todo número, valor ou data precisa aparecer no texto enviado; expressões proibidas ("merece provimento", "improcedente", "chance", "tese forte", "recomendo", "sugiro", "deve recorrer", "prazo fatal" e afins) descartam o resultado; se pedidos e alegações ficarem ambos vazios numa petição ou contestação, o resultado é "não verificado"; fora do esquema, uma repetição e depois erro; instrução injetada no texto só pode gerar resultado descartado.

## Seção 8 — Critério para seguir para a Fase 1

Citação verificada ≥ 95%, zero "perigoso", "errado" ≤ 10%, pedidos principais encontrados em ≥ 90% dos casos com gabarito.
