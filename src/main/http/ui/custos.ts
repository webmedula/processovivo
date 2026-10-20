import {
  campoDeCentavos,
  centavosDeTexto,
  reaisDeCentavos,
} from '../../../domain/entities/valorEmReais.js';

/**
 * O centro de custos na tela do processo (v0.47.0): o botão "Custos" ao lado dos controles da capa,
 * o painel logo abaixo dela e as chamadas à API, num arquivo só. `script.ts` não cresce (há teste
 * que fixa o tamanho): ele chama `window.__pvCustos.aposDesenhar(numero)` ao ligar os botões do
 * detalhe e `sair()` quando a tela deixa de ser a de um processo — as duas chamadas entraram em
 * linhas que já existiam.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Centro de custos"):
 * - o dinheiro é lido e mostrado pelas MESMAS funções puras do servidor (`valorEmReais.ts`,
 *   injetadas por `toString()`): `1.234,56` e `1234,56` viram centavos INTEIROS por texto, nunca por
 *   multiplicação de decimal, e o servidor só recebe `valorCentavos`;
 * - os totais vêm do servidor; a tela não soma nada. Depois de cada mudança, ela pede a lista de novo;
 * - a caixa "Ressarcido" é a mesma da tela Atualizações (classes `sit-*`, dica `role="tooltip"`,
 *   alvo de 32/44 px), otimista com reversão: se o servidor recusar, a caixa volta e a tela diz;
 * - excluir pede confirmação na linha, é definitivo no servidor (sem lixeira) e mostra "Excluído.
 *   Desfazer" por 6 s: o desfazer RECRIA o lançamento com os mesmos dados (um POST), não restaura nada;
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

/* Estado DESTE processo; null = painel nunca aberto aqui. */
var S=null;

var ICONE='<svg class="cust-ic" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2c1.7.3 2.9.8 2.9 2.1 0 1.2-1.2 2-2.9 2-1.4 0-2.5-.5-3-1.4M12 6.5V8m0 8v1.5"/></svg>';

var DICA_A_COBRAR='A cobrar do cliente. Marque quando ressarcido.';
var DICA_RESSARCIDO='Ressarcido. Clique para desmarcar.';
function textoDaDica(marcado){return marcado?DICA_RESSARCIDO:DICA_A_COBRAR}

function p2(n){return (n<10?'0':'')+n}
function hojeLocal(){var d=new Date();return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}
function dataBr(iso){var m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso||'');return m?m[3]+'/'+m[2]+'/'+m[1]:''}
function caminhoDoProcesso(n){return '/v1/processos/'+encodeURIComponent(n)+'/custos'}

/* Frases de erro: as do servidor para o que é erro de digitação (400/422 de domínio, escritas por nós e
   sem eco do que a pessoa digitou), fixas para o resto. */
