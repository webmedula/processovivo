/**
 * O componente de ação de "Marcar como cumprido" (v0.37.5): o HTML dos botões e
 * as duas chamadas à API, num lugar só. A tela que quiser a ação (hoje, a tabela
 * de Atualizações) chama `window.__pvProvidencia` e trata os cliques com os
 * `data-acao` que ele escreve — nenhum HTML de botão é copiado para outra tela.
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

/* O botão que marca o ato que a tela mostrou. A chave é opaca: vem do servidor e volta igual. */
function botaoCumprir(num,chave,foco){
  return '<button type="button" class="nov-btn pvp-cumprir" data-acao="cumprir" data-num="'+esc(num)+
    '" data-chave="'+esc(chave)+'" data-foco="'+esc(foco)+'">Marcar como cumprido</button>';
}

/* Desfazer com confirmação leve, NA PRÓPRIA célula (nada de alert/confirm do navegador).
   Esc cancela: quem trata o teclado é a tela. */
function controleDeDesfazer(num,confirmando,foco){
  if(!confirmando)
    return '<button type="button" class="nov-btn pvp-desfazer" data-acao="desfazer" data-num="'+esc(num)+
      '" data-foco="'+esc(foco)+'">Desfazer</button>';
  return '<span class="pvp-conf" role="group" aria-label="Desfazer a marca de cumprido?">'+
    '<span class="pvp-conf-txt">Desfazer a marca de cumprido?</span> '+
    '<button type="button" class="nov-btn pvp-sim" data-acao="desfazer-sim" data-num="'+esc(num)+
    '" data-foco="'+esc(foco)+'">Sim, desfazer</button> '+
    '<button type="button" class="nov-btn" data-acao="desfazer-nao" data-num="'+esc(num)+
    '" data-foco="'+esc(foco)+'-nao">Cancelar</button></span>';
}

function caminho(num){return '/v1/acompanhamentos/'+encodeURIComponent(digitos(num))+'/cumprido'}

/* Resolvem com o PROCESSO já recalculado pelo servidor (mesmo formato de /v1/novidades). */
function marcar(num,chave){
  return pv().api(caminho(num),{method:'POST',body:{chaveDoAto:chave}}).then(function(r){return r.processo});
}
function remover(num){
  return pv().api(caminho(num),{method:'DELETE'}).then(function(r){return r.processo});
}

window.__pvProvidencia={botaoCumprir:botaoCumprir,controleDeDesfazer:controleDeDesfazer,marcar:marcar,remover:remover};
})();
`;

export const ESTILOS_PROVIDENCIA = `
.pvp-cumprir{margin-top:4px;display:inline-block;max-width:100%;white-space:normal;text-align:center;line-height:1.25;padding-top:6px;padding-bottom:6px}
.pvp-desfazer{margin-top:4px}
.pvp-conf{display:block;margin-top:4px;font-size:12.5px;color:var(--tinta2);line-height:1.5}
.pvp-conf-txt{display:block;margin-bottom:4px}
.pvp-conf .nov-btn{margin:0 4px 4px 0}
.nvt-por{margin-top:4px;font-size:12.5px;line-height:1.4;color:var(--tinta2);overflow-wrap:anywhere}
.nvt-por strong{color:var(--tinta)}
.selo.int{background:var(--atencao-bg);color:var(--atencao);border:1px solid var(--atencao)}
.selo.cum{background:var(--verde-bg);color:var(--verde-tinta)}
.nvt-erro{padding:0 0 12px;color:var(--erro)}
.nvt .selo.neutro{color:var(--tinta2)}
.nvt-resumo:focus,.nvt-sem-prov:focus{outline:none}
`;
