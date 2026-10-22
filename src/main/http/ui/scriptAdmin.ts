/**
 * Script da área administrativa. Arquivo separado do HTML só para revisão —
 * mesma convenção do console do assinante, em `ui/script.ts`.
 *
 * JavaScript puro, sem build: o servidor devolve isto dentro de uma tag
 * <script>. A credencial é HTTP Basic Auth, que o NAVEGADOR guarda por conta
 * própria depois do primeiro pedido — nenhuma linha aqui manda usuário ou
 * senha; o `fetch` de mesma origem já sai autenticado.
 *
 * `tests/http/admin-script.spec.ts` roda o ESLint dentro desta string, pela
 * mesma razão documentada em `tests/http/console-script.spec.ts`: nem `tsc`
 * nem `eslint` enxergam JavaScript escondido dentro de um `String.raw`.
 */
export const SCRIPT_ADMIN = String.raw`
(function(){
var $=function(i){return document.getElementById(i)};

var estado={aba:'assinaturas',assinaturas:null,chaves:null,chaveEmitida:null,
  catalogo:null,editando:null,avisoPlanos:null,pagamento:{habilitado:false}};

/* ---------------- utilidades (mesmas convenções de ui/script.ts) ---------------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function dt(iso){if(!iso)return'—';var d=new Date(iso);return isNaN(d)?'—':
  d.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'})}
function dth(iso){if(!iso)return'—';var d=new Date(iso);return isNaN(d)?'—':
  d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',
    month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}

/* Dinheiro em CENTAVOS do servidor para a tela, e de volta. null é "sem preço". */
function fmtPreco(c){
  if(c==null)return 'sem preço';
  return (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
}
function paraCentavos(txt){
  var t=String(txt||'').replace(/R\$/g,'').replace(/\s/g,'');
  if(t==='')return null;
  /* "1.234,56" e "49,90" são o jeito brasileiro; "49.90" também vale. */
  if(t.indexOf(',')>=0)t=t.replace(/\./g,'').replace(',','.');
  if(!/^\d+(\.\d{1,2})?$/.test(t))return NaN;
  return Math.round(Number(t)*100);
}
function precoParaCampo(c){
  if(c==null)return '';
  return (c/100).toFixed(2).replace('.',',');
}

function api(caminho,opcoes){
  opcoes=opcoes||{};
  var h={};
  if(opcoes.body)h['content-type']='application/json';
  /* opcoes.method pode ser PUT: as rotas de plano e de regras usam. */
  return fetch(caminho,{method:opcoes.method||'GET',headers:h,
    body:opcoes.body?JSON.stringify(opcoes.body):undefined})
    .then(function(r){return r.json().catch(function(){return{}})
      .then(function(b){
        if(!r.ok){var e=new Error(b.mensagem||('HTTP '+r.status));
          e.status=r.status;e.codigo=b.erro;throw e}
        return b})});
}

function erroBloco(e){
  var msg=(e&&e.message)?e.message:'erro inesperado';
  return '<div class="cartao" style="border-color:var(--erro);background:var(--erro-bg)">'+
    '<div style="font-weight:700;color:var(--erro)">'+esc(msg)+'</div></div>';
}

/* ---------------- navegação ---------------- */
function irPara(aba){
  estado.aba=aba;
  $('nav-assinaturas').className=aba==='assinaturas'?'ativo':'';
  $('nav-chaves').className=aba==='chaves'?'ativo':'';
  $('nav-planos').className=aba==='planos'?'ativo':'';
  render();
}

function render(){
  var c=$('conteudo');
  c.innerHTML='<div class="vazio"><span class="gira"></span>carregando…</div>';
  if(estado.aba==='chaves'){renderChaves()}
  else if(estado.aba==='planos'){renderPlanos()}
  else{renderAssinaturas()}
}

/* O ambiente da cobrança recorrente. Em modo de TESTE o aviso é impossível de não ver: nenhum pagamento
   é real, e em produção isso quase sempre é engano. Sem a cobrança habilitada, nada aparece. */
function carregarPagamento(){
  return api('/admin/api/pagamento').then(function(r){estado.pagamento=r}).catch(function(){estado.pagamento={habilitado:false}});
}
var ROTULO_DA_FALHA_DO_GATEWAY={
  email_pagador:'o Mercado Pago recusou o e-mail do pagador',
  credencial:'o Mercado Pago recusou a credencial (token)',
  parametro_invalido:'o Mercado Pago recusou algum campo do pedido (veja o log)',
  indisponivel:'o Mercado Pago está fora do ar, lento ou limitando',
  desconhecido:'recusa sem motivo identificável (veja o log: "gateway de pagamento recusou o pedido")'};
function bannerDoAmbiente(){
  var p=estado.pagamento;
  if(!p||!p.habilitado)return '';
  var h='';
  if(p.modoDeTeste){
    h+='<div class="aviso" role="status" style="margin-bottom:12px;border-color:var(--erro)">'+
      '<strong style="color:var(--erro)">TESTE</strong> — '+esc(p.aviso||'Nenhum pagamento é real.')+'</div>';
  }
  var f=p.ultimaFalha;
  if(f){
    h+='<div class="aviso" role="status" style="margin-bottom:12px"><strong>Última falha do gateway:</strong> '+
      esc(dt(f.em))+' · '+esc(f.operacao)+' · '+(f.status!==null?'HTTP '+esc(f.status):'sem resposta')+
      (f.codigo?' · código '+esc(f.codigo):'')+' · '+esc(ROTULO_DA_FALHA_DO_GATEWAY[f.motivo]||f.motivo)+'</div>';
  }
  return h;
}
var ROTULO_DO_ESTADO_DO_GATEWAY={pendente:'aguardando pagamento',autorizada:'renovação automática ativa',
  pausada:'pausada',cancelada:'renovação encerrada'};

/* ---------------- assinaturas ---------------- */
function renderAssinaturas(){
  Promise.all([api('/admin/api/assinaturas'),api('/admin/api/planos'),carregarPagamento()]).then(function(rs){
    estado.assinaturas=rs[0].assinaturas||[];
    estado.catalogo=rs[1];
    desenharAssinaturas();
  }).catch(function(e){$('conteudo').innerHTML=erroBloco(e)});
}

/* Todos os planos, à venda ou não: liberar plano pausado é como se mantém um
   cliente antigo no plano dele. O rótulo diz qual é qual. */
function opcoesDePlano(selecionado){
  var planos=(estado.catalogo&&estado.catalogo.planos)||[];
  return planos.map(function(p){
    return '<option value="'+esc(p.codigo)+'"'+(p.codigo===selecionado?' selected':'')+'>'+
      esc(p.nome)+(p.disponivelParaContratacao?'':' (pausado)')+
      ' · '+esc(fmtPreco(p.precoMensalCentavos))+'</option>';
  }).join('');
}

/* Origem e cobrança no gateway: só metadado (estado, id, último pagamento) — nunca dado do pagador. */
function celulaDeOrigem(a){
  if(!a.pagamento)return '<td class="t-sub">manual</td>';
  var g=a.pagamento;
  return '<td>Mercado Pago'+
    '<div class="t-sub">'+esc(ROTULO_DO_ESTADO_DO_GATEWAY[g.estadoNoGateway]||g.estadoNoGateway)+'</div>'+
    '<div class="t-sub" style="font-family:ui-monospace,monospace;user-select:all">'+esc(g.gatewayId||'—')+'</div>'+
    '<div class="t-sub">último pagamento: '+(g.ultimoPagamento?esc(g.ultimoPagamento)+' em '+dt(g.ultimoPagamentoEm):'—')+'</div>'+
    '<button class="bt3" data-reconciliar="'+esc(a.workspace)+'">reconciliar</button></td>';
}

function linhaAssinatura(a){
  return '<tr>'+
    '<td>'+(a.email?esc(a.email):'(sem conta — chave de API) <span class="t-sub" style="font-family:ui-monospace,monospace;user-select:all">'+esc(a.workspace)+'</span>')+'</td>'+
    '<td>'+esc(a.nomeDoPlano)+(a.ehTeste?' <span class="selo">teste</span>':'')+'</td>'+
    '<td>'+esc(a.status)+'</td>'+
    '<td>'+dt(a.venceEm)+'</td>'+
    '<td class="t-sub">'+esc(a.observacao||'—')+'</td>'+
    (estado.pagamento.habilitado?celulaDeOrigem(a):'')+
    '</tr>';
}

function desenharAssinaturas(){
  var linhas=estado.assinaturas.map(linhaAssinatura).join('');
  var tabela=estado.assinaturas.length===0
    ? '<div class="vazio"><p>Nenhuma assinatura cadastrada ainda.</p></div>'
    : '<div class="cartao sem-borda"><div class="tab-rolo"><table class="tab">'+
      '<thead><tr><th>Conta</th><th>Plano</th><th>Status</th><th>Vence em</th>'+
      '<th>Observação</th>'+(estado.pagamento.habilitado?'<th>Origem / cobrança</th>':'')+
      '</tr></thead><tbody>'+linhas+'</tbody></table></div></div>';

  var h=bannerDoAmbiente();
  h+='<div class="titulo-secao"><div><h2>Assinaturas</h2>'+
    '<div class="sub">'+estado.assinaturas.length+' assinatura(s) cadastrada(s)</div>'+
    '</div><div><button class="bt2" id="bt-avisar">Enviar avisos de vencimento agora</button>'+
    (estado.pagamento.habilitado?' <button class="bt2" id="bt-reconciliar">Reconciliar cobranças</button>':'')+
    '</div></div>';
  h+='<div id="resultado-avisar"></div>';

  h+='<div class="cartao"><h3 class="sec">Gerenciar por e-mail ou workspace</h3>';
  h+='<div class="grade">';
  h+='<div><label class="rotulo">E-mail da conta</label><input id="in-email" placeholder="ana@escritorio.com.br"></div>';
  h+='<div><label class="rotulo">ou Workspace (conta de chave de API, sem e-mail)</label><input id="in-ws" placeholder="0123456789abcdef" autocomplete="off"></div>';
  h+='</div>';
  h+='<div class="grade" style="margin-top:10px">';
  var doTeste=estado.catalogo&&estado.catalogo.regras?estado.catalogo.regras.planoDoTeste:'';
  h+='<div><label class="rotulo">Plano</label><select id="in-plano">'+
    opcoesDePlano(doTeste)+'</select></div>';
  h+='<div><label class="rotulo">Meses</label><input id="in-meses" type="number" min="1" max="60" value="12"></div>';
  h+='<div><label class="rotulo">Observação (opcional)</label><input id="in-obs" placeholder="Pix 22/09"></div>';
  h+='</div>';
  h+='<div class="grade" style="margin-top:12px">'+
    '<button class="bt" id="bt-liberar">Liberar / renovar</button>'+
    '<button class="bt2" id="bt-cancelar">Cancelar assinatura</button>'+
    '</div>';
  h+='<div id="resultado-gerenciar" style="margin-top:12px"></div>';
  h+='</div>';

  h+=tabela;
  $('conteudo').innerHTML=h;

  /* Reconciliar: consulta o gateway e corrige o que divergir (aviso perdido). Uma conta ou todas. */
  function reconciliar(workspace,bt){
    bt.disabled=true;
    api('/admin/api/pagamento/reconciliar',{method:'POST',body:workspace?{workspace:workspace}:{}}).then(function(r){
      $('resultado-avisar').innerHTML='<div class="aviso" style="margin-top:10px">'+esc(r.verificadas)+
        ' verificada(s), '+esc(r.corrigidas)+' corrigida(s), '+esc(r.pagamentosNovos)+' pagamento(s) novo(s), '+
        esc(r.falhas)+' falha(s).</div>';
      renderAssinaturas();
    }).catch(function(e){$('resultado-avisar').innerHTML=erroBloco(e);bt.disabled=false});
  }
  if($('bt-reconciliar'))$('bt-reconciliar').addEventListener('click',function(){reconciliar('',$('bt-reconciliar'))});
  var recs=document.querySelectorAll('[data-reconciliar]');
  for(var k=0;k<recs.length;k++){
    (function(bt){bt.addEventListener('click',function(){reconciliar(bt.getAttribute('data-reconciliar'),bt)})})(recs[k]);
  }

  $('bt-avisar').addEventListener('click',function(){
    var bt=$('bt-avisar');bt.disabled=true;
    api('/admin/api/assinaturas/avisar',{method:'POST'}).then(function(r){
      $('resultado-avisar').innerHTML='<div class="aviso" style="margin-top:10px">'+
        esc(r.avisados)+' aviso(s) enviado(s).</div>';
      bt.disabled=false;
    }).catch(function(e){
      $('resultado-avisar').innerHTML=erroBloco(e);
      bt.disabled=false;
    });
  });

  $('bt-liberar').addEventListener('click',function(){
    var email=$('in-email').value.trim();
    var wsId=$('in-ws').value.trim();
    if(email&&wsId){$('resultado-gerenciar').innerHTML=erroBloco({message:'Informe o e-mail OU o workspace, não os dois.'});return}
    if(!email&&!wsId){$('resultado-gerenciar').innerHTML=erroBloco({message:'Informe o e-mail da conta ou o workspace.'});return}
    var corpo={plano:$('in-plano').value,meses:Number($('in-meses').value)||12};
    var obs=$('in-obs').value.trim();
    if(obs)corpo.observacao=obs;
    var rotaLiberar=email
      ?'/admin/api/assinaturas/'+encodeURIComponent(email)+'/liberar'
      :'/admin/api/workspaces/'+encodeURIComponent(wsId)+'/assinatura/liberar';
    api(rotaLiberar,
      {method:'POST',body:corpo}).then(function(r){
        $('resultado-gerenciar').innerHTML='<div class="aviso">'+esc(email||('workspace '+r.workspace))+': plano '+
          esc(r.nomeDoPlano)+', vence em '+dt(r.venceEm)+'.</div>';
        renderAssinaturas();
      }).catch(function(e){$('resultado-gerenciar').innerHTML=erroBloco(e)});
  });

  $('bt-cancelar').addEventListener('click',function(){
    var email=$('in-email').value.trim();
    if(!email){$('resultado-gerenciar').innerHTML=erroBloco({message:'Informe o e-mail da conta (cancelar por workspace não existe nesta versão).'});return}
    if(!window.confirm('Cancelar a assinatura de '+email+'?'))return;
    var obs=$('in-obs').value.trim();
    api('/admin/api/assinaturas/'+encodeURIComponent(email)+'/cancelar',
      {method:'POST',body:obs?{observacao:obs}:{}}).then(function(){
        $('resultado-gerenciar').innerHTML='<div class="aviso">'+esc(email)+': assinatura cancelada.</div>';
        renderAssinaturas();
      }).catch(function(e){$('resultado-gerenciar').innerHTML=erroBloco(e)});
  });
}

/* ---------------- planos ---------------- */
function renderPlanos(){
  Promise.all([api('/admin/api/planos'),carregarPagamento()]).then(function(rs){
    estado.catalogo=rs[0];
    desenharPlanos();
  }).catch(function(e){$('conteudo').innerHTML=erroBloco(e)});
}
var ROTULO_DO_CICLO={mensal:'mensal',trimestral:'trimestral',anual:'anual'};

function vigentes(p){return p.assinantes.teste+p.assinantes.ativa+p.assinantes.carencia}

function nomeRecurso(codigo){
  var rs=estado.catalogo.recursos;
  for(var i=0;i<rs.length;i++){if(rs[i].recurso===codigo)return rs[i].nome}
  return codigo;
}

function linhaPlano(p){
  var sit=p.disponivelParaContratacao
    ?'<span class="selo">à venda</span>':'<span class="selo al">pausado</span>';
  var a=p.assinantes;
  var detalhe=[];
  if(a.ativa)detalhe.push(a.ativa+' ativa(s)');
  if(a.teste)detalhe.push(a.teste+' em teste');
  if(a.carencia)detalhe.push(a.carencia+' em carência');
  if(a.vencida)detalhe.push(a.vencida+' vencida(s)');
  if(a.cancelada)detalhe.push(a.cancelada+' cancelada(s)');
  return '<tr>'+
    '<td><strong>'+esc(p.nome)+'</strong>'+
      '<div class="t-sub">'+esc(p.codigo)+'</div>'+
      (p.ehPlanoDoTeste?'<div style="margin-top:4px"><span class="selo nv">plano do teste</span></div>':'')+'</td>'+
    '<td>'+esc(fmtPreco(p.precoMensalCentavos))+'</td>'+
    '<td>'+esc(ROTULO_DO_CICLO[p.ciclo||'mensal']||p.ciclo)+'</td>'+
    '<td class="t-sub">'+esc(p.recursos.map(nomeRecurso).join(', '))+'</td>'+
    '<td>'+sit+'</td>'+
    '<td><strong>'+vigentes(p)+'</strong> com acesso'+
      (detalhe.length?'<div class="t-sub">'+esc(detalhe.join(' · '))+'</div>':'')+'</td>'+
    '<td style="white-space:nowrap">'+
      '<button class="bt3" data-editar="'+esc(p.codigo)+'">editar</button>'+
      '<button class="bt3" data-venda="'+esc(p.codigo)+'">'+
        (p.disponivelParaContratacao?'pausar':'colocar à venda')+'</button></td>'+
    '</tr>';
}

function planoPorCodigo(codigo){
  var ps=estado.catalogo.planos;
  for(var i=0;i<ps.length;i++){if(ps[i].codigo===codigo)return ps[i]}
  return null;
}

function formularioPlano(){
  var novo=estado.editando==='novo';
  var p=novo?{codigo:'',nome:'',resumo:'',recursos:['consulta','acompanhamento','vigilancia'],
    disponivelParaContratacao:false,precoMensalCentavos:null,ordem:'',ciclo:'mensal'}:planoPorCodigo(estado.editando);
  if(!p)return '';
  var marcas=estado.catalogo.recursos.map(function(r){
    var marcado=p.recursos.indexOf(r.recurso)>=0;
    return '<label><input type="checkbox" data-recurso="'+esc(r.recurso)+'"'+(marcado?' checked':'')+'>'+
      esc(r.nome)+(r.implementado?'':' <span class="t-sub">— ainda não existe: não pode ir à venda</span>')+
      (r.cobradoPorUso?' <span class="t-sub">— custa a cada uso: só vai à venda com preço e não entra no teste grátis</span>':'')+'</label>';
  }).join('');

  var h='<div class="cartao"><h3 class="sec">'+(novo?'Novo plano':'Editar plano '+esc(p.nome))+'</h3>';
  if(!novo&&vigentes(p)>0){
    h+='<div class="aviso" style="margin-bottom:12px">Este plano tem '+vigentes(p)+
      ' assinante(s) com acesso aberto. O que mudar aqui vale na hora para eles.</div>';
  }
  h+='<div class="grade">';
  if(novo){
    h+='<div><label class="rotulo" for="pl-codigo">Código</label>'+
      '<input id="pl-codigo" placeholder="pecas-anual" maxlength="30">'+
      '<div class="nota">Minúsculas, números e hífen. Não muda depois de criado.</div></div>';
  }
  h+='<div><label class="rotulo" for="pl-nome">Nome</label>'+
    '<input id="pl-nome" maxlength="40" value="'+esc(p.nome)+'"></div>';
  h+='<div><label class="rotulo" for="pl-preco">Preço por mês (R$)</label>'+
    '<input id="pl-preco" placeholder="49,90" value="'+esc(precoParaCampo(p.precoMensalCentavos))+'">'+
    '<div class="nota">Vazio = sem preço publicado.</div></div>';
  h+='<div><label class="rotulo" for="pl-ciclo">Ciclo de renovação</label>'+
    '<select id="pl-ciclo">'+['mensal','trimestral','anual'].map(function(c){
      return '<option value="'+c+'"'+((p.ciclo||'mensal')===c?' selected':'')+'>'+ROTULO_DO_CICLO[c]+'</option>'}).join('')+'</select>'+
    '<div class="nota">Só o mensal pode ser contratado pelo site nesta versão.</div></div>';
  h+='<div><label class="rotulo" for="pl-ordem">Ordem na lista</label>'+
    '<input id="pl-ordem" type="number" min="0" max="9999" value="'+esc(p.ordem)+'"'+
    (novo?' placeholder="no fim"':'')+'></div>';
  h+='</div>';
  h+='<div style="margin-top:10px"><label class="rotulo" for="pl-resumo">Descrição</label>'+
    '<textarea id="pl-resumo" rows="2" maxlength="300">'+esc(p.resumo)+'</textarea>'+
    '<div class="nota">Uma linha. Aparece para o advogado na tela da conta e nos e-mails.</div></div>';
  h+='<div style="margin-top:12px"><span class="rotulo">Recursos incluídos</span><div class="marcas">'+marcas+'</div></div>';
  h+='<div class="marcas" style="margin-top:12px"><label><input type="checkbox" id="pl-venda"'+
    (p.disponivelParaContratacao?' checked':'')+'>À venda</label></div>';
  h+='<div class="grade" style="margin-top:14px">'+
    '<button class="bt" id="pl-salvar">'+(novo?'Criar plano':'Salvar')+'</button>'+
    '<button class="bt2" id="pl-cancelar">Cancelar</button></div>';
  h+='<div id="pl-resultado" style="margin-top:10px"></div></div>';
  return h;
}

function formularioRegras(){
  var r=estado.catalogo.regras;
  var h='<div class="cartao"><h3 class="sec">Teste e carência</h3>';
  h+='<div class="grade">'+
    '<div><label class="rotulo" for="rg-dias">Dias de teste</label>'+
      '<input id="rg-dias" type="number" min="1" max="90" value="'+esc(r.diasDeTeste)+'"></div>'+
    '<div><label class="rotulo" for="rg-plano">Plano do teste</label>'+
      '<select id="rg-plano">'+opcoesDePlano(r.planoDoTeste)+'</select></div>'+
    '<div><label class="rotulo" for="rg-carencia">Dias de carência</label>'+
      '<input id="rg-carencia" type="number" min="0" max="60" value="'+esc(r.diasDeCarencia)+'"></div>'+
    '</div>';
  h+='<div class="nota">Nada aqui é retroativo. O teste vale para contas criadas depois da mudança; '+
    'a carência, a partir da próxima liberação de cada assinante.</div>';
  h+='<div class="grade" style="margin-top:12px"><button class="bt" id="rg-salvar">Salvar regras</button></div>';
  h+='<div id="rg-resultado" style="margin-top:10px"></div></div>';
  return h;
}

function desenharPlanos(){
  var c=estado.catalogo;
  var h=bannerDoAmbiente();
  h+='<div class="titulo-secao"><div><h2>Planos</h2>'+
    '<div class="sub">'+c.planos.length+' plano(s). Pausar tira da oferta; quem já tem o plano continua com ele.</div>'+
    '</div><button class="bt2" id="bt-novo-plano">Novo plano</button></div>';
  if(estado.avisoPlanos){
    h+='<div class="aviso" style="margin-bottom:12px">'+esc(estado.avisoPlanos)+'</div>';
  }
  h+='<div id="resultado-planos"></div>';
  if(estado.editando)h+=formularioPlano();

  h+='<div class="cartao sem-borda"><div class="tab-rolo"><table class="tab">'+
    '<thead><tr><th>Plano</th><th>Preço/mês</th><th>Ciclo</th><th>Recursos</th><th>Situação</th>'+
    '<th>Assinantes</th><th></th></tr></thead><tbody>'+
    c.planos.map(linhaPlano).join('')+'</tbody></table></div></div>';
  h+=formularioRegras();
  $('conteudo').innerHTML=h;
  estado.avisoPlanos=null;

  $('bt-novo-plano').addEventListener('click',function(){estado.editando='novo';desenharPlanos()});

  var eds=document.querySelectorAll('[data-editar]');
  for(var i=0;i<eds.length;i++){
    (function(bt){bt.addEventListener('click',function(){
      estado.editando=bt.getAttribute('data-editar');desenharPlanos();window.scrollTo(0,0);
    })})(eds[i]);
  }

  var vds=document.querySelectorAll('[data-venda]');
  for(var j=0;j<vds.length;j++){
    (function(bt){bt.addEventListener('click',function(){
      var p=planoPorCodigo(bt.getAttribute('data-venda'));
      if(!p)return;
      var novo=!p.disponivelParaContratacao;
      bt.disabled=true;
      api('/admin/api/planos/'+encodeURIComponent(p.codigo),
        {method:'PUT',body:{disponivelParaContratacao:novo}}).then(function(){
          estado.avisoPlanos=novo?p.nome+' está à venda.':
            p.nome+' foi pausado. Quem já tem o plano continua com ele.';
          renderPlanos();
        }).catch(function(e){bt.disabled=false;$('resultado-planos').innerHTML=erroBloco(e)});
    })})(vds[j]);
  }

  if(estado.editando){
    $('pl-cancelar').addEventListener('click',function(){estado.editando=null;desenharPlanos()});
    $('pl-salvar').addEventListener('click',salvarPlano);
  }
  $('rg-salvar').addEventListener('click',salvarRegras);
}

function salvarPlano(){
  var novo=estado.editando==='novo';
  var atual=novo?null:planoPorCodigo(estado.editando);
  var preco=paraCentavos($('pl-preco').value);
  if(preco!==null&&isNaN(preco)){
    $('pl-resultado').innerHTML=erroBloco({message:'Preço inválido. Use o formato 49,90 — ou deixe vazio.'});
    return;
  }
  var recursos=[];
  var cks=document.querySelectorAll('[data-recurso]');
  for(var i=0;i<cks.length;i++){if(cks[i].checked)recursos.push(cks[i].getAttribute('data-recurso'))}

  var corpo={nome:$('pl-nome').value,resumo:$('pl-resumo').value,recursos:recursos,
    disponivelParaContratacao:$('pl-venda').checked,precoMensalCentavos:preco,ciclo:$('pl-ciclo').value};
  var ordem=$('pl-ordem').value.trim();
  if(ordem!=='')corpo.ordem=Number(ordem);

  if(atual&&vigentes(atual)>0&&recursos.slice().sort().join()!==atual.recursos.slice().sort().join()){
    if(!window.confirm('Os recursos deste plano mudam NA HORA para '+vigentes(atual)+
      ' assinante(s) com acesso aberto. Continuar?'))return;
  }

  var bt=$('pl-salvar');bt.disabled=true;
  var pedido=novo
    ?(function(){corpo.codigo=$('pl-codigo').value;return api('/admin/api/planos',{method:'POST',body:corpo})})()
    :api('/admin/api/planos/'+encodeURIComponent(atual.codigo),{method:'PUT',body:corpo});
  pedido.then(function(p){
    estado.editando=null;
    estado.avisoPlanos=novo?'Plano '+p.nome+' criado.':'Plano '+p.nome+' salvo.';
    renderPlanos();
  }).catch(function(e){bt.disabled=false;$('pl-resultado').innerHTML=erroBloco(e)});
}

function salvarRegras(){
  var corpo={diasDeTeste:Number($('rg-dias').value),planoDoTeste:$('rg-plano').value,
    diasDeCarencia:Number($('rg-carencia').value)};
  var bt=$('rg-salvar');bt.disabled=true;
  api('/admin/api/regras',{method:'PUT',body:corpo}).then(function(){
    estado.avisoPlanos='Regras de teste e carência salvas.';
    renderPlanos();
  }).catch(function(e){bt.disabled=false;$('rg-resultado').innerHTML=erroBloco(e)});
}

/* ---------------- chaves de API ---------------- */
function renderChaves(){
  api('/admin/api/chaves').then(function(r){
    estado.chaves=r.chaves||[];
    desenharChaves();
  }).catch(function(e){$('conteudo').innerHTML=erroBloco(e)});
}

function linhaChave(c){
  var status=c.revogadaEm?'<span class="selo al">revogada</span>':'<span class="selo">ativa</span>';
  var acao=c.revogadaEm?'':'<button class="bt3" data-revogar="'+esc(c.identificador)+'">revogar</button>';
  return '<tr>'+
    '<td>'+esc(c.rotulo)+'</td>'+
    '<td class="t-sub">'+esc(c.identificador)+'</td>'+
    '<td class="t-sub" style="font-family:ui-monospace,monospace;user-select:all">'+esc(c.workspace)+'</td>'+
    '<td>'+status+'</td>'+
    '<td>'+dth(c.criadaEm)+'</td>'+
    '<td>'+acao+'</td>'+
    '</tr>';
}

function desenharChaves(){
  var linhas=estado.chaves.map(linhaChave).join('');
  var tabela=estado.chaves.length===0
    ? '<div class="vazio"><p>Nenhuma chave emitida ainda.</p></div>'
    : '<div class="cartao sem-borda"><div class="tab-rolo"><table class="tab">'+
      '<thead><tr><th>Rótulo</th><th>Identificador</th><th>Workspace</th><th>Status</th>'+
      '<th>Criada em</th><th></th></tr></thead><tbody>'+linhas+'</tbody></table></div></div>';

  var h='';
  h+='<div class="titulo-secao"><div><h2>Chaves de API</h2>'+
    '<div class="sub">Cada chave abre um ambiente isolado próprio — o mesmo '+
    'modelo das chaves do arquivo de configuração.</div></div></div>';

  if(estado.chaveEmitida){
    var ch=estado.chaveEmitida;
    h+='<div class="cartao alerta"><h3 class="sec">Chave emitida — copie agora</h3>'+
      '<p class="nota">Esta é a ÚNICA vez que o valor aparece. Ela não fica salva em '+
      'lugar nenhum além deste momento — se perder, revogue e gere outra.</p>'+
      '<div class="t-in" style="font-family:ui-monospace,monospace;user-select:all;padding:10px;margin:8px 0">'+
      esc(ch.chave)+'</div>'+
      '<button class="bt2" id="bt-copiar">Copiar</button>'+
      '<button class="bt3" id="bt-fechar-chave">Já copiei, fechar</button></div>';
  }

  h+='<div class="cartao"><h3 class="sec">Emitir chave nova</h3>';
  h+='<div class="grade">'+
    '<div><label class="rotulo">Rótulo</label><input id="in-rotulo" placeholder="n8n, script de cobrança…"></div>'+
    '<div class="compacto" style="align-self:flex-end"><button class="bt" id="bt-emitir">Gerar chave</button></div>'+
    '</div>';
  h+='<div id="resultado-emitir" style="margin-top:10px"></div>';
  h+='</div>';

  h+=tabela;
  $('conteudo').innerHTML=h;

  if(estado.chaveEmitida){
    $('bt-copiar').addEventListener('click',function(){
      if(navigator.clipboard){navigator.clipboard.writeText(estado.chaveEmitida.chave).catch(function(){})}
    });
    $('bt-fechar-chave').addEventListener('click',function(){
      estado.chaveEmitida=null;
      desenharChaves();
    });
  }

  $('bt-emitir').addEventListener('click',function(){
    var rotulo=$('in-rotulo').value.trim();
    if(!rotulo){$('resultado-emitir').innerHTML=erroBloco({message:'Informe um rótulo para a chave.'});return}
    var bt=$('bt-emitir');bt.disabled=true;
    api('/admin/api/chaves',{method:'POST',body:{rotulo:rotulo}}).then(function(r){
      estado.chaveEmitida=r;
      bt.disabled=false;
      renderChaves();
    }).catch(function(e){
      $('resultado-emitir').innerHTML=erroBloco(e);
      bt.disabled=false;
    });
  });

  var botoesRevogar=document.querySelectorAll('[data-revogar]');
  for(var i=0;i<botoesRevogar.length;i++){
    (function(bt){
      bt.addEventListener('click',function(){
        var id=bt.getAttribute('data-revogar');
        if(!window.confirm('Revogar a chave "'+id+'"? Quem a usa perde acesso imediatamente.'))return;
        api('/admin/api/chaves/'+encodeURIComponent(id)+'/revogar',{method:'POST'})
          .then(function(){renderChaves()})
          .catch(function(e){$('resultado-emitir').innerHTML=erroBloco(e)});
      });
    })(botoesRevogar[i]);
  }
}

/* ---------------- arranque ---------------- */
$('nav-assinaturas').addEventListener('click',function(){irPara('assinaturas')});
$('nav-chaves').addEventListener('click',function(){irPara('chaves')});
$('nav-planos').addEventListener('click',function(){irPara('planos')});
render();
})();
`;
