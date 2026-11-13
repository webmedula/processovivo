import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESTILOS } from '../../src/main/http/ui/estilos.js';
import { ESTILOS_PASTA } from '../../src/main/http/ui/estilosPasta.js';
import { ESTILOS_MENU, SCRIPT_MENU } from '../../src/main/http/ui/menuLateral.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';
import { SCRIPT_PASTA } from '../../src/main/http/ui/scriptPasta.js';
import { SCRIPT_PASTA_CALIBRACAO } from '../../src/main/http/ui/scriptPastaCalibracao.js';

/* Invariantes do menu lateral e do topo da Pasta (v0.68.0) — o que o navegador não precisa provar de novo. */
// `split('\n').length` de `script.ts` na 0.67.3 (2.340 quebras de linha + a última).
const LINHAS_DO_SCRIPT_ANTES = 2341;
const fonte = (caminho: string): string =>
  readFileSync(resolve(__dirname, '../..', caminho), 'utf8');

describe('menu lateral: completo, ícones e gaveta', () => {
  it('script.ts NÃO cresce e não sabe da forma do menu', () => {
    const script = fonte('src/main/http/ui/script.ts');
    expect(script.split('\n').length).toBeLessThanOrEqual(LINHAS_DO_SCRIPT_ANTES);
    expect(script).not.toContain('menu-gaveta');
    expect(script).not.toContain('processovivo.menu');
  });

  it('o módulo vai na página do console, logo depois do script principal, e não carrega nada de fora', () => {
    const html = paginaConsole('0.0.0');
    expect(html).toContain(SCRIPT_MENU.trim().slice(0, 40));
    expect(html).toContain(ESTILOS_MENU.trim().slice(0, 40));
    expect(SCRIPT_MENU).not.toMatch(/https?:\/\//);
    expect(SCRIPT_MENU).not.toMatch(/<script|<link/i);
    // Versão e "estado das fontes" continuam na lateral, com o mesmo texto.
    expect(html).toContain('v0.0.0 &middot; <a href="/ready">estado das fontes</a>');
  });

  it('os pontos de quebra: ícones abaixo de 1280 px, gaveta de 900 px para baixo e sempre na Pasta', () => {
    expect(SCRIPT_MENU).toContain('var LIMITE_ICONES=1280;');
    expect(SCRIPT_MENU).toContain('var LIMITE_GAVETA=900;');
    expect(SCRIPT_MENU).toContain("document.body.classList.contains('com-pasta')");
    expect(SCRIPT_MENU).toContain(
      "if(naPasta()||window.innerWidth<=LIMITE_GAVETA)return 'gaveta';",
    );
    expect(ESTILOS_MENU).toContain('html.menu-icones .lateral{width:60px');
  });

  it('a preferência guardada é só "icones" ou "completo", com try/catch na leitura e na gravação', () => {
    expect(SCRIPT_MENU).toContain("var CHAVE='processovivo.menu';");
    expect(SCRIPT_MENU).toContain(
      "try{var v=localStorage.getItem(CHAVE);if(v==='icones'||v==='completo')return v}catch(e){}",
    );
    expect(SCRIPT_MENU).toContain('try{localStorage.setItem(CHAVE,memoria)}catch(e){}');
    // Nada além disso vai ao armazenamento, e o módulo não fala com o servidor.
    expect(SCRIPT_MENU.match(/localStorage\./g)).toHaveLength(2);
    expect(SCRIPT_MENU).not.toMatch(/fetch\(|pv\(\)\.api|XMLHttpRequest/);
  });

  it('o ☰ tem nome acessível, estado e alvo; a gaveta fecha com Esc, fundo, botão e item, e prende o foco', () => {
    expect(SCRIPT_MENU).toContain(
      'aria-label="Menu" aria-expanded="false" \'+\n    \'aria-controls="lateral"',
    );
    expect(SCRIPT_MENU).toContain("xis.setAttribute('aria-label','Fechar menu')");
    expect(SCRIPT_MENU).toContain(
      "fundo.addEventListener('click',function(){fechar(true)})",
    );
    expect(SCRIPT_MENU).toContain(
      "if(ev.key==='Escape'){ev.preventDefault();ev.stopPropagation();fechar(true);return}",
    );
    expect(SCRIPT_MENU).toContain("closest('.nav button,#sair,.versao a')");
    expect(SCRIPT_MENU).toContain("if(ev.key!=='Tab')return;");
    // O ☰ da Pasta entra à esquerda de "Fechar a pasta", sem gancho novo na Pasta.
    expect(SCRIPT_MENU).toContain(
      "f.insertAdjacentHTML('beforebegin',botaoMenu('pasta-menu','bt bt2'))",
    );
    expect(SCRIPT_PASTA).not.toContain('__pvMenu');
  });

  it('animação de até 200 ms, e nenhuma com prefers-reduced-motion', () => {
    const tempos = [...ESTILOS_MENU.matchAll(/transition:[^;}]*/g)].flatMap((m) =>
      [...m[0].matchAll(/(\d*\.?\d+)s/g)].map((t) => Number(t[1]) * 1000),
    );
    expect(tempos.length).toBeGreaterThan(0);
    expect(Math.max(...tempos)).toBeLessThanOrEqual(200);
    expect(ESTILOS_MENU).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{[^}]*transition:none/,
    );
  });

  it('o /admin não muda: não recebe o módulo e mantém a barra de cima de 900 px para baixo', () => {
    expect(fonte('src/main/http/ui/paginaAdmin.ts')).not.toContain('menuLateral');
    // As regras antigas valem onde não há gaveta (o /admin nunca recebe html.menu-gaveta).
    expect(ESTILOS).toContain(
      'html:not(.menu-gaveta) .lateral{position:sticky;height:auto;width:auto;flex-direction:row;',
    );
    expect(ESTILOS).toContain(
      'html:not(.menu-gaveta) .nav{flex-direction:row;flex-wrap:wrap;margin-left:auto}',
    );
  });
});

