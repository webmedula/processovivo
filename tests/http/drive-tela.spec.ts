import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESTILOS_DRIVE, SCRIPT_DRIVE } from '../../src/main/http/ui/drive.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';
import { SCRIPT } from '../../src/main/http/ui/script.js';
import { SCRIPT_PASTA } from '../../src/main/http/ui/scriptPasta.js';

/* A tela do Drive (v0.42.0): contrato do arquivo, sem navegador. O comportamento está em drive-navegador. */

// Medido com `split("\n").length` (um a mais que `wc -l`): 2.356 linhas antes do Drive.
const LINHAS_DO_SCRIPT_ANTES_DO_DRIVE = 2357;

describe('tela do Google Drive — o contrato do arquivo', () => {
  it('o console inclui o script e os estilos do Drive, depois do calendário (que define __pvAoIniciar)', () => {
    const html = paginaConsole('0.0.0');
    expect(html).toContain(SCRIPT_DRIVE.trim().slice(0, 40));
    expect(html).toContain(ESTILOS_DRIVE.trim().slice(0, 40));
    expect(html.indexOf('window.__pvDrive=')).toBeGreaterThan(
      html.indexOf('window.__pvCalendario='),
    );
  });

  it('script.ts NÃO cresce: o gancho do cartão entrou na linha que já existia', () => {
    const linhas = readFileSync(
      resolve(__dirname, '../../src/main/http/ui/script.ts'),
      'utf8',
    ).split('\n').length;
    expect(linhas).toBeLessThanOrEqual(LINHAS_DO_SCRIPT_ANTES_DO_DRIVE);
    expect(SCRIPT).toContain('window.__pvDrive.cartao(alvo)');
    // A tela não mora no script do console: ele só a chama.
    expect(SCRIPT).not.toContain('drive-cartao');
    expect(SCRIPT).not.toContain('/v1/drive');
  });

  it('a Pasta só ganha os ganchos: o botão, a caixa e o aviso de seleção', () => {
    expect(SCRIPT_PASTA).toContain('id="pasta-drive-bt"');
    expect(SCRIPT_PASTA).toContain('id="pasta-drive-caixa"');
    expect(SCRIPT_PASTA).toContain('window.__pvDrive.ligarPasta(');
    expect(SCRIPT_PASTA).toContain('window.__pvDrive.selecaoMudou()');
    expect(SCRIPT_PASTA).not.toContain('/v1/drive');
  });

  it('o botão nasce escondido (com o recurso desligado, nada aparece) e o hidden vale mesmo com .bt', () => {
    expect(SCRIPT_PASTA).toMatch(/id="pasta-drive-bt" hidden/);
    expect(ESTILOS_DRIVE).toContain('#pasta #pasta-drive-bt[hidden]{display:none}');
  });

  it('não carrega nada de fora', () => {
    expect(SCRIPT_DRIVE).not.toMatch(
      /https?:\/\/(?!accounts\.google\.com\/|drive\.google\.com\/)/,
    );
    expect(SCRIPT_DRIVE).not.toMatch(/<script|<link/i);
    expect(ESTILOS_DRIVE).not.toMatch(/https?:\/\/|@import|url\(/);
  });

  it('só navega para o endereço de autorização do Google, e nunca para outro', () => {
    expect(SCRIPT_DRIVE).toContain("r.url.indexOf('https://accounts.google.com/')===0");
  });

  it('sem alert, confirm ou prompt (o desconectar confirma na própria tela)', () => {
    expect(SCRIPT_DRIVE).not.toMatch(/\b(alert|confirm|prompt)\s*\(/);
  });

  it('não usa a palavra "prazo" em texto novo, nem em comentário que vá à tela', () => {
    const visivel = SCRIPT_DRIVE.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(visivel).not.toMatch(/prazo/i);
  });

  it('o CSS só age no cartão do Drive, na caixa da Pasta ou no botão dela', () => {
    const corpo = ESTILOS_DRIVE.replace(/\/\*[\s\S]*?\*\//g, '');
    const seletores = corpo
      .split('}')
      .map((r) => r.split('{')[0]?.trim() ?? '')
      .filter(Boolean)
      .flatMap((s) => s.split(','))
      .map((s) => s.trim());
    for (const s of seletores) {
      expect(s, s).toMatch(
        /^(\.drive-cartao|#pasta #pasta-drive|#pasta \.pdrive|\.drive-sr)/,
      );
    }
  });

  it('texto de apoio usa --tinta2 (o --tinta3 global mede 4,2:1)', () => {
    expect(ESTILOS_DRIVE).not.toContain('--tinta3');
  });

  it('toda frase de erro e de plano é FIXA no arquivo — nada vem do servidor nem do Google', () => {
    expect(SCRIPT_DRIVE).not.toMatch(/\.mensagem\b/);
    expect(SCRIPT_DRIVE).toContain(
      'Salvar no Drive faz parte dos planos Peças e IA. Faça upgrade do plano para usar.',
    );
    // Sem prometer link de compra que não existe.
    expect(SCRIPT_DRIVE).not.toMatch(/comprar|assine|href="\/planos|loja/i);
  });
});
