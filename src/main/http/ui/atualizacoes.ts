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
 *   nível da página ("as anteriores estão no processo: clique no número"), só quando algum
 *   processo tem mais de uma atualização no período;
 * - quem esconde linha diz quantas escondeu: "mostrando X de Y processos" e "N
 *   atualizações mais antigas não mostradas", sempre com a saída ao lado;
 * - triagem ordena, nunca esconde: `exigeAcao` só MARCA. O filtro "Pedem
 *   providência" é escolha explícita da pessoa e usa a regra do servidor
 *   (`estadoDaPasta`, janela única);
 * - nada aqui afirma prazo. Partes e classe vêm do retrato do acompanhamento;
 *   vazio é "—", nunca dedução;
 * - a busca pelo NÚMERO do processo (v0.41.0) respeita Período, Situação e Tribunal e diz quantos
 *   casam FORA deles, um motivo por frase, cada um com o "Ver" (CLAUDE.md §8). O campo mora FORA da
 *   área redesenhada (`#nvt-barra` e `#nvt-corpo`), então digitar nunca perde foco nem cursor;
 * - o estado dos filtros vive na página (variável do módulo), nunca em
 *   localStorage: recarregar a página volta ao padrão.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao
 * tsc; `tests/http/console-script.spec.ts` roda o ESLint aqui dentro. Todo
 * texto vindo do servidor passa por `esc()`.
 */
import { descricaoDoAto } from '../../../domain/entities/descricaoDoAto.js';
import { nomeDaClasse } from '../../../domain/entities/nomeDaClasse.js';
import {
  SITUACAO_PADRAO,
  atoExibido,
  chaveDoAtoDaLinha,
  detectadoDistanteDoAto,
  diaMesBrasilia,
  contarSaidasDaProvidencia,
  frasesDeSaidas,
  seloDoTipo,
  contarSemLeitura,
  contarSituacoes,
  situacaoDaLinha,
  montarLinhas,
  filtrarPorSituacao,
  filtrarPorNumero,
  contarForaDosFiltros,
  ordenarGrupos,
  paginar,
  proximaOrdem,
  textoDePartes,
  textoDeProvidencia,
} from './tabelaAtualizacoes.js';
import { ESTILOS_TABELA_ATUALIZACOES } from './estilosAtualizacoes.js';

