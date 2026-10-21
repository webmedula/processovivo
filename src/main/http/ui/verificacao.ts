/**
 * A verificação dos processos na tela (v0.49.3): o botão "Verificar agora", o aviso embaixo dele e o selo do painel.
 * Vive aqui e não em `script.ts` (que não cresce): o console chama `window.__pvVerificacao.iniciar` ao disparar e ao
 * desenhar o painel, e `selo` para o texto do selo.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Sincronização"):
 * - O estado é o DESTA conta (`GET /v1/sincronizacao`): `situacao` (`na_fila` espera a rodada de outra conta;
 *   `em_andamento` roda), `total`, `concluidos` e `demorando`. Nada da fila dos outros chega aqui.
 * - "Verificando X de N" é o progresso real da conta. Sem total ainda, diz só "Verificando".
 * - "Demorando" só aparece quando a verificação PAROU de avançar (o servidor decide: nenhum item de ninguém foi
 *   concluído há 5 minutos). Rodada longa com a fila andando não é demora, e a frase não culpa o tribunal sem
 *   evidência: diz "pode".
 * - O progresso é anunciado a quem usa leitor de tela numa região discreta: só quando o X muda e no máximo uma vez
 *   a cada 10 s; mudança de situação (entrou na fila, começou, parou de avançar, terminou) é anunciada na hora.
 * - Toda frase é fixa na tela; nada do servidor vira texto além dos números.
 */
