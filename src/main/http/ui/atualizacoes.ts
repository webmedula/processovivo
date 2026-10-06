/**
 * Corpo da aba ATUALIZAÇÕES (v0.32.1): uma linha por processo.
 *
 * Arquivo próprio pela mesma razão do leitor e do calendário: `script.ts` já
 * passa de 2.400 linhas e há teste que impede o arquivo de crescer. O console
 * chama `window.__pvAtualizacoes` e este arquivo usa só `window.__pv`.
 *
 * Regras da tela (CLAUDE.md §8 e especificação v1.0.0, seção 2):
 * - o agrupamento e a janela vêm PRONTOS do servidor (`grupos`, `foraDaJanela`):
 *   a tela não reagrupa nem reclassifica;
 * - nada é descartado: "+N anteriores" expande na própria linha;
 * - quem esconde linha diz quantas escondeu ("N atualizações mais antigas não
 *   mostradas"), com a saída ao lado ("Todas");
 * - triagem ordena, nunca esconde: `exigeAcao` só MARCA — uma atualização
 *   anterior que pede providência avisa no botão "+N anteriores", fechado, e
 *   continua marcada depois de aberto;
 * - nada aqui afirma prazo.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao
 * tsc; `tests/http/console-script.spec.ts` roda o ESLint aqui dentro. Todo
 * texto vindo do servidor passa por `esc()`.
 */
import { trechoDeTexto } from './trechoDeTexto.js';

export const SCRIPT_ATUALIZACOES = String.raw`
(function(){
var pv=function(){return window.__pv};
/* A MESMA função que os testes exercitam (ui/trechoDeTexto.ts), injetada como texto. */
var trechoDeTexto=${trechoDeTexto.toString()};

/* Só o começo do texto do ato; o inteiro está no processo (v0.35.1). As
   reticências ficam fora do texto lido: aria-hidden, para não virar "ponto ponto ponto". */
function notaDoAto(n){
  var p=pv(),t=trechoDeTexto(n.conteudo);
  if(!t.texto)return '';
  return '<div class="nota nov-trecho"><div class="nov-txt">'+p.esc(t.texto)+
    (t.cortado?'<span aria-hidden="true">…</span>':'')+'</div>'+
    (t.cortado?'<button class="lnh nov-abrir" data-abrir="'+p.esc(n.numero)+
      '" aria-label="Abrir o processo para ler o texto completo">Abrir processo</button>':'')+'</div>';
}

function linha(n,ehPrincipal){
  var p=pv(),dm=p.diaMes(n.data);
  return '<div class="nov'+(n.vista?'':' nl')+(ehPrincipal?'':' ant')+'">'+
    '<div class="q" title="'+p.esc(p.dt(n.data))+'"><b>'+p.esc(dm[0])+'</b><span>'+p.esc(dm[1])+'</span></div>'+
    '<div style="min-width:0">'+
    '<div class="t">'+p.esc(n.titulo)+'</div>'+
    notaDoAto(n)+
    (ehPrincipal?'<div class="p" data-abrir="'+p.esc(n.numero)+'">'+p.mascara(n.numero)+'</div>':'')+
    '</div>'+
    '<div class="lado">'+(n.vista?'':'<span class="selo nv">novo</span>')+
    (n.exigeAcao?'<span class="selo am" title="Marcado por leitura automática do texto. Confira no ato completo.">pede providência</span>':'')+
    '<span>'+p.esc(p.humano(n.detectadaEm))+'</span></div></div>';
}

function grupo(g,aberto){
  var p=pv(),n=g.anteriores.length;
  var h='<div class="nov-grupo" data-grupo="'+p.esc(g.numero)+'">'+linha(g.maisRecente,true);
  if(n>0){
    var pede=g.anteriores.some(function(a){return a.exigeAcao});
    h+='<div class="nov-mais"><button class="nov-btn" data-mais="'+p.esc(g.numero)+'" aria-expanded="'+(aberto?'true':'false')+'">'+
      (aberto?'Recolher anteriores':'+'+n+' anterior'+(n>1?'es':''))+'</button>'+
      (!aberto&&pede?'<span class="selo am">há anterior que pede providência</span>':'')+
      '<span class="nota">'+(g.naoVistas>0?g.naoVistas+' não lida'+(g.naoVistas>1?'s':'')+' neste processo':'')+'</span></div>'+
      '<div class="nov-ant'+(aberto?'':' oculto')+'">'+
      g.anteriores.map(function(a){return linha(a,false)}).join('')+'</div>';
  }
  return h+'</div>';
}

/* "Últimos 15 dias | Todas" — a escolha vive na página, como os outros filtros do
   console, e o aviso de quantas ficaram de fora fica ao lado dela, nunca longe. */
function alternancia(r){
  var todas=r.janelaDias===null;
  return '<div class="nov-janela" role="group" aria-label="Período">'+
    '<button class="chip'+(todas?'':' on')+'" data-janela="">Últimos '+r.janelaPadraoDias+' dias</button>'+
    '<button class="chip'+(todas?' on':'')+'" data-janela="todas">Todas</button></div>';
}

function avisoDeOcultas(r){
  if(!(r.foraDaJanela>0))return '';
  return '<div class="nota nov-fora">'+(r.foraDaJanela>1?r.foraDaJanela+' atualizações mais antigas não mostradas':'1 atualização mais antiga não mostrada')+
    ' (fora dos últimos '+r.janelaPadraoDias+' dias). <button class="nov-btn" data-janela="todas">Ver todas</button></div>';
}

/* O HTML das linhas. Quem chama decide o que fazer com lista vazia. */
function corpo(r,abertos){
  abertos=abertos||{};
  return r.grupos.map(function(g){return grupo(g,!!abertos[g.numero])}).join('')+avisoDeOcultas(r);
}

/* Liga expandir/recolher e a janela. aoMudarJanela('' | 'todas') recarrega a aba.
   O estado aberto/fechado de cada linha fica em "abertos" e só a linha tocada é
   redesenhada — religar a lista inteira empilharia dois ouvintes por clique. */
function ligarGrupo(cont,r,abertos){
  var b=cont.querySelector('[data-mais]');
  if(b)b.addEventListener('click',function(){
    var num=b.getAttribute('data-mais');
    var g=r.grupos.filter(function(x){return x.numero===num})[0];
    abertos[num]=!abertos[num];
    var novo=document.createElement('div');
    novo.innerHTML=grupo(g,!!abertos[num]);
    var no=novo.firstChild;
    cont.replaceWith(no);
    ligarGrupo(no,r,abertos);
  });
  cont.querySelectorAll('[data-abrir]').forEach(function(el){
    el.addEventListener('click',function(){pv().abrir(el.getAttribute('data-abrir'))})});
}

function ligar(alvo,r,aoMudarJanela,abertos){
  alvo.querySelectorAll('.nov-grupo').forEach(function(c){ligarGrupo(c,r,abertos)});
  alvo.querySelectorAll('[data-janela]').forEach(function(b){
    b.addEventListener('click',function(){aoMudarJanela(b.getAttribute('data-janela'))})});
}

window.__pvAtualizacoes={corpo:corpo,alternancia:alternancia,ligar:ligar};
})();
`;

