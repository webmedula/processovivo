/**
 * "Salvar no Google Drive" (v0.42.0): o cartão de conexão em "Meus acessos" e o botão da Pasta
 * digital, num arquivo só. `script.ts` quase não muda (uma chamada ao fim da tela de acessos), e
 * `scriptPasta.ts` ganha só os ganchos de que precisa (o botão, a caixa e o aviso de seleção).
 *
 * Fala com o console por `window.__pv` (`api`, `esc`) e por `window.__processovivo_ir` (trocar de
 * aba — o que também fecha a Pasta). Expõe `window.__pvDrive`:
 * - `cartao(alvo)`: pinta o cartão no fim da tela "Meus acessos";
 * - `ligarPasta({ numero, marcadas })`: liga o botão e a caixa que a Pasta desenhou;
 * - `selecaoMudou()`: a Pasta avisa quando as marcadas mudam (o rótulo do botão diz o número).
 *
 * O que sustenta a tela (CLAUDE.md §8, "Google Drive"):
 * - **com o recurso desligado, nada aparece**: `GET /v1/drive` responde `habilitado: false`;
 * - **sem plano, só o aviso fixo** ("Salvar no Drive faz parte dos planos Peças e IA…"), sem
 *   prometer link de compra que não existe — e o servidor não fez nenhuma chamada ao Google;
 * - **só por clique**: nada é enviado sem o botão. Sem peça marcada o rótulo diz "todas";
 * - **toda frase é FIXA aqui**, nunca texto do servidor ou do Google;
 * - o progresso mostra enviadas / já estavam / sigilosas fora / falhas, com Cancelar, e a região
 *   `aria-live` só anuncia o começo e o fim (acompanhar contagem por leitor de tela seria ruído);
 * - o retorno do Google chega em `/?drive=ok` ou `/?drive=erro&motivo=…`: a mensagem é curta e o
 *   parâmetro sai da barra de endereço na hora. Token nunca passa por aqui.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc; o
 * `console-script.spec.ts` roda o ESLint aqui dentro. Todo dado vem por `esc()`.
 */
