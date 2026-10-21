import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';
import { SCRIPT } from '../../src/main/http/ui/script.js';
import { SCRIPT_VERIFICACAO } from '../../src/main/http/ui/verificacao.js';
import {
  ESTILOS_ATUALIZACOES,
  SCRIPT_ATUALIZACOES,
} from '../../src/main/http/ui/atualizacoes.js';

/** O corpo de uma função do script do console, até a próxima função de topo. */
function corpoDe(nome: string): string {
  const inicio = SCRIPT.indexOf(`function ${nome}(`);
  expect(inicio, `função ${nome} não encontrada`).toBeGreaterThanOrEqual(0);
  const fim = SCRIPT.indexOf('\nfunction ', inicio + 1);
  return SCRIPT.slice(inicio, fim === -1 ? undefined : fim);
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PROCESSOVIVO_PROVIDER_CHAIN: 'mock-crawler-tjsp',
    LOG_LEVEL: 'silent',
    PROCESSOVIVO_API_KEYS: 'chave-de-teste-1234567890',
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe('configuração das janelas (v0.32.1)', () => {
  it('os padrões são 15 dias de atualizações e 10 de pendência', () => {
    const c = carregarConfig(env());
    expect(c.telas).toEqual({ novidadesJanelaDias: 15, pendenciaJanelaDias: 10 });
  });

  it('as duas vêm do ambiente', () => {
    const c = carregarConfig(
      env({ NOVIDADES_JANELA_DIAS: '30', PENDENCIA_JANELA_DIAS: '7' }),
    );
    expect(c.telas).toEqual({ novidadesJanelaDias: 30, pendenciaJanelaDias: 7 });
  });
});

describe('tela de Atualizações — uma linha por processo', () => {
  it('a página carrega o módulo e o console chama os ganchos dele', () => {
    const html = paginaConsole('0.0.0');
    expect(html).toContain(SCRIPT_ATUALIZACOES.trim().slice(0, 40));
    expect(html).toContain(ESTILOS_ATUALIZACOES.trim().slice(0, 40));
    const v = corpoDe('verNovidades');
    expect(v).toContain('window.__pvAtualizacoes.esqueleto(');
    expect(v).toContain('window.__pvAtualizacoes.montar(');
    // A tela não reagrupa nem reclassifica: a tabela e os filtros moram no módulo.
    expect(SCRIPT).not.toContain('nvt-');
    expect(SCRIPT).not.toContain('nov-grupo');
  });

  it('os cartões do topo e a coluna "Peças baixadas" saíram da página inicial (v0.37.0)', () => {
    for (const fantasma of [
      'cardsDoPainel',
      'blocoPecasBaixadas',
      'Processos ativos',
      'Peças baixadas hoje',
      'class="trilho"',
      'duas-colunas',
    ]) {
      expect(SCRIPT, fantasma).not.toContain(fantasma);
      expect(SCRIPT_ATUALIZACOES, fantasma).not.toContain(fantasma);
    }
    expect(ESTILOS_ATUALIZACOES).not.toContain('.baixa');
  });

  it('o período é filtro opcional do módulo: "Todas" é o padrão e o aviso fala de PROCESSOS (v0.37.3)', () => {
    expect(SCRIPT_ATUALIZACOES).toContain('>Todas<');
    expect(SCRIPT_ATUALIZACOES).toContain('sem atualização');
    expect(SCRIPT_ATUALIZACOES).toContain('Ver todos');
    // O padrão do console é "Todas": só pede a janela quem a ligou.
    expect(SCRIPT).toContain("window.__f_nv_janela==='padrao'?'':'&janela=todas'");
    // A mensagem antiga, que falava de atualizações e escondia o processo, saiu.
    expect(SCRIPT_ATUALIZACOES).not.toContain('não mostrada');
  });

  it('processo sem novidade: linha própria, sem detecção e sem texto de ato sigiloso', () => {
    expect(SCRIPT_ATUALIZACOES).toContain('Nenhuma movimentação conhecida');
    expect(SCRIPT_ATUALIZACOES).toContain('sem detecção registrada');
    expect(SCRIPT_ATUALIZACOES).toContain('Última movimentação conhecida');
    expect(SCRIPT_ATUALIZACOES).toContain('O texto do ato não é exibido aqui');
  });

  it('exigeAcao só MARCA: o módulo nunca filtra por ele', () => {
    expect(SCRIPT_ATUALIZACOES).not.toMatch(/\.filter\([^)]*exigeAcao/);
    expect(SCRIPT_ATUALIZACOES).not.toMatch(/!\s*\w+\.exigeAcao\)\s*return/);
  });

  it('não carrega nada de fora e não anuncia prazo', () => {
    expect(SCRIPT_ATUALIZACOES).not.toMatch(/https?:\/\/|<script|<link/i);
    expect(ESTILOS_ATUALIZACOES).not.toMatch(/https?:\/\/|@import|url\(/);
    expect(SCRIPT_ATUALIZACOES).not.toMatch(/prazos? em /i);
  });
});

describe('tela do processo — ordem dos blocos', () => {
  const corpo = corpoDe('processoHtml');
  const pos = (marca: string): number => {
    const i = corpo.indexOf(marca);
    expect(i, marca).toBeGreaterThan(-1);
    return i;
  };

  it('as peças vêm logo depois dos dados do processo, depois as partes e a linha do tempo', () => {
    const ordem = [
      pos('class="capa"'),
      pos('class="fatos"'), // dados do processo
      pos('id="pecas-resumo"'), // card "Peças do processo"
      pos('<h3 class="sec">Partes</h3>'),
      pos("'Linha do tempo'"),
    ];
    expect([...ordem].sort((a, b) => a - b)).toEqual(ordem);
  });

  it('v0.41.1: os blocos "Pede providência" e "Última movimentação" saíram da tela do processo', () => {
    // A apresentação saiu; a detecção, não. A janela segue sendo lida só pelas telas que
    // ainda mostram a pendência (Atualizações), nunca pela tela do processo.
    // O chip "Pede providência" do filtro da linha do tempo continua (é a marca do ato).
    expect(corpo).not.toMatch(/Pede providência\s*·/);
    expect(corpo).not.toContain('Última movimentação');
    expect(corpo).not.toContain('pendenciaJanelaDias');
    expect(corpo).not.toContain('veja na linha do tempo');
    expect(corpo).not.toContain('class="agora"');
    expect(corpo).not.toContain('cartao alerta');
  });

  it('a linha do tempo continua marcando o ato fora da janela (a marca é exigeAcao, sem data)', () => {
    expect(SCRIPT).toMatch(
      /filtro==='acao'\)vis=base\.filter\(function\(m\)\{return m\.exigeAcao\}\)/,
    );
  });

  it('o filtro "Pedem providência" diz a janela que veio do servidor, não um número escrito na tela', () => {
    expect(SCRIPT_ATUALIZACOES).toContain('R.pendenciaJanelaDias');
    expect(SCRIPT_ATUALIZACOES).not.toMatch(/\b(10|30) dias/);
  });

  it('o texto do filtro e dos selos nunca fala em prazo', () => {
    // A palavra pode aparecer em comentário do arquivo, mas não em texto que vai à tela.
    const textos = SCRIPT_ATUALIZACOES.match(/'[^'\n]*'/g) ?? [];
    // Única ocorrência permitida (v0.37.4): o aviso de honestidade, que NEGA a contagem.
    const semAviso = textos.filter(
      (t) => /prazo/i.test(t) && !/não é contagem de prazo/.test(t),
    );
    expect(semAviso).toEqual([]);
  });

  it('a aba abre em "Pedem providência" e o estado vive na página, nunca em localStorage (v0.37.4)', () => {
    expect(SCRIPT_ATUALIZACOES).toContain('var S={situacao:"providencia"');
    expect(SCRIPT_ATUALIZACOES).not.toMatch(/localStorage|sessionStorage/);
    // 0.46.1: a frase fixa saiu; a dica "confira no ato completo" fica no chip.
    expect(SCRIPT_ATUALIZACOES).not.toContain('não é contagem de prazo');
    expect(SCRIPT_ATUALIZACOES).toContain('confira no ato completo');
  });
});

