/**
 * A tela "Administradores" do /admin (v0.62.0): o dono escolhe, por aba inteira, o que cada administrador restrito pode
 * usar. SÓ o dono a recebe — a página do restrito nem leva este código.
 *
 * Fala com o servidor só por `/admin/api/administradores*`, que entrega nomes de usuário, abas, datas e o histórico —
 * nunca senha (as credenciais moram só em variável de ambiente). Não conhece o resto do /admin: o núcleo
 * (`scriptAdmin.ts`) chama `window.__pvAdministradores.render(contêiner)`.
 */
export const SCRIPT_ADMINISTRADORES = String.raw`
window.__pvAdministradores=(function(){
var S={dados:null,edicao:{},confirmando:null,erro:{},msg:'',c:null};
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function dth(iso){if(!iso)return'—';var d=new Date(iso);return isNaN(d)?'—':
  d.toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',
    month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}

var FRASE={
  carregando:'Carregando…',
  falhou:'Não foi possível carregar os administradores. Tente de novo.',
  semRestritos:'Nenhum administrador restrito foi acrescentado no servidor ainda.',
  semHistorico:'Nenhuma mudança de permissão ainda.',
  nenhumaAba:'nenhuma aba',
  salvo:'Permissões salvas.',
  naoSalvou:'Não foi possível salvar. Tente de novo.'
};

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

function anunciar(t){
  var el=$('adm-live');
  if(!el)return;
  el.textContent='';
  setTimeout(function(){el.textContent=t||''},30);
}

function rotuloDaAba(aba){
  var l=(S.dados&&S.dados.abasDisponiveis)||[];
  for(var i=0;i<l.length;i++){if(l[i].aba===aba)return l[i].rotulo}
  return aba;
}
function lista(abas){
  if(!abas.length)return FRASE.nenhumaAba;
  return abas.map(rotuloDaAba).join(', ');
}
function salvas(u){
  var r=S.dados.restritos;
  for(var i=0;i<r.length;i++){if(r[i].usuario===u)return r[i].abas}
  return [];
}
function escolhidas(u){return S.edicao[u]||salvas(u)}
function mudou(u){
  var a=escolhidas(u).slice().sort().join(),b=salvas(u).slice().sort().join();
  return a!==b;
}

function cartaoDoDono(){
  return '<section class="adm-cartao" aria-labelledby="adm-dono-t"><h3 id="adm-dono-t" class="adm-nome">'+esc(S.dados.dono.usuario)+
    ' <span class="adm-papel">dono</span></h3><p class="adm-fixo">Todas as abas</p></section>';
}

function cartaoDoRestrito(r){
  var u=r.usuario,marcadas=escolhidas(u),h='';
  h+='<section class="adm-cartao" aria-labelledby="adm-t-'+esc(u)+'" data-adm-usuario="'+esc(u)+'">';
  h+='<h3 id="adm-t-'+esc(u)+'" class="adm-nome" tabindex="-1">'+esc(u)+' <span class="adm-papel">administrador restrito</span></h3>';
  h+='<p class="adm-suave">Último acesso: '+esc(dth(r.ultimoAcesso))+'</p>';
  h+='<fieldset class="adm-abas"><legend>Abas que '+esc(u)+' pode usar</legend>';
  for(var i=0;i<S.dados.abasDisponiveis.length;i++){
    var a=S.dados.abasDisponiveis[i];
    h+='<label class="adm-aba"><input type="checkbox" data-adm-aba="'+esc(a.aba)+'" data-adm-de="'+esc(u)+'"'+
      (marcadas.indexOf(a.aba)>=0?' checked':'')+'> <span>'+esc(a.rotulo)+'</span></label>';
  }
  h+='</fieldset>';
  if(S.confirmando===u){
    h+='<div class="adm-confirma" role="group" aria-label="Confirmar permissões de '+esc(u)+'">'+
      '<p>'+esc(u)+' passa a usar: <strong>'+esc(lista(marcadas))+'</strong>. Vale na próxima requisição dele.</p>'+
      '<button type="button" class="bt" id="adm-confirmar" data-adm-confirmar="'+esc(u)+'">Confirmar</button> '+
      '<button type="button" class="bt2" id="adm-cancelar" data-adm-cancelar="'+esc(u)+'">Cancelar</button></div>';
  }else{
    h+='<button type="button" class="bt" id="adm-salvar-'+esc(u)+'" data-adm-salvar="'+esc(u)+'"'+(mudou(u)?'':' disabled')+'>Salvar</button>';
  }
  if(S.erro[u])h+='<p class="adm-erro" role="alert">'+esc(S.erro[u])+'</p>';
  return h+'</section>';
}

function secaoSemCredencial(){
  var l=S.dados.semCredencial;
  if(!l.length)return '';
  var h='<section class="adm-secao" aria-labelledby="adm-sem-t"><h2 id="adm-sem-t" class="adm-h2">Sem credencial</h2>'+
    '<p class="adm-suave">Estes usuários têm permissões gravadas, mas não estão mais no servidor: não entram. As linhas ficam guardadas.</p><ul class="adm-lista">';
  for(var i=0;i<l.length;i++){
    h+='<li><span class="adm-mono">'+esc(l[i].usuario)+'</span> — sem credencial · '+esc(lista(l[i].abas))+'</li>';
  }
  return h+'</ul></section>';
}

function secaoDoHistorico(){
  var l=S.dados.historico;
  var h='<section class="adm-secao" aria-labelledby="adm-his-t"><h2 id="adm-his-t" class="adm-h2">Histórico de permissões</h2>';
  if(!l.length)return h+'<p class="adm-suave">'+esc(FRASE.semHistorico)+'</p></section>';
  h+='<div class="tab-rolo" role="region" aria-label="Tabela de mudanças de permissão" tabindex="0"><table class="tab adm-historico"><thead><tr>'+
    '<th scope="col">Quando</th><th scope="col">Por</th><th scope="col">Usuário</th><th scope="col">Aba</th><th scope="col">Ação</th></tr></thead><tbody>';
  for(var i=0;i<l.length;i++){
    var m=l[i];
    h+='<tr><td>'+esc(dth(m.em))+'</td><td>'+esc(m.por)+'</td><td>'+esc(m.usuario)+'</td><td>'+esc(m.rotuloDaAba)+'</td><td>'+
      (m.acao==='tirou'?'tirou':'liberou')+'</td></tr>';
  }
  return h+'</tbody></table></div></section>';
}

function desenhar(){
  var h='<h1 id="adm-titulo" class="adm-h1" tabindex="-1">Administradores</h1>';
  h+='<p class="adm-suave adm-intro">Quem entra aqui com usuário e senha próprios e quais abas cada um pode usar. Usuário e senha ficam só no servidor; aqui você escolhe as abas.</p>';
  if(!S.dados){
    h+='<p class="vazio" id="adm-estado">'+esc(S.msg||FRASE.carregando)+'</p><div id="adm-live" class="adm-so-leitor" role="status" aria-live="polite"></div>';
    S.c.innerHTML=h;
    return;
  }
  h+='<section class="adm-secao" aria-labelledby="adm-lista-t"><h2 id="adm-lista-t" class="adm-h2">Acessos</h2><div class="adm-grade">';
  h+=cartaoDoDono();
  if(!S.dados.restritos.length)h+='<p class="adm-suave">'+esc(FRASE.semRestritos)+'</p>';
  for(var i=0;i<S.dados.restritos.length;i++)h+=cartaoDoRestrito(S.dados.restritos[i]);
  h+='</div></section>';
  h+=secaoSemCredencial()+secaoDoHistorico();
  h+='<div id="adm-live" class="adm-so-leitor" role="status" aria-live="polite"></div>';
  S.c.innerHTML=h;
  ligar();
}

function focar(id){var el=$(id);if(el)el.focus()}

function ligar(){
  var caixas=S.c.querySelectorAll('input[data-adm-aba]');
  for(var i=0;i<caixas.length;i++){
    (function(cx){cx.addEventListener('change',function(){
      var u=cx.getAttribute('data-adm-de');
      var marcadas=[];
      var todas=S.c.querySelectorAll('input[data-adm-de="'+u+'"]');
      for(var k=0;k<todas.length;k++){if(todas[k].checked)marcadas.push(todas[k].getAttribute('data-adm-aba'))}
      S.edicao[u]=marcadas;
      delete S.erro[u];
      var bt=$('adm-salvar-'+u);
      if(bt)bt.disabled=!mudou(u);
    })})(caixas[i]);
  }
  var salvar=S.c.querySelectorAll('button[data-adm-salvar]');
  for(var j=0;j<salvar.length;j++){
    (function(bt){bt.addEventListener('click',function(){
      S.confirmando=bt.getAttribute('data-adm-salvar');
      desenhar();
      focar('adm-confirmar');
    })})(salvar[j]);
  }
  var conf=S.c.querySelector('button[data-adm-confirmar]');
  if(conf){
    var u=conf.getAttribute('data-adm-confirmar');
    conf.addEventListener('click',function(){gravar(u)});
    $('adm-cancelar').addEventListener('click',function(){cancelar(u)});
    var grupo=conf.parentNode;
    grupo.addEventListener('keydown',function(ev){if(ev.key==='Escape'){ev.stopPropagation();cancelar(u)}});
  }
}

function cancelar(u){
  S.confirmando=null;
  desenhar();
  focar('adm-salvar-'+u);
}

function gravar(u){
  var bt=$('adm-confirmar');
  if(bt)bt.disabled=true;
  api('/admin/api/administradores/'+encodeURIComponent(u)+'/abas',{method:'PUT',body:{abas:escolhidas(u),confirmado:true}}).then(function(d){
    S.dados=d;S.edicao={};S.confirmando=null;S.erro={};
    desenhar();
    anunciar(FRASE.salvo);
    focar('adm-t-'+u);
  },function(){
    S.confirmando=null;S.erro[u]=FRASE.naoSalvou;
    desenhar();
    focar('adm-salvar-'+u);
  });
}

function render(c){
  S.c=c;S.dados=null;S.edicao={};S.confirmando=null;S.erro={};S.msg='';
  desenhar();
  api('/admin/api/administradores').then(function(d){
    if(S.c!==c)return;
    S.dados=d;
    desenhar();
    focar('adm-titulo');
  },function(){S.msg=FRASE.falhou;desenhar()});
}

return {render:render};
})();
`;

