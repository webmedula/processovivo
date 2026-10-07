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
.nvt-tabela td{padding:12px 8px;vertical-align:top;border-top:1px solid var(--linha2);
  overflow-wrap:anywhere;min-width:0}
/* Palavra curta quebra em espaço, não no meio ("detectad/o"); só texto de fora usa "anywhere". */
.nvt-tabela td.c-trib,.nvt-tabela td.c-det,.nvt-tabela td.c-sit{overflow-wrap:break-word}
.nvt-tabela td.c-data{white-space:nowrap}
.nvt-tabela tbody tr:first-child td{border-top:0}
.nvt-tabela tbody tr.nvt-linha:hover td{background:var(--papel2)}
/* Classe com 12,5% (era 8,5%): em 1366 px o conteúdo mede ~1060 px e 8,5% deixava ~74 px,
   menos que a palavra "Procedimento". A largura veio de Partes e Atualização (o texto longo,
   que tem clamp e title) e de Processo; Ações e Data seguem com o que os botões e a data pedem. */
.h-processo{width:16%}.h-partes{width:11%}.h-atu{width:19%}.h-tribunal{width:6.5%}.h-classe{width:12.5%}
.h-dataAto{width:8.5%}.h-detectado{width:8%}.h-sit{width:9%}.h-acoes{width:9.5%}
.nvt-ord{font:inherit;font-size:inherit;font-weight:inherit;text-transform:inherit;letter-spacing:inherit;
  color:inherit;background:none;border:0;padding:4px 0;min-height:28px;cursor:pointer;text-align:left}
.nvt-ord:hover{color:var(--tinta)}
.nvt-seta{color:var(--tinta3)}
.nvt-tabela th[aria-sort="ascending"] .nvt-seta,.nvt-tabela th[aria-sort="descending"] .nvt-seta{color:var(--acento)}

.nvt-proc{display:flex;align-items:flex-start;gap:4px;flex-wrap:nowrap}
.nvt-num{font-family:var(--mono);font-weight:600;font-size:12.5px;color:var(--acento);text-decoration:none;
  overflow-wrap:normal;padding:4px 0;flex:1 1 auto;min-width:0}
.nvt-num:hover{text-decoration:underline}
.nvt-copiado{font-size:12px;font-weight:700;color:var(--verde-tinta);align-self:center}
.nvt-partes,.nvt-classe{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;
  overflow-wrap:anywhere}
/* A classe quebra em PALAVRAS inteiras: "break-word" só parte a palavra que sozinha não cabe
   na coluna. Passando de duas linhas, o clamp põe as reticências e o title tem a classe toda. */
.nvt-classe{overflow-wrap:break-word;hyphens:manual}
.nvt-classe-mini{display:none;margin-top:3px;font-size:12px;color:var(--tinta2)}
.nvt-vazio{color:var(--tinta2)}
.nvt-tit{font-weight:700;font-size:14px;line-height:1.4;overflow-wrap:anywhere}
.nvt-tit.nl::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;
  background:var(--novo);margin-right:7px;vertical-align:2px}
.nvt-tabela .c-sit .selo{display:inline-block;margin:0 4px 4px 0}
.c-data,.c-det{font-variant-numeric:tabular-nums;color:var(--tinta2)}

/* O clamp é só rede de segurança (220 caracteres em coluna estreita passam de 3
   linhas); o botão fica FORA do bloco cortado para nunca ser comido por ele. */
.nov-txt{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;
  overflow:hidden;overflow-wrap:anywhere;font-weight:400;color:var(--tinta2)}
.nov-trecho{margin-top:4px}
.nov-trecho .nov-abrir{display:block;margin-top:3px;color:var(--acento);font-weight:600;
  background:none;border:0;padding:2px 0;cursor:pointer;font-family:inherit;font-size:13px}

/* ---------- ações ---------- */
.nvt-acoes{display:flex;flex-wrap:nowrap;gap:4px;align-items:center}
.nvt-ic{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;
  border-radius:8px;border:1px solid var(--linha);background:var(--papel);color:var(--tinta2);cursor:pointer;flex:none}
.nvt-ic:hover:not(:disabled){background:var(--acento-bg);border-color:var(--acento);color:var(--acento)}
.nvt-ic:disabled{opacity:.4;cursor:default}
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

/* ---------- de 1024 a 1279: a lateral de 256px come a largura ---------- */
@media (min-width:1024px) and (max-width:1279px){
  .h-classe,.c-classe{display:none}
  .nvt-classe-mini{display:block}
  .h-processo{width:17%}.h-partes{width:11.5%}.h-atu{width:19%}.h-tribunal{width:10%}
  .h-dataAto{width:10.5%}.h-detectado{width:10.5%}.h-sit{width:10.5%}.h-acoes{width:11%}
  .nvt-tabela th{font-size:10px;letter-spacing:0}
  .nvt-classe-mini{font-size:11px;overflow-wrap:anywhere}
  .nvt-tabela th,.nvt-tabela td{padding-left:5px;padding-right:5px}
  .nvt-tabela{font-size:12.5px}
  .nvt-tabela td.c-data{font-size:12px}
  .nvt-ic{width:28px;height:28px}
  .nvt-copiar{margin-top:2px}
}

/* ---------- abaixo de 1024: um bloco por processo ---------- */
@media (max-width:1023px){
  .nvt-so-pequeno{display:flex}
  .nvt .chip,.nvt-bloco select,.nov-btn,.nvt-por select{min-height:44px}
  .nvt-ic{width:44px;height:44px}
  .nvt-wrap{border:0;background:transparent;box-shadow:none}
  .nvt-tabela,.nvt-tabela tbody,.nvt-tabela tr,.nvt-tabela td{display:block}
  .nvt-tabela thead{display:none}
  .nvt-tabela tr.nvt-linha{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;
    background:var(--papel);border:1px solid var(--linha);border-radius:var(--r);padding:14px;margin-bottom:10px}
  .nvt-tabela tr.nvt-linha td{border:0;padding:0;min-width:0}
  .nvt-tabela tbody tr.nvt-linha:hover td{background:transparent}
  .nvt-tabela td::before{content:attr(data-rotulo);display:block;font-size:11px;font-weight:700;
    text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2);margin-bottom:2px}
  .nvt-tabela td.c-proc,.nvt-tabela td.c-atu,.nvt-tabela td.c-acoes,.nvt-tabela td.c-partes{grid-column:1/-1}
  .nvt-tabela td.c-sit:empty{display:none}
  .nvt-tabela td.c-acoes::before{margin-bottom:4px}
  .nvt-num{display:inline-flex;align-items:center;min-height:44px;padding:0}
  .nvt-pag{justify-content:flex-start}
  .env.env-larga{padding-left:14px;padding-right:14px}
}
`;
