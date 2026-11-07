/**
 * Login com Google (v0.67.0): o botão na tela de entrada e o cartão "Conta Google" em "Minha conta",
 * num arquivo só. `script.ts` não cresce: a tela de entrada ganhou um `<div id="c-google">` numa
 * linha que já existia e chama `__pvLoginGoogle.entrada(criar)`; "Minha conta" ganhou `<div
 * id="g-cartao">` e chama `__pvLoginGoogle.cartao()`.
 *
 * O que sustenta a tela (CLAUDE.md §8, "Login com Google"):
 * - **com o recurso desligado, nada aparece**: `GET /v1/sessoes/google` responde `disponivel: false`,
 *   e a resposta é guardada na página (uma pergunta por carga, como a do "esqueci a senha");
 * - **o clique só pede a URL ao servidor e navega**: nenhum token passa por aqui, e só se navega para
 *   `https://accounts.google.com/` — qualquer outra resposta é ignorada;
 * - **o retorno chega em `/?google=ok|conta-nova|ligada` ou `/?google=erro&motivo=…`**: lido UMA vez
 *   e apagado da barra na hora (`replaceState`, como o `?recuperar=`); o motivo é de lista fechada e
 *   **toda frase é FIXA aqui**, nunca texto do servidor ou do Google;
 * - desligar a conta Google pede confirmação e só é oferecido quando a conta tem senha (o servidor
 *   também recusa); conta sem senha vê como criar uma.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc; o
 * `console-script.spec.ts` roda o ESLint aqui dentro. Todo dado vem por `esc()`.
 */