describe('janela de pendência em um único lugar', () => {
  it('nenhum arquivo do servidor repete a conta em dias ou o número antigo', () => {
    const lerSrc = (rel: string): string =>
      readFileSync(resolve(__dirname, '../../src', rel), 'utf8');
    for (const rel of [
      'main/http/rotas/painel.ts',
      'main/http/rotas/acompanhamentos.ts',
    ]) {
      const fonte = lerSrc(rel);
      expect(fonte, rel).not.toMatch(/DIAS_DE_PENDENCIA/);
      expect(fonte, rel).not.toMatch(/\*\s*86_?400_?000/);
    }
    expect(lerSrc('domain/entities/estadoDaPasta.ts')).not.toContain('DIAS_DE_PENDENCIA');
  });
});

describe('selo de verificação por conta (v0.37.3; progresso e "demorando" só sem avanço na v0.49.3)', () => {
  it('o selo de uma rodada em curso vem do módulo da verificação, que o atualiza com o progresso', () => {
    // Reescrito na 0.49.3: antes o texto "demorando" morava aqui, preso a `ver.demorando`; agora `ui/verificacao.ts`
    // decide (e o servidor só marca `demorando` quando a fila PAROU de avançar).
    const selo = corpoDe('seloDeVerificacao');
    expect(selo).toContain('window.__pvVerificacao.selo(ver)');
    expect(selo).not.toContain('as fontes do tribunal estão lentas');
    expect(selo.indexOf('ver.emAndamento')).toBeLessThan(selo.indexOf('sem verificação'));
  });

  it('o clique delega ao módulo, que lê o estado DA CONTA, mostra "Na fila" e não dispara de novo', () => {
    // Reescrito na 0.49.3: o laço de consulta saiu de `dispararSync` (script.ts não cresce) e foi para ui/verificacao.ts.
    const disparo = corpoDe('dispararSync');
    expect(disparo).toContain('/v1/sincronizar');
    expect(disparo).toContain('window.__pvVerificacao.iniciar(b,r');
    expect(SCRIPT_VERIFICACAO).toContain('/v1/sincronizacao');
    expect(SCRIPT_VERIFICACAO).toContain('resposta.naFila');
    expect(SCRIPT_VERIFICACAO).toContain(
      "'Verificando '+est.concluidos+' de '+est.total",
    );
  });

  it('as frases do aviso: fila, progresso e demora sem culpar o tribunal; região viva discreta', () => {
    for (const f of [
      'Na fila: sua verificação começa quando a rodada atual terminar.',
      'A verificação está sem avançar há alguns minutos. As fontes dos tribunais podem estar lentas.',
      ' Última verificação às ',
      "aria-live','polite'",
      'ANUNCIO_MIN_MS=10000',
    ]) {
      expect(SCRIPT_VERIFICACAO, f).toContain(f);
    }
    expect(SCRIPT_VERIFICACAO).not.toContain('localStorage');
    expect(SCRIPT_VERIFICACAO.toLowerCase()).not.toContain('prazo');
  });
});

