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
 *   botão e, ao clicar, a frase fixa de upgrade. Desde a v0.50.0 a frase ganha "Ver planos"
 *   (leva a "Minha conta") SÓ quando o servidor diz que há plano com IA contratável agora
 *   (`oferta: 'ver_planos'`); conta de chave de API lê "Fale com a gente", sem link;
 * - a resposta demora (p50 ~29 s, p95 ~52 s com raciocínio ligado): o estado "analisando"
 *   diz isso e oferece Cancelar, que aborta a requisição (e, no servidor, a chamada ao modelo);
 * - toda frase de recusa é FIXA aqui — nunca texto do modelo; o resultado verificado traz
 *   citações que existem no texto do ato, mostradas destacadas;
 * - aviso no calendário (v0.39.0): quando a análise traz prazo em dias e o ato é do Diário, o botão
 *   abre a PRÉVIA (data calculada no servidor, premissas e o aviso "a conferir") e só o clique em
 *   Confirmar cria o evento; sem clique, nada grava. Ato fora do Diário não calcula;
 * - avaliação por POLEGAR (v0.56.0, `ui/polegares.ts`): dois ícones no FIM do resultado, sem texto livre; para
 *   baixo abre a lista fechada de motivos, opcional. Os botões Útil / Errado / Perigoso do topo (v0.52.0) saíram.
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

var D={habilitada:null,resumo:false,promessa:null,oferta:'nenhuma'};
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
  limite_diario:'Muitas análises hoje. Tente de novo amanhã ou fale com a gente.',
  ato_nao_encontrado:'Esse ato não está mais no último retrato do processo. Atualize a tela e confira de novo.',
  desligada:'Este recurso está indisponível no momento.'
};
var NAO_VERIFICADO='Não foi possível analisar com segurança. Leia o ato.';
var ERRO='Não foi possível analisar agora. Tente de novo em alguns minutos.';
var SEM_ACAO='Sem providência indicada no ato.';
var AVISO_FIXO='Apoio à leitura, não substitui a leitura do ato nem a contagem de prazo.';
var SEM_CALCULO='Este ato não é do Diário, então o prazo não é calculado. Crie o aviso manualmente no calendário.';
var ERRO_AVISO='Não foi possível montar o aviso agora. Tente de novo em alguns minutos.';
var MSG_AVISO={
  ato_fora_do_diario:SEM_CALCULO,
  sem_prazo_na_analise:'Esta análise não traz um prazo em dias escrito no ato. Crie o aviso manualmente no calendário.',
  ato_nao_encontrado:RECUSAS.ato_nao_encontrado,
  sem_plano:RECUSAS.sem_plano
};
var SEM_PLANO_CHAVE=' Fale com a gente para contratar.';

/* A frase de "sem plano" com a oferta que o servidor indicou (v0.50.0). Conta de chave de API não assina
   online: troca o "Faça upgrade" pelo "Fale com a gente". Só "ver_planos" ganha o botão, que leva a "Minha
   conta", onde estão os planos contratáveis; sem plano com IA à venda, a frase de sempre, sem link. Serve
   também ao resumo (resumoIA.ts), que passa a frase dele. */
function semPlano(frase,classe){
  var h='<p class="'+(classe||'pvia-estado')+'">'+esc(textoSemPlano(frase))+'</p>';
  if(D.oferta==='ver_planos')h+='<p><button type="button" class="nov-btn" data-pv-planos="1">Ver planos</button></p>';
  return h;
}
function textoSemPlano(frase){
  return D.oferta==='fale_conosco'?String(frase).replace(/ Faça upgrade do plano para usar\.$/,'')+SEM_PLANO_CHAVE:frase;
}

/* Pergunta uma vez por página se a IA está ligada. Falha de rede = desligada (sem botão). */
function carregar(){
  if(D.promessa)return D.promessa;
  var h={},k=pv().chave();
  if(k)h['x-api-key']=k;
  D.promessa=fetch('/v1/analises/disponibilidade',{headers:h})
    .then(function(r){return r.ok?r.json():{habilitada:false}})
    .then(function(b){
      /* v0.58.0: o painel do /admin liga e desliga cada função; sem "funcoes" (servidor antigo) vale "habilitada". */
      var f=b.funcoes||{};
      D.habilitada=b.habilitada===true&&f.ato!==false;
      D.resumo=b.habilitada===true&&f.resumo!==false;
      D.oferta=(b.oferta==='ver_planos'||b.oferta==='fale_conosco')?b.oferta:'nenhuma';
      return D.habilitada},
      function(){D.habilitada=false;return false});
  return D.promessa;
}
function habilitada(){return D.habilitada===true}
function resumoLigado(){return D.resumo===true}
function ligar(callbacks){
  L.redesenhar=callbacks.redesenhar||L.redesenhar;
  L.anunciar=callbacks.anunciar||L.anunciar;
}

