/**
 * A tela "IA" da área administrativa (v0.58.0, Fase A do painel de IA). Módulo próprio: o
 * `scriptAdmin.ts` só ganha o gancho da aba e do aviso do alerta de custo.
 *
 * Fala com o /admin só por `window.__pvIaAdmin` ({ render, banner }). Tudo o que ela mostra vem de
 * `GET /admin/api/ia`, que entrega SÓ números, rótulos de lista fechada e ids CURTOS de conta — nenhum
 * texto de ato ou de peça, nome, número de processo, e-mail ou chave existe nesse contrato, então não
 * há como a tela mostrá-los. Toda frase é fixa aqui (nunca texto do servidor), e tudo que vem do
 * servidor passa por `esc`.
 *
 * `tests/http/admin-script.spec.ts` roda o ESLint dentro desta string, como no resto do console.
 */
export const SCRIPT_IA_ADMIN = String.raw`
(function(){
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}

var PERIODOS=[['hoje','Hoje'],['7d','7 dias'],['30d','30 dias']];
var S={periodo:'hoje',dados:null,raiz:null,confirmando:null,foco:null,msg:''};

var ROTULO_DO_MOTIVO_DA_AVALIACAO={erro_de_fato:'erro de fato',citacao_inventada:'citação inventada',
  concluiu_prazo:'concluiu prazo',deixou_de_fora:'deixou de fora algo importante',
  pode_causar_prejuizo:'pode causar prejuízo',outro:'outro'};
var ROTULO_DA_FALHA={citacao_invalida:'citação inválida',numero_invalido:'número ou data que o texto não tem',
  expressao_proibida:'expressão proibida',acao_copiada_do_trecho:'texto que só copia o trecho',
  sem_item_verificado:'nenhum item verificado',ato_recente_fora:'ato mais recente fora da situação',
  pendencia_negada:'"sem pendências" havendo providência',atualidade:'ato antigo apresentado como atual',
  forma:'forma fora do contrato',pagina_invalida:'página inexistente',chamada_falhou:'a chamada ao modelo falhou',
  formato_fora_do_esquema:'formato fora do esquema',tempo_esgotado:'tempo esgotado'};
var ROTULO_DO_TIPO={ligada:'Liga/desliga',teto_dia_conta:'Teto por conta e dia',teto_dia_global:'Teto global do dia',
  alerta_custo:'Alerta de custo'};
var ROTULO_DA_FUNCAO={ato:'Análise de ato',resumo:'Resumo do processo',peca:'Análise de peça',global:'Geral'};

var FRASE={
  carregando:'Carregando o painel de IA…',
  falha:'Não foi possível carregar o painel de IA agora. Tente de novo.',
  ligada:'Ligada',desligada:'Desligada no painel',bloqueada:'Desligada pelo ambiente do servidor',
  bloqueadaAjuda:'O ambiente do servidor desligou esta função. O painel não a liga: mude a variável de ambiente.',
  salvo:'Alteração salva.',
  naoSalvo:'Não foi possível salvar. Tente de novo.',
  tetoInvalido:'Informe um número inteiro de 1 a 100.000.',
  alertaInvalido:'Informe um valor em dólares entre 0,01 e 10.000.',
  semDados:'Sem dados no período.'
};

/* ---------- formatação ---------- */
function n(v){return Number(v||0).toLocaleString('pt-BR')}
function usd(v,casas){
  if(v==null)return '—';
  return 'US$ '+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:casas==null?2:casas,maximumFractionDigits:casas==null?2:casas});
}
function pct(v){return v==null?'—':(v*100).toLocaleString('pt-BR',{maximumFractionDigits:0})+'%'}
function seg(ms){return ms==null?'—':(ms/1000).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+' s'}
function dth(iso){
  var d=new Date(iso);
  return isNaN(d)?'—':d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',
    year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function valorDaAlteracao(a,v){
  if(a.tipo==='alerta_custo')return usd(Number(v));
  return v;
}

/* ---------- rede ---------- */
function api(caminho,opcoes){
  opcoes=opcoes||{};
  var h={};
  if(opcoes.body)h['content-type']='application/json';
  return fetch(caminho,{method:opcoes.method||'GET',headers:h,cache:'no-store',
    body:opcoes.body?JSON.stringify(opcoes.body):undefined})
    .then(function(r){return r.json().catch(function(){return {}}).then(function(b){
      if(!r.ok){var e=new Error('HTTP '+r.status);e.status=r.status;throw e}
      return b})});
}

/* Região ao vivo única e discreta: anuncia só o resultado de uma ação da pessoa. */
function anunciar(t){
  var el=$('ia-live');
  if(!el)return;
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

/* ---------- aviso do alerta de custo (de qualquer aba do /admin) ---------- */
function banner(el){
  if(!el)return Promise.resolve();
  return api('/admin/api/ia/alerta').then(function(c){
    if(c&&c.acima){
      el.hidden=false;
      el.innerHTML='<strong>Custo da IA acima do limite de hoje.</strong> Gasto do dia: '+esc(usd(c.usd))+
        ' · limite do alerta: '+esc(usd(c.alertaUsd))+'. <a href="#ia" id="ia-ver-painel">Ver o painel de IA</a>';
      var a=$('ia-ver-painel');
      if(a&&!a.getAttribute('data-ligado')){
        a.setAttribute('data-ligado','1');
        a.addEventListener('click',function(ev){ev.preventDefault();if(window.__pvIrParaIa)window.__pvIrParaIa()});
      }
    }else{el.hidden=true;el.innerHTML=''}
  },function(){el.hidden=true;el.innerHTML=''});
}

/* ---------- desenho ---------- */
function linha(rotulo,valor){
  return '<div class="ia-par"><dt>'+esc(rotulo)+'</dt><dd>'+valor+'</dd></div>';
}

function estadoDaFuncao(f){
  if(!f.ambientePermite)return {texto:FRASE.bloqueada,classe:'ia-sel-bloq'};
  if(!f.painelLigado)return {texto:FRASE.desligada,classe:'ia-sel-off'};
  return {texto:FRASE.ligada,classe:'ia-sel-on'};
}

function listaDeFalhas(f){
  if(!f.falhasDeVerificacao.length)return '<span class="ia-suave">Nenhuma no período.</span>';
  var h='<ul class="ia-lista">';
  for(var i=0;i<f.falhasDeVerificacao.length;i++){
    var x=f.falhasDeVerificacao[i];
    h+='<li>'+esc(ROTULO_DA_FALHA[x.motivo]||x.motivo)+': <strong>'+n(x.contagem)+'</strong></li>';
  }
  return h+'</ul>';
}

function motivosDaAvaliacao(f){
  var m=f.motivosDaAvaliacao||{},partes=[];
  for(var k in ROTULO_DO_MOTIVO_DA_AVALIACAO){
    if(m[k])partes.push(esc(ROTULO_DO_MOTIVO_DA_AVALIACAO[k])+' '+n(m[k]));
  }
  if(f.semMotivo)partes.push('sem motivo '+n(f.semMotivo));
  return partes.length?partes.join(' · '):'<span class="ia-suave">Nenhum.</span>';
}

function cartaoDaFuncao(f){
  var id='ia-f-'+f.funcao,est=estadoDaFuncao(f);
  var avaliadas=f.util+f.errado+f.perigoso;
  var h='<article class="cartao ia-cartao" aria-labelledby="'+id+'-t" data-funcao="'+esc(f.funcao)+'">';
  h+='<h3 id="'+id+'-t" class="ia-h3">'+esc(f.rotulo)+'</h3>';
  h+='<p class="ia-selo '+est.classe+'" data-estado="'+esc(f.funcao)+'">'+esc(est.texto)+'</p>';
  if(!f.ambientePermite)h+='<p class="ia-suave">'+esc(FRASE.bloqueadaAjuda)+'</p>';
  h+='<dl class="ia-dl">';
  h+=linha('Análises',n(f.analises));
  h+=linha('Polegar para cima',n(f.util));
  h+=linha('Polegar para baixo',n(f.errado+f.perigoso)+(avaliadas?' de '+n(avaliadas)+' avaliadas':''));
  h+=linha('Motivos do polegar para baixo',motivosDaAvaliacao(f));
  h+=linha('"Não foi possível"',n(f.naoFoiPossivel)+(f.taxaNaoFoiPossivel==null?'':' ('+pct(f.taxaNaoFoiPossivel)+')'));
  h+=linha('Não verificadas',n(f.naoVerificadas)+(f.taxaNaoVerificado==null?'':' ('+pct(f.taxaNaoVerificado)+')'));
  h+=linha('Falhas de verificação',listaDeFalhas(f));
  h+=linha('Repetições automáticas',n(f.repeticoesAutomaticas));
  h+=linha('Custo total',esc(usd(f.custo.total,4)));
  h+=linha('Custo médio por análise',esc(usd(f.custo.medio,4)));
  h+=linha('Custo p50 · p95 · máximo',esc(usd(f.custo.p50,4))+' · '+esc(usd(f.custo.p95,4))+' · '+esc(usd(f.custo.maximo,4)));
  h+=linha('Tempo p50 · p95',esc(seg(f.latenciaP50Ms))+' · '+esc(seg(f.latenciaP95Ms)));
  h+='</dl>';

  /* Liga/desliga. Desligar pede confirmação NA TELA e no pedido (confirmado:true). */
  h+='<div class="ia-acoes">';
  if(S.confirmando===f.funcao){
    h+='<div class="ia-confirma" role="group" aria-labelledby="'+id+'-conf">';
    h+='<p id="'+id+'-conf"><strong>Desligar "'+esc(f.rotulo)+'"?</strong> O botão some para todas as contas, na hora. Você pode ligar de novo quando quiser.</p>';
    h+='<button type="button" class="bt bt-perigo" data-ia-confirmar="'+esc(f.funcao)+'">Sim, desligar</button> ';
    h+='<button type="button" class="bt2" data-ia-cancelar="1">Cancelar</button>';
    h+='</div>';
  }else if(f.painelLigado){
    h+='<button type="button" class="bt2" id="'+id+'-alternar" data-ia-desligar="'+esc(f.funcao)+'"'+(f.ambientePermite?'':' disabled')+'>Desligar</button>';
  }else{
    h+='<button type="button" class="bt2" id="'+id+'-alternar" data-ia-ligar="'+esc(f.funcao)+'"'+(f.ambientePermite?'':' disabled')+'>Ligar</button>';
  }
  h+='</div>';

  /* Teto por conta e dia (o painel só reduz). */
  h+='<div class="ia-campo">';
  h+='<label for="'+id+'-teto">Teto por conta e por dia (análises; a peça conta 5)</label>';
  h+='<div class="ia-linha"><input id="'+id+'-teto" type="number" min="1" max="100000" step="1" inputmode="numeric" value="'+
    (f.tetoDoPainel==null?'':esc(f.tetoDoPainel))+'" placeholder="sem teto do painel">';
  h+='<button type="button" class="bt2" data-ia-teto="'+esc(f.funcao)+'">Salvar teto</button></div>';
  h+='<p class="ia-suave">Teto efetivo agora: <strong>'+n(f.tetoEfetivoPorConta)+'</strong> (o menor entre o ambiente e o painel). O painel só reduz.</p>';
  h+='</div>';
  return h+'</article>';
}

function secaoDeLimites(d){
  var h='<section aria-labelledby="ia-lim-t" class="ia-secao"><h2 id="ia-lim-t" class="ia-h2">Limites e alerta de custo</h2>';
  h+='<div class="cartao ia-cartao">';
  h+='<p>Custo da IA hoje: <strong id="ia-custo-hoje">'+esc(usd(d.custoDoDia.usd))+'</strong> · limite do alerta: <strong>'+esc(usd(d.custoDoDia.alertaUsd))+'</strong>'+
    (d.custoDoDia.acima?' · <strong class="ia-acima">acima do limite</strong>':'')+'</p>';
  h+='<div class="ia-campo"><label for="ia-alerta">Limite do alerta de custo por dia (US$)</label>';
  h+='<div class="ia-linha"><input id="ia-alerta" type="text" inputmode="decimal" autocomplete="off" value="'+esc(Number(d.custoDoDia.alertaUsd).toFixed(2))+'">';
  h+='<button type="button" class="bt2" data-ia-alerta="1">Salvar limite</button></div>';
  h+='<p class="ia-suave">Passando do limite, o aviso aparece aqui e um e-mail sai uma vez por dia.</p></div>';
  h+='<div class="ia-campo"><label for="ia-global">Teto global por dia, todas as contas (análises)</label>';
  h+='<div class="ia-linha"><input id="ia-global" type="number" min="1" max="100000" step="1" inputmode="numeric" value="'+
    (d.tetoGlobal==null?'':esc(d.tetoGlobal))+'" placeholder="sem teto global">';
  h+='<button type="button" class="bt2" data-ia-global="1">Salvar teto global</button></div></div>';
  h+='</div></section>';
  return h;
}

function secaoDeContas(d){
  var h='<section aria-labelledby="ia-con-t" class="ia-secao"><h2 id="ia-con-t" class="ia-h2">Contas que mais usaram</h2>';
  if(!d.contas.length)return h+'<p class="ia-suave">'+esc(FRASE.semDados)+'</p></section>';
  h+='<ol class="ia-lista ia-contas">';
  for(var i=0;i<d.contas.length;i++){
    h+='<li><span class="ia-mono">'+esc(d.contas[i].conta)+'</span> — '+n(d.contas[i].analises)+' análises</li>';
  }
  return h+'</ol></section>';
}

function descreverAlteracao(a){
  var tipo=ROTULO_DO_TIPO[a.tipo]||a.tipo;
  return esc(tipo)+': '+esc(valorDaAlteracao(a,a.anterior))+' → '+esc(valorDaAlteracao(a,a.novo));
}

function secaoDeHistorico(d){
  var h='<section aria-labelledby="ia-his-t" class="ia-secao"><h2 id="ia-his-t" class="ia-h2">Últimas 50 mudanças</h2>';
  if(!d.alteracoes.length)return h+'<p class="ia-suave">Nenhuma mudança feita pelo painel ainda.</p></section>';
  h+='<ul class="ia-lista ia-historico">';
  for(var i=0;i<d.alteracoes.length;i++){
    var a=d.alteracoes[i];
    h+='<li><span class="ia-quando">'+esc(dth(a.em))+'</span> · '+esc(ROTULO_DA_FUNCAO[a.funcao]||a.funcao)+' · '+
      descreverAlteracao(a)+' · operador <span class="ia-mono">'+esc(a.autor)+'</span></li>';
  }
  return h+'</ul></section>';
}

function desenhar(){
  var d=S.dados,h='';
  h+='<h1 id="ia-titulo" class="ia-h1" tabindex="-1">IA</h1>';
  h+='<p class="ia-suave ia-intro">Observe o uso das três funções de IA e controle o que está ligado. O ambiente do servidor é a trava mestra: este painel só desliga ou reduz.</p>';
  h+='<div class="ia-periodos" role="group" aria-label="Período">';
  for(var i=0;i<PERIODOS.length;i++){
    h+='<button type="button" class="bt2 ia-periodo" data-ia-periodo="'+PERIODOS[i][0]+'" aria-pressed="'+(S.periodo===PERIODOS[i][0])+'">'+PERIODOS[i][1]+'</button>';
  }
  h+='</div>';
  if(!d){return h+'<p class="vazio" id="ia-estado">'+esc(S.msg||FRASE.carregando)+'</p><div id="ia-live" class="ia-so-leitor" role="status" aria-live="polite"></div>'}
  h+='<section aria-labelledby="ia-fun-t" class="ia-secao"><h2 id="ia-fun-t" class="ia-h2">Funções</h2><div class="ia-grade">';
  for(var j=0;j<d.funcoes.length;j++)h+=cartaoDaFuncao(d.funcoes[j]);
  h+='</div></section>';
  h+=secaoDeLimites(d)+secaoDeContas(d)+secaoDeHistorico(d);
  h+='<div id="ia-live" class="ia-so-leitor" role="status" aria-live="polite"></div>';
  return h;
}

function pintar(){
  if(!S.raiz)return;
  var tinhaFoco=document.activeElement&&document.activeElement.id;
  S.raiz.innerHTML=desenhar();
  ligar();
  /* Foco só volta ao controle que a PESSOA acabou de usar; nunca é roubado em recarga. */
  if(S.foco){
    var el=$(S.foco)||S.raiz.querySelector('[data-foco="'+S.foco+'"]');
    if(el)el.focus();
    S.foco=null;
  }else if(tinhaFoco&&$(tinhaFoco)&&document.activeElement!==$(tinhaFoco)){
    $(tinhaFoco).focus();
  }
}

/* ---------- ações ---------- */
function carregar(){
  return api('/admin/api/ia?periodo='+encodeURIComponent(S.periodo)).then(function(d){
    S.dados=d;S.msg='';pintar();
  },function(){S.dados=null;S.msg=FRASE.falha;pintar()});
}

function salvar(caminho,corpo,focoDepois){
  return api(caminho,{method:'PUT',body:corpo}).then(function(){
    S.confirmando=null;S.foco=focoDepois||null;
    return carregar().then(function(){anunciar(FRASE.salvo);banner($('aviso-ia'))});
  },function(e){
    S.confirmando=null;
    anunciar(FRASE.naoSalvo);
    mostrarErro(e);
  });
}
function mostrarErro(e){
  var el=$('ia-live');
  if(el)el.textContent=FRASE.naoSalvo+(e&&e.status?' (código '+e.status+')':'');
}

function lerTeto(entrada){
  var t=String(entrada.value||'').trim();
  if(t==='')return null;
  var v=Number(t);
  return /^\d+$/.test(t)&&v>=1&&v<=100000?v:NaN;
}

function ligar(){
  var r=S.raiz;
  var bs=r.querySelectorAll('[data-ia-periodo]');
  for(var i=0;i<bs.length;i++){
    bs[i].addEventListener('click',function(ev){
      S.periodo=ev.currentTarget.getAttribute('data-ia-periodo');S.dados=null;S.foco=null;
      pintar();carregar().then(function(){var b=r.querySelector('[data-ia-periodo="'+S.periodo+'"]');if(b)b.focus()});
    });
  }
  var off=r.querySelectorAll('[data-ia-desligar]');
  for(var j=0;j<off.length;j++){
    off[j].addEventListener('click',function(ev){
      S.confirmando=ev.currentTarget.getAttribute('data-ia-desligar');
      S.foco=null;pintar();
      var c=r.querySelector('[data-ia-confirmar]');if(c)c.focus();
    });
  }
  var canc=r.querySelectorAll('[data-ia-cancelar]');
  for(var k=0;k<canc.length;k++){
    canc[k].addEventListener('click',function(){
      var f=S.confirmando;S.confirmando=null;S.foco='ia-f-'+f+'-alternar';pintar();
    });
  }
  var conf=r.querySelectorAll('[data-ia-confirmar]');
  for(var m=0;m<conf.length;m++){
    conf[m].addEventListener('click',function(ev){
      var f=ev.currentTarget.getAttribute('data-ia-confirmar');
      salvar('/admin/api/ia/funcoes/'+encodeURIComponent(f),{ligada:false,confirmado:true},'ia-f-'+f+'-alternar');
    });
  }
  var on=r.querySelectorAll('[data-ia-ligar]');
  for(var p=0;p<on.length;p++){
    on[p].addEventListener('click',function(ev){
      var f=ev.currentTarget.getAttribute('data-ia-ligar');
      salvar('/admin/api/ia/funcoes/'+encodeURIComponent(f),{ligada:true},'ia-f-'+f+'-alternar');
    });
  }
  var tetos=r.querySelectorAll('[data-ia-teto]');
  for(var q=0;q<tetos.length;q++){
    tetos[q].addEventListener('click',function(ev){
      var f=ev.currentTarget.getAttribute('data-ia-teto'),campo=$('ia-f-'+f+'-teto'),v=lerTeto(campo);
      if(v!==v){anunciar(FRASE.tetoInvalido);campo.focus();return}
      salvar('/admin/api/ia/funcoes/'+encodeURIComponent(f)+'/teto',{teto:v},'ia-f-'+f+'-teto');
    });
  }
  var g=r.querySelector('[data-ia-global]');
  if(g)g.addEventListener('click',function(){
    var campo=$('ia-global'),v=lerTeto(campo);
    if(v!==v){anunciar(FRASE.tetoInvalido);campo.focus();return}
    salvar('/admin/api/ia/teto-global',{teto:v},'ia-global');
  });
  var al=r.querySelector('[data-ia-alerta]');
  if(al)al.addEventListener('click',function(){
    var campo=$('ia-alerta'),t=String(campo.value||'').replace(',','.').trim(),v=Number(t);
    if(t===''||!isFinite(v)||v<0.01||v>10000){anunciar(FRASE.alertaInvalido);campo.focus();return}
    salvar('/admin/api/ia/alerta',{valorUsd:v},'ia-alerta');
  });
}

/* Entrada da aba: desenha "carregando", busca e leva o foco ao título da tela (a pessoa mudou de tela). */
function render(raiz){
  S.raiz=raiz;S.dados=null;S.confirmando=null;S.msg='';
  pintar();
  return carregar().then(function(){
    var t=$('ia-titulo');if(t)t.focus();
    banner($('aviso-ia'));
  });
}

window.__pvIaAdmin={render:render,banner:banner};
})();
`;

