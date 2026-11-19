/**
 * QUAIS processos estão sem verificação (v0.69.0).
 *
 * A tela inicial dizia "1 sem verificação — o silêncio destas não significa que nada
 * aconteceu" e um selo âmbar com a contagem, mas não dizia qual. O advogado lia o aviso e
 * não tinha como agir. Agora o selo é um BOTÃO ("1 sem verificação · ver qual") que abre,
 * logo abaixo do cabeçalho, a lista: número (que abre o processo), cliente e tribunal quando
 * existem, o motivo numa frase fixa e a última verificação que deu certo.
 *
 * Vive aqui e não em `script.ts` (que não cresce): o console chama `selo(ver)` no lugar do
 * selo âmbar e `painel(ver)` antes da tabela, em linhas que já existiam. O clique é por
 * delegação no documento, então o redesenho da aba não perde nada; a lista aberta continua
 * aberta (o estado mora numa variável desta página, nunca em `localStorage`).
 *
 * Toda frase é fixa: do servidor só chegam números, datas, o rótulo de cliente que o próprio
 * advogado deu, a sigla do tribunal e um motivo de lista fechada (`motivoSemVerificacao`).
 * A mensagem de erro gravada nunca chega à tela.
 */
export const SCRIPT_SEM_VERIFICACAO = String.raw`
(function(){
var pv=function(){return window.__pv};
var aberta=false;
var FRASES={
  aguardando_primeira:'Ainda não foi verificado pela primeira vez.',
  nao_encontrado:'As fontes públicas responderam, mas não acharam este número. Confira o número: processo recém-distribuído pode demorar a aparecer.',
  fontes_indisponiveis:'As fontes públicas (CNJ e Diário) não responderam na última tentativa.',
  outro:'A última tentativa de consulta não deu certo.'
};

function lista(ver){return (ver&&ver.semVerificacao)||[]}

/* O selo âmbar. Sem a lista (servidor antigo), o selo de antes, sem botão: nada promete o que não abre. */
function selo(ver){
  var n=ver.naoVerificados||0;
  var ponto='<span class="ponto-vivo"></span>';
  if(!lista(ver).length)return '<span class="vigia atencao">'+ponto+n+' sem verificação</span>';
  return '<button type="button" class="vigia atencao semv-bt" id="semv-bt" aria-expanded="'+(aberta?'true':'false')+
    '" aria-controls="semv-painel">'+ponto+'<span>'+n+' sem verificação <span class="semv-ver">· '+
    (n===1?'ver qual':'ver quais')+'</span></span>'+
    '<span class="semv-seta" aria-hidden="true">▾</span></button>';
}

function linha(p){
  var esc=pv().esc;
  var extra=[];
  if(p.cliente)extra.push(esc(p.cliente));
  if(p.tribunal)extra.push(esc(p.tribunal));
  var ultima=p.ultimaVerificacaoEm
    ?'Última verificação que deu certo: '+esc(pv().dth(p.ultimaVerificacaoEm))
    :'Nenhuma verificação deu certo ainda.';
  return '<li class="semv-item">'+
    '<button type="button" class="semv-num" data-semv-abrir="'+esc(p.numero)+'">'+esc(p.numero)+'</button>'+
    (extra.length?'<span class="semv-extra">'+extra.join(' · ')+'</span>':'')+
    '<div class="semv-motivo">'+esc(FRASES[p.motivo]||FRASES.outro)+'</div>'+
    '<div class="semv-ultima">'+ultima+'</div></li>';
}

/* O painel com a lista. Existe no DOM sempre que há lista (escondido quando fechado), para o aria-controls apontar para algo. */
function painel(ver){
  var l=lista(ver);
  if(!l.length)return '';
  var n=ver.naoVerificados||l.length;
  var resto=n-l.length;
  return '<section class="semv" id="semv-painel" aria-labelledby="semv-titulo"'+(aberta?'':' hidden')+'>'+
    '<h3 id="semv-titulo" tabindex="-1">'+(n===1?'Processo sem verificação':'Processos sem verificação')+'</h3>'+
    '<ul class="semv-lista">'+l.map(linha).join('')+'</ul>'+
    (resto>0?'<p class="semv-nota">e mais '+resto+(resto===1?' processo':' processos')+' (veja em Meus processos).</p>':'')+
    '<p class="semv-nota">O sistema tenta de novo a cada verificação. Até lá, confira '+(n===1?'este processo':'estes processos')+
    ' no sistema do tribunal.</p></section>';
}

function alternar(){
  var bt=document.getElementById('semv-bt'),pn=document.getElementById('semv-painel');
  if(!bt||!pn)return;
  aberta=!aberta;
  bt.setAttribute('aria-expanded',aberta?'true':'false');
  if(aberta){pn.removeAttribute('hidden');var t=document.getElementById('semv-titulo');if(t)t.focus()}
  else pn.setAttribute('hidden','');
}

document.addEventListener('click',function(ev){
  var alvo=ev.target&&ev.target.closest?ev.target:null;
  if(!alvo)return;
  if(alvo.closest('#semv-bt')){alternar();return}
  var num=alvo.closest('[data-semv-abrir]');
  if(num)pv().abrir(num.getAttribute('data-semv-abrir'));
});

window.__pvSemVerif={selo:selo,painel:painel,frases:FRASES};
})();
`;

export const ESTILOS_SEM_VERIFICACAO = `
/* v0.69.0: o selo âmbar vira botão e abre a lista dos processos sem verificação. */
.semv-bt{border:0;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer;text-align:left;line-height:1.3;padding:6px 14px}
.semv-bt:hover{filter:brightness(.97)}
.semv-bt:focus-visible{outline:3px solid var(--acento);outline-offset:2px}
.semv-ver{text-decoration:underline;text-underline-offset:2px}
.semv-seta{flex:0 0 auto;display:inline-block;font-size:14px;line-height:1;transition:transform .15s}
.semv-bt[aria-expanded="true"] .semv-seta{transform:rotate(180deg)}
@media (prefers-reduced-motion:reduce){.semv-seta{transition:none}}
.semv{margin:-8px 0 20px;padding:14px 16px;border:1px solid var(--linha);border-left:4px solid var(--atencao-ponto);
  border-radius:var(--r);background:var(--papel)}
.semv h3{margin:0 0 8px;font-size:15px;font-weight:800;color:var(--tinta)}
.semv h3:focus{outline:none}
.semv h3:focus-visible{outline:3px solid var(--acento);outline-offset:2px}
.semv-lista{list-style:none;margin:0;padding:0}
.semv-item{padding:10px 0;border-top:1px solid var(--linha);min-width:0}
.semv-item:first-child{border-top:0;padding-top:4px}
.semv-num{background:none;border:0;padding:0;min-height:32px;font:inherit;font-weight:700;font-size:15px;
  color:var(--acento);text-decoration:underline;text-underline-offset:2px;cursor:pointer;
  font-family:'JetBrains Mono',ui-monospace,monospace;white-space:nowrap}
.semv-num:focus-visible{outline:3px solid var(--acento);outline-offset:2px;border-radius:4px}
.semv-extra{margin-left:10px;color:var(--tinta2);font-size:13px;overflow-wrap:anywhere}
.semv-motivo{margin-top:2px;font-size:14px;color:var(--tinta)}
.semv-ultima{margin-top:2px;font-size:13px;color:var(--tinta2)}
.semv-nota{margin:10px 0 0;font-size:13px;color:var(--tinta2)}
@media (max-width:600px){.semv-extra{display:block;margin-left:0}}
`;
