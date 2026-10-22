/**
 * Tela do CALENDÁRIO (v0.32.0) e o link `/?processo=<número>`.
 *
 * Arquivo próprio pela mesma razão do leitor: `script.ts` já passa de 2.400
 * linhas, e há teste que impede o arquivo de crescer. O calendário conversa com
 * o console por dois ganchos, e só por eles:
 *
 * - `window.__pv` (exposto por script.ts): `api`, `esc`, `explicar`,
 *   `erroBloco`, `vazio`, `abrir`.
 * - `window.__pvCalendario.ver(alvo)`, chamado pelo `render()` do console
 *   quando a aba é "Calendário"; e `window.__pvAoIniciar()`, chamado quando a
 *   sessão abre — é ele que atende o link `/?processo=<número>` que o feed põe
 *   na descrição de cada evento.
 *
 * Regras da tela, todas da especificação e do CLAUDE.md:
 * - sugerido se distingue por RÓTULO escrito ("Sugerido"), não só por cor, e
 *   carrega a procedência ("lido do andamento de dd/mm/aaaa") e o link para o
 *   andamento;
 * - nada aqui afirma prazo: o tipo "prazo" é sempre uma data LIDA do texto, e
 *   a tela diz isso;
 * - descartados não somem calados: a tela diz quantos estão fora da lista;
 * - nenhum "carregando" sem fim: toda chamada termina em conteúdo, vazio
 *   honesto ou erro dito;
 * - sem o recurso no plano, a mensagem do servidor (402/403) e mais nada — o
 *   resto do console não muda.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao
 * tsc e ao ESLint. `tests/http/console-script.spec.ts` roda o ESLint aqui
 * dentro também. Todo texto vindo do servidor passa por `esc()`.
 */
