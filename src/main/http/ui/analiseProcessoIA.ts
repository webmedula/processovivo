import { pecasPrincipais } from './pecasPrincipais.js';

/**
 * Tela da análise do PROCESSO pelas peças (v0.66.0), em módulo próprio (`window.__pvProcessoIA`):
 * `script.ts` não cresce, e a Pasta digital só ganhou o botão e dois ganchos, como o Drive:
 * - `ligarPasta({ numero, marcadas, pecas, marcar })`: liga o botão que a Pasta desenhou;
 * - `selecaoMudou()`: a Pasta avisa quando as marcadas mudam (o rótulo do botão diz o número).
 *
 * O que sustenta a tela (CLAUDE.md §8, "Análise do processo pelas peças"):
 * - **o botão só existe para conta liberada**: `GET /v1/analises-do-processo/disponibilidade` diz
 *   `liberado`; falha de rede = sem botão;
 * - **nada é enviado sem confirmar**: o diálogo mostra a estimativa (quantas peças, quantas já analisadas,
 *   quantas vão ao tribunal, quantas sob sigilo ficam de fora, o peso máximo no limite do dia) e só o
 *   botão "Analisar" começa. O atalho "Marcar peças principais" só MARCA, e não marca laudo;
 * - **toda frase é FIXA aqui**, nunca texto do servidor ou do modelo;
 * - o progresso diz a peça da vez e tem Cancelar; três falhas seguidas de consulta param a consulta;
 * - o resultado separa os sete blocos e cada item mostra de que peça e página veio, com o trecho copiado
 *   do resultado verificado da peça (o modelo da síntese não escreve citação);
 * - o diálogo é `role="dialog"` modal: foco no título ao abrir, Tab preso dentro, Esc fecha e o foco
 *   volta ao botão. O estado do job vive na página: fechar e reabrir a Pasta reata o progresso.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc; o
 * `console-script.spec.ts` roda o ESLint aqui dentro. Todo dado vem por `esc()`.
 */
