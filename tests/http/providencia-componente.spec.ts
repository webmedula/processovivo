import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SCRIPT_PROVIDENCIA } from '../../src/main/http/ui/providencia.js';

/*
 * O componente da coluna "Cumprido" (v0.46.0; antes "Situação", v0.43.0), executado de verdade num contexto
 * isolado, sem navegador e sem rede: `window.__pv` é um dublê que só anota as chamadas à API. O que se prova
 * aqui é o HTML de cada estado (só a caixa e a dica, sem texto de estado) e que marcar/desmarcar fazem as
 * MESMAS duas chamadas da 0.43.0.
 */
interface Chamada {
  caminho: string;
  opcoes: { method: string; body?: unknown };
}
interface Linha {
  estado: 'pede' | 'cumprido' | 'nenhuma';
  caixa: boolean;
  marcado: boolean;
  chave: string;
}
interface Componente {
  celula(sit: Linha, num: string, mascara: string, foco: string): string;
  textoDaDica(marcado: boolean): string;
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

const PEDE: Linha = { estado: 'pede', caixa: true, marcado: false, chave: 'chave-ato' };
const CUMPRIDO: Linha = {
  estado: 'cumprido',
  caixa: true,
  marcado: true,
  chave: 'chave-ato',
};
const NENHUMA: Linha = { estado: 'nenhuma', caixa: false, marcado: false, chave: '' };
const NUM = '0001234-56.2026.8.09.0001';

describe('componente da caixa Cumprido (providencia.ts; na coluna Ações desde a 0.46.1)', () => {
  it('pede providência: caixa DESMARCADA e dica "Pede providência. Marque quando cumprida."', () => {
    const { comp } = carregar();
    const h = comp.celula(PEDE, NUM, NUM, 'cumprir-1');
    expect(h).toContain('<input type="checkbox"');
    expect(h).not.toContain(' checked');
    expect(h).toContain('data-chave="chave-ato"');
    expect(h).toMatch(
      /role="tooltip" id="dica-cumprido-00012345620268090001">Pede providência\. Marque quando cumprida\.</,
    );
    expect(h).toContain('aria-describedby="dica-cumprido-00012345620268090001"');
  });

  it('cumprida: caixa MARCADA (para poder desmarcar) e dica "Cumprida. Clique para desmarcar."', () => {
    const { comp } = carregar();
    const h = comp.celula(CUMPRIDO, NUM, NUM, 'cumprir-1');
    expect(h).toContain(' checked');
    expect(h).toContain('>Cumprida. Clique para desmarcar.</span>');
  });

  it('a caixa não tem texto de estado (sem "Pede providência" como rótulo, ponto ou botão); o único texto é o rótulo "Cumprido", que só o CSS do empilhado mostra', () => {
    const { comp } = carregar();
    for (const sit of [PEDE, CUMPRIDO]) {
      const h = comp.celula(sit, NUM, NUM, 'f');
      // Só a dica (escondida, ligada por aria-describedby) fala; fora dela não sobra texto.
      const fora = h.replace(/<span class="sit-dica"[^>]*>[^<]*<\/span>/, '');
      expect(fora.replace(/<[^>]*>/g, '').trim()).toBe('Cumprido');
      expect(h).toContain('<span class="sit-cx-txt">Cumprido</span>');
      expect(h).not.toMatch(/sit-ic|class="sit |<button|●|✓/);
    }
  });

  it('sem providência: só a VAGA (sem caixa, sem texto, escondida dos leitores de tela) que mantém os ícones alinhados', () => {
    const { comp } = carregar();
    const h = comp.celula(NENHUMA, NUM, NUM, 'f');
    expect(h).toBe('<span class="sit-vaga" aria-hidden="true"></span>');
    expect(h).not.toMatch(/<input|checkbox|Cumprido/);
  });

  it('a caixa é um <input type="checkbox"> real com nome acessível "Cumprido: processo …" e dica ligada por aria-describedby', () => {
    const { comp } = carregar();
    const h = comp.celula(PEDE, NUM, NUM, 'cumprir-1');
    expect(h).toContain('aria-label="Cumprido: processo 0001234-56.2026.8.09.0001"');
    expect(h).toContain('data-cx="cumprido"');
    expect(h).toContain('data-foco="cumprir-1"');
    // a dica fica FORA do rótulo: clicar nela não marca
    expect(h).toMatch(/<\/label><span class="sit-dica"/);
  });

  it('"pede" sem ato marcável (servidor antigo): caixa desabilitada, sinal mantido e a tela não inventa a chave', () => {
    const { comp } = carregar();
    const h = comp.celula({ ...PEDE, caixa: false, chave: '' }, NUM, NUM, 'f');
    expect(h).toContain(' disabled');
    expect(h).toContain('data-chave=""');
    expect(h).toContain('Pede providência, sem ato marcável');
  });

  it('o que vem do servidor é escapado (chave e número nunca viram marcação)', () => {
    const { comp } = carregar();
    expect(
      comp.celula({ ...PEDE, chave: '"><img src=x onerror=1>' }, '1', '1', 'f'),
    ).not.toContain('<img');
    expect(comp.celula(PEDE, '<b>1', '<script>x</script>', 'f')).not.toMatch(
      /<script>|<b>/,
    );
  });

  it('marcar e desmarcar fazem as MESMAS chamadas da 0.43.0: POST { chaveDoAto } e DELETE, no mesmo caminho', async () => {
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

  it('não existe mais o botão "Marcar como cumprido", a confirmação "Sim, desfazer" nem o estado em texto', () => {
    expect(SCRIPT_PROVIDENCIA).not.toMatch(
      /Marcar como cumprido|Sim, desfazer|botaoCumprir|controleDeDesfazer|sit-pede|sit-cumprido|sit-nenhuma/,
    );
  });
});
