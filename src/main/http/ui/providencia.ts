/**
 * O componente da coluna "Cumprido" (v0.37.5; refeito na v0.43.0 e na v0.46.0): o HTML da CÉLULA, a dica
 * e as duas chamadas à API, num lugar só. A tela que quiser a ação (hoje, a tabela de Atualizações)
 * chama `window.__pvProvidencia` — nenhum HTML é copiado para outra tela.
 *
 * v0.46.0 (decisão do dono): a coluna é como a "Marcar" do Projudi — SÓ a caixa, sem texto ao lado. O
 * estado em texto ("● Pede providência", "✓ Cumprido", "—") saiu: a presença da caixa é o sinal de "tem
 * providência", e linha sem providência fica sem nada. Quem explica a caixa é uma dica (`role="tooltip"`,
 * ligada por `aria-describedby`), que aparece ao passar o mouse e ao focar, some com Esc e não depende
 * de `title`. As DUAS chamadas ao servidor são as de antes (`POST` e `DELETE …/cumprido`).
 *
 * ISOLAMENTO (preparação para categorias escolhidas pelo advogado, ainda NÃO implementadas): tudo o que
 * a coluna sabe sobre "cumprido" mora aqui — `celula`, `pintar`, `marcar`, `remover`, `ligar`. A tabela
 * só entrega o estado da linha (`situacaoDaLinha`) e escuta `change` em `[data-cx]`. Trocar o controle
 * por outro (um seletor de categoria) é trocar este arquivo, sem mexer na tabela.
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

/* O texto da dica, por estado. Frases combinadas com o dono; nada aqui fala em prazo. */
var DICA_PEDE='Pede providência. Marque quando cumprida.';
var DICA_CUMPRIDA='Cumprida. Clique para desmarcar.';
var DICA_SEM_CAIXA='Pede providência. Não dá para marcar aqui; confira no processo.';
function textoDaDica(marcado){return marcado?DICA_CUMPRIDA:DICA_PEDE}

/* A célula inteira. sit vem de situacaoDaLinha: 'nenhuma' = nada (sem traço, sem caixa). Com caixa, o
   <input> é real; o nome acessível começa pela palavra "Cumprido" e acrescenta o processo, porque a tabela
   repete a caixa em toda linha. A dica é irmã do rótulo, fora dele (clicar nela não marca), ligada por
   aria-describedby e escondida por CSS — o leitor de tela a lê mesmo escondida. "pede" sem chave de ato
   (servidor antigo) mostra a caixa DESABILITADA: o sinal de providência não some, e a tela nunca inventa a chave. */
function celula(sit,num,mascara,foco){
  if(sit.estado==='nenhuma')return '';
  var id='dica-cumprido-'+esc(digitos(num));
  var livre=sit.caixa;
  var dica=livre?textoDaDica(sit.marcado):DICA_SEM_CAIXA;
  var nome=livre?'Cumprido: processo '+mascara:'Pede providência, sem ato marcável: processo '+mascara;
  return '<span class="sit-dica-wrap"><label class="sit-cx"><input type="checkbox" class="sit-cx-in" data-cx="cumprido" data-num="'+esc(num)+
    '" data-chave="'+esc(sit.chave)+'" data-foco="'+esc(foco)+'" aria-label="'+esc(nome)+'" aria-describedby="'+id+'"'+
    (sit.marcado?' checked':'')+(livre?'':' disabled')+'></label>'+
    '<span class="sit-dica" role="tooltip" id="'+id+'">'+esc(dica)+'</span></span>';
}

/* Pintura otimista da caixa que acabou de mudar: a dica já diz o estado novo. A linha cumprida é
   marcada pela tabela (classe da <tr>). */
function pintar(caixa,marcar){
  caixa.setAttribute('aria-busy','true');
  var wrap=caixa.closest?caixa.closest('.sit-dica-wrap'):null;
  var dica=wrap?wrap.querySelector('.sit-dica'):null;
  if(dica)dica.textContent=textoDaDica(marcar);
}

