/**
 * "Analisar peça com IA" na linha do tempo do processo (v0.55.0, Fase 1): o botão ao lado de cada
 * peça elegível, o painel do resultado logo abaixo dela e as chamadas à API, num arquivo só.
 * `script.ts` não cresce (há teste que fixa o tamanho): um MutationObserver sobre `#conteudo` põe o
 * botão nas peças que a tela desenha (a régua e o rodapé de peças soltas), sem tocar no download.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Análise de peça por IA"):
 * - o botão só existe se o servidor liberar a CONTA (`GET /v1/analises-de-peca/disponibilidade`: as duas
 *   chaves) e só para processo ACOMPANHADO; peça sob sigilo tem o botão DESLIGADO, com a razão. O PLANO
 *   é conferido no clique (a conta liberada sem o plano vê o aviso padrão de upgrade);
 * - o fluxo é de UM clique: se a peça não está na guarda de 24 h, a tela a baixa pelo pedido que já existe
 *   da Pasta digital e acompanha (só banco) até ela ficar disponível — e então pede a análise. O texto
 *   da peça NUNCA passa por aqui: o servidor lê o PDF guardado e devolve só o resultado verificado;
 * - toda frase de recusa é FIXA aqui, nunca texto do servidor ou do modelo;
 * - o resultado é CONCISO: uma frase, o que pede, o que alega, documentos e valores (recolhidos se
 *   muitos), citações recolhidas em "Ver trecho · pág. N" e o aviso fixo em uma linha;
 * - avaliação: na conta de AVALIAÇÃO (lista de contas) os três botões Útil / Errado / Perigoso com motivo
 *   de lista fechada; nas demais, só o link discreto "Reportar problema" (que registra "errado" + motivo).
 *   Nenhum campo de texto livre;
 * - o estado vive na página e é apagado ao sair do processo; não há "reabrir" (o servidor guarda o
 *   resultado por 30 dias, mas a reabertura exigiria restaurar os nomes do retrato, que só a análise faz).
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc;
 * `tests/http/console-script.spec.ts` roda o ESLint aqui dentro. Todo texto do servidor passa por `esc()`.
 */
