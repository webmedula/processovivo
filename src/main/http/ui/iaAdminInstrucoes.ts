/**
 * A seção "Instruções de interpretação" da tela "IA" do /admin (v0.61.0, Fase C do painel de IA). Módulo próprio:
 * o `iaAdmin.ts` só ganha um espaço (`data-ia-instrucoes`) e a chamada `montar`, e o `scriptAdmin.ts` só ganha a
 * pergunta "posso sair?" antes de trocar de aba.
 *
 * O ciclo da tela: escrever → (visualizar o prompt) → experimentar num caso real, lado a lado → publicar → reverter.
 * O conjunto de verificação, o histórico com comparação e "onde a IA erra" ficam logo abaixo, opcionais.
 *
 * O que a tela mostra vem de `/admin/api/ia/instrucoes*` e `/admin/api/ia/experimento*`: o TEXTO das instruções
 * (do próprio operador), números, rótulos fechados e frases NOSSAS. A única exceção é a resposta do experimento,
 * que traz o resultado da IA sobre UM caso da conta do próprio operador — vive só na memória desta página, nunca é
 * gravado e some ao sair da aba. Tudo que vem do servidor passa por `esc`; o texto digitado vai para a página por
 * `.value`, nunca por HTML.
 *
 * Aviso ao sair: `podeSair()` pergunta antes de trocar de aba com rascunho não salvo, e o `beforeunload` cobre fechar
 * ou recarregar a página.
 *
 * `tests/http/admin-script.spec.ts` roda o ESLint dentro desta string, como no resto do /admin.
 */