export const SCRIPT_CALENDARIO = String.raw`
(function(){
var VISAO='processovivo.calendario.visao';
var TIPOS={audiencia:'Audiência',pericia:'Perícia',prazo:'Prazo',reuniao:'Reunião',outro:'Compromisso'};
var MESES=['janeiro','fevereiro','março','abril','maio','junho','julho','agosto',
  'setembro','outubro','novembro','dezembro'];
var SEMANA=['domingo','segunda','terça','quarta','quinta','sexta','sábado'];
var SEMANA_CURTA=['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

var st={visao:lerVisao(),mes:'',eventos:[],total:0,totalNoIntervalo:0,
  verDescartados:false,carteira:null,feed:null,resumo:null,urlNova:'',editando:null,
  criando:false,selecionado:'',alvo:null,pedido:0};

function pv(){return window.__pv}
function $(i){return document.getElementById(i)}
function esc(s){return pv().esc(s)}

function lerVisao(){
  try{var v=localStorage.getItem(VISAO);return v==='mes'?'mes':'agenda'}catch(e){return 'agenda'}
}
function guardarVisao(v){try{localStorage.setItem(VISAO,v)}catch(e){}}

/* ---------- datas: sempre AAAA-MM-DD de São Paulo, nunca instante ----------
   O evento é um dia na agenda, não um instante. Converter "2026-11-12" para
   Date e de volta joga o dia para trás a oeste de Greenwich; por isso a conta
   de calendário usa Date.UTC só como calculadora, e o "hoje" vem do fuso de
   São Paulo. */
function hoje(){
  try{return new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'})}
  catch(e){return new Date().toISOString().slice(0,10)}
}
function partes(d){return d.split('-').map(Number)}
function utc(d){var p=partes(d);return Date.UTC(p[0],p[1]-1,p[2],12)}
function iso(ms){return new Date(ms).toISOString().slice(0,10)}
function somarDias(d,n){return iso(utc(d)+n*86400000)}
function inicioDoMes(d){return d.slice(0,8)+'01'}
function somarMeses(d,n){
  var p=partes(d);var x=new Date(Date.UTC(p[0],p[1]-1+n,1,12));return iso(x.getTime())
}
function fimDoMes(d){return somarDias(somarMeses(inicioDoMes(d),1),-1)}
function diaDaSemana(d){return new Date(utc(d)).getUTCDay()}
function br(d){var p=String(d||'').split('-');return p.length===3?p[2]+'/'+p[1]+'/'+p[0]:'—'}
function brDeInstante(isoTxt){
  try{return new Date(isoTxt).toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})}
  catch(e){return '—'}
}
function nomeDoMes(d){var p=partes(d),m=MESES[p[1]-1];return m.charAt(0).toUpperCase()+m.slice(1)+' de '+p[0]}
/* A grade do mês começa no domingo (semana brasileira) e fecha no sábado. */
function intervaloDaVisao(){
  var ini=inicioDoMes(st.mes), fim=fimDoMes(st.mes);
  if(st.visao==='agenda')return {de:ini,ate:fim};
  return {de:somarDias(ini,-diaDaSemana(ini)),ate:somarDias(fim,6-diaDaSemana(fim))};
}

/* ---------- entrada ---------- */
function ver(alvo){
  st.alvo=alvo;
  /* A URL do feed aparece UMA vez: sair da tela e voltar não a mostra de
     novo — quem a perdeu regenera. */
  st.urlNova='';
  if(!st.mes)st.mes=inicioDoMes(hoje());
  alvo.innerHTML='<div class="cal" id="cal">'+
    '<div class="cal-topo"><h2 class="cal-h">Calendário</h2>'+
      '<div class="cal-acoes-topo">'+
        '<button class="bt" type="button" id="cal-novo">Novo evento</button>'+
        '<button class="bt bt2" type="button" id="cal-assinar" aria-expanded="false" '+
          'aria-controls="cal-feed">Assinar no meu calendário</button>'+
      '</div></div>'+
    '<div id="cal-feed" class="oculto"></div>'+
    '<div id="cal-form"></div>'+
    '<div class="cal-barra" role="toolbar" aria-label="Navegação do calendário">'+
      '<div class="cal-nav">'+
        '<button class="bt bt2" type="button" id="cal-ant" aria-label="Mês anterior">&larr;</button>'+
        '<button class="bt bt2" type="button" id="cal-hoje">Hoje</button>'+
        '<button class="bt bt2" type="button" id="cal-prox" aria-label="Próximo mês">&rarr;</button>'+
        '<h3 class="cal-mes" id="cal-mes" aria-live="polite"></h3>'+
      '</div>'+
      '<div class="cal-visoes" role="group" aria-label="Visão">'+
        '<button class="bt bt2" type="button" id="cal-v-agenda">Agenda</button>'+
        '<button class="bt bt2" type="button" id="cal-v-mes">Mês</button>'+
      '</div></div>'+
    '<div id="cal-corpo"><div class="cartao"><span class="gira"></span>Carregando…</div></div>'+
    '<p class="nota">Datas de audiência, perícia e prazo marcadas como <strong>Sugerido</strong> '+
      'foram lidas automaticamente do texto do andamento e só valem depois que você confirma. '+
      'O Processo Vivo não calcula prazo: confira sempre no ato completo.</p>'+
  '</div>';
  $('cal-ant').addEventListener('click',function(){st.mes=somarMeses(st.mes,-1);carregar()});
  $('cal-prox').addEventListener('click',function(){st.mes=somarMeses(st.mes,1);carregar()});
  $('cal-hoje').addEventListener('click',function(){st.mes=inicioDoMes(hoje());carregar()});
  $('cal-v-agenda').addEventListener('click',function(){trocarVisao('agenda')});
  $('cal-v-mes').addEventListener('click',function(){trocarVisao('mes')});
  $('cal-novo').addEventListener('click',function(){abrirFormulario(null)});
  $('cal-assinar').addEventListener('click',alternarFeed);
  carregar();
}

function trocarVisao(v){st.visao=v;guardarVisao(v);st.selecionado='';carregar()}

function carregar(){
  var corpo=$('cal-corpo'); if(!corpo)return;
  $('cal-mes').textContent=nomeDoMes(st.mes);
  $('cal-v-agenda').setAttribute('aria-pressed',String(st.visao==='agenda'));
  $('cal-v-mes').setAttribute('aria-pressed',String(st.visao==='mes'));
  var r=intervaloDaVisao();
  var pedido=++st.pedido;
  corpo.innerHTML='<div class="cartao"><span class="gira"></span>Carregando…</div>';
  var estados=st.verDescartados?'':'&estado=sugerido,confirmado';
  pv().api('/v1/calendario/eventos?de='+r.de+'&ate='+r.ate+estados).then(function(res){
    // Resposta de um mês que a pessoa já deixou para trás: ignora.
    if(pedido!==st.pedido)return;
    st.eventos=res.eventos||[];st.total=res.total||0;st.totalNoIntervalo=res.totalNoIntervalo||0;
    desenhar();
  }).catch(function(e){if(pedido===st.pedido)corpo.innerHTML=erroDoCalendario(e)});
}

/* 402 e 403 aqui são do PLANO, não do tribunal: a mensagem do servidor já diz
   qual dos dois e o que fazer — "explicar()" do console traduziria o 403 como
   "o tribunal não liberou o arquivo", que é outra conversa. */
function erroDoCalendario(e){
  if(e&&(e.status===402||e.status===403)){
    return '<div class="cartao cal-indisponivel" role="status"><h3 class="sec">Calendário indisponível</h3>'+
      '<p>'+esc(e.message)+'</p></div>';
  }
  return pv().erroBloco(e);
}

/* ---------- desenho ---------- */
function desenhar(){
  var corpo=$('cal-corpo'); if(!corpo)return;
  var h='';
  var fora=st.totalNoIntervalo-st.total;
  if(fora>0||st.verDescartados){
    h+='<div class="cal-filtro nota" role="status">'+
      (st.verDescartados?'Mostrando também os descartados. ':
        fora+' evento(s) descartado(s) fora da lista. ')+
      '<button class="link" type="button" id="cal-descartados">'+
        (st.verDescartados?'Esconder descartados':'Mostrar descartados')+'</button></div>';
  }
  h+=st.visao==='mes'?grade():agenda(st.eventos);
  corpo.innerHTML=h;
  var b=$('cal-descartados');
  if(b)b.addEventListener('click',function(){st.verDescartados=!st.verDescartados;carregar()});
  ligarEventos(corpo);
  if(st.visao==='mes')ligarGrade(corpo);
}

function porDia(lista){
  var m={};
  lista.forEach(function(e){(m[e.dataLocal]=m[e.dataLocal]||[]).push(e)});
  return m;
}

function agenda(lista){
  if(!lista.length){
    return pv().vazio('📅','Nenhum evento em '+nomeDoMes(st.mes),
      'Audiências e perícias lidas dos andamentos aparecem aqui como sugestões. '+
      'Você também pode criar um evento em "Novo evento".');
  }
  var dias=porDia(lista), h='', hj=hoje();
  Object.keys(dias).sort().forEach(function(d){
    var p=partes(d);
    h+='<section class="cal-dia'+(d===hj?' cal-hoje':'')+'" aria-label="'+
      esc(SEMANA[diaDaSemana(d)]+', '+br(d))+'">'+
      '<h4 class="cal-dia-t"><span class="cal-dia-n">'+p[2]+'</span> '+
      esc(SEMANA[diaDaSemana(d)])+', '+esc(br(d))+(d===hj?' <span class="selo nv">hoje</span>':'')+
      '</h4>';
    dias[d].forEach(function(e){h+=cartaoDoEvento(e)});
    h+='</section>';
  });
  return h;
}

function seloDoEstado(e){
  if(e.estado==='sugerido')return '<span class="selo pr cal-sug">Sugerido</span>';
  if(e.estado==='descartado')return '<span class="selo neutro">Descartado</span>';
  return '<span class="selo ok">Confirmado</span>';
}

function cartaoDoEvento(e){
  var quando=e.horaLocal?e.horaLocal+(e.duracaoMin?' · '+e.duracaoMin+' min':''):'Dia inteiro';
  var h='<article class="cartao cal-ev cal-'+esc(e.estado)+'" id="cal-ev-'+esc(e.id)+'" '+
    'aria-labelledby="cal-ev-t-'+esc(e.id)+'">'+
    '<div class="cal-ev-cab"><span class="cal-quando">'+esc(quando)+'</span>'+
      seloDoEstado(e)+'<span class="selo neutro">'+esc(TIPOS[e.tipo]||e.tipo)+'</span></div>'+
    '<h5 class="cal-ev-t" id="cal-ev-t-'+esc(e.id)+'">'+esc(e.titulo)+'</h5>'+
    '<div class="cal-ev-proc">Processo '+
      '<button class="link" type="button" data-cal-abrir="'+esc(e.numeroProcesso)+'">'+
        esc(e.numeroFormatado)+'</button>'+
      (e.segredoJustica?' <span class="selo al">segredo de justiça</span>':'')+
      ' · '+esc(e.tribunal||'')+'</div>';
  if(e.revisar){
    h+='<div class="cal-revisar" role="note"><strong>Confira:</strong> o andamento mais recente '+
      'sugere mudança nesta data.</div>';
  }
  if(e.procedencia){
    h+='<div class="cal-proc">Lido do andamento de '+esc(brDeInstante(e.procedencia.dataDoAndamento))+
      ' — <button class="link" type="button" data-cal-andamento="'+esc(e.numeroProcesso)+'" '+
      'data-quando="'+esc(e.procedencia.dataDoAndamento)+'">ver o andamento</button>'+
      (e.procedencia.trecho?'<blockquote class="cal-trecho">“'+esc(e.procedencia.trecho)+'”</blockquote>':'')+
      (e.tipo==='prazo'?'<div class="nota">Data escrita no andamento, não um prazo calculado.</div>':'')+
      '</div>';
  }else{
    h+='<div class="cal-proc">Criado por você.</div>';
  }
  if(e.observacao)h+='<div class="cal-obs"><span class="nota">Sua observação:</span> '+esc(e.observacao)+'</div>';
  if(e.estado!=='descartado'){
    h+='<div class="cal-ev-acoes">'+
      (e.estado==='sugerido'?'<button class="bt" type="button" data-cal-confirmar="'+esc(e.id)+'">Confirmar</button>':'')+
      '<button class="bt bt2" type="button" data-cal-editar="'+esc(e.id)+'">Editar</button>'+
      '<button class="bt bt2" type="button" data-cal-descartar="'+esc(e.id)+'">Descartar</button>'+
      '</div>';
  }
  return h+'</article>';
}

function grade(){
  var r=intervaloDaVisao(), dias=porDia(st.eventos), hj=hoje(), mes=st.mes.slice(0,7);
  var h='<div class="cal-grade" aria-label="'+esc(nomeDoMes(st.mes))+'">'+
    '<div class="cal-sem" aria-hidden="true">';
  SEMANA_CURTA.forEach(function(s,i){
    h+='<div class="cal-sem-d" title="'+SEMANA[i]+'">'+s+'</div>';
  });
  h+='</div>';
  for(var d=r.de;d<=r.ate;d=somarDias(d,1)){
    if(diaDaSemana(d)===0)h+='<div class="cal-linha">';
    var lista=dias[d]||[], sug=lista.filter(function(e){return e.estado==='sugerido'}).length;
    var rotulo=br(d)+(lista.length?', '+lista.length+' evento(s)'+(sug?', '+sug+' sugerido(s)':''):', sem eventos');
    h+='<div class="cal-cel'+(d.slice(0,7)!==mes?' cal-fora':'')+(d===hj?' cal-hoje':'')+
      (d===st.selecionado?' cal-sel':'')+'">'+
      '<button type="button" class="cal-cel-b" data-cal-dia="'+d+'" aria-label="'+esc(rotulo)+'"'+
        (d===st.selecionado?' aria-pressed="true"':'')+'>'+
        '<span class="cal-cel-n">'+partes(d)[2]+'</span>'+
        (lista.length?'<span class="cal-cont'+(sug?' cal-cont-sug':'')+'" aria-hidden="true">'+lista.length+(sug?' sug.':'')+'</span>':'')+
      '</button>';
    lista.slice(0,3).forEach(function(e){
      h+='<span class="cal-chip cal-chip-'+esc(e.estado)+'" aria-hidden="true">'+
        (e.estado==='sugerido'?'<b>Sugerido</b> ':'')+esc(e.horaLocal||'')+' '+esc(TIPOS[e.tipo]||'')+'</span>';
    });
    if(lista.length>3)h+='<span class="cal-mais" aria-hidden="true">+'+(lista.length-3)+'</span>';
    h+='</div>';
    if(diaDaSemana(d)===6)h+='</div>';
  }
  h+='</div><div id="cal-detalhe-dia">'+detalheDoDia()+'</div>';
  return h;
}

function detalheDoDia(){
  if(!st.selecionado)return '<p class="nota">Escolha um dia para ver os eventos.</p>';
  var lista=st.eventos.filter(function(e){return e.dataLocal===st.selecionado});
  if(!lista.length)return '<p class="nota">Nenhum evento em '+esc(br(st.selecionado))+'.</p>';
  return agenda(lista);
}

function ligarGrade(corpo){
  Array.prototype.forEach.call(corpo.querySelectorAll('[data-cal-dia]'),function(b){
    b.addEventListener('click',function(){
      st.selecionado=b.getAttribute('data-cal-dia');desenhar();
      var alvo=document.querySelector('[data-cal-dia="'+st.selecionado+'"]');
      if(alvo)alvo.focus();
    });
  });
}

function acharEvento(id){
  for(var i=0;i<st.eventos.length;i++)if(st.eventos[i].id===id)return st.eventos[i];
  return null;
}

function ligarEventos(corpo){
  function cada(attr,fn){
    Array.prototype.forEach.call(corpo.querySelectorAll('['+attr+']'),function(b){
      b.addEventListener('click',function(){fn(b.getAttribute(attr),b)});
    });
  }
  cada('data-cal-confirmar',function(id,b){mudar(b,'/v1/calendario/eventos/'+encodeURIComponent(id),
    {method:'PATCH',body:{estado:'confirmado'}})});
  cada('data-cal-descartar',function(id,b){
    if(!window.confirm('Descartar este evento? Uma sugestão descartada não volta a ser sugerida.'))return;
    mudar(b,'/v1/calendario/eventos/'+encodeURIComponent(id)+'/descartar',{method:'POST'});
  });
  cada('data-cal-editar',function(id){abrirFormulario(acharEvento(id))});
  cada('data-cal-abrir',function(numero){pv().abrir(numero)});
  cada('data-cal-andamento',function(numero,b){irAoAndamento(numero,b.getAttribute('data-quando'))});
}

function mudar(botao,caminho,opcoes){
  botao.disabled=true;
  pv().api(caminho,opcoes).then(carregar).catch(function(e){
    botao.disabled=false;window.alert(e&&e.status?e.message:pv().explicar(e));
  });
}

/* ---------- ir ao andamento ----------
   Abre o processo e procura, na linha do tempo, o andamento de onde a data foi
   lida (marcado com data-quando). Se ele estiver recolhido num filtro ou entre
   os internos, a tela diz isso em vez de rolar para lugar nenhum. */
function irAoAndamento(numero,quando){
  pv().abrir(numero);
  var inicio=Date.now();
  var t=setInterval(function(){
    var alvo=document.querySelector('.ev[data-quando="'+quando+'"]');
    if(alvo){
      clearInterval(t);
      alvo.classList.add('cal-alvo');alvo.setAttribute('tabindex','-1');
      alvo.scrollIntoView({block:'center'});alvo.focus();
      return;
    }
    if(Date.now()-inicio>20000){
      clearInterval(t);
      var c=$('conteudo');
      if(c&&c.querySelector('.capa')){
        var n=document.createElement('div');
        n.className='aviso';n.setAttribute('role','status');
        n.textContent='O andamento de '+brDeInstante(quando)+' não está visível na linha do tempo — '+
          'pode estar recolhido entre os internos ou num filtro.';
        c.insertBefore(n,c.firstChild.nextSibling);
      }
    }
  },300);
}

/* ---------- formulário: novo e editar ---------- */
function opcoesDeTipo(atual){
  return Object.keys(TIPOS).map(function(t){
    return '<option value="'+t+'"'+(t===atual?' selected':'')+'>'+TIPOS[t]+'</option>'}).join('');
}

function abrirFormulario(evento){
  st.editando=evento;
  var alvo=$('cal-form'); if(!alvo)return;
  var e=evento||{tipo:'reuniao',titulo:'',dataLocal:hoje(),horaLocal:'',duracaoMin:'',observacao:''};
  var h='<form class="cartao cal-formulario" id="cal-f" novalidate>'+
    '<h3 class="sec" id="cal-f-t">'+(evento?'Editar evento':'Novo evento')+'</h3>'+
    (evento&&evento.origem==='detectado'?'<p class="nota">A data veio de um andamento. Corrigir '+
      'aqui não muda o andamento; a procedência continua registrada.</p>':'')+
    '<div class="cal-campos">'+
    '<div class="cal-c"><label for="cal-f-tipo">Tipo</label><select id="cal-f-tipo">'+opcoesDeTipo(e.tipo)+'</select></div>'+
    '<div class="cal-c cal-c-largo"><label for="cal-f-titulo">Título</label>'+
      '<input id="cal-f-titulo" maxlength="140" required value="'+esc(e.titulo)+'"></div>';
  if(!evento){
    h+='<div class="cal-c cal-c-largo"><label for="cal-f-proc">Processo</label>'+
      '<input id="cal-f-proc" list="cal-f-procs" required autocomplete="off" '+
        'aria-describedby="cal-f-proc-nota" placeholder="Número, apelido ou cliente">'+
      '<datalist id="cal-f-procs"></datalist>'+
      '<div class="nota" id="cal-f-proc-nota">Só processos da sua carteira.</div></div>';
  }
  h+='<div class="cal-c"><label for="cal-f-data">Data</label>'+
      '<input id="cal-f-data" type="date" required value="'+esc(e.dataLocal)+'"></div>'+
    '<div class="cal-c"><label for="cal-f-hora">Hora (opcional)</label>'+
      '<input id="cal-f-hora" type="time" value="'+esc(e.horaLocal||'')+'"></div>'+
    '<div class="cal-c"><label for="cal-f-dur">Duração em minutos (opcional)</label>'+
      '<input id="cal-f-dur" type="number" min="1" max="1440" inputmode="numeric" value="'+esc(e.duracaoMin||'')+'"></div>'+
    '<div class="cal-c cal-c-largo"><label for="cal-f-obs">Observação (só para você; não vai para o feed)</label>'+
      '<textarea id="cal-f-obs" maxlength="1000" rows="2">'+esc(e.observacao||'')+'</textarea></div>'+
    '</div>'+
    '<div class="cal-erro" id="cal-f-erro" role="alert"></div>'+
    '<div class="cal-ev-acoes"><button class="bt" type="submit" id="cal-f-salvar">'+
      (evento&&evento.estado==='sugerido'?'Salvar e confirmar':'Salvar')+'</button>'+
    '<button class="bt bt2" type="button" id="cal-f-cancelar">Cancelar</button></div></form>';
  alvo.innerHTML=h;
  $('cal-f-cancelar').addEventListener('click',fecharFormulario);
  $('cal-f').addEventListener('submit',function(ev){ev.preventDefault();salvar()});
  $('cal-f').addEventListener('keydown',function(ev){if(ev.key==='Escape')fecharFormulario()});
  if(!evento)carregarCarteira();
  $('cal-f-titulo').focus();
}

function fecharFormulario(){
  st.editando=null;var a=$('cal-form');if(a)a.innerHTML='';
  var b=$('cal-novo');if(b)b.focus();
}

/* A busca de processo é um datalist da própria carteira: o valor é o número,
   o rótulo mostra apelido, cliente e as partes — é por eles que o advogado
   procura. Carregado uma vez por abertura do formulário. */
function carregarCarteira(){
  pv().api('/v1/acompanhamentos?ordem=NUMERO').then(function(r){
    st.carteira=r.acompanhamentos||[];
    var dl=$('cal-f-procs');if(!dl)return;
    dl.innerHTML=st.carteira.map(function(a){
      var rot=[a.apelido,a.cliente,(a.partes||[]).slice(0,2).map(function(p){return p.nome}).join(' x ')]
        .filter(function(x){return x}).join(' · ');
      return '<option value="'+esc(a.numero)+'">'+esc(rot)+'</option>'}).join('');
    if(!st.carteira.length){
      var n=$('cal-f-proc-nota');
      if(n)n.textContent='Sua carteira está vazia: acompanhe um processo antes de criar um evento nele.';
    }
  }).catch(function(){
    var n=$('cal-f-proc-nota');if(n)n.textContent='Não foi possível carregar a carteira; digite o número do processo.';
  });
}

function salvar(){
  var erro=$('cal-f-erro'), botao=$('cal-f-salvar');
  var titulo=$('cal-f-titulo').value.trim(), data=$('cal-f-data').value,
    hora=$('cal-f-hora').value, dur=$('cal-f-dur').value, obs=$('cal-f-obs').value.trim();
  if(!titulo||!data){erro.textContent='Preencha o título e a data.';return}
  if(dur&&!hora){erro.textContent='Evento de dia inteiro não tem duração: informe a hora ou apague a duração.';return}
  var corpo={tipo:$('cal-f-tipo').value,titulo:titulo,dataLocal:data};
  var e=st.editando, caminho, metodo;
  if(e){
    corpo.horaLocal=hora||null;corpo.duracaoMin=dur?Number(dur):null;corpo.observacao=obs||null;
    if(e.estado==='sugerido')corpo.estado='confirmado';
    caminho='/v1/calendario/eventos/'+encodeURIComponent(e.id);metodo='PATCH';
  }else{
    var proc=$('cal-f-proc').value.replace(/\D/g,'');
    if(proc.length!==20){erro.textContent='Escolha um processo da sua carteira (número CNJ com 20 dígitos).';return}
    corpo.numeroProcesso=proc;
    if(hora)corpo.horaLocal=hora;
    if(dur)corpo.duracaoMin=Number(dur);
    if(obs)corpo.observacao=obs;
    caminho='/v1/calendario/eventos';metodo='POST';
  }
  erro.textContent='';botao.disabled=true;
  pv().api(caminho,{method:metodo,body:corpo}).then(function(r){
    fecharFormulario();
    if(r&&r.dataLocal){st.mes=inicioDoMes(r.dataLocal);if(st.visao==='mes')st.selecionado=r.dataLocal}
    carregar();
  }).catch(function(x){
    botao.disabled=false;
    erro.textContent=x&&x.status?x.message:pv().explicar(x);
  });
}

/* ---------- feed ICS ---------- */
function alternarFeed(){
  var p=$('cal-feed'), b=$('cal-assinar');
  var abrir=p.classList.contains('oculto');
  p.classList.toggle('oculto',!abrir);
  b.setAttribute('aria-expanded',String(abrir));
  if(abrir)carregarFeed();
}

function carregarFeed(){
  var p=$('cal-feed');
  p.innerHTML='<div class="cartao"><span class="gira"></span>Carregando…</div>';
  /* O resumo por e-mail é opcional: se a rota falhar, o painel do feed segue sem a opção. */
  var resumo=pv().api('/v1/calendario/resumo').catch(function(){return {disponivel:false,ativo:false}});
  Promise.all([pv().api('/v1/calendario/feed'),resumo])
    .then(function(r){st.feed=r[0];st.resumo=r[1];desenharFeed()})
    .catch(function(e){p.innerHTML=erroDoCalendario(e)});
}

function desenharFeed(){
  var p=$('cal-feed'), f=st.feed||{existe:false};
  var h='<section class="cartao cal-feed" aria-labelledby="cal-feed-t">'+
    '<h3 class="sec" id="cal-feed-t">Assinar no meu calendário</h3>'+
    '<p>O Google Agenda, o Outlook e o Calendário da Apple podem assinar uma URL e mostrar seus '+
    'eventos confirmados ao lado dos outros compromissos. O aplicativo atualiza sozinho, em geral '+
    'de hora em hora (o Google pode levar mais).</p>'+
    '<p class="cal-cuidado"><strong>Quem tiver esta URL vê estes eventos.</strong> Ela leva só o tipo '+
    'e o número do processo — sem partes, sem trecho de andamento, sem suas observações; processo em '+
    'segredo de justiça vai sem número. Regenere se ela vazar.</p>';
  if(st.urlNova){
    h+='<div class="cal-url"><label for="cal-url-i">Sua URL (aparece só agora — copie antes de sair)</label>'+
      '<div class="cal-url-l"><input id="cal-url-i" readonly value="'+esc(st.urlNova)+'">'+
      '<button class="bt" type="button" id="cal-copiar">Copiar</button></div>'+
      '<div class="nota" id="cal-copiado" role="status" aria-live="polite"></div></div>';
  }
  h+='<label class="cal-check"><input type="checkbox" id="cal-sug"'+(f.incluiSugeridos?' checked':'')+'> '+
    'Incluir sugestões ainda não confirmadas (aparecem como "[sugerido]")</label>';
  var lem=f.lembretes||{umDiaAntes:false,umaHoraAntes:false};
  h+='<fieldset class="cal-lembretes"><legend>Lembretes nos eventos confirmados</legend>'+
    '<label class="cal-check"><input type="checkbox" id="cal-lem-dia"'+(lem.umDiaAntes?' checked':'')+'> '+
      '1 dia antes (em evento de dia inteiro: às 09:00 do dia anterior)</label>'+
    '<label class="cal-check"><input type="checkbox" id="cal-lem-hora"'+(lem.umaHoraAntes?' checked':'')+'> '+
      '1 hora antes (em evento de dia inteiro: às 08:00 do próprio dia)</label>'+
    '<p class="nota" id="cal-lem-nota">Só eventos confirmados e que ainda não começaram. Sem nenhuma opção marcada, o feed não leva lembretes. '+
    'Apple Calendário e Outlook costumam mostrar estes lembretes. O Google Agenda pode ignorá-los em calendários '+
    'assinados por URL; se precisar, configure notificações dele em Configurações do calendário &gt; Notificações. '+
    'O aplicativo é quem decide se exibe; nós só incluímos os lembretes no feed.</p>'+
    (f.existe?'':'<p class="nota">Salvos junto com a URL, quando você a criar.</p>')+
    '</fieldset>';
  if(st.resumo&&st.resumo.disponivel){
    h+='<fieldset class="cal-resumo"><legend>Resumo por e-mail</legend>'+
      '<label class="cal-check"><input type="checkbox" id="cal-resumo"'+(st.resumo.ativo?' checked':'')+'> '+
      'Receber resumo dos eventos a confirmar</label>'+
      '<p class="nota" id="cal-resumo-nota">No máximo um e-mail por dia, só quando houver evento novo para confirmar '+
      'ou rever. Ele traz tipo, data e número do processo, e as datas são lidas do andamento: confira no processo.</p></fieldset>';
  }
  if(f.existe){
    h+='<p class="nota">Assinatura ativa desde '+esc(brDeInstante(f.criadoEm))+'. A URL não é mostrada de novo; '+
      'se você não a tem mais, regenere.</p>'+
      '<div class="cal-ev-acoes"><button class="bt bt2" type="button" id="cal-regenerar">Regenerar URL</button>'+
      '<button class="bt bt2" type="button" id="cal-revogar">Revogar</button></div>';
  }else{
    h+='<div class="cal-ev-acoes"><button class="bt" type="button" id="cal-criar">Criar URL de assinatura</button></div>';
  }
  h+='<details class="cal-como"><summary>Como assinar</summary><ul>'+
    '<li><strong>Google Agenda</strong> (no computador): Outras agendas → "+" → <em>Do URL</em> → cole a URL → Adicionar agenda.</li>'+
    '<li><strong>Outlook</strong>: Adicionar calendário → <em>Assinar da Web</em> → cole a URL → Importar.</li>'+
    '<li><strong>Apple</strong> (Mac): Arquivo → <em>Nova Assinatura de Calendário</em>; no iPhone: Ajustes → Calendário → Contas → Adicionar Conta → Outra → <em>Adicionar Calendário Assinado</em>.</li>'+
    '</ul></details>'+
    '<div class="cal-erro" id="cal-feed-erro" role="alert"></div></section>';
  p.innerHTML=h;

  var erro=$('cal-feed-erro');
  function falhou(e){erro.textContent=e&&e.status?e.message:pv().explicar(e)}
  function criar(){
    pv().api('/v1/calendario/feed',{method:'POST',body:{incluiSugeridos:$('cal-sug').checked,lembretes:lembretesDaTela()}})
      .then(function(r){st.urlNova=r.url;st.feed={existe:true,criadoEm:r.criadoEm,incluiSugeridos:r.incluiSugeridos,lembretes:r.lembretes};
        desenharFeed();var i=$('cal-url-i');if(i){i.focus();i.select()}})
      .catch(falhou);
  }
  if($('cal-criar'))$('cal-criar').addEventListener('click',criar);
  if($('cal-regenerar'))$('cal-regenerar').addEventListener('click',function(){
    if(window.confirm('Regenerar a URL? A antiga para de funcionar na hora, em todos os aparelhos que a assinaram.'))criar();
  });
  if($('cal-revogar'))$('cal-revogar').addEventListener('click',function(){
    if(!window.confirm('Revogar a assinatura? Os aplicativos deixam de receber os eventos.'))return;
    pv().api('/v1/calendario/feed',{method:'DELETE'})
      .then(function(){st.urlNova='';st.feed={existe:false};desenharFeed()}).catch(falhou);
  });
  $('cal-sug').addEventListener('change',function(ev){
    if(!st.feed||!st.feed.existe)return;
    var marcado=ev.target.checked;
    pv().api('/v1/calendario/feed',{method:'PATCH',body:{incluiSugeridos:marcado}})
      .then(function(r){st.feed=r;var c=$('cal-copiado')||erro;
        c.textContent=marcado?'Sugestões incluídas no feed.':'Sugestões retiradas do feed.'})
      .catch(function(e){ev.target.checked=!marcado;falhou(e)});
  });
  function lembretesDaTela(){return {umDiaAntes:$('cal-lem-dia').checked,umaHoraAntes:$('cal-lem-hora').checked}}
  ['cal-lem-dia','cal-lem-hora'].forEach(function(id){
    $(id).addEventListener('change',function(ev){
      if(!st.feed||!st.feed.existe)return;
      var antes=!ev.target.checked, c=$('cal-copiado')||erro;
      pv().api('/v1/calendario/feed',{method:'PATCH',body:{lembretes:lembretesDaTela()}})
        .then(function(r){st.feed=r;c.textContent='Lembretes salvos. O aplicativo de calendário atualiza na próxima leitura do feed.'})
        .catch(function(e){ev.target.checked=antes;falhou(e)});
    });
  });
  if($('cal-resumo'))$('cal-resumo').addEventListener('change',function(ev){
    var marcado=ev.target.checked, nota=$('cal-resumo-nota');
    pv().api('/v1/calendario/resumo',{method:'PUT',body:{ativo:marcado}})
      .then(function(r){st.resumo=r;nota.textContent=marcado?'Resumo ligado.':'Resumo desligado. Você não receberá mais este e-mail.'})
      .catch(function(e){ev.target.checked=!marcado;falhou(e)});
  });
  if($('cal-copiar'))$('cal-copiar').addEventListener('click',function(){
    var i=$('cal-url-i'), aviso=$('cal-copiado');
    function feito(){aviso.textContent='URL copiada.'}
    function manual(){i.focus();i.select();
      try{document.execCommand('copy');feito()}catch(x){aviso.textContent='Selecione e copie com Ctrl+C.'}}
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(i.value).then(feito,manual);
    else manual();
  });
}

/* ---------- o link /?processo=<número> ----------
   O feed põe este link na descrição de cada evento. Ele é lido uma vez,
   APAGADO da barra de endereço (para um F5 não reabrir o processo) e atendido
   quando a sessão abre — inclusive depois de a pessoa entrar, se ela chegou
   deslogada. Só número CNJ de 20 dígitos; qualquer outra coisa é ignorada. */
var processoPedido='', abrirResumo=false;
try{
  var busca=new URLSearchParams(location.search);
  var pedido=String(busca.get('processo')||'').replace(/\D/g,'');
  if(busca.has('processo')){
    busca.delete('processo');
    var resto=busca.toString();
    history.replaceState(null,'',location.pathname+(resto?'?'+resto:''));
  }
  if(pedido.length===20)processoPedido=pedido;
  /* v0.51.0: o link do e-mail de resumo (?calendario=resumo) abre a aba Calendário. Só esse valor exato; sai da barra. */
  if(busca.get('calendario')==='resumo')abrirResumo=true;
  if(busca.has('calendario')){
    busca.delete('calendario');
    var resto2=busca.toString();
    history.replaceState(null,'',location.pathname+(resto2?'?'+resto2:''));
  }
}catch(e){}

window.__pvAoIniciar=function(){
  if(abrirResumo){
    abrirResumo=false;
    var nav=$('nav-calendario');
    if(nav){nav.click();var ass=$('cal-assinar');if(ass&&ass.getAttribute('aria-expanded')==='false')ass.click()}
  }
  if(!processoPedido||!pv())return;
  var n=processoPedido;processoPedido='';
  pv().abrir(n);
};
window.__pvCalendario={ver:ver};
})();
`;