export const SCRIPT_ANALISE_PECA_IA = String.raw`
(function(){
var pv=function(){return window.__pv};
function esc(s){return pv().esc(s)}
function digitos(n){return String(n||'').replace(/\D/g,'')}

var D={promessa:null,liberado:false,modo:''};
var S=null;
var ESPERA_MS=2500,LIMITE_DE_ESPERA_MS=120000;

var TIPOS={peticao_inicial:'Petição inicial',contestacao:'Contestação',replica:'Réplica',embargos:'Embargos',
  recurso:'Recurso',laudo_pericial:'Laudo pericial',manifestacao:'Manifestação',outro:'Outro tipo de peça',
  indeterminado:'Tipo não identificado'};
var ATENCAO={
  peca_longa_demais_para_leitura_completa:'A peça é longa: a leitura pode ter deixado pontos de fora.',
  texto_incompleto_ou_ilegivel:'O texto da peça pode estar incompleto ou ilegível.',
  peca_cita_documentos_nao_anexados:'A peça cita documentos que podem não estar anexados.',
  conferir_peca_inteira:'Confira a peça inteira.'
};
var RECUSAS={
  sem_plano:'A análise de peça por IA faz parte do plano IA. Faça upgrade do plano para usar.',
  indisponivel:'A análise de peça por IA não está disponível para esta conta.',
  peca_sigilosa:'Peça sob sigilo: a análise por IA não é feita. Leia a peça.',
  processo_sigiloso:'Processo em segredo de justiça: a análise por IA não é feita. Leia a peça.',
  tribunal_nao_suportado:'Por enquanto a análise de peça vale apenas para o Tribunal de Justiça de Goiás (TJGO).',
  peca_nao_encontrada:'Esta peça não está na lista carregada do processo. Carregue as peças do processo e tente de novo.',
  peca_nao_baixada:'Não foi possível baixar a peça do tribunal agora. Tente de novo.',
  sem_texto:'Esta peça não tem texto que possamos ler (parece ser imagem escaneada). Leia a peça.',
  acima_de_40_paginas:'Esta peça tem mais de 40 páginas, acima do limite da análise por IA. Leia a peça.',
  acima_de_80_mil_caracteres:'Esta peça tem mais de 80 mil caracteres, acima do limite da análise por IA. Leia a peça.',
  pdf_invalido:'Não conseguimos ler o PDF desta peça. Leia a peça.',
  pdf_protegido:'O PDF desta peça tem senha e não pode ser lido. Leia a peça.',
  arquivo_grande:'O arquivo desta peça é grande demais para a análise por IA. Leia a peça.',
  limite_de_uso:'Há muitas análises em andamento ou o limite por hora foi atingido. Tente novamente em instantes.',
  limite_diario:'Muitas análises hoje (cada peça conta como cinco). Tente de novo amanhã ou fale com a gente.',
  nao_acompanhado:'Este processo não está entre os que você acompanha.'
};
var DOWNLOAD={
  428:'Cadastre o acesso ao tribunal em “Meus acessos” para baixar a peça.',
  424:'O tribunal recusou o acesso cadastrado. Atualize a senha em “Meus acessos”.',
  403:'O tribunal não liberou esta peça para o acesso cadastrado (em geral falta procuração nos autos).',
  503:'O tribunal está temporariamente indisponível. Tente em alguns minutos.',
  409:'Esta peça não está na lista carregada do processo. Carregue as peças do processo e tente de novo.'
};
var MOTIVO_NAO_OBTIDA={sem_teor:403,credencial_recusada:424};
var BAIXANDO='Baixando a peça do tribunal…';
var LENDO='Lendo a peça… isso pode levar até 2 minutos.';
var NAO_VERIFICADO='Não foi possível analisar esta peça com segurança. Leia a peça.';
var ERRO='Não foi possível analisar agora. Tente de novo em alguns minutos.';
var AVISO_FIXO='Leitura automática, pode omitir pontos. Confira a peça inteira.';
var SIGILOSA='Peça sob sigilo: a análise por IA não é feita.';
var AVALIACOES=[['util','Útil'],['errado','Errado'],['perigoso','Perigoso']];
var MOTIVOS=[['erro_de_fato','Erro de fato'],['citacao_inventada','Citação inventada'],['concluiu_prazo','Concluiu prazo'],
  ['deixou_de_fora','Deixou de fora algo importante'],['outro','Outro']];

function pl(n,um,varios){return n+' '+(n===1?um:varios)}
function cabecalhos(json){
  var h={},k=pv().chave();
  if(k)h['x-api-key']=k;
  if(json)h['content-type']='application/json';
  return h;
}
function anunciar(t){
  var el=document.getElementById('pvpe-live');
  if(!el){
    el=document.createElement('div');
    el.id='pvpe-live';el.className='pvpe-live';
    el.setAttribute('aria-live','polite');el.setAttribute('role','status');
    document.body.appendChild(el);
  }
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

/* ---------- disponibilidade (uma pergunta por página; falha = sem botão) ---------- */
function carregar(){
  if(D.promessa)return D.promessa;
  D.promessa=fetch('/v1/analises-de-peca/disponibilidade',{headers:cabecalhos(false)})
    .then(function(r){return r.ok?r.json():{liberado:false}})
    .then(function(b){
      D.liberado=b.liberado===true;
      D.modo=b.modo==='avaliacao'?'avaliacao':'geral';
      return D.liberado},
      function(){D.promessa=null;D.liberado=false;return false});
  return D.promessa;
}

/* ---------- desenho do resultado ---------- */
function citacao(it){
  return '<details class="pvpe-cit"><summary>Ver trecho · pág. '+esc(it.pagina)+'</summary>'+
    '<blockquote><mark>'+esc(it.trecho)+'</mark></blockquote></details>';
}
function lista(itens,rotulo){
  if(!itens||!itens.length)return '';
  return '<section class="pvpe-sec"><h4 class="pvpe-rot">'+rotulo+'</h4><ul class="pvpe-itens">'+
    itens.map(function(i){return '<li><p class="pvpe-texto">'+esc(i.texto)+'</p>'+citacao(i)+'</li>'}).join('')+
    '</ul></section>';
}
function citados(r){
  var docs=r.documentos||[],vals=r.valores||[],n=docs.length+vals.length;
  if(!n)return '';
  var h='<ul class="pvpe-itens-simples">'+
    docs.map(function(d){return '<li>Documento: '+esc(d.nome)+' <span class="pvpe-pg">· pág. '+esc(d.pagina)+'</span></li>'}).join('')+
    vals.map(function(v){return '<li>Valor: <strong>'+esc(v.valor)+'</strong>'+(v.contexto?' — '+esc(v.contexto):'')+
      ' <span class="pvpe-pg">· pág. '+esc(v.pagina)+'</span>'+citacao(v)+'</li>'}).join('')+'</ul>';
  if(n>4){
    return '<section class="pvpe-sec"><details class="pvpe-rec"><summary><span class="pvpe-rot">Documentos e valores citados ('+n+')</span></summary>'+h+'</details></section>';
  }
  return '<section class="pvpe-sec"><h4 class="pvpe-rot">Documentos e valores citados</h4>'+h+'</section>';
}
function avaliacaoHtml(){
  if(D.modo==='avaliacao'){
    var h='<div class="pvpe-aval" role="group" aria-label="Esta análise foi útil?"><span class="pvpe-rot">Esta análise foi útil?</span>'+
      AVALIACOES.map(function(a){
        var on=S.aval===a[0];
        return '<button type="button" class="nov-btn pvpe-av'+(on?' on':'')+'" data-pvpe="aval" data-aval="'+a[0]+
          '" id="pvpe-av-'+a[0]+'" aria-pressed="'+(on?'true':'false')+'">'+a[1]+'</button>';
      }).join('')+
      '<span class="pvpe-ok" role="status">'+(S.aval?'✓ Avaliação registrada.':'')+(S.avalErro?esc(S.avalErro):'')+'</span></div>';
    if(S.aval==='errado'||S.aval==='perigoso')h+=motivosHtml('Qual foi o problema? (opcional)');
    return h;
  }
  /* Conta no modo geral: só um link discreto; ele abre a lista fechada de motivos e registra "errado". */
  var r='<div class="pvpe-aval"><button type="button" class="link pvpe-reportar" data-pvpe="reportar" id="pvpe-reportar" aria-expanded="'+
    (S.reportando?'true':'false')+'">Reportar problema</button>'+
    '<span class="pvpe-ok" role="status">'+(S.aval?'✓ Obrigado, registramos.':'')+(S.avalErro?esc(S.avalErro):'')+'</span></div>';
  if(S.reportando&&!S.aval)r+=motivosHtml('Qual foi o problema?');
  return r;
}
function motivosHtml(titulo){
  return '<div class="pvpe-aval pvpe-motivo" role="group" aria-label="'+titulo+'"><span class="pvpe-rot">'+titulo+'</span>'+
    MOTIVOS.map(function(m){
      var on=S.motivoAval===m[0];
      return '<button type="button" class="nov-btn pvpe-av'+(on?' on':'')+'" data-pvpe="motivo" data-motivo="'+m[0]+
        '" id="pvpe-mo-'+m[0]+'" aria-pressed="'+(on?'true':'false')+'">'+m[1]+'</button>';
    }).join('')+'</div>';
}
function resultadoHtml(d){
  var r=d.resultado;
  var h=avaliacaoHtml();
  h+='<p class="pvpe-tipo"><span class="pvpe-selo">'+esc(TIPOS[r.tipo]||'Peça')+'</span></p>';
  if(r.emUmaFrase)h+='<section class="pvpe-sec"><h4 class="pvpe-rot">Em uma frase</h4><p class="pvpe-texto">'+esc(r.emUmaFrase)+'</p></section>';
  h+=lista(r.pedidos,'O que pede');
  h+=lista(r.alegacoes,'O que alega');
  h+=lista(r.preliminares,'Preliminares e defesas formais');
  h+=citados(r);
  if(r.pontosDeAtencao&&r.pontosDeAtencao.length){
    h+='<section class="pvpe-sec"><h4 class="pvpe-rot">Pontos de atenção</h4><ul class="pvpe-itens-simples">'+
      r.pontosDeAtencao.map(function(p){return '<li>'+esc(ATENCAO[p]||'')+'</li>'}).join('')+'</ul></section>';
  }
  h+='<p class="pvpe-aviso-fixo">'+esc(AVISO_FIXO)+' <button type="button" class="link" data-pvpe="abrir" id="pvpe-abrir">Abrir a peça</button></p>';
  h+='<p class="pvpe-nota" id="pvpe-nota-abrir" role="status"></p>';
  h+='<div class="pvpe-proc"><span class="pvpe-selo" aria-hidden="true">IA</span><span>'+
    (d.reaproveitada?'Resultado já gerado para esta peça (nada foi gasto agora). ':'')+
    'Gerado por IA em '+esc(pv().dth(d.criadaEm))+'. Fica guardado até '+esc(pv().dt(d.expiraEm))+'.</span></div>';
  return h;
}
function corpo(){
  var h='<div class="pvpe-topo"><h3 class="pvpe-tit">Análise da peça por IA</h3>'+
    (S.fase==='baixando'||S.fase==='lendo'?'':'<button type="button" class="nov-btn" data-pvpe="fechar" id="pvpe-fechar">Fechar</button>')+'</div>';
  if(S.fase==='baixando'||S.fase==='lendo'){
    h+='<p class="pvpe-estado"><span class="gira" aria-hidden="true"></span>'+(S.fase==='baixando'?BAIXANDO:LENDO)+'</p>'+
      '<p><button type="button" class="nov-btn" data-pvpe="cancelar" id="pvpe-cancelar">Cancelar</button></p>';
  }else if(S.fase==='resultado'){
    h+=resultadoHtml(S.dados);
  }else if(S.fase==='nao_verificado'){
    h+='<p class="pvpe-estado">'+esc(NAO_VERIFICADO)+'</p>';
  }else if(S.fase==='recusa'&&S.motivo==='sem_plano'&&window.__pvAnaliseIA){
    h+=window.__pvAnaliseIA.semPlano(RECUSAS.sem_plano,'pvpe-estado');
  }else if(S.fase==='recusa'){
    h+='<p class="pvpe-estado">'+esc(S.frase||RECUSAS[S.motivo]||ERRO)+'</p>';
  }else{
    h+='<p class="pvpe-estado">'+esc(ERRO)+'</p>'+
      '<p><button type="button" class="nov-btn" data-pvpe="repetir" id="pvpe-repetir">Tentar de novo</button></p>';
  }
  return h;
}
function painelInterno(){
  return '<div class="pvpe" id="pvpe-painel" role="region" aria-label="Análise da peça por IA" tabindex="-1" aria-busy="'+
    (S.fase==='baixando'||S.fase==='lendo'?'true':'false')+'">'+corpo()+'</div>';
}

/* ---------- montagem ---------- */
function botaoDaPeca(id){
  var bs=document.querySelectorAll('#conteudo [data-pvpe="analisar"]');
  for(var i=0;i<bs.length;i++){if(bs[i].getAttribute('data-pvpe-id')===id)return bs[i]}
  return null;
}
function montarRaiz(){
  if(!S)return false;
  var b=botaoDaPeca(S.pecaId);
  if(!b)return false;
  var raiz=document.getElementById('pvpe-raiz');
  var docs=b.closest('.docs');
  var onde=docs||b.parentElement;
  if(raiz&&raiz.getAttribute('data-peca')!==S.pecaId){raiz.parentNode.removeChild(raiz);raiz=null}
  if(!raiz){
    raiz=document.createElement('div');
    raiz.id='pvpe-raiz';raiz.setAttribute('data-peca',S.pecaId);
    raiz.innerHTML='<div id="pvpe-corpo"></div>';
    if(docs)docs.insertAdjacentElement('afterend',raiz);else onde.appendChild(raiz);
  }
  document.getElementById('pvpe-corpo').innerHTML=painelInterno();
  marcarBotoes();
  return true;
}
function marcarBotoes(){
  var bs=document.querySelectorAll('#conteudo [data-pvpe="analisar"]');
  for(var i=0;i<bs.length;i++){
    bs[i].setAttribute('aria-expanded',S&&bs[i].getAttribute('data-pvpe-id')===S.pecaId?'true':'false');
  }
}
function refrescar(anuncio,foco){
  var c=document.getElementById('pvpe-corpo');
  if(!c){marcarBotoes();return}
  var p=document.getElementById('pvpe-painel');
  var tinhaFoco=p&&p.contains(document.activeElement);
  c.innerHTML=painelInterno();
  var alvo=foco?document.getElementById(foco):null;
  if(!alvo&&tinhaFoco)alvo=document.getElementById('pvpe-painel');
  if(alvo)alvo.focus();
  if(anuncio)anunciar(anuncio);
}
function remover(){
  var raiz=document.getElementById('pvpe-raiz');
  if(raiz&&raiz.parentNode)raiz.parentNode.removeChild(raiz);
}
function descartar(){
  if(S){
    if(S.ctrl){try{S.ctrl.abort()}catch(x){}}
    if(S.timer)clearTimeout(S.timer);
  }
  S=null;
  remover();
  marcarBotoes();
}

/* ---------- chamadas ---------- */
function url(sufixo){return '/v1/processos/'+encodeURIComponent(S.numero)+'/'+sufixo}
function lerJson(r){return r.json().catch(function(){return {}}).then(function(b){return {ok:r.ok,status:r.status,b:b}})}
function falhou(e,motivo,frase,aviso){
  e.ctrl=null;e.fase='recusa';e.motivo=motivo;e.frase=frase||'';
  refrescar(aviso||frase||RECUSAS[motivo],'pvpe-fechar');
}

/* O aviso padrão do plano: a frase depende da oferta do servidor (ver planos / fale com a gente). */
function semPlanoDe(e){
  e.ctrl=null;e.fase='recusa';e.motivo='sem_plano';e.frase='';
  var pronto=window.__pvAnaliseIA?window.__pvAnaliseIA.carregar():Promise.resolve();
  pronto.then(function(){
    if(S!==e)return;
    refrescar(window.__pvAnaliseIA?window.__pvAnaliseIA.textoSemPlano(RECUSAS.sem_plano):RECUSAS.sem_plano,'pvpe-painel');
  });
}

/* 1) Garante a peça na guarda (o pedido que a Pasta digital já usa) e espera, sem consultar o tribunal à toa. */
function baixar(e){
  e.fase='baixando';e.ctrl=typeof AbortController!=='undefined'?new AbortController():null;
  fetch(url('pasta/pecas/'+encodeURIComponent(e.pecaId)),{method:'POST',headers:cabecalhos(false),signal:e.ctrl?e.ctrl.signal:undefined})
    .then(lerJson)
    .then(function(x){
      if(S!==e)return;
      if(x.ok&&x.b.estado==='disponivel'){analisar(e);return}
      if(x.ok){e.inicioDaEspera=Date.now();esperar(e);return}
      var motivo=x.b&&x.b.detalhes?x.b.detalhes.motivo:'';
      /* Plano da Pasta (Peças) ausente ou assinatura inativa: o aviso padrão de upgrade, não "o tribunal não liberou". */
      if(x.status===402||(x.b&&x.b.erro==='RECURSO_NAO_INCLUIDO_NO_PLANO')||(x.status===403&&motivo==='sem_plano')){
        semPlanoDe(e);return}
      if(DOWNLOAD[x.status]){falhou(e,'peca_nao_baixada',DOWNLOAD[x.status]);return}
      falhou(e,'peca_nao_baixada');
    })
    .catch(function(err){
      if(S!==e)return;
      if(err&&err.name==='AbortError')return;
      e.ctrl=null;e.fase='erro';refrescar(ERRO);
    });
}
function esperar(e){
  e.timer=setTimeout(function(){
    if(S!==e)return;
    fetch(url('pasta/pecas/'+encodeURIComponent(e.pecaId)+'/estado'),{headers:cabecalhos(false)})
      .then(lerJson)
      .then(function(x){
        if(S!==e)return;
        if(!x.ok){falhou(e,'peca_nao_baixada');return}
        if(x.b.estado==='disponivel'){analisar(e);return}
        if(x.b.estado==='nao_obtida'){
          var st=MOTIVO_NAO_OBTIDA[x.b.motivo];
          falhou(e,'peca_nao_baixada',st?DOWNLOAD[st]:'');return}
        if(x.b.estado==='sigilo'){falhou(e,'peca_sigilosa');return}
        if(Date.now()-e.inicioDaEspera>LIMITE_DE_ESPERA_MS){falhou(e,'peca_nao_baixada');return}
        esperar(e);
      })
      .catch(function(){if(S===e)falhou(e,'peca_nao_baixada')});
  },ESPERA_MS);
}

/* 2) A análise. O pedido não leva corpo: o servidor lê a peça da guarda. */
function analisar(e){
  e.fase='lendo';e.ctrl=typeof AbortController!=='undefined'?new AbortController():null;
  refrescar(LENDO);
  fetch(url('pecas/'+encodeURIComponent(e.pecaId)+'/analise'),{method:'POST',headers:cabecalhos(false),signal:e.ctrl?e.ctrl.signal:undefined})
    .then(lerJson)
    .then(function(x){
      if(S!==e)return;
      e.ctrl=null;
      if(x.ok&&x.b.estado==='verificada'){
        e.fase='resultado';e.dados=x.b;e.aval=x.b.avaliacao||'';
        refrescar('Análise concluída. Confira na peça.','pvpe-painel');return}
      if(x.ok&&x.b.estado==='nao_verificada'){e.fase='nao_verificado';refrescar(NAO_VERIFICADO,'pvpe-painel');return}
      var motivo=x.b&&x.b.detalhes?x.b.detalhes.motivo:'';
      if(!x.ok&&motivo&&RECUSAS[motivo]){
        e.fase='recusa';e.motivo=motivo;e.frase='';
        if(motivo==='sem_plano'){semPlanoDe(e);return}
        refrescar(RECUSAS[motivo],'pvpe-painel');return}
      if(!x.ok&&x.status===404){e.fase='recusa';e.motivo='nao_acompanhado';e.frase='';refrescar(RECUSAS.nao_acompanhado,'pvpe-painel');return}
      e.fase='erro';refrescar(ERRO,'pvpe-painel');
    })
    .catch(function(err){
      if(S!==e)return;
      if(err&&err.name==='AbortError')return;
      e.ctrl=null;e.fase='erro';refrescar(ERRO,'pvpe-painel');
    });
}

function avaliar(valor,motivo){
  var e=S;
  if(!e||!e.dados||e.ocupadoAval)return;
  e.ocupadoAval=true;e.avalErro='';
  var foco=motivo?'pvpe-mo-'+motivo:(D.modo==='avaliacao'?'pvpe-av-'+valor:'pvpe-reportar');
  var c={avaliacao:valor};
  if(motivo)c.motivo=motivo;
  fetch('/v1/analises-de-peca/'+encodeURIComponent(e.dados.id)+'/avaliacao',{method:'POST',headers:cabecalhos(true),body:JSON.stringify(c)})
    .then(function(r){
      e.ocupadoAval=false;
      if(S!==e)return;
      if(r.ok){e.aval=valor;e.motivoAval=motivo||'';refrescar('Avaliação registrada.',foco)}
      else{e.avalErro='Não foi possível registrar. Tente de novo.';refrescar(e.avalErro,foco)}
    },function(){
      e.ocupadoAval=false;
      if(S!==e)return;
      e.avalErro='Não foi possível registrar. Tente de novo.';refrescar(e.avalErro,foco);
    });
}

/* "Abrir a peça": a rota exige o cabeçalho de chave, então vai por fetch e abre o PDF guardado numa aba. */
function abrirPeca(){
  var e=S;if(!e)return;
  var nota=document.getElementById('pvpe-nota-abrir');
  fetch(url('pasta/pecas/'+encodeURIComponent(e.pecaId)+'/arquivo'),{headers:cabecalhos(false)})
    .then(function(r){if(!r.ok)throw new Error('x');return r.blob()})
    .then(function(b){
      var u=URL.createObjectURL(b);
      window.open(u,'_blank','noopener');
      setTimeout(function(){URL.revokeObjectURL(u)},60000);
      if(nota)nota.textContent='';
    })
    .catch(function(){if(nota)nota.textContent='Não foi possível abrir a peça agora. Use o botão da própria peça para baixá-la.'});
}

function abrir(b){
  var id=b.getAttribute('data-pvpe-id');
  if(S&&S.pecaId===id){descartar();b.focus();return}
  descartar();
  S={numero:numeroAtual(),pecaId:id,fase:'baixando',ctrl:null,timer:null,dados:null,aval:'',motivoAval:'',avalErro:'',
    motivo:'',frase:'',reportando:false,ocupadoAval:false,inicioDaEspera:0};
  montarRaiz();
  refrescar(BAIXANDO,'pvpe-painel');
  baixar(S);
}

/* ---------- botões nas peças ---------- */
function numeroAtual(){
  var capa=document.querySelector('#conteudo .capa');
  var num=capa?capa.querySelector('.num'):null;
  /* O botão de "Deixar de acompanhar" só existe para processo acompanhado: é o mesmo critério do resumo. */
  if(!num||!document.getElementById('parar'))return '';
  return digitos(num.textContent);
}
function ehSigilosa(b){
  if(b.classList.contains('sigilosa'))return true;
  var ev=b.closest('.ev');
  return !!(ev&&ev.querySelector('.selo.al'));
}
var agendado=false;
function decorar(){
  agendado=false;
  var n=numeroAtual();
  if(!n){if(S)descartar();return}
  if(S&&S.numero!==n)descartar();
  carregar().then(function(){
    if(!D.liberado||numeroAtual()!==n)return;
    var origem=document.querySelectorAll('#conteudo button[data-peca]');
    for(var i=0;i<origem.length;i++){
      var o=origem[i];
      if(o.getAttribute('data-pvpe-ok'))continue;
      o.setAttribute('data-pvpe-ok','1');
      var id=o.getAttribute('data-peca');
      var b=document.createElement('button');
      b.type='button';b.className='pvpe-btn';b.setAttribute('data-pvpe','analisar');b.setAttribute('data-pvpe-id',id);
      b.setAttribute('aria-expanded','false');b.setAttribute('aria-controls','pvpe-painel');
      b.textContent='Analisar peça com IA';
      if(ehSigilosa(o)){
        b.disabled=true;b.setAttribute('aria-disabled','true');b.title=SIGILOSA;
        b.setAttribute('aria-label','Analisar peça com IA (indisponível: '+SIGILOSA+')');
      }
      o.insertAdjacentElement('afterend',b);
    }
    if(S&&!document.getElementById('pvpe-raiz'))montarRaiz();
  });
}
function agendar(){if(agendado)return;agendado=true;setTimeout(decorar,0)}

/* ---------- eventos ---------- */
document.addEventListener('click',function(ev){
  var el=ev.target&&ev.target.closest?ev.target.closest('[data-pvpe]'):null;
  if(!el)return;
  var acao=el.getAttribute('data-pvpe');
  if(acao==='analisar'){if(!el.disabled)abrir(el);return}
  if(!S)return;
  if(acao==='fechar'){var b=botaoDaPeca(S.pecaId);descartar();if(b)b.focus();return}
  if(acao==='cancelar'){var b2=botaoDaPeca(S.pecaId);descartar();if(b2)b2.focus();anunciar('Análise cancelada.');return}
  if(acao==='repetir'){var e=S;e.fase='baixando';refrescar(BAIXANDO,'pvpe-painel');baixar(e);return}
  if(acao==='aval'){avaliar(el.getAttribute('data-aval'));return}
  if(acao==='reportar'){S.reportando=!S.reportando;refrescar('', S.reportando?'pvpe-mo-erro_de_fato':'pvpe-reportar');return}
  if(acao==='motivo'){
    var m=el.getAttribute('data-motivo');
    if(D.modo==='avaliacao'){
      if(S.aval!=='errado'&&S.aval!=='perigoso')return;
      avaliar(S.aval,S.motivoAval===m?'':m);return;
    }
    avaliar('errado',m);return;
  }
  if(acao==='abrir'){abrirPeca();return}
});
document.addEventListener('keydown',function(ev){
  if(ev.key!=='Escape'||!S)return;
  var p=ev.target&&ev.target.closest?ev.target.closest('#pvpe-painel'):null;
  if(!p)return;
  ev.preventDefault();
  var b=botaoDaPeca(S.pecaId);
  var andando=S.fase==='baixando'||S.fase==='lendo';
  descartar();
  if(b)b.focus();
  if(andando)anunciar('Análise cancelada.');
});

var alvo=document.getElementById('conteudo');
if(alvo&&typeof MutationObserver!=='undefined'){
  new MutationObserver(agendar).observe(alvo,{childList:true,subtree:true});
}

window.__pvPecaIA={carregar:carregar,decorar:decorar};
})();
`;

