import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESTILOS_CUSTOS, SCRIPT_CUSTOS } from '../../src/main/http/ui/custos.js';
import {
  ESTILOS_CUSTOS_CLIENTE,
  SCRIPT_CUSTOS_CLIENTE,
} from '../../src/main/http/ui/custosPorCliente.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';
import {
  campoDeCentavos,
  centavosDeTexto,
  reaisDeCentavos,
} from '../../src/domain/entities/valorEmReais.js';

/* A tela do centro de custos (v0.47.0): contrato do arquivo, sem navegador. O comportamento está em custos-navegador. */

// Medido com `split("\n").length`: o script do console tinha 2.357 antes do centro de custos.
const LINHAS_DO_SCRIPT_ANTES_DOS_CUSTOS = 2357;

describe('tela do centro de custos — o contrato do arquivo', () => {
  it('v0.49.0: o menu "Custos" vem logo depois de "Calendário", e a tela por cliente é um arquivo à parte', () => {
    const html = paginaConsole('0.0.0');
    const iCal = html.indexOf('id="nav-calendario"');
    const iCustos = html.indexOf('id="nav-custos"');
    const iBuscar = html.indexOf('id="nav-buscar"');
    expect(iCal).toBeGreaterThan(0);
    expect(iCustos).toBeGreaterThan(iCal);
    expect(iBuscar).toBeGreaterThan(iCustos);
    expect(html).toContain(SCRIPT_CUSTOS_CLIENTE.trim().slice(0, 40));
    expect(html).toContain(ESTILOS_CUSTOS_CLIENTE.trim().slice(0, 40));
    expect(html).toContain('window.__pvCustosCliente=');
    const fonte = readFileSync(
      resolve(__dirname, '../../src/main/http/ui/script.ts'),
      'utf8',
    );
    expect(fonte).toContain("estado.aba==='custos'&&window.__pvCustosCliente");
    // "Deixar de acompanhar" avisa do rótulo de cliente antes de apagar o acompanhamento.
    expect(fonte).toContain('window.__pvCustos.avisoAoParar(numero)');
  });

  it('a tela por cliente: aviso de "Sem cliente", "Mostrando X de Y", filtros e relatórios, sem localStorage nem prazo', () => {
    for (const frase of [
      'Mostrando',
      'Somente com saldo a cobrar',
      'estão sem cliente',
      'Os custos não se perdem',
      'Gerar prestação de contas do cliente (PDF)',
      'Exportar planilha (CSV)',
      'Incluir cancelados na planilha (marcados)',
    ]) {
      expect(SCRIPT_CUSTOS_CLIENTE, frase).toContain(frase);
    }
    expect(SCRIPT_CUSTOS_CLIENTE).not.toContain('localStorage');
    expect(SCRIPT_CUSTOS_CLIENTE.toLowerCase()).not.toContain('prazo');
    expect(SCRIPT_CUSTOS_CLIENTE).not.toMatch(/https?:\/\//);
    // Todo texto vindo do servidor passa por esc().
    for (const campo of ['c.nome', 'd.nome', 'p.formatado', 'p.tribunal', 'c.chave']) {
      const cru = new RegExp(`\\+\\s*${campo.replace('.', '\\.')}\\s*\\+`);
      expect(cru.test(SCRIPT_CUSTOS_CLIENTE), campo).toBe(false);
    }
  });

  it('comprovantes na tela: link para o Drive só do domínio do Google, em nova aba e com noopener noreferrer', () => {
    expect(SCRIPT_CUSTOS).toContain('target="_blank" rel="noopener noreferrer"');
    expect(SCRIPT_CUSTOS).toContain('linkSeguro(');
    expect(SCRIPT_CUSTOS).toContain('O arquivo continua no seu Google Drive');
    expect(SCRIPT_CUSTOS).toContain(
      'Conecte o Google Drive em Meus acessos para anexar comprovantes.',
    );
    for (const campo of ['c.nome', 'c.link']) {
      const cru = new RegExp(`\\+\\s*${campo.replace('.', '\\.')}\\s*\\+`);
      expect(cru.test(SCRIPT_CUSTOS), campo).toBe(false);
    }
  });

  it('o console inclui o script e os estilos, depois do calendário e do resumo', () => {
    const html = paginaConsole('0.0.0');
    expect(html).toContain(SCRIPT_CUSTOS.trim().slice(0, 40));
    expect(html).toContain(ESTILOS_CUSTOS.trim().slice(0, 40));
    expect(html.indexOf('window.__pvCustos=')).toBeGreaterThan(
      html.indexOf('window.__pvResumoIA='),
    );
  });

  it('script.ts NÃO cresce: os dois ganchos entraram em linhas que já existiam', () => {
    const fonte = readFileSync(
      resolve(__dirname, '../../src/main/http/ui/script.ts'),
      'utf8',
    );
    expect(fonte.split('\n').length).toBeLessThanOrEqual(
      LINHAS_DO_SCRIPT_ANTES_DOS_CUSTOS,
    );
    expect(fonte).toContain('window.__pvCustos.aposDesenhar(numero)');
    expect(fonte).toContain('window.__pvCustos.sair()');
    // A tela não mora no script do console: ele só a chama.
    expect(fonte).not.toContain('prestacao.pdf');
    expect(fonte).not.toContain('cust-painel');
  });

  it('o navegador recebe as MESMAS funções de dinheiro que o servidor e os testes exercitam', () => {
    for (const f of [centavosDeTexto, reaisDeCentavos, campoDeCentavos]) {
      expect(SCRIPT_CUSTOS).toContain(`var ${f.name}=${f.toString()};`);
    }
    // E, executadas como o navegador as recebe, dão os mesmos resultados.
    const nocorpo = (nome: string): string => {
      const i = SCRIPT_CUSTOS.indexOf(`var ${nome}=`);
      const fim = SCRIPT_CUSTOS.indexOf('\nvar ', i + 1);
      return SCRIPT_CUSTOS.slice(i, fim);
    };
    const f = new Function(
      `${nocorpo('centavosDeTexto')}\n${nocorpo('reaisDeCentavos')}\n${nocorpo('campoDeCentavos')}
       return {c:centavosDeTexto,r:reaisDeCentavos,e:campoDeCentavos};`,
    )() as { c(t: unknown): number | null; r(n: number): string; e(n: number): string };
    for (const t of [
      '1.234,56',
      '1234,56',
      '0,01',
      '0',
      '-1',
      'abc',
      'NaN',
      '1234.56',
      '99999999999999,99',
    ]) {
      expect(f.c(t), t).toBe(centavosDeTexto(t));
    }
    expect(f.r(123_456)).toBe('R$ 1.234,56');
    expect(f.e(123_456)).toBe('1234,56');
  });

  it('nenhum dado vai a localStorage e o texto de lançamento nunca entra no HTML sem esc()', () => {
    expect(SCRIPT_CUSTOS).not.toContain('localStorage');
    expect(SCRIPT_CUSTOS).not.toContain('sessionStorage');
    // Interpolação crua de campo de texto do usuário em HTML: `'+l.descricao+'` sem esc().
    for (const campo of [
      'l.descricao',
      'r.descricao',
      'r.nomeNova',
      's.nome',
      'c.nome',
      'x.motivoDoCancelamento',
      'r.observacao',
      'e.motivo',
      'h.titulo',
    ]) {
      const cru = new RegExp(`\\+\\s*${campo.replace('.', '\\.')}\\s*\\+`);
      expect(cru.test(SCRIPT_CUSTOS), campo).toBe(false);
    }
  });

  it('a tela da 0.48.0: sem "Ressarcido" por lançamento e sem exclusão; com recebimentos, cancelar e histórico', () => {
    // A caixa "Ressarcido" e o "Excluído. Desfazer" (que recriava o registro) saíram.
    expect(SCRIPT_CUSTOS).not.toContain('ressarcimento');
    expect(SCRIPT_CUSTOS).not.toContain('Excluído');
    expect(SCRIPT_CUSTOS).not.toMatch(
      /method:\s*'DELETE'\}\)\.then\(function\(\)\{\s*S\.confirmando/,
    );
    for (const frase of [
      'Recebimentos do cliente',
      'Registrar recebimento',
      'Crédito do cliente',
      'Mostrar cancelados',
      'Cancelado. Desfazer',
      'Histórico',
      'Depósitos e garantias não entram no total de despesas.',
      'Pago por',
    ]) {
      expect(
        SCRIPT_CUSTOS.replace(
          '<span>Cancelado.</span> <button',
          'Cancelado. Desfazer<button',
        ),
      ).toContain(frase);
    }
    // As únicas chamadas DELETE da tela: REATIVAR (…/cancelamento) e desfazer o VÍNCULO de um
    // comprovante (…/comprovantes/…) — nenhuma apaga lançamento ou recebimento.
    const deletes = SCRIPT_CUSTOS.match(/method:'DELETE'/g) ?? [];
    expect(deletes).toHaveLength(2);
    expect(SCRIPT_CUSTOS).toContain("+'/cancelamento',{method:'DELETE'}");
    expect(SCRIPT_CUSTOS).toContain(
      "'/comprovantes/'+encodeURIComponent(comp),{method:'DELETE'}",
    );
  });

  it('nenhuma frase fala em prazo', () => {
    expect(SCRIPT_CUSTOS.toLowerCase()).not.toContain('prazo');
  });

  it('o único recurso de rede é a própria API (nada de fonte, script ou imagem de fora)', () => {
    expect(SCRIPT_CUSTOS).not.toMatch(/https?:\/\//);
    expect(ESTILOS_CUSTOS).not.toMatch(/https?:\/\//);
  });
});