function aberto(n){return !!(E[n]&&E[n].aberto)}

/* Faísca (v0.49.2): o mesmo traço dos outros ícones da fileira de Ações (18 px, 2, sem biblioteca). */
var ICO_IA='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9.9 15.5A2 2 0 0 0 8.5 14.1l-6.1-1.6a.5.5 0 0 1 0-1L8.5 9.9a2 2 0 0 0 1.4-1.4l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>';

/* O botão da linha. Sem IA ligada ou sem chave do ato, não há botão. Desde a v0.49.2 é um ÍCONE na fileira de Ações,
   com a dica comum do console (__pvProvidencia.comDica) e o nome acessível "Analisar com IA"; o texto só aparece nos
   cartões (sem mouse não há dica). Estados: não há desabilitado nem carregando no botão — ele existe ou não existe
   (IA desligada, ou ato sem chave); o aberto/fechado do painel é aria-expanded, e o carregamento mora no painel. */
function botao(num,chave){
  var n=digitos(num);
  if(!habilitada()||!chave)return '';
  return window.__pvProvidencia.comDica('<button type="button" class="nvt-ic pvia-btn" data-acao="ia" data-num="'+esc(num)+'" data-chave="'+esc(chave)+
    '" data-foco="ia-'+esc(n)+'" aria-label="Analisar com IA" aria-describedby="dica-ia-'+esc(n)+'" aria-expanded="'+(aberto(n)?'true':'false')+'" aria-controls="pvia-'+esc(n)+
    '">'+ICO_IA+'<span class="pvia-btn-t">Analisar com IA</span></button>','dica-ia-'+n,'Analisar com IA');
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
  h+=blocoPrazo(n,e);
  if(d.pontosDeAtencao&&d.pontosDeAtencao.length){
    h+='<div class="pvia-sec"><span class="pvia-rot">Pontos de atenção</span><ul class="pvia-lista">'+
      d.pontosDeAtencao.map(function(p){return '<li>'+esc(ATENCAO[p]||'')+'</li>'}).join('')+'</ul></div>';
  }
  h+='<div class="pvia-proc">'+seloIA(d)+'<span>Gerado por IA em '+esc(pv().dth(d.criadaEm))+'. Confira no ato.</span></div>';
  if(window.__pvPolegares)h+=window.__pvPolegares.html('ato',d.id,d.avaliacao);
  return h;
}

/* Data AAAA-MM-DD → DD/MM/AAAA, sem passar por Date (nenhum fuso no meio). */
function br(s){var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s||''));return m?m[3]+'/'+m[2]+'/'+m[1]:String(s||'')}
function tipoTxt(t){return t==='uteis'?'dias úteis':(t==='corridos'?'dias corridos':'dias')}

