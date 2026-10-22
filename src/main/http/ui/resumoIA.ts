import { contar, pluralizar } from '../../../domain/entities/pluralizacao.js';

/**
 * "Resumir este processo com IA" na capa da página do processo (v0.40.1): o botão ao
 * lado de "Deixar de acompanhar", o painel logo abaixo da capa e as duas chamadas à API
 * da 0.40.0, num arquivo só. `script.ts` não cresce (há teste que fixa o tamanho): ele
 * chama `window.__pvResumoIA.aposDesenhar(numero, acompanhado)` ao ligar os botões do
 * detalhe e `sair()` quando a tela deixa de ser a de um processo.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Resumo do processo por IA"):
 * - é APOIO À LEITURA: nada aqui altera "pede providência", "não lida", ordem, contagem,
 *   calendário ou a marcação "providência" do sistema, e NADA é criado (nenhum aviso,
 *   nenhum evento). O aviso fixo diz isso;
 * - o botão só existe para processo ACOMPANHADO e só quando a IA está disponível para a
 *   página (a mesma rota de disponibilidade da análise de ato);
 * - o pedido não leva corpo nenhum: o servidor lê os atos do retrato da conta;
 * - o layout é CONCISO (v0.56.0, prompt `resumo-1.2.0`): faixa do sistema (só quando necessária), situação
 *   (a primeira frase é o ato mais recente lido), o que pede providência (uma linha cada, com a citação recolhida em
 *   "Ver trecho"), "Detalhes" recolhido (o que foi lido, as providências sem leitura, a hora), o aviso fixo e os
 *   polegares. Data e tipo de cada ato vêm do RETRATO, nunca do modelo;
 * - as pendências "segundo a IA" são outra coisa que a marcação "providência" do sistema; quando a IA não leu
 *   uma providência que o sistema marca, a tela NUNCA diz "sem pendências": diz que há providência sem leitura;
 * - a tela não mostra o texto descartado nem a contagem de descartes: havendo descarte, uma linha neutra nos Detalhes;
 * - toda frase de recusa é FIXA aqui — nunca texto do modelo nem do servidor;
 * - NÃO há "reabrir o último resumo": o estado vive na página, só enquanto a pessoa fica
 *   neste processo; sair da tela do processo o apaga;
 * - o rodapé não mostra o modelo (continua gravado em `resumos_ia`);
 * - avaliação por POLEGAR (v0.56.0, `ui/polegares.ts`) no FIM do resultado; os botões Útil / Errado / Perigoso saíram.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc;
 * `tests/http/console-script.spec.ts` roda o ESLint aqui dentro. Todo texto vindo do
 * servidor passa por `esc()`.
 */
