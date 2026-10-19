/**
 * O plano escolhido no site de vendas atravessa o cadastro e o login (v0.45.0).
 *
 * O site manda a pessoa para a RAIZ do app: `/?plano=<slug>`, com `&assinar=1` no "Assinar agora" e
 * `&conta=1` para abrir direto o cadastro. O console é uma página só e cadastro e login são `fetch` sem
 * navegação, então o que sobrevive a esse passo é este arquivo — sem criar rota nem caminho paralelo.
 *
 * Regras que o sustentam (CLAUDE.md §8, "Plano escolhido no site"):
 * - **O parâmetro é lido UMA vez e sai da barra de endereço na hora** (`replaceState`, como o
 *   `?recuperar=`): não fica no histórico, no favorito nem no `Referer`.
 * - **Só um slug no formato do catálogo é guardado** (`^[a-z][a-z0-9-]{1,29}$`, até 30 caracteres).
 *   URL, caminho, script ou texto livre são ignorados em silêncio e o fluxo segue como se não houvesse
 *   plano. O plano nunca é destino: a única tela a que ele leva é a de confirmação do próprio app.
 * - **`sessionStorage`, por 30 minutos, com variável em memória de reserva.** Do lado do servidor não
 *   daria: antes do login não há sessão nem workspace, e guardar exigiria um cookie e uma tabela
 *   pré-autenticação (superfície nova numa rota pública). Nunca `localStorage`: o plano escolhido não
 *   pode sobreviver à aba nem ao dia.
 * - **A conferência é contra o catálogo, depois de entrar** (`GET /v1/planos`, pública): o slug tem de
 *   ser de um plano à venda, existente e ASSINÁVEL (com preço). Qualquer outro caso descarta o plano.
 * - **`assinar=1` só vale junto de um plano válido e com o pagamento ligado, e NUNCA cobra sozinho**:
 *   abre a tela de confirmação (`window.__pvPagamento.preparar`), onde a cobrança depende do aceite dos
 *   Termos e do clique em "Continuar para o pagamento". Sem `assinar`, o plano só é DESTACADO ("Plano
 *   escolhido") no cartão de assinatura da conta; a pessoa entra no teste de 14 dias como sempre.
 * - Conta de chave de API (sem "Minha conta") descarta o plano: não assina online.
 *
 * Mesmo regime de `script.ts`: JavaScript dentro de uma string, invisível ao tsc; o
 * `console-script.spec.ts` roda o ESLint aqui dentro.
 */
export const SCRIPT_PLANO_ESCOLHIDO = String.raw`
(function(){
var CHAVE='processovivo.plano-escolhido';
var VALIDADE_MS=30*60*1000;
var FORMATO=/^[a-z][a-z0-9-]{1,29}$/;
var memoria=null;
var abrirCadastro=false;
var tratando=false;

function ler(){
  var o=memoria;
  try{
    var bruto=sessionStorage.getItem(CHAVE);
    if(bruto)o=JSON.parse(bruto);
  }catch(e){}
  if(!o||typeof o.plano!=='string'||!FORMATO.test(o.plano)||typeof o.ate!=='number'||o.ate<Date.now())return null;
  return {plano:o.plano,assinar:o.assinar===true,ate:o.ate};
}
function gravar(o){
  memoria=o;
  try{sessionStorage.setItem(CHAVE,JSON.stringify(o))}catch(e){}
}
function limpar(){
  memoria=null;
  try{sessionStorage.removeItem(CHAVE)}catch(e){}
}

/* Lido e apagado da barra antes de qualquer coisa. Os três parâmetros saem, valham ou não. */
try{
  var busca=new URLSearchParams(location.search);
  if(busca.has('plano')||busca.has('assinar')||busca.has('conta')){
    var p=busca.get('plano');
    if(p!==null&&p.length<=30&&FORMATO.test(p)){
      gravar({plano:p,assinar:busca.get('assinar')==='1',ate:Date.now()+VALIDADE_MS});
    }
    if(busca.get('conta')==='1')abrirCadastro=true;
    busca.delete('plano');busca.delete('assinar');busca.delete('conta');
    var resto=busca.toString();
    history.replaceState(null,'',location.pathname+(resto?'?'+resto:''));
  }
}catch(e){}

/* O modo da tela de entrada: "criar" uma vez, se o site pediu o cadastro; senão o padrão do console. */
function modoInicial(){
  if(!abrirCadastro)return '';
  abrirCadastro=false;
  return 'criar';
}

function tratar(){
  var o=ler();
  if(!o||tratando)return;
  var nav=document.getElementById('nav-conta');
  /* Sem "Minha conta" (chave de API) não há assinatura online: o plano não se aplica. */
  if(!nav||nav.classList.contains('oculto')){limpar();return}
  tratando=true;
  window.__pv.api('/v1/planos').then(function(r){
    var achado=null;
    var lista=(r&&r.planos)||[];
    for(var i=0;i<lista.length;i++){
      if(lista[i].slug===o.plano&&lista[i].assinavel===true)achado=lista[i];
    }
    /* Pagamento desligado, plano fora de venda ou sem preço: cai no teste grátis, sem avisar nada. */
    if(!achado||!r||r.pagamentoDisponivel!==true||!window.__pvPagamento)return;
    window.__pvPagamento.preparar(achado.slug,o.assinar);
    if(o.assinar&&window.__processovivo_ir)window.__processovivo_ir('conta');
  }).catch(function(){}).then(function(){
    limpar();
    tratando=false;
  });
}

var aoIniciarAnterior=window.__pvAoIniciar;
window.__pvAoIniciar=function(){
  if(aoIniciarAnterior)aoIniciarAnterior();
  tratar();
};

window.__pvPlano={modoInicial:modoInicial};
})();
`;
