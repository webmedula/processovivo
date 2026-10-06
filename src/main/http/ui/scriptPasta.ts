/**
 * Script da PASTA DIGITAL (v0.33.0): a lista de todas as peças do processo à
 * esquerda e o visualizador à direita, no estilo da pasta digital do e-SAJ.
 *
 * Substitui o painel "Ler peças ao lado" (v0.31). Arquivo próprio, como o
 * painel antigo era: `script.ts` já passa de 2.400 linhas e não cresce. Fala com
 * o console por dois ganchos, e só por eles:
 *
 * - `window.__pv` (exposto por script.ts): `api`, `esc`, `dth`, `dt`, `chave`…
 * - `window.__pvPasta` (exposto aqui): `aposDesenhar(numero)`, chamado quando a
 *   tela do processo pinta o cartão das peças (é onde o botão "Pasta digital"
 *   ganha o clique); `trocouProcesso(numero)` e `fechar()`, ao navegar.
 *
 * **Sem a Pasta aberta, a tela do processo é exatamente a de antes.** Nada é
 * injetado na linha do tempo; o painel só existe depois do clique, e o CSS dele
 * só age dentro de `#pasta` ou sob `body.com-pasta`.
 *
 * **O clique não é uma chamada.** Clicar numa peça agenda o pedido para daqui a
 * `DEBOUNCE_MS`; outro clique antes disso troca o agendado. O servidor repete a
 * regra (um pedido pendente por processo), de modo que nem uma tela adulterada
 * dispara uma chamada por clique ao tribunal. Peça já guardada abre sem pedido.
 *
 * **Nunca "carregando" sem fim.** Cada espera tem um nome (pedindo, aguardando a
 * fila do tribunal, baixando, abrindo o PDF) e um limite. Passado o limite a
 * tela PARA de consultar e oferece "tentar de novo". O servidor atende o tribunal
 * uma chamada por vez, com pausa de 3 s — se uma montagem está andando, o clique
 * entra na fila dela, e a tela diz isso.
 *
 * O PDF.js vem do PRÓPRIO servidor (`/ui/pdfjs/`), por `import()`. O HTML do
 * tribunal virou texto no servidor, dentro do PDF: este script não insere
 * conteúdo de peça no DOM, só texto do próprio sistema, sempre por `esc()`.
 *
 * Mesmo regime de `script.ts`: é JavaScript dentro de uma string, invisível ao
 * tsc e ao ESLint. `tests/http/console-script.spec.ts` roda o ESLint aqui dentro.
 */
