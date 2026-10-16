import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SCRIPT_PROVIDENCIA } from '../../src/main/http/ui/providencia.js';

/*
 * O componente da coluna Situação (v0.43.0), executado de verdade num contexto isolado, sem navegador
 * e sem rede: `window.__pv` é um dublê que só anota as chamadas à API. O que se prova aqui é o HTML de
 * cada estado e que marcar/desmarcar fazem as MESMAS duas chamadas que o botão antigo fazia.
 */
interface Chamada {
  caminho: string;
  opcoes: { method: string; body?: unknown };
}
interface Componente {
  estado(est: string, motivo: string | null, cumpridoEm: string | null): string;
  caixa(
    num: string,
    mascara: string,
    chave: string,
    marcado: boolean,
    foco: string,
  ): string;
  marcar(num: string, chave: string): Promise<unknown>;
  remover(num: string): Promise<unknown>;
}

function carregar(): { comp: Componente; chamadas: Chamada[] } {
  const chamadas: Chamada[] = [];
  const janela: Record<string, unknown> = {
    __pv: {
      esc: (s: unknown) =>
        String(s ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;'),
      dth: () => '05/10/2026 10:00',
      api: (caminho: string, opcoes: Chamada['opcoes']) => {
        chamadas.push({ caminho, opcoes });
        return Promise.resolve({ processo: { ok: true } });
      },
    },
  };
  runInNewContext(SCRIPT_PROVIDENCIA, { window: janela, encodeURIComponent, String });
  return { comp: janela['__pvProvidencia'] as Componente, chamadas };
}

describe('componente de Situação (providencia.ts)', () => {
  it('"pede providência": ponto aria-hidden + texto, em <span> (nunca botão), com o motivo no title', () => {
    const { comp } = carregar();
    const h = comp.estado('pede', 'Intimação nos últimos 10 dias', null);
    expect(h).toContain('class="sit sit-pede"');
    expect(h).toContain(
      '<span class="sit-ic" aria-hidden="true">●</span> Pede providência',
    );
    expect(h).toContain('Intimação nos últimos 10 dias');
    expect(h).not.toMatch(/<button|<a |onclick/);
  });

  it('"cumprido": ✓ + texto, e o title diz quando foi marcado sem falar em prazo', () => {
    const { comp } = carregar();
    const h = comp.estado('cumprido', null, '2026-10-05T10:00:00.000Z');
    expect(h).toContain('class="sit sit-cumprido"');
    expect(h).toContain('<span class="sit-ic" aria-hidden="true">✓</span> Cumprido');
    expect(h).toContain('Você marcou como cumprido em 05/10/2026 10:00');
    expect(h).not.toMatch(/prazo|<button/i);
  });

  it('sem providência: traço com texto para leitor de tela, sem caixa', () => {
    const { comp } = carregar();
    const h = comp.estado('nenhuma', null, null);
    expect(h).toContain('<span aria-hidden="true">—</span>');
    expect(h).toContain('Sem providência');
    expect(h).not.toContain('input');
  });

  it('a caixa é um <input type="checkbox"> real, com rótulo visível "Cumprido" e nome acessível que o contém', () => {
    const { comp } = carregar();
    const h = comp.caixa(
      '0001234-56.2026.8.09.0001',
      '0001234-56.2026.8.09.0001',
      'chave-ato',
      false,
      'cumprir-1',
    );
    expect(h).toMatch(/^<label class="sit-cx"><input type="checkbox"/);
    expect(h).toContain('<span class="sit-cx-txt">Cumprido</span>');
    expect(h).toContain('aria-label="Cumprido: processo 0001234-56.2026.8.09.0001"');
    expect(h).toContain('data-chave="chave-ato"');
    expect(h).not.toContain(' checked');
    expect(comp.caixa('1', '1', 'c', true, 'f')).toContain(' checked');
  });

  it('o que vem do servidor é escapado (chave e motivo nunca viram marcação)', () => {
    const { comp } = carregar();
    expect(comp.caixa('1', '1', '"><img src=x onerror=1>', false, 'f')).not.toContain(
      '<img',
    );
    expect(comp.estado('pede', '<script>x</script>', null)).not.toContain('<script>');
  });

  it('marcar e desmarcar fazem as MESMAS chamadas do botão antigo: POST { chaveDoAto } e DELETE, no mesmo caminho', async () => {
    const { comp, chamadas } = carregar();
    await comp.marcar('0001234-56.2026.8.09.0001', 'chave-ato');
    await comp.remover('00012345620268090001');
    expect(chamadas).toEqual([
      {
        caminho: '/v1/acompanhamentos/00012345620268090001/cumprido',
        opcoes: { method: 'POST', body: { chaveDoAto: 'chave-ato' } },
      },
      {
        caminho: '/v1/acompanhamentos/00012345620268090001/cumprido',
        opcoes: { method: 'DELETE' },
      },
    ]);
  });

  it('não existe mais o botão "Marcar como cumprido" nem a confirmação "Sim, desfazer"', () => {
    expect(SCRIPT_PROVIDENCIA).not.toMatch(
      /Marcar como cumprido|Sim, desfazer|botaoCumprir|controleDeDesfazer/,
    );
  });
});
