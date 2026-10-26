/**
 * A parte "Modelo" de cada função na tela "IA" do /admin (v0.60.0, Fase B do painel de IA). Módulo
 * próprio: o `iaAdmin.ts` só ganha um espaço por cartão e a chamada `montar`.
 *
 * Fala com o servidor só por `/admin/api/ia/modelos*`, que entrega ids de modelo, números, datas e
 * frases FIXAS nossas — nenhum texto de fixture, de ato, de peça ou de resposta do modelo existe nesse
 * contrato, então não há como a tela mostrá-los. Tudo que vem do servidor passa por `esc`.
 *
 * `tests/http/admin-script.spec.ts` roda o ESLint dentro desta string, como no resto do /admin.
 */
export const SCRIPT_IA_ADMIN_MODELOS = String.raw`
(function(){
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

var M={dados:null,raiz:null,escolhido:{},painel:{},msg:'',tempo:null,carregando:false};
/* painel[f] = {tipo:'estimativa'|'publicar'|'reverter', estimativa?, enviando?, erro?} */

var ROTULO_ORIGEM={painel:'definido no painel',ambiente:'definido pelo ambiente do servidor'};
var ROTULO_ESTADO={na_fila:'Na fila',executando:'Em andamento',concluido:'Concluído',falhou:'Falhou',cancelado:'Cancelado'};
var ROTULO_VEREDITO={aprovado:'Aprovado',aprovado_com_ressalva:'Aprovado com ressalvas',bloqueado:'Bloqueado'};
var FRASE={
  carregando:'Carregando os modelos…',
  falha:'Não foi possível carregar os modelos agora. Tente de novo.',
  semCandidato:'Nenhum outro modelo está na lista permitida para esta função.',
  semTeste:'Ainda não há teste para esta função.',
  testeIndisponivel:'O teste de modelo não está disponível neste servidor (a IA está desligada no ambiente).',
  duracao:'O teste chama o provedor de verdade com casos sintéticos e pode levar vários minutos. Você pode sair desta tela: ele continua no servidor.',
  invalidoDoPainel:'O modelo guardado no painel saiu da lista ou foi descontinuado. Está valendo o modelo do ambiente.',
  erroGenerico:'Não foi possível concluir. Tente de novo.',
  publicado:'Modelo publicado.',
  revertido:'Modelo anterior restaurado.',
  iniciado:'Teste iniciado.',
  cancelado:'Cancelando o teste.',
  digitar:'Digite a palavra de confirmação e escolha um motivo.'
};

/* ---------- formatação ---------- */
function n(v){return Number(v||0).toLocaleString('pt-BR')}
function usd(v,c){
  if(v==null)return '—';
  var casas=c==null?4:c;
  return 'US$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:casas,maximumFractionDigits:casas});
}
function pct(v){return v==null?'—':(v*100).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%'}
function seg(ms){return ms==null?'—':(ms/1000).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+' s'}
function dth(iso){
  var d=new Date(iso);
  return isNaN(d)?'—':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',
    year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function valor(formato,v){
  if(v==null)return '—';
  if(formato==='pct')return pct(v);
  if(formato==='ms')return seg(v);
  if(formato==='usd')return usd(v,5);
  return n(v);
}
function diferenca(formato,v){
  if(v==null)return '—';
  var sinal=v>0?'+':(v<0?'−':'');
  var a=Math.abs(v);
  if(formato==='pct')return sinal+(a*100).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+' pontos';
  if(formato==='ms')return sinal+seg(a);
  if(formato==='usd')return sinal+usd(a,5);
  return sinal+n(a);
}
function precoDe(i){
  return usd(i.precoEntradaPorMTokens,2)+' entrada / '+usd(i.precoSaidaPorMTokens,2)+' saída por 1 milhão de tokens';
}

/* ---------- rede ---------- */
function api(caminho,opcoes){
  opcoes=opcoes||{};
  var h={};
  if(opcoes.body)h['content-type']='application/json';
  return fetch(caminho,{method:opcoes.method||'GET',headers:h,cache:'no-store',
    body:opcoes.body?JSON.stringify(opcoes.body):undefined})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(b){
      if(!r.ok){var e=new Error('HTTP '+r.status);e.status=r.status;e.motivo=b&&b.detalhes?b.detalhes.motivo:'';e.mensagem=b&&b.mensagem?b.mensagem:'';throw e}
      return b})});
}
function anunciar(t){
  var el=$('ia-live');
  if(!el)return;
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

/* ---------- desenho ---------- */
function funcaoDe(f){
  if(!M.dados)return null;
  for(var i=0;i<M.dados.funcoes.length;i++)if(M.dados.funcoes[i].funcao===f)return M.dados.funcoes[i];
  return null;
}
function ativo(t){return !!t&&(t.estado==='na_fila'||t.estado==='executando')}

function blocoDoEfetivo(f){
  var e=f.efetivo,h='<p class="ia-m-linha">Modelo em uso: <strong>'+esc(e.apelido)+'</strong> <span class="ia-mono">'+esc(e.modelo)+'</span></p>';
  h+='<p class="ia-suave">'+esc(ROTULO_ORIGEM[e.origem]||e.origem)+(e.desde?' · desde '+esc(dth(e.desde)):'')+'</p>';
  if(e.painelInvalido)h+='<p class="ia-m-aviso" role="note">'+esc(FRASE.invalidoDoPainel)+'</p>';
  return h;
}

function blocoDoSeletor(f){
  var id='ia-m-'+f.funcao;
  if(!f.candidatos.length)return '<p class="ia-suave">'+esc(FRASE.semCandidato)+'</p>';
  var sel=M.escolhido[f.funcao]||'';
  var h='<div class="ia-campo"><label for="'+id+'-sel">Modelo para testar</label><select id="'+id+'-sel" data-ia-m-sel="'+esc(f.funcao)+'">';
  h+='<option value=""'+(sel===''?' selected':'')+'>Escolha um modelo</option>';
  var escolhido=null;
  for(var i=0;i<f.candidatos.length;i++){
    var c=f.candidatos[i];
    if(c.id===sel)escolhido=c;
    h+='<option value="'+esc(c.id)+'"'+(c.id===sel?' selected':'')+'>'+esc(c.apelido)+'</option>';
  }
  h+='</select></div>';
  if(escolhido){
    h+='<dl class="ia-m-detalhe" aria-label="Dados do modelo escolhido">';
    h+='<div><dt>Id</dt><dd class="ia-mono">'+esc(escolhido.id)+'</dd></div>';
    h+='<div><dt>Provedor</dt><dd>'+esc(escolhido.provedor)+'</dd></div>';
    h+='<div><dt>Preço de lista</dt><dd>'+esc(precoDe(escolhido))+'</dd></div>';
    h+='<div><dt>Janela de contexto</dt><dd>'+n(escolhido.janelaContexto)+' tokens</dd></div>';
    h+='<div><dt>ZDR conferido em</dt><dd>'+esc(escolhido.zdrConfirmadoEm)+' · '+esc(escolhido.zdrFonte)+'</dd></div>';
    h+='</dl>';
  }
  var bloqueado=ativo(M.dados.emAndamento)||!M.dados.testeDisponivel;
  h+='<div class="ia-acoes"><button type="button" class="bt2" id="'+id+'-testar" data-ia-m-testar="'+esc(f.funcao)+'"'+
    (escolhido&&!bloqueado?'':' disabled')+(!M.dados.testeDisponivel?' aria-describedby="'+id+'-ajuda"':'')+'>Testar este modelo</button></div>';
  if(!M.dados.testeDisponivel)h+='<p class="ia-suave" id="'+id+'-ajuda">'+esc(FRASE.testeIndisponivel)+'</p>';
  else if(M.dados.emAndamento&&M.dados.emAndamento.funcao!==f.funcao)h+='<p class="ia-suave">Já existe um teste em andamento em outra função. Só um teste roda por vez.</p>';
  return h;
}

function painelDeEstimativa(f){
  var p=M.painel[f.funcao];
  if(!p||p.tipo!=='estimativa')return '';
  var id='ia-m-'+f.funcao,e=p.estimativa,r=M.dados.regras;
  var h='<div class="ia-confirma" role="group" aria-labelledby="'+id+'-est-t">';
  h+='<p id="'+id+'-est-t"><strong>Estimativa do teste</strong></p>';
  if(!e){return h+'<p class="ia-suave">Calculando…</p></div>'}
  h+='<ul class="ia-lista"><li>Chamadas ao provedor: <strong>'+n(e.chamadas)+'</strong> (modelo novo e modelo atual, casos sintéticos)</li>';
  h+='<li>Custo estimado: <strong>'+esc(e.custoEstimadoUsd==null?'sem preço para estimar':usd(e.custoEstimadoUsd,4))+'</strong> · teto da rodada: <strong>'+esc(usd(e.tetoUsd,2))+'</strong></li></ul>';
  h+='<p class="ia-suave">'+esc(FRASE.duracao)+'</p>';
  if(e.acimaDoTeto)h+='<p class="ia-m-aviso" role="alert">A estimativa passa do teto da rodada. O teste não pode começar.</p>';
  if(p.erro)h+='<p class="ia-m-aviso" role="alert">'+esc(p.erro)+'</p>';
  h+='<button type="button" class="bt" id="'+id+'-iniciar" data-ia-m-iniciar="'+esc(f.funcao)+'"'+(e.acimaDoTeto||p.enviando?' disabled':'')+'>Confirmar e iniciar o teste</button> ';
  h+='<button type="button" class="bt2" data-ia-m-fechar="'+esc(f.funcao)+'">Cancelar</button></div>';
  return h;
}

function tabelaDaComparacao(t){
  if(!t.comparacao)return '';
  var h='<table class="ia-m-tabela"><caption class="ia-so-leitor">Comparação entre o modelo novo e o modelo atual</caption>';
  h+='<thead><tr><th scope="col">Medida</th><th scope="col">Atual ('+esc(t.referenciaApelido)+')</th><th scope="col">Novo ('+esc(t.candidatoApelido)+')</th><th scope="col">Diferença</th></tr></thead><tbody>';
  for(var i=0;i<t.comparacao.length;i++){
    var l=t.comparacao[i];
    var marca=l.melhor===true?'melhor':(l.melhor===false?'pior':'igual');
    h+='<tr><th scope="row">'+esc(l.rotulo)+'</th>'+
      '<td data-rotulo="Atual">'+esc(valor(l.formato,l.referencia))+'</td>'+
      '<td data-rotulo="Novo">'+esc(valor(l.formato,l.candidato))+'</td>'+
      '<td data-rotulo="Diferença" class="ia-m-'+marca+'">'+esc(diferenca(l.formato,l.diferenca))+(l.diferenca==null?'':' ('+marca+')')+'</td></tr>';
  }
  return h+'</tbody></table>';
}

function listaDeMotivos(titulo,itens,classe){
  if(!itens||!itens.length)return '';
  var h='<div class="'+classe+'"><p><strong>'+esc(titulo)+'</strong></p><ul class="ia-lista">';
  for(var i=0;i<itens.length;i++)h+='<li>'+esc(itens[i].frase)+'</li>';
  return h+'</ul></div>';
}

function blocoDoTeste(f){
  var t=f.ultimoTeste,id='ia-m-'+f.funcao;
  var h='<div class="ia-m-teste" aria-labelledby="'+id+'-tt"><h5 id="'+id+'-tt" class="ia-m-h5">Último teste</h5>';
  if(!t)return h+'<p class="ia-suave">'+esc(FRASE.semTeste)+'</p></div>';
  h+='<p class="ia-m-linha">'+esc(t.candidatoApelido)+' × '+esc(t.referenciaApelido)+' · <strong data-ia-m-estado="'+esc(f.funcao)+'">'+esc(ROTULO_ESTADO[t.estado]||t.estado)+'</strong> · '+esc(dth(t.criadoEm))+'</p>';
  if(ativo(t)){
    var feitas=t.chamadasFeitas,tot=t.chamadasPrevistas;
    h+='<p id="'+id+'-prog" data-ia-m-prog="1">'+n(feitas)+' de '+n(tot)+' chamadas</p>';
    h+='<div class="ia-m-barra" role="progressbar" aria-label="Andamento do teste" aria-valuemin="0" aria-valuemax="'+tot+'" aria-valuenow="'+feitas+'"><span style="width:'+(tot?Math.round(100*feitas/tot):0)+'%"></span></div>';
    h+='<button type="button" class="bt2" id="'+id+'-cancelar" data-ia-m-cancelar="'+esc(t.id)+'">Cancelar o teste</button>';
  }else if(t.estado==='falhou'&&t.falha){
    h+='<p class="ia-m-aviso" role="note">'+esc(t.falha.frase)+'</p>';
  }else if(t.estado==='cancelado'){
    h+='<p class="ia-suave">O teste foi cancelado. Nenhum veredito foi dado.</p>';
  }else if(t.estado==='concluido'){
    h+='<p class="ia-m-veredito ia-m-v-'+esc(t.veredito)+'">Veredito: <strong>'+esc(ROTULO_VEREDITO[t.veredito]||t.veredito)+'</strong></p>';
    h+=listaDeMotivos('Bloqueios',t.bloqueios,'ia-m-bloqueios');
    h+=listaDeMotivos('Ressalvas (publicar só com a sua aprovação)',t.ressalvas,'ia-m-ressalvas');
    h+=tabelaDaComparacao(t);
    if(t.comparacao){
      var imp=t.impactoPorDiaUsd;
      h+='<p class="ia-m-custo"><strong>Custo:</strong> '+(imp==null?'impacto por dia não estimado (falta custo medido).':
        'impacto estimado de '+esc((imp>0?'+':(imp<0?'−':''))+usd(Math.abs(imp),4))+' por dia, no volume dos últimos 30 dias ('+n(t.analisesNosUltimos30Dias)+' análises).')+'</p>';
    }
    h+='<p class="ia-suave">Rodada: '+esc(usd(t.gastoUsd,4))+' gastos de '+esc(usd(M.dados.regras.tetoDaRodadaUsd,2))+' de teto.</p>';
  }
  return h+'</div>';
}

function regrasDaDecisao(){
  var r=M.dados.regras;
  var h='<details class="ia-m-regras"><summary>Regras desta decisão</summary><ul class="ia-lista">';
  h+='<li><strong>Bloqueiam, sem aprovação manual:</strong> modelo sem ZDR confirmado; mais violações que o modelo atual na mesma rodada; citação verificada abaixo de '+pct(r.citacaoVerificadaMinima)+'; falhas de formato acima do atual em mais de '+n(r.falhasDeFormatoMaxPp)+' pontos percentuais; teste incompleto ou com erro do provedor.</li>';
  h+='<li><strong>Passam com a sua aprovação:</strong> pontos obrigatórios com queda de até '+n(r.quedaDePontosMaxPp)+' pontos percentuais; tempo p95 até +'+n(r.aumentoDaLatenciaP95Max*100)+'%; custo médio maior (qualquer valor, mostrado em destaque).</li>';
  h+='<li>Acima desses limites a troca também é bloqueada. Tudo igual ou melhor publica com uma confirmação.</li>';
  h+='<li>Teto de gasto por rodada: '+esc(usd(r.tetoDaRodadaUsd,2))+'. O teste vale para publicar por '+n(r.validadeDoTesteHoras)+' horas.</li>';
  return h+'</ul></details>';
}

function blocoDePublicar(f){
  var t=f.ultimoTeste,id='ia-m-'+f.funcao,pub=f.publicacao,p=M.painel[f.funcao];
  if(!t||t.estado!=='concluido')return '';
  var h='<div class="ia-m-publicar">';
  if(p&&p.tipo==='publicar'){
    var exige=pub.pode&&pub.exigeAprovacao;
    h+='<div class="ia-confirma" role="group" aria-labelledby="'+id+'-pub-t">';
    h+='<p id="'+id+'-pub-t"><strong>Publicar "'+esc(t.candidatoApelido)+'" na função "'+esc(f.rotulo)+'"?</strong> A troca vale na hora para todas as contas. Você pode reverter com um clique.</p>';
    if(exige){
      var r=M.dados.regras;
      h+='<div class="ia-campo"><label for="'+id+'-palavra">Digite '+esc(r.palavraDeConfirmacao)+' para aprovar as ressalvas</label><input id="'+id+'-palavra" type="text" autocomplete="off" value="'+esc(p.palavra||'')+'"></div>';
      h+='<div class="ia-campo"><label for="'+id+'-motivo">Motivo</label><select id="'+id+'-motivo"><option value="">Escolha um motivo</option>';
      for(var i=0;i<r.motivosDeAprovacao.length;i++){
        var m=r.motivosDeAprovacao[i];
        h+='<option value="'+esc(m.codigo)+'"'+(p.motivo===m.codigo?' selected':'')+'>'+esc(m.rotulo)+'</option>';
      }
      h+='</select></div>';
      h+='<div class="ia-campo"><label for="'+id+'-obs">Observação curta (opcional, até '+n(r.tamanhoMaximoDaObservacao)+' caracteres, sem dados pessoais)</label><input id="'+id+'-obs" type="text" maxlength="'+r.tamanhoMaximoDaObservacao+'" autocomplete="off" value="'+esc(p.observacao||'')+'"></div>';
    }
    if(p.erro)h+='<p class="ia-m-aviso" role="alert">'+esc(p.erro)+'</p>';
    var pronto=!exige||(p.palavra===M.dados.regras.palavraDeConfirmacao&&!!p.motivo);
    h+='<button type="button" class="bt" id="'+id+'-pub-ok" data-ia-m-publicar-ok="'+esc(f.funcao)+'"'+(pronto&&!p.enviando?'':' disabled')+'>'+(exige?'Publicar com ressalvas':'Sim, publicar')+'</button> ';
    h+='<button type="button" class="bt2" data-ia-m-fechar="'+esc(f.funcao)+'">Cancelar</button></div>';
  }else{
    h+='<button type="button" class="bt" id="'+id+'-publicar" data-ia-m-publicar="'+esc(f.funcao)+'"'+(pub.pode?'':' disabled aria-describedby="'+id+'-pub-ajuda"')+'>Publicar este modelo</button>';
    if(!pub.pode)h+='<p class="ia-suave" id="'+id+'-pub-ajuda">'+esc(pub.mensagem)+'</p>';
    else if(pub.exigeAprovacao)h+='<p class="ia-suave" id="'+id+'-pub-ajuda">Este teste tem ressalvas: para publicar, digite a confirmação e escolha um motivo.</p>';
  }
  return h+'</div>';
}

function blocoDeReverter(f){
  var id='ia-m-'+f.funcao,p=M.painel[f.funcao];
  var h='<div class="ia-m-reverter">';
  if(p&&p.tipo==='reverter'){
    h+='<div class="ia-confirma" role="group" aria-labelledby="'+id+'-rev-t"><p id="'+id+'-rev-t"><strong>Voltar para "'+esc(f.anterior?f.anterior.apelido:'')+'"?</strong> Não precisa de novo teste: era o modelo que já estava em uso.</p>';
    if(p.erro)h+='<p class="ia-m-aviso" role="alert">'+esc(p.erro)+'</p>';
    h+='<button type="button" class="bt" id="'+id+'-rev-ok" data-ia-m-reverter-ok="'+esc(f.funcao)+'"'+(p.enviando?' disabled':'')+'>Sim, reverter</button> ';
    h+='<button type="button" class="bt2" data-ia-m-fechar="'+esc(f.funcao)+'">Cancelar</button></div>';
  }else{
    h+='<button type="button" class="bt2" id="'+id+'-reverter" data-ia-m-reverter="'+esc(f.funcao)+'"'+(f.podeReverter?'':' disabled aria-describedby="'+id+'-rev-ajuda"')+'>Reverter para o modelo anterior</button>';
    h+='<p class="ia-suave" id="'+id+'-rev-ajuda">'+(f.podeReverter&&f.anterior?'Volta para '+esc(f.anterior.apelido)+'.':'Não há modelo anterior para voltar.')+'</p>';
  }
  return h+'</div>';
}

function blocoDaFuncao(f){
  var id='ia-m-'+f.funcao;
  var h='<section class="ia-mod" aria-label="Modelo de IA — '+esc(f.rotulo)+'"><h4 id="'+id+'-t" class="ia-m-h4">Modelo de IA</h4>';
  h+=blocoDoEfetivo(f)+blocoDoSeletor(f)+painelDeEstimativa(f)+blocoDoTeste(f)+blocoDePublicar(f)+blocoDeReverter(f);
  return h+'</section>';
}

function rodape(){
  var h='<p class="ia-suave ia-m-nota">'+esc(M.dados.aviso)+'</p>'+regrasDaDecisao();
  return h;
}

function desenhar(){
  if(!M.raiz)return;
  var tinhaFoco=document.activeElement&&document.activeElement.id;
  var alvos=M.raiz.querySelectorAll('[data-ia-modelos]');
  for(var i=0;i<alvos.length;i++){
    var f=M.dados?funcaoDe(alvos[i].getAttribute('data-ia-modelos')):null;
    alvos[i].innerHTML=f?blocoDaFuncao(f):'<p class="ia-suave">'+esc(M.msg||FRASE.carregando)+'</p>';
  }
  var nota=M.raiz.querySelector('[data-ia-modelos-nota]');
  if(nota)nota.innerHTML=M.dados?rodape():'';
  ligar();
  if(tinhaFoco&&$(tinhaFoco)&&document.activeElement!==$(tinhaFoco))$(tinhaFoco).focus();
}

/* ---------- ações ---------- */
function acompanhar(){
  if(M.tempo){clearTimeout(M.tempo);M.tempo=null}
  var t=M.dados&&M.dados.emAndamento;
  if(!ativo(t))return;
  M.tempo=setTimeout(function(){
    M.tempo=null;
    if(!M.raiz||!document.body.contains(M.raiz))return;
    api('/admin/api/ia/modelos/testes/'+encodeURIComponent(t.id)).then(function(novo){
      if(ativo(novo)){
        /* só o progresso muda: o resto da tela fica quieto (foco e digitação preservados) */
        M.dados.emAndamento=novo;
        var f=funcaoDe(novo.funcao);if(f)f.ultimoTeste=novo;
        var p=$('ia-m-'+novo.funcao+'-prog');
        if(p)p.textContent=n(novo.chamadasFeitas)+' de '+n(novo.chamadasPrevistas)+' chamadas';
        var b=M.raiz.querySelector('#ia-m-'+novo.funcao+'-prog + [role="progressbar"]');
        if(b){b.setAttribute('aria-valuenow',novo.chamadasFeitas);
          var s=b.firstChild;if(s&&s.style)s.style.width=(novo.chamadasPrevistas?Math.round(100*novo.chamadasFeitas/novo.chamadasPrevistas):0)+'%'}
        acompanhar();
      }else{
        carregar().then(function(){
          anunciar('Teste terminado: '+(ROTULO_ESTADO[novo.estado]||novo.estado)+(novo.veredito?'. Veredito: '+(ROTULO_VEREDITO[novo.veredito]||novo.veredito):'')+'.');
        });
      }
    },function(){acompanhar()});
  },2000);
}

function carregar(){
  return api('/admin/api/ia/modelos').then(function(d){
    M.dados=d;M.msg='';desenhar();acompanhar();
  },function(){M.dados=null;M.msg=FRASE.falha;desenhar()});
}

function recarregarTela(){
  return Promise.resolve(window.__pvIaAdmin&&window.__pvIaAdmin.recarregar?window.__pvIaAdmin.recarregar():null);
}

function textoDoErro(e){
  return (e&&e.mensagem)?e.mensagem:FRASE.erroGenerico;
}

function ligar(){
  if(!M.dados)return;
  var r=M.raiz,i,els;
  els=r.querySelectorAll('[data-ia-m-sel]');
  for(i=0;i<els.length;i++)els[i].addEventListener('change',function(ev){
    var f=ev.currentTarget.getAttribute('data-ia-m-sel');
    M.escolhido[f]=ev.currentTarget.value;delete M.painel[f];desenhar();
    var s=$('ia-m-'+f+'-sel');if(s)s.focus();
  });
  els=r.querySelectorAll('[data-ia-m-testar]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var f=ev.currentTarget.getAttribute('data-ia-m-testar'),cand=M.escolhido[f];
    if(!cand)return;
    M.painel[f]={tipo:'estimativa',estimativa:null};desenhar();
    api('/admin/api/ia/modelos/'+encodeURIComponent(f)+'/estimativa',{method:'POST',body:{candidato:cand}}).then(function(e){
      M.painel[f]={tipo:'estimativa',estimativa:e};desenhar();
      var b=$('ia-m-'+f+'-iniciar');if(b)b.focus();
    },function(e){M.painel[f]={tipo:'estimativa',estimativa:{chamadas:0,custoEstimadoUsd:null,tetoUsd:M.dados.regras.tetoDaRodadaUsd,acimaDoTeto:true},erro:textoDoErro(e)};desenhar()});
  });
  els=r.querySelectorAll('[data-ia-m-iniciar]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var f=ev.currentTarget.getAttribute('data-ia-m-iniciar'),p=M.painel[f];
    if(!p||p.enviando)return;
    p.enviando=true;desenhar();
    api('/admin/api/ia/modelos/'+encodeURIComponent(f)+'/testes',{method:'POST',body:{candidato:M.escolhido[f],confirmado:true}}).then(function(){
      delete M.painel[f];
      return carregar().then(function(){anunciar(FRASE.iniciado);var b=$('ia-m-'+f+'-cancelar');if(b)b.focus()});
    },function(e){p.enviando=false;p.erro=textoDoErro(e);desenhar()});
  });
  els=r.querySelectorAll('[data-ia-m-cancelar]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var id=ev.currentTarget.getAttribute('data-ia-m-cancelar');
    api('/admin/api/ia/modelos/testes/'+encodeURIComponent(id)+'/cancelar',{method:'POST',body:{}}).then(function(){
      anunciar(FRASE.cancelado);
    },function(){anunciar(FRASE.erroGenerico)});
  });
  els=r.querySelectorAll('[data-ia-m-fechar]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var f=ev.currentTarget.getAttribute('data-ia-m-fechar'),tipo=M.painel[f]&&M.painel[f].tipo;
    delete M.painel[f];desenhar();
    var alvo=tipo==='estimativa'?'-testar':(tipo==='publicar'?'-publicar':'-reverter');
    var b=$('ia-m-'+f+alvo);if(b)b.focus();
  });
  els=r.querySelectorAll('[data-ia-m-publicar]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var f=ev.currentTarget.getAttribute('data-ia-m-publicar');
    M.painel[f]={tipo:'publicar',palavra:'',motivo:'',observacao:''};desenhar();
    var c=$('ia-m-'+f+'-palavra')||$('ia-m-'+f+'-pub-ok');if(c)c.focus();
  });
  var campos=['palavra','motivo','obs'];
  for(var k=0;k<M.dados.funcoes.length;k++){
    (function(f){
      var p=M.painel[f];
      if(!p||p.tipo!=='publicar')return;
      campos.forEach(function(c){
        var el=$('ia-m-'+f+'-'+c);
        if(!el)return;
        el.addEventListener('input',function(){
          var q=M.painel[f];if(!q)return;
          if(c==='palavra')q.palavra=el.value;else if(c==='motivo')q.motivo=el.value;else q.observacao=el.value;
          /* habilita o botão sem redesenhar: foco e cursor ficam onde estão */
          var ok=$('ia-m-'+f+'-pub-ok');
          if(ok)ok.disabled=!(q.palavra===M.dados.regras.palavraDeConfirmacao&&!!q.motivo)||!!q.enviando;
        });
      });
    })(M.dados.funcoes[k].funcao);
  }
  els=r.querySelectorAll('[data-ia-m-publicar-ok]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var f=ev.currentTarget.getAttribute('data-ia-m-publicar-ok'),p=M.painel[f],fn=funcaoDe(f);
    if(!p||p.enviando||!fn||!fn.ultimoTeste)return;
    var corpo={testeId:fn.ultimoTeste.id,confirmado:true};
    if(fn.publicacao.exigeAprovacao){corpo.palavra=p.palavra;corpo.motivo=p.motivo;if(p.observacao)corpo.observacao=p.observacao}
    p.enviando=true;desenhar();
    api('/admin/api/ia/modelos/'+encodeURIComponent(f)+'/publicar',{method:'POST',body:corpo}).then(function(d){
      delete M.painel[f];M.dados=d;desenhar();
      var b=$('ia-m-'+f+'-reverter');if(b)b.focus();
      /* A tela IA se redesenha (histórico e cartões); o aviso só depois, na região que sobrar. */
      return recarregarTela().then(function(){anunciar(FRASE.publicado)});
    },function(e){p.enviando=false;p.erro=textoDoErro(e);desenhar()});
  });
  els=r.querySelectorAll('[data-ia-m-reverter]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var f=ev.currentTarget.getAttribute('data-ia-m-reverter');
    M.painel[f]={tipo:'reverter'};desenhar();
    var b=$('ia-m-'+f+'-rev-ok');if(b)b.focus();
  });
  els=r.querySelectorAll('[data-ia-m-reverter-ok]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var f=ev.currentTarget.getAttribute('data-ia-m-reverter-ok'),p=M.painel[f];
    if(!p||p.enviando)return;
    p.enviando=true;desenhar();
    api('/admin/api/ia/modelos/'+encodeURIComponent(f)+'/reverter',{method:'POST',body:{confirmado:true}}).then(function(d){
      delete M.painel[f];M.dados=d;desenhar();
      var b=$('ia-m-'+f+'-testar');if(b)b.focus();
      return recarregarTela().then(function(){anunciar(FRASE.revertido)});
    },function(e){p.enviando=false;p.erro=textoDoErro(e);desenhar()});
  });
}

/* O cartão de cada função tem um espaço [data-ia-modelos]; a tela IA chama montar() a cada desenho. */
function montar(raiz){
  M.raiz=raiz;
  if(M.dados){desenhar();if(!M.tempo)acompanhar()}
  else if(!M.carregando){
    M.carregando=true;
    desenhar();
    carregar().then(function(){M.carregando=false},function(){M.carregando=false});
  }
}
function reiniciar(){
  M.dados=null;M.painel={};M.escolhido={};M.carregando=false;
  if(M.tempo){clearTimeout(M.tempo);M.tempo=null}
}

window.__pvIaModelos={montar:montar,reiniciar:reiniciar};
/* Os formatadores de número, custo, tempo e data são os mesmos da seção de instruções (v0.61.0). */
window.__pvIaFormato={n:n,usd:usd,pct:pct,seg:seg,dth:dth,valor:valor,diferenca:diferenca};
})();
`;