export const SCRIPT_ANALISE_PROCESSO_IA = String.raw`
(function(){
var LIMITE=20;
var POLL_MS=1500;
var ERROS_SEGUIDOS_QUE_PARAM=3;
var pecasPrincipais=${pecasPrincipais.toString()};

var AVISO_FIXO='Análise automática das peças escolhidas, apoio à leitura. Não avalia mérito nem conta prazo. Confira nas peças.';
var SEM_PLANO='A análise por IA faz parte do plano IA. Faça upgrade do plano para usar.';
var ERRO='Não foi possível concluir agora. Tente de novo.';
var PAROU='Não foi possível acompanhar a análise. Feche e abra de novo para ver o andamento.';
var RECUSAS={
  indisponivel:'Este recurso não está disponível para a sua conta.',
  desligada:'Este recurso está indisponível no momento.',
  processo_sigiloso:'Processo sob segredo de justiça: a análise por IA não se aplica.',
  tribunal_nao_suportado:'Por enquanto, a análise das peças vale só para o TJGO.',
  selecao_invalida:'Marque de 2 a 20 peças do processo.',
  limite_de_uso:'Já há uma análise em andamento ou muitas análises na última hora. Tente de novo mais tarde.',
  nao_encontrada:'Esta análise não está mais disponível. Comece de novo.'
};
var LISTAGEM='Carregue as peças do processo e tente de novo.';
var NAO_ACOMPANHA='Acompanhe este processo para analisar as peças com IA.';
var FORA={
  peca_sigilosa:'peça sob sigilo',
  processo_sigiloso:'processo sob segredo de justiça',
  sem_texto:'sem texto pesquisável (imagem escaneada)',
  acima_de_40_paginas:'mais de 40 páginas',
  acima_de_80_mil_caracteres:'texto longo demais',
  pdf_invalido:'arquivo que não abre',
  pdf_protegido:'arquivo protegido',
  arquivo_grande:'arquivo grande demais',
  limite_diario:'limite de análises de hoje atingido',
  limite_de_uso:'muitas análises seguidas',
  nao_verificada:'a leitura não passou na verificação',
  nao_obtida:'o tribunal não entregou o arquivo',
  credencial:'acesso ao tribunal recusado',
  bloqueio_do_tribunal:'tribunal em pausa',
  tempo_esgotado:'o tribunal demorou demais',
  cancelada:'análise cancelada',
  tribunal_nao_suportado:'tribunal não suportado',
  peca_nao_encontrada:'peça fora da lista do processo'
};
var SEM_SINTESE={
  poucas_pecas:'Menos de duas peças puderam ser lidas: não há o que cruzar. Veja abaixo o que as peças lidas trouxeram.',
  limite_diario:'O limite de análises de hoje acabou antes do cruzamento. As peças já lidas não contam de novo: tente amanhã.',
  erro:'Não foi possível cruzar as peças agora. Tente de novo.'
};
var NAO_VERIFICADA='Não foi possível cruzar as peças com segurança. Leia as peças.';
var ESTADO_DA_PECA={aguardando:'na fila',baixando:'buscando no tribunal',lendo:'lendo',lida:'lida',
  reaproveitada:'já analisada',fora:'ficou de fora'};

var ctx=null;
var liberado=null;
/* Um job por página, preso ao número do processo. */
var job=null;
var timer=null;
var anterior=null;
var estimativa=null;
var recusa='';
var ocupado=false;

function pv(){return window.__pv}
function esc(s){return pv().esc(s)}
function $(i){return document.getElementById(i)}
function digitos(n){return String(n||'').replace(/\D/g,'')}
function botao(){return $('pasta-proc-ia-bt')}
function contar(n,um,muitos){return n+' '+(n===1?um:muitos)}

function anunciar(t){
  var el=$('pvpr-live');
  if(!el){
    el=document.createElement('div');
    el.id='pvpr-live';el.className='pvpr-live';
    el.setAttribute('aria-live','polite');el.setAttribute('role','status');
    document.body.appendChild(el);
  }
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

function carregar(){
  if(liberado!==null)return Promise.resolve(liberado);
  return pv().api('/v1/analises-do-processo/disponibilidade')
    .then(function(r){liberado=!!(r&&r.liberado);return liberado})
    .catch(function(){return false});
}

function ligarPasta(c){
  ctx=c;
  var b=botao();
  if(!b)return;
  b.addEventListener('click',abrir);
  carregar().then(function(ok){
    var b2=botao();
    if(!b2||!ok)return;
    b2.hidden=false;
    selecaoMudou();
  });
}

function selecaoMudou(){
  var b=botao();
  if(!b||!ctx)return;
  var n=ctx.marcadas().length;
  b.textContent=n?'Analisar processo com IA ('+n+')':'Analisar processo com IA';
  if(dialogo()&&!job)pedirEstimativa();
}

/* ---------- diálogo ---------- */
function dialogo(){return $('pvpr')}
function abrir(){
  if(!ctx)return;
  anterior=document.activeElement;
  var d=dialogo();
  if(!d){
    d=document.createElement('div');
    d.id='pvpr';d.className='pvpr-fundo';
    d.innerHTML='<div class="pvpr" role="dialog" aria-modal="true" aria-labelledby="pvpr-tit">'+
      '<div class="pvpr-topo"><h2 class="pvpr-tit" id="pvpr-tit" tabindex="-1">Análise do processo com IA</h2>'+
      '<button type="button" class="bt bt2" id="pvpr-fechar">Fechar</button></div>'+
      '<div class="pvpr-corpo" id="pvpr-corpo"></div></div>';
    document.body.appendChild(d);
    $('pvpr-fechar').addEventListener('click',fechar);
    d.addEventListener('keydown',teclar);
    d.addEventListener('click',clicar);
  }
  if(job&&job.numero!==digitos(ctx.numero())){pararPoll();job=null}
  recusa='';estimativa=null;
  if(job)acompanhar();else pedirEstimativa();
  desenhar();
  $('pvpr-tit').focus();
}
function fechar(){
  pararPoll();
  var d=dialogo();
  if(d)d.parentNode.removeChild(d);
  var volta=(anterior&&document.body.contains(anterior))?anterior:botao();
  if(volta&&volta.focus)volta.focus();
}
function teclar(e){
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();fechar();return}
  if(e.key!=='Tab')return;
  var f=Array.prototype.filter.call(dialogo().querySelectorAll('button,summary,[href],input,[tabindex="0"]'),
    function(x){return !x.disabled&&x.offsetParent!==null});
  if(!f.length)return;
  var prim=f[0],ult=f[f.length-1];
  if(e.shiftKey&&(document.activeElement===prim||document.activeElement===$('pvpr-tit'))){e.preventDefault();ult.focus()}
  else if(!e.shiftKey&&document.activeElement===ult){e.preventDefault();prim.focus()}
}
function clicar(e){
  var alvo=e.target.closest?e.target.closest('[data-pvpr]'):null;
  if(!alvo)return;
  var acao=alvo.getAttribute('data-pvpr');
  if(acao==='principais'){
    var ids=pecasPrincipais(ctx.pecas(),LIMITE);
    ctx.marcar(ids);
    anunciar(ids.length?contar(ids.length,'peça marcada','peças marcadas')+'.':'Nenhuma peça principal encontrada na lista.');
  }else if(acao==='iniciar')iniciar();
  else if(acao==='cancelar')cancelar();
  else if(acao==='nova'){job=null;recusa='';pedirEstimativa();desenhar()}
}

/* ---------- estimativa e início ---------- */
function pedirEstimativa(){
  var ids=ctx.marcadas();
  estimativa=null;recusa='';
  if(ids.length<2||ids.length>LIMITE){desenhar();return}
  var pedido=ids.join(',');
  pv().api('/v1/processos/'+encodeURIComponent(ctx.numero())+'/analise-do-processo/estimativa',
    {method:'POST',body:{pecas:ids}})
    .then(function(r){if(ctx.marcadas().join(',')!==pedido)return;estimativa=r;desenhar()})
    .catch(function(e){if(ctx.marcadas().join(',')!==pedido)return;recusa=fraseDoErro(e);desenhar()});
}
function iniciar(){
  if(ocupado)return;
  var ids=ctx.marcadas();
  ocupado=true;recusa='';desenhar();
  pv().api('/v1/processos/'+encodeURIComponent(ctx.numero())+'/analise-do-processo',{method:'POST',body:{pecas:ids}})
    .then(function(v){ocupado=false;job={id:v.id,numero:digitos(ctx.numero()),visao:v,erros:0};
      anunciar('Análise do processo começou.');acompanhar()})
    .catch(function(e){ocupado=false;recusa=fraseDoErro(e);desenhar()});
}
function cancelar(){
  if(!job)return;
  pv().api('/v1/analises-do-processo/'+encodeURIComponent(job.id),{method:'DELETE'})
    .then(function(v){if(job){job.visao=v;desenhar()}})
    .catch(function(){});
}
function fraseDoErro(e){
  var m=e&&e.detalhes&&e.detalhes.motivo;
  if(m==='sem_plano')return 'sem_plano';
  if(m&&RECUSAS[m])return RECUSAS[m];
  if(e&&e.codigo==='ACOMPANHAMENTO_NAO_ENCONTRADO')return NAO_ACOMPANHA;
  if(e&&e.codigo==='LISTAGEM_DA_PASTA_AUSENTE')return LISTAGEM;
  return ERRO;
}

/* ---------- progresso ---------- */
function pararPoll(){if(timer){clearTimeout(timer);timer=null}}
function terminou(v){return v&&(v.fase==='concluida'||v.fase==='falhou'||v.fase==='cancelada')}
function acompanhar(){
  pararPoll();
  if(!job)return;
  desenhar();
  if(terminou(job.visao))return;
  timer=setTimeout(function(){
    timer=null;
    if(!job||!dialogo())return;
    var este=job;
    pv().api('/v1/analises-do-processo/'+encodeURIComponent(este.id))
      .then(function(v){
        if(job!==este)return;
        este.erros=0;este.visao=v;
        if(terminou(v)){anunciar(v.fase==='concluida'?'Análise do processo pronta.':'Análise do processo encerrada.');desenhar();
          var t=$('pvpr-tit');if(t)t.focus();return}
        acompanhar();
      })
      .catch(function(e){
        if(job!==este)return;
        if(e&&e.status===404){este.visao={fase:'falhou',motivo:'nao_encontrada',pecas:[],total:0,concluidas:0,resultado:null};desenhar();return}
        este.erros++;
        if(este.erros>=ERROS_SEGUIDOS_QUE_PARAM){este.parou=true;desenhar();return}
        acompanhar();
      });
  },POLL_MS);
}

/* ---------- desenho ---------- */
function desenhar(){
  var c=$('pvpr-corpo');
  if(!c)return;
  c.innerHTML=job?(job.visao&&job.visao.fase==='concluida'&&job.visao.resultado?resultado(job.visao):progresso(job)):escolha();
  c.setAttribute('aria-busy',job&&!terminou(job.visao)?'true':'false');
}

function escolha(){
  var n=ctx.marcadas().length;
  var h='<p class="pvpr-nota">Escolha na lista as peças que a IA vai ler, de 2 a '+LIMITE+'. Cada peça é analisada e, depois, '+
    'as análises são cruzadas. Nada é enviado sem você confirmar.</p>'+
    '<p><button type="button" class="bt bt2" data-pvpr="principais">Marcar peças principais</button> '+
    '<span class="pvpr-nota">petição inicial, contestação, réplica, decisões e recursos; o laudo não entra no atalho.</span></p>';
  if(recusa==='sem_plano'){
    var ia=window.__pvAnaliseIA;
    return h+(ia?ia.semPlano(SEM_PLANO,'pvpr-falha'):'<p class="pvpr-falha">'+esc(SEM_PLANO)+'</p>');
  }
  if(recusa)return h+'<p class="pvpr-falha" role="alert">'+esc(recusa)+'</p>';
  if(n<2)return h+'<p class="pvpr-estado">'+(n?'Marque pelo menos mais uma peça.':'Nenhuma peça marcada.')+'</p>';
  if(n>LIMITE)return h+'<p class="pvpr-falha">'+contar(n,'peça marcada','peças marcadas')+'. Marque no máximo '+LIMITE+'.</p>';
  if(!estimativa)return h+'<p class="pvpr-estado"><span class="gira"></span>Conferindo as peças marcadas…</p>';
  var e=estimativa,lidas=e.total-e.sigilosas;
  h+='<ul class="pvpr-est">'+
    '<li>'+contar(e.total,'peça marcada','peças marcadas')+'</li>'+
    (e.jaAnalisadas?'<li>'+contar(e.jaAnalisadas,'já analisada (não conta de novo)','já analisadas (não contam de novo)')+'</li>':'')+
    (e.aBuscarNoTribunal?'<li>'+contar(e.aBuscarNoTribunal,'será buscada no tribunal','serão buscadas no tribunal')+'</li>':'')+
    (e.sigilosas?'<li>'+contar(e.sigilosas,'sob sigilo fica de fora','sob sigilo ficam de fora')+'</li>':'')+
    '<li>Conta até '+e.pesoMaximo+' no limite de análises de hoje.</li></ul>';
  if(lidas<2)return h+'<p class="pvpr-falha">Sobram menos de duas peças que podem ser lidas.</p>';
  return h+'<p><button type="button" class="bt" data-pvpr="iniciar"'+(ocupado?' disabled':'')+'>'+
    (ocupado?'<span class="gira"></span>Começando…':'Analisar '+contar(lidas,'peça','peças'))+'</button></p>';
}

function progresso(j){
  var v=j.visao||{fase:'pecas',pecas:[],total:0,concluidas:0};
  var h='';
  if(v.fase==='falhou'||v.fase==='cancelada'){
    var m=v.motivo;
    h+='<p class="pvpr-falha" role="alert">'+(v.fase==='cancelada'?'Análise cancelada.':
      m==='sem_plano'?esc(SEM_PLANO):esc(RECUSAS[m]||ERRO))+'</p>'+
      '<p><button type="button" class="bt bt2" data-pvpr="nova">Escolher de novo</button></p>';
  }else if(j.parou){
    h+='<p class="pvpr-falha" role="alert">'+esc(PAROU)+'</p>';
  }else{
    var etapa=v.fase==='sintese'?'Cruzando as análises das peças…':
      'Lendo as peças: '+v.concluidas+' de '+v.total+'.';
    h+='<p class="pvpr-estado"><span class="gira"></span>'+esc(etapa)+'</p>'+
      '<p class="pvpr-nota">Pode levar alguns minutos. Você pode fechar esta janela: a análise continua.</p>'+
      '<p><button type="button" class="bt bt2" data-pvpr="cancelar">Cancelar</button></p>';
  }
  h+='<ol class="pvpr-pecas">'+(v.pecas||[]).map(function(p){
    return '<li><span class="pvpr-rot">'+esc(p.rotulo)+'</span> <span class="pvpr-pe pvpr-pe-'+esc(p.estado)+'">'+
      esc(ESTADO_DA_PECA[p.estado]||'')+(p.estado==='fora'&&p.motivo?': '+esc(FORA[p.motivo]||'não foi possível ler'):'')+'</span></li>';
  }).join('')+'</ol>';
  return h;
}

function fonte(f){
  var onde=esc(f.rotulo)+(f.data?' ('+esc(pv().dt(f.data))+')':'')+(f.pagina?', pág. '+esc(f.pagina):'');
  if(!f.trecho)return '<span class="pvpr-fonte">'+onde+'</span>';
  return '<details class="pvpr-cit"><summary>Ver trecho · '+onde+'</summary><blockquote>'+esc(f.trecho)+'</blockquote></details>';
}
function fontes(lista){return (lista||[]).map(fonte).join('')}
function item(it){return '<p class="pvpr-texto">'+esc(it.texto)+'</p>'+fontes(it.fontes)}
function secao(id,titulo,conteudo){
  return '<section class="pvpr-sec" aria-labelledby="pvpr-s-'+id+'"><h3 class="pvpr-h" id="pvpr-s-'+id+'">'+titulo+'</h3>'+conteudo+'</section>';
}
function lista(itens,vazio){
  if(!itens||!itens.length)return '<p class="pvpr-nota">'+vazio+'</p>';
  return '<ul class="pvpr-itens">'+itens.map(function(i){return '<li>'+item(i)+'</li>'}).join('')+'</ul>';
}

function resultado(v){
  var r=v.resultado,s=r.sintese;
  var h='';
  if(r.semSintese)h+='<p class="pvpr-falha">'+esc(SEM_SINTESE[r.semSintese]||ERRO)+'</p>';
  else if(s&&s.estado!=='verificada')h+='<p class="pvpr-falha">'+esc(NAO_VERIFICADA)+'</p>';
  var ok=s&&s.estado==='verificada';
  var partes=(r.partes.autores.length||r.partes.reus.length)?
    '<p class="pvpr-texto">'+esc(r.partes.autores.join(', ')||'—')+' × '+esc(r.partes.reus.join(', ')||'—')+'</p>':'';
  h+=secao('quadro','Quadro do caso',
    (ok&&s.objeto?item(s.objeto):'')+
    (r.classe?'<p class="pvpr-nota">Classe: '+esc(r.classe)+'</p>':'')+partes);
  if(ok){
    h+=secao('pedidos','Pedidos, defesa e decisões',!s.pedidos.length?'<p class="pvpr-nota">Nenhum pedido verificado nas peças lidas.</p>':
      '<ul class="pvpr-itens">'+s.pedidos.map(function(p){
        return '<li>'+item(p)+
          '<div class="pvpr-sub"><span class="pvpr-r">Defesa</span>'+(p.defesa?item(p.defesa):'<p class="pvpr-nota">As peças lidas não falam disso.</p>')+'</div>'+
          '<div class="pvpr-sub"><span class="pvpr-r">Decisão</span>'+(p.decisao?item(p.decisao):'<p class="pvpr-nota">As peças lidas não falam disso.</p>')+'</div></li>';
      }).join('')+'</ul>');
    h+=secao('linha','Linha do tempo das teses',lista(s.linhaDoTempo,'Nada verificado para a linha do tempo.'));
    h+=secao('controv','Pontos controvertidos',lista(s.controvertidos,'Nenhum ponto em que as peças lidas divirjam.'));
  }
  h+=secao('determ','O que o juízo determinou',!r.determinacoes.length?'<p class="pvpr-nota">Nenhuma determinação nas peças lidas.</p>':
    '<ul class="pvpr-itens">'+r.determinacoes.map(function(d){
      return '<li><p class="pvpr-texto">'+esc(d.quem)+': '+esc(d.texto)+'</p>'+
        (d.prazo?'<p class="pvpr-nota">Prazo escrito no ato: '+esc(d.prazo)+'</p>':'')+fonte(d.fonte)+'</li>';
    }).join('')+'</ul>');
  var docs=r.documentos.map(function(d){return '<li><p class="pvpr-texto">'+esc(d.nome)+'</p>'+fonte(d.fonte)+'</li>'}).join('');
  var vals=r.valores.map(function(x){return '<li><p class="pvpr-texto">'+esc(x.valor)+' · '+esc(x.contexto)+'</p>'+fonte(x.fonte)+'</li>'}).join('');
  h+=secao('docs','Documentos e valores',(docs||vals)?'<ul class="pvpr-itens">'+docs+vals+'</ul>':
    '<p class="pvpr-nota">Nenhum documento ou valor citado nas peças lidas.</p>');
  var fora=(v.pecas||[]).filter(function(p){return p.estado==='fora'});
  h+=secao('fora','O que ficou de fora',(fora.length?'<ul class="pvpr-itens-simples">'+fora.map(function(p){
      return '<li>'+esc(p.rotulo)+': '+esc(FORA[p.motivo]||'não foi possível ler')+'</li>'}).join('')+'</ul>':
      '<p class="pvpr-nota">Todas as peças escolhidas foram lidas.</p>')+
    '<p class="pvpr-nota">Só entram as peças escolhidas. O que não está nelas não aparece aqui.</p>');
  h+='<p class="pvpr-aviso">'+esc(AVISO_FIXO)+'</p>';
  if(s&&window.__pvPolegares)h+=window.__pvPolegares.html('processo',s.id,s.avaliacao);
  h+='<p><button type="button" class="bt bt2" data-pvpr="nova">Nova análise</button></p>';
  return h;
}

window.__pvProcessoIA={ligarPasta:ligarPasta,selecaoMudou:selecaoMudou,pecasPrincipais:pecasPrincipais};
})();
`;

