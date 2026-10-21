/**
 * Estilos da tabela de Atualizações (v0.37.0).
 *
 * Regras que a medição em navegador (`tests/browser/atualizacoes-navegador.spec.ts`)
 * sustenta:
 * - sem rolagem horizontal da PÁGINA em 1920, 1366, 1280, 1024, 768 e 390 px: tabela
 *   de layout fixo, texto de fora com `overflow-wrap:anywhere`, item de grade com
 *   `minmax(0, …)` e `min-width:0` (v0.35.1);
 * - cabeçalho fixo ao rolar: nenhum ancestral da tabela pode ter `overflow`, senão
 *   `position:sticky` deixa de valer — por isso a moldura é borda, não recorte;
 * - abaixo de 1024 px cada processo vira um bloco empilhado, com o rótulo de cada
 *   campo vindo de `data-rotulo`; o cabeçalho some (e com ele os botões de ordenar,
 *   que passam para o seletor "Ordenar por");
 * - de 1024 a 1279 px a lateral de 256 px come a largura: a coluna Classe vira uma
 *   linha sob o Tribunal, em vez de espremer as outras;
 * - alvos de toque de 44 px no empilhado; `prefers-reduced-motion` desliga o brilho
 *   do esqueleto.
 *
 * Nada aqui carrega recurso externo (há teste).
 */
