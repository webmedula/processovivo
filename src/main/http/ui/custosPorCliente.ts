import { reaisDeCentavos } from '../../../domain/entities/valorEmReais.js';

/**
 * A tela "Custos" do menu (v0.49.0): os custos juntados POR CLIENTE, com o PDF consolidado e a planilha.
 *
 * Arquivo próprio, como o calendário e o painel de custos do processo: `script.ts` não cresce (há teste
 * que fixa o tamanho) e só liga esta tela por uma linha no `render()` e pelo menu. Conversa com o
 * console só por `window.__pv` (`api`, `esc`, `chave`, `abrir`) e entrega `window.__pvCustosCliente.ver`.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Centro de custos"):
 * - o "cliente" é o RÓTULO que o advogado deu à pasta do processo, e só processo ACOMPANHADO tem pasta.
 *   Processo sem rótulo — ou que deixou de ser acompanhado — aparece em "Sem cliente", e a tela AVISA
 *   quantos são, em vez de escondê-los. Os custos não se perdem: só o agrupamento;
 * - os totais vêm do servidor; a tela não soma nem refaz saldo. Saldo e crédito são por processo;
 * - toda lista diz quantas linhas mostra do total SEM filtro ("Mostrando X de Y clientes");
 * - o dinheiro é mostrado pela MESMA função pura do servidor (`valorEmReais.ts`, por `toString()`);
 * - todo texto vindo do servidor passa por `esc()`; toda frase de erro é nossa e fixa; nada vai a
 *   `localStorage` — o filtro vive na página, e recarregar volta ao padrão;
 * - PDF e planilha nascem na resposta e são baixados pelo navegador: nada fica guardado.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc;
 * `tests/http/console-script.spec.ts` roda o ESLint aqui dentro.
 */