describe('topo da Pasta: largura toda, aviso em uma linha, tipos em uma linha e divisor', () => {
  it('a Pasta começa na borda esquerda da janela: o menu não ocupa largura', () => {
    expect(ESTILOS_PASTA).toContain('height:100dvh;left:0;z-index:40');
    expect(ESTILOS_PASTA).not.toContain('256px');
    expect(SCRIPT_PASTA).not.toContain('-256');
  });

  it('o aviso é uma linha com o resumo sempre à vista; o texto completo de antes está inteiro em "Detalhes"', () => {
    expect(SCRIPT_PASTA).toContain('<details class="pav" id="pasta-aviso-det"');
    expect(SCRIPT_PASTA).toContain('id="pasta-aviso-linha">Lista de ');
    expect(SCRIPT_PASTA).toContain('&#9432; Detalhes');
    // Sem mudar uma palavra.
    expect(SCRIPT_PASTA).toContain(
      "' — <strong>não é consulta ao vivo</strong>. Peça nova só aparece quando as peças do '+\n    'processo são recarregadas (botão \"Atualizar\" do cartão das peças).</div>'",
    );
    expect(SCRIPT_PASTA_CALIBRACAO).toContain(
      "', há atos bloqueados que não recebemos e os números mais recentes podem estar abaixo '+\n      'dos do Projudi. Use \"Conferir numeração com o Projudi\" para corrigir.'",
    );
    // Abre sozinho só no alerta que o sistema detecta: calibração anterior invalidada.
    expect(SCRIPT_PASTA).toContain("(st.avisoAberto||(rn&&rn.alerta)?' open':'')");
    expect(SCRIPT_PASTA_CALIBRACAO).toContain(
      "if(c&&c.invalidadas>0)return {texto:'calibração anterior invalidada',alerta:true};",
    );
    // O resumo nunca se apresenta como número oficial nem fala em prazo.
    expect(SCRIPT_PASTA_CALIBRACAO).not.toMatch(/oficial/i);
  });

  it('os tipos ficam em uma linha que rola por dentro, com o sinal de que há mais', () => {
    expect(ESTILOS_PASTA).toContain(
      '#pasta .barra .chips{margin:0;display:flex;flex-wrap:nowrap;gap:5px;min-width:0;overflow-x:auto;',
    );
    expect(ESTILOS_PASTA).toContain('#pasta .barra .chips.tem-mais{');
    expect(SCRIPT_PASTA).toContain(
      "el.classList.toggle('tem-mais',el.scrollLeft+el.clientWidth<el.scrollWidth-2)",
    );
    // A ordem e a quantidade dos tipos são as de antes.
    expect(SCRIPT_PASTA).toContain(
      '.sort(function(a,b){return b.ids.length-a.ids.length}).slice(0,8);',
    );
  });

  it('divisor: nome "Redimensionar lista", mínimos de 320 px (lista) e 360 px (peça), duplo clique e Enter voltam ao padrão', () => {
    expect(SCRIPT_PASTA).toContain('aria-label="Redimensionar lista"');
    expect(SCRIPT_PASTA).toContain('role="separator" aria-orientation="vertical"');
    expect(SCRIPT_PASTA).toContain('var MIN_LISTA=320, MIN_VISOR=360;');
    expect(SCRIPT_PASTA).toContain("d.addEventListener('dblclick',padrao);");
    expect(SCRIPT_PASTA).toContain(
      "if(e.key==='Enter'){e.preventDefault();padrao();return}",
    );
    expect(SCRIPT_PASTA).toContain('try{localStorage.removeItem(LARGURA)}catch(x){}');
    expect(ESTILOS_PASTA).toContain(':root{--pasta-lista-w:clamp(440px,36vw,620px)}');
    expect(ESTILOS_PASTA).toContain('min-width:320px;');
  });
});
