/**
 * "Assinar" e "Cancelar a renovação automática" (v0.44.0): o cartão de assinatura online em "Minha
 * conta", num arquivo só. `script.ts` quase não muda (duas chamadas na tela da conta, nas linhas que
 * já existiam) e não cresce.
 *
 * Fala com o console por `window.__pv` (`api`, `esc`, `dt`) e por `window.__processovivo_ir` (trocar de
 * aba). Expõe `window.__pvPagamento`:
 * - `cartao()`: devolve o ponto de montagem (`<div id="pv-pagamento">`), que a tela da conta põe no HTML;
 * - `ligar()`: carrega `GET /v1/assinatura` e desenha o cartão dentro dele.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Cobrança recorrente"):
 * - **com a cobrança desligada, nada aparece** (`pagamento.habilitado === false`);
 * - **sem preço, sem botão**: só plano `contratavel` (a MESMA regra da rota de checkout) ganha "Assinar";
 * - **o estado verdadeiro é do servidor**: o retorno do checkout (`/?assinatura=retorno`) só abre esta
 *   tela e liga o "processando" até o servidor confirmar (webhook ou consulta); o retorno nunca decide;
 * - **o sistema nunca vê cartão**: o botão leva à página do gateway (só https), e o preço, o valor e o
 *   e-mail NUNCA saem daqui — o pedido leva só o código do plano;
 * - **toda frase é FIXA aqui**, nunca texto do servidor ou do gateway;
 * - **assinar passa SEMPRE pela tela de confirmação** (v0.45.0): valor, ciclo, a frase da renovação, o link
 *   dos Termos e a caixa de aceite, DESMARCADA, que habilita o "Continuar para o pagamento". O pedido leva
 *   `aceiteTermos: true` (o servidor o exige e registra o aceite); nada é cobrado sem esse clique. A
 *   tela vem de dois lugares com o MESMO caminho: o botão "Assinar" do cartão e o plano escolhido no site
 *   (`window.__pvPagamento.preparar`, chamado por `ui/planoEscolhido.ts`);
 * - cancelar a renovação pede confirmação NA tela (sem `alert`/`confirm`) e diz que o plano segue até o
 *   fim do período já pago.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc; o
 * `console-script.spec.ts` roda o ESLint aqui dentro. Todo dado vem por `esc()`.
 */
