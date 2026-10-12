/**
 * "Analisar com IA" na tabela de Atualizações (v0.38.0): o botão da linha, o painel
 * logo abaixo dela e as duas chamadas à API, num arquivo só. `script.ts` não cresce
 * (há teste que fixa o tamanho): a tela de Atualizações chama `window.__pvAnaliseIA`
 * e trata os cliques `data-acao="ia…"` que este arquivo escreve.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Análise por IA"):
 * - é APOIO À LEITURA: nada aqui altera "pede providência", "não lida", ordem, contagem
 *   ou calendário, e nenhuma ação depende do resultado. O aviso fixo diz isso;
 * - o pedido leva SÓ a chave do ato; o texto é lido pelo servidor, do retrato da conta;
 * - a IA desligada (padrão) não deixa botão nenhum na página; conta sem o plano IA vê o
 *   botão e, ao clicar, a frase fixa de upgrade — sem promessa de link de compra;
 * - a resposta demora (p50 ~29 s, p95 ~52 s com raciocínio ligado): o estado "analisando"
 *   diz isso e oferece Cancelar, que aborta a requisição (e, no servidor, a chamada ao modelo);
 * - toda frase de recusa é FIXA aqui — nunca texto do modelo; o resultado verificado traz
 *   citações que existem no texto do ato, mostradas destacadas;
 * - avaliação sem texto livre: Útil / Errado / Perigoso, com confirmação visível e dá para
 *   corrigir.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc;
 * `tests/http/console-script.spec.ts` roda o ESLint aqui dentro. Todo texto vindo do
 * servidor passa por `esc()`.
 */