export const ESTILOS_IA_ADMIN = `
.ia-h1{margin:0 0 6px;font-size:26px;outline:0}
.ia-h2{margin:0 0 12px;font-size:19px}
.ia-h3{margin:0 0 6px;font-size:16.5px}
.ia-intro{margin:0 0 16px;max-width:70ch}
.ia-suave{color:var(--tinta2);font-size:13.5px;margin:6px 0}
.ia-secao{margin:26px 0 0;min-width:0}
.ia-periodos{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 6px}
.ia-periodo[aria-pressed="true"]{background:var(--acento-bg);border-color:var(--acento);font-weight:700}
.ia-grade{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:16px;align-items:start}
.ia-grade>*{min-width:0}
.ia-cartao{min-width:0;overflow-wrap:anywhere}
.ia-selo{display:inline-block;margin:0 0 8px;padding:3px 10px;border-radius:999px;border:1px solid var(--linha);
  font-size:13px;font-weight:700}
.ia-sel-on{color:var(--verde-tinta);border-color:var(--verde-tinta)}
.ia-sel-off{color:var(--atencao);border-color:var(--atencao)}
.ia-sel-bloq{color:var(--erro);border-color:var(--erro)}
.ia-dl{margin:10px 0;display:grid;gap:6px}
.ia-par{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr);gap:8px;align-items:baseline;
  border-top:1px solid var(--linha);padding-top:6px}
.ia-par dt{color:var(--tinta2);font-size:13.5px}
.ia-par dd{margin:0;font-size:14px;min-width:0}
.ia-lista{margin:6px 0;padding-left:20px}
.ia-lista li{margin:3px 0;overflow-wrap:anywhere}
.ia-historico{padding-left:0;list-style:none}
.ia-historico li{border-top:1px solid var(--linha);padding:7px 0;font-size:13.5px}
.ia-mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px}
.ia-quando{color:var(--tinta2)}
.ia-acima{color:var(--erro)}
.ia-acoes{margin:10px 0}
.ia-confirma{border:1px solid var(--atencao);border-radius:10px;padding:10px 12px;background:var(--papel2)}
.ia-confirma p{margin:0 0 8px}
/* Contornado, não preenchido: o --erro do tema escuro é claro e o texto branco sobre ele não passa no contraste. */
button.bt-perigo{background:var(--erro-bg);color:var(--erro);border:2px solid var(--erro)}
.ia-campo{margin:12px 0}
.ia-campo label{display:block;font-size:13.5px;font-weight:700;margin-bottom:5px}
.ia-linha{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ia-linha input{width:100%;max-width:12rem;min-width:0}
.ia-so-leitor{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
#aviso-ia{margin:0 0 14px;border:1px solid var(--erro);background:var(--erro-bg);border-radius:10px;padding:12px 14px}
#aviso-ia a{text-decoration:underline;font-weight:700}
#aviso-ia[hidden]{display:none}
@media (max-width:520px){.ia-par{grid-template-columns:minmax(0,1fr)}}
`;
