# IA de peças — Fase 0 (viabilidade e medição) — resultado v1.0.0 (0.53.0)

Fase 0 = descobrir se a ideia é viável e segura com medições, **sem construir o produto**. Nenhuma tela, rota, plano, preço ou
chamada de IA nova em produção. Especificação: `ia-analise-de-pecas-especificacao-v1.1.0.md` (v1.0.0 preservada ao lado).

## 1. O que foi entregue

| Peça | Onde | Observação |
|---|---|---|
| Extração de texto por página (módulo interno) | `src/domain/ports/ExtratorDeTextoDePdf.ts`, `src/infrastructure/pdf/PdftotextExtrator.ts`, `ExtracaoDeTextoError` | Sem rota nem uso em produção |
| Comando de medição (somente leitura) | `scripts/pecas-medir-texto.mjs` → `src/main/sonda/medicaoDeTextoDePecas.ts` | Só agregados |
| Redação extra para peças | `src/application/politicas/redigirPecaParaIA.ts` | A redação do ato NÃO mudou |
| 24 peças sintéticas + gabarito | `tests/fixtures/ia-pecas/casos.json` | Texto por página, página de cada ponto |
| Esquema, prompt e verificação de peça | `src/main/sonda/esquemaDePeca.ts`, `promptDePeca.ts`, `verificarPeca.ts`, `avaliacaoDePeca.ts` | Só do comparador |
| Comparador de peças | `scripts/ia-comparar-modelos.mjs --tarefa=pecas` → `comparadorDePecas.ts`, `comandoComparadorPecas.ts` | Manual, ZDR, teto, `--executar` |
| Julgar a planilha humana | `--julgar-revisao=<csv>` | Errado/perigoso; não chama modelo |

`executarSonda` ganhou um parâmetro OPCIONAL `tarefa` (montar a entrada, ler o esquema e verificar); sem ele, o comportamento é o de
sempre (análise do ato). ZDR por chamada, `provider.only`, conferência do par modelo + provedor, repetição única e parada por falhas
seguidas valem igual nas duas tarefas.

## 2. Investigação (itens 1 a 6)

### 2.1 Peças hoje
- Baixada pelo `ServicoPasta` → `ServicoLeitor.consultarLote` (um `MniAdapter`, um balde, um disjuntor). Formato: PDF, imagem ou HTML do tribunal.
- `GuardaDePecas.guardar` converte na entrada (imagem → página de PDF, HTML → PDF de texto) e apaga o original: **o arquivo guardado é sempre PDF**.
  Fica em `<LEITOR_PASTA>/<hash do workspace>/…` (modo 0600, nome aleatório, fora do backup), 24 h (`LEITOR_TTL_HORAS`), limpo pelo `Agendador`.
  Metadado em `pasta_pecas` (`localizador`, `paginas`, `bytes`, `conversao`, `expira_em`).
- Servida por `GET /v1/processos/:numero/pasta/pecas/:pecaId/arquivo`. Sigilo da peça: `nivelSigilo > 0`; do processo: `processoSigiloso` (de
  `nivelSigiloDoProcesso`). Peça ou processo sigilosos nunca são guardados.
- Ponto mais simples para os bytes em memória: `GuardaDePecas.obter` (localizador) + `armazem.ler`/`caminhoLocal`.

### 2.2 Extração de texto
- **Divergência com o prompt:** o `poppler-utils` (`pdftotext`/`pdfinfo`) **já estava na imagem** (`Dockerfile`, desde a 0.30.0, "ainda não usado"). Nenhuma extração de texto existia
  em `src/` (só em testes e na sonda de lote). O `qpdf` só conta/junta/recorta páginas.
- Solução: `pdftotext -layout`, PDF pela entrada padrão, `execFile` com argumentos em vetor, **30 s**, **20 MB**, **8 MB de saída**, 40 páginas, 80 mil caracteres,
  erro tipado em português (`arquivo_vazio`, `arquivo_grande`, `pdf_invalido`, `pdf_protegido`, `tempo_esgotado`, `saida_grande_demais`, `ferramenta_ausente`),
  sem texto em mensagem ou log. Preserva o número da página (um `\f` por página).
