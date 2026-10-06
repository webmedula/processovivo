/**
 * Script da CALIBRAÇÃO do número da movimentação (v0.35.0), parte da Pasta
 * digital. Arquivo próprio: `scriptPasta.ts` já passa de 1.200 linhas e não
 * cresce por causa disto.
 *
 * O número do Projudi conta também os atos bloqueados, que o MNI não entrega.
 * Só o advogado, olhando o Projudi, sabe um número de verdade; cada número que
 * ele informa é uma âncora no servidor, e é o SERVIDOR quem calcula o que isso
 * prova (`numero.tipo`: `posicao`, `exato`, `faixa` ou `estimado`). Esta tela
 * só mostra, com o rótulo do grau de certeza — nunca arredonda uma faixa e
 * nunca chama de "oficial" um número que não foi conferido.
 *
 * Fala com a Pasta por `window.__pvPastaCal` (exposto aqui), que o
 * `scriptPasta.ts` alimenta com `ctx` (`numero`, `visao`, `peca`, `recarregar`).
 * Não consulta o tribunal: todas as chamadas são ao nosso servidor.
 *
 * Mesmo regime dos outros scripts: JavaScript dentro de uma string, lido pelo
 * ESLint em `tests/http/console-script.spec.ts`.
 */
export const SCRIPT_PASTA_CALIBRACAO = String.raw`
(function(){
var ctx=null;
var ed=null;
var msg={ok:false,texto:''};
var assinaturaAnterior='';

function pv(){return window.__pv}
function $(i){return document.getElementById(i)}
function esc(s){return pv().esc(s)}
function base(){return '/v1/processos/'+encodeURIComponent(ctx.numero())+'/pasta/calibracao'}

var AVISO_CURTO='Número calculado pela ordem dos atos recebidos do tribunal. '+
  'Pode ficar abaixo do número do Projudi se o processo tiver atos bloqueados.';
var TITULO_EXATO='Calculado a partir dos números que você informou do Projudi';

function posicaoDe(p){
  var m=p.movimentacao;
  return m&&typeof m.posicao==='number'&&m.posicao>0?m.posicao:null;
}

/* O número da linha, com o grau de certeza que o servidor deu. Resposta sem o
   campo novo cai na posição, como na 0.34.0. */
function numeroDe(p){
  var m=p.movimentacao;
  if(!m)return null;
  var n=m.numero;
  if(n&&typeof n==='object'){
    if(n.tipo==='faixa'&&typeof n.min==='number'&&typeof n.max==='number')return n;
    if((n.tipo==='exato'||n.tipo==='estimado'||n.tipo==='posicao')&&typeof n.n==='number')return n;
  }
  var pos=posicaoDe(p);
  return pos!==null?{tipo:'posicao',n:pos}:null;
}
function rotulo(n){
  if(n.tipo==='faixa')return n.min+'–'+n.max;
  return (n.tipo==='estimado'?'~':'')+n.n;
}
function porExtenso(n){
  if(n.tipo==='faixa')return 'movimentação entre '+n.min+' e '+n.max+', ainda não conferida';
  if(n.tipo==='estimado')return 'movimentação estimada em '+n.n+', não conferida';
  if(n.tipo==='exato')return 'movimentação '+n.n+', conferida';
  return 'movimentação '+n.n+', calculada pela posição, não conferida';
}
function explicacao(n){
  if(n.tipo==='faixa')return 'Entre '+n.min+' e '+n.max+': depende de quantos atos bloqueados '+
    'vieram antes deste. Informe o número de mais um ato no Projudi para fechar.';
  if(n.tipo==='estimado')return 'Estimado: este ato é posterior ao último número que você informou, '+
    'e pode ter surgido ato bloqueado depois dele.';
  if(n.tipo==='exato')return TITULO_EXATO;
  return AVISO_CURTO;
}

/* A coluna do número, à esquerda do rótulo (v0.35.2): o número da movimentação
   ocupa o lugar do índice sequencial da lista, que o advogado lia como número do
   ato no Projudi. O visual é aria-hidden e o texto para leitor de tela diz o grau
   de certeza ("380–381" lido em voz alta viraria "380 a 381" sem dizer que é faixa).
   Sem número: "—" discreto, nunca o índice. */
/* Sem posição (listagem anterior à 0.34.0) a linha é a de antes: sem número, "—". */
function numeroVisivel(p){return posicaoDe(p)===null?null:numeroDe(p)}
function curtoDe(p){
  var n=numeroVisivel(p);
  return n?rotulo(n):'—';
}
function nomeAcessivel(p){
  var n=numeroVisivel(p);
  if(!n)return 'Movimentação sem número';
  if(n.tipo==='faixa')return 'Movimentação, faixa '+n.min+' a '+n.max+', não conferida';
  if(n.tipo==='estimado')return 'Movimentação estimada '+n.n+', não conferida';
  if(n.tipo==='exato')return 'Movimentação '+n.n+', conferida';
  return 'Movimentação '+n.n+', calculada pela posição, não conferida';
}
function htmlCelula(p){
  var n=numeroVisivel(p);
  return '<span class="ord'+(n?' '+n.tipo:' sem')+'"'+(n?' title="'+esc(explicacao(n))+'"':'')+'>'+
    '<span aria-hidden="true">'+esc(curtoDe(p))+'</span>'+
    '<span class="pcal-sr">'+esc(nomeAcessivel(p)+(p.semPeca?', sem peça':''))+'.</span></span>';
}
/* O grau de certeza ao lado do rótulo, na linha de metadados (o número em si já
   está na coluna, não se repete). Faixa e estimado dizem a palavra: não dependem
   do estilo do número. */
function htmlSelo(p,buscado){
  var n=numeroVisivel(p);
  if(!n)return '';
  var h='';
  if(n.tipo==='exato'){
    h+='<span class="mov-ok" title="'+esc(TITULO_EXATO)+'"><span aria-hidden="true">✓ </span>conferido</span>';
  }else if(n.tipo==='faixa'||n.tipo==='estimado'){
    h+='<span class="mov-grau" aria-hidden="true" title="'+esc(explicacao(n))+'">'+
      (n.tipo==='faixa'?'faixa':'estimado')+'</span>';
  }
  if(n.tipo==='faixa'&&buscado!==null&&buscado>=n.min&&buscado<=n.max){
    h+='<span class="mov-ach">faixa que inclui '+buscado+'</span>';
  }
  return h;
}
/* "Mov. 369" / "Mov. 380–381" / "Mov. ~386" / "Mov. —" do cabeçalho do visualizador. */
function rotuloDoVisor(p){return 'Mov. '+curtoDe(p)}
function rotuloDoTitulo(p){
  var n=numeroDe(p);
  if(!n)return '';
  if(n.tipo==='faixa')return ' nº '+rotulo(n)+' (faixa, não conferida)';
  if(n.tipo==='estimado')return ' nº '+rotulo(n)+' (estimada)';
  if(n.tipo==='exato')return ' nº '+n.n+' (conferida)';
  return ' nº '+n.n;
}
function avisoDoVisor(p){
  var n=numeroDe(p);
  if(!n||n.tipo==='exato')return '';
  if(n.tipo==='posicao')return 'número calculado; pode ficar abaixo do Projudi';
  return n.tipo==='faixa'?'faixa: informe o nº de mais um ato para fechar':'estimado a partir do último nº informado';
}
/* A busca por número casa por IGUALDADE com o número exato, estimado ou a
   posição; e, numa faixa, quando o número buscado está dentro dela. */
function combina(p,numero){
  var n=numeroDe(p);
  if(!n)return false;
  if(n.tipo==='faixa')return numero>=n.min&&numero<=n.max;
  return n.n===numero;
}
function haNumeros(visao){
  var atos=((visao&&visao.atosSemPeca)||[]).length>0;
  return atos||((visao&&visao.pecas)||[]).some(function(p){return numeroDe(p)!==null});
}

/* O aviso do topo. Sem calibração: o texto da 0.34.0. Calibrada: o que as
   âncoras provaram. Não some enquanto houver número não exato. */
function avisoHtml(v){
  var c=v.calibracao, h='';
  var total=v.totalAtosRecebidos;
  if(c&&c.invalidadas>0){
    h+='<strong>Calibração anterior invalidada.</strong> O ato de '+(c.invalidadas===1?'uma posição':
      c.invalidadas+' posições')+' que você informou mudou desde a leitura anterior do tribunal; '+
      (c.invalidadas===1?'esse número foi descartado':'esses números foram descartados')+'. ';
  }
  if(!c||!c.ancoras.length){
    h+='Numeração das movimentações calculada '+
      'pelo Processo Vivo a partir de <strong>'+total+'</strong> atos recebidos do '+
      'tribunal. Se o último número que você vê no Projudi for maior que '+total+
      ', há atos bloqueados que não recebemos e os números mais recentes podem estar abaixo '+
      'dos do Projudi. Use "Conferir numeração com o Projudi" para corrigir.';
  }else{
    var a=c.atos, q=c.ancoras.length;
    h+='Calibrada por você com <strong>'+q+'</strong> '+(q===1?'número':'números')+
      ' do Projudi: <strong>'+a.exatos+'</strong> '+(a.exatos===1?'ato exato':'atos exatos')+', <strong>'+
      a.faixas+'</strong> com faixa, <strong>'+a.estimados+'</strong> '+
      (a.estimados===1?'estimado':'estimados')+'.';
    h+=a.faixas+a.estimados>0
      ?' Informe o número de mais um ato para refinar.'
      :' Atos que chegarem depois do último número informado voltam a ser estimados.';
  }
  return '<div class="nota num-aviso" id="pasta-aviso-num">'+h+'</div>';
}

function limparMsg(){msg={ok:false,texto:''}}
function mensagemDoErro(e){
  if(e&&(e.codigo==='CALIBRACAO_DE_NUMERACAO_INVALIDA'||e.codigo==='LISTAGEM_DA_PASTA_AUSENTE'))return e.message;
  return e&&e.status?pv().explicar(e):((e&&e.message)||'Erro inesperado.');
}
function lerNumero(id){
  var el=$(id); if(!el)return null;
  var t=String(el.value||'').trim();
  if(!/^\d{1,7}$/.test(t)||Number(t)<1){
    msg={ok:false,texto:'Informe só o número da movimentação como aparece no Projudi, por exemplo 386.'};
    el.setAttribute('aria-invalid','true');
    desenhar(true);
    var novo=$(id); if(novo)novo.focus();
    return null;
  }
  return Number(t);
}
function chamar(metodo,caminho,corpo,sucesso){
  var opcoes={method:metodo};
  if(corpo)opcoes.body=corpo;
  return pv().api(base()+caminho,opcoes).then(function(){
    msg={ok:true,texto:sucesso};
    if(corpo)ed=null;
    return ctx.recarregar();
  }).then(function(){desenhar(true)}).catch(function(e){
    msg={ok:false,texto:mensagemDoErro(e)};
    desenhar(true);
  });
}
function salvarUltimo(){
  var n=lerNumero('pasta-cal-ultimo'); if(n===null)return;
  chamar('PUT','',{numeroProjudi:n},'Calibrado pelo último número: '+n+'.');
}
function salvarDoAto(){
  if(!ed)return;
  var n=lerNumero('pasta-cal-ato'); if(n===null)return;
  chamar('PUT','',{posicao:ed.posicao,numeroProjudi:n},'Número do ato salvo.');
}

/* ---------- o editor de UM ato (flutuante: serve à lista e ao visualizador) ---------- */
function abrirEditor(p){
  var pos=posicaoDe(p);
  if(pos===null)return;
  ed={posicao:pos,pecaId:p.pecaId,descricao:p.movimentacao.descricao||''};
  limparMsg();
  /* O bloco do topo fecha: com ele aberto, o aviso e o editor tomariam a tela e
     a lista, de onde se lê o número, ficaria sem espaço. */
  var d=$('pasta-cal'); if(d)d.open=false;
  desenhar(true);
  var el=$('pasta-cal-ato'); if(el)el.focus();
}
function fecharEditor(){
  var volta=ed&&ed.pecaId;
  ed=null;limparMsg();desenhar(true);
  var l=volta&&$('pf-'+volta);
  if(l){try{l.focus({preventScroll:true})}catch(e){}}
}
function desenharEditor(){
  var el=$('pasta-cal-editor'); if(!el)return;
  if(!ed){el.hidden=true;el.innerHTML='';return}
  var atual=null;
  ((ctx.visao()&&ctx.visao().calibracao&&ctx.visao().calibracao.ancoras)||[]).forEach(function(a){
    if(a.posicao===ed.posicao)atual=a});
  el.hidden=false;
  el.innerHTML=
    '<form id="pasta-cal-form-ato" novalidate>'+
      '<label for="pasta-cal-ato"><strong>Informar o nº deste ato no Projudi</strong> '+
        '(ato '+ed.posicao+' entre os recebidos'+(ed.descricao?': '+esc(ed.descricao):'')+')</label>'+
      '<div class="pcal-linha">'+
        '<input id="pasta-cal-ato" type="text" inputmode="numeric" autocomplete="off" '+
          'aria-describedby="pasta-cal-ato-ajuda pasta-cal-ato-msg" value="'+(atual?atual.numeroProjudi:'')+'">'+
        '<button class="bt" type="submit">Salvar</button>'+
        '<button class="bt bt2" type="button" id="pasta-cal-ato-cancelar">Cancelar</button>'+
      '</div>'+
      '<div class="pcal-ajuda" id="pasta-cal-ato-ajuda">Informe dois números, um recente e um antigo, '+
        'para os atos entre eles ficarem exatos.</div>'+
      '<div class="pcal-msg'+(msg.ok?' ok':' erro')+'" id="pasta-cal-ato-msg" role="alert">'+
        esc(msg.texto)+'</div>'+
    '</form>';
  $('pasta-cal-form-ato').addEventListener('submit',function(e){e.preventDefault();salvarDoAto()});
  $('pasta-cal-ato-cancelar').addEventListener('click',fecharEditor);
  $('pasta-cal-ato').addEventListener('keydown',function(e){
    if(e.key==='Escape'){e.stopPropagation();fecharEditor()}});
}

/* ---------- o bloco do topo ---------- */
function blocoHtml(v,aberto){
  var c=v.calibracao, ancoras=(c&&c.ancoras)||[];
  var pronto=typeof v.totalAtosRecebidos==='number';
  var h='<details class="pcal" id="pasta-cal"'+(aberto?' open':'')+'>'+
    '<summary>Conferir numeração com o Projudi'+
      (ancoras.length?' <span class="pcal-n">('+ancoras.length+' '+(ancoras.length===1?'número informado':'números informados')+')</span>':'')+
    '</summary><div class="pcal-corpo">'+
    '<p class="pcal-ajuda">O Projudi numera também os atos bloqueados, que o tribunal não nos entrega. '+
      'Informe o número que você vê lá e o Processo Vivo corrige a numeração: um número recente e '+
      'um antigo deixam exatos os atos entre eles. Nada é consultado no tribunal.</p>';
  if(!pronto){
    h+='<p class="pcal-ajuda">Recarregue as peças do processo (botão "Atualizar" do cartão das peças) '+
      'para poder calibrar.</p>';
  }else{
    h+='<form id="pasta-cal-form-ultimo" novalidate><label for="pasta-cal-ultimo">'+
      'Último número que você vê no Projudi</label><div class="pcal-linha">'+
      '<input id="pasta-cal-ultimo" type="text" inputmode="numeric" autocomplete="off" '+
        'aria-describedby="pasta-cal-msg" placeholder="ex.: '+(v.totalAtosRecebidos+1)+'">'+
      '<button class="bt" type="submit">Calibrar</button></div></form>';
  }
  if(ancoras.length){
    h+='<ul class="pcal-lista" aria-label="Números informados do Projudi">';
    ancoras.forEach(function(a){
      h+='<li><span>Ato <strong>'+a.posicao+'</strong> entre os recebidos → nº <strong>'+
        a.numeroProjudi+'</strong> no Projudi</span>'+
        '<button class="bt bt2" type="button" data-remover="'+a.posicao+'" '+
        'aria-label="Remover o número informado para o ato '+a.posicao+'">Remover</button></li>';
    });
    h+='</ul><button class="bt bt2" type="button" id="pasta-cal-limpar">Limpar calibração</button>';
  }
  h+='<div class="pcal-msg'+(msg.ok?' ok':' erro')+'" id="pasta-cal-msg" role="status">'+
    (ed?'':esc(msg.texto))+'</div></div></details>';
  return h;
}
function ligarBloco(){
  var f=$('pasta-cal-form-ultimo');
  if(f)f.addEventListener('submit',function(e){e.preventDefault();salvarUltimo()});
  var l=$('pasta-cal-limpar');
  if(l)l.addEventListener('click',function(){chamar('DELETE','',null,'Calibração removida.')});
  var rs=document.querySelectorAll('#pasta-cal [data-remover]');
  Array.prototype.forEach.call(rs,function(b){
    b.addEventListener('click',function(){
      chamar('DELETE','/'+b.getAttribute('data-remover'),null,'Número removido.')});
  });
}

/* Redesenha só quando algo que se vê mudou: a Pasta consulta o servidor a cada
   2 s, e refazer o bloco a cada vez tiraria o foco e o que se digita. */
function desenhar(forcar){
  var caixa=$('pasta-cal-caixa'); if(!caixa||!ctx)return;
  var v=ctx.visao();
  if(!v||!v.listagem){caixa.innerHTML='';desenharEditor();assinaturaAnterior='';return}
  var c=v.calibracao||{};
  var assinatura=JSON.stringify([v.totalAtosRecebidos,c.ancoras,c.invalidadas,msg,!!ed]);
  if(!forcar&&assinatura===assinaturaAnterior)return;
  assinaturaAnterior=assinatura;
  var antigo=$('pasta-cal');
  var focoId=document.activeElement&&caixa.contains(document.activeElement)?document.activeElement.id:'';
  caixa.innerHTML=blocoHtml(v,antigo?antigo.open:false);
  ligarBloco();
  if(focoId){var f=$(focoId); if(f)f.focus()}
  desenharEditor();
}
function reiniciar(){ed=null;limparMsg();assinaturaAnterior=''}

window.__pvPastaCal={
  ctx:null,
  numeroDe:numeroDe,
  htmlCelula:htmlCelula,
  htmlSelo:htmlSelo,
  nomeAcessivel:nomeAcessivel,
  rotuloDoVisor:rotuloDoVisor,
  curtoDe:curtoDe,
  rotuloDoTitulo:rotuloDoTitulo,
  avisoDoVisor:avisoDoVisor,
  combina:combina,
  haNumeros:haNumeros,
  avisoHtml:avisoHtml,
  posicaoDe:posicaoDe,
  abrirEditor:abrirEditor,
  desenhar:desenhar,
  reiniciar:reiniciar,
  definir:function(c){ctx=c}
};
})();
`;
