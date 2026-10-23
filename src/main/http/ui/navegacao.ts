/**
 * Navegação por HASH do console (v0.57.0): o Voltar/Avançar do navegador e o F5 passam a funcionar DENTRO do
 * sistema. Até a 0.56.x as telas se trocavam só por variável (`estado.aba`/`estado.detalhe`) e não criavam
 * entrada no histórico: o Voltar saía do app para o site anterior e o F5 voltava à tela inicial.
 *
 * O que sustenta o módulo (CLAUDE.md §8, "Navegação por hash"):
 * - **Sem rota nova no servidor**: a parte depois do `#` nunca chega ao servidor. `history.pushState`,
 *   `replaceState` e `popstate`, nada mais;
 * - **Nenhum dado pessoal na URL.** O número CNJ NUNCA vai para o endereço (nem para o histórico, favorito, `Referer`
 *   ou título da aba): o processo é um **identificador opaco** (`token`), calculado neste navegador a partir de um sal
 *   aleatório que só ele conhece. O mesmo processo dá o mesmo token neste navegador (F5, favorito e outra aba
 *   funcionam), e quem vê o endereço não recupera o número. Parte, CPF e nome também nunca entram. O `id` da peça é o
 *   identificador interno do tribunal (já é o que a API usa), sem dado pessoal;
 * - **Telas = estados de histórico**: as abas, o detalhe do processo, a Pasta digital e a peça aberta no visualizador.
 *   Painéis (resumo, análise de peça, custos do processo) NÃO criam entrada: fechar painel não gasta um "Voltar";
 * - **Troca de peça dentro do visualizador SUBSTITUI a entrada** (replaceState): o "Voltar" da peça leva à lista, não à
 *   peça anterior;
 * - **Restaurar não consulta o tribunal**: abrir um link de peça só abre a peça se ela já está disponível; peça que
 *   precisaria ser pedida ao tribunal fica na lista (o "sem pré-busca" da Pasta continua valendo);
 * - **Login e logout usam replaceState**: o login não é uma entrada, e sair troca a entrada por `#/entrar`. Voltar
 *   depois de sair mostra a entrada, nunca o app; link para tela interna estando deslogado é guardado e atendido
 *   depois do login;
 * - **Botões "Fechar"/"Voltar" do app usam o mesmo mecanismo**: voltam um passo quando a origem é do app (cada entrada
 *   guarda a trilha das anteriores em `history.state`) e vão à tela pai quando a pessoa chegou por link direto;
 * - identificador inválido, de outra conta ou que não existe mais = tela de aviso neutra (a API é quem decide o que a
 *   conta enxerga; nada de outra conta chega à tela);
 * - ao navegar o foco vai para o título da tela e `document.title` muda (sem número de processo: o título aparece no
 *   histórico do navegador).
 *
 * Fala com o console por `window.__pv` (`detalhe`, `logado`) e `window.__processovivo_ir/_abrir`, e com a Pasta por
 * `window.__pvPasta`. O console chama de volta `aba`, `processo`, `inicial`, `voltarDoProcesso` e `sair`; a Pasta chama
 * `pasta`, `peca`, `fecharPasta` e `voltarDaPeca`. Tudo é opcional dos dois lados: sem este módulo o console é o de antes.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc; `tests/http/console-script.spec.ts`
 * roda o ESLint aqui dentro.
 */