export const ESTILOS_TABELA_ATUALIZACOES = `
.env.env-larga{max-width:none;padding-left:24px;padding-right:24px}
/* O --tinta3 do console mede 4,2–4,4:1 sobre o fundo claro (axe), abaixo dos 4,5:1 do
   texto pequeno. Nesta tela o texto de apoio usa --tinta2; o resto do console segue com
   o valor antigo — trocar a variável global mexe em todas as telas e é decisão à parte
   (mesma escolha do calendário). */
.env-larga .kicker,.env-larga .sub,.env-larga .nota,.env-larga .vazio p{color:var(--tinta2)}
.nvt-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* ---------- filtros ---------- */
.nvt-filtros{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:flex-end;margin-bottom:12px}
.nvt-bloco{display:flex;flex-direction:column;gap:6px;min-width:0}
.nvt-rot{font-size:12px;font-weight:700;color:var(--tinta2);text-transform:uppercase;letter-spacing:.04em}
.nvt-chips{display:flex;gap:8px;flex-wrap:wrap}
.nvt .chip{min-height:38px}
.nvt-bloco select{width:auto;min-width:190px;max-width:100%;min-height:38px;padding:0 10px;font-size:13.5px}
.nvt-so-pequeno{display:none}
.nvt-barra{display:contents}
.nvt-busca{flex:0 1 280px}
.nvt-busca-campo{display:flex;gap:8px;align-items:center;min-width:0}
.nvt-busca input{flex:1 1 auto;width:auto;min-width:0;min-height:38px;padding:0 10px;font-size:13.5px}
.nvt-busca input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none;display:none}
.nvt-busca-limpar[hidden]{display:none}
.nvt-busca-aviso{font-size:13.5px;color:var(--tinta2);line-height:2;padding:0 0 10px}
.nvt-busca-aviso strong{color:var(--tinta)}
.nvt-sem-prov.nvt-busca-aviso{padding:22px 20px;line-height:1.5;color:var(--tinta)}
.nvt-busca-aviso:focus{outline:none}
.nvt-sem-prov{background:var(--papel);border:1px solid var(--linha);border-radius:var(--r);padding:22px 20px;color:var(--tinta)}
.nvt-sem-prov p{margin:6px 0 0;color:var(--tinta2);font-size:13.5px}
.nvt-sem-leitura{padding:0 0 12px}
.nvt-resumo{font-size:13.5px;color:var(--tinta2);margin:0 0 10px;line-height:2}
.nvt-resumo .nov-btn{margin-left:6px;vertical-align:middle}
.nvt-resumo strong{color:var(--tinta)}
.nov-btn{font:inherit;font-weight:700;font-size:13px;min-height:32px;padding:0 12px;border-radius:999px;
  border:1px solid var(--linha);background:var(--papel);color:var(--acento);cursor:pointer}
.nov-btn:hover{background:var(--acento-bg);border-color:var(--acento)}
.nov-fora{padding:0 0 12px}
.nov-ant{padding:0 0 12px}
.selo.am{background:var(--atencao-bg);color:var(--atencao)}
.nvt .vazio{background:var(--papel);border:1px solid var(--linha);border-radius:var(--r)}

/* ---------- tabela ---------- */
.nvt-wrap{border:1px solid var(--linha);border-radius:var(--r);background:var(--papel);box-shadow:var(--sombra)}
.nvt-tabela{width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;font-size:13.5px}
.nvt-tabela th{position:sticky;top:0;z-index:2;background:var(--papel2);text-align:left;
  font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--tinta2);
  padding:10px 8px;border-bottom:1px solid var(--linha)}
.nvt-tabela th:first-child{border-top-left-radius:var(--r)}
.nvt-tabela th:last-child{border-top-right-radius:var(--r)}
.nvt-tabela td{height:48px;padding:8px 8px;vertical-align:middle;border-top:1px solid var(--linha2);
  overflow-wrap:anywhere;min-width:0}
/* Linha compacta (v0.49.2): cabeçalhos e datas nunca quebram; Tribunal e Classe são UMA linha com reticências (o texto
   inteiro está no title); Partes tem até duas linhas. A linha típica fica entre 48 e 56 px em 1920, 1366 e 1280. */
.nvt-tabela th{white-space:nowrap}
.nvt-tabela td.c-trib{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.3}
/* Palavra curta quebra em espaço, não no meio ("detectad/o"); só texto de fora usa "anywhere". */
.nvt-tabela td.c-trib,.nvt-tabela td.c-det{overflow-wrap:break-word}
.nvt-tabela td.c-data{white-space:nowrap}
.nvt-tabela tbody tr:first-child td{border-top:0}
.nvt-tabela tbody tr.nvt-linha:hover td{background:var(--papel2)}
/* Larguras (v0.49.2). Processo, Data do ato, Detectado e Ações têm largura de CONTEÚDO (o CNJ tem 25 caracteres e não
   quebra; dd/mm/aaaa e "há N dias" também não); Tribunal e Classe são uma linha com reticências; Partes e a coluna
   "auto", Atualização, dividem o resto. Três faixas, porque a lateral de 256 px muda o que sobra: >= 1600 px, 1280–1599
   e 1024–1279 (abaixo). Os números medidos antes e depois estão no CHANGELOG da 0.49.2. */
.h-processo{width:15rem}.h-partes{width:17%}.h-tribunal{width:5rem}.h-classe{width:13%}
.h-dataAto{width:5.75rem}.h-detectado{width:6rem}.h-acoes{width:9rem}
.nvt-ord{font:inherit;font-size:inherit;font-weight:inherit;text-transform:inherit;letter-spacing:inherit;
  color:inherit;background:none;border:0;padding:4px 0;min-height:28px;cursor:pointer;text-align:left}
.nvt-ord:hover{color:var(--tinta)}
.nvt-seta{color:var(--tinta3)}
.nvt-tabela th[aria-sort="ascending"] .nvt-seta,.nvt-tabela th[aria-sort="descending"] .nvt-seta{color:var(--acento)}

.nvt-proc{position:relative;display:flex;align-items:center;gap:2px;flex-wrap:nowrap}
/* O número NÃO quebra e o ícone de copiar fica colado a ele, não na borda da célula. */
.nvt-num{font-family:var(--mono);font-weight:600;font-size:12.5px;color:var(--acento);text-decoration:none;
  white-space:nowrap;overflow-wrap:normal;padding:0;flex:none}
.nvt-num:hover{text-decoration:underline}
.nvt-copiado{position:absolute;left:0;top:100%;z-index:5;padding:2px 8px;border-radius:6px;background:var(--papel);
  border:1px solid var(--linha);box-shadow:var(--sombra);font-size:12px;font-weight:700;color:var(--verde-tinta)}
.nvt-partes,.nvt-classe{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;
  overflow-wrap:anywhere}
/* Partes (v0.46.1): quebra em PALAVRAS inteiras, até duas linhas, e só depois as reticências; o nome inteiro está
   no title. "break-word" parte a palavra só quando ela sozinha não cabe na coluna. */
.nvt-partes{overflow-wrap:break-word;hyphens:manual;font-size:13px;line-height:1.3}
/* A classe quebra em PALAVRAS inteiras: "break-word" só parte a palavra que sozinha não cabe
   na coluna. Passando de duas linhas, o clamp põe as reticências e o title tem a classe toda. */
.nvt-classe{display:block;-webkit-line-clamp:unset;line-clamp:unset;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.nvt-classe-mini{display:none;font-size:12px;line-height:1.3;color:var(--tinta2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nvt-vazio{color:var(--tinta2)}
.nvt-sem{color:var(--tinta2);font-size:12px;margin:0}
.nvt-ult{color:var(--tinta2);font-size:12.5px;margin:4px 0 0;overflow-wrap:anywhere}
.nvt-ult strong{font-weight:600;color:var(--tinta)}
.nvt-sem-nov .nvt-tit{font-weight:500}
.nvt-tit{font-weight:700;font-size:14px;line-height:1.3;overflow-wrap:anywhere;min-width:0}
/* A célula Atualização (v0.49.2; v0.49.4 sem o link na tabela): ato, etiqueta e selos NUMA linha. O aviso "sem atualização detectada" (mesmo texto) é um texto pequeno na mesma linha, sem linha própria. */
.nvt-ato{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;min-width:0}
.nvt-tit.nl::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;
  background:var(--novo);margin-right:7px;vertical-align:2px}
.nvt-selos{display:inline-flex;flex-wrap:wrap;gap:2px 4px}
.nvt-tabela .nvt-selos .selo{display:inline-block;margin:0;font-size:11px;line-height:16px;padding:0 7px}
.c-data,.c-det{font-variant-numeric:tabular-nums;color:var(--tinta2)}

/* Na TABELA (>= 1024 px) o "Abrir processo" não existe (v0.49.4, decisão do dono): o número do processo é um link e o ícone
   "abrir" de Ações continua. display:none tira o botão da tela, da ordem de Tab e da leitura por leitor de tela. Nos CARTÕES
   (< 1024 px) ele aparece de novo — sem mouse não há dica — e os selos podem ocupar mais de uma linha. */
.nvt-abrir{display:none;white-space:nowrap;line-height:1.3}
.nvt-abrir .nov-abrir{color:var(--acento);font-weight:600;background:none;border:0;padding:2px 0;cursor:pointer;
  font-family:inherit;font-size:13px}
.nvt-abrir .nov-abrir:hover{text-decoration:underline}

/* A célula Atualização na tabela (v0.49.4): ponto azul (não lida), tipo do ato, etiqueta, selos e o aviso "Sem atualização
   detectada" SEMPRE numa linha só. Falta de largura corta o tipo do ato e o aviso com reticências (texto inteiro no title
   e no DOM, então o leitor de tela lê tudo); a etiqueta e os selos não encolhem. */
@media (min-width:1024px){
  .nvt-ato{flex-wrap:nowrap;gap:0 8px}
  .nvt-tit{display:inline-flex;align-items:center;white-space:nowrap;min-width:0;flex:0 1 auto}
  .nvt-tit.nl::before{flex:none}
  .nvt-tipo{overflow:hidden;text-overflow:ellipsis;min-width:0}
  .nvt-tit .selo{flex:none;margin-left:6px}
  .nvt-selos{flex:none;flex-wrap:nowrap;gap:0 4px}
  .nvt-ato .nvt-sem{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
}

/* ---------- ações ---------- */
/* UMA fileira (v0.49.2): caixa "Cumprido", abrir, pasta e "Analisar com IA", todos de 28 px (alvo mínimo de 24), cada
   um com a dica comum do console. O texto de cada ícone só aparece nos cartões (sem mouse não há dica). */
.nvt-acoes{display:flex;flex-wrap:nowrap;gap:4px;align-items:center}
.nvt-ic{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:28px;height:28px;padding:0;
  border-radius:8px;border:1px solid var(--linha);background:var(--papel);color:var(--tinta2);cursor:pointer;flex:none;
  font:inherit;font-size:13px;font-weight:600}
.nvt-ic:hover:not(:disabled){background:var(--acento-bg);border-color:var(--acento);color:var(--acento)}
.nvt-ic:disabled{opacity:.4;cursor:default}
.nvt-ic-t,.pvia-btn-t{display:none}
@media (min-width:1024px){.nvt-acoes .sit-cx,.nvt-acoes .sit-vaga{min-width:28px;min-height:28px;width:28px;height:28px}}
.nvt-acoes .sit-dica-wrap,.nvt-proc .sit-dica-wrap{flex:none}
.nvt-tabela .selo{white-space:normal;text-align:center;line-height:1.25}

/* ---------- rodapé ---------- */
.nvt-pag{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;justify-content:space-between;
  padding:12px 2px;font-size:13.5px;color:var(--tinta2)}
.nvt-por{display:flex;align-items:center;gap:8px}
.nvt-por select{width:auto;min-height:36px;padding:0 8px;font-size:13.5px}
.nvt-faixa{font-variant-numeric:tabular-nums;color:var(--tinta)}
.nvt-nav{display:flex;align-items:center;gap:6px}
.nvt-pagina{padding:0 8px;font-variant-numeric:tabular-nums}
.nvt :focus-visible{outline:2px solid var(--acento);outline-offset:2px}

/* ---------- esqueleto ---------- */
.nvt-esq{border:1px solid var(--linha);border-radius:var(--r);background:var(--papel);padding:6px 14px}
.nvt-esq-linha{display:grid;grid-template-columns:2fr 3fr 1fr;gap:16px;padding:14px 0;border-top:1px solid var(--linha2)}
.nvt-esq-linha:first-of-type{border-top:0}
.nvt-esq-linha span{height:12px;border-radius:6px;background:var(--linha);animation:nvt-brilho 1.3s ease-in-out infinite alternate}
@keyframes nvt-brilho{from{opacity:.45}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.nvt-esq-linha span{animation:none}}

/* ---------- de 1024 a 1599: a lateral de 256px come a largura ---------- */
/* A Classe vira uma linha sob o Tribunal (uma linha, com reticências e o texto inteiro no title) em vez de espremer
   a Atualização, que é a coluna que o advogado lê. */
@media (min-width:1024px) and (max-width:1599px){
  .h-classe,.c-classe{display:none}
  .nvt-classe-mini{display:block}
  .h-processo{width:14rem}.h-partes{width:11%}.h-tribunal{width:4rem}
  .h-dataAto{width:5rem}.h-detectado{width:6rem}.h-acoes{width:8.25rem}
  .nvt-tabela th,.nvt-tabela td{padding-left:6px;padding-right:6px}
  .nvt-tabela td.c-data,.nvt-tabela td.c-det{font-size:12.5px}
  .nvt-acoes{gap:3px}
}
/* De 1024 a 1279 a tabela inteira encolhe: o CNJ (25 caracteres, sem quebra) e a fileira de ícones já pedem ~330 px. */
@media (min-width:1024px) and (max-width:1279px){
  .h-processo{width:12.4rem}.h-partes{width:13%}.h-tribunal{width:3.75rem}
  .h-dataAto{width:4.5rem}.h-detectado{width:5rem}.h-acoes{width:7.4rem}
  .nvt-tabela th{font-size:10px;letter-spacing:0}
  .nvt-classe-mini{font-size:11px}
  .nvt-tabela th,.nvt-tabela td{padding-left:4px;padding-right:4px}
  .nvt-tabela{font-size:12.5px}
  .nvt-tabela td.c-data,.nvt-tabela td.c-det{font-size:11.5px}
  .nvt-num{font-size:11px}
  .nvt-ic{width:26px;height:26px}
  .nvt-acoes{gap:2px}
  .nvt-acoes .sit-cx,.nvt-acoes .sit-vaga{min-width:26px;min-height:26px;width:26px;height:26px}
  .nvt-tabela td.c-trib{white-space:normal}
}

/* ---------- abaixo de 1024: um bloco por processo ---------- */
@media (max-width:1023px){
  .nvt-so-pequeno{display:flex}
  .nvt .chip,.nvt-bloco select,.nvt-busca input,.nov-btn,.nvt-por select{min-height:44px}
  .nvt-busca{flex:1 1 100%}
  .nvt-ic{width:auto;min-width:44px;height:44px;padding:0 12px}
  .nvt-ic-t,.pvia-btn-t{display:inline}
  .nvt-acoes{flex-wrap:wrap}
  /* Sem mouse o texto está no botão; a dica da caixa "Cumprido" continua (aparece depois de marcar, como na 0.46.0). */
  .nvt-acoes .sit-dica:not([id^="dica-cumprido-"]),.nvt-proc .sit-dica{display:none}
  .nvt-tabela td.c-trib{white-space:normal}
  .nvt-classe{white-space:normal}
  .nvt-abrir{display:block}
  .nvt-abrir .nov-abrir{min-height:44px}
  .nvt-wrap{border:0;background:transparent;box-shadow:none}
  .nvt-tabela,.nvt-tabela tbody,.nvt-tabela tr,.nvt-tabela td{display:block}
  .nvt-tabela thead{display:none}
  .nvt-tabela tr.nvt-linha{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;
    background:var(--papel);border:1px solid var(--linha);border-radius:var(--r);padding:14px;margin-bottom:10px}
  /* height:auto — o 48px da tabela fazia a célula Atualização transbordar sobre a seguinte quando o selo e o botão ocupam mais de uma linha */
  .nvt-tabela tr.nvt-linha td{border:0;padding:0;min-width:0;height:auto}
  .nvt-tabela tbody tr.nvt-linha:hover td{background:transparent}
  .nvt-tabela td::before{content:attr(data-rotulo);display:block;font-size:11px;font-weight:700;
    text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2);margin-bottom:2px}
  .nvt-tabela td.c-proc,.nvt-tabela td.c-atu,.nvt-tabela td.c-acoes,.nvt-tabela td.c-partes{grid-column:1/-1}
  .nvt-tabela td.c-acoes::before{margin-bottom:4px}
  .nvt-num{display:inline-flex;align-items:center;min-height:44px;padding:0}
  .nvt-ato{gap:4px 10px}
  .nvt-pag{justify-content:flex-start}
  .env.env-larga{padding-left:14px;padding-right:14px}
}
`;
