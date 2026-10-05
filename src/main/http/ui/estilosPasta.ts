/**
 * CSS da Pasta digital (v0.33.0). Arquivo próprio, como o script: a tela do
 * processo continua exatamente como era enquanto a Pasta está fechada, e tudo
 * daqui só age dentro de `#pasta` ou sob `body.com-pasta` / `body.pasta-lendo`.
 *
 * Usa os tokens do console (estilos.ts), com o mesmo significado — o tema
 * escuro vem deles, nada aqui escreve cor própria. Verde = disponível, azul =
 * na fila/baixando, âmbar = pausa do tribunal, vermelho = não obtida. O texto
 * de estado diz a mesma coisa que a cor: ninguém depende só dela.
 */
export const ESTILOS_PASTA = `
/* ---------- pasta digital: a tela inteira à direita da lateral ---------- */
:root{--pasta-lista-w:400px}
body.com-pasta{overflow:hidden}
#pasta{position:fixed;top:0;right:0;bottom:0;left:256px;z-index:40;display:flex;
  flex-direction:column;min-width:0;overflow:hidden;background:var(--papel);
  box-shadow:-6px 0 18px rgba(11,25,44,.08)}
#pasta>*{min-width:0}
#pasta>.topo,#pasta>.aviso{flex-shrink:0}
#pasta .topo{display:flex;align-items:center;gap:8px;padding:10px 14px;
  border-bottom:1px solid var(--linha);flex-wrap:wrap}
#pasta .topo h3{margin:0;font-size:15px;font-weight:800;flex-grow:1;min-width:0;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pasta .topo .bt,#pasta .topo .bt2{min-height:40px}
#pasta .aviso{background:var(--papel);border-radius:0;border-bottom:1px solid var(--linha);
  padding:0 14px;font-size:13px;color:var(--tinta2);max-height:30vh;overflow:auto}
#pasta .aviso:empty{display:none}
#pasta .aviso>div{padding:8px 0;border-bottom:1px solid var(--linha2)}
#pasta .aviso>div:last-child{border-bottom:0}
#pasta strong{color:var(--tinta)}
#pasta .proc{font-size:12.5px;color:var(--tinta2)}
#pasta .job.pausa,#pasta .pausa{color:var(--atencao);background:var(--atencao-bg);
  border-radius:8px;padding:8px 10px;margin:6px 0}
#pasta .job.pausa strong,#pasta .pausa strong{color:var(--atencao)}
#pasta .job.falha,#pasta .falha{color:var(--erro)}
#pasta .job.falha strong,#pasta .falha strong{color:var(--erro)}
#pasta .job.ok strong{color:var(--verde-tinta)}
#pasta .job.pr strong{color:var(--atencao)}
#pasta .barra-prog{height:6px;border-radius:3px;background:var(--neutro-bg);
  overflow:hidden;margin:8px 0 4px}
#pasta .barra-prog i{display:block;height:100%;background:var(--novo);width:0;
  transition:width .3s}
#pasta .nota{color:var(--tinta2)}
/* O selo neutro do console mede 4,2:1 (axe); aqui o texto é pequeno e usa --tinta2. */
#pasta .selo.neutro{color:var(--tinta2)}

#pasta>.corpo{flex:1 1 auto;min-height:0;display:flex}

/* ---------- a lista ---------- */
#pasta .lista{flex:none;width:min(var(--pasta-lista-w),calc(100vw - 256px - 320px));
  min-width:260px;max-width:100%;display:flex;flex-direction:column;min-height:0;
  border-right:1px solid var(--linha);background:var(--papel)}
#pasta .lista .barra{flex-shrink:0;padding:10px 12px;border-bottom:1px solid var(--linha2);
  display:flex;flex-direction:column;gap:8px}
#pasta .lista input[type=search]{width:100%;min-height:40px;padding:6px 12px;font-size:14px;
  min-width:0}
#pasta .so-disp{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--tinta2);
  cursor:pointer;min-height:28px}
#pasta .so-disp input{width:18px;height:18px}
#pasta .acoes,#pasta .acoes-previa{display:flex;gap:6px;flex-wrap:wrap}
#pasta .acoes .bt,#pasta .acoes .bt2{min-height:38px;padding:0 12px;font-size:13px}
#pasta .barra .chips{margin:0;gap:6px}
#pasta .barra .chip{min-height:34px;padding:0 10px;font-size:12.5px;max-width:100%;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pasta .chip.on{border-color:var(--acento);color:var(--acento);background:var(--acento-bg)}
#pasta .contagem{font-size:12.5px;color:var(--tinta2)}
#pasta .filtro-ativo{color:var(--atencao)}
#pasta .previa{margin:8px 12px;padding:10px 12px;border:1px solid var(--linha);
  border-radius:10px;background:var(--papel2);font-size:13px;color:var(--tinta2)}
#pasta .previa.falha{border-color:var(--erro);background:var(--erro-bg)}
#pasta .previa.ok{border-color:var(--verde-tinta)}
#pasta .acoes-previa{margin-top:8px}
#pasta .itens{flex:1 1 auto;min-height:0;overflow:auto}
#pasta .vazio-lista{padding:20px 14px;color:var(--tinta2);font-size:13.5px}
#pasta .linha{display:grid;grid-template-columns:auto auto 1fr;gap:2px 8px;align-items:center;
  padding:9px 12px;border-top:1px solid var(--linha2);cursor:pointer;min-height:48px}
#pasta .linha:first-child{border-top:0}
#pasta .linha:hover{background:var(--papel2)}
#pasta .linha.atual{background:var(--acento-bg)}
#pasta .linha:focus-visible{outline:2px solid var(--acento);outline-offset:-2px}
#pasta .linha[aria-disabled=true] .rot{color:var(--tinta2)}
#pasta .linha .cx{width:20px;height:20px;border:2px solid var(--tinta3);border-radius:5px;
  background:var(--papel);position:relative;flex:none}
#pasta .linha.marcada .cx{background:var(--acento);border-color:var(--acento)}
#pasta .linha.marcada .cx::after{content:"";position:absolute;left:5px;top:1px;width:5px;
  height:10px;border:solid var(--papel);border-width:0 2px 2px 0;transform:rotate(45deg)}
#pasta .linha[aria-disabled=true] .cx{opacity:.35;border-style:dashed}
#pasta .linha .ord{font-size:12px;color:var(--tinta2);font-variant-numeric:tabular-nums;
  min-width:2ch;text-align:right}
#pasta .linha .rot{font-weight:600;font-size:13.5px;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
#pasta .linha .meta{grid-column:3;display:flex;gap:8px;flex-wrap:wrap;align-items:center;
  font-size:12px;color:var(--tinta2)}
/* A movimentação da peça: até 2 linhas, o número sempre à vista. Com a linha em
   foco o texto se abre inteiro (o title só aparece no mouse). */
#pasta .linha .mov{grid-column:3;display:flex;gap:6px;align-items:baseline;min-width:0;
  font-size:12px;color:var(--tinta2)}
#pasta .linha .mov-n{flex:none;white-space:nowrap;font-weight:700;
  font-variant-numeric:tabular-nums}
#pasta .linha .mov-t{min-width:0;overflow:hidden;overflow-wrap:anywhere;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2}
#pasta .linha:focus-visible .mov-t{-webkit-line-clamp:unset;line-clamp:unset}
#pasta .linha .mov-n.faixa{text-decoration:underline dotted;text-underline-offset:3px}
#pasta .linha .mov-n.estimado{font-style:italic}
#pasta .linha .mov-ok{flex:none;white-space:nowrap;font-size:11.5px;font-weight:700;
  color:var(--verde-tinta)}
#pasta .linha .mov-ach{flex:none;white-space:nowrap;font-size:11.5px;font-style:italic}
#pasta .linha .mov-cal{flex:none;white-space:nowrap;font-size:11.5px;margin-left:auto;
  color:var(--acento);cursor:pointer;text-decoration:underline}
#pasta .linha .pp{font-variant-numeric:tabular-nums;color:var(--acento);font-weight:700}

/* ---------- calibração do número com o Projudi (v0.35.0) ---------- */
#pasta .pcal-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;
  clip:rect(0,0,0,0);white-space:nowrap;border:0}
#pasta>.pcal-caixa{flex-shrink:0;border-bottom:1px solid var(--linha);max-height:32vh;
  overflow:auto}
#pasta>.pcal-caixa:empty{display:none}
#pasta .pcal summary{padding:8px 14px;cursor:pointer;font-weight:700;font-size:13.5px;
  color:var(--tinta);min-height:24px}
#pasta .pcal summary:focus-visible,#pasta .pcal .bt:focus-visible,
#pasta .pcal input:focus-visible,#pasta .pcal-editor input:focus-visible,
#pasta .pcal-editor .bt:focus-visible,#pasta .pcal-bt:focus-visible{outline:3px solid var(--acento);
  outline-offset:2px}
#pasta .pcal .pcal-n{font-weight:400;color:var(--tinta2)}
#pasta .pcal-corpo{padding:0 14px 12px;font-size:13px;color:var(--tinta2)}
#pasta .pcal-ajuda{margin:4px 0 8px;font-size:12.5px;color:var(--tinta2)}
#pasta .pcal label,#pasta .pcal-editor label{display:block;font-size:13px;color:var(--tinta);
  margin-bottom:4px}
#pasta .pcal-linha{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#pasta .pcal-linha input{flex:1 1 140px;min-width:0;min-height:40px;padding:6px 12px;
  font-size:16px;max-width:240px}
#pasta .pcal-linha .bt{min-height:40px}
#pasta .pcal-lista{list-style:none;margin:10px 0 8px;padding:0;display:flex;flex-direction:column;
  gap:6px}
#pasta .pcal-lista li{display:flex;gap:8px;align-items:center;justify-content:space-between;
  flex-wrap:wrap}
#pasta .pcal-lista .bt{min-height:36px}
#pasta .pcal-msg{margin-top:6px;font-size:13px;min-height:0}
#pasta .pcal-msg:empty{display:none}
#pasta .pcal-msg.ok{color:var(--verde-tinta)}
#pasta .pcal-msg.erro{color:var(--erro)}
/* Em fluxo, entre o bloco do topo e a lista: flutuando, cobria as linhas de que a
   pessoa precisa para conferir o número. No celular, com a peça aberta, o topo
   some e este bloco continua — é por ele que se informa o número do ato lido. */
#pasta>.pcal-editor{flex-shrink:0;background:var(--papel);border-bottom:1px solid var(--linha);
  padding:10px 14px;font-size:13px;color:var(--tinta2);max-height:28vh;overflow:auto}
#pasta>.pcal-editor[hidden]{display:none}
#pasta .pcal-editor .pcal-linha input{font-size:16px}
#pasta .visor .mov-visor .pcal-bt{margin-left:8px;min-height:32px;padding:0 10px;font-size:12.5px}

/* ---------- o divisor ---------- */
#pasta .divisor{flex:none;width:10px;margin:0 -5px;position:relative;cursor:col-resize;
  z-index:2;touch-action:none}
#pasta .divisor::after{content:"";position:absolute;left:4px;top:50%;width:2px;height:44px;
  margin-top:-22px;border-radius:2px;background:var(--linha)}
#pasta .divisor:hover::after,#pasta .divisor.arrastando::after,
#pasta .divisor:focus-visible::after{background:var(--acento)}

/* ---------- o visualizador ---------- */
#pasta .visor{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0;
  background:var(--fundo)}
#pasta .visor>.topo-visor,#pasta .visor>.estado,#pasta .visor>.ferramentas,
#pasta .visor>.onde{flex-shrink:0}
#pasta .topo-visor{display:flex;align-items:center;gap:8px;padding:8px 14px;
  border-bottom:1px solid var(--linha);background:var(--papel);min-width:0}
#pasta .topo-visor .nome{min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:14px}
#pasta .topo-visor .voltar{display:none}
#pasta .visor .mov-visor{flex-shrink:0;padding:6px 14px;font-size:12.5px;color:var(--tinta2);
  background:var(--papel);border-bottom:1px solid var(--linha2);overflow:auto;
  overflow-wrap:anywhere;max-height:5.5em}
#pasta .visor .mov-visor:empty{display:none}
#pasta .visor .mov-visor .mov-aviso{margin-left:8px;font-size:11.5px;font-style:italic}
#pasta .visor .estado{padding:10px 14px;border-bottom:1px solid var(--linha2);
  font-size:13.5px;color:var(--tinta2);background:var(--papel);max-height:34vh;overflow:auto}
#pasta .visor .estado:empty{display:none}
#pasta .visor .estado .espera{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
#pasta .visor .ferramentas{display:flex;align-items:center;gap:6px;padding:8px 12px;
  border-bottom:1px solid var(--linha);flex-wrap:wrap;font-size:13px;background:var(--papel)}
#pasta .visor .ferramentas>*{min-width:0;max-width:100%}
#pasta .visor .ferramentas input{min-height:34px;width:auto;flex:1 1 150px;padding:5px 10px;
  font-size:13px;min-width:0}
#pasta .visor .ferramentas button{min-height:34px;padding:0 10px;font-size:13px}
#pasta .visor .ferramentas .pg{color:var(--tinta2);font-variant-numeric:tabular-nums;
  white-space:nowrap}
#pasta .onde{padding:6px 14px;font-size:12.5px;color:var(--tinta2);
  border-bottom:1px solid var(--linha2);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;background:var(--papel)}
#pasta .onde:empty{display:none}
#pasta .paginas{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 0}
#pasta .paginas:empty{display:none}
#pasta .pagina{margin:0 auto 12px;background:#fff;box-shadow:var(--sombra);position:relative}
#pasta .pagina canvas{display:block;width:100%;height:100%}
#pasta .pagina .num{position:absolute;right:6px;bottom:4px;font-size:11px;
  color:#475569;background:rgba(255,255,255,.9);padding:0 4px;border-radius:3px}
#pasta .pagina.achada{outline:3px solid var(--atencao-ponto)}
#pasta .vazio-visor{padding:24px 16px;color:var(--tinta2);font-size:13.5px}
#pasta .aviso-peca{color:var(--tinta2)}

/* ---------- celular: lista em tela cheia; a peça abre em tela cheia, com voltar ---------- */
@media (max-width:900px){
  #pasta{left:0;box-shadow:none}
  #pasta .lista{width:100%;min-width:0;border-right:0;overflow:auto}
  /* A tela é pequena: filtros e lista rolam juntos, e a lista não fica espremida. */
  #pasta .itens{overflow:visible;flex:none}
  #pasta .divisor{display:none}
  #pasta .visor{display:none}
  body.pasta-lendo #pasta .lista{display:none}
  body.pasta-lendo #pasta .visor{display:flex}
  body.pasta-lendo #pasta>.topo,body.pasta-lendo #pasta>.aviso,
  body.pasta-lendo #pasta>.pcal-caixa{display:none}
  #pasta .topo-visor .voltar{display:inline-flex}
  #pasta .visor .estado{max-height:26vh}
}
`;