function corpoAviso(n,e){
  var a=e.aviso,h='<div class="pvia-aviso-cal">';
  if(a.fase==='escolha'){
    /* Nenhuma opção vem pré-marcada e "Calcular" só ativa depois da escolha (v0.40.1): sem tipo
       padrão, quem decide úteis ou corridos é a pessoa. Só a escolha DELA volta marcada ao redesenhar. */
    var esc_=a.escolha||'';
    h+='<p>O ato não diz se os dias são úteis ou corridos. Escolha uma opção para calcular a data.</p>'+
      '<div role="radiogroup" aria-label="Tipo de dias" class="pvia-tipos">'+
      '<label><input type="radio" name="pvia-tipo-'+esc(n)+'" value="uteis" data-foco="iaavtipo-'+esc(n)+'"'+(esc_==='uteis'?' checked':'')+'> Dias úteis</label> '+
      '<label><input type="radio" name="pvia-tipo-'+esc(n)+'" value="corridos"'+(esc_==='corridos'?' checked':'')+'> Dias corridos</label></div>'+
      (a.msg?'<p class="pvia-erro" role="alert">'+esc(a.msg)+'</p>':'')+
      '<p><button type="button" class="nov-btn" data-acao="ia-aviso-calcular" data-num="'+esc(n)+'" data-foco="iaavcalc-'+esc(n)+'"'+
      (esc_?'':' disabled')+'>Calcular</button> '+
      '<button type="button" class="nov-btn" data-acao="ia-aviso-cancelar" data-num="'+esc(n)+'" data-foco="iaavcanc-'+esc(n)+'">Cancelar</button></p>';
  }else if(a.fase==='calculando'||a.fase==='criando'){
    h+='<p class="pvia-estado"><span class="gira" aria-hidden="true"></span>'+(a.fase==='criando'?'Criando o aviso…':'Calculando a data…')+'</p>';
  }else if(a.fase==='previa'){
    var p=a.previa;
    h+='<p class="pvia-rot">Prévia do aviso — nada foi criado ainda</p>'+
      '<p><strong>'+esc(p.titulo)+'</strong></p>'+
      '<p>Data calculada: <strong>'+esc(br(p.dataFinal))+'</strong> <span class="pvia-conferir">(a conferir)</span></p>'+
      (p.tipoDoAto?'':'<p class="pvia-vazio">Tipo escolhido por você: '+esc(tipoTxt(p.tipo))+'.</p>')+
      '<p><label for="pvia-data-'+esc(n)+'">Data do aviso (você pode editar)</label> '+
      '<input type="date" id="pvia-data-'+esc(n)+'" value="'+esc(a.data||p.dataFinal)+'"></p>'+
      '<ul class="pvia-lista">'+(p.premissas||[]).map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul>'+
      '<p class="pvia-alerta">'+esc(p.aviso)+'</p>'+
      (a.msg?'<p class="pvia-erro" role="alert">'+esc(a.msg)+'</p>':'')+
      '<p><button type="button" class="nov-btn" data-acao="ia-aviso-confirmar" data-num="'+esc(n)+'" data-foco="iaavconf-'+esc(n)+'">Confirmar aviso</button> '+
      '<button type="button" class="nov-btn" data-acao="ia-aviso-cancelar" data-num="'+esc(n)+'" data-foco="iaavcanc-'+esc(n)+'">Cancelar</button></p>';
  }else if(a.fase==='criado'){
    h+='<p class="pvia-ok" role="status">'+esc(a.msg)+'</p>';
  }else{
    h+='<p class="pvia-erro" role="alert">'+esc(a.msg||ERRO_AVISO)+'</p>'+
      '<p><button type="button" class="nov-btn" data-acao="ia-aviso" data-num="'+esc(n)+'" data-foco="iaavtent-'+esc(n)+'">Tentar de novo</button> '+
      '<button type="button" class="nov-btn" data-acao="ia-aviso-cancelar" data-num="'+esc(n)+'" data-foco="iaavcanc-'+esc(n)+'">Cancelar</button></p>';
  }
  return h+'</div>';
}

/* Prazo em dias escrito no ato. A data NUNCA vem da IA: o servidor a calcula na prévia. */
function blocoPrazo(n,e){
  var p=e.dados.prazo;
  if(!p)return '';
  var h='<div class="pvia-sec"><span class="pvia-rot">Prazo escrito no ato</span>'+
    '<p class="pvia-prazo">'+esc(p.dias)+' '+esc(tipoTxt(p.tipo))+(p.tipo?'':' (o ato não diz se são úteis ou corridos)')+'</p>';
  if(!p.calculavel)return h+'<p class="pvia-vazio">'+SEM_CALCULO+'</p></div>';
  if(!e.aviso){
    h+='<p><button type="button" class="nov-btn" data-acao="ia-aviso" data-num="'+esc(n)+'" data-foco="iaaviso-'+esc(n)+
      '" title="Mostra a data calculada e as premissas. Nada é criado até você confirmar.">Criar aviso no calendário</button></p>';
  }else h+=corpoAviso(n,e);
  return h+'</div>';
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
  }else if(e.fase==='recusa'&&e.motivo==='sem_plano'){
    h+=semPlano(RECUSAS.sem_plano);
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
  e.ctrl=ctrl;e.fase='analisando';e.dados=null;
  fetch('/v1/acompanhamentos/'+encodeURIComponent(n)+'/analise',{method:'POST',headers:cabecalhos(),
    body:JSON.stringify({chaveDoAto:e.chave}),signal:ctrl?ctrl.signal:undefined})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(b){return {ok:r.ok,b:b}})})
    .then(function(x){
      if(E[n]!==e||!e.aberto)return;
      e.ctrl=null;
      if(x.ok&&x.b.estado==='verificada'){e.fase='resultado';e.dados=x.b;refrescar(n,'Análise concluída. Confira no ato.');return}
      if(x.ok&&x.b.estado==='nao_verificada'){e.fase='nao_verificada';refrescar(n,NAO_VERIFICADO);return}
      var motivo=x.b&&x.b.detalhes?x.b.detalhes.motivo:'';
      if(!x.ok&&motivo&&RECUSAS[motivo]){e.fase='recusa';e.motivo=motivo;refrescar(n,motivo==='sem_plano'?textoSemPlano(RECUSAS.sem_plano):RECUSAS[motivo]);return}
      e.fase='erro';refrescar(n,ERRO);
    })
    .catch(function(err){
      if(E[n]!==e||!e.aberto)return;
      if(err&&err.name==='AbortError')return;
      e.ctrl=null;e.fase='erro';refrescar(n,ERRO);
    });
}