describe('linha compacta e ações em ícones (v0.49.2) — o contrato do arquivo', () => {
  it('cada ícone da fileira tem nome acessível próprio, a dica comum do console e texto só para os cartões', () => {
    for (const frase of [
      "icone(' nvt-copiar','copiar'",
      "'Copiar o número do processo '+esc(m),'Copiar número'",
      "'Abrir o processo '+esc(m),'Abrir o processo'",
      "'Abrir a pasta digital do processo '+esc(m),'Abrir a pasta do processo'",
      'prov().comDica(',
      'nvt-ic-t',
    ]) {
      expect(SCRIPT_ATUALIZACOES, frase).toContain(frase);
    }
    // Nenhum `title` de ícone: a dica (role=tooltip) o substituiu.
    expect(SCRIPT_ATUALIZACOES).not.toContain('title="Copiar o número"');
    expect(SCRIPT_ATUALIZACOES).not.toContain('title="Abrir o processo"');
    expect(SCRIPT_ATUALIZACOES).not.toContain('title="Abrir a pasta digital"');
  });

  it('o "Analisar com IA" é um ícone na fileira de Ações (aria-label, dica e texto só nos cartões) e o número não ganha pontos de quebra', () => {
    expect(SCRIPT_ATUALIZACOES).toContain(
      "ia().botao(g.numero,chaveDoAtoDaLinha(g))+'</div></td>'",
    );
    expect(SCRIPT_ATUALIZACOES).not.toContain('<wbr>');
    expect(SCRIPT_ATUALIZACOES).toContain('NOMES_CURTOS={dataAto:');
  });

  it('o aviso "Sem atualização detectada" divide a linha do ato, sem linha própria', () => {
    expect(SCRIPT_ATUALIZACOES).toContain('<div class="nvt-ato">');
    expect(SCRIPT_ATUALIZACOES).toContain('Sem atualização detectada');
    expect(SCRIPT_ATUALIZACOES).toContain('Última movimentação conhecida');
  });
});