export const SCRIPT_PAGAMENTO = String.raw`
(function(){
var RENOVACAO='Renovação automática. Você pode cancelar quando quiser.';
var AVISO_DA_CONTA_DO_GATEWAY='Na página do Mercado Pago, entre com a conta de quem vai pagar. '+
  'O e-mail dela pode ser diferente do e-mail do Processo Vivo.';
var TROCA_DE_PLANO='Esta conta já tem uma renovação automática ativa. Para trocar de plano, cancele a renovação atual primeiro.';
var FRASE_DO_MOTIVO={
  plano_sem_preco:'Este plano ainda não pode ser contratado pelo site. Fale com a gente.',
  plano_nao_vendavel:'Este plano não está à venda.',
  ciclo_nao_suportado:'Este plano ainda não pode ser contratado pelo site. Fale com a gente.',
  conta_sem_email:'A assinatura online exige uma conta com e-mail.',
  ja_assinante:TROCA_DE_PLANO,
  sem_recorrencia:'Não há renovação automática para cancelar.',
  plano_desconhecido:'Plano não encontrado.',
  termos_nao_aceitos:'Para continuar, aceite os Termos de Uso.',
  plano_ja_vigente:'Este plano já está vigente nesta conta.'
};
var AMBIENTE_DE_TESTE='Ambiente de teste, nenhuma cobrança real.';
var FALHA='Não foi possível concluir agora. Tente de novo em instantes.';
var POLL_MS=4000;
var POLL_MAXIMO=30;

var dados=null;
var retorno=false;
var confirmando=false;
var confirmar='';
var termosAceitos=false;
var escolhido='';
var focarPainel=false;
var aviso='';
var timer=null;
var tentativas=0;

function pv(){return window.__pv}
function $(i){return document.getElementById(i)}
function esc(s){return pv().esc(s)}
function reais(c){return (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}

/* O retorno do checkout: abre "Minha conta" e liga o "processando". O parâmetro sai da barra na hora. */
try{
  var busca=new URLSearchParams(location.search);
  if(busca.get('assinatura')==='retorno')retorno=true;
  if(busca.get('assinatura')!==null){
    busca.delete('assinatura');
    var resto=busca.toString();
    history.replaceState(null,'',location.pathname+(resto?'?'+resto:''));
  }
}catch(e){}

var aoIniciarAnterior=window.__pvAoIniciar;
window.__pvAoIniciar=function(){
  if(aoIniciarAnterior)aoIniciarAnterior();
  if(retorno&&window.__processovivo_ir)window.__processovivo_ir('conta');
};

function cartao(){return '<div id="pv-pagamento"></div>'}

function ligar(){
  var alvo=$('pv-pagamento');
  if(!alvo)return;
  carregar().then(function(){desenhar()});
}

function carregar(){
  return pv().api('/v1/assinatura').then(function(r){dados=r;return r}).catch(function(){dados=null;return null});
}

function processando(){
  if(!dados||!dados.pagamento)return false;
  var rec=dados.pagamento.recorrencia;
  if(dados.pagamento.processando)return true;
  return retorno&&(!rec||rec.estado==='pendente');
}

function proximaVolta(){
  if(timer){clearTimeout(timer);timer=null}
  if(!processando()||tentativas>=POLL_MAXIMO)return;
  timer=setTimeout(function(){
    timer=null;tentativas++;
    if(!$('pv-pagamento'))return;
    carregar().then(function(){desenhar()});
  },POLL_MS);
}

function desenhar(){
  var alvo=$('pv-pagamento');
  if(!alvo)return;
  var pg=dados&&dados.pagamento;
  if(!pg||!pg.habilitado){alvo.innerHTML='';return}

  var rec=pg.recorrencia;
  var vence=dados.assinatura&&dados.assinatura.venceEm?pv().dt(dados.assinatura.venceEm):'';
  var planoConf=confirmar?planoDe(confirmar):null;
  if(confirmar&&!planoConf)confirmar='';
  if(confirmar&&!pg.contaComEmail){confirmar='';aviso=FRASE_DO_MOTIVO.conta_sem_email}
  if(confirmar&&rec&&rec.renovacaoAutomatica){confirmar='';aviso=TROCA_DE_PLANO}
  if(confirmar&&jaVigente(confirmar)){
    aviso='O plano '+planoConf.nome+' já está vigente'+(vence?' até '+vence:'')+'.';confirmar='';
  }
  var h='<div class="cartao pgto"><h3 class="sec">Assinatura online</h3>';

  if(pg.ambiente==='teste'||pg.ambiente==='falso'){
    h+='<div class="pgto-teste" role="note"><strong>MODO DE TESTE</strong> — nenhum pagamento é real.</div>';
  }
  if(aviso)h+='<div class="nota pgto-erro" role="alert">'+esc(aviso)+'</div>';

  if(confirmar){
    h+=painelDeConfirmacao(planoConf,pg);
    h+='</div>';
    alvo.innerHTML=h;
    ligarBotoes();
    if(focarPainel){focarPainel=false;var t=$('pgto-conf-t');if(t){t.focus();if(t.scrollIntoView)t.scrollIntoView({block:'nearest'})}}
    return;
  }

  if(processando()){
    h+='<div class="pgto-estado" role="status"><span class="gira" aria-hidden="true"></span>'+
      'Processando o pagamento. Pode levar alguns minutos; esta tela confere sozinha.</div>'+
      '<div><button type="button" class="bt2" id="pgto-atualizar">Conferir agora</button></div>';
  }else if(rec&&rec.renovacaoAutomatica){
    h+='<div class="tt">Renovação automática ativa</div>'+
      '<div class="cp" style="margin-top:4px">'+(rec.proximaCobranca?'Próxima cobrança em '+esc(pv().dt(rec.proximaCobranca))+'. ':'')+
      (rec.meio==='cartao'?'Pagamento por cartão. ':'')+'</div>';
    if(!confirmando){
      h+='<div style="margin-top:10px"><button type="button" class="bt2" id="pgto-cancelar">Cancelar renovação automática</button></div>';
    }else{
      h+='<div class="pgto-confirma" role="group" aria-label="Confirmar o cancelamento da renovação automática">'+
        '<div class="cp">Cancelar a renovação automática? Seu plano continua valendo'+(vence?' até '+esc(vence):' até o fim do período já pago')+
        ', e depois disso a vigilância dos seus processos para.</div>'+
        '<div style="margin-top:8px"><button type="button" class="bt" id="pgto-cancelar-sim">Sim, cancelar a renovação</button> '+
        '<button type="button" class="bt2" id="pgto-cancelar-nao">Voltar</button></div></div>';
    }
  }else if(rec&&rec.renovacaoCanceladaEm){
    h+='<div class="cp">A renovação automática está encerrada. Seu plano vale'+(vence?' até '+esc(vence):' até o fim do período já pago')+
      '. Para continuar depois disso, assine de novo abaixo.</div>';
  }

  var podeAssinar=!processando()&&!(rec&&rec.renovacaoAutomatica);
  var planos=(dados.planos||[]).filter(function(p){return p.contratavel});
  if(podeAssinar&&planos.length>0&&pg.contaComEmail){
    h+='<div class="pgto-planos">'+planos.map(function(p){
      var esc1=escolhido===p.codigo;
      return '<div class="pgto-plano'+(esc1?' pgto-plano-escolhido':'')+'"><div>'+
        (esc1?'<div class="pgto-escolhido">Plano escolhido</div>':'')+
        '<div class="tt">'+esc(p.nome)+'</div>'+
        '<div class="cp">'+esc(p.resumo)+'</div>'+
        '<div class="pgto-preco">'+esc(reais(p.valorDoCicloCentavos))+' por '+(p.ciclo==='mensal'?'mês':esc(p.ciclo))+'</div></div>'+
        '<button type="button" class="bt" data-assinar="'+esc(p.codigo)+'" aria-label="Assinar o plano '+esc(p.nome)+'">Assinar</button></div>';
    }).join('')+'</div>'+
    '<div class="nota">'+esc(RENOVACAO)+(pg.urlDosTermos?' <a href="'+esc(pg.urlDosTermos)+'" target="_blank" rel="noopener noreferrer">Termos de Uso</a>.':'')+'</div>'+
    '<div class="nota">'+esc(AVISO_DA_CONTA_DO_GATEWAY)+'</div>';
  }
  h+='</div>';
  alvo.innerHTML=h;
  ligarBotoes();
  proximaVolta();
}

function planoDe(codigo){
  var l=(dados&&dados.planos)||[];
  for(var i=0;i<l.length;i++){if(l[i].codigo===codigo&&l[i].contratavel)return l[i]}
  return null;
}

/* Plano pago e vigente (liberação manual) do MESMO plano: não há o que contratar. O teste não conta. */
function jaVigente(codigo){
  var a=dados&&dados.assinatura;
  return !!(a&&a.status==='ativa'&&!a.ehTeste&&a.plano===codigo);
}

/* A tela de confirmação: tudo o que a pessoa vai contratar, antes de qualquer cobrança. */
function painelDeConfirmacao(p,pg){
  var termos=pg.urlDosTermos?'<a href="'+esc(pg.urlDosTermos)+'" target="_blank" rel="noopener noreferrer">Termos de Uso</a>':'Termos de Uso';
  return '<div class="pgto-conf" role="group" aria-labelledby="pgto-conf-t">'+
    '<h4 class="tt" id="pgto-conf-t" tabindex="-1">Confirmar assinatura</h4>'+
    ((pg.ambiente==='teste'||pg.ambiente==='falso')?'<div class="nota pgto-aviso-teste" role="note">'+esc(AMBIENTE_DE_TESTE)+'</div>':'')+
    '<div class="cp">Plano <strong>'+esc(p.nome)+'</strong></div>'+
    '<div class="pgto-preco">'+esc(reais(p.valorDoCicloCentavos))+' por '+(p.ciclo==='mensal'?'mês':esc(p.ciclo))+'</div>'+
    '<div class="nota">'+esc(RENOVACAO)+'</div>'+
    '<label class="pgto-aceite"><input type="checkbox" id="pgto-aceite"'+(termosAceitos?' checked':'')+'> '+
    '<span>Li e aceito os '+termos+'.</span></label>'+
    '<div class="pgto-acoes"><button type="button" class="bt" id="pgto-continuar"'+(termosAceitos?'':' disabled')+'>Continuar para o pagamento</button> '+
    '<button type="button" class="bt2" id="pgto-voltar">Voltar</button></div>'+
    '<div class="nota">'+esc(AVISO_DA_CONTA_DO_GATEWAY)+'</div></div>';
}

function abrirConfirmacao(codigo){
  confirmar=codigo;termosAceitos=false;aviso='';confirmando=false;focarPainel=true;
  desenhar();
}

/* Chamada por ui/planoEscolhido.ts, depois de o plano ser conferido contra a vitrine: destaca o plano e,
   com "assinar", abre a confirmação. Se o cartão ainda não está na tela, o estado espera por ele. */
function preparar(codigo,assinar){
  escolhido=codigo;
  if(assinar){confirmar=codigo;termosAceitos=false;aviso='';focarPainel=true}
  if($('pv-pagamento'))carregar().then(function(){desenhar()});
}

function ligarBotoes(){
  var ac=$('pgto-aceite');
  if(ac)ac.addEventListener('change',function(){
    termosAceitos=ac.checked;
    var cont=$('pgto-continuar');
    if(cont)cont.disabled=!termosAceitos;
  });
  var cont=$('pgto-continuar');
  if(cont)cont.addEventListener('click',function(){continuar(cont)});
  var vol=$('pgto-voltar');
  if(vol)vol.addEventListener('click',function(){confirmar='';termosAceitos=false;aviso='';desenhar();var b=document.querySelector('[data-assinar]');if(b)b.focus()});
  var a=$('pgto-atualizar');
  if(a)a.addEventListener('click',function(){a.disabled=true;carregar().then(function(){desenhar()})});
  var c=$('pgto-cancelar');
  if(c)c.addEventListener('click',function(){confirmando=true;aviso='';desenhar();var s=$('pgto-cancelar-sim');if(s)s.focus()});
  var n=$('pgto-cancelar-nao');
  if(n)n.addEventListener('click',function(){confirmando=false;desenhar();var b=$('pgto-cancelar');if(b)b.focus()});
  var s=$('pgto-cancelar-sim');
  if(s)s.addEventListener('click',function(){
    s.disabled=true;
    pv().api('/v1/assinatura/recorrencia',{method:'DELETE'}).then(function(){
      confirmando=false;aviso='';return carregar();
    }).then(function(){desenhar()}).catch(function(e){
      confirmando=false;
      aviso=(e&&e.detalhes&&FRASE_DO_MOTIVO[e.detalhes.motivo])||FALHA;
      carregar().then(function(){desenhar()});
    });
  });
  var botoes=document.querySelectorAll('[data-assinar]');
  for(var i=0;i<botoes.length;i++){
    (function(b){b.addEventListener('click',function(){abrirConfirmacao(b.getAttribute('data-assinar'))})})(botoes[i]);
  }
}

function continuar(botao){
  /* Sem o aceite não há pedido: o botão já nasce desabilitado, e isto fecha o caminho do teclado. */
  if(!termosAceitos||!confirmar)return;
  var codigo=confirmar;
  botao.disabled=true;
  aviso='';
  /* Só o CÓDIGO do plano e o aceite saem daqui: preço, valor e e-mail vêm do servidor. */
  pv().api('/v1/assinatura/checkout',{method:'POST',body:{plano:codigo,aceiteTermos:true}}).then(function(r){
    if(r&&typeof r.urlDeCheckout==='string'&&/^https:\/\//i.test(r.urlDeCheckout)){
      window.location.assign(r.urlDeCheckout);
      return;
    }
    throw new Error('sem endereço');
  }).catch(function(e){
    var motivo=e&&e.detalhes&&e.detalhes.motivo;
    aviso=(motivo&&FRASE_DO_MOTIVO[motivo])||FALHA;
    /* Recusa que não se resolve repetindo: sai da confirmação e relê o estado verdadeiro. */
    if(motivo==='ja_assinante'||motivo==='plano_ja_vigente'||motivo==='plano_nao_vendavel'||motivo==='plano_sem_preco'||motivo==='plano_desconhecido'||motivo==='ciclo_nao_suportado'||motivo==='conta_sem_email'){
      confirmar='';termosAceitos=false;
      carregar().then(function(){desenhar()});
      return;
    }
    desenhar();
  });
}

window.__pvPagamento={cartao:cartao,ligar:ligar,preparar:preparar};
})();
`;