export const ESTILOS_ANALISE_PECA_IA = `
.pvpe-btn{margin:2px 0 2px 6px;padding:3px 10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;
  color:var(--acento);background:var(--papel);border:1px solid var(--acento);border-radius:999px;vertical-align:middle}
.pvpe-btn:hover:not([disabled]){background:var(--acento-bg)}
.pvpe-btn[aria-expanded="true"]{background:var(--acento-bg)}
.pvpe-btn[disabled]{cursor:not-allowed;color:var(--tinta2);border-color:var(--linha);border-style:dashed}
.pvpe-btn:focus-visible,.pvpe .nov-btn:focus-visible,.pvpe .link:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.pvpe-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
#pvpe-raiz{margin:8px 0 12px;min-width:0;max-width:100%}
.pvpe{min-width:0;max-width:100%;background:var(--papel2);border:1px solid var(--linha);border-left:4px solid var(--acento);
  border-radius:var(--r);padding:12px 14px;color:var(--tinta);overflow-wrap:anywhere;font-size:13.5px;line-height:1.5}
.pvpe:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.pvpe-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}
.pvpe-tit{margin:0;font-size:14.5px;font-weight:700}
.pvpe-estado{margin:6px 0;display:flex;align-items:flex-start;gap:8px}
.pvpe-tipo{margin:4px 0 8px}
.pvpe-sec{margin:10px 0}
.pvpe-rot{display:block;margin:0 0 4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2)}
.pvpe-itens{margin:0;padding:0;list-style:none}
.pvpe-itens>li{margin:0 0 8px;padding:0 0 8px;border-bottom:1px solid var(--linha)}
.pvpe-itens>li:last-child{border-bottom:0;margin-bottom:0;padding-bottom:0}
.pvpe-itens-simples{margin:0;padding-left:18px}
.pvpe-itens-simples>li{margin:0 0 4px}
.pvpe-texto{margin:0 0 3px;font-weight:600}
.pvpe-pg{color:var(--tinta2);font-size:12px}
.pvpe-cit{margin:3px 0 0}
.pvpe-cit summary{cursor:pointer;color:var(--tinta2);font-size:12.5px}
.pvpe-cit blockquote{margin:4px 0 0;padding:6px 10px;border-left:3px solid var(--linha);background:var(--papel);color:var(--tinta2);font-style:italic}
.pvpe-cit mark{background:var(--atencao-bg);color:var(--tinta);padding:0 2px;border-radius:3px;font-style:normal}
.pvpe-rec>summary{cursor:pointer}
.pvpe-aviso-fixo{margin:10px 0 4px;color:var(--tinta2);font-size:12.5px}
.pvpe-nota{margin:0 0 4px;font-size:12.5px;color:var(--tinta2)}
.pvpe-proc{display:flex;align-items:flex-start;gap:8px;margin:6px 0 2px;font-size:12.5px;color:var(--tinta2)}
.pvpe-selo{flex:none;display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;
  background:var(--acento-bg);color:var(--acento);border:1px solid var(--acento)}
.pvpe-aval{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:6px 0}
.pvpe-av.on{background:var(--acento-bg);border-color:var(--acento)}
.pvpe-ok{font-size:12.5px;color:var(--tinta2)}
.pvpe-reportar{font-size:12.5px;color:var(--tinta2)}
@media (max-width:600px){.pvpe{padding:10px 12px}.pvpe-btn{display:inline-block;margin-left:0}}
`;