export const ESTILOS_ADMINISTRADORES = `
.adm-h1{font-size:24px;margin:0 0 6px;outline:0}
.adm-h2{font-size:17px;margin:22px 0 10px}
.adm-intro{max-width:70ch;margin:0 0 6px}
.adm-suave{color:var(--tinta2);font-size:13.5px;margin:2px 0 8px}
.adm-grade{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:14px}
.adm-cartao{min-width:0;border:1px solid var(--linha);border-radius:12px;padding:14px 16px;background:var(--papel)}
.adm-nome{font-size:16px;margin:0 0 4px;overflow-wrap:anywhere;outline:0}
.adm-papel{display:inline-block;font-size:12px;font-weight:600;color:var(--tinta2);margin-left:4px}
.adm-fixo{margin:8px 0 0;font-weight:600}
.adm-abas{border:0;margin:6px 0 12px;padding:0;min-width:0}
.adm-abas legend{font-size:13px;color:var(--tinta2);padding:0;margin-bottom:6px}
.adm-aba{display:flex;align-items:center;gap:8px;min-height:32px;font-size:14px;cursor:pointer}
.adm-aba input{width:auto;margin:0}
.adm-confirma{border:1px solid var(--linha);border-radius:10px;padding:10px 12px;background:var(--papel2);margin-top:6px}
.adm-confirma p{margin:0 0 8px;overflow-wrap:anywhere}
.adm-erro{color:var(--erro);font-weight:600;margin:8px 0 0}
.adm-lista{margin:0;padding-left:18px}
.adm-mono{font-family:ui-monospace,monospace}
.adm-secao{min-width:0}
.adm-historico td,.adm-historico th{overflow-wrap:anywhere}
.adm-so-leitor{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