function avisoRespostaDe(r){return r.json().catch(function(){return {}}).then(function(b){return {ok:r.ok,status:r.status,b:b}})}
function avisoMotivo(x){return x.b&&x.b.detalhes?x.b.detalhes.motivo:''}

/* Prévia: não grava nada. Se o ato não diz o tipo e a pessoa ainda não escolheu, o servidor pede. */
function avisoPrevia(n){
  var e=E[n],a=e&&e.aviso;
  if(!a)return;
  a.fase='calculando';a.msg='';
  var corpoPedido={};
  if(a.tipo)corpoPedido.tipo=a.tipo;
  fetch('/v1/analises/'+encodeURIComponent(e.dados.id)+'/aviso/previa',{method:'POST',headers:cabecalhos(),body:JSON.stringify(corpoPedido)})
    .then(avisoRespostaDe)
    .then(function(x){
      if(E[n]!==e||e.aviso!==a)return;
      if(x.ok){a.fase='previa';a.previa=x.b;a.data=x.b.dataFinal;refrescar(n,'Prévia do aviso pronta. Confira a data.','iaavconf-'+n);return}
      var m=avisoMotivo(x);
      if(m==='tipo_necessario'){a.fase='escolha';refrescar(n,'Escolha dias úteis ou corridos.','iaavtipo-'+n);return}
      a.fase='erro';a.msg=MSG_AVISO[m]||ERRO_AVISO;refrescar(n,a.msg,'iaavtent-'+n);
    })
    .catch(function(){
      if(E[n]!==e||e.aviso!==a)return;
      a.fase='erro';a.msg=ERRO_AVISO;refrescar(n,a.msg,'iaavtent-'+n);
    });
}