export const SCRIPT_NAVEGACAO = String.raw`
(function(){
var BASE_TITULO=document.title||'Processo Vivo';
var ABAS={novidades:'atualizacoes',processos:'processos',calendario:'calendario',custos:'custos',buscar:'buscar',
  vigilancia:'vigilancia',credenciais:'acessos',conta:'conta'};
var ABA_DA_ROTA={};
Object.keys(ABAS).forEach(function(k){ABA_DA_ROTA[ABAS[k]]=k});
var TITULOS={novidades:'Atualizações',processos:'Meus processos',calendario:'Calendário',custos:'Custos',
  buscar:'Buscar',vigilancia:'Vigilância',credenciais:'Meus acessos',conta:'Minha conta'};
var CHAVE_SAL='processovivo.nav',CHAVE_MAPA='processovivo.nav.processos';
var aplicando=0,sal='',memoria={};

function pv(){return window.__pv}
function pasta(){return window.__pvPasta}
function digitos(n){return String(n||'').replace(/\D/g,'')}
function logado(){return !!(pv()&&pv().logado&&pv().logado())}

/* ---------- identificador opaco do processo ---------- */
function salDoNavegador(){
  if(sal)return sal;
  var s='';
  try{s=localStorage.getItem(CHAVE_SAL)||''}catch(e){}
  if(!/^[0-9a-f]{24}$/.test(s)){
    var b=new Uint8Array(12),i;
    try{crypto.getRandomValues(b)}catch(e){for(i=0;i<b.length;i++)b[i]=Math.floor(Math.random()*256)}
    s='';for(i=0;i<b.length;i++)s+=('0'+b[i].toString(16)).slice(-2);
    try{localStorage.setItem(CHAVE_SAL,s)}catch(e){}
  }
  sal=s;return s;
}
/* Mistura de 32 bits (cyrb53): síncrona e sem dependência. Opaca porque o sal é secreto, não por ser criptográfica. */
function mistura(texto,semente){
  var h1=0xdeadbeef^semente,h2=0x41c6ce57^semente;
  for(var i=0;i<texto.length;i++){
    var c=texto.charCodeAt(i);
    h1=Math.imul(h1^c,2654435761);h2=Math.imul(h2^c,1597334677);
  }
  h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);
  h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);
  return [h1>>>0,h2>>>0];
}
function tokenDe(numero){
  var t=salDoNavegador()+':'+digitos(numero);
  var a=mistura(t,1),b=mistura(t,2);
  return (a[0].toString(36)+a[1].toString(36)+b[0].toString(36)).slice(0,14);
}
/* O mapa token→número vive só na ABA (sessionStorage) e só para o que esta aba abriu — inclusive o processo avulso, que
   não está na carteira. Apagado ao sair. Nunca vai à URL, ao servidor ou ao localStorage. */
function lerMapa(){
  try{var m=JSON.parse(sessionStorage.getItem(CHAVE_MAPA)||'{}');return m&&typeof m==='object'?m:{}}
  catch(e){return memoria}
}
function guardarNoMapa(tok,numero){
  var m=lerMapa();m[tok]=digitos(numero);
  try{sessionStorage.setItem(CHAVE_MAPA,JSON.stringify(m))}catch(e){memoria=m}
}
function resolver(tok){
  var viu=lerMapa()[tok];
  if(viu)return Promise.resolve(viu);
  /* Link aberto num navegador/aba novo: a carteira da PRÓPRIA conta diz de quem é o token. */
  return pv().api('/v1/acompanhamentos').then(function(r){
    var lista=(r&&r.acompanhamentos)||[];
    for(var i=0;i<lista.length;i++){
      var n=digitos(lista[i].numero);
      if(n&&tokenDe(n)===tok){guardarNoMapa(tok,n);return n}
    }
    return null;
  }).catch(function(){return null});
}

/* ---------- rotas ---------- */
function rotaDoProcesso(tok){return '#/processo/'+tok}
function ler(hash){
  var p=String(hash||'').replace(/^#\/?/,'').split('/').filter(Boolean);
  if(!p.length||(p.length===1&&p[0]==='entrar'))return {tipo:'inicio'};
  if(p.length===1&&ABA_DA_ROTA[p[0]])return {tipo:'aba',aba:ABA_DA_ROTA[p[0]]};
  if(p[0]==='processo'&&p[1]&&/^[a-z0-9]{6,20}$/.test(p[1])){
    if(p.length===2)return {tipo:'processo',tok:p[1]};
    if(p.length===3&&p[2]==='pasta')return {tipo:'pasta',tok:p[1]};
    if(p.length===5&&p[2]==='pasta'&&p[3]==='peca'&&/^[A-Za-z0-9_-]{1,80}$/.test(p[4]))
      return {tipo:'peca',tok:p[1],peca:p[4]};
  }
  return {tipo:'invalida'};
}
function atual(){return ler(location.hash)}
function estadoDoHistorico(){
  var s=history.state;
  return s&&s.pv===1&&Array.isArray(s.p)?s:{pv:1,p:[]};
}
function tituloDe(r){
  var t=r.tipo==='aba'?TITULOS[r.aba]:r.tipo==='processo'?'Processo':r.tipo==='pasta'?'Pasta digital':
    r.tipo==='peca'?'Peça':r.tipo==='invalida'?'Página não encontrada':TITULOS.novidades;
  document.title=t+' · '+BASE_TITULO;
}

/* ---------- foco no título da tela ---------- */
var foco=0;
function alvoDoFoco(r){
  if(r.tipo==='pasta'||r.tipo==='peca')return document.getElementById('pasta-titulo-geral');
  var c=document.getElementById('conteudo');
  if(!c)return null;
  if(r.tipo==='processo'){
    /* A tela do processo não tem título: o número na capa faz esse papel (role=heading e tabindex vêm no próprio markup). */
    return c.querySelector('.capa .num');
  }
  return c.querySelector('h1,h2');
}
/* O foco só vai ao título se a pessoa não foi a outro lugar nesse meio tempo: corpo da página, controle que já saiu da
   tela ou o menu lateral (de onde ela navegou). Controle da própria tela, em uso, não é tomado. */
function livre(r){
  if(r.tipo==='pasta')return true;
  var a=document.activeElement;
  if(!a||a===document.body||!a.isConnected)return true;
  var lat=document.getElementById('lateral');
  return !!(lat&&lat.contains(a));
}
function poe(el){
  if(!el.hasAttribute('tabindex'))el.setAttribute('tabindex','-1');
  try{el.focus({preventScroll:true})}catch(e){el.focus()}
}
/* A tela do processo é redesenhada quando a régua do tribunal chega, e o redesenho derruba o foco. Por alguns segundos,
   se o foco caiu no corpo da página (a pessoa não foi a lugar nenhum), ele volta ao título novo. Para ao primeiro
   toque ou tecla da pessoa: nunca disputa o foco com ela. */
function vigiar(r,vez){
  var c=document.getElementById('conteudo');
  /* Só a tela do processo: as outras não se redesenham sozinhas depois de abertas. */
  if(!c||r.tipo!=='processo'||typeof MutationObserver==='undefined')return;
  var obs=new MutationObserver(function(){
    if(vez!==foco){obs.disconnect();return}
    var ativo=document.activeElement;
    if(ativo&&ativo!==document.body&&c.contains(ativo))return;
    if(ativo&&ativo!==document.body&&!c.contains(ativo)&&ativo.id!=='')return;
    var el=alvoDoFoco(r);if(el&&livre(r))poe(el);
  });
  obs.observe(c,{childList:true,subtree:true});
  var para=function(){
    obs.disconnect();
    ['keydown','pointerdown','focusin'].forEach(function(t){document.removeEventListener(t,sai,true)});
  };
  /* Qualquer foco que NÃO seja o do próprio título encerra a vigília: a pessoa (ou a tela) já foi a outro lugar. */
  var sai=function(ev){if(ev.type==='focusin'&&ev.target&&ev.target.getAttribute&&ev.target.getAttribute('role')==='heading')return;para()};
  ['keydown','pointerdown','focusin'].forEach(function(t){document.addEventListener(t,sai,true)});
  setTimeout(para,3000);
}
function focarTitulo(r){
  /* Abrir e trocar de peça acontece DENTRO da Pasta, a partir da lista: o foco fica onde a pessoa está (o item da lista). */
  if(r.tipo==='peca')return;
  var vez=++foco,tentativas=0;
  /* A primeira tentativa espera a tela trocar: o gancho roda ANTES do desenho, e o título da tela anterior ainda está lá. */
  setTimeout(function tenta(){
    if(vez!==foco)return;
    var el=alvoDoFoco(r);
    if(el){
      if(livre(r))poe(el);
      vigiar(r,vez);
      return;
    }
    if(++tentativas>=40){
      var c=document.getElementById('conteudo');
      if(c&&r.tipo!=='pasta'&&r.tipo!=='peca'){c.setAttribute('tabindex','-1');try{c.focus({preventScroll:true})}catch(e){c.focus()}}
      return;
    }
    setTimeout(tenta,100);
  },30);
}

/* ---------- história ---------- */
function semHistorico(fn){aplicando++;try{fn()}finally{aplicando--}}
function empurrar(rota){
  if(aplicando||location.hash===rota)return false;
  var s=estadoDoHistorico();
  var p=s.p.concat([location.hash||'#/']).slice(-40);
  try{history.pushState({pv:1,p:p},'',rota)}catch(e){return false}
  var r=ler(rota);tituloDe(r);focarTitulo(r);return true;
}
function substituir(rota){
  if(location.hash===rota)return;
  try{history.replaceState({pv:1,p:estadoDoHistorico().p},'',rota)}catch(e){}
  tituloDe(ler(rota));
}
/* Vai ao pai: se ele está na trilha, volta direto até ele; senão (link direto) troca a entrada por ele. */
function irAoPai(pai,qualquerOrigem,quando){
  var p=estadoDoHistorico().p,i;
  if(pai){
    for(i=p.length-1;i>=0;i--)if(p[i]===pai)break;
    if(i>=0){history.go(-(p.length-i));return}
  }else if(qualquerOrigem&&p.length){history.back();return}
  var destino=pai||quando;
  substituir(destino);
  var r=ler(destino);aplicar(r,true);
}

/* ---------- aplicar uma rota ao console ---------- */
function aviso(){
  var c=document.getElementById('conteudo');if(!c)return;
  c.classList.remove('env-larga');
  c.innerHTML='<div class="cartao vazio"><div class="ic">🔎</div><h2>Não encontramos esta página</h2>'+
    '<p>O endereço não existe nesta conta ou já não está disponível. Volte para a lista de processos.</p>'+
    '<button class="bt" id="nav-aviso-lista">Ver meus processos</button></div>';
  var b=document.getElementById('nav-aviso-lista');
  if(b)b.addEventListener('click',function(){window.__processovivo_ir('processos')});
}
function aplicar(r,comFoco){
  if(!logado())return;
  tituloDe(r);
  var fim=function(){if(comFoco)focarTitulo(r)};
  if(r.tipo==='inicio'||r.tipo==='aba'){
    semHistorico(function(){window.__processovivo_ir(r.tipo==='aba'?r.aba:'novidades')});
    fim();return;
  }
  if(r.tipo==='invalida'){
    semHistorico(function(){if(pasta())pasta().fechar();aviso()});
    fim();return;
  }
  resolver(r.tok).then(function(numero){
    if(!logado())return;
    if(!numero){semHistorico(function(){if(pasta())pasta().fechar();aviso()});fim();return}
    semHistorico(function(){
      var ps=pasta(),ja=pv().detalhe&&digitos(pv().detalhe())===numero;
      /* Voltar da peça para a lista da Pasta já aberta devolve o foco ao item (feito pela Pasta), não ao título. */
      if(r.tipo==='pasta'&&ps&&ps.aberta())comFoco=false;
      if(r.tipo==='processo'){
        if(ja){if(ps&&ps.aberta())ps.fechar()}
        else window.__processovivo_abrir(numero);
        return;
      }
      /* Pasta e peça: com a tela do processo já desenhada, abre direto; senão pede a abertura e desenha o processo. */
      if(r.tipo==='peca'&&ps)ps.pedirPeca(r.peca);
      if(ja&&ps&&ps.abrir()){if(r.tipo==='pasta')ps.mostrarLista();return}
      if(ps)ps.pedirAbertura(numero);
      window.__processovivo_abrir(numero);
    });
    fim();
  });
}
window.addEventListener('popstate',function(){
  if(!logado()){substituir('#/entrar');return}
  aplicar(atual(),true);
});

/* ---------- o que o console e a Pasta chamam ---------- */
window.__pvNav={
  aba:function(aba){if(ABAS[aba])empurrar('#/'+ABAS[aba])},
  processo:function(numero){
    var tok=tokenDe(numero);guardarNoMapa(tok,numero);
    var r=atual();
    if(r.tok===tok&&(r.tipo==='processo'||r.tipo==='pasta'||r.tipo==='peca'))return;
    empurrar(rotaDoProcesso(tok));
  },
  pasta:function(numero){
    var tok=tokenDe(numero),r=atual();
    if(r.tok===tok&&(r.tipo==='pasta'||r.tipo==='peca'))return;
    empurrar(rotaDoProcesso(tok)+'/pasta');
  },
  peca:function(id){
    var r=atual();if(!r.tok||(r.tipo!=='pasta'&&r.tipo!=='peca'))return;
    if(!/^[A-Za-z0-9_-]{1,80}$/.test(String(id)))return;
    var rota=rotaDoProcesso(r.tok)+'/pasta/peca/'+id;
    if(r.tipo==='peca'){if(!aplicando)substituir(rota)}
    else empurrar(rota);
  },
  /* Peça pedida pela URL que não pôde ser aberta sem consultar o tribunal: a rota volta a ser a da lista. */
  pecaNaoAberta:function(){var r=atual();if(r.tipo==='peca')substituir(rotaDoProcesso(r.tok)+'/pasta')},
  /* "Fechar a pasta": de volta à tela do processo. */
  fecharPasta:function(){
    var r=atual();
    if(!r.tok||(r.tipo!=='pasta'&&r.tipo!=='peca'))return false;
    irAoPai(rotaDoProcesso(r.tok),false,rotaDoProcesso(r.tok));return true;
  },
  /* "← lista de peças" e Esc no visualizador: de volta à lista da Pasta. */
  voltarDaPeca:function(){
    var r=atual();
    if(r.tipo!=='peca')return false;
    irAoPai(rotaDoProcesso(r.tok)+'/pasta',false,rotaDoProcesso(r.tok)+'/pasta');return true;
  },
  /* "← voltar" da tela do processo: um passo atrás quando a origem é do app; senão, a lista de processos. */
  voltarDoProcesso:function(){
    var r=atual();
    if(r.tipo!=='processo'&&r.tipo!=='pasta'&&r.tipo!=='peca')return false;
    irAoPai('',true,'#/processos');return true;
  },
  /* Chamado pelo console quando a sessão abre (login ou página nova): atende o endereço pedido. */
  inicial:function(){
    var r=atual();
    if(r.tipo==='inicio'){substituir('#/'+ABAS.novidades);aplicar({tipo:'aba',aba:'novidades'},false);return true}
    aplicar(r,false);return true;
  },
  /* Sair: apaga o mapa da aba e troca a entrada por "entrar". Voltar depois disso nunca mostra o app. */
  sair:function(){
    try{sessionStorage.removeItem(CHAVE_MAPA)}catch(e){}
    memoria={};
    try{history.replaceState({pv:1,p:[]},'','#/entrar')}catch(e){}
    document.title='Entrar · '+BASE_TITULO;
  },
  token:tokenDe,
  rotaAtual:function(){return location.hash}
};
document.title=(function(){var r=ler(location.hash);return (r.tipo==='inicio'?'Entrar':r.tipo==='aba'?TITULOS[r.aba]:r.tipo==='processo'?'Processo':
  r.tipo==='pasta'?'Pasta digital':r.tipo==='peca'?'Peça':'Página não encontrada')+' · '+BASE_TITULO})();
})();
`;