function mensagemDeErro(e){
  var s=e&&e.status;
  if((s===400||s===422)&&e.message&&e.codigo!=='REQUISICAO_INVALIDA'&&e.codigo!=='NUMERO_CNJ_INVALIDO')return e.message;
  if(s===400)return 'Confira os campos e tente de novo.';
  if(s===401)return 'Sua sessão expirou. Entre novamente.';
  if(s===402)return 'Sua assinatura está vencida. Regularize para usar o centro de custos.';
  if(s===403)return 'O centro de custos não faz parte do seu plano.';
  if(s===404)return 'Este lançamento não existe mais. Atualize a lista.';
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

function nomeDaCategoria(codigo){
  var l=(S&&S.dados&&S.dados.categorias)||[];
  for(var i=0;i<l.length;i++)if(l[i].codigo===codigo)return l[i].nome+(l[i].arquivada?' (arquivada)':'');
  return 'Outros';
}

/* ---------- desenho ---------- */
function totaisHtml(){
  var t=S.dados.totais;
  function c(rot,v,cls){return '<div class="cust-tot '+(cls||'')+'"><dt>'+rot+'</dt><dd>'+reaisDeCentavos(v)+'</dd></div>'}
  var h='<dl class="cust-tots">'+c('Total gasto',t.totalGastoCentavos)+c('Reembolsável',t.totalReembolsavelCentavos)+
    c('Já ressarcido',t.totalRessarcidoCentavos)+c('Saldo a cobrar',t.saldoACobrarCentavos,'cust-saldo')+'</dl>';
  if(t.porCategoria.length){
    h+='<h4 class="cust-rot">Por categoria</h4><ul class="cust-subs">'+t.porCategoria.map(function(s){
      return '<li><span class="cust-sub-n">'+esc(s.nome)+'</span><span class="cust-sub-q">'+s.quantidade+' '+
        (s.quantidade===1?'lançamento':'lançamentos')+'</span><span class="cust-sub-v">'+reaisDeCentavos(s.totalCentavos)+'</span></li>'}).join('')+'</ul>';
  }
  return h;
}

function linhaHtml(l){
  var id=esc(l.id);
  var ress=l.ressarcidoEm;
  var rotulo=esc(l.descricao);
  var cx;
  if(l.reembolsavel){
    var dica='cust-dica-'+id;
    cx='<span class="sit-dica-wrap"><label class="sit-cx"><input type="checkbox" class="sit-cx-in" data-cx="ressarcido" data-id="'+id+
      '" aria-label="Ressarcido: '+rotulo+'" aria-describedby="'+dica+'"'+(ress?' checked':'')+'><span class="sit-cx-txt">Ressarcido</span></label>'+
      '<span class="sit-dica" role="tooltip" id="'+dica+'">'+esc(textoDaDica(!!ress))+'</span></span>'+
      (ress?'<span class="cust-em">em '+esc(dataBr(ress))+'</span>':'');
  }else cx='<span class="cust-nd" aria-label="Ressarcimento não se aplica">—</span>';
  var acoes;
  if(S.confirmando===l.id){
    acoes='<span class="cust-conf" role="group" aria-label="Confirmar exclusão"><span>Excluir este lançamento?</span>'+
      '<button type="button" class="bt bt2 cust-perigo" data-cust="excluir-sim" data-id="'+id+'">Excluir</button>'+
      '<button type="button" class="bt bt2" data-cust="excluir-nao" data-id="'+id+'" id="cust-nao-'+id+'">Cancelar</button></span>';
  }else{
    acoes='<button type="button" class="bt bt2 cust-mini" data-cust="editar" data-id="'+id+'" aria-label="Editar: '+rotulo+'">Editar</button>'+
      '<button type="button" class="bt bt2 cust-mini" data-cust="excluir" data-id="'+id+'" aria-label="Excluir: '+rotulo+'">Excluir</button>';
  }
  return '<tr data-id="'+id+'"'+(ress?' class="cust-ress"':'')+'>'+
    '<td data-rotulo="Data">'+esc(dataBr(l.data))+'</td>'+
    '<td data-rotulo="Descrição" class="cust-desc">'+esc(l.descricao)+'</td>'+
    '<td data-rotulo="Categoria">'+esc(nomeDaCategoria(l.categoria))+'</td>'+
    '<td data-rotulo="Valor" class="cust-val">'+reaisDeCentavos(l.valorCentavos)+'</td>'+
    '<td data-rotulo="Reembolsável">'+(l.reembolsavel?'Sim':'Não')+'</td>'+
    '<td data-rotulo="Ressarcido" class="cust-c-ress">'+cx+'</td>'+
    '<td data-rotulo="Ações" class="cust-acoes">'+acoes+'</td></tr>';
}

function listaHtml(){
  var l=S.dados.lancamentos;
  if(!l.length)return '<p class="cust-vazio">Nenhum custo lançado neste processo. Adicione o primeiro.</p>';
  return '<table class="cust-tab"><caption class="cust-sr">Lançamentos do processo, do mais recente para o mais antigo</caption>'+
    '<thead><tr><th scope="col">Data</th><th scope="col">Descrição</th><th scope="col">Categoria</th><th scope="col" class="cust-val">Valor</th>'+
    '<th scope="col">Reembolsável</th><th scope="col">Ressarcido</th><th scope="col">Ações</th></tr></thead><tbody>'+
    l.map(linhaHtml).join('')+'</tbody></table>';
}

function opcoesDeCategoria(atual){
  var h='';
  S.dados.categorias.forEach(function(c){
    if(c.arquivada&&c.codigo!==atual)return;
    h+='<option value="'+esc(c.codigo)+'"'+(c.codigo===atual?' selected':'')+'>'+esc(c.nome)+(c.arquivada?' (arquivada)':'')+'</option>';
  });
  return h+'<option value="'+NOVA+'"'+(atual===NOVA?' selected':'')+'>Nova categoria…</option>';
}

function formHtml(){
  var r=S.rascunho;
  var lim=S.dados.limites;
  var h='<form class="cust-form" id="cust-form" novalidate aria-labelledby="cust-form-tit">'+
    '<h4 class="cust-rot" id="cust-form-tit">'+(r.id?'Editar lançamento':'Novo lançamento')+'</h4>'+
    '<div class="cust-campos">'+
    '<div class="cust-campo"><label for="cust-f-data">Data do gasto</label><input id="cust-f-data" type="date" value="'+esc(r.data)+'" required></div>'+
    '<div class="cust-campo cust-grande"><label for="cust-f-desc">Descrição</label><input id="cust-f-desc" type="text" maxlength="'+lim.descricao+
      '" value="'+esc(r.descricao)+'" required autocomplete="off"></div>'+
    '<div class="cust-campo"><label for="cust-f-cat">Categoria</label><select id="cust-f-cat">'+opcoesDeCategoria(r.novaCategoria?NOVA:r.categoria)+'</select></div>'+
    '<div class="cust-campo"><label for="cust-f-valor">Valor (R$)</label><input id="cust-f-valor" type="text" inputmode="decimal" autocomplete="off" '+
      'placeholder="0,00" value="'+esc(r.valor)+'" aria-describedby="cust-f-previa" required><span class="cust-previa" id="cust-f-previa" aria-live="polite"></span></div>'+
    '</div>'+
    (r.novaCategoria?'<div class="cust-campos"><div class="cust-campo cust-grande"><label for="cust-f-nova">Nome da nova categoria</label>'+
      '<input id="cust-f-nova" type="text" maxlength="'+lim.nomeDaCategoria+'" value="'+esc(r.nomeNova)+'" autocomplete="off"></div>'+
      '<div class="cust-campo"><button type="button" class="bt bt2" data-cust="criar-categoria">Criar categoria</button></div></div>':'')+
    '<div class="cust-campos">'+
    '<label class="cust-marca"><input type="checkbox" id="cust-f-reemb"'+(r.reembolsavel?' checked':'')+'> Cobrar do cliente</label>'+
    (r.id&&r.reembolsavel&&r.ressarcidoEm?'<div class="cust-campo"><label for="cust-f-ress">Ressarcido em</label><input id="cust-f-ress" type="date" value="'+esc(r.ressarcidoEm)+'"></div>':'')+
    '</div>'+
    '<div class="cust-erro" id="cust-f-erro" role="alert"></div>'+
    '<div class="cust-botoes"><button type="submit" class="bt" id="cust-f-salvar">'+(r.id?'Salvar alterações':'Salvar lançamento')+
    '</button><button type="button" class="bt bt2" data-cust="cancelar-form">Cancelar</button></div></form>';
  return h;
}

function esqueleto(){
  return '<section class="cust" id="cust-painel" role="region" aria-labelledby="cust-tit" tabindex="-1">'+
    '<div class="cust-topo"><h3 class="cust-h" id="cust-tit">Custos do processo</h3>'+
    '<button type="button" class="bt bt2 cust-mini" data-cust="fechar">Fechar</button></div>'+
    '<p class="cust-nota">Valores informados por você, só visíveis na sua conta. Não vêm do tribunal.</p>'+
    '<div id="cust-totais"></div>'+
    '<div class="cust-barra"><button type="button" class="bt" data-cust="novo" id="cust-novo">Novo lançamento</button></div>'+
    '<div id="cust-formulario"></div>'+
    '<div class="cust-aviso" id="cust-aviso" role="status"></div>'+
    '<div id="cust-msg" class="cust-msg" role="alert"></div>'+
    '<div id="cust-lista" class="cust-lista"></div>'+
    '<div class="cust-pdf"><h4 class="cust-rot">Prestação de contas</h4>'+
    '<p class="cust-nota">Gera um PDF para enviar ao cliente, com os lançamentos, os subtotais e os totais. Não leva partes nem texto de ato.</p>'+
    '<div class="cust-campos">'+
    '<div class="cust-campo"><label for="cust-pdf-de">De</label><input id="cust-pdf-de" type="date"></div>'+
    '<div class="cust-campo"><label for="cust-pdf-ate">Até</label><input id="cust-pdf-ate" type="date"></div>'+
    '<label class="cust-marca"><input type="checkbox" id="cust-pdf-cobrar"> Somente o que está a cobrar</label></div>'+
    '<div class="cust-botoes"><button type="button" class="bt bt2" data-cust="pdf" id="cust-pdf">Gerar prestação de contas (PDF)</button></div>'+
    '<div id="cust-pdf-msg" class="cust-msg" role="alert"></div></div></section>';
}

function pintarDados(){
  var t=document.getElementById('cust-totais'),l=document.getElementById('cust-lista');
  if(!S||!S.dados||!t||!l)return;
  t.innerHTML=totaisHtml();
  l.innerHTML=listaHtml();
}
function pintarFormulario(){
  var f=document.getElementById('cust-formulario');
  if(!f||!S)return;
  f.innerHTML=S.rascunho?formHtml():'';
  atualizarPrevia();
  var n=document.getElementById('cust-novo');
  if(n)n.disabled=!!S.rascunho;
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
  }
  raiz.innerHTML=esqueleto();
  pintarDados();pintarFormulario();
  ligarDicas();
  marcarBotao();
  return true;
}
function marcarBotao(){
  var b=document.getElementById('cust-abrir');
  if(b)b.setAttribute('aria-expanded',S&&S.aberto?'true':'false');
}
function ligarDicas(){
  var raiz=document.getElementById('cust-raiz');
  if(raiz&&!raiz.getAttribute('data-dicas')&&window.__pvProvidencia){
    raiz.setAttribute('data-dicas','1');
    window.__pvProvidencia.ligar(raiz);
  }
}