export const SCRIPT_VERIFICACAO = String.raw`
(function(){
var pv=function(){return window.__pv};
var INTERVALO_MS=4000;
var ANUNCIO_MIN_MS=10000;
var FRASE_FILA='Na fila: sua verificação começa quando a rodada atual terminar.';
var FRASE_EXPLICA='Cada processo leva alguns segundos (a base do CNJ é lenta), então as novidades vão aparecendo aos poucos. Pode fechar a página — ela continua rodando no servidor.';
var FRASE_DEMORA='A verificação está sem avançar há alguns minutos. As fontes dos tribunais podem estar lentas.';

/* Um só acompanhamento por vez: o botão e o painel aberto com uma rodada em curso usam o MESMO relógio. */
var T={timer:0,botao:null,aviso:null,fim:null,situacao:'',x:-1,anunciadoEm:0,live:null};

function hhmm(v){
  if(!v)return '';
  try{return new Date(v).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'})}
  catch(e){return ''}
}
/* A hora da última verificação concluída: o console a deixa em window.__pvVerificacao.ultimaEm toda vez que desenha o painel. */
function ultima(){var u=window.__pvVerificacao&&window.__pvVerificacao.ultimaEm;return u?' Última verificação às '+hhmm(u)+'.':''}

/* O que dizer para este estado: um só lugar para o botão, o aviso, o selo e o anúncio. */
function textos(est){
  var sit=est.situacao||(est.emAndamento?'em_andamento':'ociosa');
  if(est.demorando)return {chave:'demorando',botao:'Verificação demorando',aviso:FRASE_DEMORA+ultima(),
    selo:'Verificação demorando: sem avanço há alguns minutos.'+ultima(),classe:'atencao',gira:false};
  if(sit==='na_fila')return {chave:'na_fila',botao:'Na fila',aviso:FRASE_FILA,selo:'Na fila para verificar',classe:'neutro',gira:true};
  if(est.total>0){
    var p='Verificando '+est.concluidos+' de '+est.total;
    return {chave:'andamento',botao:p,aviso:p+'. '+FRASE_EXPLICA,selo:p,classe:'neutro',gira:true};
  }
  return {chave:'andamento',botao:'Verificando',aviso:'Verificando os seus processos. '+FRASE_EXPLICA,selo:'Verificando agora',classe:'neutro',gira:true};
}

function regiaoViva(){
  if(T.live&&document.body.contains(T.live))return T.live;
  var r=document.createElement('div');
  r.className='verif-sr';r.setAttribute('role','status');r.setAttribute('aria-live','polite');r.setAttribute('aria-atomic','true');
  document.body.appendChild(r);
  T.live=r;return r;
}
/* Mudança de situação anuncia na hora; só o X mudando respeita o intervalo mínimo. */
function anunciar(texto,imediato){
  var agora=Date.now();
  if(!imediato&&agora-T.anunciadoEm<ANUNCIO_MIN_MS)return;
  T.anunciadoEm=agora;
  regiaoViva().textContent=texto;
}

function pintarSelo(t){
  var s=document.getElementById('vigia-selo');
  if(!s)return;
  s.className='vigia '+t.classe;
  s.innerHTML=(t.gira?'<span class="gira"></span>':'<span class="ponto-vivo"></span>')+pv().esc(t.selo);
}

function pintar(est){
  var t=textos(est);
  if(T.botao){
    T.botao.innerHTML=(t.gira?'<span class="gira"></span>':'')+pv().esc(t.botao);
    T.botao.disabled=true;
  }
  if(T.aviso)T.aviso.textContent=t.aviso;
  pintarSelo(t);
  var x=est.concluidos||0;
  if(t.chave!==T.situacao){
    T.situacao=t.chave;T.x=x;
    anunciar(t.chave==='na_fila'?'Na fila. A verificação começa quando a rodada atual terminar.':
      t.chave==='demorando'?'A verificação está sem avançar há alguns minutos.':
      est.total>0?'Verificando '+x+' de '+est.total+'.':'Verificando os seus processos.',true);
  }else if(t.chave==='andamento'&&x!==T.x&&est.total>0){
    T.x=x;
    anunciar('Verificando '+x+' de '+est.total+'.',false);
  }
}

function parar(){
  if(T.timer){clearInterval(T.timer);T.timer=0}
}
function terminar(){
  parar();
  var fim=T.fim;
  T.botao=null;T.aviso=null;T.fim=null;T.situacao='';T.x=-1;
  anunciar('Verificação concluída.',true);
  if(fim)fim();
}
function consultar(){
  return pv().api('/v1/sincronizacao').then(function(est){
    if(!est.emAndamento){terminar();return}
    pintar(est);
  }).catch(function(){parar()});
}

/* Começa (ou reaproveita) o acompanhamento. botao e resposta vêm do clique em "Verificar agora"; sem eles (painel
   aberto com uma rodada já em curso) só o selo se atualiza. A resposta do POST já diz se entrou na fila. */
function iniciar(botao,resposta,aoTerminar){
  if(botao)T.botao=botao;
  if(botao&&(!T.aviso||!document.body.contains(T.aviso))){
    var a=document.createElement('div');
    a.className='aviso';a.style.marginTop='10px';
    a.textContent=resposta&&resposta.naFila?FRASE_FILA:'Verificando os seus processos. '+FRASE_EXPLICA;
    botao.parentNode.parentNode.appendChild(a);
    T.aviso=a;
  }
  if(aoTerminar)T.fim=aoTerminar;
  if(resposta&&resposta.naFila)pintar({emAndamento:true,situacao:'na_fila',total:0,concluidos:0,demorando:false});
  /* Já havia um acompanhamento (o painel abriu com a rodada em curso): o botão novo não espera o próximo ciclo. */
  if(T.timer){if(botao)consultar();return}
  consultar();
  T.timer=setInterval(consultar,INTERVALO_MS);
}

/* O selo do painel: o servidor manda o estado em /v1/painel; o mesmo texto do botão. */
function selo(ver){
  var t=textos(ver);
  return '<span class="vigia '+t.classe+'" id="vigia-selo">'+(t.gira?'<span class="gira"></span>':'<span class="ponto-vivo"></span>')+
    pv().esc(t.selo)+'</span>';
}

window.__pvVerificacao={iniciar:iniciar,selo:selo,textos:textos};
})();
`;

export const ESTILOS_VERIFICACAO = `
/* Região discreta para leitor de tela (v0.49.3): o progresso da verificação, sem aparecer. */
.verif-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`;