export const SCRIPT_PASTA = String.raw`
(function(){
var LARGURA='processovivo.pasta.lista';
var PDFJS='/ui/pdfjs/';
/* Janela em que cliques seguidos viram um pedido só. */
var DEBOUNCE_MS=400;
/* Uma peça pedida que não chega neste tempo: a tela para e oferece tentar de novo. */
var LIMITE_ESPERA_MS=120*1000;
/* Abrir um PDF que não responde. */
var LIMITE_PDF_MS=30*1000;
/* Montagem sem progresso por este tempo: a tela DIZ. */
var PARADO_MS=3*60*1000;
var MAX_DESENHADAS=24;

var st=novoEstado('');
function novoEstado(numero){
  return {numero:numero,visao:null,aberta:false,sel:{},foco:null,peca:null,modo:'peca',
    busca:'',soDisp:false,clique:null,espera:null,timer:null,erroPoll:0,erroVisao:null,
    carga:0,pdf:null,lib:null,pdfDe:'',zoom:'largura',escala:1,larguraBase:0,alturaBase:0,
    desenhadas:[],observador:null,pagina:1,textos:{},achadas:{id:0,termo:'',paginas:[],i:-1},
    baixando:null,previa:null,msgBaixar:'',confirmouMontar:false,montando:false,
    ultimoAviso:'',ultimoEstado:'',redimensionar:null,gatilho:null,pedidoFalhou:null,pdfUrl:''};
}

/* A calibração do número com o Projudi (v0.35.0) mora em scriptPastaCalibracao.ts. */
var cal=window.__pvPastaCal;
cal.definir({
  numero:function(){return st.numero},
  visao:function(){return st.visao},
  recarregar:function(){return recarregar()}
});

function pv(){return window.__pv}
function $(i){return document.getElementById(i)}
function esc(s){return pv().esc(s)}
function soDigitos(n){return String(n||'').replace(/\D/g,'')}
function base(){return '/v1/processos/'+encodeURIComponent(st.numero)+'/pasta'}
function hora(iso){
  if(!iso)return '—';
  try{return new Date(iso).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',
    hour:'2-digit',minute:'2-digit'})}catch(e){return '—'}
}
function minutos(seg){
  if(seg<60)return 'menos de 1 min';
  var m=Math.round(seg/60);
  return m<=1?'~1 min':'~'+m+' min';
}
function faixa(e){
  var a=minutos(e.minimoSegundos), z=minutos(e.maximoSegundos);
  return a===z?a:'entre '+a+' e '+z;
}
function normal(t){
  return String(t||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
}
function n_pecas(n){return n+' '+(n===1?'peça':'peças')}
function pecaDe(id){
  var l=(st.visao&&st.visao.pecas)||[];
  for(var i=0;i<l.length;i++){if(l[i].pecaId===id)return l[i]}
  return null;
}
function ativoJob(j){
  return !!j&&(j.estado==='na_fila'||j.estado==='baixando'||j.estado==='montando'||
    j.estado==='pausado_por_bloqueio');
}
function transitoria(p){return p.estado==='na_fila'||p.estado==='baixando'}
function agora(){return Date.now()}

/* ---------- o painel ---------- */
function montarPainel(){
  if($('pasta'))return;
  var w=null; try{w=localStorage.getItem(LARGURA)}catch(e){}
  if(w)document.documentElement.style.setProperty('--pasta-lista-w',w);
  var el=document.createElement('aside');
  el.id='pasta';
  el.setAttribute('aria-label','Pasta digital');
  el.innerHTML=
    '<div class="topo">'+
      '<button class="bt bt2" id="pasta-fechar">&larr; Fechar a pasta</button>'+
      '<h3 id="pasta-titulo-geral">Pasta digital</h3>'+
      '<button class="bt" id="pasta-montar">Montar pasta completa</button>'+
      '<button class="bt bt2" id="pasta-tudo" disabled>Ver tudo seguido</button>'+
    '</div>'+
    '<div class="aviso" id="pasta-aviso" role="status" aria-live="polite"></div>'+
    '<div class="pcal-caixa" id="pasta-cal-caixa"></div>'+
    '<div class="pcal-editor" id="pasta-cal-editor" hidden role="group" '+
      'aria-label="Informar o número do ato no Projudi"></div>'+
    '<div class="corpo">'+
      '<section class="lista" id="pasta-lista" aria-label="Peças do processo">'+
        '<div class="barra">'+
          '<input id="pasta-busca" type="search" placeholder="Buscar por rótulo, movimentação ou nº" '+
            'aria-label="Buscar peça pelo rótulo, pela descrição ou pelo número da movimentação" '+
            'autocomplete="off">'+
          '<label class="so-disp"><input type="checkbox" id="pasta-so-disp"> só disponíveis</label>'+
          '<div class="acoes">'+
            '<button class="bt bt2" id="pasta-todas">Todas</button>'+
            '<button class="bt bt2" id="pasta-nenhuma">Nenhuma</button>'+
            '<button class="bt" id="pasta-baixar-pdf" disabled>Baixar PDF</button>'+
          '</div>'+
          '<div class="chips" id="pasta-atalhos" aria-label="Marcar por tipo"></div>'+
          '<div class="contagem" id="pasta-contagem" aria-live="polite"></div>'+
        '</div>'+
        '<div id="pasta-baixar-caixa"></div>'+
        '<div class="itens" id="pasta-itens" role="listbox" aria-multiselectable="true" '+
          'aria-label="Peças, na ordem dos autos"></div>'+
      '</section>'+
      '<div class="divisor" id="pasta-divisor" role="separator" aria-orientation="vertical" '+
        'tabindex="0" aria-label="Ajustar a largura da lista" title="Arraste para ajustar"></div>'+
      '<section class="visor" id="pasta-visor" aria-label="Visualizador">'+
        '<div class="topo-visor">'+
          '<button class="bt bt2 voltar" id="pasta-voltar">&larr; lista de peças</button>'+
          '<strong id="pasta-nome" class="nome"></strong>'+
        '</div>'+
        '<div class="mov-visor" id="pasta-mov"></div>'+
        '<div class="estado" id="pasta-estado" role="status" aria-live="polite"></div>'+
        '<div class="ferramentas oculto" id="pasta-ferramentas">'+
          '<button class="bt bt2" id="pasta-menos" title="Diminuir" aria-label="Diminuir">−</button>'+
          '<button class="bt bt2" id="pasta-largura" title="Ajustar à largura">largura</button>'+
          '<button class="bt bt2" id="pasta-mais" title="Aumentar" aria-label="Aumentar">+</button>'+
          '<span class="pg" id="pasta-pg"></span>'+
          '<input id="pasta-texto" type="search" placeholder="Buscar no texto" aria-label="Buscar no texto">'+
          '<button class="bt bt2" id="pasta-buscar-texto">Buscar</button>'+
          '<button class="bt bt2 oculto" id="pasta-ant" title="Ocorrência anterior" aria-label="Ocorrência anterior">&uarr;</button>'+
          '<button class="bt bt2 oculto" id="pasta-prox" title="Próxima ocorrência" aria-label="Próxima ocorrência">&darr;</button>'+
          '<button class="bt bt2" id="pasta-baixar-este">Baixar este PDF</button>'+
        '</div>'+
        '<div class="onde" id="pasta-onde"></div>'+
        '<div class="paginas" id="pasta-paginas" tabindex="0" aria-label="Páginas do documento"></div>'+
      '</section>'+
    '</div>';
  document.body.appendChild(el);
  document.body.classList.add('com-pasta');
  ligarEventos();
  ligarDivisor();
  ajustarLargura();
  informarLargura();
  var espera=null;
  st.redimensionar=function(){
    if(espera)clearTimeout(espera);
    espera=setTimeout(function(){
      espera=null;ajustarLargura();informarLargura();
      if(st.zoom==='largura')relayout();
    },200);
  };
  window.addEventListener('resize',st.redimensionar);
}

function ligarEventos(){
  $('pasta-fechar').addEventListener('click',fechar);
  $('pasta-montar').addEventListener('click',pedirMontagem);
  $('pasta-tudo').addEventListener('click',alternarTudo);
  $('pasta-voltar').addEventListener('click',voltarParaLista);
  $('pasta-busca').addEventListener('input',function(){
    st.busca=$('pasta-busca').value;desenharLista();
  });
  $('pasta-so-disp').addEventListener('change',function(){
    st.soDisp=$('pasta-so-disp').checked;desenharLista();
  });
  /* O alvo dos botões de lote é lido NO CLIQUE, nunca congelado ao ligar o
     evento: com a lista congelada, mudar o filtro depois de desenhar mandaria
     o conjunto antigo. */
  $('pasta-todas').addEventListener('click',function(){
    visiveis().forEach(function(p){if(p.estado!=='sigilo')st.sel[p.pecaId]=1});
    desenharLista();
  });
  $('pasta-nenhuma').addEventListener('click',function(){st.sel={};desenharLista()});
  $('pasta-baixar-pdf').addEventListener('click',pedirPreviaDaSelecao);
  var itens=$('pasta-itens');
  itens.addEventListener('click',aoClicarNaLista);
  itens.addEventListener('keydown',aoTeclarNaLista);
  $('pasta-menos').addEventListener('click',function(){mudarZoom(-1)});
  $('pasta-mais').addEventListener('click',function(){mudarZoom(1)});
  $('pasta-largura').addEventListener('click',function(){st.zoom='largura';relayout()});
  $('pasta-buscar-texto').addEventListener('click',buscarTexto);
  $('pasta-texto').addEventListener('keydown',function(e){if(e.key==='Enter')buscarTexto()});
  $('pasta-prox').addEventListener('click',function(){pularOcorrencia(1)});
  $('pasta-ant').addEventListener('click',function(){pularOcorrencia(-1)});
  $('pasta-baixar-este').addEventListener('click',baixarEste);
  $('pasta-paginas').addEventListener('scroll',aoRolar);
  $('pasta').addEventListener('keydown',function(e){
    if(e.key==='Escape'&&document.body.classList.contains('pasta-lendo'))voltarParaLista();
  });
}

/* A largura da lista vale para a janela em que foi arrastada. Numa janela menor
   ela encolhe para caber, sem apagar a preferência gravada. O CSS tem a mesma
   trava em min(); esta mantém espaço para o visualizador. */
function ajustarLargura(){
  if(window.innerWidth<=900)return;
  var v=getComputedStyle(document.documentElement).getPropertyValue('--pasta-lista-w').trim();
  var m=/^(\d+(?:\.\d+)?)px$/.exec(v); if(!m)return;
  var max=Math.max(260,window.innerWidth-256-320);
  if(Number(m[1])>max)document.documentElement.style.setProperty('--pasta-lista-w',max+'px');
}
function definirLargura(w){
  var max=Math.max(260,window.innerWidth-256-320);
  w=Math.max(260,Math.min(max,w));
  document.documentElement.style.setProperty('--pasta-lista-w',w+'px');
  informarLargura();
}
/* O separador focável diz onde está (leitor de tela): valor, mínimo e máximo. */
function informarLargura(){
  var d=$('pasta-divisor'), l=$('pasta-lista'); if(!d||!l)return;
  d.setAttribute('aria-valuemin','260');
  d.setAttribute('aria-valuemax',String(Math.max(260,window.innerWidth-256-320)));
  d.setAttribute('aria-valuenow',String(Math.round(l.getBoundingClientRect().width)));
}
function gravarLargura(){
  try{localStorage.setItem(LARGURA,
    getComputedStyle(document.documentElement).getPropertyValue('--pasta-lista-w').trim())}catch(x){}
  if(st.zoom==='largura')relayout();
}
function ligarDivisor(){
  var d=$('pasta-divisor'); if(!d)return;
  d.addEventListener('pointerdown',function(e){
    e.preventDefault();d.setPointerCapture(e.pointerId);d.classList.add('arrastando');
    var esq=$('pasta-lista').getBoundingClientRect().left;
    function mover(ev){definirLargura(ev.clientX-esq)}
    function soltar(){
      d.classList.remove('arrastando');
      d.removeEventListener('pointermove',mover);
      d.removeEventListener('pointerup',soltar);
      gravarLargura();
    }
    d.addEventListener('pointermove',mover);
    d.addEventListener('pointerup',soltar);
  });
  /* Pelo teclado também: setas movem de 24 em 24 px. */
  d.addEventListener('keydown',function(e){
    if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
    e.preventDefault();
    definirLargura($('pasta-lista').getBoundingClientRect().width+(e.key==='ArrowRight'?24:-24));
    gravarLargura();
  });
}

/* ---------- abrir e fechar ---------- */
function abrirPasta(){
  montarPainel();
  st.aberta=true;
  st.gatilho=document.activeElement;
  $('pasta-titulo-geral').textContent='Pasta digital · '+pv().mascara(st.numero);
  document.body.classList.remove('pasta-lendo');
  estadoDoVisor('<span class="gira"></span>Abrindo a pasta…');
  $('pasta-itens').innerHTML='';
  carregarListagem(false);
}

/* A Pasta lê a listagem que o servidor gravou quando a tela do processo
   carregou as peças — não consulta o tribunal de novo. Se não há listagem
   (servidor reiniciado, gravação que falhou), a tela CARREGA as peças do
   processo, que é o que a produz, e diz que está fazendo isso. */
function carregarListagem(forcar){
  st.erroVisao=null;
  return pv().api(base()).then(function(r){
    if(r.listagem&&!forcar){receber(r);return}
    return recarregarPecasDoProcesso().then(function(){
      return pv().api(base()).then(function(r2){
        if(!r2.listagem)throw Object.assign(new Error('A lista de peças não foi gravada'),
          {status:409,codigo:'LISTAGEM_DA_PASTA_AUSENTE'});
        receber(r2);
      });
    });
  }).catch(function(e){falhaDaListagem(e)});
}
function recarregarPecasDoProcesso(){
  estadoDoVisor('<span class="gira"></span>Carregando a lista de peças do tribunal… '+
    '<span class="nota">pode levar alguns instantes: é a consulta completa ao processo.</span>');
  return pv().api('/v1/processos/'+encodeURIComponent(st.numero)+'/pecas');
}
function falhaDaListagem(e){
  st.erroVisao=e;
  var ausente=e&&e.codigo==='LISTAGEM_DA_PASTA_AUSENTE';
  var h='<div class="falha"><strong>'+(ausente
    ?'A lista de peças deste processo ainda não foi carregada do tribunal.'
    :esc(e&&e.message?e.message:'Não foi possível abrir a pasta.'))+'</strong> '+
    (ausente?'Carregue as peças do processo e tente de novo. Nada foi baixado.'
      :esc(e&&e.status?pv().explicar(e):'isto é defeito do Processo Vivo, não da sua consulta.'))+
    '<div style="margin-top:8px"><button class="bt bt2" id="pasta-tentar-listagem">'+
    'Tentar de novo</button></div></div>';
  estadoDoVisor(h);
  var b=$('pasta-tentar-listagem');
  if(b)b.addEventListener('click',function(){carregarListagem(true)});
}

function receber(r){
  st.visao=r;st.erroPoll=0;
  /* Marcas de peças que sumiram da lista (ou ficaram sob sigilo) não ficam. */
  Object.keys(st.sel).forEach(function(id){
    var p=pecaDe(id); if(!p||p.estado==='sigilo')delete st.sel[id];
  });
  desenharTudo();
  decidirPoll();
}

function fechar(){
  pararPoll();
  cal.reiniciar();
  if(st.clique&&st.clique.timer)clearTimeout(st.clique.timer);
  if(st.redimensionar)window.removeEventListener('resize',st.redimensionar);
  if(st.observador)st.observador.disconnect();
  if(st.pdf){try{st.pdf.destroy()}catch(e){}}
  var el=$('pasta'); if(el)el.remove();
  document.body.classList.remove('com-pasta','pasta-lendo');
  var g=st.gatilho;
  st=novoEstado(st.numero);
  if(g&&g.focus&&document.body.contains(g)){try{g.focus()}catch(e){}}
}

/* ---------- a lista ---------- */
/* A movimentação a que a peça pertence, como o tribunal a escreveu. Os números
   que aparecem DENTRO do texto ("ev. 382") são texto do cartório: aqui só se
   mostram, nunca viram link nem número da movimentação. O "mov. N" vem do
   servidor com o grau de certeza (v0.35.0): posicao (calculada, 0.34.0),
   exato (provado pelos números que o advogado informou do Projudi), faixa
   ou estimado — nunca o identificadorMovimento (erro da v0.33.2). A
   apresentação mora em scriptPastaCalibracao.ts. */
var AVISO_CURTO='Número calculado pela ordem dos atos recebidos do tribunal. '+
  'Pode ficar abaixo do número do Projudi se o processo tiver atos bloqueados.';
function posicaoDaMov(p){return cal.posicaoDe(p)}
function haNumeros(){return cal.haNumeros(st.visao)}
function textoDaMov(p){
  var m=p.movimentacao;
  if(!m)return '';
  return String(m.descricao||'')+(m.complemento?' — '+m.complemento:'');
}
function tituloDaMov(p){
  var m=p.movimentacao;
  if(!m)return '';
  return 'Movimentação'+cal.rotuloDoTitulo(p)+' · '+pv().dt(m.data)+
    (textoDaMov(p)?' — '+textoDaMov(p):'');
}
/* "382" acha a movimentação 382 e não a 1382: o número casa por IGUALDADE com o
   número exato, estimado ou a posição — e, numa faixa, quando o número buscado
   está dentro dela. Já a descrição casa por trecho — é busca de texto, como no
   rótulo. */
function numeroBuscado(termo){
  var num=/^(?:mov(?:imentacao)?\.?\s*)?(?:n[o\u00ba.]*\s*)?(\d+)$/.exec(termo);
  return num?Number(num[1]):null;
}
function combinaComBusca(p,termo){
  if(normal(p.rotulo).indexOf(termo)>=0)return true;
  var m=p.movimentacao;
  if(!m)return false;
  if(normal(textoDaMov(p)).indexOf(termo)>=0)return true;
  var buscado=numeroBuscado(termo);
  return buscado!==null&&cal.combina(p,buscado);
}
function visiveis(){
  var termo=normal(st.busca).trim();
  return ((st.visao&&st.visao.pecas)||[]).filter(function(p){
    if(st.soDisp&&p.estado!=='disponivel')return false;
    if(termo&&!combinaComBusca(p,termo))return false;
    return true;
  });
}
function marcadas(){
  return ((st.visao&&st.visao.pecas)||[]).filter(function(p){
    return st.sel[p.pecaId]&&p.estado!=='sigilo'}).map(function(p){return p.pecaId});
}
function rotuloDoEstado(p){
  if(p.estado==='nao_obtida'){
    if(p.motivo==='bloqueio_do_tribunal')return{t:'Pausada pelo tribunal',c:'pr'};
    if(p.motivo==='sem_habilitacao')return{t:'Sem habilitação',c:'al'};
    return{t:'Não obtida',c:'al'};
  }
  var m={nao_baixada:{t:'Não baixada',c:'neutro'},na_fila:{t:'Na fila',c:'nv'},
    baixando:{t:'Baixando',c:'nv'},disponivel:{t:'Disponível',c:'ok'},
    sigilo:{t:'Sob sigilo',c:'mc'}};
  return m[p.estado]||m.nao_baixada;
}
function paginasDe(p){
  if(!p.intervalo)return '';
  return 'p. '+p.intervalo.inicial+(p.intervalo.final>p.intervalo.inicial?'–'+p.intervalo.final:'');
}

function movHtml(p){
  var m=p.movimentacao;
  if(!m)return '';
  var t=textoDaMov(p), pos=posicaoDaMov(p);
  if(!t&&pos===null)return '';
  var buscado=numeroBuscado(normal(st.busca).trim());
  return '<span class="mov" title="'+esc(tituloDaMov(p))+'">'+
    (pos!==null?cal.htmlSelo(p,buscado):'')+
    (t?'<span class="mov-t">'+esc(t)+'</span>':'')+
    /* Só para o mouse: quem usa teclado aperta N na linha, e o botão do
       visualizador faz o mesmo. Um botão aqui dentro de um "option" seria
       controle interativo aninhado, que leitor de tela não alcança. */
    (pos!==null&&typeof st.visao.totalAtosRecebidos==='number'
      ?'<span class="mov-cal" data-cal="1" aria-hidden="true" '+
        'title="Informar o nº deste ato no Projudi (tecla N)">informar nº</span>':'')+
    '</span>';
}

function linhaHtml(p){
  var e=rotuloDoEstado(p), marcada=!!st.sel[p.pecaId], sig=p.estado==='sigilo';
  var atual=st.peca===p.pecaId;
  var pg=paginasDe(p);
  return '<div class="linha'+(atual?' atual':'')+(marcada?' marcada':'')+'" role="option" '+
    'id="pf-'+esc(p.pecaId)+'" data-id="'+esc(p.pecaId)+'" tabindex="'+
    (st.foco===p.pecaId?'0':'-1')+'" aria-selected="'+(marcada?'true':'false')+'"'+
    (atual?' aria-current="true"':'')+(sig?' aria-disabled="true"':'')+'>'+
    '<span class="cx" aria-hidden="true" data-cx="1"></span>'+
    cal.htmlCelula(p)+
    '<span class="rot" title="'+esc(p.rotulo)+'">'+esc(p.rotulo)+'</span>'+
    '<span class="meta"><span class="data">'+esc(pv().dt(p.data))+'</span>'+
    '<span class="selo '+e.c+'">'+e.t+'</span>'+
    (pg?'<span class="pp">'+pg+'</span>':'')+'</span>'+movHtml(p)+'</div>';
}

function desenharLista(){
  var itens=$('pasta-itens'); if(!itens||!st.visao)return;
  var v=visiveis(), total=st.visao.pecas.length;
  /* O foco e a rolagem sobrevivem ao redesenho: a lista é refeita a cada
     consulta de andamento, e perder o lugar a cada dois segundos tornaria
     impossível navegar por teclado. */
  var tinhaFoco=itens.contains(document.activeElement);
  var rolagem=itens.scrollTop;
  if(!st.foco||!v.some(function(p){return p.pecaId===st.foco}))st.foco=v.length?v[0].pecaId:null;
  itens.innerHTML=v.length?v.map(linhaHtml).join(''):
    '<div class="vazio-lista">'+(total?'Nenhuma peça combina com o filtro.':
      'O tribunal não listou nenhuma peça neste processo.')+'</div>';
  itens.scrollTop=rolagem;
  if(tinhaFoco&&st.foco){var f=$('pf-'+st.foco); if(f)f.focus({preventScroll:true})}

  var n=marcadas().length, ocultas=total-v.length;
  $('pasta-contagem').innerHTML='<strong>'+n+'</strong> '+(n===1?'marcada':'marcadas')+' de '+
    total+' · mostrando '+v.length+' de '+total+
    (ocultas?' <span class="filtro-ativo">('+ocultas+' escondidas pelos filtros)</span>':'');
  var sel=v.filter(function(p){return p.estado!=='sigilo'}).length;
  $('pasta-todas').textContent='Todas ('+sel+')';
  var bp=$('pasta-baixar-pdf');
  bp.textContent='Baixar PDF ('+n+')';
  bp.disabled=!n||!!st.baixando;
  desenharAtalhos();
}

/* Atalhos por tipo: o começo do rótulo do tribunal ("Petição", "Despacho"…). */
function grupos(){
  var g={};
  ((st.visao&&st.visao.pecas)||[]).forEach(function(p){
    if(p.estado==='sigilo')return;
    var k=String(p.rotulo).split(/\s+-\s+/)[0].trim()||'Outros';
    (g[k]=g[k]||[]).push(p.pecaId);
  });
  return Object.keys(g).map(function(k){return{rotulo:k,ids:g[k]}})
    .sort(function(a,b){return b.ids.length-a.ids.length}).slice(0,8);
}
function desenharAtalhos(){
  var el=$('pasta-atalhos'); if(!el)return;
  var gs=grupos(), h='';
  gs.forEach(function(g,i){
    var todas=g.ids.every(function(id){return st.sel[id]});
    h+='<button class="chip'+(todas?' on':'')+'" data-grupo="'+i+'" aria-pressed="'+
      (todas?'true':'false')+'">'+esc(g.rotulo)+' ('+g.ids.length+')</button>';
  });
  el.innerHTML=h;
  el.querySelectorAll('[data-grupo]').forEach(function(b){
    b.addEventListener('click',function(){
      var g=gs[Number(b.getAttribute('data-grupo'))]; if(!g)return;
      var todas=g.ids.every(function(id){return st.sel[id]});
      g.ids.forEach(function(id){if(todas)delete st.sel[id]; else st.sel[id]=1});
      desenharLista();
    });
  });
}

function linhaDe(el){
  while(el&&el.getAttribute&&!el.getAttribute('data-id'))el=el.parentNode;
  return el&&el.getAttribute?el:null;
}
function aoClicarNaLista(ev){
  var l=linhaDe(ev.target); if(!l)return;
  var id=l.getAttribute('data-id');
  st.foco=id;
  if(ev.target.getAttribute&&ev.target.getAttribute('data-cx')){alternarMarca(id);return}
  if(ev.target.getAttribute&&ev.target.getAttribute('data-cal')){
    var pc=pecaDe(id); if(pc)cal.abrirEditor(pc);
    return;
  }
  abrirPeca(id,false);
}
function alternarMarca(id){
  var p=pecaDe(id); if(!p||p.estado==='sigilo')return;
  if(st.sel[id])delete st.sel[id]; else st.sel[id]=1;
  desenharLista();
}
/* Teclado: setas navegam, Enter abre, Espaço marca. */
function aoTeclarNaLista(ev){
  var l=linhaDe(ev.target); if(!l)return;
  var v=visiveis(), id=l.getAttribute('data-id');
  var i=-1; v.forEach(function(p,k){if(p.pecaId===id)i=k});
  var alvo=null;
  if((ev.key==='n'||ev.key==='N')&&!ev.ctrlKey&&!ev.metaKey&&!ev.altKey){
    var pn=pecaDe(id);
    if(pn&&posicaoDaMov(pn)!==null&&typeof st.visao.totalAtosRecebidos==='number'){
      ev.preventDefault();cal.abrirEditor(pn);
    }
    return;
  }
  if(ev.key==='ArrowDown')alvo=Math.min(v.length-1,i+1);
  else if(ev.key==='ArrowUp')alvo=Math.max(0,i-1);
  else if(ev.key==='Home')alvo=0;
  else if(ev.key==='End')alvo=v.length-1;
  else if(ev.key==='PageDown')alvo=Math.min(v.length-1,i+10);
  else if(ev.key==='PageUp')alvo=Math.max(0,i-10);
  if(alvo!==null){
    ev.preventDefault();
    var p=v[alvo]; if(!p)return;
    st.foco=p.pecaId;
    var itens=$('pasta-itens');
    itens.querySelectorAll('.linha[tabindex="0"]').forEach(function(x){x.setAttribute('tabindex','-1')});
    var f=$('pf-'+p.pecaId);
    if(f){f.setAttribute('tabindex','0');f.focus()}
    return;
  }
  if(ev.key==='Enter'){ev.preventDefault();abrirPeca(id,true)}
  else if(ev.key===' '||ev.key==='Spacebar'){ev.preventDefault();alternarMarca(id)}
}

/* ---------- o aviso do topo ---------- */
function desenharAviso(){
  var el=$('pasta-aviso'); if(!el||!st.visao)return;
  var v=st.visao, h='';
  var pr=v.procedencia||{};
  h+='<div class="proc">Lista obtida do tribunal em '+esc(pv().dth(pr.listadaEm))+
    ' — <strong>não é consulta ao vivo</strong>. Peça nova só aparece quando as peças do '+
    'processo são recarregadas (botão "Atualizar" do cartão das peças).</div>';
  if(v.pausadoAte&&Date.parse(v.pausadoAte)>agora()){
    h+='<div class="pausa"><strong>Tribunal em pausa até '+esc(hora(v.pausadoAte))+'.</strong> '+
      'O tribunal bloqueou temporariamente as consultas deste servidor; os pedidos '+
      'voltam a ser atendidos depois dessa hora. O que já está guardado abre normalmente.</div>';
  }
  if(v.listagem&&v.listagem.processoSigiloso){
    h+='<div class="pausa"><strong>Processo em segredo de justiça.</strong> Nenhuma peça é '+
      'guardada aqui; baixe-as individualmente pela linha do tempo.</div>';
  }
  if(haNumeros()&&typeof v.totalAtosRecebidos==='number'){
    /* Sempre que houver número na lista: sem este aviso o "mov. N" passaria por
       número do Projudi, e ele só é igual até o primeiro ato bloqueado. Com a
       calibração o texto muda, mas o aviso não some enquanto houver número
       que não seja exato. */
    h+=cal.avisoHtml(v);
  }
  h+=blocoDaMontagem(v.montagem);
  h+=blocoDasSelecionadas(v.selecionadas);
  if(!ativoJob(v.montagem)&&v.estimativaDaMontagem&&!(v.listagem&&v.listagem.processoSigiloso)){
    var e=v.estimativaDaMontagem;
    h+='<div class="nota">'+(e.abuscar
      ?'Montar a pasta completa busca '+n_pecas(e.abuscar)+' no tribunal ('+faixa(e)+
        '), uma consulta de cada vez'+(e.emGuarda?'; '+e.emGuarda+' já estão guardadas':'')+'.'
      :'Todas as peças disponíveis já estão guardadas: montar não consulta o tribunal.')+'</div>';
  }
  if(h!==st.ultimoAviso){
    st.ultimoAviso=h;el.innerHTML=h;
  }
  var tudo=$('pasta-tudo'), m=v.montagem;
  var pronto=!!m&&(m.estado==='pronto'||m.estado==='parcial');
  tudo.disabled=!pronto;
  tudo.textContent=st.modo==='tudo'?'Voltar a uma peça por vez':'Ver tudo seguido';
  var bm=$('pasta-montar');
  bm.disabled=!!st.montando||ativoJob(m)||!!(v.listagem&&v.listagem.processoSigiloso);
  bm.textContent=pronto?'Montar de novo':'Montar pasta completa';
  var rebindar=el.querySelector('[data-tentar-job]');
  if(rebindar)rebindar.addEventListener('click',function(){st.erroPoll=0;st.erroVisao=null;recarregar()});
}

function blocoDaMontagem(j){
  if(!j)return '';
  var h='';
  if(j.estado==='na_fila'||j.estado==='baixando'||j.estado==='montando'){
    var feitas=j.baixadas+(j.recusadas?j.recusadas.length:0);
    var pct=j.total?Math.round(100*feitas/j.total):0;
    h+='<div class="job"><strong>'+(j.estado==='na_fila'
      ?'Montagem na fila.</strong> Começa assim que o pedido anterior terminar.'
      :j.estado==='baixando'
        ?'Montando a pasta: baixando do tribunal</strong> '+j.baixadas+' de '+j.total+
          ' peças'+(j.recusadas&&j.recusadas.length?' · '+j.recusadas.length+' não vieram':'')+
          '. Você pode ler as peças que já estão disponíveis enquanto isso.'
        :'Juntando as peças no PDF…</strong>')+
      '<div class="barra-prog"><i style="width:'+(j.estado==='montando'?100:pct)+'%"></i></div>';
    var parado=agora()-Date.parse(j.atualizadoEm)>PARADO_MS;
    h+='<div class="nota">'+(parado
      ?'Sem progresso desde '+esc(hora(j.atualizadoEm))+'. O servidor continua tentando; se ficar assim, avise o suporte.'
      :'Atualizado às '+esc(hora(j.atualizadoEm))+'.')+'</div></div>';
  }else if(j.estado==='pausado_por_bloqueio'){
    h+='<div class="job pausa"><strong>Montagem pausada pelo tribunal.</strong> Continua sozinha por '+
      'volta das <strong>'+esc(hora(j.retomarEm))+'</strong>, de onde parou — não precisa pedir '+
      'de novo. '+j.baixadas+' de '+j.total+' peças já vieram.</div>';
  }else if(j.estado==='falhou'){
    h+='<div class="job falha"><strong>Não foi possível montar a pasta.</strong> '+
      esc(j.mensagem||'')+' Use "Montar pasta completa" para pedir de novo.</div>';
  }else if(j.estado==='pronto'||j.estado==='parcial'){
    h+='<div class="job '+(j.estado==='pronto'?'ok':'pr')+'"><strong>'+(j.estado==='pronto'
      ?'Pasta montada'
      :'Pasta montada com falhas')+'</strong> · '+j.paginas+' páginas'+
      (j.estado==='parcial'?'; as peças que faltaram têm uma página de aviso no lugar':'')+
      '. Montada em '+esc(pv().dth(j.procedencia&&j.procedencia.baixadoEm))+
      (j.procedencia&&j.procedencia.expiraEm?', guardada até '+esc(pv().dth(j.procedencia.expiraEm)):'')+
      ' — <strong>não é consulta ao vivo</strong>.</div>';
  }
  return h;
}
function blocoDasSelecionadas(j){
  if(!j||!st.baixando)return '';
  if(ativoJob(j)){
    var pct=j.total?Math.round(100*(j.baixadas+(j.recusadas?j.recusadas.length:0))/j.total):0;
    return '<div class="job"><strong>Preparando o PDF das marcadas…</strong> '+
      (j.estado==='pausado_por_bloqueio'
        ?'pausado pelo tribunal; continua por volta das '+esc(hora(j.retomarEm))
        :j.baixadas+' de '+j.total+' peças')+
      '<div class="barra-prog"><i style="width:'+pct+'%"></i></div></div>';
  }
  if(j.estado==='falhou')return '<div class="job falha"><strong>Não foi possível preparar o PDF das marcadas.</strong> '+
    esc(j.mensagem||'')+'</div>';
  return '';
}

/* ---------- consulta de andamento ---------- */
function pararPoll(){if(st.timer){clearTimeout(st.timer);st.timer=null}}
function esperando(){
  /* A peça ABERTA que ainda espera e não estourou o limite. */
  var p=st.peca?pecaDe(st.peca):null;
  if(st.espera&&st.espera.id===st.peca&&!st.espera.esgotada&&(!p||p.estado!=='disponivel'))return true;
  return false;
}
function precisaPoll(){
  var v=st.visao; if(!v)return false;
  if(ativoJob(v.montagem)||ativoJob(v.selecionadas))return true;
  if(esperando())return true;
  return (v.pecas||[]).some(transitoria);
}
function decidirPoll(){
  if(st.erroVisao&&st.erroPoll>=3){pararPoll();return}
  pararPoll();
  if(!st.aberta||!precisaPoll())return;
  var lento=st.visao&&st.visao.montagem&&st.visao.montagem.estado==='pausado_por_bloqueio'&&!esperando();
  /* A peça que a pessoa espera olhando é consultada mais de perto (é só o nosso
     banco); o resto, a cada 2 s; a montagem pausada pelo tribunal, a cada 15 s. */
  st.timer=setTimeout(recarregar,lento?15000:esperando()?800:2000);
}
function recarregar(){
  if(!st.aberta)return Promise.resolve();
  return pv().api(base()).then(function(r){
    st.erroPoll=0;st.erroVisao=null;receber(r);
  }).catch(function(e){
    st.erroPoll++;
    /* Três falhas seguidas e a tela PARA de tentar e diz por quê, com botão.
       Girar para sempre seria mentir que algo está acontecendo. */
    if(st.erroPoll>=3){
      st.erroVisao=e;
      var el=$('pasta-aviso');
      if(el){
        el.innerHTML='<div class="job falha"><strong>Perdi o contato com o servidor.</strong> '+
          esc(e&&e.status?pv().explicar(e):(e&&e.message)||'')+
          ' <button class="bt bt2" data-tentar-job="1">Consultar de novo</button></div>';
        st.ultimoAviso='';
        el.querySelector('[data-tentar-job]').addEventListener('click',function(){
          st.erroPoll=0;st.erroVisao=null;recarregar()});
      }
      return;
    }
    pararPoll();
    st.timer=setTimeout(recarregar,4000);
  });
}

function desenharTudo(){
  if(!st.aberta||!st.visao)return;
  desenharAviso();
  cal.desenhar(false);
  desenharLista();
  atualizarVisor();
}

/* ---------- abrir UMA peça ---------- */
function abrirPeca(id,imediato){
  var p=pecaDe(id); if(!p)return;
  st.peca=id;
  if(st.pedidoFalhou&&st.pedidoFalhou.id===id)st.pedidoFalhou=null;
  /* No celular a peça abre em tela cheia, com "voltar" para a lista. */
  document.body.classList.add('pasta-lendo');
  if(st.clique&&st.clique.timer){clearTimeout(st.clique.timer);st.clique=null}
  if(st.modo==='tudo'&&p.intervalo){desenharLista();atualizarVisor();irParaPagina(p.intervalo.inicial);return}
  st.modo='peca';
  if(p.estado==='disponivel'||p.estado==='sigilo'||p.estado==='na_fila'||p.estado==='baixando'){
    /* Já guardada, sigilosa, ou já na fila/no ar: não há o que pedir. Se já
       está esperando, a tela só passa a acompanhar. */
    if(transitoria(p)&&!(st.espera&&st.espera.id===id))st.espera={id:id,desde:agora(),esgotada:false};
    desenharLista();atualizarVisor();decidirPoll();return;
  }
  /* Precisa pedir. O pedido espera a janela do debounce: outro clique antes
     dela TROCA o agendado, e o intermediário nunca sai desta tela. */
  st.espera={id:id,desde:agora(),esgotada:false};
  st.clique={id:id,timer:setTimeout(function(){enviarPedido(id)},imediato?0:DEBOUNCE_MS)};
  desenharLista();atualizarVisor();
}

function enviarPedido(id){
  if(!st.aberta)return;
  if(st.clique&&st.clique.id===id)st.clique.timer=null;
  pv().api(base()+'/pecas/'+encodeURIComponent(id),{method:'POST'}).then(function(){
    if(st.clique&&st.clique.id===id)st.clique=null;
    return recarregar();
  }).then(function(){decidirPoll()}).catch(function(e){
    if(st.clique&&st.clique.id===id)st.clique=null;
    st.espera=null;
    falhaDoPedido(id,e);
  });
}
function falhaDoPedido(id,e){
  st.pedidoFalhou={id:id,e:e};
  atualizarVisor();
}

function voltarParaLista(){
  document.body.classList.remove('pasta-lendo');
  var f=st.foco&&$('pf-'+st.foco); if(f)f.focus();
}

/* O que o visor diz, derivado do estado da peça aberta. */
function estadoDoVisor(h){
  var el=$('pasta-estado'); if(!el)return;
  if(h===st.ultimoEstado)return;
  st.ultimoEstado=h;el.innerHTML=h;
}
function atualizarVisor(){
  var nome=$('pasta-nome'); if(!nome)return;
  if(st.modo==='tudo'){mostrarTudo();return}
  var p=st.peca?pecaDe(st.peca):null;
  nome.textContent=p?cal.rotuloDoVisor(p)+' · '+p.rotulo:'';
  if(p)nome.setAttribute('aria-label',cal.nomeAcessivel(p)+': '+p.rotulo);
  else nome.removeAttribute('aria-label');
  var mv=$('pasta-mov');
  if(mv){
    /* Refeito só quando muda: a consulta de andamento roda a cada 2 s, e
       recriar o botão tiraria o foco de quem está nele. */
    var sigMov=p?tituloDaMov(p)+'|'+cal.avisoDoVisor(p)+'|'+(typeof st.visao.totalAtosRecebidos):'';
    if(mv.getAttribute('data-sig')!==sigMov){
      mv.setAttribute('data-sig',sigMov);
      mv.textContent=p?tituloDaMov(p):'';
      if(p&&posicaoDaMov(p)!==null){
        var avt=cal.avisoDoVisor(p);
        if(avt){
          var av=document.createElement('span');
          av.className='mov-aviso';av.title=AVISO_CURTO;
          av.textContent=avt;
          mv.appendChild(av);
        }
        if(typeof st.visao.totalAtosRecebidos==='number'){
          var bi=document.createElement('button');
          bi.type='button';bi.className='bt bt2 pcal-bt';bi.id='pasta-mov-informar';
          bi.textContent='Informar o nº deste ato no Projudi';
          bi.addEventListener('click',function(){cal.abrirEditor(p)});
          mv.appendChild(bi);
        }
      }
    }
  }
  if(!p){
    estadoDoVisor('<div class="vazio-visor">Escolha uma peça na lista. Só ela será pedida ao tribunal; '+
      'o resto da pasta não é baixado sem você pedir.</div>');
    return;
  }
  if(st.pedidoFalhou&&st.pedidoFalhou.id===p.pecaId&&p.estado!=='disponivel'){
    var e=st.pedidoFalhou.e;
    if(e&&e.codigo==='LISTAGEM_DA_PASTA_AUSENTE'){
      estadoDoVisor('<div class="falha"><strong>A lista de peças deste processo ainda não foi carregada '+
        'do tribunal.</strong> Carregue as peças do processo e tente de novo. Nada foi pedido.'+
        '<div style="margin-top:8px"><button class="bt bt2" id="pasta-tentar-pedido">Tentar de novo</button></div></div>');
      var b0=$('pasta-tentar-pedido');
      if(b0)b0.addEventListener('click',function(){
        st.pedidoFalhou=null;
        carregarListagem(true).then(function(){abrirPeca(p.pecaId,true)});
      });
    }else{
      estadoDoVisor('<div class="falha"><strong>'+esc(textoDoErro(e))+'</strong>'+
        '<div style="margin-top:8px"><button class="bt bt2" id="pasta-tentar-pedido">Tentar de novo</button></div></div>');
      var b1=$('pasta-tentar-pedido');
      if(b1)b1.addEventListener('click',function(){st.pedidoFalhou=null;abrirPeca(p.pecaId,true)});
    }
    ocultarPdf();return;
  }
  var quando=st.espera&&st.espera.id===p.pecaId?st.espera.desde:null;
  var decorrido=quando?Math.round((agora()-quando)/1000):0;
  /* O limite vale para a espera de uma peça que ainda não chegou. */
  if(quando&&!st.espera.esgotada&&p.estado!=='disponivel'&&agora()-quando>LIMITE_ESPERA_MS){
    st.espera.esgotada=true;pararPoll();
  }
  if(st.espera&&st.espera.id===p.pecaId&&st.espera.esgotada&&p.estado!=='disponivel'){
    estadoDoVisor('<div class="falha"><strong>Esta peça está demorando mais do que o normal.</strong> '+
      'O pedido continua no servidor, que consulta o tribunal uma peça por vez; se há uma '+
      'montagem em andamento, ele espera a vez. Passaram-se '+Math.round((agora()-quando)/1000)+
      ' s sem a peça chegar.<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">'+
      '<button class="bt bt2" id="pasta-conferir">Conferir de novo</button>'+
      '<button class="bt bt2" id="pasta-refazer">Pedir de novo</button></div></div>');
    var c=$('pasta-conferir');
    if(c)c.addEventListener('click',function(){
      st.espera={id:p.pecaId,desde:agora(),esgotada:false};recarregar().then(atualizarVisor)});
    var rf=$('pasta-refazer');
    if(rf)rf.addEventListener('click',function(){abrirPeca(p.pecaId,true)});
    ocultarPdf();return;
  }
  if(st.clique&&st.clique.id===p.pecaId){
    estadoDoVisor('<div class="espera"><span class="gira"></span><strong>Pedindo esta peça…</strong> '+
      'Se você clicar em outra antes de meio segundo, só a última vai ao tribunal.</div>');
    ocultarPdf();return;
  }
  if(p.estado==='na_fila'){
    var haMontagem=ativoJob(st.visao.montagem)||ativoJob(st.visao.selecionadas);
    estadoDoVisor('<div class="espera"><span class="gira"></span><strong>Aguardando a fila do tribunal.</strong> '+
      'O tribunal é consultado uma peça por vez, com pausa de 3 s entre as consultas'+
      (haMontagem?'; há uma montagem em andamento e esta peça espera a vez dela':'')+
      '.'+(decorrido>0?' <span class="nota">Esperando há '+decorrido+' s.</span>':'')+'</div>');
    ocultarPdf();return;
  }
  if(p.estado==='baixando'){
    estadoDoVisor('<div class="espera"><span class="gira"></span><strong>Baixando esta peça…</strong>'+
      (decorrido>0?' <span class="nota">'+decorrido+' s.</span>':'')+'</div>');
    ocultarPdf();return;
  }
  if(p.estado==='sigilo'){
    estadoDoVisor('<div class="aviso-peca"><strong>Peça sob sigilo.</strong> '+esc(p.descricaoDoMotivo||'')+
      ' Baixe-a individualmente pela linha do tempo.</div>');
    ocultarPdf();return;
  }
  if(p.estado==='nao_obtida'){
    var bloq=p.motivo==='bloqueio_do_tribunal';
    var ainda=bloq&&p.retomarEm&&Date.parse(p.retomarEm)>agora();
    var titulo=bloq?'Pausado pelo tribunal'+(p.retomarEm?' até '+esc(hora(p.retomarEm)):'')
      :p.motivo==='sem_habilitacao'?'Sem habilitação nos autos'
      :'Esta peça não pôde ser obtida';
    estadoDoVisor('<div class="falha"><strong>'+titulo+'.</strong> '+esc(p.descricaoDoMotivo||'')+
      '<div style="margin-top:8px"><button class="bt bt2" id="pasta-refazer"'+(ainda?' disabled':'')+
      '>'+(ainda?'Disponível às '+esc(hora(p.retomarEm)):'Tentar de novo')+'</button></div></div>');
    var rf2=$('pasta-refazer');
    if(rf2&&!ainda)rf2.addEventListener('click',function(){abrirPeca(p.pecaId,true)});
    ocultarPdf();return;
  }
  if(p.estado==='nao_baixada'){
    estadoDoVisor('<div class="vazio-visor">'+(p.substituida
      ?'Este pedido foi trocado por outro mais recente antes de ir ao tribunal. '
      :'Esta peça ainda não foi baixada. ')+
      '<button class="bt bt2" id="pasta-refazer">Baixar esta peça</button></div>');
    var rf3=$('pasta-refazer');
    if(rf3)rf3.addEventListener('click',function(){abrirPeca(p.pecaId,true)});
    ocultarPdf();return;
  }
  /* disponível */
  st.espera=null;
  var conv=p.conversao==='html'?' Convertida do HTML do tribunal em texto'+
      (p.observacao?' ('+esc(p.observacao)+')':'')+'.'
    :p.conversao==='imagem'?' Imagem do tribunal convertida em página.':'';
  estadoDoVisor('<div class="proc">Obtida do tribunal em '+esc(pv().dth(p.obtidaEm))+
    ', guardada até '+esc(pv().dth(p.expiraEm))+' — <strong>não é consulta ao vivo</strong>.'+conv+'</div>');
  var url=base()+'/pecas/'+encodeURIComponent(p.pecaId)+'/arquivo';
  if(st.pdfDe!=='peca:'+p.pecaId)carregarPdf('peca:'+p.pecaId,url,'');
}
function textoDoErro(e){
  if(!e)return 'Falhou';
  if(e.codigo==='PECA_SIGILOSA_NAO_GUARDADA')return e.message;
  if(e.codigo==='RECURSO_NAO_INCLUIDO_NO_PLANO')return 'Seu plano não inclui o acesso às peças.';
  return (e.message||'Falhou')+(e.status?' — '+pv().explicar(e):'');
}
function ocultarPdf(){
  $('pasta-ferramentas').classList.add('oculto');
  var a=$('pasta-paginas'); if(a&&st.pdfDe){a.innerHTML=''}
  if(st.pdf){try{st.pdf.destroy()}catch(e){}st.pdf=null}
  if(st.observador)st.observador.disconnect();
  st.pdfDe='';st.carga++;
  var o=$('pasta-onde'); if(o)o.innerHTML='';
}

/* ---------- ver tudo seguido ---------- */
function alternarTudo(){
  var m=st.visao&&st.visao.montagem;
  if(st.modo==='tudo'){
    st.modo='peca';st.pdfDe='';desenharAviso();atualizarVisor();return;
  }
  if(!m||(m.estado!=='pronto'&&m.estado!=='parcial'))return;
  st.modo='tudo';document.body.classList.add('pasta-lendo');
  desenharAviso();atualizarVisor();
  var p=st.peca?pecaDe(st.peca):null;
  if(p&&p.intervalo)setTimeout(function(){irParaPagina(p.intervalo.inicial)},300);
}
function mostrarTudo(){
  var m=st.visao&&st.visao.montagem;
  $('pasta-nome').textContent='Pasta completa, seguida';
  var mv0=$('pasta-mov'); if(mv0)mv0.textContent='';
  if(!m||(m.estado!=='pronto'&&m.estado!=='parcial')){
    st.modo='peca';atualizarVisor();return;
  }
  estadoDoVisor('<div class="proc">PDF combinado de '+m.total+' peças, montado em '+
    esc(pv().dth(m.procedencia&&m.procedencia.baixadoEm))+' — <strong>não é consulta ao vivo</strong>. '+
    'Clique numa peça da lista com "p. N" para ir até ela.</div>');
  var url='/v1/processos/'+encodeURIComponent(st.numero)+'/leitor/'+encodeURIComponent(m.jobId)+'/pdf';
  if(st.pdfDe!=='tudo:'+m.jobId)carregarPdf('tudo:'+m.jobId,url,'');
}

/* ---------- montar a pasta completa ---------- */
function pedirMontagem(){
  var v=st.visao; if(!v||st.montando)return;
  var e=v.estimativaDaMontagem;
  if(e&&e.abuscar&&e.exigeConfirmacao){
    var ok=window.confirm('São '+e.abuscar+' peças a pedir ao tribunal. Montar a pasta deve levar '+
      faixa(e)+', consultando o tribunal com o seu acesso, uma consulta de cada vez. Continuar?');
    if(!ok)return;
  }
  st.montando=true;desenharAviso();
  pv().api(base()+'/montar',{method:'POST'}).then(function(){
    st.montando=false;return recarregar();
  }).then(function(){decidirPoll()}).catch(function(err){
    st.montando=false;
    if(err&&err.codigo==='LISTAGEM_DA_PASTA_AUSENTE'){falhaDaListagem(err);return}
    var el=$('pasta-aviso');
    if(el){el.insertAdjacentHTML('beforeend','<div class="job falha"><strong>'+esc(textoDoErro(err))+'</strong></div>');st.ultimoAviso=''}
    desenharAviso();
  });
}

/* ---------- baixar as marcadas ---------- */
function pedirPreviaDaSelecao(){
  var ids=marcadas(); if(!ids.length)return;
  var caixa=$('pasta-baixar-caixa');
  caixa.innerHTML='<div class="previa"><span class="gira"></span>Conferindo o que está guardado…</div>';
  pv().api(base()+'/baixar/previa',{method:'POST',body:{pecas:ids}}).then(function(e){
    st.previa={ids:ids,e:e};
    var h='<div class="previa"><strong>Baixar PDF com '+n_pecas(e.total-e.sigilosas)+'.</strong> ';
    h+=e.abuscar
      ?'Serão buscadas <strong>'+n_pecas(e.abuscar)+'</strong> no tribunal ('+faixa(e)+'), '+
        'uma consulta de cada vez'+(e.emGuarda?'; '+e.emGuarda+' já estão guardadas.':'.')
      :'<strong>Nenhuma consulta ao tribunal:</strong> todas já estão guardadas.';
    if(e.sigilosas)h+=' '+n_pecas(e.sigilosas)+' sob sigilo ficam de fora.';
    h+='<div class="acoes-previa"><button class="bt" id="pasta-confirmar-baixar">'+
      (e.abuscar?'Buscar e baixar':'Baixar')+'</button>'+
      '<button class="bt bt2" id="pasta-cancelar-baixar">Cancelar</button></div></div>';
    caixa.innerHTML=h;
    $('pasta-confirmar-baixar').addEventListener('click',confirmarBaixar);
    $('pasta-cancelar-baixar').addEventListener('click',function(){st.previa=null;caixa.innerHTML=''});
    $('pasta-confirmar-baixar').focus();
  }).catch(function(err){
    caixa.innerHTML='<div class="previa falha"><strong>'+esc(textoDoErro(err))+'</strong></div>';
  });
}
function confirmarBaixar(){
  var p=st.previa; if(!p)return;
  var e=p.e;
  if(e.abuscar&&e.exigeConfirmacao&&!window.confirm('São '+e.abuscar+' peças a pedir ao tribunal ('+
    faixa(e)+'). Continuar?'))return;
  var caixa=$('pasta-baixar-caixa');
  caixa.innerHTML='<div class="previa"><span class="gira"></span>Pedindo o PDF…</div>';
  pv().api(base()+'/baixar',{method:'POST',body:{pecas:p.ids}}).then(function(r){
    st.previa=null;caixa.innerHTML='';
    st.baixando={jobId:r.job.jobId};
    return recarregar();
  }).then(function(){acompanharBaixa()}).catch(function(err){
    st.baixando=null;
    caixa.innerHTML='<div class="previa falha"><strong>'+esc(textoDoErro(err))+'</strong></div>';
  });
}
/* Quando o job das marcadas termina, o arquivo é baixado sozinho. */
function acompanharBaixa(){
  var j=st.visao&&st.visao.selecionadas;
  if(!st.baixando||!j||j.jobId!==st.baixando.jobId)return;
  if(ativoJob(j)){setTimeout(acompanharBaixa,1000);return}
  var id=j.jobId, estado=j.estado;
  st.baixando=null;desenharLista();
  if(estado!=='pronto'&&estado!=='parcial')return;
  var chave=pv().chave();
  fetch('/v1/processos/'+encodeURIComponent(st.numero)+'/leitor/'+encodeURIComponent(id)+'/pdf',
    {headers:chave?{'x-api-key':chave}:{},credentials:'same-origin'})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.blob()})
    .then(function(blob){
      salvarArquivo(blob,'processo-'+soDigitos(st.numero)+'-pecas-selecionadas.pdf');
      var c=$('pasta-baixar-caixa');
      if(c)c.innerHTML='<div class="previa ok">PDF das marcadas baixado'+
        (estado==='parcial'?'; as peças que não vieram têm uma página de aviso':'')+
        ', na ordem dos autos.</div>';
    }).catch(function(err){
      var c=$('pasta-baixar-caixa');
      if(c)c.innerHTML='<div class="previa falha"><strong>Não foi possível baixar o PDF.</strong> '+
        esc(err&&err.message?err.message:'')+'</div>';
    });
}
function baixarEste(){
  var url=st.pdfUrl; if(!url)return;
  var p=st.peca?pecaDe(st.peca):null;
  var nome=st.modo==='tudo'?'processo-'+soDigitos(st.numero)+'-pecas.pdf'
    :'processo-'+soDigitos(st.numero)+'-peca-'+(p?(p.ordem+1):'')+'.pdf';
  var chave=pv().chave();
  fetch(url,{headers:chave?{'x-api-key':chave}:{},credentials:'same-origin'})
    .then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.blob()})
    .then(function(b){salvarArquivo(b,nome)})
    .catch(function(){
      var o=$('pasta-onde'); if(o)o.textContent='Não foi possível baixar este PDF agora.';
    });
}
function salvarArquivo(blob,nome){
  var u=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=u;a.download=nome;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  URL.revokeObjectURL(u);
}

/* ---------- o PDF ---------- */
function carregarPdf(chaveDoc,url,_x){
  var area=$('pasta-paginas'); if(!area)return;
  var minha=++st.carga;
  st.pdfDe=chaveDoc;st.pdfUrl=url;
  if(st.observador)st.observador.disconnect();
  if(st.pdf){try{st.pdf.destroy()}catch(e){}st.pdf=null}
  st.desenhadas=[];st.textos={};st.achadas={id:st.achadas.id+1,termo:'',paginas:[],i:-1};
  area.innerHTML='<div class="vazio-visor"><span class="gira"></span>Abrindo o PDF…</div>';
  $('pasta-ferramentas').classList.add('oculto');
  var limite=setTimeout(function(){
    if(st.carga!==minha||st.pdf)return;
    area.innerHTML='<div class="vazio-visor falha">O PDF está demorando para abrir. '+
      '<button class="bt bt2" id="pasta-reabrir-pdf">Tentar de novo</button></div>';
    var b=$('pasta-reabrir-pdf');
    if(b)b.addEventListener('click',function(){carregarPdf(chaveDoc,url,_x)});
  },LIMITE_PDF_MS);
  var chave=pv().chave();
  import(PDFJS+'pdf.min.mjs').then(function(lib){
    st.lib=lib;
    lib.GlobalWorkerOptions.workerSrc=PDFJS+'pdf.worker.min.mjs';
    return lib.getDocument({url:url,
      httpHeaders:chave?{'x-api-key':chave}:{},withCredentials:true,
      /* Por trechos: só o que a tela precisa. */
      disableAutoFetch:true,disableStream:true,rangeChunkSize:262144,
      standardFontDataUrl:PDFJS,wasmUrl:PDFJS,iccUrl:PDFJS,cMapUrl:PDFJS,cMapPacked:true,
      isEvalSupported:false,enableXfa:false}).promise;
  }).then(function(pdf){
    clearTimeout(limite);
    if(st.carga!==minha){try{pdf.destroy()}catch(e){}return}
    st.pdf=pdf;
    return pdf.getPage(1).then(function(p1){
      if(st.carga!==minha)return;
      var v=p1.getViewport({scale:1});
      st.larguraBase=v.width;st.alturaBase=v.height;
      $('pasta-ferramentas').classList.remove('oculto');
      relayout();
    });
  }).catch(function(e){
    clearTimeout(limite);
    if(st.carga!==minha)return;
    area.innerHTML='<div class="vazio-visor falha">Não foi possível abrir o PDF: '+
      esc(e&&e.message?e.message:'erro')+'. <button class="bt bt2" id="pasta-reabrir-pdf">'+
      'Tentar de novo</button></div>';
    var b=$('pasta-reabrir-pdf');
    if(b)b.addEventListener('click',function(){carregarPdf(chaveDoc,url,_x)});
  });
}

function escalaAtual(){
  var area=$('pasta-paginas');
  if(st.zoom==='largura'){
    var w=(area?area.clientWidth:600)-24;
    return Math.max(0.3,w/(st.larguraBase||600));
  }
  return st.escala;
}
function mudarZoom(d){
  var atual=escalaAtual();
  st.escala=Math.max(0.3,Math.min(4,Math.round((atual+d*0.2)*10)/10));
  st.zoom='fixo';relayout();
}
/* Um quadro por página, do tamanho certo, sem desenhar nada. Quem desenha é o
   observador, quando o quadro chega perto da tela. */
function relayout(){
  var area=$('pasta-paginas'); if(!area||!st.pdf)return;
  var pagina=st.pagina;
  var s=escalaAtual();
  if(st.observador)st.observador.disconnect();
  st.desenhadas=[];
  var h='';
  for(var i=1;i<=st.pdf.numPages;i++){
    h+='<div class="pagina" data-p="'+i+'" style="width:'+Math.round(st.larguraBase*s)+
      'px;height:'+Math.round(st.alturaBase*s)+'px"><span class="num">'+i+'</span></div>';
  }
  area.innerHTML=h;
  st.observador=new IntersectionObserver(function(entradas){
    entradas.forEach(function(en){
      if(en.isIntersecting)desenhar(Number(en.target.getAttribute('data-p')));
    });
  },{root:area,rootMargin:'800px 0px'});
  area.querySelectorAll('.pagina').forEach(function(d){st.observador.observe(d)});
  marcarAchadas();
  irParaPagina(Math.min(pagina,st.pdf.numPages),true);
}
function quadro(n){var a=$('pasta-paginas');return a?a.querySelector('[data-p="'+n+'"]'):null}
/* "largura" vale POR PÁGINA: o PDF combinado mistura A4 do tribunal e páginas
   de outro tamanho, e uma escala só estouraria as maiores. */
function escalaDa(pg){
  if(st.zoom!=='largura')return st.escala;
  var area=$('pasta-paginas');
  return Math.max(0.3,((area?area.clientWidth:600)-24)/pg.getViewport({scale:1}).width);
}
function desenhar(n){
  if(!st.pdf||st.desenhadas.indexOf(n)>=0)return;
  st.desenhadas.push(n);
  var doc=st.pdf;
  doc.getPage(n).then(function(pg){
    if(st.pdf!==doc)return;
    var d=quadro(n), area=$('pasta-paginas'); if(!d||!area)return;
    var v=pg.getViewport({scale:escalaDa(pg)});
    var antes=d.offsetHeight, acima=d.offsetTop<area.scrollTop;
    var dpr=window.devicePixelRatio||1;
    var c=document.createElement('canvas');
    c.width=Math.floor(v.width*dpr);c.height=Math.floor(v.height*dpr);
    d.style.width=Math.round(v.width)+'px';d.style.height=Math.round(v.height)+'px';
    if(acima)area.scrollTop+=d.offsetHeight-antes;
    var ctx=c.getContext('2d');
    var antigo=d.querySelector('canvas'); if(antigo)antigo.remove();
    d.insertBefore(c,d.firstChild);
    return pg.render({canvasContext:ctx,viewport:v,
      transform:dpr!==1?[dpr,0,0,dpr,0,0]:null}).promise;
  }).catch(function(){
    var i=st.desenhadas.indexOf(n); if(i>=0)st.desenhadas.splice(i,1);
  });
  while(st.desenhadas.length>MAX_DESENHADAS){
    var longe=st.desenhadas.slice().sort(function(a,b){
      return Math.abs(b-st.pagina)-Math.abs(a-st.pagina)})[0];
    st.desenhadas.splice(st.desenhadas.indexOf(longe),1);
    var q=quadro(longe); var cv=q&&q.querySelector('canvas'); if(cv)cv.remove();
  }
}
function irParaPagina(n,silencioso){
  var area=$('pasta-paginas'), d=quadro(n); if(!area||!d)return;
  area.scrollTop=d.offsetTop-8;
  st.pagina=n;
  if(!silencioso)document.body.classList.add('pasta-lendo');
  atualizarOnde();
}
var rolando=null;
function aoRolar(){
  if(rolando)return;
  rolando=setTimeout(function(){
    rolando=null;
    var area=$('pasta-paginas'); if(!area||!st.pdf)return;
    var topo=area.scrollTop+area.clientHeight/3;
    var achado=1;
    area.querySelectorAll('.pagina').forEach(function(d){
      if(d.offsetTop<=topo)achado=Number(d.getAttribute('data-p'));
    });
    if(achado!==st.pagina){st.pagina=achado;atualizarOnde()}
  },120);
}
function atualizarOnde(){
  var pg=$('pasta-pg'); if(pg&&st.pdf)pg.textContent='p. '+st.pagina+' de '+st.pdf.numPages;
  var onde=$('pasta-onde'); if(!onde)return;
  if(st.modo!=='tudo'){onde.innerHTML='';return}
  var achada=null;
  ((st.visao&&st.visao.pecas)||[]).forEach(function(p){
    if(p.intervalo&&st.pagina>=p.intervalo.inicial&&st.pagina<=p.intervalo.final)achada=p;
  });
  onde.innerHTML=achada?'<strong>'+esc(achada.rotulo)+'</strong> · '+esc(cal.rotuloDoVisor(achada))+
    ' · '+esc(paginasDe(achada)):'';
}

/* ---------- busca no texto (como no leitor) ---------- */
function textoDaPagina(n){
  if(st.textos[n]!==undefined)return Promise.resolve(st.textos[n]);
  return st.pdf.getPage(n).then(function(pg){return pg.getTextContent()}).then(function(tc){
    var t=normal(tc.items.map(function(i){return i.str||''}).join(' '));
    st.textos[n]=t;return t;
  });
}
function buscarTexto(){
  var termo=normal($('pasta-texto').value).trim();
  var id=++st.achadas.id;
  st.achadas={id:id,termo:termo,paginas:[],i:-1};
  marcarAchadas();
  var onde=$('pasta-onde');
  if(!termo||!st.pdf)return;
  var total=st.pdf.numPages, n=1;
  function passo(){
    if(st.achadas.id!==id)return;
    if(n>total){
      var k=st.achadas.paginas.length;
      if(onde)onde.textContent=k?(k+' página(s) com "'+$('pasta-texto').value+'"')
        :'Nenhuma ocorrência. Páginas digitalizadas sem camada de texto não podem ser pesquisadas.';
      $('pasta-prox').classList.toggle('oculto',!k);
      $('pasta-ant').classList.toggle('oculto',!k);
      if(k)pularOcorrencia(1);
      return;
    }
    if(onde)onde.textContent='Procurando… p. '+n+' de '+total;
    textoDaPagina(n).then(function(t){
      if(t.indexOf(termo)>=0){st.achadas.paginas.push(n);marcarAchadas()}
      n++;passo();
    }).catch(function(){n++;passo()});
  }
  passo();
}
function marcarAchadas(){
  var a=$('pasta-paginas'); if(!a)return;
  a.querySelectorAll('.pagina.achada').forEach(function(d){d.classList.remove('achada')});
  st.achadas.paginas.forEach(function(n){var d=quadro(n); if(d)d.classList.add('achada')});
}
function pularOcorrencia(d){
  var l=st.achadas.paginas; if(!l.length)return;
  st.achadas.i=(st.achadas.i+d+l.length)%l.length;
  irParaPagina(l[st.achadas.i]);
  var onde=$('pasta-onde');
  if(onde)onde.textContent='Ocorrência '+(st.achadas.i+1)+' de '+l.length+' páginas · p. '+l[st.achadas.i];
}

/* ---------- os ganchos ---------- */
window.__pvPasta={
  /* Chamado pelo console depois de pintar o cartão das peças. Só liga o botão:
     nada é injetado na tela do processo. */
  aposDesenhar:function(numero){
    if(soDigitos(numero)!==soDigitos(st.numero)){fechar();st=novoEstado(numero)}
    var b=document.getElementById('pasta-abrir');
    if(b&&!b.getAttribute('data-ligado')){
      b.setAttribute('data-ligado','1');
      b.addEventListener('click',abrirPasta);
    }
    /* "Atualizar" recarregou as peças do processo: a Pasta aberta lê a lista nova. */
    if(st.aberta)recarregar();
  },
  trocouProcesso:function(numero){
    if(soDigitos(numero)!==soDigitos(st.numero))fechar();
  },
  fechar:fechar
};
})();
`;