export const SCRIPT_RESUMO_IA = String.raw`
(function(){
var pv=function(){return window.__pv};
function esc(s){return pv().esc(s)}
function digitos(n){return String(n||'').replace(/\D/g,'')}

/* Estado do resumo DESTA página de processo; null = nenhum aberto. */
var S=null;

var ATENCAO={
  conferir_prazo_no_processo:'Conferir o prazo no processo.',
  ato_depende_de_outro_documento:'Um ato parece depender de outro documento.',
  texto_incompleto:'O texto de um ato pode estar incompleto.',
  possivel_outro_destinatario:'Uma comunicação pode ser dirigida a outro destinatário.'
};
/* Com o ato de origem (data e rótulo do RETRATO, nunca do modelo) o ponto diz de qual ato fala. */
var ATENCAO_DO_ATO={
  ato_depende_de_outro_documento:'depende de outro documento',
  texto_incompleto:'pode estar com o texto incompleto',
  possivel_outro_destinatario:'pode ser dirigido a outro destinatário',
  conferir_prazo_no_processo:'pede conferir o prazo no processo'
};
var MOTIVO_NAO_LIDO={
  teor_indisponivel:'o tribunal não liberou o texto',
  sem_texto:'sem texto',
  abaixo_do_minimo:'texto curto demais',
  fora_do_limite:'ficou fora do limite do resumo'
};
var RECUSAS={
  sem_plano:'O resumo por IA faz parte do plano IA. Faça upgrade do plano para usar.',
  segredo_de_justica:'Processo em segredo de justiça: o resumo por IA não é feito. Leia os atos.',
  texto_insuficiente:'Este processo não tem atos com texto suficiente para resumir. Leia os atos.',
  limite_de_uso:'Há muitos resumos em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
  nao_acompanhado:'Este processo não está entre os que você acompanha.'
};
var ANALISANDO='Resumindo o processo… isso pode levar até 2 minutos.';
var NAO_VERIFICADO='Não foi possível resumir com segurança. Leia os atos.';
var ERRO='Não foi possível resumir agora. Tente de novo em alguns minutos.';
var AVISO_FIXO='Resumo automático, apoio à leitura. Confira os atos e conte os prazos você mesmo.';
var DESCARTE='Alguns pontos não puderam ser confirmados no texto e foram omitidos.';
var contar=${contar.toString()};
var pluralizar=${pluralizar.toString()};

function cabecalhosSemCorpo(){
  var h={},k=pv().chave();
  if(k)h['x-api-key']=k;
  return h;
}
/* A região ao vivo mora no <body> e nunca é trocada: sobrevive ao redesenho da tela do processo
   e ao fechamento do painel, então o "Resumo cancelado." chega ao leitor de tela. */
function anunciar(t){
  var el=document.getElementById('pvres-live');
  if(!el){
    el=document.createElement('div');
    el.id='pvres-live';el.className='pvres-live';
    el.setAttribute('aria-live','polite');el.setAttribute('role','status');
    document.body.appendChild(el);
  }
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

/* ---------- desenho ---------- */
function rotuloDoAto(a){
  var t=pv().dt(a.data)+' · '+(a.rotulo||'Ato');
  if(a.tipoDaComunicacao&&String(a.tipoDaComunicacao).toLowerCase()!==String(a.rotulo||'').toLowerCase())t+=' · '+a.tipoDaComunicacao;
  return t;
}
/* A citação recolhida: o trecho literal do ato e o caminho até ele na linha do tempo. */
function citacao(i){
  return '<details class="pvres-cit"><summary>Ver trecho</summary>'+
    '<blockquote><mark>'+esc(i.trecho)+'</mark></blockquote>'+
    '<p class="pvres-ato">Ato: <button type="button" class="link" data-pvres="ato" data-quando="'+esc(i.ato.data)+
    '" data-rotulo="'+esc(i.ato.rotulo||'Ato')+'" title="Ir a este ato na linha do tempo">'+esc(rotuloDoAto(i.ato))+'</button></p></details>';
}
/* A data do ato sai do retrato; se o texto já abre com ela, não se repete. */
function quando(i){
  var d=pv().dt(i.ato.data);
  return String(i.texto).indexOf(d)>=0?'':'<span class="pvres-quando">'+esc(d)+'</span> ';
}
function situacaoItem(i){
  return '<li><p class="pvres-texto">'+quando(i)+esc(i.texto)+'</p>'+citacao(i)+'</li>';
}
function pendenciaItem(i){
  return '<li><p class="pvres-texto"><span class="pvres-quando">'+esc(rotuloDoAto(i.ato))+'</span> — '+esc(i.texto)+'</p>'+citacao(i)+'</li>';
}

/* A faixa do SISTEMA (escrita aqui, nunca pelo modelo), só quando necessária: o ato mais recente não foi lido, ou a
   Pasta digital já listou um ato mais novo que o resumo não leu. Com o mais recente lido, não há faixa. */
function faixaHtml(at){
  if(!at||!at.maisRecente)return '';
  var m=at.maisRecente,linhas=[];
  if(!m.lido){
    linhas.push('O ato mais recente ('+esc(pv().dt(m.data))+', '+esc(m.rotulo||'ato')+') não foi lido; confira-o na linha do tempo. '+
      'O que está abaixo vem de atos mais antigos e não é a situação atual.');
  }
  if(at.tribunalMaisNovo){
    var t=at.tribunalMaisNovo;
    linhas.push('A Pasta digital (carregada em '+esc(pv().dt(t.listadaEm))+') lista um ato mais novo, de '+esc(pv().dt(t.data))+
      (t.rotulo?': '+esc(t.rotulo):'')+'. O resumo não o leu; confira-o na linha do tempo.');
  }
  if(!linhas.length)return '';
  return '<section class="pvres-faixa'+(m.lido?'':' pvres-faixa-alerta')+'" aria-label="Aviso do sistema sobre o ato mais recente">'+
    linhas.map(function(l){return '<p class="pvres-faixa-linha">'+l+'</p>'}).join('')+'</section>';
}

/* "Detalhes" (recolhido): o que foi lido, as providências marcadas pelo sistema que a IA não leu, a hora. Sem a
   contagem de descartes: havendo descarte, uma linha neutra. */
function detalhesHtml(d){
  var c=d.contagens,at=d.atualidade,m=at&&at.maisRecente;
  var h='<details class="pvres-det"><summary>Detalhes</summary>';
  var frase='Este resumo usou o texto de '+contar(c.atosComTexto,'ato recente','atos recentes');
  if(m)frase+=m.lido?', entre eles o mais recente ('+esc(pv().dt(m.data))+')':', mas não o mais recente ('+esc(pv().dt(m.data))+')';
  frase+='.';
  var resto=[];
  if(c.atosSoTitulo>0)resto.push(contar(c.atosSoTitulo,'ato tem','atos têm')+' só o título');
  if(c.foraDoResumo>0)resto.push(contar(c.foraDoResumo,'ato não foi lido','atos não foram lidos'));
  if(resto.length)frase+=' '+resto.join(' e ').replace(/^./,function(x){return x.toUpperCase()})+'.';
  h+='<p class="pvres-det-p">'+frase+'</p>';
  if(c.providenciasDoSistema>0){
    h+='<p class="pvres-det-p">Atos que o sistema marca como pedem providência: '+c.providenciasDoSistema+
      ' ('+(c.providenciasDoSistema-c.providenciasNaoCitadas)+' '+pluralizar(c.providenciasDoSistema-c.providenciasNaoCitadas,'citado','citados')+' neste resumo). '+
      'A marcação do sistema é outra coisa e não muda: confira a linha do tempo.</p>';
  }
  if(at&&at.providenciasNaoLidasTotal>0){
    h+='<p class="pvres-det-p">'+esc(contar(at.providenciasNaoLidasTotal,'ato que o sistema marca como pede providência não foi lido','atos que o sistema marca como pedem providência não foram lidos'))+':</p>'+
      '<ul class="pvres-itens-simples">'+at.providenciasNaoLidas.map(function(p){
        return '<li>'+esc(rotuloDoAto(p))+' <span class="pvres-motivo-nl">('+esc(MOTIVO_NAO_LIDO[p.motivo]||'sem leitura')+')</span></li>';
      }).join('')+'</ul>';
    if(at.providenciasNaoLidasTotal>at.providenciasNaoLidas.length)h+='<p class="pvres-nota">E mais '+(at.providenciasNaoLidasTotal-at.providenciasNaoLidas.length)+' na linha do tempo.</p>';
  }
  var pontos=d.pontosDoAto&&d.pontosDoAto.length?d.pontosDoAto:(d.pontosDeAtencao||[]).map(function(x){return {codigo:x,ato:null}});
  if(pontos.length){
    h+='<ul class="pvres-itens-simples">'+pontos.map(function(p){
      if(p.ato&&ATENCAO_DO_ATO[p.codigo])return '<li>O ato de '+esc(rotuloDoAto(p.ato))+' '+ATENCAO_DO_ATO[p.codigo]+'.</li>';
      return '<li>'+esc(ATENCAO[p.codigo]||'')+'</li>';
    }).join('')+'</ul>';
  }
  if(c.itensDescartados>0)h+='<p class="pvres-det-p">'+DESCARTE+'</p>';
  h+='<p class="pvres-det-p">Gerado por IA em '+esc(pv().dth(d.criadaEm))+'.</p></details>';
  return h;
}

function resultadoHtml(d){
  var at=d.atualidade,naoLido=!!(at&&at.maisRecente&&!at.maisRecente.lido);
  var h=faixaHtml(at);
  h+='<section class="pvres-sec"><h4 class="pvres-rot">'+(naoLido?'O que os atos lidos mostram':'Situação')+'</h4><ul class="pvres-itens">'+
    d.situacao.map(situacaoItem).join('')+'</ul></section>';
  h+='<section class="pvres-sec pvres-pend"><h4 class="pvres-rot">O que pede providência</h4>';
  if(d.pendencias.length)h+='<ul class="pvres-itens">'+d.pendencias.map(pendenciaItem).join('')+'</ul>';
  else if(at&&at.providenciasNaoLidasTotal>0){
    h+='<p class="pvres-vazio">'+esc(contar(at.providenciasNaoLidasTotal,'ato que o sistema marca como pede providência não foi lido','atos que o sistema marca como pedem providência não foram lidos'))+
      '. Veja em Detalhes e confira na linha do tempo.</p>';
  }
  else h+='<p class="pvres-vazio">Nenhuma providência indicada nos atos lidos.</p>';
  h+='</section>';
  h+=detalhesHtml(d);
  h+='<p class="pvres-nota" id="pvres-nota-ato" role="status"></p>';
  h+='<p class="pvres-aviso">'+esc(AVISO_FIXO)+'</p>';
  if(window.__pvPolegares)h+=window.__pvPolegares.html('resumo',d.id,d.avaliacao);
  return h;
}

function corpo(){
  var h='<div class="pvres-topo"><h3 class="pvres-tit">Resumo do processo por IA</h3>'+
    (S.fase==='analisando'?'':'<button type="button" class="nov-btn" data-pvres="fechar" id="pvres-fechar">Fechar</button>')+'</div>';
  if(S.fase==='analisando'){
    h+='<p class="pvres-estado"><span class="gira" aria-hidden="true"></span>'+ANALISANDO+'</p>'+
      '<p><button type="button" class="nov-btn" data-pvres="cancelar" id="pvres-cancelar">Cancelar</button></p>';
  }else if(S.fase==='resultado'){
    h+=resultadoHtml(S.dados);
  }else if(S.fase==='nao_verificado'){
    h+='<p class="pvres-estado">'+esc(NAO_VERIFICADO)+'</p>';
  }else if(S.fase==='recusa'&&S.motivo==='sem_plano'&&window.__pvAnaliseIA){
    h+=window.__pvAnaliseIA.semPlano(RECUSAS.sem_plano,'pvres-estado');
  }else if(S.fase==='recusa'){
    h+='<p class="pvres-estado">'+esc(RECUSAS[S.motivo]||ERRO)+'</p>';
  }else{
    h+='<p class="pvres-estado">'+esc(ERRO)+'</p>'+
      '<p><button type="button" class="nov-btn" data-pvres="repetir" id="pvres-repetir">Tentar de novo</button></p>';
  }
  return S.fase==='resultado'?h:h+'<p class="pvres-aviso">'+esc(AVISO_FIXO)+'</p>';
}

function painelInterno(){
  return '<div class="pvres" id="pvres-painel" role="region" aria-label="Resumo do processo por IA" tabindex="-1" aria-busy="'+
    (S.fase==='analisando'?'true':'false')+'">'+corpo()+'</div>';
}

function marcarBotao(){
  var b=document.getElementById('pvres-abrir');
  if(b)b.setAttribute('aria-expanded',S?'true':'false');
}

/* O painel mora numa raiz logo depois da capa; a raiz só é trocada quando a tela é redesenhada. */
function montarRaiz(){
  var capa=document.querySelector('#conteudo .capa');
  if(!capa||!S)return false;
  var raiz=document.getElementById('pvres-raiz');
  if(!raiz){
    raiz=document.createElement('div');
    raiz.id='pvres-raiz';
    raiz.innerHTML='<div id="pvres-corpo"></div>';
    capa.insertAdjacentElement('afterend',raiz);
  }
  document.getElementById('pvres-corpo').innerHTML=painelInterno();
  marcarBotao();
  return true;
}

function refrescar(anuncio,foco){
  var corpoEl=document.getElementById('pvres-corpo');
  if(!corpoEl){marcarBotao();return}
  var painel=document.getElementById('pvres-painel');
  var tinhaFoco=painel&&painel.contains(document.activeElement);
  corpoEl.innerHTML=painelInterno();
  var alvo=foco?document.getElementById(foco):null;
  if(!alvo&&tinhaFoco)alvo=document.getElementById('pvres-painel');
  if(alvo)alvo.focus();
  if(anuncio)anunciar(anuncio);
}

function remover(){
  var raiz=document.getElementById('pvres-raiz');
  if(raiz&&raiz.parentNode)raiz.parentNode.removeChild(raiz);
}

/* ---------- chamadas ---------- */
function iniciar(){
  var e=S;
  var ctrl=typeof AbortController!=='undefined'?new AbortController():null;
  e.ctrl=ctrl;e.fase='analisando';e.dados=null;e.motivo='';
  fetch('/v1/acompanhamentos/'+encodeURIComponent(e.numero)+'/resumo',{method:'POST',headers:cabecalhosSemCorpo(),
    signal:ctrl?ctrl.signal:undefined})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(b){return {ok:r.ok,status:r.status,b:b}})})
    .then(function(x){
      if(S!==e)return;
      e.ctrl=null;
      if(x.ok&&x.b.estado==='verificado'){
        e.fase='resultado';e.dados=x.b;
        var am=x.b.atualidade&&x.b.atualidade.maisRecente;
        refrescar(am&&!am.lido?'Resumo concluído. Atenção: o ato mais recente não foi lido. Confira na linha do tempo.':'Resumo concluído. Confira nos atos.');return}
      if(x.ok&&x.b.estado==='nao_verificado'){e.fase='nao_verificado';refrescar(NAO_VERIFICADO);return}
      var motivo=x.b&&x.b.detalhes?x.b.detalhes.motivo:'';
      if(!x.ok&&motivo&&RECUSAS[motivo]){
        e.fase='recusa';e.motivo=motivo;
        refrescar(motivo==='sem_plano'&&window.__pvAnaliseIA?window.__pvAnaliseIA.textoSemPlano(RECUSAS.sem_plano):RECUSAS[motivo]);return}
      if(!x.ok&&x.status===404){e.fase='recusa';e.motivo='nao_acompanhado';refrescar(RECUSAS.nao_acompanhado);return}
      e.fase='erro';refrescar(ERRO);
    })
    .catch(function(err){
      if(S!==e)return;
      if(err&&err.name==='AbortError')return;
      e.ctrl=null;e.fase='erro';refrescar(ERRO);
    });
}

/* ---------- abrir, fechar, sair ---------- */
function descartar(){
  if(S&&S.ctrl){try{S.ctrl.abort()}catch(x){}}
  S=null;
  remover();
  marcarBotao();
}

function fechar(anuncio){
  descartar();
  var b=document.getElementById('pvres-abrir');
  if(b)b.focus();
  if(anuncio)anunciar(anuncio);
}

function abrirResumo(numero){
  if(S){fechar('');return}
  S={numero:digitos(numero),fase:'analisando',ctrl:null,dados:null,motivo:''};
  montarRaiz();
  iniciar();
  refrescar('Resumindo o processo. Isso pode levar até 2 minutos.','pvres-painel');
}

/* Leva à linha do tempo: o andamento com a mesma data e o mesmo rótulo. Se ele não estiver na
   tela (recolhido entre os internos ou num filtro), a tela diz isso em vez de rolar para lugar nenhum. */
function irAoAto(quando,rotulo){
  var alvo=null,candidatos=document.querySelectorAll('#conteudo .ev[data-quando]');
  var t=new Date(quando).getTime();
  for(var i=0;i<candidatos.length;i++){
    var c=candidatos[i];
    if(new Date(c.getAttribute('data-quando')).getTime()!==t)continue;
    var tt=c.querySelector('.tt');
    if(!alvo)alvo=c;
    if(tt&&tt.textContent.trim().indexOf(rotulo)===0){alvo=c;break}
  }
  var nota=document.getElementById('pvres-nota-ato');
  if(!alvo){
    var msg='O ato “'+rotulo+'” de '+pv().dt(quando)+' não está visível na linha do tempo — pode estar recolhido entre os internos ou num filtro.';
    if(nota)nota.textContent=msg;
    return;
  }
  if(nota)nota.textContent='';
  alvo.classList.add('pvres-alvo');alvo.setAttribute('tabindex','-1');
  alvo.scrollIntoView({block:'center'});alvo.focus();
  alvo.addEventListener('blur',function(){alvo.classList.remove('pvres-alvo')},{once:true});
}

/* ---------- ganchos do console ---------- */
function aposDesenhar(numero,acompanhado){
  var n=digitos(numero);
  /* Outro processo: o resumo do anterior não acompanha (e não há "reabrir"). */
  if(S&&S.numero!==n)descartar();
  if(!acompanhado)return;
  var ia=window.__pvAnaliseIA;
  if(!ia)return;
  ia.carregar().then(function(ligada){
    if(!ligada)return;
    var capa=document.querySelector('#conteudo .capa'),parar=document.getElementById('parar');
    var num=capa?capa.querySelector('.num'):null;
    if(!capa||!parar||!num||digitos(num.textContent)!==n)return;
    if(document.getElementById('pvres-abrir'))return;
    var b=document.createElement('button');
    b.type='button';b.className='bt bt2 pvres-btn';b.id='pvres-abrir';
    b.setAttribute('aria-controls','pvres-painel');b.setAttribute('aria-expanded','false');
    b.title='Gera um resumo do processo por IA. Apoio à leitura: confira sempre nos atos.';
    b.textContent='Resumir este processo com IA';
    parar.insertAdjacentElement('afterend',b);
    b.addEventListener('click',function(){abrirResumo(n)});
    /* A tela foi redesenhada (régua carregada) com o resumo já em curso: devolve o painel. */
    if(S&&S.numero===n){montarRaiz()}
  });
}
function sair(){if(S||document.getElementById('pvres-raiz'))descartar()}

document.addEventListener('click',function(ev){
  var el=ev.target&&ev.target.closest?ev.target.closest('[data-pvres]'):null;
  if(!el||!S)return;
  var acao=el.getAttribute('data-pvres');
  if(acao==='fechar'){fechar('');return}
  if(acao==='cancelar'){fechar('Resumo cancelado.');return}
  if(acao==='repetir'){iniciar();refrescar('Resumindo o processo. Isso pode levar até 2 minutos.','pvres-painel');return}
  if(acao==='ato'){irAoAto(el.getAttribute('data-quando'),el.getAttribute('data-rotulo'));return}
});

/* Esc fecha o painel em que o foco está (e cancela, se estiver resumindo). */
document.addEventListener('keydown',function(ev){
  if(ev.key!=='Escape'||!S)return;
  var p=ev.target&&ev.target.closest?ev.target.closest('#pvres-painel'):null;
  if(!p)return;
  ev.preventDefault();
  fechar(S.fase==='analisando'?'Resumo cancelado.':'');
});

window.__pvResumoIA={aposDesenhar:aposDesenhar,sair:sair};
})();
`;