export const SCRIPT_ANALISE_IA = String.raw`
(function(){
var pv=function(){return window.__pv};
function esc(s){return pv().esc(s)}
function digitos(n){return String(n||'').replace(/\D/g,'')}

var D={habilitada:null,promessa:null};
var E={};
var L={redesenhar:function(){},anunciar:function(){}};

var PARECE={
  manifestar:'Manifestação da parte',
  cumprir_determinacao:'Cumprimento de uma determinação',
  comparecer_audiencia_ou_pericia:'Comparecimento a audiência ou perícia',
  apenas_ciencia:'Apenas ciência',
  sem_providencia_aparente:'Nenhuma providência aparente',
  indeterminado:'Não foi possível determinar'
};
var ATENCAO={
  conferir_prazo_no_processo:'Conferir o prazo no processo.',
  ato_depende_de_outro_documento:'O ato parece depender de outro documento.',
  texto_incompleto:'O texto do ato pode estar incompleto.',
  possivel_outro_destinatario:'A comunicação pode ser dirigida a outro destinatário.'
};
var RECUSAS={
  sem_plano:'A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.',
  segredo_de_justica:'Processo em segredo de justiça: a análise por IA não é feita. Leia o ato.',
  texto_insuficiente:'Este ato não traz texto suficiente para analisar. Leia o ato.',
  texto_indisponivel:'O tribunal não liberou o texto deste ato. Abra o processo no tribunal.',
  limite_de_uso:'Há muitas análises em andamento. Tente novamente em instantes.',
  ato_nao_encontrado:'Esse ato não está mais no último retrato do processo. Atualize a tela e confira de novo.'
};
var NAO_VERIFICADO='Não foi possível analisar com segurança. Leia o ato.';
var ERRO='Não foi possível analisar agora. Tente de novo em alguns minutos.';
var SEM_ACAO='Sem providência indicada no ato.';
var AVISO_FIXO='Apoio à leitura, não substitui a leitura do ato nem a contagem de prazo.';
var AVALIACOES=[['util','Útil'],['errado','Errado'],['perigoso','Perigoso']];

/* Pergunta uma vez por página se a IA está ligada. Falha de rede = desligada (sem botão). */
function carregar(){
  if(D.promessa)return D.promessa;
  var h={},k=pv().chave();
  if(k)h['x-api-key']=k;
  D.promessa=fetch('/v1/analises/disponibilidade',{headers:h})
    .then(function(r){return r.ok?r.json():{habilitada:false}})
    .then(function(b){D.habilitada=b.habilitada===true;return D.habilitada},
      function(){D.habilitada=false;return false});
  return D.promessa;
}
function habilitada(){return D.habilitada===true}
function ligar(callbacks){
  L.redesenhar=callbacks.redesenhar||L.redesenhar;
  L.anunciar=callbacks.anunciar||L.anunciar;
}

function aberto(n){return !!(E[n]&&E[n].aberto)}

/* O botão da linha. Sem IA ligada ou sem chave do ato, não há botão. */
function botao(num,chave){
  var n=digitos(num);
  if(!habilitada()||!chave)return '';
  return '<button type="button" class="nov-btn pvia-btn" data-acao="ia" data-num="'+esc(num)+'" data-chave="'+esc(chave)+
    '" data-foco="ia-'+esc(n)+'" aria-expanded="'+(aberto(n)?'true':'false')+'" aria-controls="pvia-'+esc(n)+
    '" title="Gera um resumo do ato por IA. Apoio à leitura: confira sempre no ato.">Analisar com IA</button>';
}

function seloIA(d){
  var tip='Gerado por IA em '+pv().dth(d.criadaEm)+'. Confira no ato.';
  return '<span class="pvia-selo" tabindex="0" role="note" aria-label="'+esc(tip)+'" title="'+esc(tip)+'">IA</span>';
}

function citacao(t){
  return '<blockquote class="pvia-cit"><mark>'+esc(t)+'</mark></blockquote>';
}

function blocoResultado(n,e){
  var d=e.dados,h='';
  h+='<p class="pvia-parece">Parece pedir: <strong>'+esc(PARECE[d.parecePedir]||PARECE.indeterminado)+'</strong></p>';
  if(d.resumo)h+='<p class="pvia-resumo">'+esc(d.resumo)+'</p>';
  if(d.trechoChave)h+='<div class="pvia-sec"><span class="pvia-rot">Trecho do ato em que se baseia</span>'+citacao(d.trechoChave)+'</div>';
  /* Ação é só providência, sem bloco de citação: o trecho do ato aparece UMA vez, acima. */
  h+='<div class="pvia-sec"><span class="pvia-rot">Ações possíveis</span>';
  if(d.acoesPossiveis&&d.acoesPossiveis.length){
    h+='<ul class="pvia-lista">'+d.acoesPossiveis.map(function(a){return '<li>'+esc(a.acao)+'</li>'}).join('')+'</ul>';
  }else h+='<p class="pvia-vazio">'+SEM_ACAO+'</p>';
  h+='</div>';
  if(d.pontosDeAtencao&&d.pontosDeAtencao.length){
    h+='<div class="pvia-sec"><span class="pvia-rot">Pontos de atenção</span><ul class="pvia-lista">'+
      d.pontosDeAtencao.map(function(p){return '<li>'+esc(ATENCAO[p]||'')+'</li>'}).join('')+'</ul></div>';
  }
  h+='<div class="pvia-proc">'+seloIA(d)+'<span>Gerado por IA em '+esc(pv().dth(d.criadaEm))+'. Confira no ato.</span></div>';
  h+='<div class="pvia-aval" role="group" aria-label="Como foi esta análise?"><span class="pvia-rot">Como foi esta análise?</span>'+
    AVALIACOES.map(function(a){
      var on=e.aval===a[0];
      return '<button type="button" class="nov-btn pvia-av'+(on?' on':'')+'" data-acao="ia-aval" data-num="'+esc(n)+'" data-aval="'+a[0]+
        '" data-foco="iaav-'+esc(n)+'-'+a[0]+'" aria-pressed="'+(on?'true':'false')+'">'+a[1]+'</button>';
    }).join('')+
    '<span class="pvia-ok" role="status">'+(e.aval?'✓ Avaliação registrada.':'')+(e.avalErro?esc(e.avalErro):'')+'</span></div>';
  return h;
}

function corpo(n){
  var e=E[n],h='';
  h+='<div class="pvia-topo"><span class="pvia-tit">Análise por IA</span>'+
    '<button type="button" class="nov-btn pvia-fechar" data-acao="ia-fechar" data-num="'+esc(n)+'" data-foco="iafechar-'+esc(n)+'">Fechar</button></div>';
  if(e.fase==='analisando'){
    h+='<p class="pvia-estado"><span class="gira" aria-hidden="true"></span>Analisando o ato… isso pode levar até um minuto.</p>'+
      '<p><button type="button" class="nov-btn" data-acao="ia-cancelar" data-num="'+esc(n)+'" data-foco="iacancelar-'+esc(n)+'">Cancelar</button></p>';
  }else if(e.fase==='resultado'){
    h+=blocoResultado(n,e);
  }else if(e.fase==='nao_verificada'){
    h+='<p class="pvia-estado">'+esc(NAO_VERIFICADO)+'</p>';
  }else if(e.fase==='recusa'){
    h+='<p class="pvia-estado">'+esc(RECUSAS[e.motivo]||ERRO)+'</p>';
  }else{
    h+='<p class="pvia-estado">'+esc(ERRO)+'</p>'+
      '<p><button type="button" class="nov-btn" data-acao="ia-repetir" data-num="'+esc(n)+'" data-foco="iarepetir-'+esc(n)+'">Tentar de novo</button></p>';
  }
  h+='<p class="pvia-aviso">'+esc(AVISO_FIXO)+'</p>';
  return h;
}

function painelInterno(n){
  return '<div class="pvia" id="pvia-'+esc(n)+'" role="region" aria-label="Análise por IA do processo '+esc(pv().mascara(n))+'" tabindex="-1" data-foco="iap-'+esc(n)+
    '" aria-busy="'+(E[n].fase==='analisando'?'true':'false')+'">'+corpo(n)+'</div>';
}

/* A linha extra logo abaixo do processo, só quando a pessoa abriu o painel. */
function painel(num){
  var n=digitos(num);
  if(!aberto(n))return '';
  return '<tr class="pvia-linha" role="row"><td colspan="9" role="cell">'+painelInterno(n)+'</td></tr>';
}

/* Atualiza o painel no lugar, sem redesenhar a tabela; se ele não está na página, redesenha. */
function refrescar(n,anuncio,foco){
  var el=document.getElementById('pvia-'+n);
  if(el&&el.parentNode){
    var tinhaFoco=el.contains(document.activeElement);
    el.parentNode.innerHTML=painelInterno(n);
    /* Trocar o HTML tira o foco de quem estava dentro: devolve ao botão pedido ou ao painel. */
    var alvo=foco?document.querySelector('#pvia-'+n+' [data-foco="'+foco+'"]'):null;
    if(!alvo&&tinhaFoco)alvo=document.getElementById('pvia-'+n);
    if(alvo)alvo.focus();
  }else L.redesenhar('');
  if(anuncio)L.anunciar(anuncio);
}

function cabecalhos(){
  var h={'content-type':'application/json'},k=pv().chave();
  if(k)h['x-api-key']=k;
  return h;
}

function iniciar(n){
  var e=E[n];
  var ctrl=typeof AbortController!=='undefined'?new AbortController():null;
  e.ctrl=ctrl;e.fase='analisando';e.dados=null;e.aval='';e.avalErro='';
  fetch('/v1/acompanhamentos/'+encodeURIComponent(n)+'/analise',{method:'POST',headers:cabecalhos(),
    body:JSON.stringify({chaveDoAto:e.chave}),signal:ctrl?ctrl.signal:undefined})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(b){return {ok:r.ok,b:b}})})
    .then(function(x){
      if(E[n]!==e||!e.aberto)return;
      e.ctrl=null;
      if(x.ok&&x.b.estado==='verificada'){e.fase='resultado';e.dados=x.b;refrescar(n,'Análise concluída. Confira no ato.');return}
      if(x.ok&&x.b.estado==='nao_verificada'){e.fase='nao_verificada';refrescar(n,NAO_VERIFICADO);return}
      var motivo=x.b&&x.b.detalhes?x.b.detalhes.motivo:'';
      if(!x.ok&&motivo&&RECUSAS[motivo]){e.fase='recusa';e.motivo=motivo;refrescar(n,RECUSAS[motivo]);return}
      e.fase='erro';refrescar(n,ERRO);
    })
    .catch(function(err){
      if(E[n]!==e||!e.aberto)return;
      if(err&&err.name==='AbortError')return;
      e.ctrl=null;e.fase='erro';refrescar(n,ERRO);
    });
}

function fechar(n,anuncio){
  var e=E[n];
  if(!e)return;
  if(e.ctrl){try{e.ctrl.abort()}catch(x){}e.ctrl=null}
  e.aberto=false;
  delete E[n];
  L.redesenhar('ia-'+n);
  if(anuncio)L.anunciar(anuncio);
}

function alternar(num,chave){
  var n=digitos(num);
  if(aberto(n)){fechar(n,'');return}
  E[n]={aberto:true,chave:chave,fase:'analisando',ctrl:null,dados:null,aval:'',avalErro:'',motivo:''};
  iniciar(n);
  L.redesenhar('iap-'+n);
  L.anunciar('Analisando o ato. Isso pode levar até um minuto.');
}

function avaliar(n,valor){
  var e=E[n];
  if(!e||!e.dados||e.ocupadoAval)return;
  e.ocupadoAval=true;e.avalErro='';
  fetch('/v1/analises/'+encodeURIComponent(e.dados.id)+'/avaliacao',{method:'POST',headers:cabecalhos(),
    body:JSON.stringify({avaliacao:valor})})
    .then(function(r){
      e.ocupadoAval=false;
      if(E[n]!==e)return;
      if(r.ok){e.aval=valor;refrescar(n,'Avaliação registrada.','iaav-'+n+'-'+valor);}
      else{e.avalErro='Não foi possível registrar. Tente de novo.';refrescar(n,e.avalErro,'iaav-'+n+'-'+valor);}
    },function(){
      e.ocupadoAval=false;
      if(E[n]!==e)return;
      e.avalErro='Não foi possível registrar. Tente de novo.';refrescar(n,e.avalErro,'iaav-'+n+'-'+valor);
    });
}

function clicar(acao,el){
  var num=el.getAttribute('data-num'),n=digitos(num);
  if(acao==='ia'){alternar(num,el.getAttribute('data-chave'));return}
  if(acao==='ia-fechar'){fechar(n,'');return}
  if(acao==='ia-cancelar'){fechar(n,'Análise cancelada.');return}
  if(acao==='ia-repetir'){
    if(!E[n])return;
    iniciar(n);refrescar(n,'Analisando o ato. Isso pode levar até um minuto.');
    var b=document.getElementById('pvia-'+n);if(b)b.focus();
    return;
  }
  if(acao==='ia-aval'){avaliar(n,el.getAttribute('data-aval'))}
}

/* Esc fecha o painel em que o foco está e devolve o foco ao botão da linha. */
document.addEventListener('keydown',function(ev){
  if(ev.key!=='Escape')return;
  var p=ev.target&&ev.target.closest?ev.target.closest('.pvia'):null;
  if(!p)return;
  var id=p.getAttribute('id')||'';
  var n=id.indexOf('pvia-')===0?id.slice(5):'';
  if(n&&E[n]){ev.preventDefault();fechar(n,E[n].fase==='analisando'?'Análise cancelada.':'')}
});

window.__pvAnaliseIA={carregar:carregar,habilitada:habilitada,ligar:ligar,botao:botao,painel:painel,clicar:clicar};
})();
`;