/**
 * CSS do calendário. Toda regra mora sob `.cal` (a tela) ou `.cal-alvo` (o
 * destaque do andamento na tela do processo): fora da aba, o console é o de
 * antes. Cores pelas variáveis do console — um significado por cor: âmbar pede
 * providência (sugerido), verde é verificado (confirmado).
 */
export const ESTILOS_CALENDARIO = `
.cal .cal-topo{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.cal .cal-h{margin:0;font-size:22px}
.cal .cal-acoes-topo,.cal .cal-ev-acoes{display:flex;gap:8px;flex-wrap:wrap}
.cal .cal-ev-acoes{margin-top:10px}
.cal .cal-barra{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0}
.cal .cal-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.cal .cal-mes{margin:0 0 0 6px;font-size:17px}
.cal .cal-visoes{display:flex;gap:6px}
.cal .cal-visoes [aria-pressed="true"]{background:var(--acento-bg);border-color:var(--acento);color:var(--tinta)}
.cal .cal-filtro{margin:0 0 10px}
.cal .cal-dia{margin:0 0 14px}
.cal .cal-dia-t{margin:0 0 8px;font-size:14px;color:var(--tinta2);text-transform:capitalize}
.cal .cal-dia-n{font-size:20px;color:var(--tinta);margin-right:4px}
.cal .cal-hoje .cal-dia-t{color:var(--novo)}
.cal .cal-ev{margin:0 0 8px;border-left:4px solid var(--verde)}
.cal .cal-ev.cal-sugerido{border-left:4px dashed var(--atencao-ponto);background:var(--papel)}
.cal .cal-ev.cal-descartado{border-left-color:var(--linha);opacity:.75}
.cal .cal-ev.cal-descartado .cal-ev-t{text-decoration:line-through}
.cal .cal-ev-cab{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cal .cal-quando{font-family:var(--mono);font-weight:700;font-size:14px}
.cal .cal-ev-t{margin:6px 0 4px;font-size:15.5px}
.cal .cal-ev-proc,.cal .cal-proc,.cal .cal-obs{font-size:13.5px;color:var(--tinta2);margin-top:4px;overflow-wrap:anywhere}
.cal .cal-trecho{margin:6px 0 0;padding:6px 10px;border-left:3px solid var(--linha);color:var(--tinta2);font-size:13px}
.cal .cal-revisar{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--atencao-bg);color:var(--atencao);font-size:13.5px}
.cal .cal-grade{border:1px solid var(--linha);border-radius:var(--r);overflow:hidden;background:var(--papel)}
.cal .cal-sem,.cal .cal-linha{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}
.cal .cal-sem-d{padding:6px;font-size:12px;font-weight:700;color:var(--tinta3);text-align:center;border-bottom:1px solid var(--linha)}
.cal .cal-cel{min-height:92px;padding:4px;border-right:1px solid var(--linha2);border-bottom:1px solid var(--linha2);min-width:0;display:flex;flex-direction:column;gap:2px}
.cal .cal-fora{background:var(--papel2);color:var(--tinta3)}
.cal .cal-cel-b{all:unset;box-sizing:border-box;cursor:pointer;display:flex;justify-content:space-between;align-items:center;min-height:28px;padding:2px 4px;border-radius:6px}
.cal .cal-cel-b:hover{background:var(--acento-bg)}
.cal .cal-cel-b:focus-visible{outline:2px solid var(--acento);outline-offset:1px}
.cal .cal-cel-n{font-weight:700;font-size:13px}
.cal .cal-hoje .cal-cel-n{background:var(--botao);color:#fff;border-radius:999px;padding:1px 7px}
.cal .cal-sel{box-shadow:inset 0 0 0 2px var(--acento)}
.cal .cal-cont{font-size:11px;font-weight:700;background:var(--neutro-bg);border-radius:999px;padding:0 6px;display:none}
.cal .cal-chip{font-size:11.5px;line-height:1.3;padding:1px 5px;border-radius:5px;background:var(--verde-bg);color:var(--verde-tinta);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal .cal-chip-sugerido{background:var(--atencao-bg);color:var(--atencao);border:1px dashed var(--atencao-ponto)}
.cal .cal-chip-descartado{background:var(--neutro-bg);color:var(--tinta3);text-decoration:line-through}
.cal .cal-mais{font-size:11px;color:var(--tinta3)}
.cal .cal-cont-sug{background:var(--atencao-bg);color:var(--atencao);border:1px dashed var(--atencao-ponto)}
.cal #cal-detalhe-dia{margin-top:14px}
.cal .cal-campos{display:flex;flex-wrap:wrap;gap:10px}
.cal .cal-c{flex:1 1 160px;min-width:0}
.cal .cal-c-largo{flex:2 1 280px}
.cal .cal-c label,.cal .cal-url label{display:block;font-size:12.5px;color:var(--tinta2);margin-bottom:4px}
.cal textarea{width:100%;padding:9px 12px;font:inherit;color:var(--tinta);background:var(--papel);border:1px solid var(--linha);border-radius:10px}
.cal .cal-erro{color:var(--erro);font-size:13.5px;margin-top:8px;min-height:1em}
.cal .cal-cuidado{background:var(--atencao-bg);border-radius:10px;padding:10px 12px;font-size:13.5px}
.cal .cal-url-l{display:flex;gap:8px}
.cal .cal-url-l input{font-family:var(--mono);font-size:12.5px;min-width:0}
.cal .cal-check{display:flex;gap:8px;align-items:center;margin:10px 0;font-size:14px}
.cal .cal-lembretes,.cal .cal-resumo{margin:14px 0;padding:6px 14px 10px;border:1px solid var(--linha);border-radius:10px;min-width:0}
.cal .cal-lembretes legend,.cal .cal-resumo legend{padding:0 6px;font-weight:700;font-size:14px}
.cal .cal-lembretes .nota,.cal .cal-resumo .nota{overflow-wrap:anywhere}
.cal .cal-como{margin-top:12px;font-size:13.5px}
.cal .cal-como summary{cursor:pointer;font-weight:700}
.cal .cal-indisponivel p{margin:0}
/* --tinta3 sobre o fundo claro dá 4,2–4,4:1 (axe-core): abaixo do mínimo de
   4,5:1 para texto pequeno. Dentro do calendário, nota e selo neutro usam a
   tinta mais escura. */
.cal .nota,.cal .selo.neutro{color:var(--tinta2)}
.ev.cal-alvo{outline:3px solid var(--acento);outline-offset:4px;border-radius:8px}
@media (max-width:560px){
  .cal .cal-cel{min-height:52px}
  .cal .cal-chip,.cal .cal-mais{display:none}
  .cal .cal-cont{display:inline-block}
  .cal .cal-url-l{flex-direction:column}
}
`;