export const ESTILOS_ANALISE_PROCESSO_IA = `
#pasta #pasta-proc-ia-bt[hidden]{display:none}
.pvpr-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.pvpr-fundo{position:fixed;inset:0;z-index:60;background:rgba(11,25,44,.55);display:flex;align-items:flex-start;justify-content:center;
  padding:24px 16px;overflow-y:auto}
.pvpr{width:min(860px,100%);min-width:0;background:var(--papel);color:var(--tinta);border:1px solid var(--linha);
  border-left:4px solid var(--acento);border-radius:var(--r);padding:16px 18px;font-size:13.5px;line-height:1.5;overflow-wrap:anywhere}
.pvpr-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.pvpr-tit{margin:0;font-size:16px;font-weight:700}
.pvpr-tit:focus-visible,.pvpr button:focus-visible,.pvpr summary:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.pvpr-tit:focus{outline:none}
.pvpr-nota{margin:4px 0;color:var(--tinta2);font-size:12.5px}
.pvpr-estado{margin:8px 0;display:flex;align-items:center;gap:8px}
.pvpr-falha{margin:8px 0;padding:8px 10px;border-radius:var(--r);background:var(--atencao-bg);color:var(--tinta)}
.pvpr-est{margin:8px 0;padding-left:18px}
.pvpr-pecas{margin:8px 0;padding-left:20px}
.pvpr-pecas>li{margin:0 0 3px}
.pvpr-pe{color:var(--tinta2);font-size:12.5px}
.pvpr-pe-fora{color:var(--tinta)}
.pvpr-sec{margin:14px 0;padding-top:10px;border-top:1px solid var(--linha)}
.pvpr-h{margin:0 0 6px;font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2)}
.pvpr-itens{margin:0;padding:0;list-style:none}
.pvpr-itens>li{margin:0 0 8px;padding:0 0 8px;border-bottom:1px solid var(--linha)}
.pvpr-itens>li:last-child{border-bottom:0;margin-bottom:0;padding-bottom:0}
.pvpr-itens-simples{margin:0;padding-left:18px}
.pvpr-texto{margin:0 0 3px;font-weight:600}
.pvpr-sub{margin:6px 0 0 12px;padding-left:10px;border-left:3px solid var(--linha)}
.pvpr-sub .pvpr-texto{font-weight:400}
.pvpr-r{display:block;font-size:11px;font-weight:700;color:var(--tinta2)}
.pvpr-fonte{display:block;color:var(--tinta2);font-size:12px}
.pvpr-cit{margin:2px 0 0}
.pvpr-cit summary{cursor:pointer;color:var(--tinta2);font-size:12.5px}
.pvpr-cit blockquote{margin:4px 0 0;padding:6px 10px;border-left:3px solid var(--linha);background:var(--papel2);color:var(--tinta2);font-style:italic}
.pvpr-aviso{margin:12px 0 4px;color:var(--tinta2);font-size:12.5px}
@media (max-width:600px){.pvpr-fundo{padding:0}.pvpr{border-radius:0;min-height:100%;padding:12px}}
`;