/* Confirmação: o servidor recalcula e cria o evento. Sem este clique, nada foi gravado. */
function avisoConfirmar(n){
  var e=E[n],a=e&&e.aviso;
  if(!a||a.fase!=='previa')return;
  var campo=document.getElementById('pvia-data-'+n);
  var data=campo?campo.value:'';
  var corpoPedido={dataLocal:data};
  if(a.tipo)corpoPedido.tipo=a.tipo;
  a.fase='criando';a.msg='';
  refrescar(n,'Criando o aviso…');
  fetch('/v1/analises/'+encodeURIComponent(e.dados.id)+'/aviso',{method:'POST',headers:cabecalhos(),body:JSON.stringify(corpoPedido)})
    .then(avisoRespostaDe)
    .then(function(x){
      if(E[n]!==e||e.aviso!==a)return;
      if(x.ok){
        a.fase='criado';
        a.msg='Aviso criado no calendário para '+br(x.b.dataLocal)+(x.b.calculado?'. A data é calculada: confira no processo.':'. A data foi editada por você.');
        refrescar(n,a.msg);return;
      }
      if(x.status===400){a.fase='previa';a.msg='Data inválida. Escolha uma data no seletor.';a.data=data;refrescar(n,a.msg,'iaavconf-'+n);return}
      var m=avisoMotivo(x);
      a.fase='erro';a.msg=MSG_AVISO[m]||ERRO_AVISO;refrescar(n,a.msg,'iaavtent-'+n);
    })
    .catch(function(){
      if(E[n]!==e||e.aviso!==a)return;
      a.fase='erro';a.msg=ERRO_AVISO;refrescar(n,a.msg,'iaavtent-'+n);
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
  E[n]={aberto:true,chave:chave,fase:'analisando',ctrl:null,dados:null,motivo:''};
  iniciar(n);
  L.redesenhar('iap-'+n);
  L.anunciar('Analisando o ato. Isso pode levar até um minuto.');
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
  if(acao==='ia-aviso'){
    var e=E[n];
    if(!e||!e.dados||!e.dados.prazo||!e.dados.prazo.calculavel)return;
    e.aviso={fase:e.dados.prazo.tipo?'calculando':'escolha',tipo:'',msg:'',previa:null,data:''};
    if(e.aviso.fase==='calculando'){refrescar(n,'Calculando a data…');avisoPrevia(n)}
    else refrescar(n,'Escolha dias úteis ou corridos.','iaavtipo-'+n);
    return;
  }
  if(acao==='ia-aviso-calcular'){
    var ev=E[n];
    if(!ev||!ev.aviso)return;
    var marcado=document.querySelector('input[name="pvia-tipo-'+n+'"]:checked');
    if(!marcado)return;
    ev.aviso.tipo=marcado.value;
    refrescar(n,'Calculando a data…');
    avisoPrevia(n);
    return;
  }
  if(acao==='ia-aviso-confirmar'){avisoConfirmar(n);return}
  if(acao==='ia-aviso-cancelar'){
    var ec=E[n];
    if(ec){ec.aviso=null;refrescar(n,'Aviso cancelado. Nada foi criado.','iaaviso-'+n)}
  }
}

/* Escolher úteis ou corridos ativa o "Calcular" (v0.40.1). Atualiza o botão no lugar, sem redesenhar o
   painel: o foco fica no rádio e o leitor de tela não perde a posição. */
document.addEventListener('change',function(ev){
  var r=ev.target;
  if(!r||r.type!=='radio'||String(r.name||'').indexOf('pvia-tipo-')!==0)return;
  var n=r.name.slice(10),e=E[n];
  if(!e||!e.aviso)return;
  e.aviso.escolha=r.value;
  var b=document.querySelector('#pvia-'+n+' [data-acao="ia-aviso-calcular"]');
  if(b)b.disabled=false;
});

/* "Ver planos" (v0.50.0): vai a "Minha conta", onde ficam os planos contratáveis. Um ouvinte só, para o
   painel da análise e o do resumo. */
document.addEventListener('click',function(ev){
  var b=ev.target&&ev.target.closest?ev.target.closest('[data-pv-planos]'):null;
  if(!b)return;
  ev.preventDefault();
  if(window.__processovivo_ir)window.__processovivo_ir('conta');
});

/* Esc fecha o painel em que o foco está e devolve o foco ao botão da linha. */
document.addEventListener('keydown',function(ev){
  if(ev.key!=='Escape')return;
  var p=ev.target&&ev.target.closest?ev.target.closest('.pvia'):null;
  if(!p)return;
  var id=p.getAttribute('id')||'';
  var n=id.indexOf('pvia-')===0?id.slice(5):'';
  if(n&&E[n]){ev.preventDefault();fechar(n,E[n].fase==='analisando'?'Análise cancelada.':'')}
});

window.__pvAnaliseIA={carregar:carregar,habilitada:habilitada,resumoLigado:resumoLigado,ligar:ligar,botao:botao,painel:painel,clicar:clicar,
  semPlano:semPlano,textoSemPlano:textoSemPlano};
})();
`;

export const ESTILOS_ANALISE_IA = `
.pvia-btn-t{display:none}
.pvia-btn[aria-expanded="true"]{background:var(--acento-bg);border-color:var(--acento);color:var(--acento)}
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
.pvia-prazo{margin:0 0 6px;font-weight:700}
.pvia-aviso-cal{margin:6px 0;padding:10px 12px;border:1px solid var(--linha);border-radius:var(--r);background:var(--papel)}
.pvia-conferir{color:var(--tinta2);font-weight:700}
.pvia-alerta{margin:8px 0;font-weight:700;color:var(--tinta)}
.pvia-erro{margin:6px 0;color:var(--erro,#b3261e);font-weight:700}
.pvia-tipos label{margin-right:12px}
.pvia-vazio{margin:0;color:var(--tinta2)}
.pvia-lista li{margin:0 0 6px}
.pvia-cit{margin:4px 0 0;padding:6px 10px;border-left:3px solid var(--linha);background:var(--papel);color:var(--tinta2);font-style:italic}
.pvia-cit mark{background:var(--atencao-bg);color:var(--tinta);padding:0 2px;border-radius:3px;font-style:normal}
.pvia-proc{display:flex;align-items:flex-start;gap:8px;margin:10px 0 6px;font-size:12.5px;color:var(--tinta2)}
.pvia-selo{flex:none;display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;
  background:var(--acento-bg);color:var(--acento);border:1px solid var(--acento);cursor:help}
.pvia-ok{font-size:12.5px;color:var(--verde-tinta);font-weight:700}
.pvia-aviso{margin:10px 0 0;font-size:12.5px;color:var(--tinta2)}
.pvia button:focus-visible,.pvia-btn:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
@media (max-width:1023px){
  .nvt-tabela tr.pvia-linha{display:block;margin:-4px 0 10px}
  .nvt-tabela tr.pvia-linha td{display:block;padding:0}
  .nvt-tabela tr.pvia-linha td::before{content:none}
  .pvia .nov-btn{min-height:44px}
  .pvia-btn-t{display:inline}
}
`;