export const SCRIPT_LOGIN_GOOGLE = String.raw`
(function(){
var disponivel=null;     /* null = ainda não perguntou ao servidor */
var retorno=null;        /* {ok, tipo|motivo} do retorno do Google, até a primeira tela que o mostra */

function pv(){return window.__pv}
function $(i){return document.getElementById(i)}
function esc(s){return pv().esc(s)}

var MOTIVOS={
  negado:'A entrada com o Google foi cancelada. Nada mudou.',
  estado_invalido:'O pedido venceu ou já foi usado. Clique de novo em “Entrar com Google”.',
  autorizacao_recusada:'O Google não aceitou a entrada. Tente de novo.',
  email_nao_verificado:'O Google não confirmou o e-mail dessa conta. Entre com e-mail e senha, ou use outra conta Google.',
  email_invalido:'O e-mail dessa conta Google não pôde ser usado. Entre com e-mail e senha.',
  conta_google_em_uso:'Essa conta Google já está ligada a outra conta do Processo Vivo.',
  sessao_diferente:'Para ligar a conta Google, entre primeiro na sua conta e clique em “Ligar conta Google” em Minha conta.',
  indisponivel:'Não foi possível falar com o Google agora. Tente de novo em instantes.'
};
var ICONE='<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">'+
  '<path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.8-6.8C35.7 2.5 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>'+
  '<path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.2 5.5-4.7 7.2l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.6z"/>'+
  '<path fill="#FBBC05" d="M10.5 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.1.8-4.6l-7.9-6.1C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.9-6.1z"/>'+
  '<path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>';

/* Lido e apagado da barra antes de qualquer coisa. */
try{
  var busca=new URLSearchParams(location.search);
  var r=busca.get('google');
  if(r==='ok'||r==='conta-nova'||r==='ligada')retorno={ok:true,tipo:r};
  else if(r==='erro')retorno={ok:false,motivo:busca.get('motivo')||''};
  if(r!==null){
    busca.delete('google');busca.delete('motivo');
    var resto=busca.toString();
    history.replaceState(null,'',location.pathname+(resto?'?'+resto:''));
  }
}catch(e){}

function perguntar(){
  if(disponivel!==null)return Promise.resolve(disponivel);
  return pv().api('/v1/sessoes/google').then(function(r){
    disponivel=r&&r.disponivel===true;return disponivel;
  }).catch(function(){disponivel=false;return false});
}

/* Pede a URL e navega. Só para o Google: resposta de outro formato é ignorada. */
function ir(caminho,botao,aviso){
  botao.disabled=true;
  pv().api(caminho,{method:'POST'}).then(function(r){
    if(r&&typeof r.url==='string'&&r.url.indexOf('https://accounts.google.com/')===0){location.assign(r.url);return}
    botao.disabled=false;
    aviso.innerHTML='<div class="nota" style="color:var(--erro)">'+MOTIVOS.indisponivel+'</div>';
  }).catch(function(){
    botao.disabled=false;
    aviso.innerHTML='<div class="nota" style="color:var(--erro)">'+MOTIVOS.indisponivel+'</div>';
  });
}

function fraseDoRetorno(){
  if(!retorno)return '';
  var r=retorno;retorno=null;
  if(r.ok)return '';
  return '<div class="nota lg-aviso" role="status" style="color:var(--erro)">'+esc(MOTIVOS[r.motivo]||MOTIVOS.indisponivel)+'</div>';
}

/* A tela de entrada: o botão nasce só depois de o servidor dizer que o login existe. */
function entrada(criar){
  var alvo=$('c-google');
  if(!alvo)return;
  perguntar().then(function(ok){
    alvo=$('c-google');
    if(!alvo||!ok)return;
    alvo.innerHTML='<div class="lg-ou"><span>ou</span></div>'+
      '<button type="button" class="lg-bt" id="c-google-bt">'+ICONE+'<span>'+
      (criar?'Criar conta com Google':'Entrar com Google')+'</span></button>'+
      '<div id="c-google-aviso">'+fraseDoRetorno()+'</div>'+
      (criar?'<div class="nota lg-nota">Usamos só o seu nome e o seu e-mail da conta Google. Nada mais.</div>':'');
    $('c-google-bt').addEventListener('click',function(){
      ir('/v1/sessoes/google',$('c-google-bt'),$('c-google-aviso'));
    });
  });
}

/* O cartão em "Minha conta". */
function cartao(){
  var alvo=$('g-cartao');
  if(!alvo)return;
  pv().api('/v1/eu/google').then(function(s){
    alvo=$('g-cartao');
    if(!alvo||!s||s.disponivel!==true)return;
    var ligada=s.ligada===true;
    var h='<div class="cartao"><h3 class="sec">Conta Google</h3>';
    var aviso='';
    if(retorno&&retorno.ok&&retorno.tipo==='ligada'){retorno=null;aviso='<div class="nota" style="color:var(--ok)" role="status">Conta Google ligada.</div>'}
    else aviso=fraseDoRetorno();
    if(ligada){
      h+='<div class="nota">Você pode entrar com o botão “Entrar com Google”'+
        (s.ligadaEm?' (ligada em '+esc(pv().dt(s.ligadaEm))+')':'')+'.</div>';
      if(s.temSenha===true){
        h+='<div style="margin-top:12px"><button class="bt bt2" id="g-desligar">Desligar a conta Google</button></div>';
      }else{
        h+='<div class="nota" style="margin-top:8px">Esta conta ainda não tem senha. Para também entrar por senha, '+
          'use “Esqueceu a senha?” na tela de entrada: o link chega no seu e-mail.</div>';
      }
    }else{
      h+='<div class="nota">Ligue a sua conta Google para entrar com um clique. Usamos só o seu nome e o seu e-mail; nada mais é lido.</div>'+
        '<div style="margin-top:12px"><button type="button" class="lg-bt" id="g-ligar">'+ICONE+'<span>Ligar conta Google</span></button></div>';
    }
    h+='<div id="g-aviso">'+aviso+'</div></div>';
    alvo.innerHTML=h;
    if($('g-ligar'))$('g-ligar').addEventListener('click',function(){ir('/v1/eu/google',$('g-ligar'),$('g-aviso'))});
    if($('g-desligar'))$('g-desligar').addEventListener('click',function(){
      if(!confirm('Desligar a conta Google? Você continua entrando com e-mail e senha.'))return;
      $('g-desligar').disabled=true;
      pv().api('/v1/eu/google',{method:'DELETE'}).then(function(){cartao()}).catch(function(e){
        $('g-desligar').disabled=false;
        var m=e&&e.detalhes&&e.detalhes.motivo;
        $('g-aviso').innerHTML='<div class="nota" style="color:var(--erro)">'+
          (m==='conta_sem_senha'?'Crie uma senha antes de desligar a conta Google.':'Não foi possível desligar agora. Tente de novo.')+'</div>';
      });
    });
  }).catch(function(){});
}

window.__pvLoginGoogle={entrada:entrada,cartao:cartao};
})();
`;

export const ESTILOS_LOGIN_GOOGLE = `
.lg-ou{display:flex;align-items:center;gap:12px;margin:18px 0 12px;color:var(--tinta2);font-size:13px}
.lg-ou::before,.lg-ou::after{content:"";flex:1;height:1px;background:var(--linha)}
.lg-bt{display:inline-flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:46px;
  padding:0 16px;border:1px solid var(--linha);border-radius:10px;background:var(--papel);color:var(--tinta);
  font:inherit;font-weight:600;font-size:14.5px;cursor:pointer}
.lg-bt:hover{background:var(--papel2)}
.lg-bt:focus-visible{outline:2px solid var(--acento);outline-offset:2px}
.lg-bt:disabled{opacity:.6;cursor:default}
.cartao .lg-bt{width:auto}
.lg-aviso{margin-top:10px}
.lg-nota{margin-top:10px;text-align:center;color:var(--tinta2)}
.lg-aviso{color:var(--erro)}
`;