export const SCRIPT_IA_ADMIN_INSTRUCOES = String.raw`
(function(){
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

var FUNCOES=[['ato','Análise de ato'],['resumo','Resumo do processo'],['peca','Análise de peça']];
var M={dados:null,raiz:null,f:'ato',u:{},carregando:false,msg:'',tempo:null};
var FMT=window.__pvIaFormato||{};

var FRASE={
  carregando:'Carregando as instruções…',
  falha:'Não foi possível carregar as instruções agora. Tente de novo.',
  intro:'Aqui você ajusta COMO a IA interpreta e o que ela destaca: foco, prioridade, tom, tamanho e exemplos. O formato da resposta, a verificação das citações, a regra de não calcular prazo nem dar parecer, o segredo de justiça e a retenção zero de dados (ZDR) ficam no código e não mudam por aqui.',
  ciclo:'O ciclo é curto: escreva, experimente num caso real e publique. Publicar vale na hora para todas as contas; reverter é um clique.',
  aviso:'Não cole aqui texto de processos reais nem dados de pessoas: esta instrução é enviada ao modelo em toda análise. Use exemplos inventados.',
  vazioPadrao:'Sem instrução publicada: a IA usa o prompt padrão do sistema (+e0).',
  salvo:'Rascunho salvo.',publicado:'Instrução publicada. A próxima análise já usa esta versão.',
  revertido:'Instrução revertida.',
  erroGenerico:'Não foi possível concluir. Tente de novo.',
  sujo:'Alterações não salvas',limpo:'Tudo salvo',
  salvarAntes:'Salve o rascunho para poder publicar.',
  semRascunho:'Escreva a instrução e salve o rascunho para poder publicar.',
  iguais:'O rascunho é igual ao que está publicado.',
  leituraFalhou:'A leitura das instruções falhou no servidor: está valendo o prompt padrão (+e0).',
  expSemServico:'O experimento não está disponível para esta função neste servidor (a IA ou a Pasta digital está desligada).',
  expCasoEmFoco:'O texto do caso aparece só aqui, na sua tela: não é gravado em lugar nenhum e some quando você sai desta aba.',
  expRodando:'Rodando a instrução publicada e o rascunho no mesmo caso…',
  expSemProcessos:'A sua conta não tem processos acompanhados para escolher.',
  expSemAtos:'Este processo não tem atos para escolher.',
  expSemPecas:'Nenhuma peça deste processo está na guarda de 24 h. Abra a peça na Pasta digital do processo e volte aqui.',
  expSigiloso:'Processo em segredo de justiça: nada é enviado à IA.',
  verDuracao:'O conjunto de verificação chama o provedor de verdade com casos sintéticos, duas vezes (instrução publicada e rascunho), e pode levar vários minutos. Você pode sair desta tela: ele continua no servidor.',
  verNaoBloqueia:'A verificação é opcional e só informa: nada aqui impede de publicar.',
  verIndisponivel:'O conjunto de verificação não está disponível neste servidor (a IA está desligada no ambiente).',
  semHistorico:'Ainda não há versões publicadas desta função.',
  semErros:'Nenhum polegar para baixo nos últimos 30 dias.'
};

var ROTULO_ESTADO={na_fila:'Na fila',executando:'Em andamento',concluido:'Concluído',falhou:'Falhou',cancelado:'Cancelado'};
var ROTULO_ESTADO_VERSAO={publicada:'em uso',substituida:'substituída',rascunho:'rascunho'};

/* ---------- formatação (a mesma da parte "Modelo", exposta por ela) ---------- */
function n(v){return FMT.n?FMT.n(v):String(v)}
function usd(v,c){return FMT.usd?FMT.usd(v,c):String(v)}
function seg(ms){return FMT.seg?FMT.seg(ms):String(ms)}
function dth(iso){return FMT.dth?FMT.dth(iso):String(iso)}
function valor(formato,v){return FMT.valor?FMT.valor(formato,v):String(v)}
function diferenca(formato,v){return FMT.diferenca?FMT.diferenca(formato,v):String(v)}

/* ---------- rede ---------- */
function api(caminho,opcoes){
  opcoes=opcoes||{};
  var h={};
  if(opcoes.body)h['content-type']='application/json';
  return fetch(caminho,{method:opcoes.method||'GET',headers:h,cache:'no-store',signal:opcoes.sinal,
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
/* A tela IA se redesenha (o registro de mudanças da Fase A ganha a linha nova); o aviso vem depois, na região que sobrar. */
function recarregarTela(){
  return Promise.resolve(window.__pvIaAdmin&&window.__pvIaAdmin.recarregar?window.__pvIaAdmin.recarregar():null);
}
function textoDoErro(e){return (e&&e.mensagem)?e.mensagem:FRASE.erroGenerico}

/* ---------- estado ---------- */
function novoU(){
  return {texto:null,obs:null,baseTexto:'',baseObs:'',msg:'',
    previaAberta:false,previa:null,
    expAberto:false,exp:{processos:null,carregandoProcessos:false,erroProcessos:'',numero:'',atos:null,pecas:null,sigiloso:false,
      carregandoCaso:false,chave:'',rodando:false,resultado:null,erro:'',ctl:null},
    verAberto:false,ver:{estimativa:null,estimando:false,enviando:false,erro:''},
    painel:null,
    histAberto:false,hist:{verTexto:null,de:'',para:'',diff:null,erro:'',carregando:false},
    errosAberto:false,erros:null};
}
function U(f){if(!M.u[f])M.u[f]=novoU();return M.u[f]}
function funcaoDe(f){
  if(!M.dados)return null;
  for(var i=0;i<M.dados.funcoes.length;i++)if(M.dados.funcoes[i].funcao===f)return M.dados.funcoes[i];
  return null;
}
function sujo(f){var u=M.u[f];return !!u&&u.texto!==null&&(u.texto!==u.baseTexto||u.obs!==u.baseObs)}
function algumSujo(){for(var i=0;i<FUNCOES.length;i++)if(sujo(FUNCOES[i][0]))return true;return false}
function ativo(t){return !!t&&(t.estado==='na_fila'||t.estado==='executando')}

/* Alinha o editor com o que o servidor tem. Sem alterações do operador, o editor SEGUE o servidor; com alterações,
   só a base muda (o que ele digitou fica). "forcar" (depois de salvar) devolve o texto normalizado pelo servidor. */
function alinhar(f,forcar){
  var fd=funcaoDe(f),u=U(f);
  if(!fd)return;
  var base=fd.rascunho?fd.rascunho.texto:fd.publicada.texto;
  var baseObs=fd.rascunho?fd.rascunho.observacao:'';
  var estavaSujo=sujo(f);
  u.baseTexto=base;u.baseObs=baseObs;
  if(!estavaSujo||forcar||u.texto===null){u.texto=base;u.obs=baseObs}
}
function aplicar(dados,forcar){
  M.dados=dados;
  for(var i=0;i<FUNCOES.length;i++)alinhar(FUNCOES[i][0],forcar===FUNCOES[i][0]);
}

/* ---------- partes do desenho ---------- */
function abas(){
  var h='<div class="ia-i-abas" role="tablist" aria-label="Função de IA">';
  for(var i=0;i<FUNCOES.length;i++){
    var f=FUNCOES[i][0],fd=funcaoDe(f),sel=M.f===f;
    h+='<button type="button" role="tab" class="ia-i-aba" id="ia-i-aba-'+f+'" aria-selected="'+(sel?'true':'false')+'" aria-controls="ia-i-painel" tabindex="'+(sel?'0':'-1')+'" data-ia-i-aba="'+f+'">'+
      esc(FUNCOES[i][1])+' <span class="ia-mono">'+esc(fd?fd.publicada.rotulo:'')+'</span>'+(sujo(f)?' <span class="ia-i-ponto" title="'+esc(FRASE.sujo)+'">●<span class="ia-so-leitor"> '+esc(FRASE.sujo)+'</span></span>':'')+'</button>';
  }
  return h+'</div>';
}

function estadoDaVersao(fd){
  var h='<p class="ia-i-linha" id="ia-i-versao">Em uso: <strong class="ia-mono">'+esc(fd.versaoEfetiva)+'</strong>';
  if(fd.publicada.versao===0)h+=' · '+esc(FRASE.vazioPadrao);
  else{
    var atual=null;
    for(var i=0;i<fd.historico.length;i++)if(fd.historico[i].versao===fd.publicada.versao)atual=fd.historico[i];
    h+=' · publicada'+(atual&&atual.publicadoEm?' em '+esc(dth(atual.publicadoEm)):'')+(atual&&atual.publicadoPor?' · Por <span class="ia-mono">'+esc(atual.publicadoPorNome||atual.publicadoPor)+'</span>':'');
  }
  h+='</p>';
  if(fd.leituraFalhou)h+='<p class="ia-i-aviso" role="note">'+esc(FRASE.leituraFalhou)+'</p>';
  return h;
}

function editor(fd,u){
  var lim=M.dados.limites,len=(u.texto||'').length;
  var h='<div class="ia-i-editor">';
  h+='<div class="ia-campo"><label for="ia-i-texto">Instrução de interpretação — '+esc(fd.rotulo)+'</label>';
  h+='<textarea id="ia-i-texto" rows="12" spellcheck="true" autocomplete="off" aria-describedby="ia-i-contador ia-i-aviso-real"></textarea>';
  h+='<p class="ia-suave ia-i-contador" id="ia-i-contador"><span id="ia-i-conta">'+n(len)+'</span> de '+n(lim.texto)+' caracteres'+(len>lim.texto?' — <strong class="ia-acima">acima do limite: encurte o texto</strong>':'')+'</p>';
  h+='<p class="ia-suave" id="ia-i-aviso-real">'+esc(FRASE.aviso)+'</p></div>';
  h+='<div class="ia-campo"><label for="ia-i-obs">Observação curta (opcional, até '+n(lim.observacao)+' caracteres)</label>';
  h+='<input id="ia-i-obs" type="text" maxlength="'+lim.observacao+'" autocomplete="off"></div>';
  h+='<p class="ia-i-estado" id="ia-i-sujo" data-sujo="'+(sujo(M.f)?'1':'0')+'">'+esc(sujo(M.f)?FRASE.sujo:FRASE.limpo)+(u.msg?' · '+esc(u.msg):'')+'</p>';
  return h+'</div>';
}

function barraDeAcoes(fd,u){
  var lim=M.dados.limites,len=(u.texto||'').length;
  var s=sujo(M.f);
  var podeSalvar=s&&len<=lim.texto;
  var temRascunho=!!fd.rascunho;
  var vazio=(fd.rascunho?fd.rascunho.texto:'').trim()==='';
  var igual=temRascunho&&fd.rascunho.texto===fd.publicada.texto;
  var podePublicar=temRascunho&&!s&&!vazio;
  var ajuda='';
  if(!temRascunho)ajuda=FRASE.semRascunho;
  else if(s)ajuda=FRASE.salvarAntes;
  else if(vazio)ajuda='O rascunho está vazio: para voltar ao padrão, use Reverter.';
  else if(igual)ajuda=FRASE.iguais;
  var h='<div class="ia-i-acoes">';
  h+='<button type="button" class="bt" id="ia-i-salvar"'+(podeSalvar?'':' disabled')+'>Salvar rascunho</button> ';
  h+='<button type="button" class="bt2" id="ia-i-previa-bt" aria-expanded="'+(u.previaAberta?'true':'false')+'" aria-controls="ia-i-previa">Visualizar prompt montado</button> ';
  h+='<button type="button" class="bt2" id="ia-i-exp-bt" aria-expanded="'+(u.expAberto?'true':'false')+'" aria-controls="ia-i-exp">Experimentar num caso real</button> ';
  h+='<button type="button" class="bt2" id="ia-i-ver-bt" aria-expanded="'+(u.verAberto?'true':'false')+'" aria-controls="ia-i-ver">Rodar conjunto de verificação</button>';
  h+='</div>';
  h+='<div class="ia-i-acoes">';
  h+='<button type="button" class="bt" id="ia-i-publicar"'+(podePublicar&&!(u.painel&&u.painel.tipo==='publicar')?'':' disabled')+(ajuda?' aria-describedby="ia-i-pub-ajuda"':'')+'>Publicar</button> ';
  h+='<button type="button" class="bt2" id="ia-i-reverter"'+(fd.podeReverter?'':' disabled aria-describedby="ia-i-pub-ajuda"')+'>Reverter</button>';
  h+='</div>';
  h+='<p class="ia-suave" id="ia-i-pub-ajuda">'+esc(ajuda||(fd.podeReverter?'Reverter volta para '+fd.reverteParaRotulo+(fd.reverteParaRotulo==='+e0'?' (o prompt padrão)':'')+'.':'Não há instrução publicada para reverter.'))+'</p>';
  return h;
}

function confirmacao(fd,u){
  var p=u.painel;
  if(!p)return '';
  var h='<div class="ia-confirma" role="group" aria-labelledby="ia-i-conf-t">';
  if(p.tipo==='publicar'){
    h+='<p id="ia-i-conf-t"><strong>Publicar o rascunho '+esc(fd.rascunho.rotulo)+' na função "'+esc(fd.rotulo)+'"?</strong> A próxima análise de qualquer usuário já usa esta instrução. Você pode reverter com um clique.</p>';
    if(p.erro)h+='<p class="ia-i-aviso" role="alert">'+esc(p.erro)+'</p>';
    h+='<button type="button" class="bt" id="ia-i-pub-ok"'+(p.enviando?' disabled':'')+'>Sim, publicar</button> ';
    h+='<button type="button" class="bt2" id="ia-i-pub-cancelar">Cancelar</button>';
  }else{
    h+='<p id="ia-i-conf-t"><strong>Voltar para '+esc(fd.reverteParaRotulo)+(fd.reverteParaRotulo==='+e0'?' (o prompt padrão)':'')+' na função "'+esc(fd.rotulo)+'"?</strong> A instrução em uso sai de produção agora; o texto dela continua no histórico.</p>';
    if(p.erro)h+='<p class="ia-i-aviso" role="alert">'+esc(p.erro)+'</p>';
    h+='<button type="button" class="bt" id="ia-i-rev-ok"'+(p.enviando?' disabled':'')+'>Sim, reverter</button> ';
    h+='<button type="button" class="bt2" id="ia-i-rev-cancelar">Cancelar</button>';
  }
  return h+'</div>';
}

/* ----- prévia do prompt montado ----- */
function blocoDaPrevia(titulo,texto,id){
  return '<div class="ia-i-bloco"><h4 class="ia-i-h5" id="'+id+'-t">'+esc(titulo)+'</h4>'+
    '<pre class="ia-i-pre" id="'+id+'" tabindex="0" role="region" aria-labelledby="'+id+'-t">'+esc(texto===''?'(vazio)':texto)+'</pre></div>';
}
function painelDaPrevia(u){
  if(!u.previaAberta)return '';
  var p=u.previa;
  var h='<section class="ia-i-painel" id="ia-i-previa" aria-labelledby="ia-i-previa-t"><h3 class="ia-i-h4" id="ia-i-previa-t" tabindex="-1">Prompt montado</h3>';
  if(!p||p.carregando)return h+'<p class="ia-suave">Montando…</p></section>';
  if(p.erro)return h+'<p class="ia-i-aviso" role="alert">'+esc(p.erro)+'</p></section>';
  var d=p.dados;
  h+='<p class="ia-suave">A ordem é sempre a mesma: parte fixa, a sua instrução e o lembrete final. No lugar do texto do caso vai um exemplo fictício. Sem instrução, o prompt é só a parte fixa.</p>';
  h+=blocoDaPrevia('1. Parte fixa (código, não editável)',d.fixa,'ia-i-p-fixa');
  h+=blocoDaPrevia('2. A sua instrução',d.editavel,'ia-i-p-edit');
  h+=blocoDaPrevia('3. Lembrete final (código, não editável)',d.lembrete,'ia-i-p-lemb');
  h+=blocoDaPrevia('4. Formato da resposta (acrescentado pelo sistema)',d.formato,'ia-i-p-form');
  h+=blocoDaPrevia('5. Mensagem do caso (exemplo fictício)',d.exemplo,'ia-i-p-exem');
  return h+'<button type="button" class="bt2" id="ia-i-previa-fechar">Fechar a prévia</button></section>';
}

/* ----- experimento ----- */
function selectDe(id,rotulo,opcoes,valorAtual,vazio,desabilitado){
  var h='<div class="ia-campo"><label for="'+id+'">'+esc(rotulo)+'</label><select id="'+id+'"'+(desabilitado?' disabled':'')+'>';
  h+='<option value=""'+(valorAtual===''?' selected':'')+'>'+esc(vazio)+'</option>';
  for(var i=0;i<opcoes.length;i++){
    h+='<option value="'+esc(opcoes[i].valor)+'"'+(opcoes[i].valor===valorAtual?' selected':'')+(opcoes[i].desabilitada?' disabled':'')+'>'+esc(opcoes[i].texto)+'</option>';
  }
  return h+'</select></div>';
}
function listaDeAtos(u){
  var ops=[];
  for(var i=0;i<u.exp.atos.length;i++){
    var a=u.exp.atos[i];
    ops.push({valor:a.chaveDoAto,texto:dth(a.data).slice(0,10)+' · '+a.titulo+(a.tipoComunicacao?' ('+a.tipoComunicacao+')':'')+(a.legivel?'':' — sem texto suficiente'),desabilitada:!a.legivel});
  }
  return ops;
}
function listaDePecas(u){
  var ops=[];
  for(var i=0;i<u.exp.pecas.length;i++){
    var p=u.exp.pecas[i];
    ops.push({valor:p.pecaId,texto:p.rotulo+(p.data?' · '+dth(p.data).slice(0,10):'')+(p.paginas?' · '+p.paginas+' pág.':'')});
  }
  return ops;
}
function escolhaDoCaso(fd,u){
  var x=u.exp,h='';
  if(!fd.experimentoDisponivel)return '<p class="ia-suave">'+esc(FRASE.expSemServico)+'</p>';
  if(x.carregandoProcessos&&!x.processos)return '<p class="ia-suave">Carregando os seus processos…</p>';
  if(x.erroProcessos)return '<p class="ia-i-aviso" role="alert">'+esc(x.erroProcessos)+'</p>';
  if(!x.processos)return '';
  if(!x.processos.length)return '<p class="ia-suave">'+esc(FRASE.expSemProcessos)+'</p>';
  var procs=[];
  for(var i=0;i<x.processos.length;i++){
    var p=x.processos[i];
    procs.push({valor:p.numero,texto:p.numeroFormatado+' · '+p.tribunal+(p.classe?' · '+p.classe:'')+(p.sigiloso?' · segredo de justiça':'')+' · '+p.atos+' atos'});
  }
  h+=selectDe('ia-i-exp-proc','Processo (da sua conta)',procs,x.numero,'Escolha um processo',x.rodando);
  if(x.numero&&x.sigiloso)h+='<p class="ia-i-aviso" role="note">'+esc(FRASE.expSigiloso)+'</p>';
  if(x.numero&&!x.sigiloso&&M.f==='ato'){
    if(x.carregandoCaso)h+='<p class="ia-suave">Carregando os atos…</p>';
    else if(x.atos&&!x.atos.length)h+='<p class="ia-suave">'+esc(FRASE.expSemAtos)+'</p>';
    else if(x.atos)h+=selectDe('ia-i-exp-ato','Ato',listaDeAtos(u),x.chave,'Escolha um ato',x.rodando);
  }
  if(x.numero&&!x.sigiloso&&M.f==='peca'){
    if(x.carregandoCaso)h+='<p class="ia-suave">Carregando as peças…</p>';
    else if(x.pecas&&!x.pecas.length)h+='<p class="ia-suave">'+esc(FRASE.expSemPecas)+'</p>';
    else if(x.pecas)h+=selectDe('ia-i-exp-peca','Peça (na guarda de 24 h)',listaDePecas(u),x.chave,'Escolha uma peça',x.rodando);
  }
  var pronto=!!x.numero&&!x.sigiloso&&(M.f==='resumo'||!!x.chave);
  h+='<div class="ia-acoes"><button type="button" class="bt" id="ia-i-exp-rodar"'+(pronto&&!x.rodando?'':' disabled')+'>Experimentar</button> ';
  if(x.rodando)h+='<button type="button" class="bt2" id="ia-i-exp-cancelar">Cancelar</button> ';
  if(x.resultado&&!x.rodando)h+='<button type="button" class="bt2" id="ia-i-exp-outro">Experimentar em outro caso</button>';
  return h+'</div>';
}
function coluna(b,fd){
  var rot=b.rotulo==='publicada'?'Instrução publicada':'Rascunho';
  var ver=b.rotulo==='rascunho'&&b.versao===0?'não salvo':b.versaoRotulo;
  var h='<article class="ia-i-col" data-braco="'+esc(b.rotulo)+'" aria-labelledby="ia-i-col-'+esc(b.rotulo)+'-t">';
  h+='<h4 class="ia-i-h4" id="ia-i-col-'+esc(b.rotulo)+'-t">'+esc(rot)+' <span class="ia-mono">'+esc(ver)+'</span></h4>';
  if(b.estado==='erro')return h+'<p class="ia-i-aviso" role="note">Não foi possível obter a resposta do modelo para esta instrução.</p></article>';
  h+='<p class="'+(b.verificado?'ia-i-ok':'ia-i-mal')+'" data-verificado="'+(b.verificado?'1':'0')+'">'+(b.verificado?'✓ Verificada':'✗ Não verificada'+(b.motivoDeNaoVerificacaoFrase?' — '+esc(b.motivoDeNaoVerificacaoFrase):''))+'</p>';
  for(var i=0;i<b.secoes.length;i++){
    var s=b.secoes[i];
    h+='<h5 class="ia-i-h5">'+esc(s.titulo)+'</h5><ul class="ia-i-itens">';
    for(var j=0;j<s.itens.length;j++){
      var it=s.itens[j];
      h+='<li>'+esc(it.texto)+(it.nota?' <span class="ia-suave">('+esc(it.nota)+')</span>':'')+(it.citacao?'<blockquote class="ia-i-cit"><span class="ia-i-cit-rotulo">Citação:</span> '+esc(it.citacao)+'</blockquote>':'')+'</li>';
    }
    h+='</ul>';
  }
  h+='<h5 class="ia-i-h5">Descartado pela verificação</h5>';
  if(!b.descartes.length)h+='<p class="ia-suave">Nada foi descartado.</p>';
  else{h+='<ul class="ia-i-itens">';for(var k=0;k<b.descartes.length;k++)h+='<li>'+n(b.descartes[k].quantidade)+' × '+esc(b.descartes[k].rotulo)+'</li>';h+='</ul>'}
  if(b.citacoes)h+='<p class="ia-suave">Citações do modelo que existem no texto: '+n(b.citacoes.validas)+' de '+n(b.citacoes.emitidas)+'.</p>';
  h+='<dl class="ia-i-med"><div><dt>Tempo</dt><dd>'+esc(seg(b.latenciaMs))+'</dd></div>'+
    '<div><dt>Custo</dt><dd>'+esc(b.custoUsd==null?'não informado':usd(b.custoUsd,5))+'</dd></div>'+
    '<div><dt>Tokens (entrada → saída)</dt><dd>'+(b.tokensEntrada==null?'—':n(b.tokensEntrada))+' → '+(b.tokensSaida==null?'—':n(b.tokensSaida))+'</dd></div>'+
    '<div><dt>Modelo</dt><dd class="ia-mono">'+esc(b.modelo)+'</dd></div></dl>';
  return h+'</article>';
}
function painelDoExperimento(fd,u){
  if(!u.expAberto)return '';
  var x=u.exp;
  var h='<section class="ia-i-painel" id="ia-i-exp" aria-labelledby="ia-i-exp-t"><h3 class="ia-i-h4" id="ia-i-exp-t" tabindex="-1">Experimentar num caso real</h3>';
  h+='<p class="ia-suave">Roda a instrução publicada e o rascunho (do jeito que está na caixa acima, mesmo sem salvar) no mesmo caso da sua conta e mostra as duas respostas lado a lado. '+esc(FRASE.expCasoEmFoco)+'</p>';
  h+=escolhaDoCaso(fd,u);
  if(x.rodando)h+='<p class="ia-suave" role="status" aria-busy="true">'+esc(FRASE.expRodando)+'</p>';
  if(x.erro)h+='<p class="ia-i-aviso" role="alert">'+esc(x.erro)+'</p>';
  if(x.resultado){
    h+='<div class="ia-i-lado" id="ia-i-lado" aria-label="Respostas lado a lado">';
    for(var i=0;i<x.resultado.bracos.length;i++)h+=coluna(x.resultado.bracos[i],fd);
    h+='</div>';
  }
  return h+'<button type="button" class="bt2" id="ia-i-exp-fechar">Fechar o experimento</button></section>';
}

/* ----- conjunto de verificação ----- */
function tabelaDaVerificacao(v){
  if(!v.comparacao)return '';
  var h='<table class="ia-m-tabela"><caption class="ia-so-leitor">Comparação entre o rascunho e a instrução publicada</caption>';
  h+='<thead><tr><th scope="col">Medida</th><th scope="col">Publicada</th><th scope="col">Rascunho ('+esc(v.rascunho)+')</th><th scope="col">Diferença</th></tr></thead><tbody>';
  for(var i=0;i<v.comparacao.length;i++){
    var l=v.comparacao[i];
    var marca=l.melhor===true?'melhor':(l.melhor===false?'pior':'igual');
    h+='<tr><th scope="row">'+esc(l.rotulo)+'</th>'+
      '<td data-rotulo="Publicada">'+esc(valor(l.formato,l.referencia))+'</td>'+
      '<td data-rotulo="Rascunho">'+esc(valor(l.formato,l.candidato))+'</td>'+
      '<td data-rotulo="Diferença" class="ia-m-'+marca+'">'+esc(diferenca(l.formato,l.diferenca))+(l.diferenca==null?'':' ('+marca+')')+'</td></tr>';
  }
  return h+'</tbody></table>';
}
function resultadoDaVerificacao(v){
  var h='<div class="ia-i-verres" aria-labelledby="ia-i-verres-t"><h4 class="ia-i-h5" id="ia-i-verres-t">Última verificação</h4>';
  h+='<p class="ia-i-linha">Rascunho <span class="ia-mono">'+esc(v.rascunho)+'</span> × publicada · modelo <span class="ia-mono">'+esc(v.modelo)+'</span> · <strong data-ia-i-ver-estado="1">'+esc(ROTULO_ESTADO[v.estado]||v.estado)+'</strong> · '+esc(dth(v.criadoEm))+'</p>';
  if(ativo(v)){
    h+='<p id="ia-i-ver-prog" data-ia-i-prog="1">'+n(v.chamadasFeitas)+' de '+n(v.chamadasPrevistas)+' chamadas</p>';
    h+='<div class="ia-m-barra" role="progressbar" aria-label="Andamento da verificação" aria-valuemin="0" aria-valuemax="'+v.chamadasPrevistas+'" aria-valuenow="'+v.chamadasFeitas+'"><span style="width:'+(v.chamadasPrevistas?Math.round(100*v.chamadasFeitas/v.chamadasPrevistas):0)+'%"></span></div>';
    h+='<button type="button" class="bt2" id="ia-i-ver-cancelar" data-ia-i-ver-cancelar="'+esc(v.id)+'">Cancelar a verificação</button>';
  }else if(v.estado==='falhou'&&v.falha){
    h+='<p class="ia-i-aviso" role="note">'+esc(v.falha.frase)+'</p>';
  }else if(v.estado==='cancelado'){
    h+='<p class="ia-suave">A verificação foi cancelada.</p>';
  }else if(v.estado==='concluido'){
    if(v.avisos&&v.avisos.length){
      h+='<div class="ia-i-avisos" role="group" aria-label="Avisos de piora"><p><strong>Avisos de piora do rascunho</strong> (informam, não bloqueiam a publicação)</p><ul class="ia-lista">';
      for(var i=0;i<v.avisos.length;i++)h+='<li class="ia-i-av-'+esc(v.avisos[i].gravidade)+'">'+(v.avisos[i].gravidade==='grave'?'<strong>Atenção:</strong> ':'')+esc(v.avisos[i].frase)+'</li>';
      h+='</ul></div>';
    }else if(v.semPiora){
      h+='<p class="ia-i-ok">✓ Nenhuma piora: o rascunho ficou igual ou melhor em tudo o que foi medido.</p>';
    }
    h+=tabelaDaVerificacao(v);
    h+='<p class="ia-suave">Rodada: '+esc(usd(v.gastoUsd,4))+' gastos.</p>';
  }
  return h+'</div>';
}
function painelDaVerificacao(fd,u){
  if(!u.verAberto)return '';
  var d=M.dados,v=u.ver;
  var h='<section class="ia-i-painel" id="ia-i-ver" aria-labelledby="ia-i-ver-t"><h3 class="ia-i-h4" id="ia-i-ver-t" tabindex="-1">Conjunto de verificação</h3>';
  h+='<p class="ia-suave">'+esc(FRASE.verNaoBloqueia)+' Roda 48 casos sintéticos (ato), 8 (resumo) ou 24 (peça), no modelo em uso, duas vezes.</p>';
  if(!d.verificacao.disponivel){return h+'<p class="ia-suave">'+esc(FRASE.verIndisponivel)+'</p></section>'}
  var emAndamento=d.verificacao.emAndamento;
  if(v.estimativa){
    var e=v.estimativa;
    h+='<div class="ia-confirma" role="group" aria-labelledby="ia-i-ver-est-t"><p id="ia-i-ver-est-t"><strong>Estimativa da verificação</strong></p>';
    h+='<ul class="ia-lista"><li>Chamadas ao provedor: <strong>'+n(e.chamadas)+'</strong> (instrução publicada e rascunho, casos sintéticos)</li>';
    h+='<li>Custo estimado: <strong>'+esc(e.custoEstimadoUsd==null?'sem preço para estimar':usd(e.custoEstimadoUsd,4))+'</strong> · teto da rodada: <strong>'+esc(usd(e.tetoUsd,2))+'</strong></li></ul>';
    h+='<p class="ia-suave">'+esc(FRASE.verDuracao)+'</p>';
    if(e.acimaDoTeto)h+='<p class="ia-i-aviso" role="alert">A estimativa passa do teto da rodada. A verificação não pode começar.</p>';
    if(v.erro)h+='<p class="ia-i-aviso" role="alert">'+esc(v.erro)+'</p>';
    h+='<button type="button" class="bt" id="ia-i-ver-iniciar"'+(e.acimaDoTeto||v.enviando?' disabled':'')+'>Confirmar e rodar</button> ';
    h+='<button type="button" class="bt2" id="ia-i-ver-descartar">Cancelar</button></div>';
  }else{
    var bloq=ativo(emAndamento)||v.estimando;
    h+='<div class="ia-acoes"><button type="button" class="bt" id="ia-i-ver-estimar"'+(bloq?' disabled':'')+'>Estimar e rodar</button></div>';
    if(ativo(emAndamento)&&emAndamento.funcao!==M.f)h+='<p class="ia-suave">Já existe uma verificação em andamento em outra função. Só uma roda por vez.</p>';
    if(v.erro)h+='<p class="ia-i-aviso" role="alert">'+esc(v.erro)+'</p>';
  }
  if(fd.ultimaVerificacao)h+=resultadoDaVerificacao(fd.ultimaVerificacao);
  else h+='<p class="ia-suave">Ainda não há verificação desta função.</p>';
  return h+'<button type="button" class="bt2" id="ia-i-ver-fechar">Fechar</button></section>';
}

/* ----- histórico e comparação ----- */
function opcoesDeVersao(fd){
  var ops=[{valor:'0',texto:'+e0 — prompt padrão (sem instrução)'}];
  for(var i=fd.historico.length-1;i>=0;i--){
    var h=fd.historico[i];
    ops.push({valor:String(h.versao),texto:h.rotulo+' — '+(ROTULO_ESTADO_VERSAO[h.estado]||h.estado)});
  }
  if(fd.rascunho)ops.push({valor:String(fd.rascunho.versao),texto:fd.rascunho.rotulo+' — rascunho salvo'});
  return ops;
}
/* O que os dois seletores de "Comparar" mostram quando a pessoa ainda não escolheu: o padrão (+e0) e a versão em uso. */
function escolhasDeComparar(fd,hv){
  var ops=opcoesDeVersao(fd);
  var de=hv.de||ops[0].valor;
  var para=hv.para||String(fd.rascunho&&fd.publicada.versao===0?fd.rascunho.versao:fd.publicada.versao);
  return {de:de,para:para};
}
function painelDoHistorico(fd,u){
  var aberto=u.histAberto;
  var h='<section class="ia-i-sec" aria-labelledby="ia-i-hist-t"><h3 class="ia-i-h4"><button type="button" class="ia-i-disc" id="ia-i-hist-bt" aria-expanded="'+(aberto?'true':'false')+'" aria-controls="ia-i-hist"><span aria-hidden="true">'+(aberto?'▾':'▸')+'</span> <span id="ia-i-hist-t">Histórico de versões</span></button></h3>';
  if(!aberto)return h+'</section>';
  h+='<div id="ia-i-hist">';
  if(!fd.historico.length)h+='<p class="ia-suave">'+esc(FRASE.semHistorico)+'</p>';
  else{
    h+='<ul class="ia-i-versoes">';
    for(var i=0;i<fd.historico.length;i++){
      var v=fd.historico[i];
      h+='<li data-versao="'+v.versao+'"><span class="ia-mono">'+esc(v.rotulo)+'</span> · '+esc(ROTULO_ESTADO_VERSAO[v.estado]||v.estado)+
        ' · '+esc(dth(v.publicadoEm||v.criadoEm))+(v.publicadoPor||v.autor?' · Por <span class="ia-mono">'+esc(v.publicadoPorNome||v.por||v.autor)+'</span>':'')+' · '+n(v.caracteres)+' caracteres'+
        (v.observacao?' · <em>'+esc(v.observacao)+'</em>':'')+
        ' <button type="button" class="bt2 ia-i-peq" data-ia-i-ver-texto="'+v.versao+'">Ver o texto</button>'+
        ' <button type="button" class="bt2 ia-i-peq" data-ia-i-usar="'+v.versao+'">Usar como rascunho</button></li>';
    }
    h+='</ul>';
  }
  var hv=u.hist;
  if(hv.verTexto){
    h+='<div class="ia-i-bloco"><h4 class="ia-i-h5" id="ia-i-vt-t">Texto de '+esc(hv.verTexto.rotulo)+'</h4><pre class="ia-i-pre" id="ia-i-vt" tabindex="0" role="region" aria-labelledby="ia-i-vt-t">'+esc(hv.verTexto.texto===''?'(vazio)':hv.verTexto.texto)+'</pre></div>';
  }
  var ops=opcoesDeVersao(fd),esc2=escolhasDeComparar(fd,hv);
  h+='<div class="ia-i-comparar"><div class="ia-campo"><label for="ia-i-diff-de">Comparar</label><select id="ia-i-diff-de">';
  for(var a=0;a<ops.length;a++)h+='<option value="'+esc(ops[a].valor)+'"'+(ops[a].valor===esc2.de?' selected':'')+'>'+esc(ops[a].texto)+'</option>';
  h+='</select></div><div class="ia-campo"><label for="ia-i-diff-para">com</label><select id="ia-i-diff-para">';
  for(var b=0;b<ops.length;b++)h+='<option value="'+esc(ops[b].valor)+'"'+(ops[b].valor===esc2.para?' selected':'')+'>'+esc(ops[b].texto)+'</option>';
  h+='</select></div><button type="button" class="bt2" id="ia-i-diff-ir"'+(hv.carregando?' disabled':'')+'>Comparar</button></div>';
  if(hv.erro)h+='<p class="ia-i-aviso" role="alert">'+esc(hv.erro)+'</p>';
  if(hv.diff){
    h+='<div class="ia-i-bloco"><h4 class="ia-i-h5" id="ia-i-diff-t">Diferença: '+esc(hv.diff.deRotulo)+' → '+esc(hv.diff.paraRotulo)+'</h4>';
    var mudou=false;
    for(var k=0;k<hv.diff.linhas.length;k++)if(hv.diff.linhas[k].tipo!=='igual')mudou=true;
    if(!mudou)h+='<p class="ia-suave">Os dois textos são iguais.</p>';
    else{
      h+='<div class="ia-i-diff" id="ia-i-diff" tabindex="0" role="region" aria-labelledby="ia-i-diff-t"><ul class="ia-i-diff-lista">';
      for(var m=0;m<hv.diff.linhas.length;m++){
        var l=hv.diff.linhas[m];
        var marca=l.tipo==='adicionada'?'+':(l.tipo==='removida'?'−':' ');
        var leitor=l.tipo==='adicionada'?'Adicionada: ':(l.tipo==='removida'?'Removida: ':'');
        h+='<li class="ia-i-d-'+esc(l.tipo)+'"><span class="ia-i-d-marca" aria-hidden="true">'+marca+'</span>'+(leitor?'<span class="ia-so-leitor">'+leitor+'</span>':'')+esc(l.texto===''?' ':l.texto)+'</li>';
      }
      h+='</ul></div>';
    }
    h+='</div>';
  }
  return h+'</div></section>';
}

/* ----- onde a IA erra ----- */
function painelDosErros(fd,u){
  var aberto=u.errosAberto;
  var h='<section class="ia-i-sec" aria-labelledby="ia-i-erros-t"><h3 class="ia-i-h4"><button type="button" class="ia-i-disc" id="ia-i-erros-bt" aria-expanded="'+(aberto?'true':'false')+'" aria-controls="ia-i-erros"><span aria-hidden="true">'+(aberto?'▾':'▸')+'</span> <span id="ia-i-erros-t">Onde a IA erra</span></button></h3>';
  if(!aberto)return h+'</section>';
  h+='<div id="ia-i-erros">';
  var e=u.erros;
  if(!e||e.carregando)return h+'<p class="ia-suave">Carregando…</p></div></section>';
  if(e.erro)return h+'<p class="ia-i-aviso" role="alert">'+esc(e.erro)+'</p></div></section>';
  var d=e.dados,a=d.atual,avaliadas=a.uteis+a.erradas+a.perigosas;
  h+='<p class="ia-suave">Polegares dados pelos usuários nos últimos '+n(d.dias)+' dias, por versão das instruções. Mostra só a data, a versão, o motivo escolhido e o modelo — nunca o conteúdo da análise.</p>';
  h+='<p class="ia-i-linha" id="ia-i-erros-atual">Versão atual <strong class="ia-mono">'+esc(a.rotulo)+'</strong>: '+n(a.analises)+' análises · '+n(a.uteis)+' polegar para cima · '+n(a.erradas+a.perigosas)+' para baixo'+(avaliadas?' de '+n(avaliadas)+' avaliadas':'')+' · '+n(a.naoVerificadas)+' não verificadas</p>';
  if(d.porEdicao.length){
    h+='<table class="ia-m-tabela"><caption class="ia-so-leitor">Polegares por versão das instruções</caption><thead><tr><th scope="col">Versão</th><th scope="col">Análises</th><th scope="col">Para cima</th><th scope="col">Para baixo</th><th scope="col">Sem avaliação</th><th scope="col">Não verificadas</th></tr></thead><tbody>';
    for(var i=0;i<d.porEdicao.length;i++){
      var p=d.porEdicao[i];
      h+='<tr><th scope="row" class="ia-mono">'+esc(p.rotulo)+'</th><td data-rotulo="Análises">'+n(p.analises)+'</td><td data-rotulo="Para cima">'+n(p.uteis)+'</td><td data-rotulo="Para baixo">'+n(p.erradas+p.perigosas)+'</td><td data-rotulo="Sem avaliação">'+n(p.semAvaliacao)+'</td><td data-rotulo="Não verificadas">'+n(p.naoVerificadas)+'</td></tr>';
    }
    h+='</tbody></table>';
  }
  h+='<h4 class="ia-i-h5">Polegares para baixo mais recentes</h4>';
  if(!d.recentes.length)h+='<p class="ia-suave">'+esc(FRASE.semErros)+'</p>';
  else{
    h+='<ul class="ia-i-erros-lista">';
    for(var j=0;j<d.recentes.length;j++){
      var r=d.recentes[j];
      h+='<li>'+esc(dth(r.em))+' · <span class="ia-mono">'+esc(r.versao)+'</span> · '+(r.avaliacao==='perigoso'?'pode causar prejuízo':'errado')+' · motivo: '+esc(r.motivoRotulo||'não informado')+(r.naoVerificada?' · não verificada':'')+' · modelo <span class="ia-mono">'+esc(r.modelo)+'</span> · conta <span class="ia-mono">'+esc(r.conta)+'</span></li>';
    }
    h+='</ul>';
  }
  return h+'</div></section>';
}

/* ---------- desenho principal ---------- */
function corpo(){
  var fd=funcaoDe(M.f),u=U(M.f);
  var h='<div role="tabpanel" id="ia-i-painel" aria-labelledby="ia-i-aba-'+M.f+'" tabindex="-1">';
  h+=estadoDaVersao(fd)+editor(fd,u)+barraDeAcoes(fd,u)+confirmacao(fd,u)+painelDaPrevia(u)+painelDoExperimento(fd,u)+painelDaVerificacao(fd,u)+painelDoHistorico(fd,u)+painelDosErros(fd,u);
  return h+'</div>';
}

function desenhar(){
  var alvo=M.raiz?M.raiz.querySelector('[data-ia-instrucoes]'):null;
  if(!alvo)return;
  var foco=document.activeElement&&document.activeElement.id;
  if(!M.dados){
    alvo.innerHTML='<h2 id="ia-ins-t" class="ia-h2">Instruções de interpretação</h2><p class="ia-suave">'+esc(M.msg||FRASE.carregando)+'</p>';
    return;
  }
  var h='<h2 id="ia-ins-t" class="ia-h2">Instruções de interpretação</h2>';
  h+='<div class="cartao ia-cartao ia-i-cartao"><p class="ia-intro">'+esc(FRASE.intro)+'</p><p class="ia-suave">'+esc(FRASE.ciclo)+'</p>'+abas()+corpo()+'</div>';
  alvo.innerHTML=h;
  var u=U(M.f),t=$('ia-i-texto'),o=$('ia-i-obs');
  if(t)t.value=u.texto||'';
  if(o)o.value=u.obs||'';
  ligar();
  if(foco&&$(foco)&&document.activeElement!==$(foco))$(foco).focus();
}

/* Só o que muda ao digitar: o contador, o selo "não salvo" e os botões — o foco e o cursor ficam onde estão. */
function atualizarAoDigitar(){
  var fd=funcaoDe(M.f),u=U(M.f),lim=M.dados.limites,len=(u.texto||'').length;
  var conta=$('ia-i-conta');if(conta)conta.textContent=n(len);
  var c=$('ia-i-contador');
  if(c){
    var extra=c.querySelector('.ia-acima');
    if(len>lim.texto&&!extra)c.insertAdjacentHTML('beforeend',' — <strong class="ia-acima">acima do limite: encurte o texto</strong>');
    else if(len<=lim.texto&&extra&&extra.parentNode)extra.parentNode.removeChild(extra);
  }
  var s=sujo(M.f),el=$('ia-i-sujo');
  if(el){el.setAttribute('data-sujo',s?'1':'0');el.textContent=s?FRASE.sujo:FRASE.limpo}
  var salvar=$('ia-i-salvar');if(salvar)salvar.disabled=!(s&&len<=lim.texto);
  var pub=$('ia-i-publicar');
  if(pub){
    var vazio=(fd.rascunho?fd.rascunho.texto:'').trim()==='';
    pub.disabled=!(fd.rascunho&&!s&&!vazio)||!!(u.painel&&u.painel.tipo==='publicar');
  }
  var aj=$('ia-i-pub-ajuda');
  if(aj&&!fd.rascunho)aj.textContent=FRASE.semRascunho;
  else if(aj&&s)aj.textContent=FRASE.salvarAntes;
  var aba=$('ia-i-aba-'+M.f);
  if(aba){
    var ponto=aba.querySelector('.ia-i-ponto');
    if(s&&!ponto)aba.insertAdjacentHTML('beforeend',' <span class="ia-i-ponto" title="'+esc(FRASE.sujo)+'">●<span class="ia-so-leitor"> '+esc(FRASE.sujo)+'</span></span>');
    else if(!s&&ponto&&ponto.parentNode)ponto.parentNode.removeChild(ponto);
  }
}

/* ---------- ações ---------- */
function carregar(){
  return api('/admin/api/ia/instrucoes').then(function(d){
    aplicar(d);M.msg='';desenhar();acompanhar();
  },function(){M.dados=null;M.msg=FRASE.falha;desenhar()});
}

function acompanhar(){
  if(M.tempo){clearTimeout(M.tempo);M.tempo=null}
  var t=M.dados&&M.dados.verificacao&&M.dados.verificacao.emAndamento;
  if(!ativo(t))return;
  M.tempo=setTimeout(function(){
    M.tempo=null;
    if(!M.raiz||!document.body.contains(M.raiz))return;
    api('/admin/api/ia/verificacoes/'+encodeURIComponent(t.id)).then(function(novo){
      if(ativo(novo)){
        M.dados.verificacao.emAndamento=novo;
        var fd=funcaoDe(novo.funcao);if(fd)fd.ultimaVerificacao=novo;
        /* só o progresso muda: o resto da tela fica quieto (foco e digitação preservados) */
        var p=$('ia-i-ver-prog');
        if(p)p.textContent=n(novo.chamadasFeitas)+' de '+n(novo.chamadasPrevistas)+' chamadas';
        var b=M.raiz.querySelector('#ia-i-ver-prog + [role="progressbar"]');
        if(b){b.setAttribute('aria-valuenow',novo.chamadasFeitas);
          var s=b.firstChild;if(s&&s.style)s.style.width=(novo.chamadasPrevistas?Math.round(100*novo.chamadasFeitas/novo.chamadasPrevistas):0)+'%'}
        acompanhar();
      }else{
        M.dados.verificacao.emAndamento=null;
        var fd2=funcaoDe(novo.funcao);if(fd2)fd2.ultimaVerificacao=novo;
        desenhar();
        anunciar('Verificação terminada: '+(ROTULO_ESTADO[novo.estado]||novo.estado)+'.');
      }
    },function(){acompanhar()});
  },2000);
}

function abrirPainel(chave,idPainel,idTitulo){
  var u=U(M.f);
  u[chave]=true;
  desenhar();
  var t=$(idTitulo||idPainel+'-t');if(t)t.focus();
}
function fecharPainel(chave,idBotao){
  U(M.f)[chave]=false;
  desenhar();
  var b=$(idBotao);if(b)b.focus();
}

function salvarRascunho(){
  var f=M.f,u=U(f);
  api('/admin/api/ia/instrucoes/'+encodeURIComponent(f)+'/rascunho',{method:'PUT',body:{texto:u.texto||'',observacao:u.obs||''}}).then(function(d){
    aplicar(d,f);u.msg=FRASE.salvo;desenhar();anunciar(FRASE.salvo);
    var b=$('ia-i-texto');if(b)b.focus();
  },function(e){u.msg='';desenhar();anunciar(textoDoErro(e));
    var el=$('ia-i-sujo');if(el)el.textContent=FRASE.sujo+' · '+textoDoErro(e)});
}

function carregarProcessos(){
  var u=U(M.f),x=u.exp;
  if(x.processos||x.carregandoProcessos)return;
  x.carregandoProcessos=true;x.erroProcessos='';
  api('/admin/api/ia/experimento/processos').then(function(d){
    x.processos=d.processos;x.carregandoProcessos=false;desenhar();
  },function(e){x.carregandoProcessos=false;x.erroProcessos=textoDoErro(e);desenhar()});
}
function carregarCaso(){
  var f=M.f,x=U(f).exp;
  x.atos=null;x.pecas=null;x.chave='';x.sigiloso=false;
  if(!x.numero||f==='resumo'){
    /* o resumo é do processo inteiro: só o sigilo vem da lista */
    for(var i=0;i<(x.processos||[]).length;i++)if(x.processos[i].numero===x.numero)x.sigiloso=!!x.processos[i].sigiloso;
    desenhar();return;
  }
  x.carregandoCaso=true;desenhar();
  var rota=f==='ato'?'atos':'pecas';
  api('/admin/api/ia/experimento/processos/'+encodeURIComponent(x.numero)+'/'+rota).then(function(d){
    x.carregandoCaso=false;x.sigiloso=!!d.sigiloso;
    if(f==='ato')x.atos=d.atos;else x.pecas=d.pecas;
    desenhar();
  },function(e){x.carregandoCaso=false;x.erro=textoDoErro(e);desenhar()});
}
function rodarExperimento(){
  var f=M.f,u=U(f),x=u.exp;
  var corpoDoPedido={numero:x.numero,texto:u.texto||''};
  if(f==='ato')corpoDoPedido.chaveDoAto=x.chave;
  if(f==='peca')corpoDoPedido.pecaId=x.chave;
  x.rodando=true;x.erro='';x.ctl=new AbortController();
  desenhar();
  var alvo=$('ia-i-exp-t');if(alvo)alvo.focus();
  api('/admin/api/ia/instrucoes/'+encodeURIComponent(f)+'/experimentar',{method:'POST',body:corpoDoPedido,sinal:x.ctl.signal}).then(function(r){
    x.rodando=false;x.ctl=null;x.resultado=r;desenhar();
    var l=$('ia-i-lado');if(l){l.setAttribute('tabindex','-1');l.focus()}
    anunciar('Experimento terminado: as duas respostas estão lado a lado.');
  },function(e){
    x.rodando=false;x.ctl=null;
    x.erro=(e&&e.name==='AbortError')?'Experimento cancelado.':textoDoErro(e);
    desenhar();
    var b=$('ia-i-exp-rodar');if(b)b.focus();
  });
}

function carregarErros(){
  var u=U(M.f);
  u.erros={carregando:true};desenhar();
  api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/erros').then(function(d){
    u.erros={dados:d};desenhar();
  },function(e){u.erros={erro:textoDoErro(e)};desenhar()});
}

function ligar(){
  var r=M.raiz,i,els;
  /* abas: clique e setas */
  els=r.querySelectorAll('[data-ia-i-aba]');
  for(i=0;i<els.length;i++){
    els[i].addEventListener('click',function(ev){
      M.f=ev.currentTarget.getAttribute('data-ia-i-aba');desenhar();
      var a=$('ia-i-aba-'+M.f);if(a)a.focus();
    });
    els[i].addEventListener('keydown',function(ev){
      var k=ev.key,ordem=['ato','resumo','peca'],pos=ordem.indexOf(M.f),nova=null;
      if(k==='ArrowRight')nova=ordem[(pos+1)%ordem.length];
      else if(k==='ArrowLeft')nova=ordem[(pos+ordem.length-1)%ordem.length];
      else if(k==='Home')nova=ordem[0];
      else if(k==='End')nova=ordem[ordem.length-1];
      if(nova){ev.preventDefault();M.f=nova;desenhar();var a=$('ia-i-aba-'+nova);if(a)a.focus()}
    });
  }
  var t=$('ia-i-texto'),o=$('ia-i-obs'),u=U(M.f);
  if(t)t.addEventListener('input',function(){u.texto=t.value;u.msg='';atualizarAoDigitar()});
  if(o)o.addEventListener('input',function(){u.obs=o.value;u.msg='';atualizarAoDigitar()});

  var salvar=$('ia-i-salvar');
  if(salvar)salvar.addEventListener('click',salvarRascunho);

  /* prévia do prompt montado */
  var pv=$('ia-i-previa-bt');
  if(pv)pv.addEventListener('click',function(){
    if(u.previaAberta){fecharPainel('previaAberta','ia-i-previa-bt');return}
    u.previa={carregando:true};
    abrirPainel('previaAberta','ia-i-previa');
    api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/previa',{method:'POST',body:{texto:u.texto||''}}).then(function(d){
      u.previa={dados:d};desenhar();
    },function(e){u.previa={erro:textoDoErro(e)};desenhar()});
  });
  var pf=$('ia-i-previa-fechar');
  if(pf)pf.addEventListener('click',function(){fecharPainel('previaAberta','ia-i-previa-bt')});

  /* experimento */
  var eb=$('ia-i-exp-bt');
  if(eb)eb.addEventListener('click',function(){
    if(u.expAberto){fecharPainel('expAberto','ia-i-exp-bt');return}
    abrirPainel('expAberto','ia-i-exp');
    carregarProcessos();
  });
  var ef=$('ia-i-exp-fechar');
  if(ef)ef.addEventListener('click',function(){fecharPainel('expAberto','ia-i-exp-bt')});
  var sp=$('ia-i-exp-proc');
  if(sp)sp.addEventListener('change',function(){
    u.exp.numero=sp.value;u.exp.resultado=null;u.exp.erro='';
    carregarCaso();
    var s=$('ia-i-exp-proc');if(s)s.focus();
  });
  var sa=$('ia-i-exp-ato')||$('ia-i-exp-peca');
  if(sa)sa.addEventListener('change',function(){
    u.exp.chave=sa.value;u.exp.resultado=null;u.exp.erro='';desenhar();
    var s=$('ia-i-exp-ato')||$('ia-i-exp-peca');if(s)s.focus();
  });
  var er=$('ia-i-exp-rodar');
  if(er)er.addEventListener('click',rodarExperimento);
  var ec=$('ia-i-exp-cancelar');
  if(ec)ec.addEventListener('click',function(){if(u.exp.ctl)u.exp.ctl.abort()});
  var eo=$('ia-i-exp-outro');
  if(eo)eo.addEventListener('click',function(){
    /* outro caso, sem perder o rascunho */
    u.exp.numero='';u.exp.atos=null;u.exp.pecas=null;u.exp.chave='';u.exp.resultado=null;u.exp.erro='';u.exp.sigiloso=false;
    desenhar();
    var s=$('ia-i-exp-proc');if(s)s.focus();
  });

  /* conjunto de verificação */
  var vb=$('ia-i-ver-bt');
  if(vb)vb.addEventListener('click',function(){
    if(u.verAberto){fecharPainel('verAberto','ia-i-ver-bt');return}
    abrirPainel('verAberto','ia-i-ver');
  });
  var vf=$('ia-i-ver-fechar');
  if(vf)vf.addEventListener('click',function(){fecharPainel('verAberto','ia-i-ver-bt')});
  var ve=$('ia-i-ver-estimar');
  if(ve)ve.addEventListener('click',function(){
    u.ver.estimando=true;u.ver.erro='';desenhar();
    api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/verificacao/estimativa',{method:'POST',body:{texto:u.texto||''}}).then(function(e){
      u.ver.estimando=false;u.ver.estimativa=e;desenhar();
      var b=$('ia-i-ver-iniciar');if(b)b.focus();
    },function(e){u.ver.estimando=false;u.ver.erro=textoDoErro(e);desenhar();var b=$('ia-i-ver-estimar');if(b)b.focus()});
  });
  var vd=$('ia-i-ver-descartar');
  if(vd)vd.addEventListener('click',function(){u.ver.estimativa=null;u.ver.erro='';desenhar();var b=$('ia-i-ver-estimar');if(b)b.focus()});
  var vi=$('ia-i-ver-iniciar');
  if(vi)vi.addEventListener('click',function(){
    if(u.ver.enviando)return;
    u.ver.enviando=true;desenhar();
    api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/verificacao',{method:'POST',body:{texto:u.texto||'',confirmado:true}}).then(function(t){
      u.ver.enviando=false;u.ver.estimativa=null;
      M.dados.verificacao.emAndamento=t;
      var fd=funcaoDe(M.f);if(fd)fd.ultimaVerificacao=t;
      desenhar();acompanhar();anunciar('Verificação iniciada.');
      var b=$('ia-i-ver-cancelar');if(b)b.focus();
    },function(e){u.ver.enviando=false;u.ver.erro=textoDoErro(e);desenhar()});
  });
  var vc=$('ia-i-ver-cancelar');
  if(vc)vc.addEventListener('click',function(){
    api('/admin/api/ia/verificacoes/'+encodeURIComponent(vc.getAttribute('data-ia-i-ver-cancelar'))+'/cancelar',{method:'POST',body:{}}).then(function(){
      anunciar('Cancelando a verificação.');
    },function(){anunciar(FRASE.erroGenerico)});
  });

  /* publicar e reverter */
  var pb=$('ia-i-publicar');
  if(pb)pb.addEventListener('click',function(){
    u.painel={tipo:'publicar'};desenhar();
    var b=$('ia-i-pub-ok');if(b)b.focus();
  });
  var pc=$('ia-i-pub-cancelar');
  if(pc)pc.addEventListener('click',function(){u.painel=null;desenhar();var b=$('ia-i-publicar');if(b)b.focus()});
  var po=$('ia-i-pub-ok');
  if(po)po.addEventListener('click',function(){
    var fd=funcaoDe(M.f),p=u.painel;
    if(!p||p.enviando||!fd||!fd.rascunho)return;
    p.enviando=true;desenhar();
    api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/publicar',{method:'POST',body:{versao:fd.rascunho.versao,confirmado:true}}).then(function(d){
      u.painel=null;aplicar(d,M.f);u.msg='';desenhar();
      var b=$('ia-i-reverter');if(b)b.focus();
      return recarregarTela().then(function(){anunciar(FRASE.publicado)});
    },function(e){p.enviando=false;p.erro=textoDoErro(e);desenhar()});
  });
  var rb=$('ia-i-reverter');
  if(rb)rb.addEventListener('click',function(){
    u.painel={tipo:'reverter'};desenhar();
    var b=$('ia-i-rev-ok');if(b)b.focus();
  });
  var rc=$('ia-i-rev-cancelar');
  if(rc)rc.addEventListener('click',function(){u.painel=null;desenhar();var b=$('ia-i-reverter');if(b)b.focus()});
  var ro=$('ia-i-rev-ok');
  if(ro)ro.addEventListener('click',function(){
    var p=u.painel;
    if(!p||p.enviando)return;
    p.enviando=true;desenhar();
    api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/reverter',{method:'POST',body:{confirmado:true}}).then(function(d){
      u.painel=null;aplicar(d);u.msg='';desenhar();
      var b=$('ia-i-publicar')||$('ia-i-texto');if(b)b.focus();
      return recarregarTela().then(function(){anunciar(FRASE.revertido)});
    },function(e){p.enviando=false;p.erro=textoDoErro(e);desenhar()});
  });

  /* histórico e comparação */
  var hb=$('ia-i-hist-bt');
  if(hb)hb.addEventListener('click',function(){
    u.histAberto=!u.histAberto;desenhar();
    var b=$('ia-i-hist-bt');if(b)b.focus();
  });
  els=r.querySelectorAll('[data-ia-i-ver-texto]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var v=ev.currentTarget.getAttribute('data-ia-i-ver-texto');
    api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/versoes/'+encodeURIComponent(v)).then(function(d){
      u.hist.verTexto={rotulo:'+e'+d.versao,texto:d.texto};desenhar();
      var p=$('ia-i-vt');if(p)p.focus();
    },function(e){u.hist.erro=textoDoErro(e);desenhar()});
  });
  els=r.querySelectorAll('[data-ia-i-usar]');
  for(i=0;i<els.length;i++)els[i].addEventListener('click',function(ev){
    var v=ev.currentTarget.getAttribute('data-ia-i-usar');
    api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/versoes/'+encodeURIComponent(v)).then(function(d){
      u.texto=d.texto;desenhar();atualizarAoDigitar();
      var t2=$('ia-i-texto');if(t2)t2.focus();
      anunciar('Texto de +e'+d.versao+' copiado para o editor. Salve o rascunho para guardá-lo.');
    },function(e){u.hist.erro=textoDoErro(e);desenhar()});
  });
  var dd=$('ia-i-diff-de'),dp=$('ia-i-diff-para');
  if(dd)dd.addEventListener('change',function(){u.hist.de=dd.value;u.hist.diff=null});
  if(dp)dp.addEventListener('change',function(){u.hist.para=dp.value;u.hist.diff=null});
  var di=$('ia-i-diff-ir');
  if(di)di.addEventListener('click',function(){
    var fd=funcaoDe(M.f);
    var esc3=escolhasDeComparar(fd,u.hist),de=esc3.de,para=esc3.para;
    var rotulo=function(v){return '+e'+v};
    u.hist.carregando=true;u.hist.erro='';desenhar();
    api('/admin/api/ia/instrucoes/'+encodeURIComponent(M.f)+'/diff?de='+encodeURIComponent(de)+'&para='+encodeURIComponent(para)).then(function(d){
      u.hist.carregando=false;u.hist.diff={deRotulo:rotulo(de),paraRotulo:rotulo(para),linhas:d.linhas};desenhar();
      var l=$('ia-i-diff');if(l)l.focus();else{var t3=$('ia-i-diff-t');if(t3){t3.setAttribute('tabindex','-1');t3.focus()}}
    },function(e){u.hist.carregando=false;u.hist.erro=textoDoErro(e);desenhar()});
  });

  /* onde a IA erra */
  var eb2=$('ia-i-erros-bt');
  if(eb2)eb2.addEventListener('click',function(){
    u.errosAberto=!u.errosAberto;
    if(u.errosAberto)carregarErros();else desenhar();
    var b=$('ia-i-erros-bt');if(b)b.focus();
  });
}

/* ---------- entrada e saída da tela ---------- */
/* Aviso ao sair: o admin pergunta antes de trocar de aba; o navegador, antes de fechar ou recarregar a página. */
function podeSair(){
  if(!algumSujo())return true;
  return window.confirm('Você tem um rascunho de instrução que não foi salvo. Se sair desta tela, as alterações serão descartadas. Sair mesmo?');
}
/* Sair da aba: pergunta se há rascunho não salvo e, saindo, esquece tudo (inclusive o caso do experimento). */
function sair(){
  if(!podeSair())return false;
  reiniciar();
  return true;
}
window.addEventListener('beforeunload',function(ev){
  if(!algumSujo())return;
  ev.preventDefault();
  ev.returnValue='';
});

/* O cartão da tela IA tem um espaço [data-ia-instrucoes]; a tela IA chama montar() a cada desenho. */
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
  M.dados=null;M.u={};M.carregando=false;M.f='ato';M.msg='';
  if(M.tempo){clearTimeout(M.tempo);M.tempo=null}
}

window.__pvIaInstrucoes={montar:montar,reiniciar:reiniciar,podeSair:podeSair,sair:sair,temAlteracoesNaoSalvas:algumSujo};
})();
`;

