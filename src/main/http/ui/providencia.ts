/**
 * O componente de "Cumprido" (v0.37.5; refeito na v0.43.0): o HTML do ESTADO e da CAIXA e as
 * duas chamadas à API, num lugar só. A tela que quiser a ação (hoje, a tabela de
 * Atualizações) chama `window.__pvProvidencia` — nenhum HTML é copiado para outra tela.
 *
 * v0.43.0 (decisão do dono): o estado é TEXTO ("● Pede providência", "✓ Cumprido", "—"), sem
 * cara de botão, e a caixa "Cumprido" é o único controle. O botão "Marcar como cumprido" e a
 * confirmação de desfazer saíram: desmarcar a caixa é o desfazer, e o aviso curto depois de
 * marcar (`atualizacoes.ts`) oferece "Desfazer". As DUAS chamadas ao servidor são as de antes
 * (`POST` e `DELETE …/cumprido`), com as mesmas regras.
 *
 * Arquivo próprio pela mesma razão do leitor e do calendário: `script.ts` não
 * cresce. Mesmo regime dele: JavaScript dentro de uma string, invisível ao tsc;
 * `tests/http/console-script.spec.ts` roda o ESLint aqui dentro. Todo texto
 * vindo do servidor passa por `esc()`.
 *
 * O que a marca É: "cumpri o que este ato pedia". Não é prazo, não mexe na
 * "não lida" e um ato novo que exija ação volta a pedir providência sozinho.
 */
export const SCRIPT_PROVIDENCIA = String.raw`
(function(){
var pv=function(){return window.__pv};
function esc(s){return pv().esc(s)}
function digitos(n){return String(n||'').replace(/\D/g,'')}

/* O estado da providência, como TEXTO. O ícone (● ou ✓) só reforça: o texto sempre está lá, então a
   informação não depende de cor. Sem hover de clique: não é controle. O traço tem texto para leitor de tela. */
var TITULO_PEDE='Marcado por leitura automática do texto. Confira no ato completo.';
function estado(est,motivo,cumpridoEm){
  if(est==='pede')
    return '<span class="sit sit-pede" title="'+esc((motivo?motivo+'. ':'')+TITULO_PEDE)+'"><span class="sit-ic" aria-hidden="true">●</span> Pede providência</span>';
  if(est==='cumprido')
    return '<span class="sit sit-cumprido" title="'+esc('Você marcou como cumprido'+(cumpridoEm?' em '+pv().dth(cumpridoEm):'')+
      '. Um ato novo que exija ação volta a pedir providência sozinho.')+'"><span class="sit-ic" aria-hidden="true">✓</span> Cumprido</span>';
  return '<span class="sit sit-nenhuma"><span aria-hidden="true">—</span><span class="nvt-sr">Sem providência</span></span>';
}

/* A caixa "Cumprido": input real com rótulo visível. O nome acessível começa pela palavra visível e
   acrescenta o processo, porque a tabela repete a caixa em toda linha. A chave é opaca: vem do
   servidor e volta igual. */
function caixa(num,mascara,chave,marcado,foco){
  return '<label class="sit-cx"><input type="checkbox" class="sit-cx-in" data-cx="cumprido" data-num="'+esc(num)+
    '" data-chave="'+esc(chave)+'" data-foco="'+esc(foco)+'" aria-label="Cumprido: processo '+esc(mascara)+'"'+
    (marcado?' checked':'')+'><span class="sit-cx-txt">Cumprido</span></label>';
}

function caminho(num){return '/v1/acompanhamentos/'+encodeURIComponent(digitos(num))+'/cumprido'}

/* Resolvem com o PROCESSO já recalculado pelo servidor (mesmo formato de /v1/novidades). */
function marcar(num,chave){
  return pv().api(caminho(num),{method:'POST',body:{chaveDoAto:chave}}).then(function(r){return r.processo});
}
function remover(num){
  return pv().api(caminho(num),{method:'DELETE'}).then(function(r){return r.processo});
}

window.__pvProvidencia={estado:estado,caixa:caixa,marcar:marcar,remover:remover};
})();
`;

export const ESTILOS_PROVIDENCIA = `
/* Estado: texto, sem fundo, sem borda, sem hover. Cores com UM significado cada (âmbar = pede providência,
   verde = cumprido); o texto usa os tons de tinta (--atencao, --verde-tinta), que passam de 4,5:1 nos dois
   temas, e o ponto/ícone vai na cor viva. O traço e o ícone nunca são a única informação. */
.sit{display:inline-block;font-weight:600;font-size:13px;line-height:1.35;margin:0 0 2px;cursor:default}
.sit-pede{color:var(--atencao)}
.sit-pede .sit-ic{color:var(--atencao-ponto)}
.sit-cumprido{color:var(--verde-tinta)}
.sit-nenhuma{color:var(--tinta2);font-weight:400}
/* A caixa: o rótulo todo é o alvo (24 px no mínimo; 32 no desktop e 44 no empilhado). */
.sit-cx{display:inline-flex;align-items:center;gap:8px;min-height:32px;min-width:24px;padding:2px 6px 2px 0;
  cursor:pointer;font-size:13px;font-weight:600;color:var(--tinta)}
.sit-cx-in{width:20px;height:20px;margin:0;flex:none;cursor:pointer;accent-color:var(--acento)}
.sit-cx-txt{white-space:nowrap}
.sit-cx-in[aria-busy="true"]{opacity:.6;cursor:progress}
.nvt-cumprida .nvt-tit{font-weight:500;color:var(--tinta2)}
.selo.int{background:var(--atencao-bg);color:var(--atencao);border:1px solid var(--atencao)}
.nvt-erro{padding:0 0 12px;color:var(--erro)}
.nvt .selo.neutro{color:var(--tinta2)}
.nvt-resumo:focus,.nvt-sem-prov:focus{outline:none}
/* O aviso depois de marcar mora FORA da tabela e do trecho redesenhado; vazio não ocupa altura. */
.nvt-desfazer{font-size:13.5px;color:var(--tinta2)}
.nvt-desfazer:not(:empty){display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0 0 10px;
  padding:6px 12px;background:var(--papel);border:1px solid var(--linha);border-radius:var(--r)}
.nvt-desfazer .nov-btn{min-height:32px}
@media (max-width:1023px){.sit-cx{min-height:44px}.nvt-desfazer .nov-btn{min-height:44px}}
`;