export const ESTILOS_IA_ADMIN_MODELOS = `
.ia-mod{margin:16px 0 0;padding-top:12px;border-top:1px solid var(--linha);min-width:0}
.ia-m-h4{margin:0 0 6px;font-size:15.5px}
.ia-m-h5{margin:10px 0 4px;font-size:14.5px}
.ia-m-linha{margin:4px 0;overflow-wrap:anywhere}
.ia-m-aviso{margin:8px 0;padding:8px 10px;border:1px solid var(--atencao);border-radius:8px;background:var(--papel2);overflow-wrap:anywhere}
.ia-m-detalhe{margin:8px 0;display:grid;gap:4px}
.ia-m-detalhe>div{display:grid;grid-template-columns:minmax(0,.8fr) minmax(0,1.4fr);gap:8px;font-size:13.5px}
.ia-m-detalhe dt{color:var(--tinta2)}
.ia-m-detalhe dd{margin:0;min-width:0;overflow-wrap:anywhere}
.ia-mod select,.ia-mod input[type=text]{width:100%;max-width:100%;min-width:0}
.ia-m-barra{height:10px;border-radius:999px;background:var(--linha);overflow:hidden;margin:6px 0 10px}
.ia-m-barra span{display:block;height:100%;background:var(--acento);transition:width .3s}
.ia-m-veredito{margin:8px 0;font-size:15px}
.ia-m-v-aprovado strong{color:var(--verde-tinta)}
.ia-m-v-aprovado_com_ressalva strong{color:var(--atencao)}
.ia-m-v-bloqueado strong{color:var(--erro)}
.ia-m-bloqueios{border-left:3px solid var(--erro);padding-left:10px;margin:8px 0}
.ia-m-ressalvas{border-left:3px solid var(--atencao);padding-left:10px;margin:8px 0}
.ia-m-bloqueios p,.ia-m-ressalvas p{margin:0 0 2px}
.ia-m-tabela{width:100%;border-collapse:collapse;margin:10px 0;font-size:13.5px;table-layout:fixed}
.ia-m-tabela th,.ia-m-tabela td{padding:6px 6px;border-top:1px solid var(--linha);text-align:left;vertical-align:top;overflow-wrap:anywhere}
.ia-m-tabela thead th{color:var(--tinta2);font-weight:700}
.ia-m-tabela tbody th{font-weight:600}
.ia-m-melhor{color:var(--verde-tinta)}
.ia-m-pior{color:var(--erro)}
.ia-m-custo{margin:8px 0;padding:8px 10px;border:2px solid var(--linha);border-radius:8px;overflow-wrap:anywhere}
.ia-m-nota{margin-top:16px}
.ia-m-regras{margin:10px 0 0;font-size:13.5px}
.ia-m-regras summary{cursor:pointer;font-weight:700}
.ia-m-publicar,.ia-m-reverter{margin:10px 0}
/* Em tela estreita cada linha da tabela vira um bloco: nada de rolagem horizontal. */
@media (max-width:760px){
  .ia-m-tabela thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .ia-m-tabela,.ia-m-tabela tbody,.ia-m-tabela tr,.ia-m-tabela th,.ia-m-tabela td{display:block}
  .ia-m-tabela tr{border-top:1px solid var(--linha);padding:6px 0}
  .ia-m-tabela th,.ia-m-tabela td{border:0;padding:2px 0}
  .ia-m-tabela td::before{content:attr(data-rotulo) ": ";color:var(--tinta2)}
}
@media (max-width:520px){.ia-m-detalhe>div{grid-template-columns:minmax(0,1fr)}}
`;
