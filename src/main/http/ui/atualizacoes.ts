/**
 * Corpo da aba ATUALIZAÇÕES (v0.37.0): uma TABELA, uma linha por processo.
 *
 * Arquivo próprio pela mesma razão do leitor e do calendário: `script.ts` já
 * passa de 2.400 linhas e há teste que impede o arquivo de crescer. O console
 * chama `window.__pvAtualizacoes` e este arquivo usa só `window.__pv`.
 *
 * O que sustenta a tela (CLAUDE.md §8):
 * - o agrupamento e a janela de 15 dias vêm PRONTOS do servidor (`grupos`,
 *   `foraDaJanela`): a tela não reagrupa nem reclassifica;
 * - filtros, ordenação e paginação moram em `tabelaAtualizacoes.ts` (funções puras,
 *   injetadas aqui por `toString()` e exercitadas pelos testes);
 * - uma linha por processo, com a atualização mais recente e mais nada: não há
 *   "+N anteriores" nem aviso por linha (v0.37.1). A regra de ouro vira UMA frase no
 *   nível da página ("as anteriores estão em 'Abrir processo'"), só quando algum
 *   processo tem mais de uma atualização no período;
 * - quem esconde linha diz quantas escondeu: "mostrando X de Y processos" e "N
 *   atualizações mais antigas não mostradas", sempre com a saída ao lado;
 * - triagem ordena, nunca esconde: `exigeAcao` só MARCA. O filtro "Pedem
 *   providência" é escolha explícita da pessoa e usa a regra do servidor
 *   (`estadoDaPasta`, janela única);
 * - nada aqui afirma prazo. Partes e classe vêm do retrato do acompanhamento;
 *   vazio é "—", nunca dedução;
 * - o estado dos filtros vive na página (variável do módulo), nunca em
 *   localStorage: recarregar a página volta ao padrão.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao
 * tsc; `tests/http/console-script.spec.ts` roda o ESLint aqui dentro. Todo
 * texto vindo do servidor passa por `esc()`.
 */
import { descricaoDoAto } from '../../../domain/entities/descricaoDoAto.js';
import { nomeDaClasse } from '../../../domain/entities/nomeDaClasse.js';
import { trechoDeTexto } from './trechoDeTexto.js';
import {
  contarSituacoes,
  montarLinhas,
  filtrarPorSituacao,
  ordenarGrupos,
  paginar,
  proximaOrdem,
  textoDePartes,
} from './tabelaAtualizacoes.js';
import { ESTILOS_TABELA_ATUALIZACOES } from './estilosAtualizacoes.js';

