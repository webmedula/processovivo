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
var FRASE_DO_MOTIVO={
  plano_sem_preco:'Este plano ainda não pode ser contratado pelo site. Fale com a gente.',
  plano_nao_vendavel:'Este plano não está à venda.',
  ciclo_nao_suportado:'Este plano ainda não pode ser contratado pelo site. Fale com a gente.',
  conta_sem_email:'A assinatura online exige uma conta com e-mail.',
  ja_assinante:'Esta conta já tem uma renovação automática ativa.',
  sem_recorrencia:'Não há renovação automática para cancelar.',
  plano_desconhecido:'Plano não encontrado.'
};
var FALHA='Não foi possível concluir agora. Tente de novo em instantes.';
var POLL_MS=4000;
var POLL_MAXIMO=30;

var dados=null;
var retorno=false;
var confirmando=false;
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
  var h='<div class="cartao pgto"><h3 class="sec">Assinatura online</h3>';

  if(pg.ambiente==='teste'||pg.ambiente==='falso'){
    h+='<div class="pgto-teste" role="note"><strong>MODO DE TESTE</strong> — nenhum pagamento é real.</div>';
  }
  if(aviso)h+='<div class="nota pgto-erro" role="alert">'+esc(aviso)+'</div>';

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
      return '<div class="pgto-plano"><div><div class="tt">'+esc(p.nome)+'</div>'+
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

function ligarBotoes(){
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
    (function(b){b.addEventListener('click',function(){assinar(b)})})(botoes[i]);
  }
}

function assinar(b){
  var todos=document.querySelectorAll('[data-assinar]');
  for(var i=0;i<todos.length;i++)todos[i].disabled=true;
  aviso='';
  /* Só o CÓDIGO do plano sai daqui: preço, valor e e-mail vêm do servidor. */
  pv().api('/v1/assinatura/checkout',{method:'POST',body:{plano:b.getAttribute('data-assinar')}}).then(function(r){
    if(r&&typeof r.urlDeCheckout==='string'&&/^https:\/\//i.test(r.urlDeCheckout)){
      window.location.assign(r.urlDeCheckout);
      return;
    }
    throw new Error('sem endereço');
  }).catch(function(e){
    aviso=(e&&e.detalhes&&FRASE_DO_MOTIVO[e.detalhes.motivo])||FALHA;
    desenhar();
  });
}

window.__pvPagamento={cartao:cartao,ligar:ligar};
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
.pgto .nota a{color:var(--acento);text-decoration:underline}
.pgto :focus-visible{outline:2px solid var(--acento);outline-offset:2px}
`;
