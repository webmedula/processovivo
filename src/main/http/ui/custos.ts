import {
  campoDeCentavos,
  centavosDeTexto,
  reaisDeCentavos,
} from '../../../domain/entities/valorEmReais.js';

/**
 * O centro de custos na tela do processo (v0.47.0, ampliado na v0.48.0): o botão "Custos" ao lado dos
 * controles da capa, o painel logo abaixo dela e as chamadas à API, num arquivo só. `script.ts` não
 * cresce (há teste que fixa o tamanho): ele chama `window.__pvCustos.aposDesenhar(numero)` ao ligar os
 * botões do detalhe e `sair()` quando a tela deixa de ser a de um processo.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Centro de custos"):
 * - o dinheiro é lido e mostrado pelas MESMAS funções puras do servidor (`valorEmReais.ts`,
 *   injetadas por `toString()`): `1.234,56` e `1234,56` viram centavos INTEIROS por texto, nunca por
 *   multiplicação de decimal, e o servidor só recebe `valorCentavos`;
 * - os totais vêm do servidor; a tela não soma nada. Depois de cada mudança, ela pede a lista de novo;
 * - "Recebimentos do cliente" substituiu a caixa "Ressarcido" por lançamento: o reembolso é por
 *   processo, parcial e múltiplo; o excedente aparece como "Crédito do cliente", nunca como saldo negativo;
 * - NADA é apagado pela tela: "Cancelar" guarda o registro (fora dos totais), "Reativar" o devolve, e o
 *   aviso "Cancelado. Desfazer" de 6 s só reativa. "Mostrar cancelados" os exibe riscados e com o texto
 *   "Cancelado"; "Histórico" lista, em ordem cronológica, o que aconteceu com o registro;
 * - quem pagou é TEXTO na linha ("Escritório"/"Cliente"); despesa paga pelo cliente não é cobrada de
 *   volta, e a caixa "Cobrar do cliente" fica desligada e desabilitada com a explicação escrita;
 * - depósitos e garantias (Grupo 08) aparecem em bloco separado e nunca entram no total de despesas;
 * - todo texto vindo do servidor passa por `esc()`; nenhum valor ou descrição vai a `localStorage`,
 *   ao log ou à barra de endereço. O estado vive na página enquanto a pessoa fica NESTE processo;
 * - nenhuma frase fala em prazo nem aconselha: são valores que o advogado informou.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc;
 * `tests/http/console-script.spec.ts` roda o ESLint aqui dentro.
 */