export const SCRIPT_DRIVE = String.raw`
(function(){
var SEM_PLANO='Salvar no Drive faz parte dos planos Peças e IA. Faça upgrade do plano para usar.';
var SO_A_PASTA='O sistema só acessa a pasta que ele mesmo cria no seu Drive, chamada “Processo Vivo”. '+
  'Não lê, não apaga nem compartilha nada do que já está lá.';
var POLL_MS=1500;
var ERROS_SEGUIDOS_QUE_PARAM=3;

var visao=null;
var ctx=null;
var envio=null;          /* {id, numero} em acompanhamento */
var timer=null;
var pedido=null;         /* o último pedido, para "tentar de novo" */
var retorno=null;        /* mensagem do retorno do Google, mostrada uma vez */

function pv(){return window.__pv}
function $(i){return document.getElementById(i)}
function esc(s){return pv().esc(s)}
function pl(n,um,varios){return n+' '+(n===1?um:varios)}

var MOTIVOS_DE_RECUSA={
  sem_plano:SEM_PLANO,
  nao_conectado:'Conecte o Google Drive para salvar peças.',
  precisa_reconectar:'A autorização do Google Drive expirou. Reconecte para continuar.',
  job_em_andamento:'Já há um envio ao Google Drive em andamento. Espere terminar ou cancele.',
  limite_global:'Há muitos envios em andamento no servidor. Tente de novo em instantes.',
  nada_para_enviar:'Não há peças para enviar: as que estão sob sigilo não vão para o Drive.',
  job_nao_encontrado:'Este envio não está mais disponível. Confira a pasta no Drive.'
};
var MOTIVOS_DE_PARADA={
  precisa_reconectar:'A autorização do Google Drive expirou. Reconecte para continuar.',
  drive_cheio:'O seu Google Drive está sem espaço. Libere espaço e tente de novo.',
  limite_de_uso:'O Google limitou o uso por agora. Tente de novo em alguns minutos.',
  drive_indisponivel:'O Google Drive não respondeu. Tente de novo.',
  credencial_do_tribunal:'O acesso ao tribunal não está valendo. Confira em “Meus acessos”, depois tente de novo.',
  bloqueio_do_tribunal:'O tribunal pausou as consultas deste servidor por um tempo. Tente de novo mais tarde.'
};
var MOTIVOS_DO_RETORNO={
  negado:'A conexão com o Google Drive foi cancelada. Nada foi conectado.',
  escopo_negado:'A permissão para criar a pasta não foi concedida. Conecte de novo e deixe essa opção marcada.',
  estado_invalido:'O pedido de conexão venceu ou já foi usado. Clique em Conectar de novo.',
  autorizacao_recusada:'O Google não aceitou a conexão. Tente de novo.',
  sem_plano:SEM_PLANO,
  indisponivel:'Não foi possível falar com o Google agora. Tente de novo em instantes.'
};

function textoDoErro(e){
  var m=e&&e.detalhes&&e.detalhes.motivo;
  if(m&&MOTIVOS_DE_RECUSA[m])return MOTIVOS_DE_RECUSA[m];
  if(e&&e.codigo==='SEGREDO_DE_JUSTICA_NAO_GUARDADO')return 'Processo em segredo de justiça: nenhuma peça vai para o Drive.';
  if(e&&e.codigo==='LISTAGEM_DA_PASTA_AUSENTE')return 'Carregue as peças do processo antes de salvar no Drive.';
  if(e&&e.status===501)return 'O envio ao Google Drive não está habilitado neste servidor.';
  return 'Não foi possível falar com o servidor. Tente de novo.';
}

function carregar(){
  return pv().api('/v1/drive').then(function(v){visao=v;return v}).catch(function(){visao=null;return null});
}

/* ---------- o retorno do Google ---------- */
try{
  var busca=new URLSearchParams(location.search);
  var r=busca.get('drive');
  if(r==='ok')retorno={ok:true};
  else if(r==='erro')retorno={ok:false,motivo:busca.get('motivo')||''};
  if(r!==null){
    busca.delete('drive');busca.delete('motivo');
    var resto=busca.toString();
    history.replaceState(null,'',location.pathname+(resto?'?'+resto:''));
  }
}catch(e){}

var aoIniciarAnterior=window.__pvAoIniciar;
window.__pvAoIniciar=function(){
  if(aoIniciarAnterior)aoIniciarAnterior();
  if(retorno&&window.__processovivo_ir)window.__processovivo_ir('credenciais');
};

/* ---------- o cartão ---------- */
function cartao(alvo){
  carregar().then(function(v){
    if(!v||!v.habilitado||!alvo||!document.body.contains(alvo))return;
    var el=document.createElement('div');
    el.className='cartao drive-cartao';
    el.id='drive-cartao';
    alvo.appendChild(el);
    desenharCartao(el,v);
  });
}

function mensagemDoRetorno(){
  if(!retorno)return '';
  var m=retorno;retorno=null;
  return m.ok
    ?'<div class="drive-msg ok" role="status">Google Drive conectado. A pasta “Processo Vivo” foi criada no seu Drive.</div>'
    :'<div class="drive-msg falha" role="status">'+esc(MOTIVOS_DO_RETORNO[m.motivo]||MOTIVOS_DO_RETORNO.autorizacao_recusada)+'</div>';
}

function desenharCartao(el,v){
  var h='<h3 class="sec">Google Drive</h3>'+mensagemDoRetorno();
  if(!v.plano){
    h+='<div class="nota" id="drive-sem-plano">'+esc(SEM_PLANO)+'</div>';
    el.innerHTML=h;
    return;
  }
  if(v.estado==='conectado'){
    h+='<div class="drive-linha"><span class="selo nv">conectado</span>'+
      (v.linkDaPastaRaiz?' <a id="drive-abrir" href="'+esc(v.linkDaPastaRaiz)+'" target="_blank" rel="noopener noreferrer">Abrir pasta no Drive</a>':'')+
      '</div>'+
      '<div class="nota">Use o botão “Salvar no Drive” na Pasta digital de cada processo. '+esc(SO_A_PASTA)+'</div>'+
      '<div class="drive-acoes" id="drive-acoes"><button class="bt bt2" id="drive-desconectar">Desconectar</button></div>';
  }else if(v.estado==='precisa_reconectar'){
    h+='<div class="drive-msg falha" id="drive-reconectar-msg">'+
      esc(v.motivoDoUltimoErro==='escopo_negado'
        ?'A permissão para a pasta não vale mais. Reconecte e deixe marcada a opção de criar e acessar a pasta.'
        :'A autorização do Google Drive expirou ou foi retirada. Reconecte para voltar a salvar peças.')+'</div>'+
      '<div class="drive-acoes" id="drive-acoes"><button class="bt" id="drive-conectar">Reconectar</button>'+
      '<button class="bt bt2" id="drive-desconectar">Desconectar</button></div>';
  }else{
    h+='<div class="nota">Salve na pasta do seu Google Drive as peças dos processos. '+esc(SO_A_PASTA)+'</div>'+
      '<div class="drive-acoes" id="drive-acoes"><button class="bt" id="drive-conectar">Conectar ao Google Drive</button></div>';
  }
  h+='<div id="drive-aviso" role="status"></div>';
  el.innerHTML=h;

  var c=$('drive-conectar');
  if(c)c.addEventListener('click',function(){conectar(c)});
  var d=$('drive-desconectar');
  if(d)d.addEventListener('click',function(){pedirDesconexao(el,v)});
}

function conectar(botao){
  botao.disabled=true;
  pv().api('/v1/drive/conexao',{method:'POST'}).then(function(r){
    /* Só se navega para o endereço de autorização do Google — nunca para outro. */
    if(r&&typeof r.url==='string'&&r.url.indexOf('https://accounts.google.com/')===0){location.assign(r.url);return}
    botao.disabled=false;
    avisoDoCartao('Não foi possível iniciar a conexão. Tente de novo.');
  }).catch(function(e){
    botao.disabled=false;
    avisoDoCartao(textoDoErro(e));
  });
}

function avisoDoCartao(t){
  var a=$('drive-aviso');
  if(a)a.innerHTML='<div class="drive-msg falha">'+esc(t)+'</div>';
}

function pedirDesconexao(el,v){
  var acoes=$('drive-acoes');
  if(!acoes)return;
  acoes.innerHTML='<span class="drive-conf" id="drive-conf">Desconectar? As peças já salvas continuam no seu Drive.</span> '+
    '<button class="bt" id="drive-desconectar-sim">Sim, desconectar</button> '+
    '<button class="bt bt2" id="drive-desconectar-nao">Cancelar</button>';
  $('drive-desconectar-nao').addEventListener('click',function(){desenharCartao(el,v);var b=$('drive-desconectar');if(b)b.focus()});
  $('drive-desconectar-sim').addEventListener('click',function(){
    $('drive-desconectar-sim').disabled=true;
    pv().api('/v1/drive',{method:'DELETE'}).then(function(){
      return carregar().then(function(v2){desenharCartao(el,v2||{plano:true,estado:'desconectado'});var b=$('drive-conectar');if(b)b.focus()});
    }).catch(function(e){avisoDoCartao(textoDoErro(e))});
  });
  $('drive-desconectar-sim').focus();
}

/* ---------- a Pasta digital ---------- */
function caixa(){return $('pasta-drive-caixa')}
function botao(){return $('pasta-drive-bt')}

function ligarPasta(c){
  ctx=c;
  var b=botao();
  if(!b)return;
  b.addEventListener('click',clicou);
  carregar().then(function(v){
    var b2=botao();
    if(!b2||!v||!v.habilitado)return;
    b2.hidden=false;
    selecaoMudou();
    /* A Pasta foi fechada e reaberta no meio de um envio deste processo: reata o progresso. */
    if(v.envioAtivo&&ctx&&String(v.envioAtivo.numeroProcesso)===String(ctx.numero()).replace(/\D/g,'')){
      acompanhar({id:v.envioAtivo.id,numero:v.envioAtivo.numeroProcesso});
    }
  });
}

function selecaoMudou(){
  var b=botao();
  if(!b||!ctx)return;
  var n=ctx.marcadas().length;
  b.textContent=n?'Salvar no Drive ('+n+')':'Salvar todas no Drive';
  b.disabled=!!envio;
}

function clicou(){
  if(!ctx||envio)return;
  if(!visao||!visao.plano){mostrar('<div class="pdrive falha" id="pdrive-sem-plano"><strong>'+esc(SEM_PLANO)+'</strong></div>');return}
  if(visao.estado!=='conectado'){
    /* Desconectado (ou a autorização caiu): o botão leva ao cartão de conexão. */
    if(window.__processovivo_ir)window.__processovivo_ir('credenciais');
    return;
  }
  var ids=ctx.marcadas();
  enviar(ids.length?{pecas:ids}:{todas:true});
}

function enviar(corpo){
  pedido={corpo:corpo,numero:ctx.numero()};
  mostrar('<div class="pdrive"><span class="gira"></span>Pedindo o envio…</div>');
  pv().api('/v1/processos/'+encodeURIComponent(pedido.numero)+'/pasta/drive',{method:'POST',body:corpo})
    .then(function(e){acompanhar({id:e.id,numero:e.numeroProcesso},e)})
    .catch(function(e){
      mostrar('<div class="pdrive falha"><strong>'+esc(textoDoErro(e))+'</strong></div>');
    });
}

function mostrar(html){
  var c=caixa();
  if(c)c.innerHTML=html;
}

function acompanhar(ref,primeiro){
  envio=ref;
  selecaoMudou();
  var erros=0;
  anunciar('Enviando as peças para o Google Drive.');
  desenharProgresso(primeiro||null);
  function passo(){
    if(timer){clearTimeout(timer);timer=null}
    /* Pasta fechada: para de consultar (o envio segue no servidor; reabrir reata). */
    if(!caixa()){envio=null;return}
    pv().api('/v1/drive/jobs/'+encodeURIComponent(ref.id)).then(function(e){
      erros=0;
      if(e.estado==='em_andamento'){desenharProgresso(e);timer=setTimeout(passo,POLL_MS);return}
      terminou(e);
    }).catch(function(){
      erros+=1;
      if(erros>=ERROS_SEGUIDOS_QUE_PARAM){
        envio=null;selecaoMudou();
        mostrar('<div class="pdrive falha"><strong>Perdemos o contato com o envio.</strong> '+
          'Ele pode ter continuado: confira a pasta no Drive.</div>');
        return;
      }
      timer=setTimeout(passo,POLL_MS);
    });
  }
  timer=setTimeout(passo,primeiro?POLL_MS:0);
}

function desenharProgresso(e){
  var feitas=e?e.processadas:0, total=e?e.total:0;
  mostrar('<div class="pdrive" id="pdrive" role="group" aria-label="Envio ao Google Drive">'+
    '<div class="pdrive-linha"><span class="gira"></span><strong id="pdrive-txt">'+
    (total?'Enviando '+Math.min(feitas+1,total)+' de '+total+'…':'Enviando…')+'</strong></div>'+
    '<div class="pdrive-acoes"><button class="bt bt2" id="pdrive-cancelar">Cancelar</button></div></div>');
  var c=$('pdrive-cancelar');
  if(c)c.addEventListener('click',cancelar);
}

function cancelar(){
  if(!envio)return;
  var c=$('pdrive-cancelar');
  if(c){c.disabled=true;c.textContent='Cancelando…'}
  pv().api('/v1/drive/jobs/'+encodeURIComponent(envio.id),{method:'DELETE'}).catch(function(){});
}

function anunciar(t){
  var v=$('drive-vivo');
  if(!v){
    v=document.createElement('div');
    v.id='drive-vivo';v.className='drive-sr';
    v.setAttribute('role','status');v.setAttribute('aria-live','polite');
    document.body.appendChild(v);
  }
  v.textContent=t;
}

function resumo(e){
  var p=e.progresso, partes=[];
  if(p.enviadas)partes.push(pl(p.enviadas,'enviada','enviadas'));
  if(p.atualizadas)partes.push(pl(p.atualizadas,'atualizada','atualizadas'));
  if(p.jaEstavam)partes.push(pl(p.jaEstavam,'já estava','já estavam'));
  if(e.sigilosasForaDoEnvio)partes.push(pl(e.sigilosasForaDoEnvio,'sigilosa ficou','sigilosas ficaram')+' de fora');
  if(p.removidasNoDrive)partes.push(pl(p.removidasNoDrive,'removida','removidas')+' no Drive');
  if(p.falhas)partes.push(p.falhas===1?'1 falhou':p.falhas+' falharam');
  return partes.length?partes.join(' · '):'Nada novo para enviar.';
}

function terminou(e){
  var tinhaFoco=!!caixa()&&caixa().contains(document.activeElement);
  envio=null;
  selecaoMudou();
  var cls=e.estado==='concluido'&&!e.progresso.falhas?'ok':(e.estado==='concluido'?'':'falha');
  var h='<div class="pdrive '+cls+'" id="pdrive-fim" tabindex="-1">';
  var titulo=e.estado==='concluido'?'Envio concluído.':e.estado==='cancelado'?'Envio cancelado.':'O envio parou.';
  h+='<div><strong>'+titulo+'</strong> <span id="pdrive-resumo">'+esc(resumo(e))+'</span></div>';
  if(e.estado==='cancelado')h+='<div class="nota">O que já foi enviado continua no Drive.</div>';
  if(e.estado==='interrompido'&&e.motivoDaParada){
    var t=MOTIVOS_DE_PARADA[e.motivoDaParada]||MOTIVOS_DE_PARADA.drive_indisponivel;
    h+='<div class="drive-erro">'+esc(t)+'</div>';
    if(e.motivoDaParada==='bloqueio_do_tribunal'&&e.retomarEm){
      h+='<div class="nota">O tribunal volta a atender depois de '+esc(horaDe(e.retomarEm))+'.</div>';
    }
  }
  if(e.sigilosasForaDoEnvio)h+='<div class="nota">Peças sob sigilo não vão para o Drive.</div>';
  var naoVieram=(e.falhasDasPecas||[]).filter(function(f){return f.motivo==='tribunal_nao_entregou'||f.motivo==='tempo_esgotado'}).length;
  var recusadas=(e.falhasDasPecas||[]).filter(function(f){return f.motivo==='recusada_pelo_drive'||f.motivo==='drive_indisponivel'}).length;
  if(naoVieram)h+='<div class="drive-erro">'+pl(naoVieram,'peça não veio','peças não vieram')+' do tribunal. Tente de novo.</div>';
  if(recusadas)h+='<div class="drive-erro">'+pl(recusadas,'peça não foi aceita','peças não foram aceitas')+' pelo Drive. Tente de novo.</div>';
  if((e.avisos||[]).indexOf('pasta_raiz_recriada')>=0)h+='<div class="nota">A pasta “Processo Vivo” tinha sido apagada do seu Drive; criamos uma nova.</div>';
  if((e.avisos||[]).indexOf('pasta_do_processo_recriada')>=0)h+='<div class="nota">A pasta deste processo tinha sido apagada do seu Drive; criamos uma nova.</div>';
  var removidas=e.removidasNoDrive||[];
  if(removidas.length){
    h+='<div class="nota">'+pl(removidas.length,'peça foi apagada','peças foram apagadas')+' do seu Drive e não foi reenviada sozinha.</div>';
  }
  h+='<div class="pdrive-acoes">';
  if(e.linkDaPasta)h+='<a class="bt bt2" id="pdrive-abrir" href="'+esc(e.linkDaPasta)+'" target="_blank" rel="noopener noreferrer">Abrir no Drive</a>';
  if(e.motivoDaParada==='precisa_reconectar')h+='<button class="bt" id="pdrive-reconectar">Reconectar</button>';
  else if(e.estado==='interrompido'||naoVieram||recusadas)h+='<button class="bt" id="pdrive-repetir">Tentar de novo</button>';
  if(removidas.length)h+='<button class="bt bt2" id="pdrive-reenviar">Reenviar as removidas</button>';
  h+='<button class="bt bt2" id="pdrive-fechar">Fechar</button></div></div>';
  mostrar(h);
  anunciar(titulo+' '+resumo(e));

  var rec=$('pdrive-reconectar');
  if(rec)rec.addEventListener('click',function(){if(window.__processovivo_ir)window.__processovivo_ir('credenciais')});
  var rep=$('pdrive-repetir');
  if(rep)rep.addEventListener('click',function(){if(pedido)enviar(pedido.corpo)});
  var ree=$('pdrive-reenviar');
  if(ree)ree.addEventListener('click',function(){
    pedido={corpo:{pecas:removidas,reenviarRemovidas:true},numero:ctx?ctx.numero():''};
    mostrar('<div class="pdrive"><span class="gira"></span>Pedindo o reenvio…</div>');
    pv().api('/v1/processos/'+encodeURIComponent(pedido.numero)+'/pasta/drive',{method:'POST',body:pedido.corpo})
      .then(function(r){acompanhar({id:r.id,numero:r.numeroProcesso},r)})
      .catch(function(er){mostrar('<div class="pdrive falha"><strong>'+esc(textoDoErro(er))+'</strong></div>')});
  });
  var fe=$('pdrive-fechar');
  if(fe)fe.addEventListener('click',function(){mostrar('');var b=botao();if(b)b.focus()});
  var fim=$('pdrive-fim');
  if(tinhaFoco&&fim)fim.focus();
}

function horaDe(iso){
  try{return new Date(iso).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'})}
  catch(e){return 'o horário informado'}
}

window.__pvDrive={cartao:cartao,ligarPasta:ligarPasta,selecaoMudou:selecaoMudou};
})();
`;