- Qualidade: camada de texto nativa, sem OCR. "Com texto pesquisável" = pelo menos metade das páginas lidas com ≥ 50 caracteres.

### 2.3 Como medir a taxa de peças com texto
**Recomendado e implementado: (a) comando somente leitura sobre as peças vigentes.** Não toca o caminho de download (risco zero), usa as peças
dos últimos 24 h (amostra pequena em dias parados → repetir em dias diferentes; o comando avisa abaixo de 30 peças). **(b) medidor no
download NÃO foi implementado**, por decisão do dono; só valeria se (a) der amostra pequena demais.

### 2.4 Redação
- Cobre (ato): CNJ, CPF/CNPJ (inclusive mascarado), e-mail, telefone, OAB, nomes de partes e advogados do retrato.
- Acrescentado (peça): CEP, RG/CNH com rótulo, "nascido/nascimento + data", conta/agência com rótulo.
- **Continua SEM cobrir** (risco residual): endereço (logradouro, bairro, cidade), nome de terceiro fora do retrato (testemunha, perito, filho, sócio),
  documento ou conta sem rótulo, chave Pix, placa, cartão. Há teste que fixa a ausência (a peça de redação mantém "Rua Nenhuma" e "Sicrano de Mentira").
  **Nenhum texto do produto pode prometer o contrário.**

### 2.5 Comparador e contexto dos modelos
Estendido como acima. Contexto (pesquisa de 22/10/2026; ZDR e preços continuam **não confirmados**): `deepseek/deepseek-v4-flash` 1.048.576 tokens
([OpenRouter](https://openrouter.ai/deepseek/deepseek-v4-flash/api)); `google/gemini-3.8-flash` ~1,05 M e `qwen/qwen3.8-flash` 1 M
([OpenRouter](https://openrouter.ai/compare/google/gemini-3.8-flash/qwen/qwen3.8-flash)); `anthropic/claude-haiku-5.5`: **não confirmado**.
80 mil caracteres ≈ 25 mil tokens: cabe com folga; o teto de SAÍDA (3.000 tokens no comparador) é outra restrição e não foi medido. Variantes (`:free`) e apelidos (`~`) são recusados.

### 2.6 Segurança de PDF
Já existia: `qpdf` por `execFile`/vetor com tempo (600 s), cotas por PDF (300 MB) e por workspace (1 GB), conversão de HTML/imagem na entrada, PDF.js com
`isEvalSupported:false` e `enableXfa:false`, guarda por workspace. **Faltava e o módulo novo trouxe:** tamanho máximo por peça antes de abrir, tempo curto,
`maxBuffer`, limite de páginas e de caracteres, erro tipado para senha. **Não dá para fazer com segurança aqui e fica só relatado:** limite de CPU/memória do
processo filho (exige `ulimit`/cgroup do contêiner) e proteção contra "bomba" de descompressão dentro do `pdftotext` (hoje mitigada só por tempo e saída máximos).

## 3. Resultado das medições
Esta fase entrega os **instrumentos**. As medições sobre peças REAIS (taxa de texto, p50/p95 de páginas e caracteres, falhas, tempo) e sobre modelos
(citação, pedidos principais, custo) são rodadas pelo dono no Console do Easypanel (ver `DEPLOY.md`), porque o ambiente de desenvolvimento não alcança o
OpenRouter nem tem peças reais. **Nenhum número de produção foi inventado aqui.**

## 4. Riscos residuais (em palavras simples)
1. A redação não pega endereço nem o nome de quem não está no processo. Mandar uma peça a um serviço de IA, mesmo com retenção zero, sempre manda um pouco
   mais de dado pessoal do que um andamento.
2. Metade das peças pode vir escaneada (indício de 5 de 9 e 7 de 15 PDFs sem fonte). Sem OCR, essas peças não são lidas; a medição diz quantas.
3. A leitura pode omitir pontos. A tela da Fase 1 terá de dizer isso ("Leitura automática, pode omitir pontos. Confira a peça inteira.").
4. O processo filho do `pdftotext` não tem limite de CPU/memória, só de tempo e de saída.
5. A avaliação automática é um filtro; "errado" e "perigoso" só a revisão humana decide.