export const SCRIPT_ATUALIZACOES = String.raw`
(function(){
var pv=function(){return window.__pv};
/* As MESMAS funções que os testes exercitam (ui/trechoDeTexto.ts e
   ui/tabelaAtualizacoes.ts), injetadas como texto. */
var trechoDeTexto=${trechoDeTexto.toString()};
var contarSituacoes=${contarSituacoes.toString()};
var montarLinhas=${montarLinhas.toString()};
var filtrarPorSituacao=${filtrarPorSituacao.toString()};
var proximaOrdem=${proximaOrdem.toString()};
var ordenarGrupos=${ordenarGrupos.toString()};
var paginar=${paginar.toString()};
var descricaoDoAto=${descricaoDoAto.toString()};
var nomeDaClasse=${nomeDaClasse.toString()};
var textoDePartes=${textoDePartes.toString()};

/* Só a escolha da sessão: some quando a página recarrega. */
var S={situacao:'todas',ordem:null,porPagina:25,pagina:1,foco:''};
var R=null,O=null,corpo=null,live=null;

var SITUACOES=[['todas','Todas'],['naoLidas','Não lidas'],['providencia','Pedem providência']];
var NOMES_ORDEM={processo:'Processo',tribunal:'Tribunal',dataAto:'Data do ato',detectado:'Detectado'};

function svg(d){return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+d+'</svg>'}
var ICO_COPIAR=svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
var ICO_ABRIR=svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>');
var ICO_PASTA=svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>');
var ICO_PRIMEIRA=svg('<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>');
var ICO_ANTERIOR=svg('<path d="m15 18-6-6 6-6"/>');
var ICO_PROXIMA=svg('<path d="m9 18 6-6-6-6"/>');
var ICO_ULTIMA=svg('<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>');

function esc(s){return pv().esc(s)}
function digitos(n){return String(n||'').replace(/\D/g,'')}

/* O "há N dias" desta lista conta desde a DETECÇÃO, nunca desde a data do ato. A
   célula mostra só "há 11 dias" (o cabeçalho já diz "Detectado"); a frase completa
   vai no title e no texto para leitor de tela. "ontem" vira "há 1 dia" para seguir
   o mesmo molde. */
function detectadoCurto(iso){
  var h=pv().humano(iso);
  if(!h)return '';
  return h==='ontem'?'há 1 dia':h;
}
function detectadoHa(iso){
  var c=detectadoCurto(iso);
  return c?'detectado '+c:'';
}

/* Só o começo do texto do ato; o inteiro está no processo (v0.35.1). As
   reticências ficam fora do texto lido: aria-hidden, para não virar "ponto ponto ponto". */
function notaDoAto(n){
  var t=trechoDeTexto(n.conteudo);
  if(!t.texto)return '';
  return '<div class="nota nov-trecho"><div class="nov-txt">'+esc(t.texto)+
    (t.cortado?'<span aria-hidden="true">…</span>':'')+'</div>'+
    (t.cortado?'<button type="button" class="lnh nov-abrir" data-acao="abrir" data-num="'+esc(n.numero)+
      '" aria-label="Abrir o processo para ler o texto completo">Abrir processo</button>':'')+'</div>';
}

function seloProvidencia(motivo){
  return '<span class="selo am" title="'+esc((motivo?motivo+'. ':'')+
    'Marcado por leitura automática do texto. Confira no ato completo.')+'">pede providência</span>';
}

/* ---------- a linha do processo ---------- */
function celulaProcesso(g){
  var m=pv().mascara(g.numero);
  return '<td class="c-proc" data-rotulo="Processo"><div class="nvt-proc">'+
    '<a class="nvt-num" href="/?processo='+esc(digitos(g.numero))+'" data-acao="abrir" data-num="'+esc(g.numero)+'">'+esc(m).replace(/([-.])/g,'$1<wbr>')+'</a>'+
    '<button type="button" class="nvt-ic nvt-copiar" data-acao="copiar" data-num="'+esc(g.numero)+'" data-foco="copiar-'+esc(g.numero)+'"'+
    ' aria-label="Copiar o número do processo '+esc(m)+'" title="Copiar o número">'+ICO_COPIAR+'</button></div></td>';
}

function celulaPartes(g){
  var txt=textoDePartes(g.processo?g.processo.partes:null);
  if(!txt)return '<td class="c-partes" data-rotulo="Partes"><span class="nvt-vazio" title="A fonte não informou as partes">—</span></td>';
  return '<td class="c-partes" data-rotulo="Partes"><span class="nvt-partes" title="'+esc(txt)+'">'+esc(txt)+'</span></td>';
}

/* Processo acompanhado SEM novidade registrada (v0.37.3): a última movimentação do retrato,
   com a mesma regra de descrição e de trecho. Não é "atualização detectada" e a célula diz isso.
   Segredo de justiça: rótulo e data, nunca o texto do ato. */
function celulaSemNovidade(g){
  var n=g.maisRecente;
  var h='<td class="c-atu" data-rotulo="Atualização">';
  if(!n.data){
    return h+'<div class="nvt-tit nvt-vazio">Nenhuma movimentação conhecida</div></td>';
  }
  var enxuto=descricaoDoAto(n.titulo);
  h+='<div class="nvt-sem">Última movimentação conhecida · sem atualização detectada</div>'+
    '<div class="nvt-tit"'+(enxuto!==n.titulo?' title="'+esc(n.titulo)+'"':'')+'>'+esc(enxuto)+'</div>';
  if(g.segredoJustica)
    h+='<div class="nota nvt-sem"><span class="selo al">segredo de justiça</span> O texto do ato não é exibido aqui.</div>';
  else h+=notaDoAto(n);
  return h+'</td>';
}

function celulaAtualizacao(n){
  /* Só a exibição perde a repetição do tipo; o original fica no title. */
  var enxuto=descricaoDoAto(n.titulo);
  return '<td class="c-atu" data-rotulo="Atualização"><div class="nvt-tit'+(n.vista?'':' nl')+'"'+
    (enxuto!==n.titulo?' title="'+esc(n.titulo)+'"':'')+'>'+esc(enxuto)+'</div>'+notaDoAto(n)+'</td>';
}

function celulaSituacao(g){
  var s='';
  if(g.naoVistas>0)s+='<span class="selo nv" title="'+esc(g.naoVistas+(g.naoVistas>1?' atualizações ainda não lidas neste processo':' atualização ainda não lida neste processo'))+'">'+
    (g.naoVistas>1?g.naoVistas+' não lidas':'Não lida')+'</span>';
  if(g.processo&&g.processo.pedeProvidencia)s+=seloProvidencia(g.processo.motivoProvidencia);
  return '<td class="c-sit" data-rotulo="Situação">'+s+'</td>';
}

function celulaAcoes(g){
  var m=pv().mascara(g.numero);
  return '<td class="c-acoes" data-rotulo="Ações"><div class="nvt-acoes">'+
    '<button type="button" class="nvt-ic" data-acao="abrir" data-num="'+esc(g.numero)+'" data-foco="abrir-'+esc(g.numero)+'" aria-label="Abrir o processo '+esc(m)+'" title="Abrir o processo">'+ICO_ABRIR+'</button>'+
    '<button type="button" class="nvt-ic" data-acao="pasta" data-num="'+esc(g.numero)+'" data-foco="pasta-'+esc(g.numero)+'" aria-label="Abrir a pasta digital do processo '+esc(m)+'" title="Abrir a pasta digital">'+ICO_PASTA+'</button>'+
    '</div></td>';
}

/* A classe é montada AQUI e só aqui: a coluna Classe e a linha sob o Tribunal (1024–1279 px)
   saem do mesmo texto. Só a exibição é normalizada; o texto cru vai no title quando difere,
   e o title tem sempre a classe inteira para o caso de a coluna ainda cortar. Sem classe,
   "—": nunca se inventa. */
function classeDaLinha(g){
  var cru=g.processo&&g.processo.classe?String(g.processo.classe):'';
  var txt=nomeDaClasse(cru);
  if(!txt)return {cheia:'<span class="nvt-vazio" title="A fonte não informou a classe">—</span>',mini:''};
  var t=' title="'+esc(cru!==txt?cru:txt)+'"';
  return {cheia:'<span class="nvt-classe"'+t+'>'+esc(txt)+'</span>',mini:'<span class="nvt-classe-mini"'+t+'>'+esc(txt)+'</span>'};
}

function celulaData(n){
  if(!n.data)return '<td class="c-data" data-rotulo="Data do ato"><span class="nvt-vazio" title="Nenhuma movimentação conhecida">—</span></td>';
  return '<td class="c-data" data-rotulo="Data do ato"><time datetime="'+esc(n.data)+'" title="'+esc(pv().dth(n.data))+'">'+esc(pv().dt(n.data))+'</time></td>';
}
function celulaDetectado(n){
  if(!n.detectadaEm)
    return '<td class="c-det" data-rotulo="Detectado"><span title="Sem detecção registrada: o acompanhamento ainda não percebeu nenhuma movimentação nova neste processo.">'+
      '<span aria-hidden="true">—</span><span class="nvt-sr">sem detecção registrada</span></span></td>';
  return '<td class="c-det" data-rotulo="Detectado"><span title="'+esc(detectadoHa(n.detectadaEm)+'. Quando o Processo Vivo percebeu este ato ('+pv().dth(n.detectadaEm)+'). A data do ato está na coluna ao lado.')+'">'+
    '<span aria-hidden="true">'+esc(detectadoCurto(n.detectadaEm))+'</span><span class="nvt-sr">'+esc(detectadoHa(n.detectadaEm))+'</span></span></td>';
}

function linha(g){
  var n=g.maisRecente;
  var classe=classeDaLinha(g);
  var h='<tr class="nvt-linha'+(g.semNovidade?' nvt-sem-nov':'')+'" role="row" data-processo="'+esc(g.numero)+'">'+
    celulaProcesso(g)+celulaPartes(g)+(g.semNovidade?celulaSemNovidade(g):celulaAtualizacao(n))+
    '<td class="c-trib" data-rotulo="Tribunal">'+esc(g.processo&&g.processo.tribunal?g.processo.tribunal:'—')+classe.mini+'</td>'+
    '<td class="c-classe" data-rotulo="Classe">'+classe.cheia+'</td>'+
    celulaData(n)+celulaDetectado(n)+
    celulaSituacao(g)+celulaAcoes(g)+'</tr>';
  return h;
}

/* ---------- cabeçalho, filtros e rodapé ---------- */
function cabecalhoOrdenavel(chave){
  var o=S.ordem&&S.ordem.chave===chave?S.ordem:null;
  var seta=o?(o.direcao==='asc'?'↑':'↓'):'↕';
  return '<th scope="col" class="h-'+chave+'" aria-sort="'+(o?(o.direcao==='asc'?'ascending':'descending'):'none')+'">'+
    '<button type="button" class="nvt-ord" data-acao="ord" data-chave="'+chave+'" data-foco="ord-'+chave+'">'+NOMES_ORDEM[chave]+
    ' <span class="nvt-seta" aria-hidden="true">'+seta+'</span></button></th>';
}

function cabecalho(){
  return '<thead><tr role="row">'+cabecalhoOrdenavel('processo')+
    '<th scope="col" class="h-partes">Partes</th><th scope="col" class="h-atu">Atualização</th>'+
    cabecalhoOrdenavel('tribunal')+'<th scope="col" class="h-classe">Classe</th>'+
    cabecalhoOrdenavel('dataAto')+cabecalhoOrdenavel('detectado')+
    '<th scope="col" class="h-sit">Situação</th><th scope="col" class="h-acoes">Ações</th></tr></thead>';
}

function filtros(cont){
  var todas=R.janelaDias===null;
  var h='<div class="nvt-filtros">'+
    '<div class="nvt-bloco"><span class="nvt-rot" id="nvt-rot-periodo">Período</span>'+
    '<div class="nvt-chips" role="group" aria-labelledby="nvt-rot-periodo">'+
    '<button type="button" class="chip'+(todas?'':' on')+'" aria-pressed="'+(todas?'false':'true')+'" data-acao="periodo" data-janela="padrao" data-foco="periodo-padrao">Últimos '+R.janelaPadraoDias+' dias</button>'+
    '<button type="button" class="chip'+(todas?' on':'')+'" aria-pressed="'+(todas?'true':'false')+'" data-acao="periodo" data-janela="todas" data-foco="periodo-todas">Todas</button></div></div>'+
    '<div class="nvt-bloco"><span class="nvt-rot" id="nvt-rot-situacao">Situação</span>'+
    '<div class="nvt-chips" role="group" aria-labelledby="nvt-rot-situacao">';
  var n={todas:cont.todas,naoLidas:cont.naoLidas,providencia:cont.pedemProvidencia};
  SITUACOES.forEach(function(s){
    var on=S.situacao===s[0];
    var dica=s[0]==='providencia'?'Processos com ato dos últimos '+R.pendenciaJanelaDias+' dias que pede providência (leitura automática do texto; confira no ato completo).':
      s[0]==='naoLidas'?'Processos com atualização que você ainda não abriu.':'Todos os processos acompanhados'+(todas?'.':' com atualização detectada no período.');
    h+='<button type="button" class="chip'+(s[0]==='naoLidas'&&on?' nv':'')+(on?' on':'')+'" aria-pressed="'+(on?'true':'false')+'" title="'+esc(dica)+'" data-acao="situacao" data-sit="'+s[0]+'" data-foco="sit-'+s[0]+'">'+
      esc(s[1])+' ('+n[s[0]]+')</button>';
  });
  h+='</div></div>'+
    '<div class="nvt-bloco"><label class="nvt-rot" for="nvt-trib">Tribunal</label>'+
    '<select id="nvt-trib" data-sel="tribunal" data-foco="trib"><option value="">Todos os tribunais</option>'+
    (O.tribunais||[]).map(function(t){return '<option value="'+esc(t)+'"'+(O.tribunal===t?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select></div>'+
    '<div class="nvt-bloco nvt-so-pequeno"><label class="nvt-rot" for="nvt-ordenar">Ordenar por</label>'+
    '<select id="nvt-ordenar" data-sel="ordenar" data-foco="ordenar"><option value="">Ordem padrão</option>'+
    ['dataAto:desc','dataAto:asc','detectado:desc','detectado:asc','processo:asc','processo:desc','tribunal:asc','tribunal:desc'].map(function(v){
      var p=v.split(':'),on=S.ordem&&S.ordem.chave===p[0]&&S.ordem.direcao===p[1];
      var d=(p[0]==='dataAto'||p[0]==='detectado')?(p[1]==='desc'?'mais recente primeiro':'mais antiga primeiro'):(p[1]==='asc'?'A–Z':'Z–A');
      return '<option value="'+v+'"'+(on?' selected':'')+'>'+NOMES_ORDEM[p[0]]+' ('+d+')</option>'}).join('')+'</select></div>'+
    '</div>';
  return h;
}

function resumo(base,filtrados){
  var onde=O.tribunal?' em '+esc(O.tribunal):'';
  var h='<div class="nvt-resumo">';
  if(S.situacao!=='todas'){
    var nome=SITUACOES.filter(function(s){return s[0]===S.situacao})[0][1];
    h+='Mostrando <strong>'+filtrados+'</strong> de <strong>'+base+'</strong> processos'+onde+
      (R.janelaDias===null?'':' com atualização detectada nos últimos '+R.janelaPadraoDias+' dias')+' (filtro: '+esc(nome)+'). '+
      '<button type="button" class="nov-btn" data-acao="limpar" data-foco="limpar">Limpar filtros</button>';
  }else if(R.janelaDias===null){
    h+='<strong>'+base+'</strong> '+(base===1?'processo acompanhado':'processos acompanhados')+onde+'.';
  }else{
    h+='<strong>'+R.acompanhados+'</strong> '+(R.acompanhados===1?'processo acompanhado':'processos acompanhados')+onde+
      ' · <strong>'+base+'</strong> com atualização detectada nos últimos '+R.janelaPadraoDias+' dias.';
  }
  return h+'</div>';
}

/* O período é um filtro da pessoa e nasce desligado. Ligado, diz quantos PROCESSOS tirou da
   lista (e, se houver, quantas atualizações antigas existem) e oferece a saída ao lado. */
function avisoDeOcultas(){
  if(R.janelaDias===null||!(R.processosForaDaJanela>0))return '';
  var n=R.processosForaDaJanela;
  return '<div class="nota nov-fora">'+n+(n>1?' processos sem atualização':' processo sem atualização')+' nos últimos '+R.janelaPadraoDias+' dias'+
    (R.foraDaJanela>0?' (há '+R.foraDaJanela+(R.foraDaJanela>1?' atualizações mais antigas':' atualização mais antiga')+')':'')+
    ' · <button type="button" class="nov-btn" data-acao="periodo" data-janela="todas" data-foco="ver-todas">Ver todos</button></div>';
}

/* A regra de ouro em UMA frase, no nível da página: sem contagem por processo e sem
   alarme. Só existe se algum processo da lista tem mais de uma atualização no período. */
function avisoDeAnteriores(linhas){
  if(!linhas.some(function(g){return g.quantidade>1}))return '';
  return "<div class='nota nov-ant'>Cada processo mostra a atualização mais recente. As anteriores estão em 'Abrir processo'.</div>";
}

function rodape(pg){
  var h='<nav class="nvt-pag" aria-label="Paginação das atualizações">'+
    '<label class="nvt-por">Itens por página <select data-sel="porpagina" data-foco="porpagina">'+
    [10,25,50].map(function(n){return '<option value="'+n+'"'+(S.porPagina===n?' selected':'')+'>'+n+'</option>'}).join('')+'</select></label>'+
    '<span class="nvt-faixa">'+pg.de+'–'+pg.ate+' de '+pg.total+' '+(pg.total===1?'processo':'processos')+'</span>'+
    '<span class="nvt-nav">';
  function bt(rot,ico,alvo,desligado){
    return '<button type="button" class="nvt-ic" data-acao="pagina" data-vai="'+alvo+'" data-foco="pag-'+alvo+'" aria-label="'+rot+'" title="'+rot+'"'+(desligado?' disabled':'')+'>'+ico+'</button>';
  }
  h+=bt('Primeira página',ICO_PRIMEIRA,'primeira',pg.pagina<=1)+bt('Página anterior',ICO_ANTERIOR,'anterior',pg.pagina<=1)+
    '<span class="nvt-pagina">Página '+pg.pagina+' de '+pg.paginas+'</span>'+
    bt('Próxima página',ICO_PROXIMA,'proxima',pg.pagina>=pg.paginas)+bt('Última página',ICO_ULTIMA,'ultima',pg.pagina>=pg.paginas);
  return h+'</span></nav>';
}

/* ---------- estados sem tabela ---------- */
function semProcessos(){
  return pv().vazio('🔔','Nenhum processo acompanhado ainda',
    'Adicione um processo pelo número e o Processo Vivo passa a verificar sozinho, avisando quando houver movimentação nova.',
    '<button type="button" class="bt" data-acao="buscar">Buscar processo</button>');
}
function semBase(){
  if(R.janelaDias!==null)
    return pv().vazio('🔔','Nenhum processo com atualização nos últimos '+R.janelaPadraoDias+' dias',
      'Seus processos continuam sendo acompanhados — o período só esconde o que não tem atualização nele.',
      '<button type="button" class="bt bt2" data-acao="periodo" data-janela="todas" data-foco="ver-todas">Ver todos</button>');
  return pv().vazio('🔔','Nenhum processo com este filtro','Não há processo de '+O.tribunal+' acompanhado.',
    '<button type="button" class="bt bt2" data-acao="limpar" data-foco="limpar">Limpar filtros</button>');
}
function semResultado(total){
  return pv().vazio('🔎','Nenhum processo com este filtro',
    'Há '+total+(R.janelaDias===null?(total===1?' processo acompanhado':' processos acompanhados'):(total===1?' processo':' processos')+' com atualização neste período')+', sem o filtro de situação.',
    '<button type="button" class="bt bt2" data-acao="limpar" data-foco="limpar">Limpar filtros</button>');
}

/* ---------- desenho ---------- */
function anunciar(texto){if(live)live.textContent=texto}

function desenhar(anunciarMudanca){
  var base=montarLinhas(R.grupos,R.semNovidade||[],R.janelaDias===null),cont=contarSituacoes(base);
  if(!R.acompanhados&&!base.length){corpo.innerHTML=semProcessos();return}
  var filtrados=filtrarPorSituacao(base,S.situacao);
  var ordenados=ordenarGrupos(filtrados,S.ordem);
  var pg=paginar(ordenados.length,S.pagina,S.porPagina);
  S.pagina=pg.pagina;
  var h=filtros(cont)+resumo(base.length,filtrados.length)+avisoDeOcultas();
  if(!base.length)h+=semBase();
  else if(!filtrados.length)h+=semResultado(base.length);
  else{
    h+=avisoDeAnteriores(filtrados);
    h+='<div class="nvt-wrap"><table class="nvt-tabela" role="table"><caption class="nvt-sr">Processos acompanhados e a atualização mais recente de cada um</caption>'+
      cabecalho()+'<tbody>'+ordenados.slice(pg.inicio,pg.fim).map(linha).join('')+'</tbody></table></div>'+rodape(pg);
  }
  corpo.innerHTML=h;
  if(anunciarMudanca&&filtrados.length)
    anunciar('Mostrando '+pg.de+' a '+pg.ate+' de '+pg.total+(pg.total===1?' processo':' processos'));
  else if(anunciarMudanca)anunciar('Nenhum processo com este filtro');
  devolverFoco();
}

/* Cada redesenho troca o HTML; sem isto o foco do teclado cairia no <body> a cada clique. */
var VIZINHO={'pag-primeira':'pag-proxima','pag-anterior':'pag-proxima','pag-ultima':'pag-anterior','pag-proxima':'pag-anterior'};
function devolverFoco(){
  var f=S.foco;S.foco='';
  if(!f)return;
  var alvo=corpo.querySelector('[data-foco="'+f+'"]');
  if((!alvo||alvo.disabled)&&VIZINHO[f])alvo=corpo.querySelector('[data-foco="'+VIZINHO[f]+'"]');
  if(alvo&&!alvo.disabled)alvo.focus();
}

/* ---------- copiar ---------- */
function copiarTexto(txt,ok,falha){
  function reserva(){
    try{
      var t=document.createElement('textarea');
      t.value=txt;t.setAttribute('readonly','');t.style.position='fixed';t.style.opacity='0';
      document.body.appendChild(t);t.select();
      var feito=document.execCommand('copy');
      document.body.removeChild(t);
      if(feito)ok();else falha();
    }catch(e){falha()}
  }
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt).then(ok,reserva);
  else reserva();
}
function copiar(btn,num){
  var m=pv().mascara(num);
  copiarTexto(m,function(){
    anunciar('Número '+m+' copiado.');
    var s=document.createElement('span');
    s.className='nvt-copiado';s.setAttribute('aria-hidden','true');s.textContent='Copiado';
    btn.parentNode.appendChild(s);
    setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s)},1800);
  },function(){anunciar('Não foi possível copiar. Selecione o número e copie com o teclado.')});
}

/* ---------- eventos (um só ouvinte, na raiz: o HTML interno é trocado a cada desenho) ---------- */
function aoClicar(ev){
  var el=ev.target.closest?ev.target.closest('[data-acao]'):null;
  if(!el||!corpo.contains(el))return;
  var acao=el.getAttribute('data-acao'),num=el.getAttribute('data-num');
  if(acao==='abrir'){ev.preventDefault();pv().abrir(num);return}
  if(acao==='pasta'){
    /* A Pasta abre depois que a tela do processo desenha o cartão das peças. */
    if(window.__pvPasta&&window.__pvPasta.pedirAbertura)window.__pvPasta.pedirAbertura(num);
    pv().abrir(num);return;
  }
  if(acao==='copiar'){copiar(el,num);return}
  if(acao==='buscar'){window.__processovivo_ir('buscar');return}
  if(acao==='processos'){window.__processovivo_ir('processos');return}
  if(acao==='periodo'){
    S.pagina=1;S.foco=el.getAttribute('data-foco')||'';
    O.aoMudar({janela:el.getAttribute('data-janela')});return;
  }
  S.foco=el.getAttribute('data-foco')||'';
  if(acao==='situacao'){S.situacao=el.getAttribute('data-sit');S.pagina=1;desenhar(true);return}
  if(acao==='limpar'){
    S.situacao='todas';S.pagina=1;
    if(O.tribunal){S.foco='trib';O.aoMudar({tribunal:''});return}
    desenhar(true);return;
  }
  if(acao==='ord'){S.ordem=proximaOrdem(S.ordem,el.getAttribute('data-chave'));S.pagina=1;desenhar(true);return}
  if(acao==='pagina'){
    var tot=Math.ceil(filtrarPorSituacao(montarLinhas(R.grupos,R.semNovidade||[],R.janelaDias===null),S.situacao).length/S.porPagina)||1;
    var v=el.getAttribute('data-vai');
    S.pagina=v==='primeira'?1:v==='anterior'?S.pagina-1:v==='proxima'?S.pagina+1:tot;
    desenhar(true);
  }
}
function aoMudar(ev){
  var el=ev.target,sel=el.getAttribute?el.getAttribute('data-sel'):null;
  if(!sel)return;
  S.foco=el.getAttribute('data-foco')||'';
  if(sel==='tribunal'){S.pagina=1;O.aoMudar({tribunal:el.value});return}
  if(sel==='porpagina'){S.porPagina=Number(el.value)||25;S.pagina=1;desenhar(true);return}
  if(sel==='ordenar'){
    var p=el.value.split(':');
    S.ordem=p[0]?{chave:p[0],direcao:p[1]}:null;S.pagina=1;desenhar(true);
  }
}

/* A tela inteira. opc: { tribunais, tribunal, aoMudar({janela?, tribunal?}) }.
   O estado dos filtros (S) sobrevive ao recarregamento do período e do tribunal. */
function montar(alvo,r,opc){
  R=r;O=opc;
  alvo.innerHTML='<section class="nvt" aria-label="Últimas atualizações"><div id="nvt-corpo"></div>'+
    '<div class="nvt-sr" id="nvt-live" role="status" aria-live="polite" aria-atomic="true"></div></section>';
  corpo=alvo.querySelector('#nvt-corpo');live=alvo.querySelector('#nvt-live');
  corpo.addEventListener('click',aoClicar);
  corpo.addEventListener('change',aoMudar);
  desenhar(false);
}

/* Esqueleto discreto enquanto o servidor responde. */
function esqueleto(){
  var l='';
  for(var i=0;i<6;i++)l+='<div class="nvt-esq-linha"><span></span><span></span><span></span></div>';
  return '<div class="nvt-esq" role="status" aria-busy="true"><span class="nvt-sr">Carregando as atualizações…</span>'+l+'</div>';
}

window.__pvAtualizacoes={montar:montar,esqueleto:esqueleto};
})();
`;

export const ESTILOS_ATUALIZACOES = ESTILOS_TABELA_ATUALIZACOES;