/**
 * CSS do Drive. Toda regra mora sob `.drive-cartao` (o cartão em "Meus acessos"), `.pdrive` (a
 * caixa na Pasta) ou `#pasta-drive-caixa`/`#pasta-drive-bt`: fora disso o console é o de antes.
 * Texto de apoio em `--tinta2` (o `--tinta3` global mede 4,2:1 no claro); erro em `--erro`.
 */
export const ESTILOS_DRIVE = `
.drive-cartao .drive-linha{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-width:0}
.drive-cartao .nota,.drive-cartao .drive-msg{color:var(--tinta2);overflow-wrap:anywhere}
.drive-cartao .drive-acoes{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;min-width:0}
.drive-cartao .drive-conf{font-size:13px;color:var(--tinta2);overflow-wrap:anywhere}
.drive-cartao .drive-msg{margin:8px 0;padding:8px 10px;border:1px solid var(--linha);border-radius:10px;background:var(--papel2);font-size:13.5px}
.drive-cartao .drive-msg.ok{border-color:var(--verde-tinta)}
.drive-cartao .drive-msg.falha{border-color:var(--erro);background:var(--erro-bg);color:var(--tinta)}
#pasta #pasta-drive-bt[hidden]{display:none}
#pasta #pasta-drive-caixa{flex-shrink:0;max-height:34vh;overflow:auto}
#pasta #pasta-drive-caixa:empty{display:none}
#pasta .pdrive{margin:8px 12px;padding:10px 12px;border:1px solid var(--linha);border-radius:10px;
  background:var(--papel2);font-size:13px;color:var(--tinta2);min-width:0;overflow-wrap:anywhere}
#pasta .pdrive.falha{border-color:var(--erro);background:var(--erro-bg);color:var(--tinta)}
#pasta .pdrive.ok{border-color:var(--verde-tinta)}
#pasta .pdrive strong{color:var(--tinta)}
#pasta .pdrive:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
#pasta .pdrive .nota{margin-top:6px;color:var(--tinta2);font-size:inherit}
#pasta .pdrive .drive-erro{margin-top:6px;color:var(--tinta)}
#pasta .pdrive-linha{display:flex;align-items:center;gap:8px;min-width:0}
#pasta .pdrive-acoes{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
#pasta .pdrive-acoes .bt,#pasta .pdrive-acoes .bt2{min-height:26px;padding:0 8px;font-size:12px}
#pasta .pdrive-acoes a.bt,#pasta .pdrive-acoes a.bt2{display:inline-flex;align-items:center;text-decoration:none}
.drive-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;