export const ESTILOS_IA_ADMIN_INSTRUCOES = `
.ia-i-cartao{min-width:0}
.ia-i-abas{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 0;border-bottom:1px solid var(--linha)}
.ia-i-aba{border:1px solid var(--linha);border-bottom:0;border-radius:8px 8px 0 0;background:var(--papel2);padding:8px 12px;font:inherit;
  color:var(--tinta);cursor:pointer;min-height:40px}
.ia-i-aba[aria-selected="true"]{background:var(--acento-bg);border-color:var(--acento);font-weight:700}
.ia-i-ponto{color:var(--atencao)}
.ia-i-linha{margin:8px 0;overflow-wrap:anywhere}
.ia-i-aviso{margin:8px 0;padding:8px 10px;border:1px solid var(--atencao);border-radius:8px;background:var(--papel2);overflow-wrap:anywhere}
.ia-i-editor textarea{width:100%;max-width:100%;min-width:0;box-sizing:border-box;font:inherit;line-height:1.45;resize:vertical;min-height:11rem}
.ia-i-editor input[type=text]{width:100%;max-width:100%;min-width:0}
.ia-i-contador{margin:4px 0}
.ia-i-estado{margin:6px 0 0;font-size:13.5px;font-weight:700;color:var(--tinta2)}
.ia-i-estado[data-sujo="1"]{color:var(--atencao)}
.ia-i-acoes{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 0}
.ia-i-peq{padding:3px 8px;font-size:13px}
.ia-i-painel,.ia-i-sec{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--linha);min-width:0}
.ia-i-h4{margin:0 0 8px;font-size:16px;outline:0}
.ia-i-h5{margin:12px 0 4px;font-size:14.5px;outline:0}
.ia-i-disc{display:inline-flex;gap:6px;align-items:center;border:0;background:none;padding:4px 0;font:inherit;font-weight:700;color:var(--tinta);cursor:pointer;min-height:32px}
.ia-i-bloco{margin:10px 0}
.ia-i-pre{margin:4px 0 0;padding:10px 12px;border:1px solid var(--linha);border-radius:8px;background:var(--papel2);white-space:pre-wrap;overflow-wrap:anywhere;
  word-break:break-word;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px;line-height:1.45;max-height:22rem;overflow:auto}
.ia-i-lado{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:14px;margin:14px 0;align-items:start;outline:0}
.ia-i-lado>*{min-width:0}
.ia-i-col{border:1px solid var(--linha);border-radius:10px;padding:12px;background:var(--papel);overflow-wrap:anywhere}
.ia-i-ok{color:var(--verde-tinta);font-weight:700;margin:6px 0}
.ia-i-mal{color:var(--erro);font-weight:700;margin:6px 0}
.ia-i-itens{margin:4px 0;padding-left:18px}
.ia-i-itens li{margin:6px 0}
.ia-i-cit{margin:4px 0 0;padding:4px 8px;border-left:3px solid var(--linha);color:var(--tinta2);font-size:13px}
.ia-i-cit-rotulo{font-weight:700}
.ia-i-med{margin:10px 0 0;display:grid;gap:4px;font-size:13.5px}
.ia-i-med>div{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr);gap:8px}
.ia-i-med dt{color:var(--tinta2)}
.ia-i-med dd{margin:0;min-width:0;overflow-wrap:anywhere}
.ia-i-avisos{border-left:3px solid var(--atencao);padding-left:10px;margin:8px 0}
.ia-i-av-grave strong{color:var(--erro)}
.ia-i-versoes,.ia-i-erros-lista{list-style:none;padding:0;margin:6px 0}
.ia-i-versoes li,.ia-i-erros-lista li{border-top:1px solid var(--linha);padding:7px 0;font-size:13.5px;overflow-wrap:anywhere}
.ia-i-comparar{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:12px 0}
.ia-i-comparar .ia-campo{margin:0;min-width:0;flex:1 1 14rem}
.ia-i-comparar select{width:100%;max-width:100%;min-width:0}
.ia-i-diff{margin:6px 0 0;padding:8px 10px;border:1px solid var(--linha);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;
  font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12.5px;max-height:22rem;overflow:auto}
.ia-i-diff-lista{list-style:none;margin:0;padding:0}
.ia-i-diff-lista li{padding:1px 0}
.ia-i-d-adicionada{color:var(--verde-tinta);font-weight:700}
.ia-i-d-removida{color:var(--erro);text-decoration:line-through}
.ia-i-d-marca{display:inline-block;width:1.4em}
.ia-i-cartao select{max-width:100%;min-width:0}
@media (max-width:520px){.ia-i-med>div{grid-template-columns:minmax(0,1fr)}}
`;
