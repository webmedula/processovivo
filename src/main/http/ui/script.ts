/**
 * Script do console. Arquivo separado do HTML apenas para revisão.
 *
 * JavaScript puro de propósito: a página é uma string que o servidor devolve,
 * sem build, sem framework e sem recurso externo. Nada para compilar e nada que
 * quebre em deploy.
 */
import { descricaoDoAto } from '../../../domain/entities/descricaoDoAto.js';
import { nomeDaClasse } from '../../../domain/entities/nomeDaClasse.js';

export const SCRIPT = String.raw`
(function(){
var $=function(i){return document.getElementById(i)};
/* Classe para EXIBIÇÃO (domain/entities/nomeDaClasse.ts): a mesma função que os testes e o
   servidor usam; o dado guardado e a API seguem como vieram. */
var nomeDaClasse=${nomeDaClasse.toString()};
/* A última movimentação sem o tipo repetido (v0.37.1); o original vai no title. */
var descricaoDoAto=${descricaoDoAto.toString()};
var CH='processovivo.chave', VER='processovivo.verinternos';
var FILTRO_MOV='processovivo.filtroMov';
var SO_PRINCIPAIS='processovivo.soPrincipais';

/* A régua carregada, guardada por processo.
   Sem isto, cada clique num chip da linha do tempo redesenha o detalhe, que
   chama carregarPecas de novo — outra consulta ao MNI, dezenas de segundos, e
   mais uma chance de recusa contra a conta do advogado no tribunal. O cache
   vive na página: recarregar limpa, e há botão para atualizar à mão. */
var regua={numero:'',dados:null,baixadas:[]};
/* O mesmo processo chega escrito de dois jeitos — mascarado na lista, só
   dígitos na URL. Comparar as duas formas cruas faria o cache nunca acertar. */
function soDigitos(n){return String(n||'').replace(/\D/g,'')}
/** Textos completos dos andamentos exibidos, para o botão "ler o ato inteiro". */
var janelaTextos=[];

function recorte(t,n){
  var x=String(t).replace(/\s+/g,' ').trim();
  return x.length<=n?x:x.slice(0,n-1)+'…';
}
function chip(id,rotulo,atual){
  return '<button class="chip'+(atual===id?' on':'')+'" data-chip="'+id+'">'+rotulo+'</button>';
}
/** Data e hora — a hora importa quando se conta prazo. */
function dth(v){
  if(!v)return '—';
  try{return new Date(v).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',
    day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}
  catch(e){return '—'}
}
function redesenharDetalhe(){
  if(estado.detalhe)abrir(estado.detalhe); else executarBusca();
}

/* Códigos da Tabela Processual Unificada vistos numa resposta REAL do TJGO.
   A classificação é palpite de quem não advoga — por isso NADA é escondido de
   verdade: os internos ficam a um clique, com a contagem à vista. Sumir com
   movimentação em silêncio é como se perde prazo. */
var INTERNOS={12266:1,12265:1,581:1,60:1};
var MARCOS={26:1,219:1,848:1,12548:1,12455:1,12444:1,14739:1,123:1,1051:1};

var estado={aba:'novidades',chave:'',detalhe:null,eu:null,trilha:null,
  modoEntrada:'entrar',facetas:{tribunais:[],classes:[],clientes:[]},
  /* null = ainda não perguntamos ao servidor se ele consegue enviar e-mail.
     O link "esqueci minha senha" só aparece quando a resposta for true —
     oferecer e não enviar deixaria a pessoa esperando mensagem que não vem. */
  recuperacaoDisponivel:null,
  /* null = ainda não carregada. Pode ficar null para sempre numa sessão por
     chave de API, que não tem assinatura — e isso NÃO é erro. */
  assinatura:null};

/* ---------------- utilidades ---------------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function dt(iso){if(!iso)return'—';var d=new Date(iso);return isNaN(d)?'—':
  d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})}
function anoDe(iso){var d=new Date(iso);return isNaN(d)?'—':
  d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',year:'numeric'})}
function humano(iso){
  if(!iso)return'';
  var n=Math.floor((Date.now()-new Date(iso).getTime())/86400000);
  if(isNaN(n))return'';
  if(n<=0)return'hoje'; if(n===1)return'ontem';
  if(n<30)return'há '+n+' dias';
  if(n<365){var m=Math.round(n/30);return'há '+m+(m===1?' mês':' meses')}
  var a=Math.floor(n/365);return'há '+a+(a===1?' ano':' anos')}
/* Dia por extenso e hora, no fuso de Brasília.

   O advogado abre o sistema para decidir o que fazer HOJE, e a data no topo é a
   âncora dessa leitura — sem ela, "vence às 18h" não diz de que dia. A hora é a
   do carregamento e está rotulada como tal; relógio correndo na tela seria
   movimento sem informação. */
function diaPorExtenso(d){
  /* "Terça-feira, 29 de setembro" — montado por partes: o formato pronto do
     pt-BR traz o ano e abrevia o mês com ponto ("29 de set. de 2026"), e no
     topo do painel isso é conectivo demais para uma âncora de leitura. */
  try{
    var o={timeZone:'America/Sao_Paulo'};
    var semana=d.toLocaleDateString('pt-BR',Object.assign({weekday:'long'},o));
    var dia=d.toLocaleDateString('pt-BR',Object.assign({day:'numeric'},o));
    var mes=d.toLocaleDateString('pt-BR',Object.assign({month:'long'},o));
    return semana.charAt(0).toUpperCase()+semana.slice(1)+', '+dia+' de '+mes;
  }catch(e){return ''}
}
/* Pelo relógio de Brasília, não o do computador: um advogado viajando não
   deveria ler "Boa noite" às dez da manhã do fuso onde estão os prazos dele. */
function saudacao(){
  try{
    var h=Number(new Date().toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',hour12:false}).slice(0,2));
    return h<12?'Bom dia':h<18?'Boa tarde':'Boa noite';
  }catch(e){return 'Olá'}
}
/* Dia e mês curtos para o bloco de data do feed: "29" e "set". */
function diaMes(iso){
  var d=new Date(iso);
  if(!iso||isNaN(d))return ['—',''];
  var o={timeZone:'America/Sao_Paulo'};
  return [d.toLocaleDateString('pt-BR',Object.assign({day:'numeric'},o)),
    d.toLocaleDateString('pt-BR',Object.assign({month:'short'},o)).replace('.','')];
}
var ICONE_ATUALIZAR='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>';
var ICONE_LUPA='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
var ICONE_FILTROS='<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>';
var ICONE_MAIS='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
var ICONE_CHECK='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00C853" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
function horaDe(v){
  if(!v)return '';
  try{return new Date(v).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',
    hour:'2-digit',minute:'2-digit'})}
  catch(e){return ''}
}
/* "há 12 min" / "há 3 h" — o humano() existente conta em DIAS, e para a última
   verificação isso arredonda tudo para "hoje", que é justamente a distinção que
   importa aqui: verificado há 5 minutos e verificado há 14 horas são estados
   diferentes de confiança na tela. */
function desdeAgora(iso){
  if(!iso)return '';
  var min=Math.floor((Date.now()-new Date(iso).getTime())/60000);
  if(isNaN(min))return '';
  if(min<1)return 'agora há pouco';
  if(min<60)return 'há '+min+' min';
  var h=Math.floor(min/60);
  if(h<24)return 'há '+h+' h';
  var d=Math.floor(h/24);
  return 'há '+d+(d===1?' dia':' dias');
}
function tamanho(bytes){
  var b=Number(bytes)||0;
  if(b<1024)return b+' B';
  if(b<1048576)return Math.round(b/1024)+' KB';
  return (b/1048576).toFixed(1).replace('.',',')+' MB';
}

function mascara(n){var d=String(n||'').replace(/\D/g,'');
  return d.length===20?d.slice(0,7)+'-'+d.slice(7,9)+'.'+d.slice(9,13)+'.'+
    d.slice(13,14)+'.'+d.slice(14,16)+'.'+d.slice(16,20):String(n||'')}

function api(caminho,opcoes){
  opcoes=opcoes||{};
  /* A sessão viaja em cookie HttpOnly, que o navegador manda sozinho por ser
     a mesma origem. A chave só entra quando é ela que está autenticando —
     mandar as duas faria o servidor ter que escolher a cada requisição. */
  var h=estado.chave?{'x-api-key':estado.chave}:{};
  if(opcoes.body)h['content-type']='application/json';
  return fetch(caminho,{method:opcoes.method||'GET',headers:h,
    body:opcoes.body?JSON.stringify(opcoes.body):undefined})
    .then(function(r){return r.json().catch(function(){return{}})
      .then(function(b){
        if(!r.ok){var e=new Error(b.mensagem||('HTTP '+r.status));
          e.status=r.status;e.codigo=b.erro;e.detalhes=b.detalhes;throw e}
        return b})});
}

function explicar(e){
  var m={401:'Sua sessão expirou. Entre novamente.',
    409:'Já existe uma conta com este e-mail.',
    400:'O formato do número CNJ ou da OAB não confere.',
    404:'Consultamos as fontes e nenhuma tem esse processo.',
    429:'Muitas consultas seguidas. Aguarde um instante.',
    403:'O tribunal respondeu e não liberou este arquivo. Em geral significa que o acesso cadastrado não está habilitado nos autos.',
    424:'O tribunal recusou o acesso cadastrado. Atualize usuário e senha em "Meus acessos".',
    428:'Falta cadastrar o acesso do advogado no tribunal, em "Meus acessos".',
    501:'Nenhuma fonte configurada faz essa busca. Verifique PROCESSOVIVO_PROVIDER_CHAIN — a busca por OAB vem do DJEN.',
    502:'As fontes externas falharam. Em geral é o CNJ lento ou fora do ar.',
    503:'Fonte temporariamente indisponível.'};
  return m[e.status]||e.message||'Erro inesperado.';
}
/**
 * A caixa de erro da tela.
 *
 * Distingue DOIS erros que antes viravam a mesma caixa, e a confusão custou
 * caro: erro que veio do servidor (tem status) e erro de programação da
 * própria interface (um TypeError solto dentro de um .then, que o .catch
 * engole e traz para cá). No segundo caso a caixa antiga imprimia a mensagem do
 * TypeError duas vezes — como título E como explicação, porque explicar() cai
 * em e.message quando não há status — e o resultado era uma tela que dizia
 * "Cannot read properties of null" duas vezes, sem dizer onde.
 *
 * Agora ela diz que a falha é NOSSA e da interface, e imprime a primeira linha
 * da pilha. Quem relatar o problema passa a ter um endereço para me dar.
 */
function erroBloco(e){
  var doServidor=e&&(e.status!==undefined||e.codigo!==undefined);
  var titulo=doServidor?(e.message||'Falhou'):'Falha na interface';
  var detalhe=doServidor
    ? explicar(e)
    : (e&&e.message?e.message:'erro inesperado')+
      ' — isto é defeito do Processo Vivo, não da sua consulta.';
  var onde=!doServidor&&e&&e.stack?String(e.stack).split('\n')[1]:'';
  return '<div class="cartao" style="border-color:var(--erro);background:var(--erro-bg)">'+
    '<div style="font-weight:700;color:var(--erro);margin-bottom:4px">'+
    esc(titulo)+'</div><div style="color:var(--tinta2)">'+
    esc(detalhe)+'</div>'+
    (onde?'<div class="t-sub" style="margin-top:6px">'+esc(onde.trim())+'</div>':'')+
    '</div>';
}
function vazio(icone,titulo,texto,acao){
  return '<div class="cartao vazio"><div class="ic">'+icone+'</div><h3>'+esc(titulo)+
    '</h3><p>'+esc(texto)+'</p>'+(acao||'')+'</div>';
}

/* ---------------- chrome ---------------- */
function pintarNav(){
  ['novidades','processos','calendario','buscar','vigilancia','credenciais','conta'].forEach(function(a){
    var b=$('nav-'+a); if(b)b.classList.toggle('ativo',estado.aba===a&&!estado.detalhe)});
}
function atualizarBolha(){
  api('/v1/novidades?limite=1').then(function(r){
    var b=$('bolha');
    if(r.naoVistas>0){b.textContent=r.naoVistas>99?'99+':r.naoVistas;b.classList.remove('oculto')}
    else b.classList.add('oculto');
    /* A contagem da carteira vem de graça nesta mesma resposta: acompanhados
       já era devolvido aqui. Uma chamada só para dois números — a lateral não
       merece requisição própria. */
    var c=$('cont-processos');
    if(c)c.textContent=r.acompanhados>0?String(r.acompanhados):'';
  }).catch(function(){});
}

function ir(aba){
  // Sair do processo fecha a Pasta: o painel é do processo, não da aba.
  if(window.__pvPasta)window.__pvPasta.fechar();
  estado.aba=aba;estado.detalhe=null;pintarNav();render()}
window.__processovivo_ir=ir;

/* ---------------- aba: novidades ---------------- */
function verNovidades(){
  var alvo=$('conteudo');
  /* A tabela e os filtros moram em ui/atualizacoes.ts; aqui ficam o cabeçalho e a carga. */
  alvo.innerHTML=window.__pvAtualizacoes.esqueleto();
  var trib=window.__f_nv_trib||'';
  var q=trib?'tribunal='+encodeURIComponent(trib):'';
  /* A janela de tempo NÃO conta como filtro para o texto de "vazio": ela tem aviso próprio. */
  var jan=window.__f_nv_janela==='todas'?'&janela=todas':'';

  /* Duas chamadas em paralelo, e o painel NÃO derruba a tela se falhar: ele só
     informa a verificação. Trocar a tela inteira por um erro porque a frase de
     cima não veio seria perder o que funciona por causa do que enfeita. */
  Promise.all([
    api('/v1/novidades?'+q+jan),
    api('/v1/painel').catch(function(){return null})
  ]).then(function(res){
    var r=res[0], pn=res[1];
    var h=blocoAssinatura()+blocoTrilha();
    /* O número de PROCESSOS entra no subtítulo, antes do de movimentações.
       Esta tela mostra movimentação NOVA, e processo recém-adicionado não gera
       nenhuma — a primeira sincronização é o retrato inicial. Sem este número,
       a tela que a pessoa vê primeiro parece dizer que ela não tem nada, logo
       depois de ela cadastrar três processos. Aconteceu num teste real: o dado
       estava salvo e a interface convenceu o dono de que tinha sumido. */
    var acomp=r.acompanhados||0;
    var ver=(pn&&pn.verificacao)||{};

    var primeiroNome=estado.eu&&estado.eu.nome?estado.eu.nome.split(' ')[0]:'';
    h+='<div class="cabeca">'+
      '<div class="titulo-secao" style="margin-bottom:0"><div>'+
        '<div class="kicker">'+esc(diaPorExtenso(new Date()))+'</div>'+
        '<h2>'+(primeiroNome?esc(saudacao()+', '+primeiroNome):'Últimas atualizações')+'</h2>'+
        '<div class="sub">'+resumoDaVerificacao(ver,acomp,r)+'</div></div>'+
        '<div class="acoes">'+seloDeVerificacao(ver,acomp);
    if(r.naoVistas>0)h+='<button class="bt bt2" id="marcar">Marcar todas como lidas</button>';
    h+='<button class="bt bt2" id="sincronizar">'+ICONE_ATUALIZAR+'Verificar agora</button></div></div></div>'+
      '<div id="nv-tabela"></div>';
    alvo.innerHTML=h;

    window.__pvAtualizacoes.montar($('nv-tabela'),r,{
      tribunais:estado.facetas.tribunais,
      tribunal:trib,
      aoMudar:function(m){
        if(m.janela!==undefined)window.__f_nv_janela=m.janela;
        if(m.tribunal!==undefined)window.__f_nv_trib=m.tribunal;
        verNovidades();
      }
    });

    if($('marcar'))$('marcar').addEventListener('click',function(){
      api('/v1/novidades/marcar-vistas',{method:'POST',body:{}})
        .then(function(){atualizarBolha();verNovidades()})});
    $('sincronizar').addEventListener('click',dispararSync);
  }).catch(function(e){
    alvo.innerHTML=erroBloco(e)+'<p><button class="bt bt2" id="nv-tentar">Tentar de novo</button></p>';
    $('nv-tentar').addEventListener('click',verNovidades);
  });
}

function dispararSync(){
  var b=$('sincronizar'); if(!b)return;
  b.disabled=true;b.innerHTML='<span class="gira"></span>Verificando';
  api('/v1/sincronizar',{method:'POST',body:{}})
    .then(function(){
      b.innerHTML='Verificação iniciada';
      var aviso=document.createElement('div');
      aviso.className='aviso';aviso.style.marginTop='10px';
      aviso.innerHTML='Varredura em andamento. Cada processo leva alguns segundos '+
        '(a base do CNJ é lenta), então as novidades vão aparecendo aos poucos. '+
        'Pode fechar a página — ela continua rodando no servidor.';
      b.parentNode.parentNode.appendChild(aviso);
      var t=setInterval(function(){
        api('/v1/sincronizacao').then(function(s){
          if(!s.emAndamento){clearInterval(t);atualizarBolha();verNovidades()}})
          .catch(function(){clearInterval(t)});
      },4000);
    })
    .catch(function(e){b.disabled=false;b.textContent='Verificar agora';alert(explicar(e))});
}

/**
 * A frase que diz se dá para confiar na tela.
 *
 * Vem antes dos números de propósito, e é a mesma razão que obriga o
 * ServicoNotificacao a avisar quando NÃO conseguiu verificar: a partir do
 * primeiro aviso enviado, o advogado para de conferir à mão e lê silêncio como
 * "não houve nada". Silêncio só significa isso enquanto a verificação estiver
 * de pé.
 */
function resumoDaVerificacao(ver,acomp,r){
  /* A hora da verificação está no selo ao lado; aqui fica há quanto tempo foi,
     que é o que o selo não diz. */
  var partes=[];
  if(ver.ultimaEm&&!ver.emAndamento)partes.push('última verificação '+desdeAgora(ver.ultimaEm));
  partes.push(acomp+' processo(s) acompanhado(s)');
  if(r.naoVistas>0)partes.push(r.naoVistas+' não lida(s)');
  var txt=esc(partes.join(' · '));
  if(ver.naoVerificados>0){
    txt+=' · <span class="alerta-txt">'+ver.naoVerificados+
      ' sem verificação — o silêncio destas não significa que nada aconteceu</span>';
  }
  return txt;
}

/**
 * O selo ao lado do título: o estado da verificação num relance.
 *
 * Verde SÓ quando houve verificação e nenhum processo ficou sem ela. Processo
 * sem verificação deixa o selo âmbar, com a contagem — é a mesma regra da frase
 * de baixo, dita em cor: o silêncio só significa "nada aconteceu" enquanto a
 * verificação estiver de pé.
 */
function seloDeVerificacao(ver,acomp){
  if(!acomp)return '';
  if(ver.emAndamento)return '<span class="vigia neutro"><span class="gira"></span>Verificando agora</span>';
  if(ver.naoVerificados>0){
    return '<span class="vigia atencao"><span class="ponto-vivo"></span>'+
      ver.naoVerificados+' sem verificação</span>';
  }
  if(!ver.ultimaEm)return '<span class="vigia neutro"><span class="ponto-vivo"></span>Aguardando a primeira verificação</span>';
  return '<span class="vigia"><span class="ponto-vivo"></span>Verificado às '+
    esc(horaDe(ver.ultimaEm))+'</span>';
}

/* ---------------- aba: meus processos ---------------- */
function verProcessos(){
  var alvo=$('conteudo');
  alvo.innerHTML='<div class="cartao"><span class="gira"></span>Carregando…</div>';
  var f=window.__f_pr||{};
  var q=[];
  if(f.texto)q.push('texto='+encodeURIComponent(f.texto));
  if(f.tribunal)q.push('tribunal='+encodeURIComponent(f.tribunal));
  if(f.parte)q.push('parte='+encodeURIComponent(f.parte));
  if(f.cliente)q.push('cliente='+encodeURIComponent(f.cliente));
  if(f.classe)q.push('classe='+encodeURIComponent(f.classe));
  if(f.novidade)q.push('comNovidade=true');
  if(f.dias)q.push('ultimosDias='+f.dias);
  if(f.ordem)q.push('ordem='+f.ordem);

  api('/v1/acompanhamentos'+(q.length?'?'+q.join('&'):'')).then(function(r){
    var h='<div class="titulo-secao"><div><h2>Meus processos</h2>'+
      (r.total<(r.totalSemFiltro===undefined?r.total:r.totalSemFiltro)?'':'<div class="sub sub-carteira">'+r.total+' acompanhado(s)</div>')+'</div>'+
      '<button class="bt" id="ir-buscar">'+ICONE_MAIS+'Adicionar processo</button></div>';

    /* Filtros escondidos em "Mais filtros" que estão VALENDO são contados no
       botão, e o painel fica aberto enquanto houver algum: filtro ativo que
       ninguém vê é como a carteira "perde" processos (ver o aviso abaixo). */
    var ocultosAtivos=[f.parte,f.classe,f.dias,(f.ordem&&f.ordem!=='MOVIMENTACAO_RECENTE')?f.ordem:'']
      .filter(function(v){return !!v}).length;
    var maisAberto=!!window.__f_pr_mais||ocultosAtivos>0;

    /* Os rótulos existem porque sem eles a barra vira uma fileira de caixas
       mudas: quem abre a tela não sabe que aquele "Tribunal" é um filtro e não
       o tribunal do primeiro processo. Numa carteira de centenas, filtro que
       não se anuncia é filtro que ninguém usa. */
    h+='<div class="barra-filtros">'+
      '<label class="busca" for="f-txt">'+ICONE_LUPA+
        '<input id="f-txt" placeholder="Buscar por número, apelido, vara ou texto do ato" '+
        'value="'+esc(f.texto||'')+'"></label>'+
      '<select id="f-trib" aria-label="Tribunal"><option value="">Tribunal: todos</option>'+
        estado.facetas.tribunais.map(function(t){return '<option value="'+esc(t)+'"'+(f.tribunal===t?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select>'+
      '<select id="f-cli" aria-label="Cliente"><option value="">Cliente: todos</option>'+
        (estado.facetas.clientes||[]).map(function(c){return '<option value="'+esc(c)+'"'+(f.cliente===c?' selected':'')+'>'+esc(c)+'</option>'}).join('')+'</select>'+
      '<button class="chip'+(maisAberto?' on':'')+'" id="f-mais" aria-expanded="'+maisAberto+'"'+
        (ocultosAtivos?' title="Há filtro valendo aqui dentro; limpe-o para recolher"':'')+'>'+
        ICONE_FILTROS+'Mais filtros'+(ocultosAtivos?' <span class="conta-filtro">'+ocultosAtivos+'</span>':'')+'</button>'+
      '<button class="chip nv'+(f.novidade?' on':'')+'" id="f-nv" aria-pressed="'+(!!f.novidade)+'">Com novidade</button>'+
      '</div>';

    h+='<div class="filtros'+(maisAberto?'':' oculto')+'" id="filtros-mais">'+
      '<div style="flex:2 1 220px"><label class="rotulo" for="f-parte">Parte</label>'+
        '<input id="f-parte" placeholder="nome do cliente ou da outra parte" '+
        'value="'+esc(f.parte||'')+'"></div>'+
      '<div><label class="rotulo" for="f-cls">Classe</label>'+
        '<select id="f-cls"><option value="">Todas</option>'+
        estado.facetas.classes.map(function(c){return '<option value="'+esc(c)+'"'+(f.classe===c?' selected':'')+'>'+esc(c)+'</option>'}).join('')+'</select></div>'+
      '<div><label class="rotulo" for="f-dias">Movimentado em</label>'+
        '<select id="f-dias"><option value="">Qualquer período</option>'+
        [['7','Últimos 7 dias'],['30','Últimos 30 dias'],['90','Últimos 90 dias'],['365','Último ano']]
          .map(function(o){return '<option value="'+o[0]+'"'+(f.dias===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select></div>'+
      '<div><label class="rotulo" for="f-ord">Ordenar por</label>'+
        '<select id="f-ord">'+
        [['MOVIMENTACAO_RECENTE','Movimentação recente'],['ADICIONADO_RECENTE','Adicionado recente'],['NUMERO','Número']]
          .map(function(o){return '<option value="'+o[0]+'"'+(f.ordem===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select></div>'+
      '</div>';

    /* Filtro ativo que esconde processo PRECISA se anunciar.
       Estes filtros vivem numa variável global da página: sobrevivem a trocar
       de aba e só somem quando a página recarrega. Foi assim que um filtro
       esquecido fez a carteira parecer ter um processo em vez de três — e só
       sair e entrar de novo "resolveu", o que é o pior tipo de conserto,
       porque não ensina nada e deixa a desconfiança. */
    var totalReal=(r.totalSemFiltro===undefined?r.total:r.totalSemFiltro);
    if(r.total<totalReal){
      h+='<div class="aviso" style="margin-bottom:12px">Mostrando <b>'+r.total+
        '</b> de <b>'+totalReal+'</b> processos — há filtro ativo. '+
        '<button class="link" id="limpar-f">limpar filtros</button></div>';
    }

    if(!r.acompanhamentos.length){
      h+=vazio('📁',
        (q.length?'Nenhum processo com esses filtros':'Você ainda não acompanha nenhum processo'),
        (q.length?'Ajuste os filtros para ver mais.'
          :'Busque um processo pelo número e clique em acompanhar. A partir daí o Processo Vivo verifica sozinho e avisa quando houver movimentação nova.'),
        q.length?'':'<button class="bt" onclick="window.__processovivo_ir(\'buscar\')">Buscar processo</button>');
    }else{
      h+=tabelaDaCarteira(r.acompanhamentos);
    }
    alvo.innerHTML=h;

    $('ir-buscar').addEventListener('click',function(){ir('buscar')});
    /* ATENÇÃO ao ramo de reset: a versão anterior fazia
       Object.assign({}, __f_pr, {}) — que MANTÉM tudo, em vez de limpar. O
       botão de limpar filtros existia e não limpava nada. */
    var setF=function(k,v){
      if(k==='reset'){window.__f_pr={}}
      else{
        var o={};o[k]=v;
        // Guarda quem tem o foco para devolvê-lo depois do redesenho.
        var ativo=document.activeElement;
        o.__focado=(ativo&&(ativo.id==='f-txt'||ativo.id==='f-parte'))?ativo.id:null;
        window.__f_pr=Object.assign({},window.__f_pr,o);
      }
      verProcessos();
    };
    var lf=$('limpar-f');
    if(lf)lf.addEventListener('click',function(){setF('reset')});
    $('f-trib').addEventListener('change',function(){setF('tribunal',this.value)});
    $('f-cls').addEventListener('change',function(){setF('classe',this.value)});
    $('f-cli').addEventListener('change',function(){setF('cliente',this.value)});
    $('f-dias').addEventListener('change',function(){setF('dias',this.value)});
    $('f-ord').addEventListener('change',function(){setF('ordem',this.value)});
    $('f-nv').addEventListener('click',function(){setF('novidade',!f.novidade)});
    /* Abrir e fechar o painel NÃO refaz a consulta: só mostra o que já está na
       página. Com filtro escondido valendo, ele não fecha — ver maisAberto. */
    $('f-mais').addEventListener('click',function(){
      if(ocultosAtivos>0)return;
      window.__f_pr_mais=!window.__f_pr_mais;
      var aberto=!!window.__f_pr_mais;
      $('filtros-mais').classList.toggle('oculto',!aberto);
      this.classList.toggle('on',aberto);
      this.setAttribute('aria-expanded',String(aberto));
    });
    /* Os dois campos de texto esperam 350ms antes de consultar: cada tecla
       dispararia uma ida ao banco e um redesenho, e o cursor saltaria. */
    var t;
    var comAtraso=function(campo,chave){
      var el=$(campo); if(!el)return;
      el.addEventListener('input',function(){
        var v=this.value;clearTimeout(t);
        t=setTimeout(function(){setF(chave,v)},350)});
    };
    comAtraso('f-txt','texto');
    comAtraso('f-parte','parte');
    alvo.querySelectorAll('[data-abrir]').forEach(function(el){
      el.addEventListener('click',function(){abrir(el.getAttribute('data-abrir'))})});
    /* A rotulagem é ligada AQUI, na carteira, que é onde os botões existem.
       Desde a v0.25.0 ela era ligada só na tela de Atualizações, que não tem
       botão de rotular nenhum — e o clique em "rotular" não fazia nada. */
    ligarRotulagem(alvo);

    /* A tela é redesenhada a cada filtro, o que apaga o foco — quem estava
       digitando perderia o campo no meio da palavra. Devolver o cursor ao fim
       do texto é o que faz a busca parecer instantânea em vez de truncada. */
    if(f.__focado){
      var fc=$(f.__focado);
      if(fc){fc.focus();fc.setSelectionRange(fc.value.length,fc.value.length)}
    }
  }).catch(function(e){alvo.innerHTML=erroBloco(e)});
}

/**
 * A carteira em tabela.
 *
 * Os cartões empilhados que havia antes funcionavam com dez processos e viravam
 * rolagem com cento e quarenta: cada pasta ocupava quatro linhas, e comparar
 * duas exigia percorrer a tela inteira. Uma tabela responde de longe — o olho
 * desce uma coluna em vez de ler parágrafos.
 *
 * O que NÃO se perdeu na troca: as partes. Desde a v0.29.0 elas têm coluna
 * própria, sempre visível — antes dividiam a coluna Cliente e sumiam assim que
 * a pasta ganhava rótulo. Era por elas que o advogado achava "os processos do
 * cliente X", e tirá-las para caber numa grade seria trocar informação por
 * alinhamento.
 */
function tabelaDaCarteira(lista){
  /* Larguras fixas por coluna (table-layout:fixed): é o que deixa cada
     célula cortar com reticências em vez de esticar a linha. Partes fica com
     o que sobrar — é o texto mais longo e o que mais tolera corte, porque o
     nome inteiro está no "title". */
  var h='<div class="cartao sem-borda"><div class="tab-rolo"><table class="tab fixa">'+
    '<colgroup><col style="width:25%"><col style="width:14%"><col>'+
    '<col style="width:88px"><col style="width:23%"><col style="width:132px"></colgroup>'+
    '<thead><tr>'+
      '<th>Processo</th><th>Cliente</th><th>Partes</th><th>Tribunal</th>'+
      '<th>Última movimentação</th><th>Estado</th>'+
    '</tr></thead><tbody>';

  lista.forEach(function(a){
    var e=a.estado||{rotulo:'EM_CURSO',naoVerificado:false};
    var classeTxt=(nomeDaClasse(a.classe)||'classe não informada')+(a.vara?' · '+a.vara:'');
    var classeCru=(a.classe||'classe não informada')+(a.vara?' · '+a.vara:'');
    var movTxt=a.ultimaMovimentacao?descricaoDoAto(a.ultimaMovimentacao.titulo):'';
    var partes=(a.partes||[]).map(function(x){return x.nome}).join(' · ');
    h+='<tr'+(a.novidadesNaoVistas>0?' class="nova"':'')+'>'+
      '<td><button class="lnh corta" data-abrir="'+esc(a.numero)+'">'+
        '<span class="n">'+esc(a.numero)+'</span></button>'+
        '<div class="t-sub corta" title="'+esc(classeCru)+'">'+esc(classeTxt)+'</div></td>'+
      '<td>'+celulaDeCliente(a)+'</td>'+
      '<td><span class="corta" style="font-size:13px;color:var(--tinta2)" title="'+esc(partes)+'">'+
        (partes?esc(partes):'—')+'</span></td>'+
      '<td><span class="trib">'+esc(a.tribunal||'—')+'</span>'+
        (a.segredoJustica?'<div style="margin-top:3px"><span class="selo al">segredo</span></div>':'')+'</td>'+
      '<td>'+
        (a.ultimaMovimentacao
          ? '<div class="corta t-mov-t" style="font-weight:600" title="'+esc(a.ultimaMovimentacao.titulo)+'">'+
              esc(movTxt)+'</div>'+
            '<div class="t-sub">'+dt(a.ultimaMovimentacao.data)+' · '+
            humano(a.ultimaMovimentacao.data)+'</div>'
          : '<div class="t-sub">'+(a.erro?'não foi possível consultar'
              :'aguardando primeira consulta')+'</div>')+
      '</td>'+
      '<td>'+seloDeEstado(e,a)+'</td>'+
    '</tr>';
  });
  return h+'</tbody></table></div></div>';
}

/** Os quatro estados, e o aviso de verificação que corre por fora deles. */
function seloDeEstado(e,a){
  /* Uma cor, um significado: âmbar pede providência, azul é novidade, verde é
     "em curso e em dia". Arquivado fica apagado. */
  var m={
    PROVIDENCIA:['pr','providência'],
    NOVIDADE:['nv',(a.novidadesNaoVistas||0)+' nova(s)'],
    ARQUIVADO:['neutro','arquivado'],
    EM_CURSO:['ok','em curso']
  };
  var par=m[e.rotulo]||m.EM_CURSO;
  var h='<span class="selo'+(par[0]?' '+par[0]:'')+'"'+
    (e.motivo?' title="'+esc(e.motivo)+'"':'')+'>'+esc(par[1])+'</span>';
  /* O aviso de "não verificado" é SEPARADO do selo, e não um quinto valor dele.
     Uma pasta pode ter prazo aberto e estar sem verificação há três dias, e as
     duas informações importam: uma diz o que fazer hoje, a outra diz para não
     confiar no silêncio. Colapsá-las esconderia sempre uma. */
  if(e.naoVerificado){
    h+='<div style="margin-top:3px"><span class="selo al" title="'+esc(a.erro||'ainda não sincronizado')+
      '">não verificado</span></div>';
  }
  return h;
}

/**
 * A coluna Cliente: o rótulo quando existe, um convite a rotular quando não.
 *
 * Nunca uma das partes no lugar do cliente. O tribunal entrega as partes sem
 * dizer qual delas o advogado representa; apresentar uma delas como "o
 * cliente" seria afirmar o que ninguém afirmou, e o palpite errado põe o nome
 * do adversário ali. As partes têm coluna própria, ao lado.
 */
function celulaDeCliente(a){
  if(a.cliente){
    return '<button class="lnh forte corta" data-rotular="'+esc(a.numero)+'" '+
      'title="editar o cliente: '+esc(a.cliente)+'">'+esc(a.cliente)+'</button>';
  }
  /* Sem rótulo, a célula é um convite a rotular. As partes ganharam coluna
     própria na v0.29.0 e não precisam mais ocupar esta. */
  return '<button class="rotular" data-rotular="'+esc(a.numero)+'" '+
    'title="dar um nome de cliente a esta pasta">+ rotular cliente</button>';
}

/**
 * Edição do rótulo na própria linha.
 *
 * Em vez de abrir a pasta para nomear o cliente: rotular cento e quarenta
 * processos é trabalho de uma sentada, e um ida-e-volta por pasta transformaria
 * isso numa tarde. Enter grava, Esc cancela, campo vazio APAGA o rótulo — sem
 * essa última, um nome digitado errado ficaria para sempre.
 */
function ligarRotulagem(alvo){
  alvo.querySelectorAll('[data-rotular]').forEach(function(el){
    el.addEventListener('click',function(ev){
      ev.stopPropagation();
      var numero=el.getAttribute('data-rotular');
      var atual=el.classList.contains('forte')?el.textContent:'';
      var celula=el.parentNode;
      celula.innerHTML='<input class="t-in" maxlength="120" placeholder="nome do cliente">';
      var campo=celula.firstChild;
      campo.value=atual;
      campo.focus();
      campo.select();

      var fechado=false;
      var gravar=function(){
        if(fechado)return; fechado=true;
        var valor=campo.value.trim();
        if(valor===atual){verProcessos();return}
        api('/v1/acompanhamentos/'+encodeURIComponent(numero)+'/cliente',
            {method:'PUT',body:{cliente:valor}})
          .then(function(){return carregarFacetas()})
          .then(verProcessos)
          .catch(function(e){alert(explicar(e));verProcessos()});
      };
      campo.addEventListener('keydown',function(k){
        if(k.key==='Enter'){k.preventDefault();gravar()}
        else if(k.key==='Escape'){fechado=true;verProcessos()}
      });
      campo.addEventListener('blur',gravar);
    });
  });
}

/* ---------------- aba: buscar ---------------- */
function verBuscar(){
  $('conteudo').innerHTML=
    '<div class="titulo-secao"><div><h2>Buscar processo</h2>'+
    '<div class="sub">Consulte pelo número CNJ ou pela OAB do advogado</div></div></div>'+
    '<div class="cartao"><div class="grade">'+
      '<div style="flex:0 0 168px"><label class="rotulo" for="modo">Consultar por</label>'+
      '<select id="modo"><option value="numero">Número do processo</option>'+
      '<option value="oab">OAB do advogado</option></select></div>'+
      '<div id="c-num"><label class="rotulo" for="numero">Número CNJ</label>'+
      '<input id="numero" placeholder="0311517-22.2015.8.09.0051" spellcheck="false"></div>'+
      '<div id="c-oab" class="oculto" style="flex:0 0 130px"><label class="rotulo" for="oab">Inscrição</label>'+
      '<input id="oab" placeholder="234567"></div>'+
      '<div id="c-uf" class="oculto" style="flex:0 0 84px"><label class="rotulo" for="uf">UF</label>'+
      '<input id="uf" placeholder="GO" maxlength="2"></div>'+
    '</div><div style="margin-top:14px;display:flex;gap:12px;align-items:center">'+
      '<button class="bt" id="bt-buscar">Consultar</button>'+
      '<span id="cron" style="font-size:13px;color:var(--tinta3)"></span></div>'+
      '<div id="espera" class="aviso oculto" style="margin-top:12px">A primeira consulta '+
      'de um processo pode levar até um minuto — a base do CNJ responde devagar quando o '+
      'dado ainda não está no cache dela.<div class="barra-prog"></div></div>'+
    '</div><div id="res"></div>';

  $('modo').addEventListener('change',function(){
    var o=this.value==='oab';
    $('c-num').classList.toggle('oculto',o);
    $('c-oab').classList.toggle('oculto',!o);
    $('c-uf').classList.toggle('oculto',!o)});
  $('bt-buscar').addEventListener('click',executarBusca);
  ['numero','oab','uf'].forEach(function(i){
    $(i).addEventListener('keydown',function(e){if(e.key==='Enter')executarBusca()})});
}

var cron=null;
function espera(on){
  if(on){var t0=Date.now();$('espera').classList.remove('oculto');
    cron=setInterval(function(){$('cron').textContent=Math.round((Date.now()-t0)/1000)+'s'},250)}
  else{clearInterval(cron);$('cron').textContent='';$('espera').classList.add('oculto')}
}

/**
 * Resultado da busca por OAB, com as PARTES à vista e filtro por cliente.
 *
 * As partes já vinham na resposta e eram descartadas — o DJEN manda os
 * destinatários de cada intimação, e o mapper os consolida em partes. Uma
 * carteira de 130 processos sem mostrar quem é a parte obriga o advogado a
 * abrir um por um para achar os do cliente X, que é o trabalho que ele queria
 * que o sistema fizesse.
 *
 * O filtro é LOCAL, sobre a lista já em mãos: refazer a consulta a cada letra
 * digitada gastaria uma ida ao DJEN por tecla.
 */
function desenharBuscaOab(){
  var b=estado.buscaOab; if(!b)return;
  var alvo=$('res'); if(!alvo)return;

  var termo=(b.texto||'').trim().toUpperCase();
  var digitos=termo.replace(/\D/g,'');
  var lista=b.lista.filter(function(p){
    if(b.tribunal&&p.tribunal!==b.tribunal)return false;
    if(!termo)return true;
    if(digitos&&String(p.numero||'').replace(/\D/g,'').indexOf(digitos)>=0)return true;
    if(String(p.classe||'').toUpperCase().indexOf(termo)>=0)return true;
    /* As partes entram na busca livre: é o caso de uso que motivou a tela —
       "em quais destes eu represento o Condomínio X". */
    return (p.partes||[]).some(function(x){
      return String(x.nome||'').toUpperCase().indexOf(termo)>=0});
  });

  var tribunais=[];
  b.lista.forEach(function(p){
    if(p.tribunal&&tribunais.indexOf(p.tribunal)<0)tribunais.push(p.tribunal)});
  tribunais.sort();

  var ja=b.jaAcompanhados||{};
  var sel=b.sel||{};
  /* Só conta como selecionado quem está VISÍVEL no filtro atual. Marcar 7,
     filtrar para outra coisa e clicar acompanharia processos fora da tela —
     exatamente o que o rótulo diria não estar fazendo. */
  var selVisiveis=lista.filter(function(p){
    return sel[String(p.numero)]&&!ja[String(p.numero)]});
  var novosVisiveis=lista.filter(function(p){return !ja[String(p.numero)]});
  var alvos=selVisiveis.length?selVisiveis:novosVisiveis;

  /* O rótulo diz o NÚMERO, e é isso que resolve a ambiguidade antiga: o botão
     dizia "Acompanhar todos" ao lado de um título com o total sem filtro, e
     acompanhava só os filtrados. Três números na tela e o botão era o único
     que não se explicava. */
  var rotuloLote = selVisiveis.length
    ? 'Acompanhar '+selVisiveis.length+' selecionado(s)'
    : (lista.length<b.lista.length
        ? 'Acompanhar os '+novosVisiveis.length+' filtrados'
        : 'Acompanhar os '+novosVisiveis.length);

  var h='<div class="titulo-secao"><div><h2>'+b.lista.length+' processo(s)</h2>'+
    '<div class="sub">Vieram das publicações do diário oficial. Processo sem '+
    'publicação recente não aparece aqui.</div></div>'+
    (alvos.length
      ? '<button class="bt bt2" id="bt-lote">'+esc(rotuloLote)+'</button>'
      : '<span class="selo nv">todos já acompanhados</span>')+
    '</div>';

  h+='<div class="filtros">'+
    '<div style="flex:2 1 240px"><input id="o-txt" placeholder="Filtrar por parte, classe ou número" '+
      'value="'+esc(b.texto||'')+'"></div>'+
    '<div><select id="o-trib"><option value="">Todos os tribunais</option>'+
      tribunais.map(function(t){
        return '<option'+(b.tribunal===t?' selected':'')+'>'+esc(t)+'</option>'}).join('')+
    '</select></div>'+
    ((b.texto||b.tribunal)?'<div class="compacto"><button class="chip" id="o-limpar">limpar</button></div>':'')+
    (novosVisiveis.length?'<div class="compacto"><button class="chip" id="o-marcar">'+
      (selVisiveis.length>=novosVisiveis.length?'desmarcar todos':'marcar os '+novosVisiveis.length+' visíveis')+
      '</button></div>':'')+
    '</div>';

  /* Mostrando X de Y, sempre que houver recorte. A tela nunca mostra um
     subconjunto calada — a regra que ficou do filtro fantasma. */
  if(lista.length<b.lista.length){
    h+='<div class="aviso" style="margin-bottom:12px">Mostrando <b>'+lista.length+
      '</b> de <b>'+b.lista.length+'</b> processos.</div>';
  }

  if(!lista.length){
    h+=vazio('🔍','Nenhum processo com esse filtro',
      'Nenhum dos '+b.lista.length+' processos tem parte, classe ou número com esse texto.');
  }else{
    lista.forEach(function(p){
      var um=(p.movimentacoes&&p.movimentacoes[0])||null;
      var partes=(p.partes||[]).slice(0,4).map(function(x){
        return '<span class="selo'+(x.polo==='ATIVO'?' nv':'')+'">'+
          esc(rotuloPolo(x.polo))+'</span> '+esc(x.nome)}).join(' · ');
      var resto=(p.partes||[]).length-4;
      /* A linha deixou de ser um <button> só.

         Caixa de seleção dentro de botão é HTML inválido e os cliques se
         atropelam — o de marcar dispara o de abrir. Agora são duas áreas
         irmãs: a caixa, e o corpo que continua abrindo o processo. */
      var n=String(p.numero), jaTem=!!ja[n];
      h+='<div class="item" style="display:flex;gap:10px;align-items:flex-start">'+
        '<label style="padding:2px 0 0;cursor:'+(jaTem?'default':'pointer')+'">'+
          '<input type="checkbox" data-sel="'+esc(n)+'"'+
          (jaTem?' checked disabled':(sel[n]?' checked':''))+'></label>'+
        '<button data-num="'+esc(p.numero)+'" style="flex:1;text-align:left;'+
          'background:none;border:0;padding:0;cursor:pointer;color:inherit;font:inherit">'+
          '<div class="lin1"><span class="n">'+esc(p.numero)+'</span>'+
          '<span class="selo">'+esc(p.tribunal||'—')+'</span>'+
          (jaTem?'<span class="selo nv">já acompanhando</span>':'')+'</div>'+
          '<div class="lin2">'+esc(nomeDaClasse(p.classe)||'classe não informada')+'</div>'+
          (partes?'<div class="lin3">'+partes+(resto>0?' · <span class="cp">+'+resto+'</span>':'')+'</div>':
            '<div class="lin3"><span class="cp">partes não informadas nesta publicação</span></div>')+
          (um?'<div class="lin3"><span class="cp">'+esc(um.titulo)+' · '+dt(um.data)+'</span></div>':'')+
        '</button></div>';
    });
  }

  alvo.innerHTML=h;

  /* O lote lê os alvos NA HORA DO CLIQUE, e não no momento da ligação. Com a
     lista congelada na ligação, marcar uma caixa depois de desenhar mandaria
     para o servidor o conjunto antigo — o botão diria um número e faria
     outro. */
  ligarAcompanharLote(function(){
    var s=estado.buscaOab.sel||{}, j=estado.buscaOab.jaAcompanhados||{};
    var marcados=lista.filter(function(p){
      return s[String(p.numero)]&&!j[String(p.numero)]});
    var fonte=marcados.length?marcados:lista.filter(function(p){
      return !j[String(p.numero)]});
    return fonte.map(function(p){return p.numero});
  });

  alvo.querySelectorAll('[data-sel]').forEach(function(el){
    el.addEventListener('change',function(){
      var n=el.getAttribute('data-sel');
      if(el.checked)estado.buscaOab.sel[n]=true; else delete estado.buscaOab.sel[n];
      /* Só o rótulo é repintado. Redesenhar a lista inteira a cada clique
         jogaria a rolagem para o topo, e numa carteira de 130 processos isso
         inviabiliza marcar mais de um. */
      atualizarRotuloLote(lista);
    });
  });

  var mk=$('o-marcar');
  if(mk)mk.addEventListener('click',function(){
    var j=estado.buscaOab.jaAcompanhados||{};
    var novos=lista.filter(function(p){return !j[String(p.numero)]});
    var marcadosAgora=novos.filter(function(p){
      return estado.buscaOab.sel[String(p.numero)]}).length;
    var ligar=marcadosAgora<novos.length;
    novos.forEach(function(p){
      var n=String(p.numero);
      if(ligar)estado.buscaOab.sel[n]=true; else delete estado.buscaOab.sel[n];
    });
    desenharBuscaOab();
  });

  var t;
  $('o-txt').addEventListener('input',function(){
    var v=this.value;clearTimeout(t);
    t=setTimeout(function(){estado.buscaOab.texto=v;desenharBuscaOab();
      var c=$('o-txt'); if(c){c.focus();c.setSelectionRange(v.length,v.length)}},250)});
  $('o-trib').addEventListener('change',function(){
    estado.buscaOab.tribunal=this.value;desenharBuscaOab()});
  var lp=$('o-limpar');
  if(lp)lp.addEventListener('click',function(){
    estado.buscaOab.texto='';estado.buscaOab.tribunal='';desenharBuscaOab()});
  alvo.querySelectorAll('[data-num]').forEach(function(el){
    el.addEventListener('click',function(){
      $('modo').value='numero';$('modo').dispatchEvent(new Event('change'));
      $('numero').value=el.getAttribute('data-num');executarBusca()})});
}

/** AT/PA do DJEN em palavra, que é como o advogado fala. */
function rotuloPolo(polo){
  /* O enum do domínio é ATIVO | PASSIVO | OUTROS. "OUTROS" não vira "terceiro"
     porque a fonte não disse isso — pode ser MP, assistente, perito. */
  var m={ATIVO:'autor',PASSIVO:'réu',OUTROS:'outra parte'};
  return m[polo]||'parte';
}

function executarBusca(){
  var porOab=$('modo').value==='oab', url;
  if(porOab){
    var o=$('oab').value.trim(),u=$('uf').value.trim().toUpperCase();
    if(!o||!u)return;
    url='/v1/advogados/'+encodeURIComponent(u)+'/'+encodeURIComponent(o)+'/processos';
  }else{
    var n=$('numero').value.trim(); if(!n)return;
    url='/v1/processos/'+encodeURIComponent(n);
  }
  $('bt-buscar').disabled=true;$('bt-buscar').innerHTML='<span class="gira"></span>Consultando';
  $('res').innerHTML='';espera(true);

  api(url).then(function(b){
    espera(false);$('bt-buscar').disabled=false;$('bt-buscar').textContent='Consultar';
    if(porOab){
      var l=b.processos||[];
      if(!l.length){$('res').innerHTML=vazio('🔍','Nenhum processo','Essa OAB não retornou processos nas fontes configuradas.');return}
      /* O resultado fica no estado do console, e NÃO numa variável global da
         página.
         Filtro em variável global sobrevive a trocar de aba e só morre com
         recarregamento — foi assim que um filtro esquecido fez a carteira
         parecer ter um processo em vez de três. Aqui ele nasce com a busca e
         morre com ela. */
      /* "sel" nasce com a busca e morre com ela, pelo mesmo motivo do filtro:
         seleção que sobrevive à troca de aba faz o advogado acompanhar o que
         marcou em outra consulta, sem ver o que está marcando. */
      estado.buscaOab={lista:l,texto:'',tribunal:'',sel:{},jaAcompanhados:null};
      desenharBuscaOab();

      /* Quem já está na carteira precisa aparecer marcado e travado. Sem isso
         o advogado marca 7, clica, e o resultado diz "4 acompanhados" porque 3
         já estavam lá — e ele não entende a conta. Falha aqui não quebra a
         tela: na pior hipótese nenhum aparece como já acompanhado. */
      api('/v1/acompanhamentos').then(function(r){
        var m={};
        (r.acompanhamentos||[]).forEach(function(a){m[String(a.numero)]=true});
        if(estado.buscaOab){estado.buscaOab.jaAcompanhados=m;desenharBuscaOab()}
      }).catch(function(){
        if(estado.buscaOab){estado.buscaOab.jaAcompanhados={};desenharBuscaOab()}
      });
      return;
    }
    $('res').innerHTML=processoHtml(b,null,{buscaAvulsa:true})+'<div id="pecas"></div>';
    ligarBotoesDetalhe(b.numero,false);
    oferecerPecas(b.numero);
  }).catch(function(e){
    espera(false);$('bt-buscar').disabled=false;$('bt-buscar').textContent='Consultar';
    $('res').innerHTML=erroBloco(e);
  });
}

/**
 * Acompanhar em lote o resultado de uma busca por OAB.
 *
 * É o fluxo que fecha o produto: o advogado digita a própria inscrição uma vez
 * e sai com a carteira inteira sob vigilância, em vez de recadastrar processo
 * por processo.
 *
 * Sequencial de propósito. Disparar 80 POSTs de uma vez faria o servidor abrir
 * 80 consultas às fontes ao mesmo tempo, estourar o rate limit e derrubar a
 * própria varredura. Devagar e mostrando o progresso é melhor do que rápido e
 * pela metade.
 */
function ligarAcompanharLote(alvosAgora){
  var bt=$('bt-lote'); if(!bt)return;
  bt.addEventListener('click',function(){
    var numeros=alvosAgora();
    if(!numeros.length)return;

    /* Confirmação a partir de 20.

       Acompanhar 130 processos não é só uma linha no banco: a próxima
       varredura vai consultar os 130 no tribunal, com a pausa configurada
       entre eles, contra a cota compartilhada do CNJ. Não é proibitivo, e
       merece um aviso — somos convidados no servidor alheio. */
    if(numeros.length>=20&&!window.confirm(
      'Acompanhar '+numeros.length+' processos?\n\n'+
      'Cada um passa a ser consultado no tribunal a cada varredura. '+
      'Você pode deixar de acompanhar depois, um a um.')){
      return;
    }

    bt.disabled=true;
    var ok=0,falhou=0,i=0;
    function passo(){
      if(i>=numeros.length){
        bt.innerHTML=ok+' acompanhado(s)'+(falhou?' · '+falhou+' falhou(ram)':'');
        carregarFacetas();
        /* Redesenha para que os recém-acompanhados apareçam travados, com o
           selo. Sem isto o advogado reclica e o contador diz zero, sem
           explicar por quê. */
        if(estado.buscaOab){
          if(!estado.buscaOab.jaAcompanhados)estado.buscaOab.jaAcompanhados={};
          numeros.forEach(function(n){estado.buscaOab.jaAcompanhados[String(n)]=true});
          estado.buscaOab.sel={};
          setTimeout(desenharBuscaOab,1200);
        }
        return;
      }
      bt.innerHTML='<span class="gira"></span>'+(i+1)+'/'+numeros.length;
      api('/v1/acompanhamentos',{method:'POST',body:{numero:numeros[i]}})
        .then(function(){ok++}).catch(function(){falhou++})
        .then(function(){i++;passo()});
    }
    passo();
  });
}

/**
 * Repinta só o rótulo do botão de lote.
 *
 * Existe porque marcar uma caixa não pode redesenhar a lista: numa carteira de
 * 130 processos, a rolagem voltaria ao topo a cada clique e seria impossível
 * marcar o segundo.
 */
function atualizarRotuloLote(lista){
  var bt=$('bt-lote'); if(!bt||!estado.buscaOab)return;
  var s=estado.buscaOab.sel||{}, j=estado.buscaOab.jaAcompanhados||{};
  var marcados=lista.filter(function(p){
    return s[String(p.numero)]&&!j[String(p.numero)]}).length;
  var novos=lista.filter(function(p){return !j[String(p.numero)]}).length;
  var filtrado=lista.length<estado.buscaOab.lista.length;
  bt.textContent = marcados
    ? 'Acompanhar '+marcados+' selecionado(s)'
    : (filtrado?'Acompanhar os '+novos+' filtrados':'Acompanhar os '+novos);
}

/* ---------------- detalhe ---------------- */
function abrir(numero){
  if(window.__pvPasta)window.__pvPasta.trocouProcesso(numero);
  estado.detalhe=numero;pintarNav();
  $('conteudo').classList.remove('env-larga');
  var alvo=$('conteudo');
  alvo.innerHTML='<div class="cartao"><span class="gira"></span>Carregando…</div>';

  api('/v1/acompanhamentos/'+encodeURIComponent(numero)).then(function(a){
    if(a.processo){
      alvo.innerHTML='<button class="bt bt3" id="voltar">&larr; voltar</button>'+
        processoHtml(a.processo,a,{acompanhado:true})+'<div id="pecas"></div>';
      ligarBotoesDetalhe(numero,true);
      carregarPecas(numero);
    }else{
      alvo.innerHTML='<button class="bt bt3" id="voltar">&larr; voltar</button>'+
        vazio('⏳','Ainda sem dados deste processo',
          a.erro?('A última tentativa falhou: '+a.erro):'A primeira consulta ainda não completou.',
          '<button class="bt bt2" id="parar">Deixar de acompanhar</button>');
      ligarBotoesDetalhe(numero,true);
    }
    $('voltar').addEventListener('click',function(){estado.detalhe=null;pintarNav();render()});
    api('/v1/novidades/marcar-vistas',{method:'POST',body:{numero:numero}})
      .then(atualizarBolha).catch(function(){});
  }).catch(function(e){
    // Não acompanhado ainda: cai para a consulta avulsa.
    if(e.status===404){
      api('/v1/processos/'+encodeURIComponent(numero)).then(function(p){
        alvo.innerHTML='<button class="bt bt3" id="voltar">&larr; voltar</button>'+
          processoHtml(p,null,{buscaAvulsa:true})+'<div id="pecas"></div>';
        ligarBotoesDetalhe(numero,false);
        carregarPecas(numero);
        $('voltar').addEventListener('click',function(){estado.detalhe=null;pintarNav();render()});
      }).catch(function(e2){alvo.innerHTML=erroBloco(e2)});
      return;
    }
    alvo.innerHTML=erroBloco(e);
  });
}
window.__processovivo_abrir=abrir;
/* O que a Pasta digital (scriptPasta.ts) e o calendário (calendario.ts) usam do console.
   Um objeto pequeno e explícito: eles não leem o estado da tela por dentro. */
window.__pv={api:api,esc:esc,explicar:explicar,dth:dth,erroBloco:erroBloco,vazio:vazio,abrir:abrir,chave:function(){return estado.chave},dt:dt,diaMes:diaMes,humano:humano,mascara:mascara,tamanho:tamanho};

function ligarBotoesDetalhe(numero,acompanhado){
  var b=$('acompanhar');
  if(b)b.addEventListener('click',function(){
    b.disabled=true;b.innerHTML='<span class="gira"></span>Adicionando';
    api('/v1/acompanhamentos',{method:'POST',body:{numero:numero}})
      .then(function(){carregarFacetas();abrir(numero)})
      .catch(function(e){b.disabled=false;b.textContent='Acompanhar';alert(explicar(e))})});
  var p=$('parar');
  if(p)p.addEventListener('click',function(){
    api('/v1/acompanhamentos/'+encodeURIComponent(numero),{method:'DELETE'})
      .then(function(){carregarFacetas();atualizarBolha();ir('processos')})
      .catch(function(e){alert(explicar(e))})});
  void acompanhado;
}

function agrupar(movs){
  var out=[],ult=null;
  movs.forEach(function(m){
    /* Evento que ENTREGA documento nunca se agrupa. "Outros ×4" esconderia
       quatro botões de download diferentes atrás de um contador — que é
       exatamente o problema que a régua veio resolver. */
    var k=(m.pecas&&m.pecas.length)?null:dt(m.data)+'|'+m.titulo;
    if(k&&ult&&ult.k===k){ult.n++;return}
    ult={k:k,mov:m,n:1};out.push(ult)});
  return out;
}

/**
 * A tela de um processo. Ordem (v0.32.1): capa, dados do processo, PEÇAS, o que
 * pede providência (só dentro da janela), último ato, partes, linha do tempo.
 * Desde a v0.10.0 a providência vem antes do último ato e das partes — a
 * pergunta de quem abre é "o que eu preciso fazer?" —, e as peças subiram para
 * logo depois dos dados porque eram o que o advogado procurava rolando a tela.
 */
function processoHtml(p,acomp,op){
  op=op||{};
  var movs=p.movimentacoes||[];
  var relev=movs.filter(function(m){return !INTERNOS[m.codigoTpu]});
  var ultima=relev[0]||movs[0]||null;
  // O campo exigeAcao vem do servidor (domain/entities/triagem.ts). A tela não
  // reclassifica: duas heurísticas para a mesma coisa divergem no dia em que
  // alguém ajusta só uma.
  var janPend=(estado.facetas&&estado.facetas.pendenciaJanelaDias)||0;
  var limPend=janPend>0?Date.now()-janPend*86400000:0;
  var pedem=movs.filter(function(m){return m.exigeAcao});
  var acoes=pedem.filter(function(m){return new Date(m.data).getTime()>=limPend});
  var pendAnteriores=pedem.length-acoes.length;

  var h='<div class="capa"><div class="num">'+esc(p.numero)+'</div>'+
    '<div class="sob">'+esc(p.classe||'Classe não informada')+
    (p.assunto?' · '+esc(p.assunto):'')+'</div><div class="selos">'+
    '<span class="selo">'+esc(p.tribunal||'—')+'</span>'+
    (p.grau?'<span class="selo">'+esc(p.grau)+'</span>':'')+
    (p.segredoJustica?'<span class="selo al">segredo de justiça</span>':'')+
    (op.acompanhado?'<span class="selo nv">acompanhando</span>':'')+
    '</div>';
  h+='<div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">';
  if(op.acompanhado)h+='<button class="bt bt2" id="parar">Deixar de acompanhar</button>';
  else h+='<button class="bt" id="acompanhar">Acompanhar este processo</button>';
  h+='</div></div>';

  // 1. Ficha cadastral — os dados do processo; as peças vêm logo abaixo (v0.32.1).
  h+='<div class="fatos">'+
    '<div class="fato"><div class="k">Vara</div><div class="v">'+esc(p.vara||'—')+'</div></div>'+
    '<div class="fato"><div class="k">Distribuição</div><div class="v">'+dt(p.dataDistribuicao)+'</div></div>'+
    '<div class="fato"><div class="k">Andamentos</div><div class="v">'+movs.length+'</div></div>'+
    // Com a HORA: verificado às 03h e verificado às 14h são coisas diferentes
    // quando se conta prazo.
    (acomp&&acomp.sincronizadoEm?'<div class="fato"><div class="k">Verificado</div><div class="v">'+
      humano(acomp.sincronizadoEm)+'</div><div class="k">'+dth(acomp.sincronizadoEm)+'</div></div>':'')+
    (p.procedencia&&p.procedencia.provider?'<div class="fato"><div class="k">Fontes</div>'+
      '<div class="v">'+esc(p.procedencia.provider)+'</div></div>':'')+
    (p.valorCausa!=null?'<div class="fato"><div class="k">Valor da causa</div><div class="v">'+
      p.valorCausa.toLocaleString('pt-BR',{style:'currency',currency:'BRL'})+'</div></div>':'')+
    '</div>';

  // 2. Resumo das peças — o diferencial do produto. A altura mínima é reservada
  //    de propósito: a consulta ao MNI leva dezenas de segundos, e um bloco que
  //    cresce no meio da página empurra o texto que está sendo lido.
  h+='<div id="pecas-resumo" style="min-height:96px"></div>';

  // 3. O que pede providência, DENTRO da janela (PENDENCIA_JANELA_DIAS, a mesma
  //    do selo da carteira e do card do painel — o servidor entrega o valor).
  //    Ato mais antigo continua marcado na linha do tempo e é contado aqui:
  //    sair do topo não é sumir da tela.
  if(acoes.length){
    h+='<div class="cartao alerta"><h3 class="sec">Pede providência · '+acoes.length+
      (janPend>0?' <span class="nota" style="font-weight:500">(últimos '+janPend+' dias)</span>':'')+'</h3>';
    acoes.forEach(function(m){
      h+='<div class="acao"><div class="dt">'+dt(m.data)+'</div><div>'+
        '<div class="tt">'+esc(m.titulo)+'</div>'+
        (m.conteudo?'<div class="cp">'+esc(recorte(m.conteudo,260))+'</div>':'')+
        '</div></div>';
    });
    if(pendAnteriores>0)h+='<div class="nota">'+pendAnteriores+' ato(s) anterior(es) que pedem '+
      'providência não estão aqui — veja na linha do tempo.</div>';
    h+='<div class="nota">Marcado por leitura automática do texto (prazo, '+
      '"intime-se", "manifeste-se"). <strong>Confira sempre no ato completo</strong> — '+
      'a contagem do prazo é sua.</div></div>';
  }else if(pendAnteriores>0){
    h+='<div class="cartao"><div class="nota">Nenhum ato dos últimos '+janPend+' dias pede providência. '+
      pendAnteriores+' ato(s) anterior(es) que pedem providência — veja na linha do tempo.</div></div>';
  }

  // 4. O último ato, com trecho do teor. Antes esta faixa mostrava só o rótulo
  //    ("Ato ordinatório"), que é categoria e não informação.
  if(ultima){
    h+='<div class="agora"><div class="k">Última movimentação</div>'+
      '<div class="t">'+esc(ultima.titulo)+'</div>'+
      '<div class="d">'+dt(ultima.data)+' · '+humano(ultima.data)+
      (ultima.fonte?' · via '+esc(ultima.fonte):'')+'</div>'+
      (ultima.conteudo?'<div class="cp">'+esc(recorte(ultima.conteudo,320))+'</div>':'')+
      (ultima.teorIndisponivel?'<div class="nota">O diário não publica o texto deste '+
        'documento'+(ultima.url?' — <a href="'+esc(ultima.url)+'" target="_blank" '+
        'rel="noopener noreferrer">abrir no tribunal</a>':'')+'.</div>':'')+
      '</div>';
  }

  // 5. Partes: quem está do outro lado importa mais que a data de distribuição.
  h+='<div class="cartao"><h3 class="sec">Partes</h3>';
  if(p.partes&&p.partes.length){
    p.partes.forEach(function(pt){
      h+='<div class="parte"><span class="selo">'+esc(pt.polo)+'</span> <strong>'+esc(pt.nome)+'</strong>';
      if(pt.advogados&&pt.advogados.length)
        h+='<div class="nota">'+pt.advogados.map(function(a){
          return esc(a.nome)+(a.oab?' — OAB '+esc(a.oab)+'/'+esc(a.ufOab||''):'')}).join(' · ')+'</div>';
      h+='</div>'});
  }else{
    h+='<div style="color:var(--tinta2)">Nenhuma parte informada. O DataJud publica só '+
      'metadados, e o DJEN só conhece quem foi intimado em alguma publicação — um '+
      'processo sem publicação recente no diário aparece sem partes.</div>';
  }
  h+='</div>';

  // 5. A régua temporal.
  /* A régua só substitui a linha do tempo quando a espinha é a DO TRIBUNAL.
     Degradada — MNI sem movimentos, ou chave que não bateu em peça nenhuma —
     ela não acrescenta nada que a página já não tenha, e trocar uma pela outra
     arriscaria apagar andamentos se a consulta às fontes públicas tivesse
     falhado do lado do servidor. Entre exibir a régua e não perder andamento,
     não perder andamento. */
  var r=(regua.dados&&soDigitos(regua.numero)===soDigitos(p.numero)&&
    regua.dados.resumo&&regua.dados.resumo.espinha==='tribunal')?regua.dados:null;
  var eventos=r?r.eventos:movs;

  var ver=false; try{ver=localStorage.getItem(VER)==='1'}catch(e){}
  var filtro='tudo'; try{filtro=localStorage.getItem(FILTRO_MOV)||'tudo'}catch(e){}
  var principais=false; try{principais=localStorage.getItem(SO_PRINCIPAIS)==='1'}catch(e){}

  var base=ver?eventos:eventos.filter(function(m){return !INTERNOS[m.codigoTpu]});
  var escond=eventos.length-base.length;

  /* O filtro de ruído decide pelo POSITIVO: some só o que o servidor
     IDENTIFICOU como cartório (ver domain/entities/triagem.ts). Filtrar por
     "não exige ação" esconderia também o que a heurística não soube
     classificar — que é justamente onde ela erra, e onde se perde prazo. */
  var escondRuido=0;
  if(principais&&r){
    var antesDoRuido=base.length;
    base=base.filter(function(m){return !m.ehRuido});
    escondRuido=antesDoRuido-base.length;
  }

  var vis=base;
  if(filtro==='acao')vis=base.filter(function(m){return m.exigeAcao});
  else if(filtro==='docs')vis=base.filter(function(m){return m.pecas&&m.pecas.length});
  else if(filtro==='teor')vis=base.filter(function(m){return m.conteudo});
  var grupos=agrupar(vis);

  h+='<div class="cartao"><div class="titulo-secao" style="margin-bottom:6px">'+
    '<h3 class="sec" style="margin:0">'+(r?'Linha do tempo':'Andamentos')+' · '+
      grupos.length+' de '+eventos.length+'</h3>'+
    ((escond>0||ver)?'<button class="bt bt2" id="alternar">'+
      (ver?'Recolher internos':'Mostrar '+escond+' interno(s)')+'</button>':'')+'</div>';

  /* O botão de ruído só aparece com a régua carregada: sem ela o servidor não
     mandou a marcação, e um botão que não filtra nada é pior que botão nenhum. */
  if(r){
    h+='<div style="margin:0 0 10px"><button class="bt bt2" id="so-principais">'+
      (principais?'Ver histórico completo':'Apenas andamentos principais')+'</button>'+
      (principais&&escondRuido>0?'<span class="nota" style="margin-left:10px">'+
        escondRuido+' registro(s) de cartório fora da tela</span>':'')+'</div>';
  }

  h+='<div class="chips">'+
    chip('tudo','Tudo',filtro)+
    chip('acao','Pede providência',filtro)+
    (r?chip('docs','Com documento',filtro):'')+
    chip('teor','Com inteiro teor',filtro)+
    '</div>';

  if(escond>0&&!ver)h+='<div class="nota" style="margin:0 0 10px">Recolhidos: confirmações, '+
    'expedições e juntadas de documento — registros de cartório que não mudam o estado do '+
    'processo. Nada foi descartado.</div>';

  if(!grupos.length)h+='<div class="nota">Nenhum andamento neste filtro.</div>';

  var anoAtual=null;
  grupos.forEach(function(g,idx){
    var a=anoDe(g.mov.data);
    if(a!==anoAtual){anoAtual=a;h+='<div class="ano">'+a+'</div>'}
    var m=g.mov, longo=m.conteudo&&m.conteudo.length>320;
    var decisao=m.ehDecisao||MARCOS[m.codigoTpu];
    h+='<div class="ev'+(decisao?' decisao':'')+(m.exigeAcao?' pede':'')+'" data-quando="'+esc(m.data)+'">'+
      '<div class="dt">'+dt(m.data)+'</div><div>'+
      '<div class="tt">'+esc(m.titulo)+(g.n>1?' <span class="xn">×'+g.n+'</span>':'')+
      (decisao?' <span class="selo mc">decisão</span>':'')+
      (m.exigeAcao?' <span class="selo al">providência</span>':'')+'</div>'+
      (m.complementos&&m.complementos.length?'<div class="cp">'+esc(m.complementos.join(' · '))+'</div>':'')+
      (m.conteudo?'<div class="cp" id="tx'+idx+'">'+esc(longo?recorte(m.conteudo,320):m.conteudo)+'</div>'+
        (longo?'<button class="link" data-ler="'+idx+'">ler o ato inteiro</button>':''):'')+
      (m.teorIndisponivel?'<div class="nota">Documento não público no diário'+
        (m.url?' — <a href="'+esc(m.url)+'" target="_blank" rel="noopener noreferrer">abrir no tribunal</a>':'')+
        '</div>':'')+
      documentosDoEvento(m.pecas)+
      '</div></div>';
  });
  h+='</div>';

  // Guardado fora do HTML para o botão "ler o ato inteiro" não precisar
  // reescrever a página inteira nem embutir 20 mil caracteres num atributo.
  janelaTextos=grupos.map(function(g){return g.mov.conteudo||''});

  setTimeout(function(){
    var b=$('alternar');
    if(b)b.addEventListener('click',function(){
      try{localStorage.setItem(VER,ver?'0':'1')}catch(e){}
      redesenharDetalhe();
    });
    var sp=$('so-principais');
    if(sp)sp.addEventListener('click',function(){
      try{localStorage.setItem(SO_PRINCIPAIS,principais?'0':'1')}catch(e){}
      redesenharDetalhe();
    });
    // Os botões de download agora vivem DENTRO da linha do tempo, então quem
    // os liga é quem desenha a linha do tempo.
    ligarDownloadDePecas(p.numero);
    document.querySelectorAll('[data-chip]').forEach(function(el){
      el.addEventListener('click',function(){
        try{localStorage.setItem(FILTRO_MOV,el.getAttribute('data-chip'))}catch(e){}
        redesenharDetalhe();
      })});
    document.querySelectorAll('[data-ler]').forEach(function(el){
      el.addEventListener('click',function(){
        var i=Number(el.getAttribute('data-ler'));
        var alvo=$('tx'+i);
        if(alvo){alvo.textContent=janelaTextos[i]||'';el.remove()}
      })});
  },0);
  return h;
}

/* ---------------- aba: meus acessos (credenciais de tribunal) ---------------- */
/*
 * A tela que faltava para a v0.12.0 fazer sentido para quem usa: as peças do
 * processo só saem para quem está habilitado nos autos, e quem prova isso é a
 * credencial do próprio advogado no sistema do tribunal.
 *
 * A senha SAI daqui e nunca volta: o servidor a guarda cifrada e não a devolve
 * em nenhuma resposta. Por isso o campo aparece sempre vazio, mesmo com acesso
 * já cadastrado — não é defeito, é o desenho.
 */
function verCredenciais(){
  var alvo=$('conteudo');
  alvo.innerHTML='<div class="cartao"><span class="gira"></span>Carregando…</div>';

  api('/v1/credenciais').then(function(r){
    var lista=r.credenciais||[];
    var h='<div class="titulo-secao"><div><h2>Meus acessos</h2>'+
      '<div class="sub">O acesso do advogado no tribunal, usado para buscar as peças do processo</div></div></div>';

    if(lista.length){
      h+='<div class="cartao"><h3 class="sec">Cadastrados · '+lista.length+'</h3>';
      lista.forEach(function(c){
        var estadoTxt, estadoCls;
        if(c.recusadaEm){estadoTxt='recusado pelo tribunal em '+dt(c.recusadaEm);estadoCls='al'}
        else if(c.usadaEm){estadoTxt='usado com sucesso '+humano(c.usadaEm);estadoCls='nv'}
        else{estadoTxt='ainda não usado';estadoCls=''}
        h+='<div class="acao"><div class="dt">'+esc(c.tribunal)+'</div><div>'+
          '<div class="tt">'+esc(c.identificacao)+
          ' <span class="selo'+(estadoCls?' '+estadoCls:'')+'">'+esc(estadoTxt)+'</span></div>'+
          (c.recusadaEm?'<div class="cp">A senha provavelmente mudou no tribunal. '+
            'Cadastre de novo abaixo — enquanto isso, as peças deste tribunal não são buscadas.</div>':'')+
          '<button class="link" data-remover="'+esc(c.tribunal)+'">remover este acesso</button>'+
          '</div></div>';
      });
      h+='</div>';
    }else{
      h+=vazio('🔑','Nenhum acesso cadastrado',
        'Sem o acesso do advogado, o sistema mostra decisões e julgados — que é o que o diário publica — mas não as petições e documentos juntados pelas partes.');
    }

    h+='<div class="cartao"><h3 class="sec">'+(lista.length?'Cadastrar outro':'Cadastrar acesso')+'</h3>'+
      '<label class="rotulo" for="c-trib">Tribunal</label>'+
      '<input id="c-trib" value="TJGO" autocomplete="off">'+
      '<div class="nota">Hoje só o TJGO tem fonte de peças configurada.</div>'+
      '<label class="rotulo" for="c-id">CPF do advogado</label>'+
      '<input id="c-id" placeholder="somente números" autocomplete="off" inputmode="numeric">'+
      '<label class="rotulo" for="c-senha">Senha do Projudi</label>'+
      '<input id="c-senha" type="password" placeholder="a mesma senha do sistema do tribunal" autocomplete="new-password">'+
      '<div class="nota">Guardada cifrada no servidor e nunca devolvida em nenhuma tela. '+
      'É usada só para consultar os processos em que este advogado está habilitado.</div>'+
      '<div style="margin-top:12px"><button class="bt" id="c-salvar">Salvar acesso</button></div>'+
      '<div id="c-msg"></div></div>';

    alvo.innerHTML=h;
    ligarCredenciais();
  }).catch(function(e){
    // 501 significa servidor sem cofre configurado — a instrução vem do próprio
    // erro, e é para quem opera, não para o advogado.
    alvo.innerHTML='<div class="titulo-secao"><div><h2>Meus acessos</h2></div></div>'+erroBloco(e);
  });
}

function ligarCredenciais(){
  document.querySelectorAll('[data-remover]').forEach(function(el){
    el.addEventListener('click',function(){
      var t=el.getAttribute('data-remover');
      api('/v1/credenciais/'+encodeURIComponent(t),{method:'DELETE'})
        .then(verCredenciais).catch(function(e){alert(explicar(e))});
    })});

  var b=$('c-salvar');
  if(!b)return;
  b.addEventListener('click',function(){
    var trib=($('c-trib').value||'').trim().toUpperCase();
    var id=($('c-id').value||'').replace(/\D/g,'');
    var senha=$('c-senha').value||'';
    var msg=$('c-msg');
    if(!trib||!id||!senha){
      msg.innerHTML='<div class="nota" style="color:var(--erro)">Preencha tribunal, CPF e senha.</div>';
      return;
    }
    b.disabled=true;b.innerHTML='<span class="gira"></span>Salvando';
    api('/v1/credenciais',{method:'PUT',body:{tribunal:trib,identificacao:id,senha:senha}})
      .then(function(){
        // Limpa a senha da tela assim que ela sai daqui.
        $('c-senha').value='';
        verCredenciais();
      })
      .catch(function(e){
        b.disabled=false;b.textContent='Salvar acesso';
        msg.innerHTML='<div class="nota" style="color:var(--erro)">'+esc(explicar(e))+'</div>';
      });
  });
}

/* ---------------- peças do processo ---------------- */
/*
 * Carregado DEPOIS do processo, e não junto: a consulta ao MNI passa por
 * autenticação no tribunal e pode levar dezenas de segundos. Amarrar as duas
 * faria a tela inteira esperar pela mais lenta — e o advogado ficaria sem ver
 * as movimentações, que já estavam prontas.
 */
/**
 * Na busca avulsa, as peças são OFERECIDAS — não carregadas sozinhas.
 *
 * Carregar direto pareceria melhor e não é: cada consulta ao MNI leva dezenas
 * de segundos, autentica no tribunal e carrega a linha do tempo inteira como
 * pedágio. Quem digita cinco números seguidos para conferir alguma coisa
 * dispararia cinco dessas — contra o tribunal, sem ter pedido peça nenhuma.
 *
 * O botão também preenche o espaço que o resumo reserva. Sem ele a tela fica
 * com um vão em branco onde o bloco apareceria: foi o que esta função veio
 * consertar.
 */
function oferecerPecas(numero){
  var caixa=$('pecas-resumo'); if(!caixa)return;
  caixa.innerHTML='<div class="cartao"><div class="titulo-secao" style="margin-bottom:0">'+
    '<div><h3 class="sec" style="margin:0">Peças do processo</h3>'+
    '<div class="sub">Petição, contestação, laudo e documentos juntados pelas '+
    'partes — o que o diário nunca publica.</div></div>'+
    '<button class="bt bt2" id="bt-ver-pecas">Buscar peças</button></div></div>';
  var b=$('bt-ver-pecas');
  if(b)b.addEventListener('click',function(){carregarPecas(numero)});
}

function carregarPecas(numero,forcar){
  var resumo=$('pecas-resumo'), caixa=$('pecas');
  if(!caixa)return;

  /* Cache antes de tudo.
     Cada clique num chip da linha do tempo redesenha o detalhe, e o redesenho
     passa por aqui. Sem o cache, filtrar a tela dispararia outra consulta ao
     MNI: dezenas de segundos e mais uma oportunidade de recusa contra a conta
     do advogado no tribunal. */
  if(!forcar&&regua.dados&&soDigitos(regua.numero)===soDigitos(numero)){
    desenharPecas(numero,regua.dados);
    return;
  }

  var carregando='<div class="cartao"><h3 class="sec">Peças do processo</h3>'+
    '<div class="nota"><span class="gira"></span>Consultando o tribunal…</div></div>';
  if(resumo)resumo.innerHTML=carregando;
  caixa.innerHTML='';

  api('/v1/processos/'+encodeURIComponent(numero)+'/pecas').then(function(r){
    var linha=r.linhaDoTempo||null;
    regua={numero:numero,dados:linha,baixadas:r.jaBaixadas||[]};

    /* Com a espinha do tribunal, a página inteira muda de forma: cada evento
       passa a entregar o documento dele. Redesenhar é o caminho — e o
       redesenho volta aqui pelo cache, sem tocar no tribunal de novo. */
    if(linha&&linha.resumo&&linha.resumo.espinha==='tribunal'){
      redesenharDetalhe();
      return;
    }
    desenharPecas(numero,linha);
  }).catch(function(e){
    regua={numero:'',dados:null,baixadas:[]};
    erroDePecas(resumo||caixa,e);
  });
}

/**
 * Desenha o cartão do topo e o que sobrou para o rodapé.
 *
 * O rodapé encolhe até sumir conforme a junção peça↔andamento funciona: ele
 * guarda só o que não pôde ser pendurado em evento nenhum. Sumir com essas
 * peças seria pior que o desenho antigo — elas existem nos autos.
 */
function desenharPecas(numero,linha){
  var resumo=$('pecas-resumo'), caixa=$('pecas');
  if(!caixa)return;
  caixa.innerHTML='';

  var res=(linha&&linha.resumo)||{};
  var soltas=(linha&&linha.pecasSoltas)||[];
  var naRegua=res.pecasAcopladas||0;
  var total=naRegua+soltas.length;

  if(!total){
    var nada='<div class="cartao"><h3 class="sec">Peças do processo</h3>'+
      '<div class="nota">O tribunal respondeu e não há nenhuma peça juntada '+
      'neste processo até agora.</div></div>';
    if(resumo)resumo.innerHTML=nada;
    return;
  }

  if(resumo){
    var rh='<div class="cartao"><div class="titulo-secao" style="margin-bottom:6px">'+
      '<h3 class="sec" style="margin:0">Peças do processo · '+total+'</h3>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap">'+
      /* A Pasta digital abre por botão, e só por ele: sem clicar aqui, a tela
         do processo é exatamente a de antes. */
      '<button class="bt bt2" id="pasta-abrir">Pasta digital</button>'+
      '<button class="bt bt2" id="pecas-atualizar">Atualizar</button></div></div>';
    if(naRegua){
      rh+='<div class="nota">'+naRegua+' de '+total+' estão na linha do tempo, '+
        'no evento que as juntou — o botão de baixar fica na própria linha.'+
        (res.decisoes?' '+res.decisoes+' decisão(ões) em destaque.':'')+'</div>';
    }
    if(soltas.length){
      rh+='<div class="nota">'+soltas.length+' não puderam ser ligadas a um '+
        'andamento e ficaram na lista ao fim da página.</div>';
    }
    rh+='</div>';
    resumo.innerHTML=rh;
    var at=$('pecas-atualizar');
    if(at)at.addEventListener('click',function(){carregarPecas(numero,true)});
  }

  if(soltas.length)caixa.innerHTML=listaDePecasHtml(soltas,naRegua?'Peças sem andamento':'Todas as peças');
  ligarDownloadDePecas(numero);
  if(window.__pvPasta)window.__pvPasta.aposDesenhar(numero);
}

/* A lista agrupada por origem — o que era a tela inteira das peças e hoje é só
   o resto. A pergunta que traz o advogado às peças quase sempre é "o que a
   outra parte alegou", então esse grupo vem primeiro. DESCONHECIDA continua
   visível: sumir com peça porque a heurística de origem não decidiu é
   exatamente como se perde prazo. */
function listaDePecasHtml(pecas,titulo){
  var lista=pecas.slice();
  lista.sort(function(a,b){
    var x=a.dataHora?Date.parse(a.dataHora):NaN, y=b.dataHora?Date.parse(b.dataHora):NaN;
    if(isNaN(x)&&isNaN(y))return 0;
    if(isNaN(x))return 1;
    if(isNaN(y))return -1;
    return y-x;
  });
  var grupos=[
    {chave:'PARTE',titulo:'Juntadas pelas partes'},
    {chave:'JUIZO',titulo:'Do juízo'},
    {chave:'DESCONHECIDA',titulo:'Origem não identificada'}
  ];
  var h='<div class="cartao"><h3 class="sec">'+esc(titulo)+' · '+lista.length+'</h3>';
  grupos.forEach(function(g){
    var doGrupo=lista.filter(function(p){return (p.origem||'DESCONHECIDA')===g.chave});
    if(!doGrupo.length)return;
    h+='<div class="ano">'+g.titulo+' · '+doGrupo.length+'</div>';
    /* Diz quantas foram DEDUZIDAS. O tribunal não rotula anexo, e o sistema
       conclui a origem pelo ato que juntou o documento. Concluir é legítimo;
       apresentar conclusão como se fosse o que a fonte afirmou, não. */
    var deduzidas=doGrupo.filter(function(p){return p.origemDeduzida}).length;
    if(deduzidas){
      h+='<div class="nota">'+deduzidas+' destas o tribunal não rotulou — a '+
        'origem foi deduzida do ato que as juntou.</div>';
    }
    doGrupo.forEach(function(p){h+=linhaDePeca(p)});
  });
  return h+'</div>';
}

/**
 * O erro das peças traduzido para a ação que resolve.
 *
 * Cada ramo existe porque a mensagem genérica mandaria a pessoa ao lugar
 * errado: negativa de acesso vira "confira de quem é a credencial", falta de
 * credencial vira "cadastre", plano vira a mensagem do plano, e configuração
 * ausente é problema nosso, não dela.
 */
function erroDePecas(alvo,e){
  /* Negativa de acesso NÃO é "processo sem peças".

     O tribunal responde sucesso com o cabeçalho e sem a linha do tempo quando
     o acesso cadastrado não consta nos autos. Dizer "nenhuma peça" aqui faria
     o advogado concluir que o processo está vazio. */
  if(e.codigo==='SEM_HABILITACAO_NOS_AUTOS'){
    alvo.innerHTML='<div class="cartao"><h3 class="sec">Peças do processo</h3>'+
      '<div class="nota">'+esc(e.message)+'</div>'+
      '<div style="margin-top:12px"><button class="bt bt2" id="ir-cred">Conferir meus acessos</button></div></div>';
    var b0=$('ir-cred');
    if(b0)b0.addEventListener('click',function(){ir('credenciais')});
    return;
  }

  if(e.status===428){
    alvo.innerHTML='<div class="cartao"><h3 class="sec">Peças do processo</h3>'+
      '<div class="nota">Petições, contestações e documentos juntados pelas partes não são '+
      'publicados no diário — só saem do sistema do tribunal, para quem está habilitado nos autos.</div>'+
      '<div style="margin-top:12px"><button class="bt" id="ir-cred">Cadastrar o acesso do advogado</button></div></div>';
    var b=$('ir-cred');
    if(b)b.addEventListener('click',function(){ir('credenciais')});
    return;
  }

  if(e.status===403){
    alvo.innerHTML='<div class="cartao"><h3 class="sec">Peças do processo</h3>'+
      '<div class="nota">'+esc(e.message)+'</div></div>';
    return;
  }

  if(e.status===501){
    alvo.innerHTML='<div class="cartao"><h3 class="sec">Peças do processo</h3>'+
      '<div class="nota">O acesso a peças não está configurado neste servidor.</div></div>';
    return;
  }

  alvo.innerHTML='<div class="cartao"><h3 class="sec">Peças do processo</h3>'+
    '<div class="nota" style="color:var(--erro)">'+esc(explicar(e))+'</div></div>';
}

/**
 * Os documentos que ESTE ato juntou, na linha dele.
 *
 * É o ajuste que o advogado pediu como mais urgente, e a razão é de rotina:
 * ler "14/09 · Petição da parte", memorizar a data e rolar até o rodapé para
 * caçar o arquivo no meio de 278 peças não acontece na correria do escritório.
 *
 * O rótulo do botão é texto puro de propósito: ligarDownloadDePecas troca o
 * texto por "baixando…" e o repõe depois, e qualquer marcação aqui dentro
 * seria perdida na reposição. Origem e sigilo viram CLASSE, não elemento.
 */
function jaFoiBaixada(id){
  var l=regua.baixadas||[];
  for(var i=0;i<l.length;i++){if(l[i]===id)return true}
  return false;
}

function documentosDoEvento(pecas){
  if(!pecas||!pecas.length)return '';
  var h='<div class="docs">';
  pecas.forEach(function(p){
    /* "já baixado" não é enfeite: baixar de novo custa outra consulta ao
       tribunal de dezenas de segundos e mais uma requisição carregando a senha
       do advogado. Quem não lembra se já puxou a contestação clica de novo — e
       paga tudo outra vez. O botão continua clicável de propósito: pode ser que
       a pessoa tenha perdido o arquivo. */
    var ja=jaFoiBaixada(p.id);
    var cls='doc'+(p.origem==='PARTE'?' parte':'')+(p.sigilosa?' sigilosa':'')+
      (ja?' ja':'');
    h+='<button class="'+cls+'" data-peca="'+esc(p.id)+'"'+
      (ja?' title="você já baixou esta peça"':'')+'>'+
      (ja?'✓ ':'')+esc(formatoDaPeca(p.mimetype))+' · '+esc(recorte(p.rotulo,44))+
      '</button>';
  });
  return h+'</div>';
}

/** Uma linha de peça. Mesma forma no resumo e na lista completa. */
function linhaDePeca(p){
  var origem = p.origem==='PARTE' ? '<span class="selo nv">da parte</span>'
             : p.origem==='JUIZO' ? '<span class="selo">do juízo</span>' : '';
  return '<div class="ev"><div class="dt">'+dt(p.dataHora)+'</div><div>'+
    '<div class="tt">'+esc(p.rotulo)+' '+origem+
    (p.sigilosa?' <span class="selo al">sigilosa</span>':'')+'</div>'+
    (p.descricao&&p.descricao!==p.rotulo?'<div class="cp">'+esc(p.descricao)+'</div>':'')+
    (p.signatarios&&p.signatarios.length?'<div class="cp">assinada por '+
      esc(p.signatarios.join(', '))+'</div>':'')+
    /* Botão SEMPRE, e não só quando conteudoDisponivel. A listagem do MNI
       nunca traz o teor, então aquela condição escondia o download de todas as
       peças, inclusive as que baixam sem problema. Se o tribunal recusar, quem
       avisa é o 403 — com o motivo certo, embaixo do próprio botão. */
    '<button class="link" data-peca="'+esc(p.id)+'">baixar '+
      esc(formatoDaPeca(p.mimetype))+'</button>'+
    '</div></div>';
}

/**
 * O formato em uma palavra que o advogado reconhece.
 *
 * Antes saía o mimetype cru com "application/" removido, e nos documentos do
 * juízo — que o TJGO manda como HTML — o botão dizia "baixar text/html". Tirar
 * só o prefixo resolvia metade dos casos e deixava a outra metade falando
 * jargão na cara de quem não é da área.
 */
function formatoDaPeca(mime){
  var m=String(mime||'').toLowerCase();
  if(m.indexOf('pdf')>=0)return 'PDF';
  if(m.indexOf('html')>=0)return 'HTML';
  if(m.indexOf('image/')===0)return 'imagem';
  if(m.indexOf('word')>=0||m.indexOf('msword')>=0||m.indexOf('officedocument')>=0)return 'documento';
  if(m.indexOf('text/')===0)return 'texto';
  return 'arquivo';
}

/*
 * O download passa por fetch, e não por um link direto, porque a rota exige o
 * header x-api-key — que um <a href> não tem como mandar.
 */
function ligarDownloadDePecas(numero){
  document.querySelectorAll('[data-peca]').forEach(function(el){
    /* Os botões passaram a existir em dois lugares (na régua e no rodapé das
       peças soltas), e as duas funções que desenham chamam esta. Sem a marca,
       o segundo registro duplicaria o clique — dois downloads e duas trocas de
       rótulo disputando o mesmo botão. */
    if(el.getAttribute('data-ligado'))return;
    el.setAttribute('data-ligado','1');
    el.addEventListener('click',function(){
      var id=el.getAttribute('data-peca');
      var rotulo=el.textContent;
      el.textContent='baixando…';
      fetch('/v1/processos/'+encodeURIComponent(numero)+'/pecas/'+encodeURIComponent(id),
        {headers:{'x-api-key':estado.chave}})
        .then(function(r){
          if(!r.ok){var e=new Error('HTTP '+r.status);e.status=r.status;throw e}
          var nome=(r.headers.get('content-disposition')||'').match(/filename="([^"]+)"/);
          return r.blob().then(function(b){return{blob:b,nome:nome?nome[1]:('peca-'+id)}});
        })
        .then(function(x){
          var u=URL.createObjectURL(x.blob);
          var a=document.createElement('a');
          a.href=u;a.download=x.nome;document.body.appendChild(a);a.click();
          document.body.removeChild(a);URL.revokeObjectURL(u);
          el.textContent=rotulo;
        })
        .catch(function(e){
          // 403 não é falha de download, é o controle de acesso dos autos
          // funcionando. Dizer "falhou, tente de novo" faria o advogado clicar
          // dez vezes numa peça que ele não tem direito de ver.
          if(e&&e.status===403){
            el.textContent='—';
            el.insertAdjacentHTML('afterend',
              '<div class="nota">o tribunal não liberou esta peça para o acesso '+
              'cadastrado — em geral falta procuração nos autos</div>');
            return;
          }
          if(e&&e.status===424){
            el.textContent='—';
            el.insertAdjacentHTML('afterend',
              '<div class="nota" style="color:var(--erro)">o tribunal recusou o acesso '+
              'cadastrado; atualize a senha em "Meus acessos"</div>');
            return;
          }
          el.textContent='falhou — tentar de novo';
        });
    })});
}

/* ---------------- chave / arranque ---------------- */
/* ---------------- entrar, criar conta, perfil ----------------
 *
 * O cadastro é PROGRESSIVO, e essa é a decisão de produto que molda estas
 * telas: nome, e-mail e senha bastam para entrar e já consultar processo.
 * A OAB entra depois, quando ela destrava a vigilância; a senha do tribunal
 * só quando a pessoa quer as peças.
 *
 * Pedir OAB e senha do Projudi na primeira tela custaria a maior parte dos
 * cadastros — é muita confiança para quem ainda não viu o sistema funcionar.
 */
/**
 * A casca das telas de quem ainda não entrou: a marca à esquerda, o
 * formulário à direita (empilhados no celular).
 *
 * As frases do lado da marca só prometem o que o sistema faz hoje. "Silêncio
 * nunca quer dizer sem novidade por engano" é o aviso de silêncio do
 * ServicoNotificacao — é a promessa que diferencia o produto, e ela é
 * verdadeira.
 *
 * O logo vem da lateral, que já está na página (escondida): uma cópia só do
 * SVG em vez de duas.
 */
function molduraDeEntrada(formulario){
  document.body.classList.add('fora');
  $('lateral').classList.add('oculto');
  var logo=$('marca')?$('marca').innerHTML:'';
  var beneficio=function(forte,resto){
    return '<div class="beneficio"><span class="ck">'+ICONE_CHECK+'</span>'+
      '<span><b>'+forte+'</b>'+resto+'</span></div>';
  };
  $('conteudo').innerHTML='<div class="entrada">'+
    '<section class="entrada-marca">'+logo+
      '<div><h1>Seus processos vigiados.<br>Você, avisado.</h1>'+
      '<p class="lead">O Processo Vivo confere o tribunal e o Diário de Justiça por você, '+
      'e avisa quando algo muda no que é seu.</p>'+
      '<div class="beneficios">'+
        beneficio('Publicações no seu nome',', encontradas pela sua OAB no Diário de Justiça')+
        beneficio('Andamentos de cada processo',', sem abrir o site do tribunal')+
        beneficio('Peças das partes',', como petição, contestação e laudo, com o seu acesso ao tribunal')+
      '</div></div>'+
      '<div class="promessa"><span class="ponto-vivo"></span><span>Se não conseguirmos '+
      'verificar, você também fica sabendo. Silêncio nunca quer dizer "sem novidade" por engano.</span></div>'+
    '</section>'+
    '<section class="entrada-form"><div class="entrada-caixa">'+formulario+'</div></section>'+
  '</div>';
}

function telaEntrada(modo){
  if(modo)estado.modoEntrada=modo;
  var criar=estado.modoEntrada==='criar';
  molduraDeEntrada(
    '<h2>'+(criar?'Criar conta':'Entrar')+'</h2>'+
    '<div class="sub">'+(criar?'Leva um minuto. A primeira coisa depois é informar a sua OAB.'
      :'Bom ver você de novo.')+'</div>'+
    '<div class="segmentos" role="tablist">'+
      '<button type="button" role="tab" aria-selected="'+(!criar)+'" class="'+(criar?'':'on')+'" data-modo="entrar">Entrar</button>'+
      '<button type="button" role="tab" aria-selected="'+criar+'" class="'+(criar?'on':'')+'" data-modo="criar">Criar conta</button>'+
    '</div>'+
    (criar?'<label class="rotulo" for="c-nome">Seu nome</label>'+
      '<input id="c-nome" placeholder="Maria Silva" autocomplete="name">':'')+
    '<label class="rotulo" for="c-email">E-mail</label>'+
    '<input id="c-email" type="email" placeholder="voce@escritorio.com.br" autocomplete="username">'+
    '<label class="rotulo" for="c-senha">Senha</label>'+
    '<input id="c-senha" type="password" autocomplete="'+(criar?'new-password':'current-password')+'">'+
    (criar?'<div class="nota">Pelo menos 10 caracteres. Uma frase que só você '+
      'lembra protege mais do que trocar letra por símbolo.</div>':'')+
    '<div id="c-erro"></div>'+
    '<button class="bt" id="c-enviar">'+(criar?'Criar conta e entrar':'Entrar')+'</button>'+
    (criar?'':'<div id="c-esqueci" class="nota" style="margin-top:14px;text-align:center"></div>')+
    '<div class="rodape">Vai conectar uma integração, como n8n ou script? '+
    '<button class="link" id="c-chave">Entrar com chave de API</button></div>');

  document.querySelectorAll('[data-modo]').forEach(function(b){
    b.addEventListener('click',function(){telaEntrada(b.getAttribute('data-modo'))})});
  $('c-chave').addEventListener('click',telaChave);

  var enviar=function(){
    var email=$('c-email').value.trim(), senha=$('c-senha').value;
    if(!email||!senha)return;
    var botao=$('c-enviar'); botao.disabled=true;
    $('c-erro').innerHTML='';
    var corpo=criar?{nome:($('c-nome').value.trim()||email.split('@')[0]),email:email,senha:senha}
                   :{email:email,senha:senha};
    api(criar?'/v1/contas':'/v1/sessoes',{method:'POST',body:corpo})
      .then(function(){
        /* Sessão nova: qualquer chave guardada neste navegador para de valer,
           senão o servidor receberia as duas e a pessoa veria a carteira
           errada conforme a aba. */
        estado.chave=''; try{localStorage.removeItem(CH)}catch(e){}
        return carregarEu();
      })
      .then(function(){estado.aba='novidades';iniciar()})
      .catch(function(e){
        botao.disabled=false;
        $('c-erro').innerHTML='<div class="nota" style="color:var(--erro);margin-top:10px">'+
          esc(e.message||explicar(e))+'</div>';
      });
  };
  $('c-enviar').addEventListener('click',enviar);
  ['c-email','c-senha'].forEach(function(id){
    $(id).addEventListener('keydown',function(e){if(e.key==='Enter')enviar()})});
  if(!criar)desenharEsqueci();
}

/* Pergunta ao servidor se ele consegue mandar e-mail, e só então desenha o
   link. A resposta é sobre a INSTALAÇÃO, não sobre nenhuma conta — nenhum
   e-mail é enviado nesta chamada, então não há o que um curioso descubra. */
function desenharEsqueci(){
  var pintar=function(){
    var alvo=$('c-esqueci');
    if(!alvo||estado.recuperacaoDisponivel!==true)return;
    alvo.innerHTML='Esqueceu a senha? '+
      '<button class="link" id="c-recuperar">receber um link por e-mail</button>';
    $('c-recuperar').addEventListener('click',function(){telaRecuperar()});
  };
  if(estado.recuperacaoDisponivel!==null){pintar();return}
  api('/v1/senha/recuperar').then(function(r){
    estado.recuperacaoDisponivel=r.disponivel===true;pintar();
  }).catch(function(){estado.recuperacaoDisponivel=false});
}

/* Pedir o link.
 *
 * A confirmação é a MESMA para e-mail cadastrado e não cadastrado, e é o
 * próprio servidor que devolve o texto. Uma tela que dissesse "não encontramos
 * esta conta" seria um verificador de quem é assinante do Processo Vivo aberto na
 * internet, e sem nem precisar de senha para consultar. */
function telaRecuperar(){
  molduraDeEntrada(
    '<h2>Recuperar acesso</h2><div class="sub">'+
    'Enviamos um link para você escolher uma senha nova.</div>'+
    '<label class="rotulo" for="r-email">E-mail da conta</label>'+
    '<input id="r-email" type="email" placeholder="voce@escritorio.com.br" autocomplete="username">'+
    '<div id="r-aviso"></div>'+
    '<button class="bt" id="r-enviar">Enviar link</button>'+
    '<div class="rodape"><button class="link" id="r-voltar">Voltar para a entrada</button></div>');

  var enviar=function(){
    var email=$('r-email').value.trim();
    if(!email)return;
    var botao=$('r-enviar'); botao.disabled=true;
    api('/v1/senha/recuperar',{method:'POST',body:{email:email}})
      .then(function(r){
        molduraDeEntrada(
          '<h2>Confira seu e-mail</h2>'+
          '<p class="sub">'+esc(r.mensagem)+'</p>'+
          '<div class="nota">O link vale uma hora e serve uma vez só. '+
          'Se não chegar em alguns minutos, tente de novo.</div>'+
          '<button class="bt" id="r-ok">Voltar ao início</button>');
        $('r-ok').addEventListener('click',function(){telaEntrada('entrar')});
      })
      .catch(function(e){
        botao.disabled=false;
        $('r-aviso').innerHTML='<div class="nota" style="color:var(--erro);margin-top:10px">'+
          esc(e.message||explicar(e))+'</div>';
      });
  };
  $('r-enviar').addEventListener('click',enviar);
  $('r-voltar').addEventListener('click',function(){telaEntrada('entrar')});
  $('r-email').addEventListener('keydown',function(e){if(e.key==='Enter')enviar()});
}

/* Escolher a senha nova, vindo do link do e-mail.
 *
 * O token chega por "?recuperar=" e é APAGADO da barra de endereço antes de
 * qualquer coisa (ver o arranque, no fim do arquivo): na URL ele iria parar no
 * histórico, num favorito, numa captura de tela e no cabeçalho "Referer" de
 * toda requisição externa que a página fizesse. */
function telaRedefinir(token){
  molduraDeEntrada(
    '<h2>Escolher nova senha</h2><div class="sub">'+
    'Ao confirmar, todas as sessões abertas nesta conta são encerradas.</div>'+
    '<label class="rotulo" for="n-senha">Nova senha</label>'+
    '<input id="n-senha" type="password" autocomplete="new-password">'+
    '<label class="rotulo" for="n-senha2">Repita a nova senha</label>'+
    '<input id="n-senha2" type="password" autocomplete="new-password">'+
    '<div class="nota">Pelo menos 10 caracteres. Uma frase que só você lembra '+
    'protege mais do que trocar letra por símbolo.</div>'+
    '<div id="n-erro"></div>'+
    '<button class="bt" id="n-enviar">Salvar e entrar</button>');

  var aviso=function(texto,acao){
    $('n-erro').innerHTML='<div class="nota" style="color:var(--erro);margin-top:10px">'+
      esc(texto)+'</div>'+(acao||'');
  };

  var enviar=function(){
    var a=$('n-senha').value, b=$('n-senha2').value;
    if(!a||!b)return;
    /* Conferir aqui, e não só no servidor: um erro de digitação trocaria a
       senha para algo que a pessoa não sabe — e o link já teria sido gasto. */
    if(a!==b){aviso('As duas senhas não são iguais.');return}
    var botao=$('n-enviar'); botao.disabled=true;
    $('n-erro').innerHTML='';
    api('/v1/senha/redefinir',{method:'POST',body:{token:token,senhaNova:a}})
      .then(function(){
        estado.chave=''; try{localStorage.removeItem(CH)}catch(e){}
        return carregarEu();
      })
      .then(function(){estado.aba='novidades';iniciar()})
      .catch(function(e){
        botao.disabled=false;
        if(e.status===401){
          /* Inválido, expirado e já usado dão a MESMA resposta do servidor, de
             propósito. A tela repete esse silêncio e oferece a única saída
             útil: pedir outro link. */
          aviso('Este link não vale mais. Ele expira em uma hora e só pode ser '+
            'usado uma vez.',
            '<button class="bt" id="n-novo">Pedir um link novo</button>');
          var novo=$('n-novo');
          if(novo)novo.addEventListener('click',function(){telaRecuperar()});
          return;
        }
        /* A mensagem do servidor vem primeiro: em senha curta ela diz o
           mínimo exato, e "explicar" cairia no texto genérico de 400, que
           fala de número CNJ e não tem nada a ver com esta tela. */
        aviso(e.message||explicar(e));
      });
  };
  $('n-enviar').addEventListener('click',enviar);
  ['n-senha','n-senha2'].forEach(function(id){
    $(id).addEventListener('keydown',function(e){if(e.key==='Enter')enviar()})});
}

/* A porta das integrações. Continua existindo porque n8n e script não têm
   navegador para guardar cookie — e cada chave segue sendo seu próprio
   ambiente, do mesmo jeito que era antes das contas. */
function telaChave(){
  molduraDeEntrada(
    '<h2>Entrar com chave de API</h2>'+
    '<div class="sub">Para integrações. Pessoas entram com e-mail e senha.</div>'+
    '<label class="rotulo" for="k">Chave de API</label>'+
    '<input id="k" type="password" placeholder="cole a chave aqui" autocomplete="off">'+
    '<div class="nota">Fica guardada apenas neste navegador. É uma chave de '+
    'PROCESSOVIVO_API_KEYS ou uma emitida na área administrativa.</div>'+
    '<button class="bt" id="entrar">Entrar</button>'+
    '<div class="rodape"><button class="link" id="voltar">Voltar para a entrada</button></div>');
  var entrar=function(){
    var v=$('k').value.trim(); if(!v)return;
    estado.chave=v; try{localStorage.setItem(CH,v)}catch(e){}
    estado.eu=null;estado.trilha=null;
    iniciar();
  };
  $('entrar').addEventListener('click',entrar);
  $('voltar').addEventListener('click',function(){telaEntrada('entrar')});
  $('k').addEventListener('keydown',function(e){if(e.key==='Enter')entrar()});
}

function carregarEu(){
  return api('/v1/eu').then(function(r){
    estado.eu=r.usuario; estado.trilha=r.trilha; return true;
  }).catch(function(){estado.eu=null;estado.trilha=null;return false});
}

/*
 * A trilha de liberação.
 *
 * Fica no topo da tela inicial ENQUANTO houver passo pendente, e some sozinha
 * quando tudo está pronto — lembrete permanente vira ruído e ensina a pessoa a
 * ignorar a área mais importante da tela.
 *
 * Cada passo diz o que DESTRAVA, não o que exige. "Informe sua OAB" é
 * burocracia; "para ser avisado de processo novo no seu nome" é motivo.
 */
/* Tarja de assinatura.

   Só aparece quando HÁ o que dizer: o servidor manda o campo "aviso" pronto, e
   ele só vem perto do vencimento, na carência ou depois do bloqueio. Uma tarja
   permanente dizendo "plano Peças, ativo" é ruído que treina a pessoa a não
   ler o cabeçalho — e é justamente o cabeçalho onde vai aparecer, um dia, o
   aviso que importa.

   O texto vem do servidor de propósito. Montá-lo aqui duplicaria a regra de
   status em JavaScript que nenhuma ferramenta lê, e as duas versões
   divergiriam na primeira mudança de carência. */
function blocoAssinatura(){
  var a=estado.assinatura;
  if(!a||!a.aviso)return '';
  var grave=a.status==='vencida'||a.status==='cancelada';
  return '<div class="cartao" style="border-left:3px solid var('+
    (grave?'--erro':'--marco')+')">'+
    '<div class="tt">'+esc(a.aviso)+'</div>'+
    '<div class="cp" style="margin-top:4px">Plano '+esc(a.nomeDoPlano)+
    (grave?' · a vigilância está parada':'')+
    ' <button class="link" data-trilha="conta">Ver minha conta</button></div></div>';
}

function blocoTrilha(){
  var t=estado.trilha;
  if(!t||!estado.eu)return '';
  if(t.oab&&t.tribunal)return '';

  var n=0;
  var passo=function(pronto,titulo,porque,botao,aba){
    n++;
    return '<div class="passo'+(pronto?' feito':'')+'"><span class="marca-passo">'+
      (pronto?'✓':n)+'</span><div>'+
      '<div class="tt">'+esc(titulo)+'</div>'+
      '<div class="cp">'+esc(porque)+'</div>'+
      (pronto?'':'<button class="bt2" data-trilha="'+aba+'">'+esc(botao)+'</button>')+
      '</div></div>';
  };
  var feitos=1+(t.oab?1:0)+(t.tribunal?1:0);

  return '<div class="cartao trilha">'+
    '<div class="trilha-topo"><h3>Falta pouco para o Processo Vivo trabalhar sozinho</h3>'+
    '<span>'+feitos+' de 3</span></div>'+
    '<div class="progresso"><i style="width:'+Math.round(feitos/3*100)+'%"></i></div>'+
    '<div class="passos">'+
    passo(true,'Conta criada','Você já pode consultar qualquer processo por número.','','') +
    passo(t.oab,'Informe sua OAB',
      'Para o sistema achar sozinho os processos no seu nome e avisar de publicação nova.',
      'Informar OAB','conta')+
    passo(t.tribunal,'Cadastre seu acesso ao tribunal',
      'Para baixar as peças das partes: petição, contestação, laudo. O diário nunca publica essas.',
      'Cadastrar acesso','credenciais')+
    '</div></div>';
}
function ligarTrilha(){
  document.querySelectorAll('[data-trilha]').forEach(function(b){
    b.addEventListener('click',function(){ir(b.getAttribute('data-trilha'))})});
}

function verConta(){
  if(!estado.eu){
    $('conteudo').innerHTML=vazio('👤','Você entrou com chave de API',
      'Chave é o acesso de integração, e não tem perfil. Para ter conta com e-mail e senha, saia e crie uma.');
    return;
  }
  var u=estado.eu;

  /* O cartão do plano é PERMANENTE aqui, ao contrário da tarja da tela
     inicial. São perguntas diferentes: a tarja responde "preciso agir agora?"
     e some quando não; este cartão responde "o que eu contratei mesmo?", que
     é a pergunta que traz a pessoa até esta tela. */
  var a=estado.assinatura;
  var rotulos={teste:'em teste',ativa:'ativa',carencia:'vencida, em carência',
    vencida:'vencida',cancelada:'cancelada'};
  var cartaoPlano=a
    ? '<div class="cartao"><h3 class="sec">Plano</h3>'+
      '<div class="tt">'+esc(a.nomeDoPlano)+' · '+esc(rotulos[a.status]||a.status)+'</div>'+
      '<div class="cp" style="margin-top:4px">'+
      (a.status==='vencida'||a.status==='cancelada'
        ? 'A vigilância dos seus processos está parada. Enquanto estiver assim, NÃO receber e-mail nosso não significa que nada aconteceu.'
        : (a.ehTeste?'Teste até ':'Vale até ')+dt(a.venceEm))+
      '</div>'+
      (a.aviso?'<div class="nota" style="margin-top:8px">'+esc(a.aviso)+'</div>':'')+
      (a.precoMensalCentavos!=null
        ? '<div class="cp" style="margin-top:4px">'+esc((a.precoMensalCentavos/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}))+' por mês</div>'
        : '')+
      '<div class="nota" style="margin-top:8px">Inclui: '+esc((a.nomesDosRecursos||a.recursos).join(', '))+'</div>'+
      '<div class="nota" style="margin-top:8px">Para trocar de plano ou renovar, '+
      'responda o e-mail de aviso ou fale com a gente.</div></div>'
    : '';

  $('conteudo').innerHTML=
    '<div class="titulo-secao"><div><h2>Minha conta</h2>'+
    '<div class="sub">'+esc(u.nome)+' · '+esc(u.email)+'</div></div></div>'+
    cartaoPlano+

    '<div class="cartao"><h3 class="sec">Inscrição na OAB</h3>'+
    '<div class="nota">É o que permite achar os processos no seu nome sem você '+
    'digitar número nenhum, e ligar o aviso de publicação nova.</div>'+
    '<div class="campo" style="margin-top:12px">'+
      '<div><label class="rotulo" for="p-oab">Número</label>'+
      '<input id="p-oab" placeholder="47383" value="'+esc(u.oab||'')+'" style="width:150px"></div>'+
      '<div><label class="rotulo" for="p-uf">UF</label>'+
      '<input id="p-uf" placeholder="GO" maxlength="2" value="'+esc(u.ufOab||'')+'" style="width:90px"></div>'+
      '<div style="align-self:end"><button class="bt" id="p-salvar">Salvar</button></div>'+
    '</div><div id="p-aviso"></div></div>'+

    '<div class="cartao"><h3 class="sec">Trocar a senha</h3>'+
    '<div class="nota">Trocar a senha encerra as sessões abertas em outros '+
    'aparelhos. É de propósito: quem troca costuma estar tirando alguém de dentro.</div>'+
    '<div class="campo" style="margin-top:12px">'+
      '<div><label class="rotulo" for="s-atual">Senha atual</label>'+
      '<input id="s-atual" type="password" autocomplete="current-password"></div>'+
      '<div><label class="rotulo" for="s-nova">Senha nova</label>'+
      '<input id="s-nova" type="password" autocomplete="new-password"></div>'+
      '<div style="align-self:end"><button class="bt bt2" id="s-salvar">Trocar</button></div>'+
    '</div><div id="s-aviso"></div></div>';

  $('p-salvar').addEventListener('click',function(){
    var oab=$('p-oab').value.trim(), uf=$('p-uf').value.trim().toUpperCase();
    if(!oab||!uf){$('p-aviso').innerHTML='<div class="nota">Informe número e UF.</div>';return}
    $('p-salvar').disabled=true;
    api('/v1/eu',{method:'PATCH',body:{oab:oab,ufOab:uf}}).then(function(r){
      estado.eu=r.usuario;estado.trilha=r.trilha;
      $('p-salvar').disabled=false;
      $('p-aviso').innerHTML='<div class="nota" style="color:var(--ok)">Salvo. '+
        'A vigilância por OAB já pode ser ligada na aba Vigilância.</div>';
    }).catch(function(e){
      $('p-salvar').disabled=false;
      $('p-aviso').innerHTML='<div class="nota" style="color:var(--erro)">'+esc(e.message)+'</div>';
    });
  });

  $('s-salvar').addEventListener('click',function(){
    var atual=$('s-atual').value, nova=$('s-nova').value;
    if(!atual||!nova)return;
    $('s-salvar').disabled=true;
    api('/v1/eu/senha',{method:'POST',body:{senhaAtual:atual,senhaNova:nova}})
      .then(function(){
        $('s-salvar').disabled=false;$('s-atual').value='';$('s-nova').value='';
        $('s-aviso').innerHTML='<div class="nota" style="color:var(--ok)">Senha trocada.</div>';
      })
      .catch(function(e){
        $('s-salvar').disabled=false;
        $('s-aviso').innerHTML='<div class="nota" style="color:var(--erro)">'+esc(e.message)+'</div>';
      });
  });
}

function carregarFacetas(){
  return api('/v1/facetas').then(function(f){estado.facetas=f}).catch(function(){});
}

/* ---------------- aba: vigilância por OAB e avisos ---------------- */
/**
 * A tela que muda a natureza do produto.
 *
 * Até aqui o usuário precisava saber o número do processo para acompanhá-lo —
 * ou seja, precisava já saber que o processo existe. Cadastrando a inscrição,
 * ele passa a ser avisado de processo que nem sabia que tinha.
 */
function verVigilancia(){
  $('conteudo').innerHTML=
    '<div class="titulo-secao"><div><h2>Vigilância por OAB</h2>'+
    '<div class="sub">Cadastre sua inscrição uma vez. Toda publicação nova no '+
    'seu nome entra sozinha na carteira.</div></div></div>'+

    '<div class="cartao"><h3 class="sec">Inscrições vigiadas</h3>'+
    '<div class="campo">'+
      '<div><label for="v-oab">Número da OAB</label>'+
      '<input id="v-oab" class="ent" placeholder="47383" style="width:150px"></div>'+
      '<div><label for="v-uf">UF</label>'+
      '<input id="v-uf" class="ent" placeholder="GO" maxlength="2" style="width:70px"></div>'+
      '<div><label for="v-apelido">Apelido (opcional)</label>'+
      '<input id="v-apelido" class="ent" placeholder="Dr. João" style="width:180px"></div>'+
      '<button class="bt" id="v-add">Vigiar</button>'+
    '</div>'+
    '<div id="v-lista"><span class="gira"></span>Carregando…</div></div>'+

    '<div class="cartao"><h3 class="sec">Aviso por e-mail</h3>'+
    '<div class="nota">Um resumo por ciclo, não um e-mail por movimentação. E, '+
    'igualmente importante: se ficarmos sem conseguir verificar, você é avisado '+
    'disso também — silêncio não deve ser lido como "não houve nada".</div>'+
    '<div class="campo">'+
      '<div><label for="n-email">Endereço</label>'+
      '<input id="n-email" class="ent" type="email" placeholder="voce@escritorio.com.br" style="width:260px"></div>'+
      '<button class="bt" id="n-salvar">Salvar</button>'+
      '<button class="bt bt2" id="n-desligar">Desligar avisos</button>'+
    '</div><div id="n-estado" class="nota"></div></div>';

  $('v-add').addEventListener('click',adicionarVigilancia);
  $('n-salvar').addEventListener('click',function(){salvarNotificacao(true)});
  $('n-desligar').addEventListener('click',function(){salvarNotificacao(false)});
  carregarVigilancias();
  carregarNotificacao();
}

function carregarVigilancias(){
  api('/v1/vigilancias').then(function(r){
    var l=r.vigilancias||[];
    if(!l.length){
      $('v-lista').innerHTML='<div class="nota">Nenhuma inscrição vigiada ainda.</div>';
      return;
    }
    $('v-lista').innerHTML=l.map(function(v){
      return '<div class="vig"><div>'+
        '<div class="id">OAB '+esc(v.identificacao)+(v.apelido?' · '+esc(v.apelido):'')+'</div>'+
        '<div class="nota">'+
          (v.ativa?'':'desligada · ')+
          v.processosEncontrados+' processo(s) trazidos · '+
          (v.varridaEm?'verificada '+humano(v.varridaEm):'ainda não verificada')+
          (v.erro?' · <span style="color:var(--al)">'+esc(v.erro)+'</span>':'')+
        '</div></div>'+
        '<button class="bt bt3" data-parar="'+esc(v.uf)+'/'+esc(v.oab)+'">remover</button>'+
        '</div>';
    }).join('');
    document.querySelectorAll('[data-parar]').forEach(function(el){
      el.addEventListener('click',function(){
        var partes=el.getAttribute('data-parar').split('/');
        api('/v1/vigilancias/'+encodeURIComponent(partes[0])+'/'+encodeURIComponent(partes[1]),
          {method:'DELETE'}).then(carregarVigilancias).catch(function(e){alert(explicar(e))});
      })});
  }).catch(function(e){$('v-lista').innerHTML=erroBloco(e)});
}

function adicionarVigilancia(){
  var oab=$('v-oab').value.trim(), uf=$('v-uf').value.trim().toUpperCase();
  var apelido=$('v-apelido').value.trim();
  if(!oab||uf.length!==2)return;
  var b=$('v-add'); b.disabled=true; b.innerHTML='<span class="gira"></span>Vigiando';
  api('/v1/vigilancias',{method:'POST',body:{oab:oab,uf:uf,apelido:apelido||undefined}})
    .then(function(){
      $('v-oab').value='';$('v-apelido').value='';
      carregarVigilancias();
      // Primeira varredura na hora: cadastrar e não ver nada acontecer por uma
      // hora passa a impressão de que não funcionou.
      return api('/v1/vigilancias/varrer',{method:'POST',body:{}});
    })
    .then(function(){
      $('v-lista').insertAdjacentHTML('afterbegin',
        '<div class="nota">Primeira varredura em andamento — os processos dos últimos '+
        '30 dias vão aparecer em Meus processos.</div>');
    })
    .catch(function(e){alert(explicar(e))})
    .then(function(){b.disabled=false;b.textContent='Vigiar'});
}

function carregarNotificacao(){
  api('/v1/notificacao').then(function(n){
    $('n-email').value=n.email||'';
    $('n-estado').textContent=n.ativa
      ? 'Avisos ligados'+(n.ultimoEnvioEm?' · último envio '+humano(n.ultimoEnvioEm):'')
      : 'Avisos desligados';
  }).catch(function(){});
}

function salvarNotificacao(ativa){
  var email=$('n-email').value.trim();
  api('/v1/notificacao',{method:'PUT',body:{email:email||undefined,ativa:ativa}})
    .then(carregarNotificacao)
    .catch(function(e){alert(explicar(e))});
}

function render(){
  if(estado.detalhe)return;
  $('conteudo').classList.toggle('env-larga',estado.aba==='novidades');
  if(estado.aba==='novidades')return verNovidades();
  if(estado.aba==='processos')return verProcessos();
  if(estado.aba==='vigilancia')return verVigilancia();
  if(estado.aba==='credenciais')return verCredenciais();
  if(estado.aba==='conta')return verConta();
  if(estado.aba==='calendario'&&window.__pvCalendario)return window.__pvCalendario.ver($('conteudo'));// ui/calendario.ts
  return verBuscar();
}

/* ---------------- tema ---------------- */
/* Automático segue o computador; claro e escuro fixam. A escolha fica neste
   navegador (é preferência de tela, não da conta), e o <head> a aplica ANTES
   da primeira pintura — senão a tela abriria escura e piscaria para clara. */
var TEMA='processovivo.tema';
var TEMAS={auto:'automático',claro:'claro',escuro:'escuro'};
function temaAtual(){
  try{var t=localStorage.getItem(TEMA);return t==='claro'||t==='escuro'?t:'auto'}
  catch(e){return 'auto'}
}
function aplicarTema(t){
  if(t==='claro'||t==='escuro')document.documentElement.setAttribute('data-tema',t);
  else document.documentElement.removeAttribute('data-tema');
  try{if(t==='auto')localStorage.removeItem(TEMA);else localStorage.setItem(TEMA,t)}catch(e){}
  var b=$('tema');
  if(b){
    b.querySelector('span').textContent='Tema: '+TEMAS[t];
    b.setAttribute('title','Tema '+TEMAS[t]+' — clique para trocar');
  }
}
if($('tema'))$('tema').addEventListener('click',function(){
  var ordem=['auto','claro','escuro'];
  aplicarTema(ordem[(ordem.indexOf(temaAtual())+1)%ordem.length]);
});
aplicarTema(temaAtual());

/* O cartão no pé da lateral: quem está dentro e em que plano. Com chave de
   API não há pessoa nem plano — diz isso, em vez de deixar o cartão vazio. */
function pintarUsuario(){
  var nome=estado.eu&&estado.eu.nome?estado.eu.nome:'';
  var iniciais=nome.split(' ').filter(function(p){return p}).slice(0,2)
    .map(function(p){return p.charAt(0).toUpperCase()}).join('');
  var a=estado.assinatura;
  var plano=!estado.eu?'integração':
    /* No teste, a data é o que importa ali; o nome do plano está em Minha conta. */
    !a?'':(a.ehTeste?'Teste até '+dt(a.venceEm).slice(0,5):'Plano '+a.nomeDoPlano);
  if($('usuario-nome'))$('usuario-nome').textContent=nome||'Chave de API';
  if($('usuario-plano'))$('usuario-plano').textContent=plano;
  if($('usuario-iniciais'))$('usuario-iniciais').textContent=iniciais||'API';
}

function iniciar(){
  document.body.classList.remove('fora');
  $('lateral').classList.remove('oculto');
  var navConta=$('nav-conta');
  if(navConta)navConta.classList.toggle('oculto',!estado.eu);
  pintarUsuario();
  /* Falha aqui não pode derrubar a tela: a assinatura é um aviso, não o
     produto. Um erro na rota deixaria o advogado sem a carteira por causa de
     uma tarja. */
  api('/v1/assinatura').then(function(r){
    estado.assinatura=r.assinatura;
    pintarUsuario();
    if(estado.assinatura)render();
  }).catch(function(){});

  api('/v1/facetas').then(function(f){
    estado.facetas=f;
    atualizarBolha();
    pintarNav();
    render();if(window.__pvAoIniciar)window.__pvAoIniciar();// link /?processo= (ui/calendario.ts)
  }).catch(function(e){
    if(e.status===401){
      estado.chave='';try{localStorage.removeItem(CH)}catch(x){}
      estado.eu=null;estado.trilha=null;
      $('lateral').classList.add('oculto');telaEntrada('entrar');return}
    $('conteudo').innerHTML=erroBloco(e);
  });
}

['novidades','processos','calendario','buscar','vigilancia','credenciais','conta'].forEach(function(a){
  var b=$('nav-'+a); if(b)b.addEventListener('click',function(){ir(a)})});

$('sair').addEventListener('click',function(){
  /* Sair é do servidor, não só do navegador: apagar o cookie localmente
     deixaria a sessão VÁLIDA no banco, e um cookie copiado antes disso
     continuaria abrindo a conta. */
  var fim=function(){
    estado.chave='';try{localStorage.removeItem(CH)}catch(e){}
    estado.eu=null;estado.trilha=null;
    $('lateral').classList.add('oculto');telaEntrada('entrar');
  };
  api('/v1/sessoes',{method:'DELETE'}).then(fim,fim);
});

/* O token de recuperação, se veio na URL, é lido e APAGADO da barra de
   endereço antes de qualquer outra coisa.

   Não é preciosismo: na URL ele entra no histórico do navegador, pode ser
   salvo num favorito, aparece em captura de tela e viaja no cabeçalho
   "Referer" de toda requisição que a página fizer para fora. "replaceState"
   troca a entrada atual do histórico em vez de acrescentar outra — com
   "pushState" o botão "voltar" traria o token de volta.

   O token continua vivo na variável, que é o suficiente para a tela funcionar
   e some quando a aba fecha. */
var tokenRecuperacao='';
try{
  var busca=new URLSearchParams(location.search);
  tokenRecuperacao=busca.get('recuperar')||'';
  if(tokenRecuperacao){
    busca.delete('recuperar');
    var resto=busca.toString();
    history.replaceState(null,'',location.pathname+(resto?'?'+resto:''));
  }
}catch(e){}

/* Ordem de tentativa: PRIMEIRO o link de recuperação, depois o cookie de
   sessão, depois a chave guardada. A recuperação vem na frente de propósito:
   quem clicou no link do e-mail pode estar justamente tirando alguém de dentro
   da conta, e cair na carteira por causa de um cookie antigo esconderia a
   única coisa que a pessoa veio fazer. A mesma precedência do servidor vale
   para o resto — entre cookie e chave, quem vale é a pessoa. */
if(tokenRecuperacao){
  telaRedefinir(tokenRecuperacao);
}else{
  carregarEu().then(function(entrou){
    if(entrou){iniciar();return}
    try{estado.chave=localStorage.getItem(CH)||''}catch(e){}
    if(estado.chave)iniciar(); else telaEntrada('entrar');
  });
}
})();
`;