function aposDesenhar(numero){
  var n=digitos(numero);
  if(S&&S.numero!==n)descartar();
  var capa=document.querySelector('#conteudo .capa');
  var num=capa?capa.querySelector('.num'):null;
  if(!capa||!num||digitos(num.textContent)!==n)return;
  if(!S)S={numero:n,aberto:false,dados:null,rascunho:null,confirmando:'',salvando:{},ultimo:null,timer:0};
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
}

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
  return pv().api(caminhoDoProcesso(n)).then(function(d){
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
  S.aberto=false;S.rascunho=null;S.confirmando='';
  limparAviso();
  montarRaiz();
  var b=document.getElementById('cust-abrir');
  if(b)b.focus();
}

/* ---------- formulário ---------- */
function rascunhoNovo(){
  return {id:'',data:hojeLocal(),descricao:'',categoria:'custas',valor:'',reembolsavel:false,ressarcidoEm:'',novaCategoria:false,nomeNova:'',original:null};
}
function abrirFormulario(r){
  S.rascunho=r;
  pintarFormulario();
  var f=document.getElementById(r.id?'cust-f-desc':'cust-f-data');
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
  var t=v('cust-f-desc');if(t!==null)r.descricao=t;
  var c=v('cust-f-cat');
  if(c!==null){if(c===NOVA)r.novaCategoria=true;else{r.novaCategoria=false;r.categoria=c}}
  var m=v('cust-f-valor');if(m!==null)r.valor=m;
  var nn=v('cust-f-nova');if(nn!==null)r.nomeNova=nn;
  var cb=document.getElementById('cust-f-reemb');if(cb)r.reembolsavel=cb.checked;
  var rs=v('cust-f-ress');if(rs!==null)r.ressarcidoEm=rs;
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

function criarCategoria(nome){
  return pv().api('/v1/custos/categorias',{method:'POST',body:{nome:nome}}).then(function(c){
    S.dados.categorias.push(c);
    return c;
  });
}

function salvar(){
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
    if(!nome){if(botao)botao.disabled=false;return erroDoForm('Escreva o nome da nova categoria ou escolha uma da lista.')}
    etapa=criarCategoria(nome).then(function(c){r.categoria=c.codigo;r.novaCategoria=false;return c.codigo});
  }
  etapa.then(function(codigo){
    var corpo={data:r.data,descricao:desc,categoria:codigo,valorCentavos:centavos,reembolsavel:!!r.reembolsavel};
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
    if(corpo.reembolsavel&&o.ressarcidoEm&&r.ressarcidoEm&&r.ressarcidoEm!==o.ressarcidoEm)diff.ressarcidoEm=r.ressarcidoEm;
    return pv().api('/v1/custos/'+encodeURIComponent(r.id),{method:'PATCH',body:diff});
  }).then(function(){
    var novo=!r.id;
    S.rascunho=null;
    return carregar().then(function(){
      pintarFormulario();
      var n=document.getElementById('cust-novo');
      if(n)n.focus();
      anunciar(novo?'Lançamento salvo.':'Alterações salvas.');
    });
  }).catch(function(e){
    if(!S||!S.rascunho)return;
    /* Categoria criada antes de falhar o lançamento: o seletor já a tem. */
    pintarFormulario();
    erroDoForm(mensagemDeErro(e));
  });
}

/* ---------- ações da lista ---------- */
function acharLancamento(id){
  var l=(S.dados&&S.dados.lancamentos)||[];
  for(var i=0;i<l.length;i++)if(l[i].id===id)return l[i];
  return null;
}
function editar(id){
  var l=acharLancamento(id);if(!l)return;
  abrirFormulario({id:l.id,data:l.data,descricao:l.descricao,categoria:l.categoria,valor:campoDeCentavos(l.valorCentavos),
    reembolsavel:l.reembolsavel,ressarcidoEm:l.ressarcidoEm||'',novaCategoria:false,nomeNova:'',
    original:{data:l.data,descricao:l.descricao,categoria:l.categoria,valorCentavos:l.valorCentavos,reembolsavel:l.reembolsavel,ressarcidoEm:l.ressarcidoEm||''}});
}
function pedirExclusao(id){
  S.confirmando=id;
  pintarDados();
  var b=document.getElementById('cust-nao-'+id);
  if(b)b.focus();
}
function cancelarExclusao(id){
  S.confirmando='';
  pintarDados();
  var b=document.querySelector('#cust-lista [data-cust="excluir"][data-id="'+id+'"]');
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
function excluir(id){
  var l=acharLancamento(id);if(!l)return;
  var copia={data:l.data,descricao:l.descricao,categoria:l.categoria,valorCentavos:l.valorCentavos,reembolsavel:l.reembolsavel};
  if(l.ressarcidoEm)copia.ressarcidoEm=l.ressarcidoEm;
  pv().api('/v1/custos/'+encodeURIComponent(id),{method:'DELETE'}).then(function(){
    S.confirmando='';
    return carregar();
  }).then(function(){
    limparAviso();
    S.ultimo=copia;
    var a=document.getElementById('cust-aviso');
    if(a)a.innerHTML='<span>Excluído.</span> <button type="button" class="bt bt2 cust-mini" data-cust="desfazer">Desfazer</button>';
    S.timer=setTimeout(limparAviso,TEMPO_DO_AVISO_MS);
    anunciar('Lançamento excluído. Desfazer disponível por 6 segundos.');
    var n=document.getElementById('cust-novo');
    if(n&&!S.rascunho)n.focus();
  }).catch(function(e){
    S.confirmando='';pintarDados();mensagem(mensagemDeErro(e));
  });
}
function desfazer(){
  var c=S.ultimo;if(!c)return;
  limparAviso();
  pv().api(caminhoDoProcesso(S.numero),{method:'POST',body:c}).then(function(){
    return carregar();
  }).then(function(){
    anunciar('Lançamento restaurado.');
    var n=document.getElementById('cust-novo');
    if(n)n.focus();
  }).catch(function(e){mensagem('Não foi possível desfazer. '+mensagemDeErro(e))});
}

/* "Ressarcido": otimista. A caixa já mudou quando o evento chega; se o servidor recusar, ela volta. */
function ressarcir(cx){
  var id=cx.getAttribute('data-id'),marcar=cx.checked;
  if(S.salvando[id]){cx.checked=!marcar;return}
  S.salvando[id]=1;
  cx.setAttribute('aria-busy','true');
  var wrap=cx.closest('.sit-dica-wrap'),dica=wrap?wrap.querySelector('.sit-dica'):null;
  if(dica)dica.textContent=textoDaDica(marcar);
  mensagem('');
  pv().api('/v1/custos/'+encodeURIComponent(id)+'/ressarcimento',marcar?{method:'PUT',body:{}}:{method:'DELETE'}).then(function(){
    delete S.salvando[id];
    return carregar();
  }).then(function(){
    var novo=document.querySelector('#cust-lista [data-cx="ressarcido"][data-id="'+id+'"]');
    if(novo)novo.focus();
    anunciar(marcar?'Marcado como ressarcido.':'Ressarcimento desmarcado.');
  }).catch(function(e){
    if(!S)return;
    delete S.salvando[id];
    cx.checked=!marcar;cx.removeAttribute('aria-busy');
    if(dica)dica.textContent=textoDaDica(!marcar);
    mensagem('Não foi possível salvar. Tente de novo.'+((e&&(e.status===400||e.status===422)&&e.message&&e.codigo!=='REQUISICAO_INVALIDA')?' '+e.message:''));
  });
}

/* ---------- prestação de contas ---------- */
function gerarPdf(){
  var msg=document.getElementById('cust-pdf-msg'),botao=document.getElementById('cust-pdf');
  function dizer(t){if(msg)msg.textContent=t||''}
  var de=document.getElementById('cust-pdf-de').value,ate=document.getElementById('cust-pdf-ate').value;
  var cobrar=document.getElementById('cust-pdf-cobrar').checked;
  if(de&&ate&&de>ate)return dizer('A data inicial não pode ser depois da data final.');
  dizer('');
  var q=[];
  if(de)q.push('de='+encodeURIComponent(de));
  if(ate)q.push('ate='+encodeURIComponent(ate));
  if(cobrar)q.push('somenteACobrar=true');
  var url=caminhoDoProcesso(S.numero)+'/prestacao.pdf'+(q.length?'?'+q.join('&'):'');
  var chave=pv().chave();
  var numero=S.numero;
  botao.disabled=true;botao.setAttribute('aria-busy','true');botao.textContent='Gerando…';
  fetch(url,{headers:chave?{'x-api-key':chave}:{}}).then(function(r){
    if(!r.ok)return r.json().catch(function(){return{}}).then(function(b){
      var e=new Error(b.mensagem||('HTTP '+r.status));e.status=r.status;e.codigo=b.erro;throw e});
    var cd=r.headers.get('content-disposition')||'';
    var m=/filename="([^"]+)"/.exec(cd);
    return r.blob().then(function(blob){return{blob:blob,nome:m?m[1]:'prestacao-de-contas-'+numero+'.pdf'}});
  }).then(function(x){
    var a=document.createElement('a');
    a.href=URL.createObjectURL(x.blob);a.download=x.nome;
    document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);document.body.removeChild(a)},1000);
    dizer('');
    anunciar('Prestação de contas gerada.');
  }).catch(function(e){dizer(mensagemDeErro(e))}).then(function(){
    var b=document.getElementById('cust-pdf');
    if(b){b.disabled=false;b.removeAttribute('aria-busy');b.textContent='Gerar prestação de contas (PDF)'}
  });
}