export const SCRIPT_CUSTOS_CLIENTE = String.raw`
(function(){
var pv=function(){return window.__pv};
function esc(s){return pv().esc(s)}
var reaisDeCentavos=${reaisDeCentavos.toString()};

var SEM_CLIENTE='~sem-cliente';
var st={alvo:null,filtro:{de:'',ate:'',saldo:false,cliente:''},dados:null,detalhe:null,csvCanc:false,rodada:0};

function mensagemDeErro(e){
  var s=e&&e.status;
  if((s===400||s===422)&&e.message&&e.codigo!=='REQUISICAO_INVALIDA')return e.message;
  if(s===400)return 'Confira o período e tente de novo.';
  if(s===401)return 'Sua sessão expirou. Entre novamente.';
  if(s===402)return 'Sua assinatura está vencida. Regularize para usar o centro de custos.';
  if(s===403)return 'O centro de custos não faz parte do seu plano.';
  if(s===404)return 'Este cliente não tem mais custos neste filtro. Atualize a lista.';
  if(s===429)return 'Muitas operações seguidas. Aguarde um instante.';
  return 'Não foi possível concluir. Tente de novo.';
}

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

function consulta(extra){
  var q=[];
  if(st.filtro.de)q.push('de='+encodeURIComponent(st.filtro.de));
  if(st.filtro.ate)q.push('ate='+encodeURIComponent(st.filtro.ate));
  if(st.filtro.saldo)q.push('somenteComSaldo=true');
  (extra||[]).forEach(function(x){q.push(x)});
  return q.length?'?'+q.join('&'):'';
}

/* ---------- esqueleto ---------- */
function ver(alvo){
  st.alvo=alvo;st.detalhe=null;st.dados=null;
  alvo.innerHTML='<div class="cc" id="cc">'+
    '<div class="cc-topo"><h2 class="cc-h" id="cc-tit" tabindex="-1">Custos</h2></div>'+
    '<p class="cc-nota">Valores informados por você, só visíveis na sua conta. O cliente é o rótulo que você deu à pasta do processo (em Meus processos).</p>'+
    '<form class="cc-filtros" id="cc-filtros" role="search" aria-label="Filtros dos custos">'+
      '<div class="cc-campo"><label for="cc-f-cliente">Cliente</label><select id="cc-f-cliente"><option value="">Todos os clientes</option></select></div>'+
      '<div class="cc-campo"><label for="cc-f-de">De</label><input id="cc-f-de" type="date" value="'+esc(st.filtro.de)+'"></div>'+
      '<div class="cc-campo"><label for="cc-f-ate">Até</label><input id="cc-f-ate" type="date" value="'+esc(st.filtro.ate)+'"></div>'+
      '<label class="cc-marca"><input type="checkbox" id="cc-f-saldo"'+(st.filtro.saldo?' checked':'')+'> Somente com saldo a cobrar</label>'+
    '</form>'+
    '<div id="cc-aviso"></div><div id="cc-msg" class="cc-msg" role="alert"></div>'+
    '<div id="cc-corpo"><p class="cc-vazio">Carregando…</p></div></div>';
  carregar();
}

function carregar(){
  var rodada=++st.rodada;
  var corpo=document.getElementById('cc-corpo');
  pv().api('/v1/custos/clientes'+consulta()).then(function(d){
    if(rodada!==st.rodada||!st.alvo)return;
    st.dados=d;
    pintarOpcoes();
    pintarLista();
  }).catch(function(e){
    if(rodada!==st.rodada)return;
    var c=document.getElementById('cc-corpo');
    if(c)c.innerHTML='<p class="cc-vazio cc-erro">'+esc(mensagemDeErro(e))+'</p>';
  });
  if(corpo&&!st.dados)corpo.innerHTML='<p class="cc-vazio">Carregando…</p>';
}

function pintarOpcoes(){
  var s=document.getElementById('cc-f-cliente');
  if(!s||!st.dados)return;
  var atual=st.filtro.cliente;
  var h='<option value="">Todos os clientes</option>';
  st.dados.clientes.forEach(function(c){
    h+='<option value="'+esc(c.chave)+'"'+(c.chave===atual?' selected':'')+'>'+esc(c.nome)+'</option>';
  });
  s.innerHTML=h;
}

function pintarLista(){
  var corpo=document.getElementById('cc-corpo'),aviso=document.getElementById('cc-aviso');
  if(!corpo||!st.dados)return;
  var d=st.dados;
  var lista=d.clientes.filter(function(c){return !st.filtro.cliente||c.chave===st.filtro.cliente});
  /* Processos sem rótulo: a tela diz, em vez de deixá-los num canto. */
  aviso.innerHTML=d.processosSemCliente>0?'<p class="cc-aviso" role="note">'+d.processosSemCliente+' '+
    (d.processosSemCliente===1?'processo com custos está sem cliente':'processos com custos estão sem cliente')+
    '. Dê um rótulo de cliente à pasta em Meus processos para agrupá-los; enquanto isso, aparecem em "Sem cliente". Os custos não se perdem.</p>':'';
  if(!d.totalDeClientes){
    corpo.innerHTML='<p class="cc-vazio">Nenhum custo lançado ainda. Abra um processo, clique em Custos e lance a primeira despesa.</p>';
    return;
  }
  var h='<p class="cc-conta" id="cc-conta">Mostrando '+lista.length+' de '+d.totalDeClientes+' '+(d.totalDeClientes===1?'cliente':'clientes')+
    ' · '+d.totalDeProcessos+' '+(d.totalDeProcessos===1?'processo':'processos')+' com custos no total.</p>';
  if(!lista.length){
    h+='<p class="cc-vazio">Nenhum cliente neste filtro. Mude o período ou desmarque "Somente com saldo a cobrar".</p>';
    corpo.innerHTML=h;
    return;
  }
  h+='<table class="cc-tab"><caption class="cc-sr">Custos por cliente</caption><thead><tr>'+
    '<th scope="col">Cliente</th><th scope="col" class="cc-num">Processos</th><th scope="col" class="cc-val">Total de despesas</th>'+
    '<th scope="col" class="cc-val">Pago pelo escritório</th><th scope="col" class="cc-val">Recebido</th>'+
    '<th scope="col" class="cc-val">Saldo a cobrar</th><th scope="col" class="cc-val">Crédito do cliente</th><th scope="col">Ações</th></tr></thead><tbody>'+
    lista.map(function(c){
      return '<tr><td data-rotulo="Cliente" class="cc-nome">'+esc(c.nome)+(c.semCliente?' <span class="cc-etq">sem rótulo</span>':'')+'</td>'+
        '<td data-rotulo="Processos" class="cc-num">'+c.processos+'</td>'+
        '<td data-rotulo="Total de despesas" class="cc-val">'+reaisDeCentavos(c.totalDespesasCentavos)+'</td>'+
        '<td data-rotulo="Pago pelo escritório" class="cc-val">'+reaisDeCentavos(c.pagoPeloEscritorioCentavos)+'</td>'+
        '<td data-rotulo="Recebido" class="cc-val">'+reaisDeCentavos(c.totalRecebidoCentavos)+'</td>'+
        '<td data-rotulo="Saldo a cobrar" class="cc-val cc-saldo">'+reaisDeCentavos(c.saldoACobrarCentavos)+'</td>'+
        '<td data-rotulo="Crédito do cliente" class="cc-val">'+reaisDeCentavos(c.creditoDoClienteCentavos)+'</td>'+
        '<td data-rotulo="Ações" class="cc-acoes"><button type="button" class="bt bt2 cc-mini" data-cc="abrir" data-chave="'+esc(c.chave)+'" aria-label="Abrir os processos de '+esc(c.nome)+'">Abrir</button></td></tr>';
    }).join('')+'</tbody></table>'+
    '<p class="cc-nota">Saldo e crédito são calculados por processo: o recebimento de um processo não abate o de outro.</p>';
  corpo.innerHTML=h;
}

/* ---------- um cliente ---------- */
function abrirCliente(chave){
  var rodada=++st.rodada;
  var corpo=document.getElementById('cc-corpo');
  if(corpo)corpo.innerHTML='<p class="cc-vazio">Carregando…</p>';
  pv().api('/v1/custos/clientes/detalhe'+consulta(['cliente='+encodeURIComponent(chave)])).then(function(d){
    if(rodada!==st.rodada||!st.alvo)return;
    st.detalhe=d;
    pintarDetalhe();
    var t=document.getElementById('cc-tit-cliente');
    if(t)t.focus();
  }).catch(function(e){
    if(rodada!==st.rodada)return;
    st.detalhe=null;
    var c=document.getElementById('cc-corpo');
    if(c)c.innerHTML='<p class="cc-vazio cc-erro">'+esc(mensagemDeErro(e))+'</p><button type="button" class="bt bt2" data-cc="voltar">Voltar aos clientes</button>';
  });
}

function pintarDetalhe(){
  var corpo=document.getElementById('cc-corpo'),aviso=document.getElementById('cc-aviso');
  var d=st.detalhe;
  if(!corpo||!d)return;
  aviso.innerHTML='';
  var t=d.totais;
  function c(rot,v,cls){return '<div class="cc-tot '+(cls||'')+'"><dt>'+rot+'</dt><dd>'+reaisDeCentavos(v)+'</dd></div>'}
  var h='<div class="cc-barra"><button type="button" class="bt bt2" data-cc="voltar" id="cc-voltar">&larr; Clientes</button></div>'+
    '<h3 class="cc-cli" id="cc-tit-cliente" tabindex="-1">'+esc(d.nome)+'</h3>'+
    (d.semCliente?'<p class="cc-nota">Estes processos não têm rótulo de cliente — ou deixaram de ser acompanhados, e o rótulo mora na pasta. Os custos continuam aqui.</p>':'')+
    '<dl class="cc-tots">'+c('Total de despesas',t.totalDespesasCentavos)+c('Pago pelo escritório',t.pagoPeloEscritorioCentavos)+
    c('Pago diretamente pelo cliente',t.pagoPeloClienteCentavos)+c('Reembolsável',t.totalReembolsavelCentavos)+
    c('Recebido do cliente',t.totalRecebidoCentavos)+c('Saldo a cobrar',t.saldoACobrarCentavos,'cc-destaque')+
    (t.creditoDoClienteCentavos>0?c('Crédito do cliente',t.creditoDoClienteCentavos,'cc-destaque'):'')+
    (t.depositosCentavos>0?c('Depósitos e garantias (fora das despesas)',t.depositosCentavos):'')+'</dl>';
  h+='<p class="cc-conta">Mostrando '+d.processos.length+' de '+d.totalDeProcessos+' '+(d.totalDeProcessos===1?'processo':'processos')+' deste cliente.</p>';
  if(!d.processos.length){
    h+='<p class="cc-vazio">Nenhum processo deste cliente neste filtro.</p>';
  }else{
    h+='<table class="cc-tab"><caption class="cc-sr">Processos de '+esc(d.nome)+'</caption><thead><tr>'+
      '<th scope="col">Processo</th><th scope="col">Tribunal</th><th scope="col" class="cc-val">Total de despesas</th>'+
      '<th scope="col" class="cc-val">Recebido</th><th scope="col" class="cc-val">Saldo a cobrar</th><th scope="col" class="cc-val">Crédito do cliente</th><th scope="col">Ações</th></tr></thead><tbody>'+
      d.processos.map(function(p){
        return '<tr><td data-rotulo="Processo" class="cc-nome">'+esc(p.formatado)+'</td>'+
          '<td data-rotulo="Tribunal">'+esc(p.tribunal)+'</td>'+
          '<td data-rotulo="Total de despesas" class="cc-val">'+reaisDeCentavos(p.totalDespesasCentavos)+'</td>'+
          '<td data-rotulo="Recebido" class="cc-val">'+reaisDeCentavos(p.totalRecebidoCentavos)+'</td>'+
          '<td data-rotulo="Saldo a cobrar" class="cc-val cc-saldo">'+reaisDeCentavos(p.saldoACobrarCentavos)+'</td>'+
          '<td data-rotulo="Crédito do cliente" class="cc-val">'+reaisDeCentavos(p.creditoDoClienteCentavos)+'</td>'+
          '<td data-rotulo="Ações" class="cc-acoes"><button type="button" class="bt bt2 cc-mini" data-cc="processo" data-numero="'+esc(p.numeroProcesso)+'" aria-label="Abrir o painel de custos do processo '+esc(p.formatado)+'">Painel de custos</button></td></tr>';
      }).join('')+'</tbody></table>';
  }
  h+='<div class="cc-relatorios"><h4 class="cc-rot">Relatórios deste cliente</h4>'+
    '<p class="cc-nota">Usam o período e o filtro de saldo acima. Não levam partes nem texto de ato, e nada fica guardado no servidor.</p>'+
    '<div class="cc-botoes"><button type="button" class="bt bt2" data-cc="pdf" id="cc-pdf">Gerar prestação de contas do cliente (PDF)</button>'+
    '<button type="button" class="bt bt2" data-cc="csv" id="cc-csv">Exportar planilha (CSV)</button>'+
    '<label class="cc-marca"><input type="checkbox" id="cc-csv-canc"'+(st.csvCanc?' checked':'')+'> Incluir cancelados na planilha (marcados)</label></div>'+
    '<div id="cc-rel-msg" class="cc-msg" role="alert"></div></div>';
  corpo.innerHTML=h;
}

function voltar(){
  st.detalhe=null;
  pintarLista();
  var t=document.getElementById('cc-tit');
  if(t)t.focus();
}

/* ---------- downloads ---------- */
function baixar(caminho,botaoId,rotulo,padrao,pronto){
  var msg=document.getElementById('cc-rel-msg'),botao=document.getElementById(botaoId);
  function dizer(t){if(msg)msg.textContent=t||''}
  if(!st.detalhe)return;
  dizer('');
  var chave=pv().chave();
  botao.disabled=true;botao.setAttribute('aria-busy','true');botao.textContent='Gerando…';
  fetch(caminho,{headers:chave?{'x-api-key':chave}:{}}).then(function(r){
    if(!r.ok)return r.json().catch(function(){return{}}).then(function(b){
      var e=new Error(b.mensagem||('HTTP '+r.status));e.status=r.status;e.codigo=b.erro;throw e});
    var cd=r.headers.get('content-disposition')||'';
    var m=/filename="([^"]+)"/.exec(cd);
    return r.blob().then(function(blob){return{blob:blob,nome:m?m[1]:padrao}});
  }).then(function(x){
    var a=document.createElement('a');
    a.href=URL.createObjectURL(x.blob);a.download=x.nome;
    document.body.appendChild(a);a.click();
    setTimeout(function(){URL.revokeObjectURL(a.href);document.body.removeChild(a)},1000);
    anunciar(pronto);
  }).catch(function(e){dizer(mensagemDeErro(e))}).then(function(){
    var b=document.getElementById(botaoId);
    if(b){b.disabled=false;b.removeAttribute('aria-busy');b.textContent=rotulo}
  });
}

/* ---------- eventos ---------- */
function dentro(el){return !!(st.alvo&&el&&st.alvo.contains(el))}
document.addEventListener('click',function(ev){
  var t=ev.target&&ev.target.closest?ev.target.closest('[data-cc]'):null;
  if(!t||!dentro(t))return;
  var a=t.getAttribute('data-cc');
  if(a==='abrir')abrirCliente(t.getAttribute('data-chave'));
  else if(a==='voltar')voltar();
  else if(a==='processo'){
    if(window.__pvCustos)window.__pvCustos.abrirPainelDe(t.getAttribute('data-numero'));
    else pv().abrir(t.getAttribute('data-numero'));
  }
  else if(a==='pdf')baixar('/v1/custos/clientes/prestacao.pdf'+consulta(['cliente='+encodeURIComponent(st.detalhe.chave)]),'cc-pdf','Gerar prestação de contas do cliente (PDF)','prestacao-de-contas-por-cliente.pdf','Prestação de contas gerada.');
  else if(a==='csv')baixar('/v1/custos/lancamentos.csv'+csvConsulta(),'cc-csv','Exportar planilha (CSV)','custos-por-cliente.csv','Planilha gerada.');
});
function csvConsulta(){
  var q=[];
  if(st.filtro.de)q.push('de='+encodeURIComponent(st.filtro.de));
  if(st.filtro.ate)q.push('ate='+encodeURIComponent(st.filtro.ate));
  if(st.detalhe)q.push('cliente='+encodeURIComponent(st.detalhe.chave));
  if(st.csvCanc)q.push('incluirCancelados=true');
  return q.length?'?'+q.join('&'):'';
}
document.addEventListener('change',function(ev){
  var t=ev.target;
  if(!t||!dentro(t))return;
  if(t.id==='cc-csv-canc'){st.csvCanc=t.checked;return}
  var mudou=false;
  if(t.id==='cc-f-de'){st.filtro.de=t.value;mudou=true}
  else if(t.id==='cc-f-ate'){st.filtro.ate=t.value;mudou=true}
  else if(t.id==='cc-f-saldo'){st.filtro.saldo=t.checked;mudou=true}
  else if(t.id==='cc-f-cliente'){
    st.filtro.cliente=t.value;
    if(st.detalhe){st.detalhe=null}
    pintarLista();
    return;
  }
  if(!mudou)return;
  if(st.filtro.de&&st.filtro.ate&&st.filtro.de>st.filtro.ate){
    var m=document.getElementById('cc-msg');
    if(m)m.textContent='A data inicial não pode ser depois da data final.';
    return;
  }
  var m2=document.getElementById('cc-msg');
  if(m2)m2.textContent='';
  if(st.detalhe)abrirCliente(st.detalhe.chave);
  else carregar();
});
document.addEventListener('submit',function(ev){
  if(ev.target&&ev.target.id==='cc-filtros')ev.preventDefault();
});

window.__pvCustosCliente={ver:ver};
})();
`;

