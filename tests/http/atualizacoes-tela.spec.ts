import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { carregarConfig } from '../../src/infrastructure/config/env.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';
import { SCRIPT } from '../../src/main/http/ui/script.js';
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

describe('tela do processo — ordem e janela de pendência', () => {
  const corpo = corpoDe('processoHtml');
  const pos = (marca: string): number => {
    const i = corpo.indexOf(marca);
    expect(i, marca).toBeGreaterThan(-1);
    return i;
  };

  it('as peças vêm logo depois dos dados do processo; os demais blocos mantêm a ordem', () => {
    const ordem = [
      pos('class="capa"'),
      pos('class="fatos"'), // dados do processo
      pos('id="pecas-resumo"'), // card "Peças do processo"
      pos('Pede providência'),
      pos('Última movimentação'),
      pos('<h3 class="sec">Partes</h3>'),
      pos("'Linha do tempo'"),
    ];
    expect([...ordem].sort((a, b) => a - b)).toEqual(ordem);
  });

  it('o bloco "Pede providência" lê a janela que o servidor entrega, sem número próprio', () => {
    expect(corpo).toContain('estado.facetas.pendenciaJanelaDias');
    expect(corpo).toContain('veja na linha do tempo');
    expect(corpo).not.toMatch(/\b30\b/);
    expect(corpo).not.toContain('slice(0,5)');
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
    expect(SCRIPT_ATUALIZACOES).toContain(
      'Leitura automática do andamento, não é contagem de prazo. Confira no processo.',
    );
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

describe('selo de verificação por conta (v0.37.3)', () => {
  it('"demorando" para de girar e diz que as fontes estão lentas, com a última verificação', () => {
    const selo = corpoDe('seloDeVerificacao');
    expect(selo).toContain('ver.demorando');
    expect(selo).toContain('Verificação demorando: as fontes do tribunal estão lentas.');
    expect(selo).toContain('Última verificação às ');
    // O spinner só vem depois do caso "demorando".
    expect(selo.indexOf('ver.demorando')).toBeLessThan(selo.indexOf('Verificando agora'));
  });

  it('o clique lê o estado DA CONTA e não desiste nem dispara de novo', () => {
    const disparo = corpoDe('dispararSync');
    expect(disparo).toContain('/v1/sincronizacao');
    expect(disparo).toContain('jaEmAndamento');
    expect(disparo).toContain('s.demorando');
  });
});