/* ---------- eventos (delegados no documento; a tela é redesenhada com frequência) ---------- */
document.addEventListener('click',function(ev){
  var t=ev.target&&ev.target.closest?ev.target.closest('#cust-abrir,[data-cust]'):null;
  if(!t||!S)return;
  if(t.id==='cust-abrir'){if(S.aberto)fechar();else abrir();return}
  var a=t.getAttribute('data-cust'),id=t.getAttribute('data-id');
  if(a==='fechar')fechar();
  else if(a==='novo')abrirFormulario(rascunhoNovo());
  else if(a==='cancelar-form')fecharFormulario(true);
  else if(a==='editar')editar(id);
  else if(a==='excluir')pedirExclusao(id);
  else if(a==='excluir-nao')cancelarExclusao(id);
  else if(a==='excluir-sim')excluir(id);
  else if(a==='desfazer')desfazer();
  else if(a==='pdf')gerarPdf();
  else if(a==='criar-categoria'){
    lerCampos();
    var nome=String(S.rascunho.nomeNova).replace(/\s+/g,' ').trim();
    if(!nome)return erroDoForm('Escreva o nome da nova categoria.');
    criarCategoria(nome).then(function(c){
      S.rascunho.categoria=c.codigo;S.rascunho.novaCategoria=false;S.rascunho.nomeNova='';
      pintarDados();pintarFormulario();
      var s=document.getElementById('cust-f-cat');if(s)s.focus();
      anunciar('Categoria criada.');
    }).catch(function(e){erroDoForm(mensagemDeErro(e))});
  }
});
document.addEventListener('change',function(ev){
  var t=ev.target;
  if(!S||!t||!t.getAttribute)return;
  if(t.getAttribute('data-cx')==='ressarcido'){ressarcir(t);return}
  if(t.id==='cust-f-cat'){
    lerCampos();
    pintarFormulario();
    var f=document.getElementById(S.rascunho.novaCategoria?'cust-f-nova':'cust-f-cat');
    if(f)f.focus();
    return;
  }
  if(t.id==='cust-f-reemb'){
    lerCampos();
    if(!S.rascunho.reembolsavel)S.rascunho.ressarcidoEm='';
    pintarFormulario();
    var c=document.getElementById('cust-f-reemb');if(c)c.focus();
  }
});
document.addEventListener('input',function(ev){
  if(!S||!ev.target)return;
  if(ev.target.id==='cust-f-valor')atualizarPrevia();
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
document.addEventListener('keydown',function(ev){
  if(ev.key!=='Escape'||!S||!S.aberto)return;
  var p=ev.target&&ev.target.closest?ev.target.closest('#cust-painel'):null;
  if(!p)return;
  if(ev.target.closest&&ev.target.closest('#cust-aviso')){ev.preventDefault();limparAviso();return}
  /* A dica de "Ressarcido" também fecha com Esc (providencia.ts): aqui só o painel e o formulário. */
  if(ev.target.closest&&ev.target.closest('.sit-dica-wrap'))return;
  ev.preventDefault();
  if(S.confirmando){var id=S.confirmando;cancelarExclusao(id);return}
  if(S.rascunho){fecharFormulario(true);return}
  fechar();
});

window.__pvCustos={aposDesenhar:aposDesenhar,sair:sair};
})();
`;

export const ESTILOS_CUSTOS = `
/* Centro de custos (v0.47.0). Tudo sob #cust-raiz ou .cust-*; a tela do processo não muda enquanto fechado. */
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
.cust-campos{display:flex;flex-wrap:wrap;gap:10px 12px;align-items:flex-end;margin:8px 0}
.cust-campo{flex:1 1 150px;min-width:0}
.cust-campo.cust-grande{flex:2 1 260px}
.cust-campo label{display:block;font-size:12px;color:var(--tinta2);margin-bottom:4px;font-weight:600}
.cust-marca{display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;font-weight:600}
.cust-marca input{width:20px;height:20px;margin:0;accent-color:var(--acento)}
.cust-previa{display:block;margin-top:4px;font-size:12.5px;color:var(--tinta2);min-height:1.2em}
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
.cust-tab th{font-size:11.5px;text-align:left;color:var(--tinta2);padding:6px 8px;border-bottom:1px solid var(--linha);font-weight:700}
.cust-tab td{padding:8px;border-bottom:1px solid var(--linha);vertical-align:top;min-width:0;overflow-wrap:anywhere}
.cust-tab th:nth-child(1){width:86px}.cust-tab th:nth-child(3){width:128px}.cust-tab th:nth-child(4){width:108px}
.cust-tab th:nth-child(5){width:96px}.cust-tab th:nth-child(6){width:104px}.cust-tab th:nth-child(7){width:150px}
.cust-tab .cust-val{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.cust-ress td.cust-desc{color:var(--tinta2)}
.cust-em{display:block;font-size:12px;color:var(--tinta2)}
.cust-nd{color:var(--tinta2)}
.cust-acoes{display:flex;flex-wrap:wrap;gap:6px}
.cust-conf{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.cust-perigo{color:var(--erro);border-color:var(--erro)}
.cust-c-ress .sit-dica-wrap{display:inline-block}
/* A caixa fica à direita da linha/cartão: a dica cresce para a ESQUERDA em qualquer largura (a de Atualizações
   cresce para a direita no empilhado, o que aqui criaria rolagem horizontal). */
.cust .sit-dica{right:0;left:auto}
.cust-pdf{margin-top:14px;padding-top:6px;border-top:1px solid var(--linha)}
/* Abaixo de 1100 px a lista vira cartões: a tabela de 7 colunas não cabe ao lado da lateral. */
@media (max-width:1099px){
  .cust-tab,.cust-tab tbody,.cust-tab tr,.cust-tab td{display:block;width:100%}
  .cust-tab thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .cust-tab tr{background:var(--papel);border:1px solid var(--linha);border-radius:var(--r);padding:8px 12px;margin:0 0 10px}
  .cust-tab td{display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between;align-items:center;border-bottom:0;padding:4px 0}
  .cust-tab td::before{content:attr(data-rotulo);font-size:11.5px;font-weight:700;color:var(--tinta2);flex:none}
  .cust-tab .cust-val{text-align:left}
  .cust-tab td.cust-desc{display:block}
  .cust-tab td.cust-desc::before{display:block;margin-bottom:2px}
  .cust-tab td.cust-acoes{justify-content:flex-start;padding-top:8px}
  .cust-tab td.cust-acoes::before{display:none}
  .cust-mini{min-height:44px}
  .cust-c-ress .sit-cx-txt{display:inline}
}
@media (max-width:480px){.cust{padding:12px}.cust-tot{flex-basis:calc(50% - 6px)}}
`;