export const SCRIPT_CUSTOS = String.raw`
(function(){
var pv=function(){return window.__pv};
function esc(s){return pv().esc(s)}
function digitos(n){return String(n||'').replace(/\D/g,'')}

var centavosDeTexto=${centavosDeTexto.toString()};
var reaisDeCentavos=${reaisDeCentavos.toString()};
var campoDeCentavos=${campoDeCentavos.toString()};

var TEMPO_DO_AVISO_MS=6000;
var NOVA='__nova__';
var GRUPO_DE_DEPOSITOS='08';
var AVISO_DO_DEPOSITO='Depósitos e garantias não entram no total de despesas.';
var AVISO_PAGO_PELO_CLIENTE='Despesa paga pelo cliente não é cobrada de volta: não gera saldo.';
var ROTULO_DA_OPERACAO={criou:'Criado',editou:'Editado',cancelou:'Cancelado',reativou:'Reativado',anexou:'Comprovante anexado',removeu:'Comprovante removido'};
var LIMITE_ARQUIVO=5*1024*1024;
var TEXTO_DO_DRIVE={
  desligado:'O envio de comprovantes ao Google Drive não está ativado neste servidor.',
  sem_plano:'Anexar comprovantes ao Google Drive faz parte dos planos Peças e IA.',
  nao_conectado:'Conecte o Google Drive em Meus acessos para anexar comprovantes.',
  precisa_reconectar:'A autorização do Google Drive expirou. Reconecte em Meus acessos para anexar comprovantes.'
};
var CLIPE='<svg class="cust-ic" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>';
function linkSeguro(u){return /^https:\/\/(drive|docs)\.google\.com\//.test(String(u||''))}
function tamanhoLegivel(n){return n>=1048576?(n/1048576).toFixed(1).replace('.',',')+' MB':Math.max(1,Math.round(n/1024))+' KB'}

/* Estado DESTE processo; null = painel nunca aberto aqui. */
var S=null;
/* Pedido da tela Custos por cliente: abrir o painel assim que a tela deste processo desenhar. */
var pendente='';

var ICONE='<svg class="cust-ic" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2c1.7.3 2.9.8 2.9 2.1 0 1.2-1.2 2-2.9 2-1.4 0-2.5-.5-3-1.4M12 6.5V8m0 8v1.5"/></svg>';

function p2(n){return (n<10?'0':'')+n}
function hojeLocal(){var d=new Date();return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}
function dataBr(iso){var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||'');return m?m[3]+'/'+m[2]+'/'+m[1]:''}
function instanteBr(iso){
  var d=new Date(iso);
  if(isNaN(d.getTime()))return '';
  return d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).replace(', ',' ');
}
function caminhoDoProcesso(n){return '/v1/processos/'+encodeURIComponent(n)+'/custos'}
function semAcento(t){return String(t||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()}

/* Frases de erro: as do servidor para o que é erro de digitação (400/422 de domínio, escritas por nós e
   sem eco do que a pessoa digitou), fixas para o resto. */
function mensagemDeErro(e){
  var s=e&&e.status;
  if((s===400||s===422)&&e.message&&e.codigo!=='REQUISICAO_INVALIDA'&&e.codigo!=='NUMERO_CNJ_INVALIDO')return e.message;
  if(s===400)return 'Confira os campos e tente de novo.';
  if(s===401)return 'Sua sessão expirou. Entre novamente.';
  if(s===402)return 'Sua assinatura está vencida. Regularize para usar o centro de custos.';
  if(s===403)return 'O centro de custos não faz parte do seu plano.';
  if(s===404)return 'Este registro não existe mais. Atualize a lista.';
  if(s===429)return 'Muitas operações seguidas. Aguarde um instante.';
  return 'Não foi possível concluir. Tente de novo.';
}

/* A região ao vivo mora no <body> e nunca é trocada: sobrevive ao redesenho da tela do processo. */
function anunciar(t){
  var el=document.getElementById('cust-live');
  if(!el){
    el=document.createElement('div');
    el.id='cust-live';el.className='cust-sr';
    el.setAttribute('aria-live','polite');el.setAttribute('role','status');
    document.body.appendChild(el);
  }
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

function categoria(codigo){
  var l=(S&&S.dados&&S.dados.categorias)||[];
  for(var i=0;i<l.length;i++)if(l[i].codigo===codigo)return l[i];
  return null;
}
function nomeDaCategoria(codigo){
  var c=categoria(codigo);
  return c?c.nomeCompleto+(c.arquivada?' (arquivada)':''):'Categoria não identificada';
}

/* ---------- desenho ---------- */
function totaisHtml(){
  var t=S.dados.totais;
  function c(rot,v,cls){return '<div class="cust-tot '+(cls||'')+'"><dt>'+rot+'</dt><dd>'+reaisDeCentavos(v)+'</dd></div>'}
  var h='<dl class="cust-tots">'+c('Total de despesas',t.totalDespesasCentavos)+c('Pago pelo escritório',t.pagoPeloEscritorioCentavos)+
    c('Pago diretamente pelo cliente',t.pagoPeloClienteCentavos)+c('Reembolsável',t.totalReembolsavelCentavos)+
    c('Recebido do cliente',t.totalRecebidoCentavos)+c('Saldo a cobrar',t.saldoACobrarCentavos,'cust-saldo')+
    (t.creditoDoClienteCentavos>0?c('Crédito do cliente',t.creditoDoClienteCentavos,'cust-credito'):'')+'</dl>';
  if(t.reembolsavelDeDepositosCentavos>0){
    h+='<p class="cust-nota">Do reembolsável, '+reaisDeCentavos(t.reembolsavelDeDepositosCentavos)+' são depósitos e garantias cobrados do cliente.</p>';
  }
  if(t.porCategoria.length){
    h+='<h4 class="cust-rot">Despesas por subcategoria</h4><ul class="cust-subs">'+t.porCategoria.map(subHtml).join('')+'</ul>';
  }
  if(t.depositos.quantidade){
    var d=t.depositos;
    h+='<h4 class="cust-rot">Depósitos e garantias</h4><p class="cust-nota">'+AVISO_DO_DEPOSITO+'</p>'+
      '<dl class="cust-tots"><div class="cust-tot"><dt>Total de depósitos e garantias</dt><dd>'+reaisDeCentavos(d.totalCentavos)+'</dd></div>'+
      '<div class="cust-tot"><dt>Adiantado pelo escritório</dt><dd>'+reaisDeCentavos(d.pagoPeloEscritorioCentavos)+'</dd></div>'+
      '<div class="cust-tot"><dt>Pago pelo cliente</dt><dd>'+reaisDeCentavos(d.pagoPeloClienteCentavos)+'</dd></div></dl>'+
      '<ul class="cust-subs">'+d.porCategoria.map(subHtml).join('')+'</ul>';
  }
  return h;
}
function subHtml(s){
  return '<li><span class="cust-sub-n">'+esc(s.nome)+'</span><span class="cust-sub-q">'+s.quantidade+' '+
    (s.quantidade===1?'lançamento':'lançamentos')+'</span><span class="cust-sub-v">'+reaisDeCentavos(s.totalCentavos)+'</span></li>';
}

/* Ícones das ações (v0.49.1): o mesmo traço do clipe e do resto do console (24x24, 1.8, sem biblioteca nova). */
function icone(caminhos){
  return '<svg class="cust-ic" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+caminhos+'</svg>';
}
var ICONE_EDITAR=icone('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
var ICONE_CANCELAR=icone('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>');
var ICONE_ANEXAR=icone('<path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>');
var ICONE_HISTORICO=icone('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>');
var ICONE_REATIVAR=icone('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>');

/* Uma ação em ícone: botão de verdade, nome acessível próprio (sem repetir a descrição do lançamento: a linha da
   tabela já a dá), dica com o texto da ação — a MESMA dica do "Cumprido" (window.__pvProvidencia.comDica) — e o
   texto curto ao lado do ícone só nos cartões (sem mouse não há dica). data-cust/data-id/data-tipo são o que o
   ouvinte delegado lê; o selo de contagem do clipe não muda o tamanho do botão. */
function botaoIcone(acao,tipo,x,ic,nome,texto,dica,extra,selo){
  var id=esc(x.id);
  var did='cust-d-'+acao+'-'+tipo.charAt(0)+'-'+id;
  var bt='<button type="button" class="bt bt2 cust-ib" data-cust="'+acao+'" data-tipo="'+tipo+'" data-id="'+id+'" aria-label="'+esc(nome)+'" aria-describedby="'+did+'"'+(extra||'')+'>'+
    ic+'<span class="cust-ib-t">'+texto+'</span>'+(selo?'<span class="cust-ib-n" aria-hidden="true">'+selo+'</span>':'')+'</button>';
  return window.__pvProvidencia.comDica(bt,did,dica);
}

function acoesHtml(tipo,x){
  var id=esc(x.id);
  var conf=S.confirmando;
  var coisa=tipo==='recebimento'?'recebimento':'lançamento';
  if(conf&&conf.tipo===tipo&&conf.id===x.id){
    return '<span class="cust-conf" role="group" aria-label="Confirmar cancelamento">'+
      '<label class="cust-motivo-l" for="cust-motivo-'+id+'">Motivo (opcional)</label>'+
      '<input type="text" id="cust-motivo-'+id+'" class="cust-motivo" maxlength="'+S.dados.limites.motivo+'" autocomplete="off">'+
      '<button type="button" class="bt bt2 cust-perigo cust-mini" data-cust="cancelar-sim" data-tipo="'+tipo+'" data-id="'+id+'">Confirmar cancelamento</button>'+
      '<button type="button" class="bt bt2 cust-mini" data-cust="cancelar-nao" data-tipo="'+tipo+'" data-id="'+id+'" id="cust-nao-'+id+'">Voltar</button></span>';
  }
  var h='';
  if(x.cancelado){
    h+=botaoIcone('reativar',tipo,x,ICONE_REATIVAR,'Reativar '+coisa,'Reativar','Reativar');
  }else{
    h+=botaoIcone('editar',tipo,x,ICONE_EDITAR,'Editar '+coisa,'Editar','Editar')+
      botaoIcone('cancelar',tipo,x,ICONE_CANCELAR,'Cancelar '+coisa,'Cancelar','Cancelar '+coisa);
    if(tipo==='lancamento'){
      var n=(x.comprovantes||[]).length;
      var cheio=(n>=S.dados.limites.comprovantesPorLancamento);
      var nome=n?'Anexar comprovante ('+n+(n===1?' anexado)':' anexados)'):'Anexar comprovante';
      h+=botaoIcone('anexar',tipo,x,ICONE_ANEXAR,nome,'Comprovante',cheio?'Este lançamento já tem '+S.dados.limites.comprovantesPorLancamento+' comprovantes.':'Anexar comprovante',cheio?' disabled':'',n?String(n):'');
    }
  }
  return h+botaoIcone('historico',tipo,x,ICONE_HISTORICO,'Histórico do '+coisa,'Histórico','Histórico');
}

function comprovantesHtml(l){
  var cs=l.comprovantes||[];
  if(!cs.length)return '';
  var h='<span class="cust-comp"><span class="cust-comp-n">'+CLIPE+'<span class="cust-sr">Comprovantes: </span>'+cs.length+'</span>'+
    '<span class="cust-comp-t"> '+(cs.length===1?'comprovante':'comprovantes')+'</span>';
  h+='<ul class="cust-comp-lista" aria-label="Comprovantes deste lançamento">'+cs.map(function(c){
    var id=esc(c.id),lid=esc(l.id);
    var abrir=linkSeguro(c.link)?'<a href="'+esc(c.link)+'" target="_blank" rel="noopener noreferrer">Abrir no Drive<span class="cust-sr">: '+esc(c.nome)+'</span></a>':'';
    var remover;
    if(S.removendoComp===c.id){
      remover='<span class="cust-conf" role="group" aria-label="Confirmar remoção do comprovante">'+
        '<span>Remove só o vínculo. O arquivo continua no seu Google Drive.</span>'+
        '<button type="button" class="bt bt2 cust-perigo cust-mini" data-cust="remover-comp-sim" data-id="'+lid+'" data-comp="'+id+'">Remover vínculo</button>'+
        '<button type="button" class="bt bt2 cust-mini" data-cust="remover-comp-nao" data-id="'+lid+'" data-comp="'+id+'" id="cust-rcn-'+id+'">Voltar</button></span>';
    }else{
      remover='<button type="button" class="bt bt2 cust-mini" data-cust="remover-comp" data-id="'+lid+'" data-comp="'+id+'" aria-label="Remover comprovante: '+esc(c.nome)+'">Remover</button>';
    }
    return '<li><span class="cust-comp-nome">'+esc(c.nome)+'</span> <span class="cust-nd">('+tamanhoLegivel(c.tamanho)+')</span> '+abrir+' '+(l.cancelado?'':remover)+'</li>';
  }).join('')+'</ul></span>';
  return h;
}

function marcaDeCancelado(x){
  if(!x.cancelado)return '';
  return '<span class="cust-canc">Cancelado'+(x.canceladoEm?' em '+esc(dataBr(String(x.canceladoEm).slice(0,10))):'')+'</span>'+
    (x.motivoDoCancelamento?'<span class="cust-em">Motivo: '+esc(x.motivoDoCancelamento)+'</span>':'');
}

function linhaHtml(l){
  var id=esc(l.id);
  var cobrar=l.pagoPor==='cliente'?'<span class="cust-nd" aria-label="Não se aplica">—</span>':(l.reembolsavel?'Sim':'Não');
  return '<tr data-id="'+id+'"'+(l.cancelado?' class="cust-cancelado"':'')+'>'+
    '<td data-rotulo="Data">'+esc(dataBr(l.data))+'</td>'+
    '<td data-rotulo="Descrição" class="cust-desc"><span class="cust-desc-t" title="'+esc(l.descricao)+'">'+esc(l.descricao)+'</span>'+marcaDeCancelado(l)+comprovantesHtml(l)+'</td>'+
    '<td data-rotulo="Subcategoria"><span class="cust-sub-t" title="'+esc(nomeDaCategoria(l.categoria))+'">'+esc(nomeDaCategoria(l.categoria))+'</span></td>'+
    '<td data-rotulo="Valor" class="cust-val">'+reaisDeCentavos(l.valorCentavos)+'</td>'+
    '<td data-rotulo="Pago por">'+(l.pagoPor==='cliente'?'Cliente':'Escritório')+'</td>'+
    '<td data-rotulo="Cobrar do cliente">'+cobrar+'</td>'+
    '<td data-rotulo="Ações" class="cust-acoes">'+acoesHtml('lancamento',l)+'</td></tr>';
}

function tabelaDeLancamentos(titulo,lista){
  return '<table class="cust-tab"><caption class="cust-sr">'+titulo+', do mais recente para o mais antigo</caption>'+
    '<thead><tr><th scope="col">Data</th><th scope="col">Descrição</th><th scope="col">Subcategoria</th><th scope="col" class="cust-val">Valor</th>'+
    '<th scope="col">Pago por</th><th scope="col">Cobrar do cliente</th><th scope="col">Ações</th></tr></thead><tbody>'+
    lista.map(linhaHtml).join('')+'</tbody></table>';
}

function linhaDoRecebimento(r){
  var id=esc(r.id);
  return '<tr data-id="'+id+'"'+(r.cancelado?' class="cust-cancelado"':'')+'>'+
    '<td data-rotulo="Data">'+esc(dataBr(r.data))+'</td>'+
    '<td data-rotulo="Observação" class="cust-desc">'+(r.observacao?'<span class="cust-desc-t" title="'+esc(r.observacao)+'">'+esc(r.observacao)+'</span>':'<span class="cust-nd">—</span>')+marcaDeCancelado(r)+'</td>'+
    '<td data-rotulo="Valor" class="cust-val">'+reaisDeCentavos(r.valorCentavos)+'</td>'+
    '<td data-rotulo="Ações" class="cust-acoes">'+acoesHtml('recebimento',r)+'</td></tr>';
}

function listaHtml(){
  var d=S.dados;
  var desp=d.lancamentos.filter(function(l){return !l.deposito});
  var deps=d.lancamentos.filter(function(l){return l.deposito});
  var h='';
  if(!d.lancamentos.length)h+='<p class="cust-vazio">Nenhum custo lançado neste processo. Adicione o primeiro.</p>';
  else{
    if(desp.length)h+=tabelaDeLancamentos('Despesas do processo',desp);
    if(deps.length)h+='<h4 class="cust-rot">Depósitos e garantias</h4><p class="cust-nota">'+AVISO_DO_DEPOSITO+'</p>'+tabelaDeLancamentos('Depósitos e garantias',deps);
  }
  h+='<h4 class="cust-rot" id="cust-rec-tit">Recebimentos do cliente</h4>';
  if(!d.recebimentos.length)h+='<p class="cust-vazio">Nenhum recebimento registrado.</p>';
  else h+='<table class="cust-tab cust-tab-rec"><caption class="cust-sr">Recebimentos do cliente, do mais recente para o mais antigo</caption>'+
    '<thead><tr><th scope="col">Data</th><th scope="col">Observação</th><th scope="col" class="cust-val">Valor</th><th scope="col">Ações</th></tr></thead><tbody>'+
    d.recebimentos.map(linhaDoRecebimento).join('')+'</tbody></table>';
  return h;
}

function barraDeCanceladosHtml(){
  var d=S.dados;
  var esc1=d.canceladosEscondidos>0&&!S.mostrarCancelados;
  return '<label class="cust-marca"><input type="checkbox" id="cust-f-mostrar-canc"'+(S.mostrarCancelados?' checked':'')+'> Mostrar cancelados</label>'+
    (esc1?'<span class="cust-nota cust-escondidos">'+d.canceladosEscondidos+' '+(d.canceladosEscondidos===1?'registro cancelado escondido':'registros cancelados escondidos')+'.</span>':'');
}

function opcoesDeCategoria(atual,busca){
  var d=S.dados,q=semAcento(busca).trim(),h='';
  d.grupos.forEach(function(g){
    var itens='';
    d.categorias.forEach(function(c){
      if(c.grupo!==g.codigo)return;
      if(c.arquivada&&c.codigo!==atual)return;
      /* A escolhida nunca some da lista por causa da busca: o valor lido no salvar seria outro. */
      if(q&&c.codigo!==atual&&semAcento(c.nomeCompleto+' '+c.codigo).indexOf(q)<0)return;
      itens+='<option value="'+esc(c.codigo)+'"'+(c.codigo===atual?' selected':'')+'>'+esc(c.nome)+(c.arquivada?' (arquivada)':'')+'</option>';
    });
    if(itens)h+='<optgroup label="'+esc(g.nome)+'">'+itens+'</optgroup>';
  });
  return h+'<option value="'+NOVA+'"'+(atual===NOVA?' selected':'')+'>Nova subcategoria…</option>';
}
function opcoesDeGrupo(atual){
  return S.dados.grupos.map(function(g){return '<option value="'+esc(g.codigo)+'"'+(g.codigo===atual?' selected':'')+'>'+esc(g.nome)+'</option>'}).join('');
}
function avisoDoGrupoHtml(r){
  var c=r.novaCategoria?null:categoria(r.categoria);
  var dep=r.novaCategoria?r.grupoNovo===GRUPO_DE_DEPOSITOS:(c&&c.deposito);
  return dep?AVISO_DO_DEPOSITO:'';
}

function formHtml(){
  var r=S.rascunho;
  var lim=S.dados.limites;
  if(r.tipo==='recebimento'){
    return '<form class="cust-form" id="cust-form" novalidate aria-labelledby="cust-form-tit">'+
      '<h4 class="cust-rot" id="cust-form-tit">'+(r.id?'Editar recebimento':'Registrar recebimento')+'</h4>'+
      '<div class="cust-campos">'+
      '<div class="cust-campo"><label for="cust-f-data">Data do recebimento</label><input id="cust-f-data" type="date" value="'+esc(r.data)+'" required></div>'+
      '<div class="cust-campo"><label for="cust-f-valor">Valor (R$)</label><input id="cust-f-valor" type="text" inputmode="decimal" autocomplete="off" '+
        'placeholder="0,00" value="'+esc(r.valor)+'" aria-describedby="cust-f-previa" required><span class="cust-previa" id="cust-f-previa" aria-live="polite"></span></div>'+
      '<div class="cust-campo cust-grande"><label for="cust-f-obs">Observação (opcional)</label><input id="cust-f-obs" type="text" maxlength="'+lim.observacao+
        '" value="'+esc(r.observacao)+'" autocomplete="off"></div></div>'+
      '<div class="cust-erro" id="cust-f-erro" role="alert"></div>'+
      '<div class="cust-botoes"><button type="submit" class="bt" id="cust-f-salvar">'+(r.id?'Salvar alterações':'Registrar recebimento')+
      '</button><button type="button" class="bt bt2" data-cust="cancelar-form">Voltar</button></div></form>';
  }
  var cliente=r.pagoPor==='cliente';
  return '<form class="cust-form" id="cust-form" novalidate aria-labelledby="cust-form-tit">'+
    '<h4 class="cust-rot" id="cust-form-tit">'+(r.id?'Editar lançamento':'Novo lançamento')+'</h4>'+
    '<div class="cust-campos">'+
    '<div class="cust-campo"><label for="cust-f-data">Data do gasto</label><input id="cust-f-data" type="date" value="'+esc(r.data)+'" required></div>'+
    '<div class="cust-campo cust-grande"><label for="cust-f-desc">Descrição</label><input id="cust-f-desc" type="text" maxlength="'+lim.descricao+
      '" value="'+esc(r.descricao)+'" required autocomplete="off"></div>'+
    '<div class="cust-campo"><label for="cust-f-valor">Valor (R$)</label><input id="cust-f-valor" type="text" inputmode="decimal" autocomplete="off" '+
      'placeholder="0,00" value="'+esc(r.valor)+'" aria-describedby="cust-f-previa" required><span class="cust-previa" id="cust-f-previa" aria-live="polite"></span></div>'+
    '</div>'+
    '<div class="cust-campos">'+
    '<div class="cust-campo"><label for="cust-f-busca">Buscar subcategoria</label><input id="cust-f-busca" type="search" value="'+esc(r.busca)+'" autocomplete="off" aria-controls="cust-f-cat"></div>'+
    '<div class="cust-campo cust-grande"><label for="cust-f-cat">Grupo › Subcategoria</label><select id="cust-f-cat" aria-describedby="cust-f-aviso-grupo">'+opcoesDeCategoria(r.novaCategoria?NOVA:r.categoria,r.busca)+'</select></div>'+
    '</div>'+
    '<p class="cust-nota cust-aviso-grupo" id="cust-f-aviso-grupo">'+avisoDoGrupoHtml(r)+'</p>'+
    (r.novaCategoria?'<div class="cust-campos"><div class="cust-campo"><label for="cust-f-grupo-novo">Grupo da nova subcategoria</label>'+
      '<select id="cust-f-grupo-novo">'+opcoesDeGrupo(r.grupoNovo)+'</select></div>'+
      '<div class="cust-campo cust-grande"><label for="cust-f-nova">Nome da nova subcategoria</label>'+
      '<input id="cust-f-nova" type="text" maxlength="'+lim.nomeDaCategoria+'" value="'+esc(r.nomeNova)+'" autocomplete="off"></div>'+
      '<div class="cust-campo"><button type="button" class="bt bt2" data-cust="criar-categoria">Criar subcategoria</button></div></div>':'')+
    '<fieldset class="cust-pago"><legend>Pago por</legend>'+
    '<label class="cust-marca"><input type="radio" name="cust-f-pago" id="cust-f-pago-escritorio" value="escritorio"'+(cliente?'':' checked')+'> Escritório</label>'+
    '<label class="cust-marca"><input type="radio" name="cust-f-pago" id="cust-f-pago-cliente" value="cliente"'+(cliente?' checked':'')+'> Cliente (diretamente)</label>'+
    '</fieldset>'+
    '<div class="cust-campos">'+
    '<label class="cust-marca"><input type="checkbox" id="cust-f-reemb"'+(r.reembolsavel&&!cliente?' checked':'')+(cliente?' disabled':'')+' aria-describedby="cust-f-reemb-nota"> Cobrar do cliente</label>'+
    '<span class="cust-nota" id="cust-f-reemb-nota">'+(cliente?AVISO_PAGO_PELO_CLIENTE:'')+'</span>'+
    '</div>'+
    '<div class="cust-erro" id="cust-f-erro" role="alert"></div>'+
    '<div class="cust-botoes"><button type="submit" class="bt" id="cust-f-salvar">'+(r.id?'Salvar alterações':'Salvar lançamento')+
    '</button><button type="button" class="bt bt2" data-cust="cancelar-form">Voltar</button></div></form>';
}

function historicoHtml(){
  var h=S.historico;
  if(!h)return '';
  var corpo;
  if(h.erro)corpo='<p class="cust-vazio cust-erro-lista">'+esc(h.erro)+'</p>';
  else if(!h.eventos)corpo='<p class="cust-vazio">Carregando…</p>';
  else if(!h.eventos.length)corpo='<p class="cust-vazio">Sem eventos registrados.</p>';
  else corpo='<ol class="cust-hist-lista">'+h.eventos.map(function(e){
    var cs=(e.campos||[]).map(function(c){
      if(c.de!==undefined||c.para!==undefined)return '<li>'+esc(c.rotulo)+': '+esc(c.de||'—')+' → '+esc(c.para||'—')+'</li>';
      return '<li>'+esc(c.rotulo)+' alterada</li>';
    }).join('');
    return '<li><time>'+esc(instanteBr(e.quando))+'</time> — <strong>'+esc(ROTULO_DA_OPERACAO[e.operacao]||e.operacao)+'</strong>'+
      (e.motivo?'<span class="cust-em">Motivo: '+esc(e.motivo)+'</span>':'')+(cs?'<ul>'+cs+'</ul>':'')+'</li>';
  }).join('')+'</ol>';
  return '<section class="cust-hist" id="cust-hist-painel" role="region" aria-labelledby="cust-hist-tit" tabindex="-1">'+
    '<div class="cust-topo"><h4 class="cust-rot" id="cust-hist-tit">Histórico: '+esc(h.titulo)+'</h4>'+
    '<button type="button" class="bt bt2 cust-mini" data-cust="hist-fechar" id="cust-hist-fechar">Fechar histórico</button></div>'+corpo+'</section>';
}

function esqueleto(){
  return '<section class="cust" id="cust-painel" role="region" aria-labelledby="cust-tit" tabindex="-1">'+
    '<div class="cust-topo"><h3 class="cust-h" id="cust-tit">Custos do processo</h3>'+
    '<button type="button" class="bt bt2 cust-mini" data-cust="fechar">Fechar</button></div>'+
    '<p class="cust-nota">Valores informados por você, só visíveis na sua conta. Não vêm do tribunal. A classificação é só uma organização: não afirma que uma cobrança seja exigível no processo.</p>'+
    '<div id="cust-totais"></div>'+
    '<div class="cust-barra"><button type="button" class="bt" data-cust="novo" id="cust-novo">Novo lançamento</button> '+
    '<button type="button" class="bt bt2" data-cust="novo-recebimento" id="cust-novo-rec">Registrar recebimento</button> '+
    '<span id="cust-canc-barra"></span></div>'+
    '<div id="cust-formulario"></div>'+
    '<div class="cust-aviso" id="cust-aviso" role="status"></div>'+
    '<div id="cust-msg" class="cust-msg" role="alert"></div>'+
    '<div id="cust-comp-aviso" class="cust-msg cust-comp-aviso" role="status"></div>'+
    '<input type="file" id="cust-arq" class="cust-sr" tabindex="-1" aria-hidden="true" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png">'+
    '<div id="cust-lista" class="cust-lista"></div>'+
    '<div id="cust-historico"></div>'+
    '<div class="cust-pdf"><h4 class="cust-rot">Prestação de contas</h4>'+
    '<p class="cust-nota">Gera um PDF para enviar ao cliente, com os lançamentos, os recebimentos, os subtotais e os totais. Não leva partes nem texto de ato, nem o que foi cancelado.</p>'+
    '<div class="cust-campos">'+
    '<div class="cust-campo"><label for="cust-pdf-de">De</label><input id="cust-pdf-de" type="date"></div>'+
    '<div class="cust-campo"><label for="cust-pdf-ate">Até</label><input id="cust-pdf-ate" type="date"></div>'+
    '<label class="cust-marca"><input type="checkbox" id="cust-pdf-cobrar"> Somente o que está a cobrar</label></div>'+
    '<div class="cust-botoes"><button type="button" class="bt bt2" data-cust="pdf" id="cust-pdf">Gerar prestação de contas (PDF)</button></div>'+
    '<div id="cust-pdf-msg" class="cust-msg" role="alert"></div>'+
    '<h4 class="cust-rot">Planilha</h4>'+
    '<p class="cust-nota">Uma linha por lançamento e outra por recebimento, para abrir no Excel. Usa o mesmo período acima.</p>'+
    '<div class="cust-campos"><label class="cust-marca"><input type="checkbox" id="cust-csv-canc"> Incluir cancelados (marcados)</label></div>'+
    '<div class="cust-botoes"><button type="button" class="bt bt2" data-cust="csv" id="cust-csv">Exportar planilha (CSV)</button></div>'+
    '<div id="cust-csv-msg" class="cust-msg" role="alert"></div></div></section>';
}

function pintarDados(){
  var t=document.getElementById('cust-totais'),l=document.getElementById('cust-lista'),b=document.getElementById('cust-canc-barra');
  if(!S||!S.dados||!t||!l)return;
  t.innerHTML=totaisHtml();
  l.innerHTML=listaHtml();
  if(b)b.innerHTML=barraDeCanceladosHtml();
}
function pintarHistorico(){
  var h=document.getElementById('cust-historico');
  if(!h||!S)return;
  /* O painel é redesenhado quando os eventos chegam: o foco que estava nele volta a ele. */
  var tinhaFoco=h.contains(document.activeElement);
  h.innerHTML=historicoHtml();
  var p=document.getElementById('cust-hist-painel');
  if(tinhaFoco&&p)p.focus();
}
function pintarFormulario(){
  var f=document.getElementById('cust-formulario');
  if(!f||!S)return;
  f.innerHTML=S.rascunho?formHtml():'';
  atualizarPrevia();
  var n=document.getElementById('cust-novo'),nr=document.getElementById('cust-novo-rec');
  if(n)n.disabled=!!S.rascunho;
  if(nr)nr.disabled=!!S.rascunho;
}
function mensagem(t){
  var m=document.getElementById('cust-msg');
  if(m)m.textContent=t||'';
}

/* ---------- raiz e botão ---------- */
function montarRaiz(){
  var capa=document.querySelector('#conteudo .capa');
  if(!capa||!S)return false;
  var raiz=document.getElementById('cust-raiz');
  if(!S.aberto){
    /* Fechado, a tela do processo é a de antes: nada do painel fica no DOM. */
    if(raiz)raiz.parentNode.removeChild(raiz);
    marcarBotao();
    return true;
  }
  if(!raiz){
    raiz=document.createElement('div');
    raiz.id='cust-raiz';
    capa.insertAdjacentElement('afterend',raiz);
    window.__pvProvidencia.ligar(raiz);
  }
  raiz.innerHTML=esqueleto();
  pintarDados();pintarFormulario();pintarHistorico();
  marcarBotao();
  return true;
}
function marcarBotao(){
  var b=document.getElementById('cust-abrir');
  if(b)b.setAttribute('aria-expanded',S&&S.aberto?'true':'false');
}

function aposDesenhar(numero){
  var n=digitos(numero);
  if(S&&S.numero!==n)descartar();
  var capa=document.querySelector('#conteudo .capa');
  var num=capa?capa.querySelector('.num'):null;
  if(!capa||!num||digitos(num.textContent)!==n)return;
  if(!S)S={numero:n,aberto:false,dados:null,rascunho:null,confirmando:null,removendoComp:'',anexandoA:'',mostrarCancelados:false,historico:null,salvando:{},ultimo:null,timer:0};
  if(!document.getElementById('cust-abrir')){
    var ancora=document.getElementById('parar')||document.getElementById('acompanhar');
    var linha=ancora?ancora.parentElement:null;
    if(!linha)return;
    var b=document.createElement('button');
    b.type='button';b.className='bt bt2 cust-btn';b.id='cust-abrir';
    b.setAttribute('aria-controls','cust-painel');b.setAttribute('aria-expanded','false');
    b.setAttribute('aria-label','Custos do processo');
    b.title='Custos do processo';
    b.innerHTML=ICONE+'<span>Custos</span>';
    linha.appendChild(b);
  }
  /* A tela foi redesenhada (régua carregada) com o painel aberto: devolve o painel a partir do estado. */
  if(S.aberto)montarRaiz();
  else marcarBotao();
  if(pendente===n){pendente='';if(!S.aberto)abrir()}
}
function abrirPainelDe(numero){pendente=digitos(numero);pv().abrir(numero)}

function descartar(){
  if(S&&S.timer)clearTimeout(S.timer);
  S=null;
  var r=document.getElementById('cust-raiz');
  if(r)r.parentNode.removeChild(r);
}
function sair(){if(S||document.getElementById('cust-raiz'))descartar()}

/* ---------- dados ---------- */
function carregar(){
  var n=S.numero;
  return pv().api(caminhoDoProcesso(n)+(S.mostrarCancelados?'?cancelados=true':'')).then(function(d){
    if(!S||S.numero!==n)return;
    S.dados=d;
    if(S.aberto)pintarDados();
  });
}

function abrir(){
  if(!S)return;
  S.aberto=true;
  montarRaiz();
  var p=document.getElementById('cust-painel');
  if(p)p.focus();
  mensagem('');
  var lista=document.getElementById('cust-lista');
  if(lista&&!S.dados)lista.innerHTML='<p class="cust-vazio">Carregando…</p>';
  var n=S.numero;
  carregar().then(function(){
    if(S&&S.numero===n&&S.aberto)pintarFormulario();
  }).catch(function(e){
    if(!S||S.numero!==n)return;
    var l=document.getElementById('cust-lista');
    if(l)l.innerHTML='<p class="cust-vazio cust-erro-lista">'+esc(mensagemDeErro(e))+'</p>';
  });
}
function fechar(){
  if(!S)return;
  S.aberto=false;S.rascunho=null;S.confirmando=null;S.historico=null;
  limparAviso();
  montarRaiz();
  var b=document.getElementById('cust-abrir');
  if(b)b.focus();
}

/* ---------- formulário ---------- */
function rascunhoNovo(){
  return {tipo:'lancamento',id:'',data:hojeLocal(),descricao:'',categoria:'CUS-020',busca:'',valor:'',reembolsavel:false,pagoPor:'escritorio',novaCategoria:false,nomeNova:'',grupoNovo:'12',original:null};
}
function rascunhoNovoRecebimento(){
  return {tipo:'recebimento',id:'',data:hojeLocal(),valor:'',observacao:'',original:null};
}
function abrirFormulario(r){
  S.rascunho=r;
  pintarFormulario();
  var f=document.getElementById(r.id&&r.tipo==='lancamento'?'cust-f-desc':'cust-f-data');
  if(f)f.focus();
}
function fecharFormulario(foco){
  S.rascunho=null;
  pintarFormulario();
  if(foco){var n=document.getElementById('cust-novo');if(n)n.focus()}
}
function lerCampos(){
  var r=S.rascunho;if(!r)return;
  function v(id){var e=document.getElementById(id);return e?e.value:null}
  var d=v('cust-f-data');if(d!==null)r.data=d;
  var m=v('cust-f-valor');if(m!==null)r.valor=m;
  if(r.tipo==='recebimento'){
    var o=v('cust-f-obs');if(o!==null)r.observacao=o;
    return;
  }
  var t=v('cust-f-desc');if(t!==null)r.descricao=t;
  var b=v('cust-f-busca');if(b!==null)r.busca=b;
  var c=v('cust-f-cat');
  if(c!==null){if(c===NOVA)r.novaCategoria=true;else{r.novaCategoria=false;r.categoria=c}}
  var nn=v('cust-f-nova');if(nn!==null)r.nomeNova=nn;
  var gn=v('cust-f-grupo-novo');if(gn!==null)r.grupoNovo=gn;
  var pc=document.getElementById('cust-f-pago-cliente');
  if(pc)r.pagoPor=pc.checked?'cliente':'escritorio';
  var cb=document.getElementById('cust-f-reemb');
  if(cb&&!cb.disabled)r.reembolsavel=cb.checked;
  if(r.pagoPor==='cliente')r.reembolsavel=false;
}
function atualizarPrevia(){
  var p=document.getElementById('cust-f-previa'),i=document.getElementById('cust-f-valor');
  if(!p||!i)return;
  var txt=i.value;
  if(!String(txt).trim()){p.textContent='';p.classList.remove('cust-previa-ruim');return}
  var c=centavosDeTexto(txt);
  if(c===null){p.textContent='Use o formato 1.234,56 (vírgula nos centavos).';p.classList.add('cust-previa-ruim')}
  else{p.textContent='= '+reaisDeCentavos(c);p.classList.remove('cust-previa-ruim')}
}
function erroDoForm(t){
  var e=document.getElementById('cust-f-erro');
  if(e)e.textContent=t||'';
}
/* A busca refaz só a lista do seletor: o foco continua no campo de busca. */
function repintarSeletor(){
  var s=document.getElementById('cust-f-cat');
  if(!s||!S.rascunho)return;
  s.innerHTML=opcoesDeCategoria(S.rascunho.novaCategoria?NOVA:S.rascunho.categoria,S.rascunho.busca);
}

function criarCategoria(nome,grupo){
  return pv().api('/v1/custos/categorias',{method:'POST',body:{nome:nome,grupo:grupo}}).then(function(c){
    S.dados.categorias.push(c);
    return c;
  });
}

function recarregarDepois(texto,focoId){
  return carregar().then(function(){
    pintarFormulario();
    var n=document.getElementById(focoId||'cust-novo');
    if(n&&!n.disabled)n.focus();
    anunciar(texto);
  });
}

function salvarRecebimento(){
  lerCampos();
  var r=S.rascunho;
  var centavos=centavosDeTexto(r.valor);
  if(centavos===null)return erroDoForm('Informe o valor em reais, por exemplo 1.234,56.');
  if(centavos<=0)return erroDoForm('O valor precisa ser maior que zero.');
  if(centavos>S.dados.limites.valorMaximoCentavos)return erroDoForm('O valor máximo é '+reaisDeCentavos(S.dados.limites.valorMaximoCentavos)+'.');
  if(!r.data)return erroDoForm('Informe a data do recebimento.');
  var obs=String(r.observacao).replace(/\s+/g,' ').trim();
  var botao=document.getElementById('cust-f-salvar');
  if(botao)botao.disabled=true;
  erroDoForm('');
  var req;
  if(!r.id)req=pv().api('/v1/processos/'+encodeURIComponent(S.numero)+'/recebimentos',{method:'POST',body:obs?{data:r.data,valorCentavos:centavos,observacao:obs}:{data:r.data,valorCentavos:centavos}});
  else{
    var o=r.original,diff={};
    if(r.data!==o.data)diff.data=r.data;
    if(centavos!==o.valorCentavos)diff.valorCentavos=centavos;
    if(obs!==o.observacao)diff.observacao=obs||null;
    req=pv().api('/v1/recebimentos/'+encodeURIComponent(r.id),{method:'PATCH',body:diff});
  }
  req.then(function(){
    var novo=!r.id;
    S.rascunho=null;
    return recarregarDepois(novo?'Recebimento registrado.':'Alterações salvas.');
  }).catch(function(e){
    if(!S||!S.rascunho)return;
    pintarFormulario();
    erroDoForm(mensagemDeErro(e));
  });
}

function salvar(){
  if(S.rascunho&&S.rascunho.tipo==='recebimento')return salvarRecebimento();
  lerCampos();
  var r=S.rascunho;
  var desc=String(r.descricao).replace(/\s+/g,' ').trim();
  if(!desc)return erroDoForm('Informe a descrição.');
  var centavos=centavosDeTexto(r.valor);
  if(centavos===null)return erroDoForm('Informe o valor em reais, por exemplo 1.234,56.');
  if(centavos<=0)return erroDoForm('O valor precisa ser maior que zero.');
  if(centavos>S.dados.limites.valorMaximoCentavos)return erroDoForm('O valor máximo de um lançamento é '+reaisDeCentavos(S.dados.limites.valorMaximoCentavos)+'.');
  if(!r.data)return erroDoForm('Informe a data do gasto.');
  var botao=document.getElementById('cust-f-salvar');
  if(botao)botao.disabled=true;
  erroDoForm('');
  var etapa=Promise.resolve(r.categoria);
  if(r.novaCategoria){
    var nome=String(r.nomeNova).replace(/\s+/g,' ').trim();
    if(!nome){if(botao)botao.disabled=false;return erroDoForm('Escreva o nome da nova subcategoria ou escolha uma da lista.')}
    etapa=criarCategoria(nome,r.grupoNovo).then(function(c){r.categoria=c.codigo;r.novaCategoria=false;return c.codigo});
  }
  etapa.then(function(codigo){
    var corpo={data:r.data,descricao:desc,categoria:codigo,valorCentavos:centavos,reembolsavel:r.pagoPor==='cliente'?false:!!r.reembolsavel,pagoPor:r.pagoPor};
    if(!r.id){
      return pv().api(caminhoDoProcesso(S.numero),{method:'POST',body:corpo});
    }
    /* Só o que mudou: uma data antiga já gravada não é revalidada por quem só ajustou a descrição. */
    var o=r.original,diff={};
    if(corpo.data!==o.data)diff.data=corpo.data;
    if(corpo.descricao!==o.descricao)diff.descricao=corpo.descricao;
    if(corpo.categoria!==o.categoria)diff.categoria=corpo.categoria;
    if(corpo.valorCentavos!==o.valorCentavos)diff.valorCentavos=corpo.valorCentavos;
    if(corpo.reembolsavel!==o.reembolsavel)diff.reembolsavel=corpo.reembolsavel;
    if(corpo.pagoPor!==o.pagoPor)diff.pagoPor=corpo.pagoPor;
    return pv().api('/v1/custos/'+encodeURIComponent(r.id),{method:'PATCH',body:diff});
  }).then(function(){
    var novo=!r.id;
    S.rascunho=null;
    return recarregarDepois(novo?'Lançamento salvo.':'Alterações salvas.');
  }).catch(function(e){
    if(!S||!S.rascunho)return;
    /* Subcategoria criada antes de falhar o lançamento: o seletor já a tem. */
    pintarFormulario();
    erroDoForm(mensagemDeErro(e));
  });
}

/* ---------- ações da lista ---------- */
function achar(tipo,id){
  var l=(S.dados&&(tipo==='recebimento'?S.dados.recebimentos:S.dados.lancamentos))||[];
  for(var i=0;i<l.length;i++)if(l[i].id===id)return l[i];
  return null;
}
function caminhoDe(tipo,id){return (tipo==='recebimento'?'/v1/recebimentos/':'/v1/custos/')+encodeURIComponent(id)}
function editar(tipo,id){
  var l=achar(tipo,id);if(!l)return;
  if(tipo==='recebimento'){
    abrirFormulario({tipo:'recebimento',id:l.id,data:l.data,valor:campoDeCentavos(l.valorCentavos),observacao:l.observacao||'',
      original:{data:l.data,valorCentavos:l.valorCentavos,observacao:l.observacao||''}});
    return;
  }
  abrirFormulario({tipo:'lancamento',id:l.id,data:l.data,descricao:l.descricao,categoria:l.categoria,busca:'',valor:campoDeCentavos(l.valorCentavos),
    reembolsavel:l.reembolsavel,pagoPor:l.pagoPor,novaCategoria:false,nomeNova:'',grupoNovo:'12',
    original:{data:l.data,descricao:l.descricao,categoria:l.categoria,valorCentavos:l.valorCentavos,reembolsavel:l.reembolsavel,pagoPor:l.pagoPor}});
}
function pedirCancelamento(tipo,id){
  S.confirmando={tipo:tipo,id:id};
  pintarDados();
  var m=document.getElementById('cust-motivo-'+id);
  if(m)m.focus();
}
function voltarDoCancelamento(tipo,id){
  S.confirmando=null;
  pintarDados();
  var b=document.querySelector('#cust-lista [data-cust="cancelar"][data-id="'+id+'"]');
  if(b)b.focus();
}
function limparAviso(){
  if(S&&S.timer){clearTimeout(S.timer);S.timer=0}
  if(S)S.ultimo=null;
  var a=document.getElementById('cust-aviso');
  if(!a)return;
  /* O foco não fica no vazio quando o aviso some debaixo dele. */
  var tinhaFoco=a.contains(document.activeElement);
  a.innerHTML='';
  var n=document.getElementById('cust-novo');
  if(tinhaFoco&&n&&!n.disabled)n.focus();
}
/* Cancelar NÃO apaga: o servidor guarda o registro. O "Desfazer" só reativa o MESMO registro. */
function cancelar(tipo,id){
  var m=document.getElementById('cust-motivo-'+id);
  var motivo=m?String(m.value).replace(/\s+/g,' ').trim():'';
  pv().api(caminhoDe(tipo,id)+'/cancelamento',{method:'POST',body:motivo?{motivo:motivo}:{}}).then(function(){
    S.confirmando=null;
    return carregar();
  }).then(function(){
    limparAviso();
    S.ultimo={tipo:tipo,id:id};
    var a=document.getElementById('cust-aviso');
    if(a)a.innerHTML='<span>Cancelado.</span> <button type="button" class="bt bt2 cust-mini" data-cust="desfazer">Desfazer</button>';
    S.timer=setTimeout(limparAviso,TEMPO_DO_AVISO_MS);
    anunciar('Cancelado. Desfazer disponível por 6 segundos.');
    var n=document.getElementById('cust-novo');
    if(n&&!S.rascunho)n.focus();
  }).catch(function(e){
    S.confirmando=null;pintarDados();mensagem(mensagemDeErro(e));
  });
}
function reativar(tipo,id,depois){
  pv().api(caminhoDe(tipo,id)+'/cancelamento',{method:'DELETE'}).then(function(){
    return carregar();
  }).then(function(){
    anunciar('Reativado.');
    if(depois)depois();
  }).catch(function(e){mensagem(mensagemDeErro(e))});
}
function desfazer(){
  var u=S.ultimo;if(!u)return;
  limparAviso();
  reativar(u.tipo,u.id,function(){
    var n=document.getElementById('cust-novo');
    if(n)n.focus();
  });
}

/* ---------- histórico ---------- */
function abrirHistorico(tipo,id){
  var x=achar(tipo,id);if(!x)return;
  S.historico={tipo:tipo,id:id,titulo:tipo==='recebimento'?('recebimento de '+dataBr(x.data)):x.descricao,eventos:null,erro:''};
  pintarHistorico();
  var p=document.getElementById('cust-hist-painel');
  if(p)p.focus();
  pv().api(caminhoDe(tipo,id)+'/historico').then(function(r){
    if(!S||!S.historico||S.historico.id!==id)return;
    S.historico.eventos=r.eventos;pintarHistorico();
  }).catch(function(e){
    if(!S||!S.historico||S.historico.id!==id)return;
    S.historico.erro=mensagemDeErro(e);pintarHistorico();
  });
}
function fecharHistorico(){
  if(!S||!S.historico)return;
  var h=S.historico;
  S.historico=null;
  pintarHistorico();
  var b=document.querySelector('#cust-lista [data-cust="historico"][data-id="'+h.id+'"]');
  if(b)b.focus();
}

/* ---------- prestação de contas ---------- */
function baixar(o){
  var msg=document.getElementById(o.msg),botao=document.getElementById(o.botao);
  function dizer(t){if(msg)msg.textContent=t||''}
  var de=document.getElementById('cust-pdf-de').value,ate=document.getElementById('cust-pdf-ate').value;
  if(de&&ate&&de>ate)return dizer('A data inicial não pode ser depois da data final.');
  dizer('');
  var q=o.consulta(de,ate);
  var url=caminhoDoProcesso(S.numero)+o.caminho+(q.length?'?'+q.join('&'):'');
  var chave=pv().chave();
  var numero=S.numero;
  botao.disabled=true;botao.setAttribute('aria-busy','true');botao.textContent='Gerando…';
  fetch(url,{headers:chave?{'x-api-key':chave}:{}}).then(function(r){
    if(!r.ok)return r.json().catch(function(){return{}}).then(function(b){
      var e=new Error(b.mensagem||('HTTP '+r.status));e.status=r.status;e.codigo=b.erro;throw e});
    var cd=r.headers.get('content-disposition')||'';
    var m=/filename="([^"]+)"/.exec(cd);
    return r.blob().then(function(blob){return{blob:blob,nome:m?m[1]:o.padrao+'-'+numero+o.extensao}});
  }).then(function(x){
    var a=document.createElement('a');
    a.href=URL.createObjectURL(x.blob);a.download=x.nome;
    document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);document.body.removeChild(a)},1000);
    dizer('');
    anunciar(o.pronto);
  }).catch(function(e){dizer(mensagemDeErro(e))}).then(function(){
    var b=document.getElementById(o.botao);
    if(b){b.disabled=false;b.removeAttribute('aria-busy');b.textContent=o.rotulo}
  });
}
function gerarPdf(){
  baixar({msg:'cust-pdf-msg',botao:'cust-pdf',caminho:'/prestacao.pdf',padrao:'prestacao-de-contas',extensao:'.pdf',rotulo:'Gerar prestação de contas (PDF)',pronto:'Prestação de contas gerada.',
    consulta:function(de,ate){
      var q=[];
      if(de)q.push('de='+encodeURIComponent(de));
      if(ate)q.push('ate='+encodeURIComponent(ate));
      if(document.getElementById('cust-pdf-cobrar').checked)q.push('somenteACobrar=true');
      return q}});
}
function gerarCsv(){
  baixar({msg:'cust-csv-msg',botao:'cust-csv',caminho:'/lancamentos.csv',padrao:'custos',extensao:'.csv',rotulo:'Exportar planilha (CSV)',pronto:'Planilha gerada.',
    consulta:function(de,ate){
      var q=[];
      if(de)q.push('de='+encodeURIComponent(de));
      if(ate)q.push('ate='+encodeURIComponent(ate));
      if(document.getElementById('cust-csv-canc').checked)q.push('incluirCancelados=true');
      return q}});
}

/* ---------- comprovantes (o arquivo vai direto ao Google Drive do advogado) ---------- */
function avisoDeComprovante(t){
  var a=document.getElementById('cust-comp-aviso');
  if(a)a.textContent=t||'';
}
function irParaAcessos(){if(window.__processovivo_ir)window.__processovivo_ir('credenciais')}
/* Antes de abrir o seletor de arquivo: o Drive está pronto? Cada frase é nossa e fixa. */
function conferirDrive(){
  return pv().api('/v1/drive').then(function(d){
    if(!d||d.habilitado===false)return 'desligado';
    if(d.plano===false)return 'sem_plano';
    if(d.estado==='precisa_reconectar')return 'precisa_reconectar';
    if(d.estado!=='conectado')return 'nao_conectado';
    return '';
  }).catch(function(){return ''});
}
function pedirComprovante(id){
  avisoDeComprovante('');
  conferirDrive().then(function(motivo){
    if(!S)return;
    if(motivo){
      var a=document.getElementById('cust-comp-aviso');
      if(!a)return;
      a.textContent=TEXTO_DO_DRIVE[motivo]||'';
      if(motivo==='nao_conectado'||motivo==='precisa_reconectar'){
        a.appendChild(document.createTextNode(' '));
        var b=document.createElement('button');
        b.type='button';b.className='bt bt2 cust-mini';b.textContent='Abrir Meus acessos';
        b.addEventListener('click',irParaAcessos);
        a.appendChild(b);
      }
      return;
    }
    S.anexandoA=id;
    var inp=document.getElementById('cust-arq');
    if(inp){inp.value='';inp.click()}
  });
}
function frasePorMotivo(e){
  var m=e&&e.detalhes&&e.detalhes.motivo,s=e&&e.status;
  if(m&&TEXTO_DO_DRIVE[m])return TEXTO_DO_DRIVE[m];
  if(m==='tipo_nao_aceito')return 'Anexe um PDF, uma imagem JPEG ou uma imagem PNG.';
  if(m==='arquivo_grande')return 'O comprovante pode ter até 5 MB.';
  if(m==='arquivo_vazio')return 'Escolha um arquivo para anexar.';
  if(m==='drive_cheio')return 'O seu Google Drive está sem espaço. Libere espaço e tente de novo.';
  if(m==='limite_de_uso')return 'O Google Drive pediu uma pausa. Tente de novo em alguns minutos.';
  if(m==='drive_indisponivel')return 'O Google Drive não respondeu agora. Tente de novo em instantes.';
  if(m==='recusado')return 'O Google Drive recusou o arquivo. Confira o comprovante e tente de novo.';
  if(s===413)return 'O comprovante pode ter até 5 MB.';
  if(s===415)return 'Anexe um PDF, uma imagem JPEG ou uma imagem PNG.';
  if(s===422&&e.codigo==='LIMITE_DE_CUSTOS')return 'Este lançamento já tem 5 comprovantes. Remova algum para anexar outro.';
  return mensagemDeErro(e);
}
function enviarComprovante(arquivo){
  var id=S.anexandoA;
  S.anexandoA='';
  if(!id||!arquivo)return;
  if(arquivo.size>LIMITE_ARQUIVO)return avisoDeComprovante('O comprovante pode ter até 5 MB.');
  if(arquivo.size===0)return avisoDeComprovante('Escolha um arquivo para anexar.');
  var chave=pv().chave();
  var cab={'content-type':arquivo.type||'application/octet-stream','x-nome-do-arquivo':encodeURIComponent(arquivo.name||'comprovante')};
  if(chave)cab['x-api-key']=chave;
  avisoDeComprovante('Enviando o comprovante ao seu Google Drive…');
  var botao=document.querySelector('#cust-lista [data-cust="anexar"][data-id="'+id+'"]');
  if(botao)botao.disabled=true;
  fetch('/v1/custos/'+encodeURIComponent(id)+'/comprovantes',{method:'POST',headers:cab,body:arquivo}).then(function(r){
    if(!r.ok)return r.json().catch(function(){return{}}).then(function(b){
      var e=new Error(b.mensagem||('HTTP '+r.status));e.status=r.status;e.codigo=b.erro;e.detalhes=b.detalhes;throw e});
    return r.json();
  }).then(function(){
    return carregar().then(function(){
      avisoDeComprovante('Comprovante anexado. O arquivo ficou no seu Google Drive.');
      anunciar('Comprovante anexado.');
      var b=document.querySelector('#cust-lista [data-cust="anexar"][data-id="'+id+'"]');
      if(b&&!b.disabled)b.focus();
    });
  }).catch(function(e){
    if(!S)return;
    avisoDeComprovante(frasePorMotivo(e));
    if(botao)botao.disabled=false;
  });
}
function removerComprovante(id,comp){
  pv().api('/v1/custos/'+encodeURIComponent(id)+'/comprovantes/'+encodeURIComponent(comp),{method:'DELETE'}).then(function(){
    S.removendoComp='';
    return carregar();
  }).then(function(){
    avisoDeComprovante('Comprovante removido do lançamento. O arquivo continua no seu Google Drive.');
    anunciar('Comprovante removido. O arquivo continua no seu Google Drive.');
    var b=document.querySelector('#cust-lista [data-cust="anexar"][data-id="'+id+'"]');
    if(b)b.focus();
  }).catch(function(e){S.removendoComp='';pintarDados();mensagem(mensagemDeErro(e))});
}

/* "Deixar de acompanhar": o rótulo de cliente mora na pasta do processo. Se o processo tem custos, a
   pessoa é avisada de que ele passa a "Sem cliente" na visão por cliente (os custos NÃO se perdem). */
function avisoAoParar(numero){
  var n=digitos(numero);
  return pv().api(caminhoDoProcesso(n)+'/totais').then(function(t){
    var tem=t&&((t.quantidade||0)>0||(t.totalRecebidoCentavos||0)>0);
    if(!tem)return true;
    return window.confirm('Este processo tem custos lançados. Ao deixar de acompanhar, o rótulo de cliente se perde e o processo passa a aparecer como "Sem cliente" na tela Custos por cliente. Os custos não se perdem. Deixar de acompanhar mesmo assim?');
  }).catch(function(){return true});
}

/* ---------- eventos (delegados no documento; a tela é redesenhada com frequência) ---------- */
document.addEventListener('click',function(ev){
  var t=ev.target&&ev.target.closest?ev.target.closest('#cust-abrir,[data-cust]'):null;
  if(!t||!S)return;
  if(t.id==='cust-abrir'){if(S.aberto)fechar();else abrir();return}
  var a=t.getAttribute('data-cust'),id=t.getAttribute('data-id'),tipo=t.getAttribute('data-tipo');
  if(a==='fechar')fechar();
  else if(a==='novo')abrirFormulario(rascunhoNovo());
  else if(a==='novo-recebimento')abrirFormulario(rascunhoNovoRecebimento());
  else if(a==='cancelar-form')fecharFormulario(true);
  else if(a==='editar')editar(tipo,id);
  else if(a==='cancelar')pedirCancelamento(tipo,id);
  else if(a==='cancelar-nao')voltarDoCancelamento(tipo,id);
  else if(a==='cancelar-sim')cancelar(tipo,id);
  else if(a==='reativar')reativar(tipo,id,function(){
    var b=document.querySelector('#cust-lista [data-cust="historico"][data-id="'+id+'"]');
    if(b)b.focus();
  });
  else if(a==='desfazer')desfazer();
  else if(a==='historico')abrirHistorico(tipo,id);
  else if(a==='hist-fechar')fecharHistorico();
  else if(a==='pdf')gerarPdf();
  else if(a==='csv')gerarCsv();
  else if(a==='anexar')pedirComprovante(id);
  else if(a==='remover-comp'){S.removendoComp=t.getAttribute('data-comp');pintarDados();var rn=document.getElementById('cust-rcn-'+S.removendoComp);if(rn)rn.focus()}
  else if(a==='remover-comp-nao'){var rid=S.removendoComp;S.removendoComp='';pintarDados();var rb=document.querySelector('#cust-lista [data-cust="remover-comp"][data-comp="'+rid+'"]');if(rb)rb.focus()}
  else if(a==='remover-comp-sim')removerComprovante(id,t.getAttribute('data-comp'));
  else if(a==='criar-categoria'){
    lerCampos();
    var nome=String(S.rascunho.nomeNova).replace(/\s+/g,' ').trim();
    if(!nome)return erroDoForm('Escreva o nome da nova subcategoria.');
    criarCategoria(nome,S.rascunho.grupoNovo).then(function(c){
      S.rascunho.categoria=c.codigo;S.rascunho.novaCategoria=false;S.rascunho.nomeNova='';
      pintarDados();pintarFormulario();
      var s=document.getElementById('cust-f-cat');if(s)s.focus();
      anunciar('Subcategoria criada.');
    }).catch(function(e){erroDoForm(mensagemDeErro(e))});
  }
});
document.addEventListener('change',function(ev){
  var t=ev.target;
  if(!S||!t||!t.getAttribute)return;
  if(t.id==='cust-arq'){enviarComprovante(t.files&&t.files[0]);return}
  if(t.id==='cust-f-mostrar-canc'){
    S.mostrarCancelados=t.checked;
    carregar().then(function(){
      var c=document.getElementById('cust-f-mostrar-canc');if(c)c.focus();
      anunciar(S.mostrarCancelados?'Mostrando cancelados.':'Cancelados escondidos.');
    }).catch(function(e){mensagem(mensagemDeErro(e))});
    return;
  }
  if(!S.rascunho)return;
  if(t.id==='cust-f-cat'||t.id==='cust-f-grupo-novo'){
    lerCampos();
    pintarFormulario();
    var f=document.getElementById(S.rascunho.novaCategoria&&t.id==='cust-f-cat'?'cust-f-nova':t.id);
    if(f)f.focus();
    return;
  }
  if(t.name==='cust-f-pago'||t.id==='cust-f-reemb'){
    lerCampos();
    pintarFormulario();
    var c=document.getElementById(t.id);if(c)c.focus();
  }
});
document.addEventListener('input',function(ev){
  if(!S||!ev.target)return;
  if(ev.target.id==='cust-f-valor')atualizarPrevia();
  if(ev.target.id==='cust-f-busca'&&S.rascunho){lerCampos();repintarSeletor();return}
  /* O rascunho acompanha a digitação: a tela do processo pode ser redesenhada (régua chegando) sem perder o que foi escrito. */
  if(S.rascunho&&ev.target.closest&&ev.target.closest('#cust-form'))lerCampos();
});
document.addEventListener('focusout',function(ev){
  var t=ev.target;
  if(!S||!t||t.id!=='cust-f-valor')return;
  var c=centavosDeTexto(t.value);
  if(c!==null&&c>0){t.value=campoDeCentavos(c);atualizarPrevia()}
});
document.addEventListener('submit',function(ev){
  if(ev.target&&ev.target.id==='cust-form'){ev.preventDefault();if(S&&S.rascunho)salvar()}
});
/* Esc com a dica de um ícone aberta fecha SÓ a dica (o ouvinte de ligar() já a fechou quando este roda, por isso
   o estado de antes é guardado na captura); o segundo Esc volta a fazer o que fazia. */
var escSoFechouADica=false;
document.addEventListener('keydown',function(ev){
  var w=ev.key==='Escape'&&ev.target&&ev.target.closest?ev.target.closest('.sit-dica-wrap'):null;
  escSoFechouADica=!!(w&&w.querySelector('.cust-ib')&&!w.classList.contains('sit-dica-fechada'));
},true);
document.addEventListener('keydown',function(ev){
  if(ev.key!=='Escape'||!S||!S.aberto)return;
  if(escSoFechouADica){escSoFechouADica=false;return}
  var p=ev.target&&ev.target.closest?ev.target.closest('#cust-painel'):null;
  if(!p)return;
  if(ev.target.closest&&ev.target.closest('#cust-aviso')){ev.preventDefault();limparAviso();return}
  ev.preventDefault();
  if(S.confirmando){voltarDoCancelamento(S.confirmando.tipo,S.confirmando.id);return}
  if(S.removendoComp){var rc=S.removendoComp;S.removendoComp='';pintarDados();var rb2=document.querySelector('#cust-lista [data-cust="remover-comp"][data-comp="'+rc+'"]');if(rb2)rb2.focus();return}
  if(S.historico){fecharHistorico();return}
  if(S.rascunho){fecharFormulario(true);return}
  fechar();
});

window.__pvCustos={aposDesenhar:aposDesenhar,sair:sair,avisoAoParar:avisoAoParar,abrirPainelDe:abrirPainelDe};
})();
`;