export const ESTILOS_RESUMO_IA = `
.pvres-btn[aria-expanded="true"]{background:var(--acento-bg);border-color:var(--acento)}
.pvres-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
#pvres-raiz{margin:0 0 14px}
.pvres{min-width:0;max-width:100%;background:var(--papel2);border:1px solid var(--linha);border-left:4px solid var(--acento);
  border-radius:var(--r);padding:14px 16px;color:var(--tinta);overflow-wrap:anywhere;font-size:13.5px;line-height:1.5}
.pvres:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.pvres-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.pvres-tit{margin:0;font-size:15px;font-weight:700}
.pvres-estado{margin:6px 0;display:flex;align-items:flex-start;gap:8px}
.pvres-sec{margin:12px 0}
.pvres-rot{display:block;margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2)}
.pvres-itens{margin:0;padding:0;list-style:none}
.pvres-itens>li{margin:0 0 8px;padding:0 0 8px;border-bottom:1px solid var(--linha)}
.pvres-itens>li:last-child{border-bottom:0;margin-bottom:0}
.pvres-itens-simples{margin:0;padding-left:18px}
.pvres-texto{margin:0 0 4px;font-weight:600}
.pvres-ato{margin:0 0 4px;color:var(--tinta2);font-size:12.5px}
.pvres-ato .link{font-size:12.5px;text-align:left;overflow-wrap:anywhere}
.pvres-cit blockquote{margin:4px 0 0;padding:6px 10px;border-left:3px solid var(--linha);background:var(--papel);color:var(--tinta2);font-style:italic}
.pvres-cit mark{background:var(--atencao-bg);color:var(--tinta);padding:0 2px;border-radius:3px;font-style:normal}
.pvres-faixa{margin:10px 0;padding:8px 12px;border:1px solid var(--linha);border-radius:var(--r);background:var(--papel)}
.pvres-faixa-alerta{border-left:4px solid var(--atencao);background:var(--atencao-bg)}
.pvres-faixa-linha{margin:0 0 6px}
.pvres-faixa-linha:last-child{margin-bottom:0}
.pvres-motivo-nl{color:var(--tinta2)}
.pvres-quando{color:var(--tinta2);font-weight:700;font-size:12.5px}
.pvres-cit{margin:2px 0 0}
.pvres-cit summary{cursor:pointer;color:var(--tinta2);font-size:12.5px}
.pvres-det{margin:10px 0 0}
.pvres-det summary{cursor:pointer;font-weight:700;font-size:12.5px;color:var(--tinta2)}
.pvres-det-p{margin:6px 0 0;font-size:12.5px;color:var(--tinta2)}
.pvres-det summary:focus-visible,.pvres-cit summary:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.pvres-nota{margin:0 0 6px;font-size:12.5px;color:var(--tinta2)}
.pvres-vazio{margin:0;color:var(--tinta2)}
.pvres-aviso{margin:10px 0 0;font-size:12.5px;color:var(--tinta2)}
.pvres button:focus-visible,.pvres-btn:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.ev.pvres-alvo{outline:2px solid var(--acento);outline-offset:3px;border-radius:var(--r)}
@media (max-width:1023px){
  .pvres-btn,.pvres .nov-btn{min-height:44px}
}
`;
