/**
 * Histórico de PEÇAS BAIXADAS dentro da Pasta digital (v0.37.0).
 *
 * Saiu da página inicial (coluna "Peças baixadas") para cá: é um registro POR
 * PROCESSO, e só faz sentido com o processo aberto. Arquivo próprio porque
 * `scriptPasta.ts` já passa de 1.300 linhas e não cresce por causa disto.
 *
 * O que a gaveta mostra e o que NÃO é:
 * - é o registro dos downloads avulsos feitos pela linha do tempo do processo
 *   (`pecas_baixadas`: metadado — rótulo, tamanho, data e hora). O ARQUIVO nunca
 *   fica guardado nessa tabela, e a gaveta diz isso;
 * - o estado de cada peça da Pasta ("em guarda", "não baixada"…) continua sendo da
 *   lista da Pasta e não é repetido aqui;
 * - lê só do nosso servidor (`GET /v1/pecas-baixadas?numero=`, isolado por
 *   workspace e por processo): não consulta o tribunal e não oferece "baixar de
 *   novo", porque isso custaria outra consulta com a senha do advogado.
 *
 * Fala com a Pasta por `window.__pvPastaBaixadas` (exposto aqui). Mesmo regime dos
 * outros scripts: JavaScript dentro de uma string, lido pelo ESLint em
 * `tests/http/console-script.spec.ts`. Todo texto vindo do servidor passa por `esc()`.
 */
export const SCRIPT_PASTA_BAIXADAS = String.raw`
(function(){
/* O servidor devolve no máximo isto; se vier cheio, a gaveta diz que há mais. */
var LIMITE=200;
var carga=0;

function pv(){return window.__pv}

/* "há N dias" desde o download; hoje e ontem por extenso, igual ao resto do console. */
function quando(iso){
  var h=pv().humano(iso);
  return h||'';
}

function itemHtml(p){
  var p_=pv();
  return '<li class="pbx-item"><div class="pbx-rotulo">'+p_.esc(p.rotulo)+'</div>'+
    '<div class="pbx-det"><span>'+p_.esc(p_.tamanho(p.bytes))+'</span>'+
    '<span>'+p_.esc(p_.dth(p.baixadaEm))+'</span>'+
    '<span>'+p_.esc(quando(p.baixadaEm))+'</span></div></li>';
}

function desenhar(sec,r){
  var lista=r.pecas||[];
  var h='<div class="pbx-nota">Registro dos downloads avulsos que você fez <strong>deste processo</strong> '+
    'pela linha do tempo. O arquivo não fica guardado aqui — é só o histórico do que já foi puxado do '+
    'tribunal. O estado de cada peça da pasta está na lista ao lado.</div>';
  if(!lista.length){
    h+='<div class="pbx-vazio">Nenhuma peça baixada deste processo ainda.</div>';
  }else{
    h+='<div class="pbx-conta" aria-live="polite">'+
      (lista.length>=LIMITE?'Mostrando as '+lista.length+' mais recentes.':
        lista.length+(lista.length===1?' peça baixada':' peças baixadas')+'.')+'</div>'+
      '<ul class="pbx-lista">'+lista.map(itemHtml).join('')+'</ul>';
  }
  sec.innerHTML=h;
}

function erro(sec,e,tentar){
  sec.innerHTML='<div class="pbx-vazio"><strong>Não consegui carregar o histórico.</strong> '+
    pv().esc(pv().explicar(e))+
    ' <button type="button" class="bt bt2" id="pasta-baixadas-tentar">Tentar de novo</button></div>';
  var b=document.getElementById('pasta-baixadas-tentar');
  if(b)b.addEventListener('click',tentar);
}

function carregar(numero,sec){
  var minha=++carga;
  sec.innerHTML='<div class="pbx-vazio"><span class="gira"></span>Carregando o histórico…</div>';
  pv().api('/v1/pecas-baixadas?numero='+encodeURIComponent(numero)+'&limite='+LIMITE).then(function(r){
    if(minha!==carga)return;
    desenhar(sec,r);
  }).catch(function(e){
    if(minha!==carga)return;
    erro(sec,e,function(){carregar(numero,sec)});
  });
}

/* Abre ou fecha a gaveta. Sempre relê o servidor ao abrir: o histórico muda sempre
   que a pessoa baixa uma peça na tela do processo. */
function alternar(numero,botao,sec){
  var abrir=sec.hasAttribute('hidden');
  if(abrir){
    sec.removeAttribute('hidden');
    botao.setAttribute('aria-expanded','true');
    carregar(numero,sec);
  }else{
    fechar(botao,sec);
  }
}
function fechar(botao,sec){
  carga++;
  sec.setAttribute('hidden','');
  sec.innerHTML='';
  if(botao)botao.setAttribute('aria-expanded','false');
}

window.__pvPastaBaixadas={alternar:alternar,fechar:fechar};
})();
`;
