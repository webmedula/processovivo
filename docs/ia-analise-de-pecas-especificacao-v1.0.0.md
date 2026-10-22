# Processo Vivo — Análise de peças por IA — Especificação v1.0.0 (seções 5 e 8 e princípios)

> Texto fornecido pelo dono em 22/10/2026 e salvo aqui sem alteração de conteúdo (apenas este título).
> Os desdobramentos e as medições da Fase 0 estão em `docs/ia-pecas-fase0-resultado-v1.0.0.md`.

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
