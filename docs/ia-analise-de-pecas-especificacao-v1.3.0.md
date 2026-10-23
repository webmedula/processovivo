# Processo Vivo — Análise de peças por IA — Especificação v1.3.0

Acrescenta à v1.2.0 (que continua valendo, sem alteração) o que a 0.56.1 fixou em código e testes. Prompt `peca-1.1.0`, regras de verificação `1.1.0`.

## Por que

Num despacho real de uma página (~960 caracteres) o resultado saiu com tipo "outro" e dois pontos de atenção falsos ("peça longa" e "texto incompleto ou
ilegível"), sem prazos. Os pontos vinham do **modelo**: o prompt pedia os quatro códigos de `pontos_de_atencao` e a verificação só conferia que o código existia.

## Mudanças

1. **Pontos de atenção de FATO são do sistema.** Tamanho, qualidade do texto e conversão de HTML são calculados pelo código a partir do que ele contou
   (`pontosDeAtencaoDoSistema`): `peca_extensa` (mais de 20 páginas ou 50 mil caracteres) e `pouco_texto_por_pagina` (3 páginas ou mais, média abaixo de 200
   caracteres). Só aparecem se verdadeiros; peça de uma página nunca é "extensa". A conversão do HTML do tribunal segue como aviso do sistema (`conversao`).
2. **O modelo só aponta o que depende do conteúdo:** `peca_cita_documentos_nao_anexados` e `conferir_peca_inteira`. Os dois códigos antigos de fato, se emitidos
   (ou presentes em resultado guardado), são descartados.
3. **Tipos novos:** `despacho`, `decisao`, `sentenca`, `acordao` (atos do juízo).
4. **Bloco "O que determina"** (`determinacoes`, só para atos do juízo; até 5): `{ quem, texto, prazo_escrito, trecho, pagina }`.
   - verbos "determina", "intima", "manda"; quem faz o quê;
   - `prazo_escrito` é o **literal** do ato (ex.: "10 (dez) dias") ou `null`; se não estiver literalmente na página indicada, só o prazo é descartado;
   - **nunca** data calculada, vencimento ou contagem de dias; sem mérito, sem conselho;
   - o trecho tem de existir na página; número só se estiver no texto enviado; as expressões proibidas valem para `quem` e `texto`.
5. **"Não verificado":** pedidos e alegações vazios não tornam "não verificado" um despacho, decisão, sentença ou acórdão (a regra segue só para petição e contestação).
6. **Tela:** "O que determina" (quem, o quê, "Prazo escrito no ato"), e todo item com citação traz "Ver trecho · pág. N" visível, abrindo o trecho ao clique.
7. **Teste:** `PAGINA_DO_DESPACHO` (sintética) + dublê que emite os códigos antigos; falha se houver "peça longa" em 1 página ou faltar um dos prazos.

Fora de escopo: OCR, cálculo de prazo, mudança de modelo, provedor, ZDR, plano, preço, teto.