export const ESTILOS_CUSTOS = `
/* Centro de custos (v0.47.0, v0.48.0). Tudo sob #cust-raiz ou .cust-*; a tela do processo não muda enquanto fechado. */
.cust-btn{display:inline-flex;align-items:center;gap:8px}
.cust-btn[aria-expanded="true"]{background:var(--acento-bg);border-color:var(--acento)}
.cust-ic{flex:none}
.cust-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
#cust-raiz{margin:0 0 14px;min-width:0;max-width:100%}
.cust{min-width:0;max-width:100%;background:var(--papel2);border:1px solid var(--linha);border-left:4px solid var(--acento);
  border-radius:var(--r);padding:14px 16px;color:var(--tinta);font-size:13.5px;line-height:1.5;overflow-wrap:anywhere}
.cust:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.cust-topo{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:4px}
.cust-h{margin:0;font-size:15px;font-weight:700}
.cust-nota{margin:0 0 10px;font-size:12.5px;color:var(--tinta2)}
.cust-rot{display:block;margin:12px 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2)}
.cust-tots{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}
.cust-tot{flex:1 1 150px;min-width:0;background:var(--papel);border:1px solid var(--linha);border-radius:var(--r);padding:8px 12px}
.cust-tot dt{font-size:12px;color:var(--tinta2);font-weight:600}
.cust-tot dd{margin:2px 0 0;font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.cust-saldo{border-color:var(--acento);background:var(--acento-bg)}
.cust-subs{margin:0;padding:0;list-style:none}
.cust-subs li{display:flex;flex-wrap:wrap;gap:2px 12px;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--linha)}
.cust-sub-n{flex:1 1 140px;min-width:0}
.cust-sub-q{color:var(--tinta2)}
.cust-sub-v{font-weight:700;font-variant-numeric:tabular-nums}
.cust-barra{margin:12px 0 6px}
.cust-mini{min-height:32px;padding:0 12px;font-size:13px}
.cust-form{margin:10px 0;padding:12px;background:var(--papel);border:1px solid var(--linha);border-radius:var(--r)}
/* Grade do formulário (v0.49.1): quatro faixas iguais; campo comum ocupa uma, o "grande" duas. Começo alinhado
   (align-items:start) — rótulo, caixa e altura do controle são os mesmos em toda a linha, e o texto de apoio
   (a prévia do valor) cai ABAIXO da caixa, em altura reservada, sem empurrar o vizinho. A ordem do DOM (e do Tab)
   não muda. */
.cust-campos{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 12px;align-items:start;margin:8px 0}
.cust-campo{grid-column:span 1;min-width:0}
.cust-campo.cust-grande{grid-column:span 2}
.cust-campo input,.cust-campo select{display:block;width:100%;min-height:44px;box-sizing:border-box}
.cust-campo label{line-height:1.3;min-height:1.3em}
.cust-campos>.cust-marca{grid-column:span 1}
.cust-campos>.cust-nota{grid-column:span 3;align-self:center;margin:0}
.cust-campo>.bt{margin-top:calc(1.3em + 4px)}
.cust-campo label{display:block;font-size:12px;color:var(--tinta2);margin-bottom:4px;font-weight:600}
.cust-marca{display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;font-weight:600}
.cust-marca input{width:20px;height:20px;margin:0;accent-color:var(--acento)}
.cust-previa{display:block;margin-top:4px;font-size:12.5px;line-height:1.3;color:var(--tinta2);min-height:1.3em}
.cust-previa-ruim{color:var(--erro)}
.cust-erro,.cust-msg{color:var(--erro);font-size:13px}
.cust-erro:empty,.cust-msg:empty{display:none}
.cust-erro-lista{color:var(--erro)}
.cust-botoes{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.cust-aviso{font-size:13.5px;color:var(--tinta2)}
.cust-aviso:not(:empty){display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:6px 0;padding:6px 12px;background:var(--papel);border:1px solid var(--linha);border-radius:var(--r)}
.cust-lista{margin:8px 0;min-width:0}
.cust-vazio{margin:6px 0;color:var(--tinta2)}
.cust-tab{width:100%;border-collapse:collapse;table-layout:fixed}
.cust-tab th{font-size:11.5px;text-align:left;color:var(--tinta2);padding:6px 8px;border-bottom:1px solid var(--linha);font-weight:700;vertical-align:bottom}
.cust-tab td{padding:8px;border-bottom:1px solid var(--linha);vertical-align:middle;min-width:0;overflow-wrap:anywhere}
/* Colunas (v0.49.1). As estreitas têm largura de CONTEÚDO em rem e nunca quebram (data, valor, quem pagou, cobrar,
   ações); a Subcategoria fica numa linha só, com reticências e o texto inteiro no title e no nome acessível (o corte
   é visual: o texto continua no DOM); a Descrição fica com o que sobra, até 2 linhas, e só então reticências. */
.cust-tab th:nth-child(1){width:6.5rem}.cust-tab th:nth-child(3){width:25%}.cust-tab th:nth-child(4){width:7.5rem}
.cust-tab th:nth-child(5){width:5.5rem}.cust-tab th:nth-child(6){width:5rem}.cust-tab th:nth-child(7){width:8.5rem}
.cust-tab-rec th:nth-child(1){width:6.5rem}.cust-tab-rec th:nth-child(3){width:7.5rem}.cust-tab-rec th:nth-child(4){width:8.5rem}
.cust-tab td:nth-child(1),.cust-tab td.cust-val,.cust-tab td:nth-child(5),.cust-tab td:nth-child(6){white-space:nowrap}
.cust-sub-t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cust-desc-t{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;overflow-wrap:break-word}
.cust-tab .cust-val{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.cust-cancelado td{color:var(--tinta2)}
.cust-cancelado td.cust-desc,.cust-cancelado td.cust-val{text-decoration:line-through}
.cust-canc{display:block;font-size:12px;font-weight:700;color:var(--erro);text-decoration:none}
.cust-em{display:block;font-size:12px;color:var(--tinta2)}
.cust-nd{color:var(--tinta2)}
.cust-tab td.cust-acoes{white-space:nowrap}
.cust-acoes{display:flex;flex-wrap:nowrap;gap:4px}
/* Ação em ícone: 28x28 (alvo mínimo de 24), sem texto no desktop; o selo do clipe flutua no canto e não muda o tamanho. */
button.cust-ib{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;width:28px;height:28px;min-height:0;padding:0;font-size:13px}
.cust-ib:focus-visible{outline:2px solid var(--acento);outline-offset:1px}
.cust-ib:disabled{opacity:.5;cursor:not-allowed}
.cust-ib-t{display:none}
.cust-ib-n{position:absolute;top:-5px;right:-5px;min-width:15px;height:15px;padding:0 3px;border-radius:8px;background:var(--acento);color:var(--papel);
  font-size:10px;font-weight:700;line-height:15px;text-align:center;font-variant-numeric:tabular-nums}
.cust-acoes .sit-dica-wrap{flex:none}
.cust-acoes .sit-dica{max-width:min(200px,calc(100vw - 48px))}
.cust-conf{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.cust-tab .cust-conf{flex-direction:column;align-items:stretch;white-space:normal}
.cust-perigo{color:var(--erro);border-color:var(--erro)}
.cust-credito{border-color:var(--verde-tinta)}
.cust-pago{border:0;margin:8px 0;padding:0;display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center}
.cust-pago legend{font-size:12px;font-weight:600;color:var(--tinta2);padding:0;margin-bottom:2px;width:100%}
.cust-aviso-grupo{min-height:1.2em;margin:2px 0}
.cust-motivo{min-width:0;flex:1 1 140px}
.cust-motivo-l{font-size:12px;font-weight:600;color:var(--tinta2)}
.cust-escondidos{display:inline-block;margin:0 0 0 8px}
.cust-comp{display:block;margin-top:6px;font-size:12.5px;color:var(--tinta2)}
.cust-comp-n{display:inline-flex;align-items:center;gap:4px;font-weight:700;color:var(--tinta)}
.cust-comp-lista{margin:4px 0 0;padding:0;list-style:none}
.cust-comp-lista li{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center;padding:2px 0;min-width:0}
.cust-comp-nome{overflow-wrap:anywhere}
.cust-comp-aviso{color:var(--tinta);font-size:13px}
.cust-hist{margin:12px 0;padding:10px 12px;background:var(--papel);border:1px solid var(--linha);border-radius:var(--r)}
.cust-hist:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.cust-hist-lista{margin:0;padding:0 0 0 18px}
.cust-hist-lista li{margin:6px 0}
.cust-hist-lista ul{margin:2px 0 0;padding-left:18px}
.cust-pdf{margin-top:14px;padding-top:6px;border-top:1px solid var(--linha)}
/* Entre 900 e 1439 px (lateral + painel) as colunas estreitas encolhem; abaixo de 1280 a letra e as margens também, e
   a Subcategoria pode ir a duas linhas. A Descrição fica com o resto. */
@media (min-width:900px) and (max-width:1439px){
  .cust-tab th:nth-child(1){width:6rem}.cust-tab th:nth-child(3){width:17%}.cust-tab th:nth-child(4){width:6.75rem}
  .cust-tab th:nth-child(5){width:4.5rem}.cust-tab th:nth-child(6){width:3.5rem}.cust-tab th:nth-child(7){width:7.5rem}
  .cust-tab-rec th:nth-child(3){width:6.75rem}.cust-tab-rec th:nth-child(4){width:7.5rem}
}
@media (min-width:900px) and (max-width:1279px){
  .cust-tab th:nth-child(1){width:5rem}.cust-tab th:nth-child(3){width:15%}.cust-tab th:nth-child(4){width:5.75rem}
  .cust-tab th{padding:6px 4px;font-size:11px}
  .cust-tab td{padding:6px 4px;font-size:12.5px}
  .cust-sub-t{white-space:normal;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2}
}
/* Abaixo de 900 px a lista vira cartões: com a lateral, a tabela de 7 colunas não cabe. Sem mouse não há dica, então
   o texto da ação aparece ao lado do ícone (Editar, Cancelar, Comprovante, Histórico, Reativar). */
@media (max-width:899px){
  .cust-tab,.cust-tab tbody,.cust-tab tr,.cust-tab td{display:block;width:100%}
  .cust-tab thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .cust-tab tr{background:var(--papel);border:1px solid var(--linha);border-radius:var(--r);padding:8px 12px;margin:0 0 10px}
  .cust-tab td{display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between;align-items:center;border-bottom:0;padding:4px 0;white-space:normal}
  .cust-tab td::before{content:attr(data-rotulo);font-size:11.5px;font-weight:700;color:var(--tinta2);flex:none}
  .cust-tab .cust-val{text-align:left}
  .cust-tab td.cust-desc{display:block}
  .cust-tab td.cust-desc::before{display:block;margin-bottom:2px}
  .cust-tab td.cust-acoes{justify-content:flex-start;padding-top:8px}
  .cust-tab td.cust-acoes::before{display:none}
  .cust-acoes{flex-wrap:wrap;gap:6px}
  .cust-sub-t,.cust-desc-t{display:block;white-space:normal;overflow:visible;-webkit-line-clamp:unset;line-clamp:unset}
  button.cust-ib{width:auto;min-height:44px;padding:0 12px}
  .cust-ib-t{display:inline}
  .cust-ib-n{top:2px;right:2px}
  .cust-acoes .sit-dica{display:none}
  .cust-mini{min-height:44px}
  .cust-campos{grid-template-columns:1fr}
  .cust-campo,.cust-campo.cust-grande,.cust-campos>.cust-marca,.cust-campos>.cust-nota{grid-column:auto}
  .cust-campo>.bt{margin-top:0}
}
@media (max-width:480px){.cust{padding:12px}.cust-tot{flex-basis:calc(50% - 6px)}}
`;
