import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCRIPT_PLANO_ESCOLHIDO } from '../../src/main/http/ui/planoEscolhido.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';

/* Invariantes do plano escolhido no site (v0.45.0) — o que o navegador não precisa provar de novo. */
const LINHAS_DO_SCRIPT_ANTES = 2357;

describe('plano escolhido no site — o script do console', () => {
  it('vai na página e script.ts NÃO cresce: o gancho entrou numa linha que já existia', () => {
    expect(paginaConsole('0.0.0')).toContain(SCRIPT_PLANO_ESCOLHIDO.trim().slice(0, 40));
    const fonte = readFileSync(
      resolve(__dirname, '../../src/main/http/ui/script.ts'),
      'utf8',
    );
    expect(fonte.split('\n').length).toBeLessThanOrEqual(LINHAS_DO_SCRIPT_ANTES);
    expect(fonte).toContain('window.__pvPlano.modoInicial()');
  });

  it('só um slug no formato do catálogo e de até 30 caracteres é guardado; o destino nunca vem da URL', () => {
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain('var FORMATO=/^[a-z][a-z0-9-]{1,29}$/;');
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain('p.length<=30&&FORMATO.test(p)');
    // Nada de redirecionar para o que veio da URL.
    expect(SCRIPT_PLANO_ESCOLHIDO).not.toMatch(
      /location\.(href|assign|replace)\s*=|location\.assign|window\.open/,
    );
  });

  it('`assinar` só vale como "1" e junto de um plano válido (a gravação é a mesma)', () => {
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain("assinar:busca.get('assinar')==='1'");
    const gravacoes = SCRIPT_PLANO_ESCOLHIDO.match(/gravar\(\{plano:p/g) ?? [];
    expect(gravacoes).toHaveLength(1);
  });

  it('sessionStorage por 30 minutos, com reserva em memória; nunca localStorage; os parâmetros saem da barra', () => {
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain('var VALIDADE_MS=30*60*1000;');
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain('sessionStorage.setItem');
    expect(SCRIPT_PLANO_ESCOLHIDO).not.toContain('localStorage');
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain(
      "busca.delete('plano');busca.delete('assinar');busca.delete('conta');",
    );
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain('history.replaceState');
  });

  it('só chama a vitrine pública e o gancho da confirmação; nunca o checkout (assinar abre a CONFIRMAÇÃO)', () => {
    const rotas = [...SCRIPT_PLANO_ESCOLHIDO.matchAll(/'(\/v1\/[^']*)'/g)].map(
      (m) => m[1],
    );
    expect([...new Set(rotas)]).toEqual(['/v1/planos']);
    expect(SCRIPT_PLANO_ESCOLHIDO).not.toContain('checkout');
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain(
      'window.__pvPagamento.preparar(achado.slug,o.assinar)',
    );
  });

  it('o plano é conferido contra o catálogo: assinável e com o pagamento ligado; senão cai no teste grátis', () => {
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain(
      'lista[i].slug===o.plano&&lista[i].assinavel===true',
    );
    expect(SCRIPT_PLANO_ESCOLHIDO).toContain('r.pagamentoDisponivel!==true');
  });

  it('nada de alert/confirm, innerHTML nem recurso externo', () => {
    expect(SCRIPT_PLANO_ESCOLHIDO).not.toMatch(
      /\b(alert|confirm|prompt)\s*\(|innerHTML|<script|<link|https?:\/\/[a-z]/i,
    );
  });
});