export const ESTILOS_ATUALIZACOES = `
.nov-grupo{border-top:1px solid var(--linha2)}
.nov-grupo .nov{border-top:0}
.nov-btn{font:inherit;font-weight:700;font-size:13px;min-height:32px;padding:0 12px;border-radius:999px;
  border:1px solid var(--linha);background:var(--papel);color:var(--acento);cursor:pointer}
.nov-btn:hover{background:var(--acento-bg);border-color:var(--acento)}
.nov-janela{display:flex;gap:6px;align-items:center}
.nov-mais{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:0 20px 12px 88px}
.nov-ant{background:var(--papel2);border-top:1px solid var(--linha2)}
.nov-ant .nov{padding:10px 20px 10px 20px;border-top:1px solid var(--linha2)}
.nov-ant .nov:first-child{border-top:0}
.nov.ant .t{font-weight:600;font-size:14px}
.nov-fora{padding:12px 20px;border-top:1px solid var(--linha2)}
.selo.am{background:var(--atencao-bg);color:var(--atencao)}
/* O clamp é só rede de segurança (220 caracteres em coluna estreita passam de 3
   linhas); o botão fica FORA do bloco cortado para nunca ser comido por ele. */
.nov-txt{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;
  overflow:hidden;overflow-wrap:anywhere}
.nov-trecho{margin-top:4px}
.nov-trecho .nov-abrir{display:block;margin-top:3px;color:var(--acento);font-weight:600}
@media (max-width:560px){.nov-mais{padding-left:14px}}
`;
