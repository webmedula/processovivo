/**
 * Os tokens do tema escuro, uma vez só: valem tanto pelo sistema do advogado
 * (automático) quanto pela escolha manual na lateral.
 */
const ESCURO = `
    --fundo:#0b1220; --papel:#111b2e; --papel2:#16223a; --barra:#111b2e;
    --linha:#223049; --linha2:#1b2740;
    --tinta:#e8eef7; --tinta2:#a7b4c8; --tinta3:#8391a8;
    --acento:#8ab4ff; --acento-bg:#15264a;
    --botao:#3a6bc4; --botao-hover:#4a7bd4;
    --novo:#8ab4ff; --novo-bg:#15264a;
    --verde:#00c853; --verde-tinta:#3fe08c; --verde-bg:#0e2a1c;
    --atencao:#f5b94a; --atencao-bg:#332508; --atencao-ponto:#f5b94a;
    --marco:#e0ac5a; --marco-bg:#2e2415;
    --erro:#ff8a80; --erro-bg:#3a1614;
    --neutro-bg:#1b2840;
    --lateral:#070e1a; --lateral-linha:#17233a; --lateral-tinta:#a7b4c8;
    --lateral-ativo:#16284a; --lateral-apagado:#6b7a92;
    --sombra:none;
`;

/** CSS do console. Arquivo separado só para o HTML e o script ficarem legíveis. */
export const ESTILOS = `
/* ---------- fontes ---------- */
/* Servidas pelo próprio servidor (rotas/interface.ts), nunca por CDN: o
   console precisa abrir atrás do firewall de um fórum. "swap" mostra o texto
   na fonte do sistema enquanto a nossa chega — tela em branco esperando fonte
   é pior do que um piscar de tipografia. */
@font-face{font-family:"Plus Jakarta Sans";font-style:normal;font-weight:200 800;
  font-display:swap;src:url(/ui/fontes/plus-jakarta-sans.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;
  font-display:swap;src:url(/ui/fontes/jetbrains-mono-500.woff2) format("woff2")}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:600;
  font-display:swap;src:url(/ui/fontes/jetbrains-mono-600.woff2) format("woff2")}

/* ---------- cores ---------- */
/* Saem do logo (v0.29.0): azul-marinho do documento, verde do ✓.
   Cada cor de estado tem UM significado, e é isso que deixa a tela ser lida de
   longe:
     verde   — verificado, em dia (o que o ✓ do logo promete);
     azul    — novidade;
     âmbar   — pede providência;
     vermelho— erro, sigilo, verificação que falhou.
   O verde do logo (#00C853) é claro demais para TEXTO sobre branco (contraste
   ~2:1): ele entra em ponto, traço e fundo; o texto verde usa --verde-tinta. */
:root{
  color-scheme:light dark;
  --fonte:"Plus Jakarta Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --fundo:#f4f6f9; --papel:#fff; --papel2:#f8fafc; --barra:#fff;
  --linha:#e3e8ef; --linha2:#edf0f4;
  --tinta:#0b192c; --tinta2:#475569; --tinta3:#64748b;
  --acento:#1f4e9e; --acento-bg:#eaf0fa;
  --botao:#163057; --botao-hover:#0b192c;
  --novo:#1d4ed8; --novo-bg:#eaf1fe;
  --verde:#00c853; --verde-tinta:#067a3c; --verde-bg:#e8f8ef;
  --atencao:#9a5800; --atencao-bg:#fff3dc; --atencao-ponto:#f59e0b;
  --marco:#8a5a00; --marco-bg:#fdf3e0;
  --erro:#b42318; --erro-bg:#feeceb;
  --neutro-bg:#eef1f5;
  --lateral:#0b192c; --lateral-linha:#1c2c45; --lateral-tinta:#b8c4d6;
  --lateral-ativo:#1a2f52; --lateral-apagado:#7d8ba3;
  --sombra:0 1px 2px rgba(11,25,44,.06),0 2px 6px rgba(11,25,44,.04);
  --r:14px;
}
/* Tema escuro: pelo computador (automático), ou escolhido na lateral
   (data-tema no <html>). "claro" fixa o claro mesmo com o sistema escuro. */
@media (prefers-color-scheme:dark){
  :root:not([data-tema=claro]){${ESCURO}}
}
:root[data-tema=escuro]{${ESCURO}}
:root[data-tema=claro]{color-scheme:light}
:root[data-tema=escuro]{color-scheme:dark}
*{box-sizing:border-box}
/* word-spacing: o espaço entre palavras da Plus Jakarta Sans é estreito, e em
   rótulo curto ("Mais filtros", "Com novidade") as palavras quase encostam. */
body{margin:0;background:var(--fundo);color:var(--tinta);
  font:15px/1.55 var(--fonte);word-spacing:.06em;-webkit-font-smoothing:antialiased}
a{color:var(--acento);text-decoration:none}
.oculto{display:none!important}
:focus-visible{outline:2px solid var(--acento);outline-offset:2px}

/* ---------- casca: lateral fixa + conteúdo ---------- */
/* A navegação saiu da barra de cima para uma coluna à esquerda na v0.25.0.
   Três razões, nesta ordem: ela não rola para fora da tela, cabe crescer sem
   virar segunda linha, e abre espaço para a contagem ao lado de cada destino —
   que é informação que antes exigia abrir a tela para descobrir.
   Desde a v0.29.0 ela é azul-marinho nos DOIS temas: é onde a marca mora, e o
   logo em branco sobre o marinho é a versão que o dono do produto desenhou. */
.app{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:start}
/* Sem isto, a tabela larga (que rola dentro do próprio cartão) alargava a
   página inteira no celular: item de grade não encolhe abaixo do conteúdo. */
.app>*{min-width:0}
.lateral{position:sticky;top:0;height:100vh;width:256px;background:var(--lateral);
  border-right:1px solid var(--lateral-linha);display:flex;flex-direction:column;
  padding:24px 16px 18px;gap:26px;overflow-y:auto;z-index:20;color:#fff}
.marca{padding:4px 8px 0}
.marca .logo-svg{width:168px;height:auto;display:block}
.marca .sub{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--lateral-apagado);margin-top:8px;font-weight:700}
.nav{display:flex;flex-direction:column;gap:4px}
.nav button{background:transparent;border:0;color:var(--lateral-tinta);font:inherit;
  font-weight:600;font-size:14.5px;min-height:44px;padding:0 12px;border-radius:10px;
  cursor:pointer;display:flex;align-items:center;gap:12px;width:100%;text-align:left}
.nav button svg{flex-shrink:0;width:19px;height:19px}
.nav button:hover{background:rgba(255,255,255,.06);color:#fff}
.nav button.ativo{background:var(--lateral-ativo);color:#fff;font-weight:700;
  box-shadow:inset 3px 0 0 var(--verde)}
/* A contagem é discreta e alinhada à direita: informa sem competir com o nome
   do destino, que é onde o clique acontece. */
.cont{margin-left:auto;font-size:12.5px;color:var(--lateral-apagado);font-weight:700;
  font-variant-numeric:tabular-nums}
.nav button.ativo .cont{color:var(--lateral-tinta)}
.lateral-pe{margin-top:auto;display:flex;flex-direction:column;gap:10px}
.usuario{display:flex;align-items:center;gap:12px;padding:10px 6px 10px 12px;
  border:1px solid var(--lateral-linha);border-radius:12px}
.usuario .av{width:36px;height:36px;border-radius:50%;background:#1e3a66;color:#fff;
  font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center;
  flex-shrink:0}
.usuario .quem{display:flex;flex-direction:column;min-width:0;flex-grow:1}
.usuario .nome{font-size:14px;font-weight:700;color:#fff;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.usuario .plano{font-size:12px;color:var(--lateral-tinta);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.lateral-pe button{background:transparent;border:0;color:var(--lateral-tinta);font:inherit;
  width:40px;height:40px;border-radius:8px;cursor:pointer;display:flex;
  align-items:center;justify-content:center;flex-shrink:0}
.lateral-pe button:hover{background:rgba(255,255,255,.08);color:#fff}
.lateral-pe button.tema{width:auto;height:36px;justify-content:flex-start;gap:10px;
  padding:0 10px;font-size:13px;font-weight:600;align-self:flex-start}
.lateral-pe button.tema svg{width:17px;height:17px}
.versao{font-size:11.5px;color:var(--lateral-apagado);padding:0 8px}
.versao a{color:var(--lateral-tinta)}
.bolha{background:var(--verde);color:#062414;font-size:12px;font-weight:800;
  min-width:24px;height:22px;border-radius:11px;display:inline-flex;margin-left:auto;
  align-items:center;justify-content:center;padding:0 7px}

.env{max-width:1240px;margin:0 auto;padding:34px 40px 80px;width:100%}

/* Abaixo de 900px a lateral volta a ser barra de cima: numa tela estreita,
   256px fixos comeriam um quarto da largura útil da tabela. */
@media (max-width:900px){
  .app{grid-template-columns:1fr}
  .lateral{position:sticky;height:auto;width:auto;flex-direction:row;
    align-items:center;gap:10px;border-right:0;
    border-bottom:1px solid var(--lateral-linha);padding:10px 14px;flex-wrap:wrap}
  .marca{padding:0}
  .marca .logo-svg{width:120px}
  .marca .sub{display:none}
  .nav{flex-direction:row;flex-wrap:wrap;margin-left:auto}
  .nav button{width:auto;min-height:40px;padding:0 10px;gap:7px}
  .nav button.ativo{box-shadow:inset 0 -2px 0 var(--verde)}
  .lateral-pe{margin-top:0;flex-direction:row;align-items:center}
  .usuario{border:0;padding:0}
  .lateral-pe button.tema span{display:none}
  .usuario .quem,.usuario .av{display:none}
  .versao{display:none}
  .env{padding:18px 14px 70px}
}
/* No celular a navegação vira só ícones: seis rótulos por extenso ocupavam
   três linhas antes do conteúdo. O texto continua lá para o leitor de tela. */
@media (max-width:560px){
  .nav button>span:not(.bolha):not(.cont){position:absolute;width:1px;height:1px;
    overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .nav button{padding:0 9px}
  .cont{display:none}
  .titulo-secao h2{font-size:24px}
}
/* ---------- trilha de liberação ---------- */
.trilha{display:flex;flex-direction:column;gap:14px}
.trilha-topo{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.trilha-topo h3{margin:0;font-size:16px;font-weight:800}
.trilha-topo span{font-size:13px;font-weight:700;color:var(--tinta3)}
.progresso{height:6px;border-radius:3px;background:var(--neutro-bg);overflow:hidden}
.progresso i{display:block;height:100%;background:var(--verde);border-radius:3px}
.passos{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.passo{display:flex;gap:12px;align-items:flex-start;padding:14px;border:1px solid var(--linha);
  border-radius:12px;background:var(--papel2)}
.passo .marca-passo{flex-shrink:0;width:26px;height:26px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-size:13px;font-weight:800;
  border:2px solid var(--linha);color:var(--tinta3)}
.passo.feito .marca-passo{background:var(--verde);border-color:var(--verde);color:#062414}
.passo .tt{font-weight:700;font-size:14.5px}
.passo .cp{font-size:13px;color:var(--tinta2);margin-top:2px;white-space:normal}
.passo .bt2{margin-top:10px;min-height:38px;font-size:13.5px}

/* ---------- tela de entrada ---------- */
/* Fora da sessão a página é outra: sem lateral, sem a coluna estreita do
   conteúdo. A grade da .app, com a lateral escondida, encolhia o conteúdo à
   largura do formulário e o empurrava para o canto superior esquerdo — era a
   tela mais fraca do sistema, e a primeira que o advogado vê. */
body.fora .app{display:block}
body.fora .env{max-width:none;padding:0}
.entrada{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);min-height:100vh}
.entrada-marca{background:var(--lateral);color:#fff;padding:56px 64px;display:flex;
  flex-direction:column;justify-content:space-between;gap:40px}
.entrada-marca .logo-svg{width:232px;height:auto;display:block}
.entrada-marca h1{margin:0;font-size:44px;line-height:1.1;font-weight:800;
  letter-spacing:-.02em}
.entrada-marca .lead{margin:22px 0 0;font-size:17px;line-height:1.6;color:#b8c4d6;
  max-width:460px}
.beneficios{display:flex;flex-direction:column;gap:14px;margin-top:30px}
.beneficio{display:flex;gap:14px;align-items:flex-start;font-size:15.5px;
  line-height:1.5;color:#e4eaf3}
.beneficio b{color:#fff}
.beneficio .ck{flex-shrink:0;width:28px;height:28px;border-radius:8px;
  background:rgba(0,200,83,.16);display:flex;align-items:center;justify-content:center}
.promessa{display:flex;align-items:center;gap:12px;padding:14px 16px;
  border:1px solid #22344f;border-radius:12px;max-width:480px;font-size:13.5px;
  line-height:1.5;color:#b8c4d6}
.ponto-vivo{width:8px;height:8px;border-radius:50%;background:var(--verde);
  box-shadow:0 0 0 4px rgba(0,200,83,.2);flex-shrink:0}
.entrada-form{display:flex;align-items:center;justify-content:center;padding:48px 24px}
.entrada-caixa{width:100%;max-width:420px}
.entrada-caixa h2{margin:0;font-size:28px;font-weight:800;letter-spacing:-.02em}
.entrada-caixa .sub{margin:6px 0 22px;font-size:15px;color:var(--tinta2)}
.entrada-caixa .rotulo{margin-top:16px}
.entrada-caixa input{height:48px;font-size:15px;background:var(--papel)}
.entrada-caixa .bt{width:100%;height:50px;font-size:15.5px;margin-top:22px}
.entrada-caixa .rodape{margin-top:20px;padding-top:18px;border-top:1px solid var(--linha);
  font-size:14px;color:var(--tinta2);text-align:center}
.segmentos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;
  padding:4px;background:var(--neutro-bg);border-radius:12px;margin-bottom:6px}
.segmentos button{height:40px;border:0;border-radius:9px;background:transparent;
  font:inherit;font-size:14px;font-weight:600;color:var(--tinta2);cursor:pointer}
.segmentos button.on{background:var(--papel);color:var(--tinta);font-weight:700;
  box-shadow:0 1px 2px rgba(11,25,44,.12)}
@media (max-width:900px){
  .entrada{grid-template-columns:1fr}
  .entrada-marca{padding:28px 22px;gap:18px}
  .entrada-marca .logo-svg{width:180px}
  .entrada-marca h1{font-size:28px}
  .entrada-marca .lead{font-size:15px;margin-top:12px}
  .beneficios,.promessa{display:none}
  .entrada-form{padding:28px 18px 48px;align-items:flex-start}
}

/* ---------- blocos ---------- */
.cartao{background:var(--papel);border:1px solid var(--linha);
  border-radius:var(--r);padding:20px;margin-bottom:16px;box-shadow:var(--sombra)}
.titulo-secao{display:flex;align-items:flex-end;justify-content:space-between;
  gap:16px;flex-wrap:wrap;margin-bottom:20px}
.titulo-secao h2{font-size:28px;margin:0;letter-spacing:-.02em;font-weight:800;
  line-height:1.2}
.titulo-secao .sub{color:var(--tinta3);font-size:14px;margin-top:4px}
.titulo-secao .acoes{display:flex;gap:10px;align-items:center;flex-wrap:wrap}

.rotulo{display:block;font-size:13px;font-weight:700;color:var(--tinta2);
  margin-bottom:7px}
input,select{width:100%;min-height:44px;padding:9px 12px;font:inherit;color:var(--tinta);
  background:var(--papel);border:1px solid var(--linha);border-radius:10px;outline:0}
input:focus,select:focus{border-color:var(--acento);
  box-shadow:0 0 0 3px var(--acento-bg)}
input[type=checkbox],input[type=radio]{width:auto;min-height:0}
.grade{display:flex;gap:10px;flex-wrap:wrap}
.grade>div{flex:1 1 180px}
button.bt{font:inherit;font-weight:700;min-height:44px;padding:0 18px;border:0;
  border-radius:10px;background:var(--botao);color:#fff;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;gap:8px}
button.bt:hover{background:var(--botao-hover)}
button.bt:disabled{opacity:.5;cursor:progress}
/* bt2 também aparece SEM .bt (área administrativa): tem de se sustentar sozinho. */
button.bt2{font:inherit;font-weight:700;font-size:14px;min-height:44px;padding:0 16px;
  border-radius:10px;cursor:pointer;display:inline-flex;align-items:center;
  justify-content:center;gap:8px;background:var(--papel);color:var(--tinta);
  border:1px solid var(--linha)}
button.bt2:hover{background:var(--papel2);border-color:var(--tinta3)}
button.bt3{background:transparent;color:var(--tinta3);border:0;padding:5px 8px;
  font-size:13px;font-weight:600;cursor:pointer}
button.bt3:hover{color:var(--erro)}
.nota{font-size:12.5px;color:var(--tinta3);margin-top:7px}
.aviso{background:var(--acento-bg);border-radius:10px;padding:12px 14px;
  font-size:13.5px;color:var(--tinta2)}

/* ---------- selo de vigilância ---------- */
/* A frase que diz se dá para confiar na tela, em forma de selo: verde quando
   a verificação está de pé, âmbar quando há processo sem verificação. Nunca
   verde por padrão — um selo verde sem verificação recente seria a tela
   dizendo "pode ficar tranquilo" sem ter olhado. */
.vigia{display:inline-flex;align-items:center;gap:9px;min-height:40px;padding:0 14px;
  border-radius:20px;background:var(--verde-bg);color:var(--verde-tinta);
  font-size:13.5px;font-weight:700}
.vigia.atencao{background:var(--atencao-bg);color:var(--atencao)}
.vigia.atencao .ponto-vivo{background:var(--atencao-ponto);
  box-shadow:0 0 0 4px rgba(245,158,11,.2)}
.vigia.neutro{background:var(--neutro-bg);color:var(--tinta2)}
.vigia.neutro .ponto-vivo{background:var(--tinta3);box-shadow:none}

/* ---------- filtros ---------- */
/* Na carteira, só a busca e três controles ficam à vista; o resto mora em
   "Mais filtros". Sete caixas sempre abertas ocupavam meia tela antes da
   primeira linha da tabela. */
.barra-filtros{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.busca{flex:1 1 280px;display:flex;align-items:center;gap:10px;min-height:46px;
  padding:0 14px;border:1px solid var(--linha);border-radius:10px;
  background:var(--papel);color:var(--tinta3)}
.busca:focus-within{border-color:var(--acento);box-shadow:0 0 0 3px var(--acento-bg)}
.busca input{border:0;padding:0;min-height:44px;background:transparent;box-shadow:none}
.busca input:focus{box-shadow:none}
.barra-filtros select{width:auto;min-height:46px;font-size:14px;font-weight:600}
.filtros{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;
  padding:16px;background:var(--papel);border:1px solid var(--linha);
  border-radius:var(--r);margin-bottom:14px}
.filtros>div{flex:1 1 160px;min-width:140px}
.filtros .compacto{flex:0 0 auto}
.conta-filtro{min-width:20px;height:20px;border-radius:10px;background:var(--botao);
  color:#fff;font-size:11.5px;font-weight:800;display:inline-flex;align-items:center;
  justify-content:center;padding:0 6px}

/* ---------- lista de processos ---------- */
.item{display:block;width:100%;text-align:left;background:var(--papel);
  border:1px solid var(--linha);border-radius:var(--r);padding:14px 16px;
  margin-bottom:10px;cursor:pointer;font:inherit;color:inherit}
.item:hover{border-color:var(--acento)}
.item.novo{border-left:3px solid var(--novo)}
.item .lin1{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.item .n{font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.item .ap{color:var(--tinta2);font-size:14px}
.item .lin2{color:var(--tinta2);font-size:13px;margin-top:3px}
.item .lin3{color:var(--tinta3);font-size:12px;margin-top:5px}

.selo{display:inline-flex;align-items:center;font-size:12px;font-weight:700;
  height:22px;padding:0 9px;border-radius:6px;white-space:nowrap;
  background:var(--acento-bg);color:var(--acento)}
.selo.nv{background:var(--novo-bg);color:var(--novo)}
.selo.al{background:var(--erro-bg);color:var(--erro)}
.selo.mc{background:var(--marco-bg);color:var(--marco)}
.selo.pr{background:var(--atencao-bg);color:var(--atencao)}
.selo.ok{background:var(--verde-bg);color:var(--verde-tinta)}
.selo.neutro{background:var(--neutro-bg);color:var(--tinta3)}

/* ---------- detalhe ---------- */
.capa{background:var(--papel);border:1px solid var(--linha);
  border-radius:var(--r) var(--r) 0 0;border-bottom:0;padding:20px 18px 18px}
.capa .num{font-size:24px;font-weight:700;letter-spacing:-.03em;
  font-variant-numeric:tabular-nums}
.capa .sob{margin-top:4px;color:var(--tinta2);font-size:14px}
.selos{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.agora{background:var(--papel2);border:1px solid var(--linha);border-top:0;
  border-radius:0 0 var(--r) var(--r);padding:14px 18px;margin-bottom:14px}
.agora .k{font-size:11px;font-weight:700;color:var(--tinta3);
  text-transform:uppercase;letter-spacing:.07em}
.agora .t{font-size:17px;font-weight:600;margin-top:4px}
.agora .d{font-size:13px;color:var(--tinta2);margin-top:2px}
.fatos{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));
  gap:1px;background:var(--linha2);border:1px solid var(--linha);
  border-radius:var(--r);overflow:hidden;margin-bottom:14px}
.fato{background:var(--papel);padding:13px 16px}
.fato .k{font-size:11px;font-weight:700;color:var(--tinta3);
  text-transform:uppercase;letter-spacing:.07em}
.fato .v{margin-top:3px;font-size:14px;line-height:1.4}
h3.sec{font-size:12px;font-weight:700;text-transform:uppercase;
  letter-spacing:.08em;color:var(--tinta3);margin:0 0 10px}
.ano{position:sticky;top:57px;background:var(--papel);padding:8px 0 6px;
  font-size:12px;font-weight:700;color:var(--tinta3);z-index:2}
.ev{display:grid;grid-template-columns:78px 1fr;gap:12px;padding:8px 0;
  border-top:1px solid var(--linha2)}
.ev .dt{font-size:12px;color:var(--tinta3);font-variant-numeric:tabular-nums;
  padding-top:2px;white-space:nowrap}
.ev .tt{font-weight:500;line-height:1.4}
.ev.marco .tt{font-weight:700}
.ev.marco .dt{color:var(--marco);font-weight:700}
.ev .cp{font-size:13px;color:var(--tinta2);margin-top:3px}
.ev .xn{font-size:11px;color:var(--tinta3);font-weight:600}
/* ---------- painel: cabeçalho, cards e trilho ---------- */
/* A data por extenso é a âncora da leitura: o advogado abre o sistema para
   decidir o que fazer HOJE, e sem ela "vence às 18h" não diz de que dia. */
.cabeca{margin-bottom:24px}
.kicker{font-size:13.5px;font-weight:600;color:var(--tinta3);margin-bottom:6px}
.alerta-txt{color:var(--atencao);font-weight:600}

/* ---------- carteira em tabela ---------- */
/* Substituiu os cartões empilhados na v0.25.0: com 142 pastas, quatro linhas
   por cartão viram rolagem, e comparar duas exigia percorrer a tela.
   Na v0.29.0 a linha ficou com altura FIXA: o texto das partes quebrava em
   quatro linhas e esticava cada processo, e cabiam três por tela. Agora cada
   célula corta com reticências, e o texto inteiro fica no "title". */
.cartao.sem-borda{padding:0;overflow:hidden}
.tab-rolo{overflow-x:auto}
.tab{width:100%;border-collapse:collapse;font-size:14px}
.tab.fixa{table-layout:fixed;min-width:980px}
.tab th{text-align:left;font-size:11.5px;font-weight:800;text-transform:uppercase;
  letter-spacing:.06em;color:var(--tinta3);padding:12px 14px;
  border-bottom:1px solid var(--linha);white-space:nowrap;
  position:sticky;top:0;background:var(--papel2);z-index:1}
.tab td{padding:11px 14px;border-bottom:1px solid var(--linha2);vertical-align:top}
.tab.fixa td{padding:9px 14px;vertical-align:middle;height:56px}
.corta{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.tab tbody tr:last-child td{border-bottom:0}
.tab tbody tr:hover{background:var(--papel2)}
/* A marca de novidade é uma régua à esquerda da linha inteira, não um fundo:
   fundo colorido em várias linhas de uma vez vira ruído e some com o destaque
   do que pede providência. */
.tab tr.nova td:first-child{box-shadow:inset 3px 0 0 var(--novo)}
.tab tr.nova{background:var(--papel2)}
.tab .n{font-weight:600;font-variant-numeric:tabular-nums;
  font-family:var(--mono);font-size:13px}
.tab.fixa .t-sub{margin-top:2px}
.t-sub{color:var(--tinta3);font-size:12px;margin-top:3px;line-height:1.4}
.t-mov-t{line-height:1.35}
.t-num{min-width:200px}
.t-cli{min-width:150px;max-width:230px}
.t-trib{white-space:nowrap;color:var(--tinta2)}
.t-mov{min-width:240px}
.t-est{white-space:nowrap}
/* Botão que não parece botão: a linha inteira é navegável e um contorno por
   célula transformaria a tabela numa grade de caixas. */
.lnh{background:transparent;border:0;padding:0;margin:0;font:inherit;color:inherit;
  cursor:pointer;text-align:left;max-width:100%}
.lnh:hover{color:var(--acento)}
.lnh.forte{font-weight:600}
.lnh.vazio{opacity:.85}
.lnh.vazio:hover{opacity:1}
/* Pasta sem cliente: um convite a rotular, tracejado para não parecer dado. */
.rotular{background:transparent;border:1px dashed var(--tinta3);border-radius:7px;
  color:var(--tinta2);font:inherit;font-size:12.5px;font-weight:600;padding:3px 10px;
  cursor:pointer;white-space:nowrap}
.rotular:hover{border-style:solid;color:var(--acento);border-color:var(--acento)}
/* O --tinta3 mede 4,2:1 sobre o fundo claro (axe); o subtítulo da carteira usa --tinta2, como as
   telas que já mediram isso. A variável global segue como está (decisão à parte). */
.titulo-secao .sub.sub-carteira{color:var(--tinta2)}
.trib{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:6px;
  background:var(--neutro-bg);font-size:12px;font-weight:700;color:var(--tinta2)}
.t-in{width:100%;font:inherit;font-size:13px;padding:5px 8px;border-radius:6px;
  border:1px solid var(--acento);background:var(--papel);color:var(--tinta)}
.selo.av{background:var(--marco-bg);color:var(--marco)}

.parte{padding:11px 0;border-top:1px solid var(--linha2)}
.parte:first-of-type{border-top:0}

/* ---------- estados ---------- */
.vazio{text-align:center;padding:48px 20px;color:var(--tinta2)}
.vazio .ic{font-size:30px;margin-bottom:10px;opacity:.5}
.vazio h3{margin:0 0 6px;font-size:16px;color:var(--tinta)}
.vazio p{margin:0 auto 16px;max-width:420px;font-size:14px}
.gira{display:inline-block;width:13px;height:13px;border:2px solid currentColor;
  border-top-color:transparent;border-radius:50%;animation:g .7s linear infinite;
  vertical-align:-2px;margin-right:8px}
@keyframes g{to{transform:rotate(360deg)}}
.barra-prog{height:2px;background:var(--acento);border-radius:2px;
  animation:pulsa 1.4s ease-in-out infinite;margin-top:10px}
@keyframes pulsa{0%,100%{opacity:.25}50%{opacity:1}}

/* ---------- providência, filtros e leitura do ato ---------- */
/* O cartão de providência é o primeiro da página e precisa se distinguir sem
   gritar: borda de acento à esquerda, não fundo vermelho. Alarme permanente
   deixa de ser alarme. */
.cartao.alerta{border-left:3px solid var(--atencao-ponto)}
.acao{display:grid;grid-template-columns:88px 1fr;gap:10px;padding:9px 0;
  border-bottom:1px solid var(--linha)}
.acao:last-of-type{border-bottom:0}
.ev.pede .tt{font-weight:600}

/* ---------- régua temporal ---------- */
/* Três níveis de ênfase, e só três. A crítica que originou isto foi de um
   advogado: numa lista de 381 andamentos a decisão de 03/03 estava
   "visualmente perdida no meio dos Outros ×2". A régua marca o pronunciamento
   do juízo com fundo, e o que pede providência com a régua de acento à
   esquerda — o mesmo recurso do cartão de alerta, para a página inteira falar
   uma língua só. O resto fica neutro de propósito: se tudo salta aos olhos,
   nada salta. */
.ev.decisao{background:var(--marco-bg);border-radius:8px;padding:10px 12px;
  margin:2px 0;border-top:0}
.ev.decisao .tt{font-weight:700}
.ev.decisao .dt{color:var(--marco);font-weight:700}
.ev.pede{border-left:3px solid var(--atencao-ponto);padding-left:11px}

/* O documento na linha do evento — o que aposentou a lista de anexos no
   rodapé. Botão de verdade, não link de texto: é a ação mais frequente da
   tela e precisa de área de clique no celular. */
.docs{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.doc{background:var(--papel2);border:1px solid var(--linha);color:var(--tinta);
  border-radius:7px;padding:5px 10px;font-size:12.5px;cursor:pointer;
  font-family:inherit;text-align:left;max-width:100%;line-height:1.35}
.doc:hover{border-color:var(--acento);color:var(--acento)}
.doc.parte{border-left:3px solid var(--novo)}
.doc.sigilosa{border-left:3px solid var(--erro)}
/* Já baixado fica DISCRETO, não desabilitado: a pessoa pode ter perdido o
   arquivo, e travar o botão a obrigaria a procurar outro caminho para algo a
   que tem direito. A marca serve para não repetir por engano. */
.doc.ja{color:var(--tinta3);border-style:dashed}
.doc.ja:hover{color:var(--acento);border-style:solid}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.chip{background:transparent;border:1px solid var(--linha);color:var(--tinta2);
  border-radius:999px;min-height:36px;padding:0 14px;font-size:13px;font-weight:600;
  cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:7px}
.chip:hover{color:var(--tinta);border-color:var(--tinta2)}
.chip.on{background:var(--tinta);border-color:var(--tinta);color:var(--papel)}
.chip.nv.on{background:var(--novo-bg);border-color:var(--novo);color:var(--novo)}
.barra-filtros .chip{min-height:46px;border-radius:10px;background:var(--papel)}
.barra-filtros .chip.on{background:var(--tinta);border-color:var(--tinta);color:var(--papel)}
.barra-filtros .chip.nv.on{background:var(--novo-bg);border-color:var(--novo);color:var(--novo)}
.chip.on .conta-filtro{background:var(--papel);color:var(--tinta)}
.link{background:none;border:0;color:var(--acento);cursor:pointer;padding:4px 0;
  font-size:12.5px;font-family:inherit;text-decoration:underline}
.cp a{color:var(--acento)}
/* O inteiro teor expandido é texto de decisão: precisa respirar e preservar as
   quebras de linha do ato, senão vira um bloco ilegível de 20 mil caracteres. */
.cp{white-space:pre-wrap}
.vig{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;
  padding:11px 0;border-bottom:1px solid var(--linha)}
.vig:last-of-type{border-bottom:0}
.vig .id{font-weight:600}
.campo{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin:10px 0}
.campo label{display:block;font-size:12px;color:var(--tinta2);margin-bottom:4px}

@media (max-width:560px){
  .acao{grid-template-columns:1fr;gap:2px}
  .vig{grid-template-columns:1fr;align-items:start}
  .ev{grid-template-columns:1fr;gap:2px}
  .capa .num{font-size:20px}
  .nav button{padding:8px 10px;font-size:13px}
}
`;