export const ESTILOS_PAGAMENTO = `
.pgto-teste{margin:0 0 12px;padding:8px 12px;border:2px solid var(--erro);border-radius:var(--r);color:var(--erro);background:var(--erro-bg);font-size:13.5px}
.pgto-erro{color:var(--erro);margin:0 0 10px}
.pgto-estado{display:flex;align-items:center;gap:8px;margin:0 0 10px;color:var(--tinta)}
.pgto-planos{display:grid;gap:10px;margin:12px 0 10px}
.pgto-plano{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:12px 14px;border:1px solid var(--linha);border-radius:var(--r);min-width:0}
.pgto-plano > div{min-width:0;overflow-wrap:anywhere}
.pgto-preco{margin-top:4px;font-weight:700;color:var(--tinta)}
.pgto-plano .bt,.pgto .bt2,.pgto .bt{min-height:44px}
.pgto-confirma{margin-top:10px;padding:10px 12px;border:1px solid var(--linha);border-radius:var(--r)}
.pgto .nota a,.pgto-aceite a{color:var(--acento);text-decoration:underline}
.pgto-conf{display:grid;gap:10px;margin:8px 0 4px;padding:14px;border:1px solid var(--linha);border-radius:var(--r);min-width:0;overflow-wrap:anywhere}
.pgto-conf .pgto-preco{font-size:1.15em}
.pgto-aceite{display:flex;align-items:flex-start;gap:10px;min-height:44px;cursor:pointer}
.pgto-aceite input{width:22px;height:22px;margin:0;flex:none}
.pgto-aviso-teste{color:var(--tinta);font-weight:600}
.pgto-plano-escolhido{border:2px solid var(--acento)}
.pgto-escolhido{display:inline-block;margin-bottom:4px;padding:1px 8px;border:1px solid var(--acento);border-radius:999px;font-size:12.5px;font-weight:700;color:var(--tinta)}
.pgto :focus-visible{outline:2px solid var(--acento);outline-offset:2px}
`;
