# Prompt para o agente de código — IA de peças, Fase 0: viabilidade e medição (sem produto) — v1.0.0

Como usar: crie uma branch nova a partir da `main` **já atualizada** (sugestão: `ia-pecas-fase0`; confirme que a PR da 0.52.0 (#59) já foi mergeada). Salve `ia-analise-de-pecas-especificacao-v1.0.0.md` em `docs/` e cole o texto abaixo, **a partir da linha "Você vai executar...".**
Versão do produto: **0.53.0** (medição e preparação; **nenhum botão novo, nenhuma chamada de IA nova em produção**). A antiga "colunas redimensionáveis" passa a 0.55.0. Se o `CLAUDE.md` ou o `package.json` mandar outro número, use-o e me diga.

---

Você vai executar a **Fase 0** da análise de peças por IA do Processo Vivo, descrita em `docs/ia-analise-de-pecas-especificacao-v1.0.0.md`: descobrir se a ideia é **viável e segura** com medições, **sem construir o produto**. Leia a especificação inteira primeiro. Se algo conflitar com o código ou com o `CLAUDE.md`, **pare e me diga**.

## Decisões do dono para esta fase

1. **Nada muda para o usuário** e **nenhuma chamada de IA nova roda em produção**. O que for de IA nesta fase é só o **comparador manual** (0.52.0), com dados **sintéticos**.
2. Se o projeto **não tiver** extração de texto de PDF, **autorizo instalar `poppler-utils` (`pdftotext`) na imagem Docker**, com apresentação clara do que muda no `Dockerfile`. **Nenhuma dependência npm nova sem minha aprovação prévia** (pare e pergunte).
3. **Sem OCR.** PDF escaneado é medido e contado, não lido.
4. O texto de uma peça **nunca** é gravado em banco, log, relatório ou arquivo. Só contagens e medidas.
5. Decisões já tomadas para a Fase 1 (apenas registre na documentação, **não implemente**): resultado guardado com citações curtas por até 30 dias (configurável); cada peça vale 5 análises no teto diário; peça acima de 40 páginas ou 80 mil caracteres é recusada; o Autran avalia ~20 peças anonimizadas.

## Investigação primeiro (me responda antes de implementar)

1. **Peças hoje:** onde e como a peça é baixada, guardada (os 24 horas), servida e apagada; em que formato chega (PDF? outros?); onde o processo marca sigilo da peça e do processo. Qual é o ponto mais simples para, **em memória**, obter os bytes de uma peça já baixada.
2. **Extração de texto de PDF:** existe algo no projeto? (por exemplo, o "leitor" da 0.31.x, a Pasta digital, o `qpdf`, o juntar de PDFs). O que ele extrai, com que qualidade, e se preserva o **número da página**. Se não houver, proponha a menor solução (preferência: `pdftotext -layout` por página, binário na imagem, chamado por `child_process` com argumentos em lista, tempo limite e tamanho máximo), com riscos (PDF malicioso, tempo, memória).
3. **Como medir a taxa de peças com texto** sem guardar nada: dado que a peça fica só 24 h, qual é a forma mais simples e segura de obter uma amostra confiável? Opções a avaliar: (a) comando de CLI **somente leitura** sobre as peças atualmente guardadas; (b) **medidor opcional** no momento do download, ligado por variável (padrão **desligado**), que grava só contagens agregadas (sem número de processo, sem workspace identificável além de um contador). Recomende uma e diga os riscos.
4. **Redação (`redigirParaIA`):** o que cobre hoje (CNJ, CPF/CNPJ, e-mail, telefone, OAB, nomes do retrato) e o que **não** cobre numa peça (endereços, RG, nomes de terceiros, datas de nascimento). Proponha o que é viável acrescentar com função pura e testes, sem prometer o que não se consegue.
5. **Comparador da 0.52.0:** como estender os casos para **peças** (texto em páginas, contexto longo, citação com página) reaproveitando o esquema, a verificação e o relatório. Qual é o maior contexto que os modelos candidatos suportam (cite fonte; "não confirmado" onde faltar).
6. **Nota sobre segurança de PDF:** o que o projeto já faz para abrir PDF de tribunal (limites de tamanho, tempo, isolamento). Se faltar, liste, **sem implementar fora do escopo**.

## O que implementar

### 1. Extração de texto por página (módulo interno, sem rota)
- Função/porta interna que, dados os bytes de um PDF, devolve **texto por página** e contagens (páginas, caracteres, se há texto pesquisável), com **tempo limite**, **tamanho máximo** e erro tipado em português. **Sem rota HTTP, sem botão, sem uso em produção** nesta versão (só pelo comando de medição e pelos testes).
- Se for preciso, atualizar o `Dockerfile` (e `DEPLOY.md`) para incluir `poppler-utils`, e **testes que falham se o binário não existir**, com mensagem clara. Conferir o tamanho final da imagem e relatar.

### 2. Comando de medição (somente leitura)
- Comando de CLI (ajuste ao padrão existente e me diga o nome, por exemplo `npm run cli -- pecas medir-texto`) que, para as peças disponíveis, mostra **só agregados**: total de peças, % com texto pesquisável, distribuição de páginas e de caracteres (p50, p95, máximo), % acima do limite de 40 páginas/80 mil caracteres, % de falhas de extração por tipo, tempo de extração p50/p95. **Sem texto, sem nome, sem número de processo, sem workspace.**
- Se a investigação 3 recomendar o medidor opcional no download, implemente-o **desligado por padrão** (`PROCESSOVIVO_PECAS_MEDIR_TEXTO`, nome a ajustar), gravando só contadores agregados; senão, **não implemente**.

### 3. Conjunto sintético de peças e extensão do comparador
- 20 a 30 peças **fictícias** (petição inicial, contestação, réplica, embargos, laudo pericial, manifestação curta, peça longa, peça sem pedido, peça com valor parecido com prazo, peça com instrução injetada, peça com nomes e CPF a redigir) em `tests/fixtures/` (texto por página; PDFs gerados só se couber **sem dependência nova**; senão, fixtures de texto e **um** PDF mínimo sintético feito à mão para testar a extração).
- Cada caso com **pontos obrigatórios** (pedidos e documentos que a leitura deve achar, com a página) e **proibições** (avaliar mérito, prazo calculado, valor inventado, conselho).
- **Estenda o comparador** para rodar o esquema de peças (campos da seção 5 da especificação) e medir: citação verificada **com página**, pedidos encontrados, proibições, latência e custo (p50, p95, máximo). **O esquema de saída e a verificação de peças ficam num módulo de comparação/avaliação, sem rota de produção.** O comparador continua manual, com ZDR obrigatório, teto de gasto e `--executar`.
- Relatório com o **critério de decisão** da seção 8 da especificação (citação ≥ 95%, zero "perigoso", "errado" ≤ 10%, pedidos principais ≥ 90%) e uma planilha de revisão humana (CSV só com casos fictícios).

### 4. Documentação
- Atualize `docs/` com: o resultado das investigações, as decisões da seção 5 acima e o roteiro da Fase 1. Se a especificação precisar de ajuste, atualize-a para **v1.1.0** (histórico de versões) em vez de editar em silêncio.

## O que NÃO mudar

Qualquer tela, rota pública, plano, preço, `exigir()`, a análise do ato, o resumo, o calendário, a política e os termos (arquivos), o modelo e o prompt de produção. **Sem dependência npm nova sem minha aprovação.** Sem migração destrutiva.

## Testes (sem rede e sem tempo real)

- Extração: PDF de texto, PDF sem texto (escaneado simulado), PDF corrompido, PDF acima do limite, tempo limite, número de páginas preservado, nenhum texto em log ou mensagem de erro.
- Medição: agregados corretos com peças de teste; garantia de que **nenhum texto, nome, número ou identificador de conta** aparece na saída.
- Fixtures: validação do esquema; teste que **falha** se alguma peça sintética contiver padrão de dado real (CNJ real, CPF, e-mail, telefone).
- Comparador de peças com **provedor falso**: métricas, página na citação, proibições, teto de gasto, recusa sem confirmação e sem ZDR, sem vazamento de chave.
- `npm run check` **com `npm run build`** e a suíte completa **2 vezes** verdes. O CI precisa iniciar para o último commit (confirme na aba Checks). Se o `Dockerfile` mudar, confirme que o build da imagem continua passando no CI.

## Regras

Fixtures sintéticas; nenhum dado real, token ou segredo no repositório, nos logs ou no `CHANGELOG`. O repositório é público. Atualize `package.json`, `package-lock.json`, `CHANGELOG.md`, `CLAUDE.md` (registre: Fase 0 da IA de peças, extração só interna, sem OCR, texto de peça nunca persistido) e `DEPLOY.md` (comando de medição e, se houver, a variável e o `poppler-utils`). Antes de abrir a PR, faça `git fetch` e `git merge origin/main` (sem rebase e sem force-push). **Abra a PR, mas não faça merge.**

## Ao terminar, entregue

1. As respostas da investigação (itens 1 a 6), com fonte e "não confirmado" onde faltar, e as divergências com o código.
2. O que ficou pronto, a **versão** usada, os nomes finais do comando, das variáveis e dos arquivos, e o que mudou no `Dockerfile` (tamanho da imagem antes e depois).
3. A **recomendação de redação** (o que cobre e o que continua sem cobrir numa peça) e o risco residual, em palavras simples.
4. **Passo a passo para quem não é técnico**, com comandos em bloco de código **e de novo em texto simples, uma linha cada**: (a) baixar a branch e rodar os testes; (b) **rodar o comando de medição no Console do Easypanel** e ler o resultado; (c) rodar o comparador de peças em modo estimativa e depois com `--executar` (no Console, sem copiar chave para fora).
5. **Como o Autran avalia as ~20 peças anonimizadas** fora do repositório, usando o modo que a sonda já tem (CSV/volume), passo a passo, sem texto em log.
6. O resultado dos testes, o número da PR e o estado do CI.