export const ESTILOS_ANALISE_IA = `
.pvia-btn{display:block;margin-top:6px;max-width:100%;white-space:normal;text-align:center;line-height:1.2;
  min-height:30px;padding:4px 8px;font-size:12px}
.pvia-btn[aria-expanded="true"]{background:var(--acento-bg);border-color:var(--acento)}
.nvt-tabela tr.pvia-linha td{padding:0 8px 14px;border-top:0}
.nvt-tabela tbody tr.nvt-linha:hover + tr.pvia-linha td,.nvt-tabela tbody tr.pvia-linha:hover td{background:transparent}
.pvia{min-width:0;max-width:100%;background:var(--papel2);border:1px solid var(--linha);border-left:4px solid var(--acento);
  border-radius:var(--r);padding:14px 16px;color:var(--tinta);overflow-wrap:anywhere;font-size:13.5px;line-height:1.5}
.pvia:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.pvia-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.pvia-tit{font-weight:700;font-size:14px}
.pvia-estado{margin:6px 0;display:flex;align-items:flex-start;gap:8px}
.pvia-parece{margin:0 0 6px}
.pvia-resumo{margin:0 0 8px}
.pvia-sec{margin:10px 0}
.pvia-rot{display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2);margin-bottom:3px}
.pvia-lista{margin:0;padding-left:18px}
.pvia-vazio{margin:0;color:var(--tinta2)}
.pvia-lista li{margin:0 0 6px}
.pvia-cit{margin:4px 0 0;padding:6px 10px;border-left:3px solid var(--linha);background:var(--papel);color:var(--tinta2);font-style:italic}
.pvia-cit mark{background:var(--atencao-bg);color:var(--tinta);padding:0 2px;border-radius:3px;font-style:normal}
.pvia-proc{display:flex;align-items:flex-start;gap:8px;margin:10px 0 6px;font-size:12.5px;color:var(--tinta2)}
.pvia-selo{flex:none;display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;
  background:var(--acento-bg);color:var(--acento);border:1px solid var(--acento);cursor:help}
.pvia-aval{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-top:8px}
.pvia-aval .pvia-rot{margin:0 4px 0 0}
.pvia-av.on{background:var(--acento-bg);color:var(--acento);border-color:var(--acento);box-shadow:inset 0 0 0 1px var(--acento)}
.pvia-ok{font-size:12.5px;color:var(--verde-tinta);font-weight:700}
.pvia-aviso{margin:10px 0 0;font-size:12.5px;color:var(--tinta2)}
.pvia button:focus-visible,.pvia-btn:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
@media (max-width:1023px){
  .nvt-tabela tr.pvia-linha{display:block;margin:-4px 0 10px}
  .nvt-tabela tr.pvia-linha td{display:block;padding:0}
  .nvt-tabela tr.pvia-linha td::before{content:none}
  .pvia-btn,.pvia .nov-btn{min-height:44px}
}
`;