/* Esc fecha a dica sem tirar o foco da caixa; ela volta quando o mouse sai e o foco também. Um ouvinte
   por raiz, delegado: o HTML interno é trocado a cada desenho. */
function ligar(raiz){
  function envoltorio(alvo){return alvo&&alvo.closest?alvo.closest('.sit-dica-wrap'):null}
  raiz.addEventListener('keydown',function(ev){
    if(ev.key!=='Escape')return;
    var w=envoltorio(ev.target);
    if(w)w.classList.add('sit-dica-fechada');
  });
  raiz.addEventListener('focusout',function(ev){
    var w=envoltorio(ev.target);
    if(w&&!w.matches(':hover'))w.classList.remove('sit-dica-fechada');
  });
  raiz.addEventListener('mouseout',function(ev){
    var w=envoltorio(ev.target);
    if(!w||w.contains(ev.relatedTarget))return;
    if(!w.contains(document.activeElement))w.classList.remove('sit-dica-fechada');
  });
}

function caminho(num){return '/v1/acompanhamentos/'+encodeURIComponent(digitos(num))+'/cumprido'}

/* Resolvem com o PROCESSO já recalculado pelo servidor (mesmo formato de /v1/novidades). */
function marcar(num,chave){
  return pv().api(caminho(num),{method:'POST',body:{chaveDoAto:chave}}).then(function(r){return r.processo});
}
function remover(num){
  return pv().api(caminho(num),{method:'DELETE'}).then(function(r){return r.processo});
}

window.__pvProvidencia={celula:celula,pintar:pintar,ligar:ligar,textoDaDica:textoDaDica,marcar:marcar,remover:remover};
})();
`;

export const ESTILOS_PROVIDENCIA = `
/* A coluna "Cumprido": só a caixa (v0.46.0). Alvo de 32 px no desktop e 44 no empilhado; o rótulo é o alvo. */
.sit-cx{display:inline-flex;align-items:center;justify-content:center;min-height:32px;min-width:32px;cursor:pointer}
.sit-cx-in{width:20px;height:20px;margin:0;flex:none;cursor:pointer;accent-color:var(--acento)}
.sit-cx-in:disabled{cursor:not-allowed}
.sit-cx-in[aria-busy="true"]{opacity:.6;cursor:progress}
/* Sem transição de opacidade: o leitor de contraste (e quem tem sensibilidade a movimento) veria a dica pela metade. */
/* A dica (ancorada à direita da caixa: a coluna fica na ponta da tabela e uma dica que crescesse para a
   direita criaria rolagem horizontal; no empilhado, que não tem ponta, ancora à esquerda): irmã do rótulo, escondida por visibility (o leitor de tela ainda a lê pelo aria-describedby).
   Aparece com o mouse ou com o foco na caixa, sem clique; Esc a fecha (.sit-dica-fechada). Não recebe o
   mouse (não tapa nem rouba o clique) e fica abaixo da caixa, sobre a linha de baixo, nunca sobre a própria. */
.sit-dica-wrap{position:relative;display:inline-block}
.sit-dica{position:absolute;right:0;top:100%;z-index:5;width:max-content;max-width:min(180px,calc(100vw - 48px));
  padding:6px 9px;border-radius:6px;background:var(--tinta);color:var(--papel);font-size:12.5px;font-weight:500;
  line-height:1.35;text-align:left;box-shadow:var(--sombra);visibility:hidden;opacity:0;pointer-events:none}
.sit-dica-wrap:hover .sit-dica,.sit-dica-wrap:focus-within .sit-dica{visibility:visible;opacity:1}
.sit-dica-wrap.sit-dica-fechada .sit-dica{visibility:hidden;opacity:0}
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
@media (max-width:1023px){.sit-cx{min-height:44px;min-width:44px;justify-content:flex-start}.sit-dica{right:auto;left:0}.nvt-desfazer .nov-btn{min-height:44px}}
`;