export const SCRIPT_ATUALIZACOES = String.raw`
(function(){
var pv=function(){return window.__pv};
/* As MESMAS funções que os testes exercitam (ui/tabelaAtualizacoes.ts), injetadas como texto. */
var contarSituacoes=${contarSituacoes.toString()};
var montarLinhas=${montarLinhas.toString()};
var filtrarPorSituacao=${filtrarPorSituacao.toString()};
var filtrarPorNumero=${filtrarPorNumero.toString()};
var contarForaDosFiltros=${contarForaDosFiltros.toString()};
var proximaOrdem=${proximaOrdem.toString()};
var ordenarGrupos=${ordenarGrupos.toString()};
var paginar=${paginar.toString()};
var descricaoDoAto=${descricaoDoAto.toString()};
var nomeDaClasse=${nomeDaClasse.toString()};
var textoDePartes=${textoDePartes.toString()};
var textoDeProvidencia=${textoDeProvidencia.toString()};
var contarSemLeitura=${contarSemLeitura.toString()};
var atoExibido=${atoExibido.toString()};
var chaveDoAtoDaLinha=${chaveDoAtoDaLinha.toString()};
var detectadoDistanteDoAto=${detectadoDistanteDoAto.toString()};
var diaMesBrasilia=${diaMesBrasilia.toString()};
var contarSaidasDaProvidencia=${contarSaidasDaProvidencia.toString()};
var frasesDeSaidas=${frasesDeSaidas.toString()};
var seloDoTipo=${seloDoTipo.toString()};
var situacaoDaLinha=${situacaoDaLinha.toString()};

/* Só a escolha da sessão: some quando a página recarrega e a aba volta a abrir em
   "Pedem providência" (v0.37.4). */
var S={situacao:${JSON.stringify(SITUACAO_PADRAO)},ordem:null,porPagina:25,pagina:1,termo:'',foco:'',aviso:'',ocupado:{}};
var R=null,O=null,raiz=null,corpo=null,barra=null,live=null,filtrosEl=null,avisoEl=null,entrada=null,limparBusca=null,espera=null;
/* O aviso "Marcado como cumprido. Desfazer" some sozinho; o tempo é uma constante, nunca um sleep dos testes. */
var TEMPO_DO_AVISO_MS=6000;
var T={num:'',timer:null};
var ESPERA_BUSCA_MS=200;

var SITUACOES=[['todas','Todas'],['naoLidas','Não lidas'],['providencia','Pedem providência']];
var NOMES_ORDEM={processo:'Processo',tribunal:'Tribunal',dataAto:'Data do ato',detectado:'Detectado'};
/* Rótulo do cabeçalho quando o nome inteiro não cabe numa linha (v0.49.2); o nome completo fica no aria-label e no title. */
var NOMES_CURTOS={dataAto:'Data'};

function svg(d){return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+d+'</svg>'}
var ICO_COPIAR=svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
var ICO_ABRIR=svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>');
var ICO_PASTA=svg('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>');
var ICO_PRIMEIRA=svg('<path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/>');
var ICO_ANTERIOR=svg('<path d="m15 18-6-6 6-6"/>');
var ICO_PROXIMA=svg('<path d="m9 18 6-6-6-6"/>');
var ICO_ULTIMA=svg('<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>');

function esc(s){return pv().esc(s)}
function prov(){return window.__pvProvidencia}
function ia(){return window.__pvAnaliseIA}
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

/* A célula Atualização é UMA linha de ato (v0.46.0, decisão do dono): tipo, etiqueta e selos. O texto
   do ato NÃO aparece na tabela — continua guardado e é lido na tela do processo, na Pasta e na análise por IA.
   v0.49.4 (decisão do dono): na TABELA (>= 1024 px) o "Abrir processo" não existe — o número do processo já é um link e o
   ícone "abrir" de Ações continua. O botão segue no DOM só para os CARTÕES (< 1024 px), onde não há dica e sobra espaço;
   display:none na tabela o tira da tela, da ordem de Tab e da leitura por leitor de tela (não fica "escondido" a
   quem enxerga, mas aparece para quem lê). */
function linkAbrir(n){
  return '<span class="nvt-abrir"><button type="button" class="lnh nov-abrir" data-acao="abrir" data-num="'+esc(n.numero)+
    '" data-foco="abrir-ato-'+esc(n.numero)+'" aria-label="Abrir o processo '+esc(pv().mascara(n.numero))+'">Abrir processo</button></span>';
}

/* ---------- a linha do processo ---------- */
/* Ícone da fileira com a MESMA dica da caixa "Cumprido" (__pvProvidencia.comDica, v0.49.2): nome acessível no
   aria-label, texto da dica ligado por aria-describedby; nada de title (a dica o substitui). */
function icone(classe,acao,g,foco,nome,dica,ico,texto){
  var n=esc(digitos(g.numero));
  return prov().comDica('<button type="button" class="nvt-ic'+classe+'" data-acao="'+acao+'" data-num="'+esc(g.numero)+'" data-foco="'+foco+esc(g.numero)+
    '" aria-label="'+nome+'" aria-describedby="dica-'+acao+'-'+n+'">'+ico+'<span class="nvt-ic-t">'+texto+'</span></button>','dica-'+acao+'-'+n,dica);
}

function celulaProcesso(g){
  var m=pv().mascara(g.numero);
  return '<td class="c-proc" data-rotulo="Processo"><div class="nvt-proc">'+
    '<a class="nvt-num" href="/?processo='+esc(digitos(g.numero))+'" data-acao="abrir" data-num="'+esc(g.numero)+'">'+esc(m)+'</a>'+
    icone(' nvt-copiar','copiar',g,'copiar-','Copiar o número do processo '+esc(m),'Copiar número',ICO_COPIAR,'Copiar número')+'</div></td>';
}

function celulaPartes(g){
  var txt=textoDePartes(g.processo?g.processo.partes:null);
  if(!txt)return '<td class="c-partes" data-rotulo="Partes"><span class="nvt-vazio" title="A fonte não informou as partes">—</span></td>';
  return '<td class="c-partes" data-rotulo="Partes"><span class="nvt-partes" title="'+esc(txt)+'">'+esc(txt)+'</span></td>';
}

/* Selo "Intimação"/"Citação" ao lado do rótulo do ato (v0.37.6): vem da comunicação do Diário que gera
   a providência. Destinatário não confirmado diz isso no title; "dirigida a outro" é aviso à parte. */
function seloDoAto(a){
  var t=seloDoTipo(a.tipo);
  if(!t)return '';
  return ' <span class="selo int" title="'+esc('Comunicação publicada no Diário Eletrônico (DJEN). '+
    (a.paraOUsuario==='sim'?'Destinatário confirmado: uma das suas inscrições na OAB. ':'Destinatário não confirmado. ')+
    'Leitura automática; confira no ato completo.')+'">'+esc(t)+'</span>';
}

/* Quando o último andamento é outro ato, ele vai numa segunda linha. A linha diz o ato que gera a
   providência; nada aqui afirma prazo (rótulo e data, nunca o texto). */
function linhaUltimoAndamento(a){
  if(!a.ultimoAndamento)return '';
  var enxuto=descricaoDoAto(a.ultimoAndamento.rotulo);
  return '<div class="nvt-ult"'+(enxuto!==a.ultimoAndamento.rotulo?' title="'+esc(a.ultimoAndamento.rotulo)+'"':'')+
    '>Último andamento: <strong>'+esc(enxuto)+'</strong> · <time datetime="'+esc(a.ultimoAndamento.data)+'">'+esc(pv().dt(a.ultimoAndamento.data))+'</time></div>';
}

/* Processo acompanhado SEM novidade registrada (v0.37.3): a última movimentação do retrato,
   com a mesma regra de descrição e de trecho. Não é "atualização detectada" e a célula diz isso.
   Segredo de justiça: rótulo e data, nunca o texto do ato. Se o processo pede providência, a linha
   mostra o ato que a gera e a última movimentação vai na segunda linha. */
function celulaSemNovidade(g){
  var n=g.maisRecente;
  var h='<td class="c-atu" data-rotulo="Atualização">';
  if(!n.data){
    return h+'<div class="nvt-tit nvt-vazio">Nenhuma movimentação conhecida</div></td>';
  }
  var a=atoExibido(g);
  var enxuto=descricaoDoAto(a.rotulo);
  /* v0.49.2: uma linha só — o ato, o link e o aviso discreto "sem atualização detectada" (mesmo texto de antes) —, que
     só desce quando falta largura; o aviso deixou de ter linha própria acima do ato. O texto visível é "Sem atualização
     detectada" nos dois casos; "Última movimentação conhecida" (quando o ato da linha é só o último andamento) vai no
     title e em texto para leitor de tela, para o aviso caber numa linha. */
  h+='<div class="nvt-ato"><span class="nvt-tit" title="'+esc(a.rotulo)+'"><span class="nvt-tipo">'+esc(enxuto)+'</span>'+seloDoAto(a)+'</span>'+
    selosDaLinha(g)+(a.daProvidencia?'<span class="nvt-sem" title="Sem atualização detectada">Sem atualização detectada</span>':
      '<span class="nvt-sem" title="Última movimentação conhecida: o acompanhamento ainda não detectou atualização neste processo."><span class="nvt-sr">Última movimentação conhecida · </span>Sem atualização detectada</span>')+
    linkAbrir(n)+'</div>';
  if(g.segredoJustica)
    h+='<div class="nota nvt-sem"><span class="selo al">segredo de justiça</span> O texto do ato não é exibido aqui.</div>';
  return h+linhaUltimoAndamento(a)+'</td>';
}

function celulaAtualizacao(g){
  var n=g.maisRecente;
  var a=atoExibido(g);
  /* Só a exibição perde a repetição do tipo; o original fica no title. */
  var enxuto=descricaoDoAto(a.rotulo);
  return '<td class="c-atu" data-rotulo="Atualização"><div class="nvt-ato"><span class="nvt-tit'+(n.vista?'':' nl')+'" title="'+esc(a.rotulo)+'"><span class="nvt-tipo">'+esc(enxuto)+'</span>'+seloDoAto(a)+'</span>'+
    selosDaLinha(g)+linkAbrir(n)+'</div>'+linhaUltimoAndamento(a)+'</td>';
}

/* Os selos de OUTRA informação (v0.46.1): "Não lida" e "sem marca há mais de N dias" moravam na célula da coluna
   "Cumprido", que deixou de existir; passam para o fim da célula Atualização, sem mudar de texto nem de regra.
   O selo "Intimação a outro destinatário" saiu da linha (decisão do dono): o filtro continua, e quem o explica é a
   frase "N com intimação a outro destinatário · Ver" acima da tabela e o resumo da lista aberta pelo "Ver". */
function selosDaLinha(g){
  var P=g.processo&&g.processo.providencia?g.processo.providencia:null;
  var s='';
  if(g.naoVistas>0)s+='<span class="selo nv" title="'+esc(g.naoVistas+(g.naoVistas>1?' atualizações ainda não lidas neste processo':' atualização ainda não lida neste processo'))+'">'+
    (g.naoVistas>1?g.naoVistas+' não lidas':'Não lida')+'</span>';
  if(P&&P.situacao==='venceu'&&situacaoDaLinha(g).estado==='nenhuma'){
    s+='<span class="selo neutro nvt-venceu" title="Esta comunicação do Diário passou da janela de leitura automática sem você marcar como cumprida. Confira no processo.">sem marca há mais de '+R.pendenciaIntimacaoJanelaDias+' dias</span>';
  }
  return s?'<span class="nvt-selos">'+s+'</span>':'';
}

function celulaAcoes(g){
  var m=pv().mascara(g.numero);
  /* A caixa "Cumprido" é o PRIMEIRO controle (v0.46.1): tudo o que diz respeito a ela mora em __pvProvidencia. Desde a
     v0.49.2 a fileira é uma só e o "Analisar com IA" é o quarto ícone (antes um botão de texto na linha de baixo). */
  return '<td class="c-acoes" data-rotulo="Ações"><div class="nvt-acoes">'+
    prov().celula(situacaoDaLinha(g),g.numero,m,'cumprir-'+g.numero)+
    icone('','abrir',g,'abrir-','Abrir o processo '+esc(m),'Abrir o processo',ICO_ABRIR,'Abrir')+
    icone('','pasta',g,'pasta-','Abrir a pasta digital do processo '+esc(m),'Abrir a pasta do processo',ICO_PASTA,'Pasta')+
    ia().botao(g.numero,chaveDoAtoDaLinha(g))+'</div></td>';
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

function celulaData(g){
  var a=atoExibido(g);
  if(!a.data)return '<td class="c-data" data-rotulo="Data do ato"><span class="nvt-vazio" title="Nenhuma movimentação conhecida">—</span></td>';
  return '<td class="c-data" data-rotulo="Data do ato"><time datetime="'+esc(a.data)+'" title="'+esc(pv().dth(a.data))+'">'+esc(pv().dt(a.data))+'</time></td>';
}
/* "Detectado" (v0.37.6): quando a detecção está a mais de 7 dias da data do ato, o "há 2 dias" sozinho
   passa por ato novo; a coluna mostra a data absoluta e o title explica as duas datas. A ordenação e a
   regra de detectadaEm não mudam. */
function celulaDetectado(g){
  var n=g.maisRecente,a=atoExibido(g);
  if(!n.detectadaEm)
    return '<td class="c-det" data-rotulo="Detectado"><span title="Sem detecção registrada: o acompanhamento ainda não percebeu nenhuma movimentação nova neste processo.">'+
      '<span aria-hidden="true">—</span><span class="nvt-sr">sem detecção registrada</span></span></td>';
  var distante=detectadoDistanteDoAto(a.data,n.detectadaEm);
  var explica='Data do ato é a do tribunal; detectado é quando o Processo Vivo viu pela primeira vez.';
  /* A detecção é da atualização da linha: se a linha mostra outro ato (o da providência), o title diz. */
  var deOutro=a.daProvidencia&&!a.igualAAtualizacao?' A detecção refere-se ao último andamento, não ao ato que pede providência.':'';
  var curto=distante?'em '+diaMesBrasilia(n.detectadaEm):detectadoCurto(n.detectadaEm);
  var cheio=distante?'detectado em '+diaMesBrasilia(n.detectadaEm):detectadoHa(n.detectadaEm);
  return '<td class="c-det" data-rotulo="Detectado"><span title="'+esc(cheio+' ('+pv().dth(n.detectadaEm)+'). '+explica+deOutro)+'">'+
    '<span aria-hidden="true">'+esc(curto)+'</span><span class="nvt-sr">'+esc(cheio)+'</span></span></td>';
}

function linha(g){
  var classe=classeDaLinha(g);
  var h='<tr class="nvt-linha'+(g.semNovidade?' nvt-sem-nov':'')+(situacaoDaLinha(g).estado==='cumprido'?' nvt-cumprida':'')+'" role="row" data-processo="'+esc(g.numero)+'">'+
    celulaProcesso(g)+celulaPartes(g)+(g.semNovidade?celulaSemNovidade(g):celulaAtualizacao(g))+
    '<td class="c-trib" data-rotulo="Tribunal">'+esc(g.processo&&g.processo.tribunal?g.processo.tribunal:'—')+classe.mini+'</td>'+
    '<td class="c-classe" data-rotulo="Classe">'+classe.cheia+'</td>'+
    celulaData(g)+celulaDetectado(g)+
    celulaAcoes(g)+'</tr>'+ia().painel(g.numero);
  return h;
}

/* ---------- cabeçalho, filtros e rodapé ---------- */
function cabecalhoOrdenavel(chave){
  var o=S.ordem&&S.ordem.chave===chave?S.ordem:null;
  var seta=o?(o.direcao==='asc'?'↑':'↓'):'↕';
  return '<th scope="col" class="h-'+chave+'" aria-sort="'+(o?(o.direcao==='asc'?'ascending':'descending'):'none')+'">'+
    '<button type="button" class="nvt-ord" data-acao="ord" data-chave="'+chave+'" data-foco="ord-'+chave+'" aria-label="'+NOMES_ORDEM[chave]+'" title="'+NOMES_ORDEM[chave]+'">'+
    (NOMES_CURTOS[chave]||NOMES_ORDEM[chave])+' <span class="nvt-seta" aria-hidden="true">'+seta+'</span></button></th>';
}

function cabecalho(){
  return '<thead><tr role="row">'+cabecalhoOrdenavel('processo')+
    '<th scope="col" class="h-partes">Partes</th><th scope="col" class="h-atu">Atualização</th>'+
    cabecalhoOrdenavel('tribunal')+'<th scope="col" class="h-classe">Classe</th>'+
    cabecalhoOrdenavel('dataAto')+cabecalhoOrdenavel('detectado')+
    '<th scope="col" class="h-acoes" title="A caixa Cumprido aparece onde há providência, por leitura automática do texto do andamento. Confira no ato completo.">Ações</th></tr></thead>';
}

function filtros(cont){
  var todas=R.janelaDias===null;
  var h=''+
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
  /* (v0.46.1, decisão do dono) A frase fixa de aviso sob o chip saiu daqui;
     "leitura automática… confira no ato completo" segue no title do chip, no do cabeçalho Ações e no da etiqueta. */
  h+='</div></div>'+
    '<div class="nvt-bloco"><label class="nvt-rot" for="nvt-trib">Tribunal</label>'+
    '<select id="nvt-trib" data-sel="tribunal" data-foco="trib"><option value="">Todos os tribunais</option>'+
    (O.tribunais||[]).map(function(t){return '<option value="'+esc(t)+'"'+(O.tribunal===t?' selected':'')+'>'+esc(t)+'</option>'}).join('')+'</select></div>'+
    '<div class="nvt-bloco nvt-so-pequeno"><label class="nvt-rot" for="nvt-ordenar">Ordenar por</label>'+
    '<select id="nvt-ordenar" data-sel="ordenar" data-foco="ordenar"><option value="">Ordem padrão</option>'+
    ['dataAto:desc','dataAto:asc','detectado:desc','detectado:asc','processo:asc','processo:desc','tribunal:asc','tribunal:desc'].map(function(v){
      var p=v.split(':'),on=S.ordem&&S.ordem.chave===p[0]&&S.ordem.direcao===p[1];
      var d=(p[0]==='dataAto'||p[0]==='detectado')?(p[1]==='desc'?'mais recente primeiro':'mais antiga primeiro'):(p[1]==='asc'?'A–Z':'Z–A');
      return '<option value="'+v+'"'+(on?' selected':'')+'>'+NOMES_ORDEM[p[0]]+' ('+d+')</option>'}).join('')+'</select></div>';
  return h;
}

/* O que o filtro de providência deixou de fora, dito em voz alta (v0.37.5): os marcados como
   cumpridos (com o "Ver") e as intimações que passaram da janela sem marca. Nada some calado. */
function saidasDaProvidencia(base){
  var c=contarSaidasDaProvidencia(base),f=frasesDeSaidas(c.cumpridos,c.vencidos,R.pendenciaIntimacaoJanelaDias,c.outros),h='';
  if(f.cumpridos)h+=' · '+esc(f.cumpridos)+' · <button type="button" class="nov-btn" data-acao="situacao" data-sit="cumpridos" data-foco="ver-cumpridos">Ver</button>';
  if(f.vencidos)h+=' · '+esc(f.vencidos);
  if(f.outros)h+=' · '+esc(f.outros)+' · <button type="button" class="nov-btn" data-acao="situacao" data-sit="outros" data-foco="ver-outros" title="Processos cuja intimação do Diário foi dirigida a outro destinatário. Não contam em Pedem providência; se for de um colega do escritório, confira no processo.">Ver</button>';
  return h;
}

function resumo(base,filtrados,linhasBase){
  var onde=O.tribunal?' em '+esc(O.tribunal):'';
  var h='<div class="nvt-resumo" data-foco="resumo">';
  if(S.situacao==='cumpridos'){
    h+='Mostrando <strong>'+filtrados+'</strong> '+(filtrados===1?'processo marcado como cumprido':'processos marcados como cumpridos')+onde+
      '. <button type="button" class="nov-btn" data-acao="situacao" data-sit="providencia" data-foco="voltar-prov">Voltar aos que pedem providência</button>';
    return h+'</div>';
  }
  if(S.situacao==='outros'){
    h+='Mostrando <strong>'+filtrados+'</strong> '+(filtrados===1?'processo com intimação a outro destinatário':'processos com intimação a outro destinatário')+onde+
      '. Eles não entram em "Pedem providência" por causa dessa intimação; se for de um colega do escritório, confira no processo. '+
      '<button type="button" class="nov-btn" data-acao="situacao" data-sit="providencia" data-foco="voltar-prov">Voltar aos que pedem providência</button>';
    return h+'</div>';
  }
  if(S.situacao==='providencia'){
    /* Pedem providência (padrão da aba, v0.37.4): a frase fica sempre à vista e "Ver todos" é a saída. */
    var t=textoDeProvidencia(filtrados,base,(O.tribunal?' em '+O.tribunal:'')+
      (R.janelaDias===null?'':' com atualização detectada nos últimos '+R.janelaPadraoDias+' dias'));
    /* O bloco "Nenhum processo pede providência" já diz tudo e traz o "Ver todos". */
    if(t.modo==='vazio')return '';
    h+=esc(t.frase)+(t.verTodos?' · <button type="button" class="nov-btn" data-acao="situacao" data-sit="todas" data-foco="sit-todas">Ver todos</button>':'')+saidasDaProvidencia(linhasBase);
  }else if(S.situacao!=='todas'){
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
  return "<div class='nota nov-ant'>Cada processo mostra a atualização mais recente. As anteriores estão no processo: clique no número.</div>";
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

/* ---------- busca pelo número (v0.41.0) ---------- */
/* Uma frase por motivo, só quando o número é maior que zero. O "Ver" tira esse motivo e MANTÉM a busca. */
function frasesDaBusca(b){
  var f=[];
  if(b.situacao>0)f.push({txt:b.situacao+(b.situacao===1?' processo com esse número em outra situação':' processos com esse número em outra situação'),acao:'busca-situacao',foco:'busca-sit'});
  if(b.periodo>0)f.push({txt:b.periodo+' fora dos últimos '+R.janelaPadraoDias+' dias',acao:'periodo',janela:'todas',foco:'busca-per'});
  if(b.tribunal>0)f.push({txt:b.tribunal+' em outro tribunal',acao:'busca-tribunal',foco:'busca-trib'});
  return f;
}
function htmlDasFrases(fr){
  return fr.map(function(x){
    return esc(x.txt)+' · <button type="button" class="nov-btn" data-acao="'+x.acao+'"'+(x.janela?' data-janela="'+x.janela+'"':'')+' data-foco="'+x.foco+'">Ver</button>';
  }).join(' · ');
}
function textoDasFrases(fr){return fr.map(function(x){return x.txt}).join('. ')}

/* Acima da tabela, quando há resultado: quantos casam e o que ficou fora dos filtros. */
function avisoDaBusca(achados,b){
  var fr=frasesDaBusca(b);
  return '<div class="nota nvt-busca-aviso" data-foco="busca-aviso"><strong>'+achados+'</strong> '+(achados===1?'processo encontrado':'processos encontrados')+
    (fr.length?' · '+htmlDasFrases(fr):'')+'</div>';
}
/* Nada casa nos filtros atuais. Com casamento fora, as frases ocupam o lugar do vazio, e nunca se diz
   que "não há processo"; sem casamento em lugar nenhum, a frase própria e nenhum "Ver". */
function semBusca(b){
  var fr=frasesDaBusca(b);
  if(!fr.length)return '<div class="nvt-sem-prov nvt-busca-aviso" role="status" data-foco="busca-aviso"><strong>Nenhum processo acompanhado com esse número.</strong></div>';
  return '<div class="nvt-sem-prov nvt-busca-aviso" role="status" data-foco="busca-aviso"><strong>Sem resultado nos filtros atuais.</strong><p>'+htmlDasFrases(fr)+'</p></div>';
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

/* Nenhum pede providência: sem tabela vazia. O bloco só nasce com conteúdo (há processos
   acompanhados) e não alarma. */
function semProvidencia(linhasBase){
  var base=linhasBase.length;
  return '<div class="nvt-sem-prov" role="status" data-foco="resumo"><strong>Nenhum processo pede providência agora.</strong>'+
    '<p>'+base+(base===1?' processo acompanhado':' processos acompanhados')+
    ' · <button type="button" class="nov-btn" data-acao="situacao" data-sit="todas" data-foco="sit-todas">Ver todos</button>'+saidasDaProvidencia(linhasBase)+'</p></div>';
}

/* O "Ver" abriu a lista dos marcados e não sobrou nenhum (outro tribunal, ou todos desfeitos). */
function semCumpridos(){
  return '<div class="nvt-sem-prov" role="status" data-foco="resumo"><strong>Nenhum processo marcado como cumprido.</strong>'+
    '<p><button type="button" class="nov-btn" data-acao="situacao" data-sit="providencia" data-foco="voltar-prov">Voltar aos que pedem providência</button></p></div>';
}

function semOutros(){
  return '<div class="nvt-sem-prov" role="status" data-foco="resumo"><strong>Nenhum processo com intimação a outro destinatário.</strong>'+
    '<p><button type="button" class="nov-btn" data-acao="situacao" data-sit="providencia" data-foco="voltar-prov">Voltar aos que pedem providência</button></p></div>';
}

/* Quem não tem movimentação conhecida não pode ser lido: o filtro não o conta, e a tela diz. */
function avisoSemLeitura(baseLinhas){
  var n=contarSemLeitura(baseLinhas);
  if(!n)return '';
  return '<div class="nota nvt-sem-leitura">'+n+(n>1?' processos sem movimentação conhecida não puderam ser lidos':' processo sem movimentação conhecida não pôde ser lido')+
    (n>1?' e não aparecem':' e não aparece')+' neste filtro · <button type="button" class="nov-btn" data-acao="situacao" data-sit="todas" data-foco="sit-todas">Ver todos</button></div>';
}

/* ---------- desenho ---------- */
function anunciar(texto){if(live)live.textContent=texto}

/* A lista da tela, na ordem em que as regras se aplicam: Situação, depois a busca, depois a ordenação. */
function listaDaTela(base){
  return ordenarGrupos(filtrarPorNumero(filtrarPorSituacao(base,S.situacao),S.termo),S.ordem);
}
function ligarFiltros(sim){
  if(sim&&!filtrosEl.parentNode)raiz.insertBefore(filtrosEl,avisoEl);
  if(!sim&&filtrosEl.parentNode)filtrosEl.parentNode.removeChild(filtrosEl);
}

function desenhar(anunciarMudanca){
  var base=montarLinhas(R.grupos,R.semNovidade||[],R.janelaDias===null),cont=contarSituacoes(base);
  if(!R.acompanhados&&!base.length){ligarFiltros(false);barra.innerHTML='';corpo.innerHTML=semProcessos();return}
  ligarFiltros(true);
  var porSituacao=filtrarPorSituacao(base,S.situacao);
  var filtrados=filtrarPorNumero(porSituacao,S.termo);
  var ordenados=ordenarGrupos(filtrados,S.ordem);
  var busca=contarForaDosFiltros(S.termo,base,filtrados,R.numerosForaDaJanela,R.numerosEmOutroTribunal);
  var pg=paginar(ordenados.length,S.pagina,S.porPagina);
  S.pagina=pg.pagina;
  /* O resumo e os avisos de situação falam da Situação; a busca tem a linha dela. */
  barra.innerHTML=filtros(cont);
  var h=(S.aviso?'<div class="nota nvt-erro" role="alert">'+esc(S.aviso)+'</div>':'')+resumo(base.length,porSituacao.length,base)+avisoDeOcultas();
  if(S.situacao==='providencia'&&!busca.valido)h+=avisoSemLeitura(base);
  if(busca.valido&&!filtrados.length)h+=semBusca(busca);
  else if(!base.length)h+=semBase();
  else if(!filtrados.length&&S.situacao==='providencia')h+=semProvidencia(base);
  else if(!filtrados.length&&S.situacao==='cumpridos')h+=semCumpridos();
  else if(!filtrados.length&&S.situacao==='outros')h+=semOutros();
  else if(!filtrados.length)h+=semResultado(base.length);
  else{
    if(busca.valido)h+=avisoDaBusca(filtrados.length,busca);
    h+=avisoDeAnteriores(filtrados);
    h+='<div class="nvt-wrap"><table class="nvt-tabela" role="table"><caption class="nvt-sr">Processos acompanhados e a atualização mais recente de cada um</caption>'+
      cabecalho()+'<tbody>'+ordenados.slice(pg.inicio,pg.fim).map(linha).join('')+'</tbody></table></div>'+rodape(pg);
  }
  corpo.innerHTML=h;
  if(anunciarMudanca==='busca'){
    /* Só depois da espera (quem chama), com o número de processos e o que ficou fora dos filtros. */
    if(!busca.valido)anunciar(filtrados.length?'Busca limpa. Mostrando '+pg.total+(pg.total===1?' processo':' processos'):'Busca limpa');
    else if(filtrados.length)anunciar(filtrados.length+(filtrados.length===1?' processo encontrado':' processos encontrados'));
    else{
      var fr=textoDasFrases(frasesDaBusca(busca));
      anunciar(fr?'Nenhum resultado nos filtros atuais. '+fr:'Nenhum processo acompanhado com esse número');
    }
  }else if(anunciarMudanca&&filtrados.length)
    anunciar('Mostrando '+pg.de+' a '+pg.ate+' de '+pg.total+(pg.total===1?' processo':' processos'));
  else if(anunciarMudanca)anunciar('Nenhum processo com este filtro');
  devolverFoco();
}

/* Cada redesenho troca o HTML; sem isto o foco do teclado cairia no <body> a cada clique. */
var VIZINHO={'pag-primeira':'pag-proxima','pag-anterior':'pag-proxima','pag-ultima':'pag-anterior','pag-proxima':'pag-anterior'};
function devolverFoco(){
  var f=S.foco;S.foco='';
  if(!f)return;
  /* "a|b|c": a primeira que existir. Marcar tira a linha da lista; o foco vai para o vizinho. */
  var cand=f.split('|'),alvo=null;
  for(var i=0;i<cand.length&&!alvo;i++){
    var c=raiz.querySelector('[data-foco="'+cand[i]+'"]');
    if(!c&&VIZINHO[cand[i]])c=raiz.querySelector('[data-foco="'+VIZINHO[cand[i]]+'"]');
    if(c&&!c.disabled)alvo=c;
  }
  if(!alvo)return;
  /* O resumo não é um controle: ganha tabindex só no instante do foco programático e o perde ao sair,
     para não deixar um tabindex negativo escondido na página. */
  var foco=alvo.getAttribute('data-foco');
  if((foco==='resumo'||foco==='busca-aviso')&&!alvo.hasAttribute('tabindex')){
    alvo.setAttribute('tabindex','-1');
    alvo.addEventListener('blur',function(){alvo.removeAttribute('tabindex')},{once:true});
  }
  alvo.focus();
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
    (btn.closest('.nvt-proc')||btn.parentNode).appendChild(s);
    setTimeout(function(){if(s.parentNode)s.parentNode.removeChild(s)},1800);
  },function(){anunciar('Não foi possível copiar. Selecione o número e copie com o teclado.')});
}

/* ---------- marcar como cumprido (v0.37.5) ---------- */
function baseAtual(){return montarLinhas(R.grupos,R.semNovidade||[],R.janelaDias===null)}

/* O processo ao lado, na página como está AGORA: depois de marcar, a linha pode sair da
   lista e o foco do teclado tem de ir para algum lugar coerente. */
function vizinhoDe(num){
  var ord=listaDaTela(baseAtual());
  var pg=paginar(ord.length,S.pagina,S.porPagina),vis=ord.slice(pg.inicio,pg.fim),i=-1;
  for(var k=0;k<vis.length;k++)if(vis[k].numero===num)i=k;
  var v=i<0?null:(vis[i+1]||vis[i-1]);
  return v?v.numero:'';
}

/* O servidor devolve o processo já recalculado: a lista é atualizada sem nova consulta. */
function trocarProcesso(num,info){
  [R.grupos,R.semNovidade||[]].forEach(function(l){
    l.forEach(function(g){if(digitos(g.numero)===digitos(num))g.processo=info});
  });
}

/* O aviso curto depois de marcar: fora da tabela e da área redesenhada, sem prender o foco. */
function fecharAviso(comFoco){
  if(T.timer){clearTimeout(T.timer);T.timer=null}
  var tinhaFoco=avisoEl&&avisoEl.contains(document.activeElement);
  var num=T.num;T.num='';
  if(avisoEl)avisoEl.innerHTML='';
  /* O botão em foco sumiu: o foco vai para a caixa da mesma linha, se ela está na tela, senão para o resumo. */
  if(comFoco&&tinhaFoco&&raiz){S.foco='cumprir-'+num+'|resumo';devolverFoco()}
}
/* Esc fecha o aviso quando o foco está nele; em qualquer outro lugar a tecla não faz nada aqui. */
function aoTeclar(ev){
  if(ev.key==='Escape'&&avisoEl&&avisoEl.contains(document.activeElement))fecharAviso(true);
}
function mostrarAviso(num){
  fecharAviso(false);
  T.num=num;
  avisoEl.innerHTML='<span>Marcado como cumprido.</span> <button type="button" class="nov-btn" data-desfazer="'+esc(num)+'">Desfazer</button>';
  T.timer=setTimeout(function(){T.timer=null;fecharAviso(true)},TEMPO_DO_AVISO_MS);
}

/* Falha: a tela volta ao que os dados dizem (o servidor não mudou nada), e a pessoa vê por quê. A frase é
   a combinada; só o 409 (o ato saiu do retrato) leva também a explicação do servidor, porque "tente de
   novo" sozinho não resolve. */
function textoDaFalha(e){
  var t='Não foi possível salvar. Tente de novo.';
  if(e&&e.status===409&&e.codigo&&e.message)t+=' '+e.message;
  return t;
}
function falhouNaMarca(num,e){
  delete S.ocupado[num];
  S.aviso=textoDaFalha(e);S.foco='cumprir-'+num;desenhar(false);
}

/* A mudança APARECE na linha na hora (estado em texto e caixa); a lista, as contagens e os filtros
   se refazem quando o servidor responde. Se ele falhar, desenhar() de novo devolve a linha ao que os dados dizem. */
function pintarOtimista(caixa,marcar){
  var tr=caixa.closest?caixa.closest('tr'):null;
  prov().pintar(caixa,marcar);
  if(tr)tr.classList.toggle('nvt-cumprida',marcar);
}

function concluir(num,marcar,viz,info){
  delete S.ocupado[num];
  trocarProcesso(num,info);
  /* Desfez o último da lista dos marcados: volta ao filtro de onde veio, sem tela vazia. */
  if(!marcar&&S.situacao==='cumpridos'&&!filtrarPorSituacao(baseAtual(),'cumpridos').length)S.situacao='providencia';
  S.foco='cumprir-'+num+'|cumprir-'+viz+'|abrir-'+viz+'|resumo';
  desenhar(false);
  if(marcar){
    mostrarAviso(num);
    var pedem=contarSituacoes(baseAtual()).pedemProvidencia;
    anunciar(pedem===0?'Nenhum processo pede providência agora.':
      pedem===1?'1 processo ainda pede providência.':pedem+' processos ainda pedem providência.');
  }else{
    anunciar('Desmarcado.');
  }
}

function salvar(num,marcar,chave){
  S.ocupado[num]=true;S.aviso='';
  var viz=vizinhoDe(num);
  var req=marcar?prov().marcar(num,chave):prov().remover(num);
  req.then(function(info){concluir(num,marcar,viz,info)},function(e){falhouNaMarca(num,e)});
}

/* A caixa mudou (clique, Espaço ou o rótulo): marca ou desmarca com as MESMAS chamadas do botão antigo. */
function aoMudarCaixa(el){
  var num=el.getAttribute('data-num'),marcar=el.checked;
  if(S.ocupado[num]){el.checked=!marcar;return}
  fecharAviso(false);
  pintarOtimista(el,marcar);
  salvar(num,marcar,el.getAttribute('data-chave'));
}

/* "Desfazer" do aviso: a mesma chamada de desmarcar, mesmo com a linha fora da lista filtrada. */
function desfazerDoAviso(num){
  if(S.ocupado[num])return;
  fecharAviso(false);
  salvar(num,false,'');
}

/* ---------- eventos (um só ouvinte, na raiz: o HTML interno é trocado a cada desenho) ---------- */
function aoClicar(ev){
  var d=ev.target.closest?ev.target.closest('[data-desfazer]'):null;
  if(d&&avisoEl.contains(d)){desfazerDoAviso(d.getAttribute('data-desfazer'));return}
  var el=ev.target.closest?ev.target.closest('[data-acao]'):null;
  if(!el||!raiz.contains(el))return;
  var acao=el.getAttribute('data-acao'),num=el.getAttribute('data-num');
  if(acao==='ia'||acao.indexOf('ia-')===0){ia().clicar(acao,el);return}
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
  /* Os "Ver" da busca: tiram UM motivo e mantêm o termo. O de período segue pelo ramo acima. */
  if(acao==='busca-situacao'){S.situacao='todas';S.pagina=1;S.foco='busca-aviso';desenhar(true);return}
  if(acao==='busca-tribunal'){S.pagina=1;S.foco='trib';O.aoMudar({tribunal:''});return}
  if(acao==='situacao'){S.situacao=el.getAttribute('data-sit');S.pagina=1;desenhar(true);return}
  if(acao==='limpar'){
    S.situacao='todas';S.pagina=1;
    if(O.tribunal){S.foco='trib';O.aoMudar({tribunal:''});return}
    desenhar(true);return;
  }
  if(acao==='ord'){S.ordem=proximaOrdem(S.ordem,el.getAttribute('data-chave'));S.pagina=1;desenhar(true);return}
  if(acao==='pagina'){
    var tot=Math.ceil(listaDaTela(baseAtual()).length/S.porPagina)||1;
    var v=el.getAttribute('data-vai');
    S.pagina=v==='primeira'?1:v==='anterior'?S.pagina-1:v==='proxima'?S.pagina+1:tot;
    desenhar(true);
  }
}
function aoMudar(ev){
  var el=ev.target;
  if(el.getAttribute&&el.getAttribute('data-cx')==='cumprido'){aoMudarCaixa(el);return}
  var sel=el.getAttribute?el.getAttribute('data-sel'):null;
  if(!sel)return;
  S.foco=el.getAttribute('data-foco')||'';
  if(sel==='tribunal'){S.pagina=1;O.aoMudar({tribunal:el.value});return}
  if(sel==='porpagina'){S.porPagina=Number(el.value)||25;S.pagina=1;desenhar(true);return}
  if(sel==='ordenar'){
    var p=el.value.split(':');
    S.ordem=p[0]?{chave:p[0],direcao:p[1]}:null;S.pagina=1;desenhar(true);
  }
}

/* ---------- busca pelo número: o campo vive FORA da área redesenhada ---------- */
function aplicarTermo(valor,anunciarMudanca){
  S.termo=valor;S.pagina=1;
  desenhar(anunciarMudanca?'busca':false);
}
function mostrarLimpar(){limparBusca.hidden=!entrada.value}
function aoDigitar(){
  mostrarLimpar();
  if(espera)clearTimeout(espera);
  /* Espera curta: o desenho e o anúncio só acontecem quando a pessoa para de digitar. */
  espera=setTimeout(function(){espera=null;aplicarTermo(entrada.value,true)},ESPERA_BUSCA_MS);
}
function limparTermo(){
  if(espera){clearTimeout(espera);espera=null}
  entrada.value='';mostrarLimpar();
  aplicarTermo('',true);
  entrada.focus();
}
function aoTeclarNaBusca(ev){
  if(ev.key==='Escape'&&(entrada.value||S.termo)){ev.preventDefault();limparTermo()}
}

/* A tela inteira. opc: { tribunais, tribunal, aoMudar({janela?, tribunal?}) }.
   O estado dos filtros (S) sobrevive ao recarregamento do período e do tribunal. */
function montar(alvo,r,opc){
  R=r;O=opc;
  if(espera){clearTimeout(espera);espera=null}
  if(T.timer){clearTimeout(T.timer);T.timer=null}
  T.num='';
  alvo.innerHTML='<section class="nvt" aria-label="Últimas atualizações"><div id="nvt-desfazer" class="nvt-desfazer" role="status" aria-live="polite" aria-atomic="true"></div><div id="nvt-corpo"></div>'+
    '<div class="nvt-sr" id="nvt-live" role="status" aria-live="polite" aria-atomic="true"></div></section>';
  raiz=alvo.querySelector('.nvt');
  corpo=alvo.querySelector('#nvt-corpo');avisoEl=alvo.querySelector('#nvt-desfazer');live=alvo.querySelector('#nvt-live');
  /* Os filtros: o bloco da busca é criado UMA vez por montagem e nunca é refeito; só os outros blocos
     (#nvt-barra, display:contents) são redesenhados. Assim digitar não perde foco nem cursor. */
  filtrosEl=document.createElement('div');filtrosEl.className='nvt-filtros';
  filtrosEl.innerHTML='<div class="nvt-bloco nvt-busca"><label class="nvt-rot" for="nvt-busca">Número do processo</label>'+
    '<div class="nvt-busca-campo"><input id="nvt-busca" type="search" inputmode="numeric" autocomplete="off" placeholder="Digite parte do número">'+
    '<button type="button" class="nov-btn nvt-busca-limpar" hidden>Limpar</button></div></div><div id="nvt-barra" class="nvt-barra"></div>';
  barra=filtrosEl.querySelector('#nvt-barra');
  entrada=filtrosEl.querySelector('#nvt-busca');limparBusca=filtrosEl.querySelector('.nvt-busca-limpar');
  entrada.value=S.termo;mostrarLimpar();
  entrada.addEventListener('input',aoDigitar);
  entrada.addEventListener('keydown',aoTeclarNaBusca);
  limparBusca.addEventListener('click',limparTermo);
  raiz.addEventListener('click',aoClicar);
  raiz.addEventListener('change',aoMudar);
  raiz.addEventListener('keydown',aoTeclar);
  prov().ligar(raiz);
  /* IA (v0.38.0): desligada, não há botão. Ligada, a primeira pergunta ao servidor redesenha UMA vez. */
  ia().ligar({redesenhar:function(f){S.foco=f||'';desenhar(false)},anunciar:anunciar});
  if(!ia().habilitada())ia().carregar().then(function(h){if(h&&corpo&&corpo.isConnected)desenhar(false)});
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