export const ESTILOS_CUSTOS_CLIENTE = `
/* Tela "Custos" por cliente (v0.49.0). Tudo sob .cc; o resto do console não muda. */
.cc{min-width:0;max-width:100%;color:var(--tinta);font-size:13.5px;line-height:1.5;overflow-wrap:anywhere}
.cc-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.cc-h{margin:0 0 4px;font-size:20px;font-weight:700}
.cc-h:focus-visible,.cc-cli:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.cc-cli{margin:8px 0 4px;font-size:16px}
.cc-nota{margin:4px 0 10px;font-size:12.5px;color:var(--tinta2)}
.cc-conta{margin:8px 0;font-size:12.5px;color:var(--tinta2)}
.cc-filtros{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin:10px 0;padding:12px;background:var(--papel2);border:1px solid var(--linha);border-radius:var(--r)}
.cc-campo{flex:1 1 170px;min-width:0}
.cc-campo label{display:block;font-size:12px;font-weight:600;color:var(--tinta2);margin-bottom:4px}
.cc-campo select,.cc-campo input{width:100%;min-width:0}
.cc-marca{display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;font-weight:600}
.cc-marca input{width:20px;height:20px;margin:0;accent-color:var(--acento)}
.cc-aviso{margin:8px 0;padding:8px 12px;background:var(--papel2);border:1px solid var(--linha);border-left:4px solid var(--atencao);border-radius:var(--r)}
.cc-msg{color:var(--erro);font-size:13px}
.cc-msg:empty{display:none}
.cc-vazio{margin:8px 0;color:var(--tinta2)}
.cc-erro{color:var(--erro)}
.cc-tab{width:100%;border-collapse:collapse;table-layout:fixed}
.cc-tab th{font-size:11.5px;text-align:left;color:var(--tinta2);padding:6px 8px;border-bottom:1px solid var(--linha);font-weight:700}
.cc-tab td{padding:8px;border-bottom:1px solid var(--linha);vertical-align:top;min-width:0;overflow-wrap:anywhere}
.cc-tab .cc-val{text-align:right;font-variant-numeric:tabular-nums}
.cc-tab .cc-num{text-align:right;width:84px}
.cc-tab .cc-saldo{font-weight:700}
.cc-tab th:last-child{width:128px}
.cc-etq{display:inline-block;margin-left:6px;padding:0 6px;border:1px solid var(--linha);border-radius:10px;font-size:11px;color:var(--tinta2)}
.cc-mini{min-height:32px;padding:0 12px;font-size:13px}
.cc-barra{margin:6px 0}
.cc-tots{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0}
.cc-tot{flex:1 1 150px;min-width:0;background:var(--papel);border:1px solid var(--linha);border-radius:var(--r);padding:8px 12px}
.cc-tot dt{font-size:12px;color:var(--tinta2);font-weight:600}
.cc-tot dd{margin:2px 0 0;font-size:17px;font-weight:700;font-variant-numeric:tabular-nums}
.cc-destaque{border-color:var(--acento);background:var(--acento-bg)}
.cc-relatorios{margin-top:16px;padding-top:6px;border-top:1px solid var(--linha)}
.cc-rot{display:block;margin:10px 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--tinta2)}
.cc-botoes{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}
/* Abaixo de 1100 px a tabela vira cartões: com a lateral de 256 px ela não cabe. */
@media (max-width:1099px){
  .cc-tab,.cc-tab tbody,.cc-tab tr,.cc-tab td{display:block;width:100%}
  .cc-tab thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .cc-tab tr{background:var(--papel);border:1px solid var(--linha);border-radius:var(--r);padding:8px 12px;margin:0 0 10px}
  .cc-tab td{display:flex;flex-wrap:wrap;gap:4px 12px;justify-content:space-between;align-items:center;border-bottom:0;padding:4px 0}
  .cc-tab td::before{content:attr(data-rotulo);font-size:11.5px;font-weight:700;color:var(--tinta2);flex:none}
  .cc-tab .cc-val,.cc-tab .cc-num{text-align:left;width:auto}
  .cc-tab td.cc-acoes{justify-content:flex-start;padding-top:8px}
  .cc-tab td.cc-acoes::before{display:none}
  .cc-mini{min-height:44px}
}
@media (max-width:480px){.cc-tot{flex-basis:calc(50% - 6px)}}
`;
