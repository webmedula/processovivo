import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCRIPT_PAGAMENTO } from '../../src/main/http/ui/pagamento.js';
import { paginaConsole } from '../../src/main/http/ui/pagina.js';

/* Invariantes da tela "Assinatura online" (v0.44.0) — o que o navegador não precisa provar de novo. */
// `split('\n').length` de `script.ts` na 0.43.0 (2.356 quebras de linha + a última).
const LINHAS_DO_SCRIPT_ANTES_DA_COBRANCA = 2357;

function lerFonte(caminho: string): string {
  return readFileSync(resolve(__dirname, '../..', caminho), 'utf8');
}

describe('tela da assinatura online', () => {
  it('script.ts NÃO cresce: os dois ganchos entraram em linhas que já existiam', () => {
    const fonte = lerFonte('src/main/http/ui/script.ts');
    expect(fonte.split('\n').length).toBeLessThanOrEqual(
      LINHAS_DO_SCRIPT_ANTES_DA_COBRANCA,
    );
    expect(fonte).toContain('window.__pvPagamento.cartao()');
    expect(fonte).toContain('window.__pvPagamento.ligar()');
    // A tela não mora no script do console: ele só a chama.
    expect(fonte).not.toContain('/v1/assinatura/checkout');
    expect(fonte).not.toContain('pgto-');
  });

  it('o script vai na página e só chama as três rotas do gateway da conta', () => {
    const html = paginaConsole('0.0.0');
    expect(html).toContain(SCRIPT_PAGAMENTO.trim().slice(0, 40));
    const rotas = [...SCRIPT_PAGAMENTO.matchAll(/'(\/v1\/[^']*)'/g)].map((m) => m[1]);
    expect([...new Set(rotas)].sort()).toEqual([
      '/v1/assinatura',
      '/v1/assinatura/checkout',
      '/v1/assinatura/recorrencia',
    ]);
  });

  // v0.49.5: o pedido passou a levar também o e-mail de quem vai pagar (o Mercado Pago recusa o pagamento quando o
  // e-mail do pagador não é o da assinatura); preço e valor continuam vindo só do servidor.
  it('o pedido de checkout leva o código do plano, o aceite e o e-mail do pagador: preço e valor nunca saem da tela', () => {
    expect(SCRIPT_PAGAMENTO).toContain(
      'body:{plano:codigo,aceiteTermos:true,emailDoPagador:email}',
    );
    // (as chaves `plano_sem_preco` e `conta_sem_email` são MOTIVOS de recusa, não campos do pedido)
    expect(SCRIPT_PAGAMENTO).not.toMatch(/\bvalor:|\bpreco:|\bemail:|payer/i);
  });

  it('o sistema nunca vê cartão: nenhum campo de número, validade ou código de segurança', () => {
    // Os únicos campos da tela são o e-mail de quem paga (v0.49.5) e a caixa de aceite dos Termos (v0.45.0).
    const campos = SCRIPT_PAGAMENTO.match(/<input[^>]*>/g) ?? [];
    expect(campos).toHaveLength(2);
    expect(campos.some((c) => c.includes('type="email"'))).toBe(true);
    expect(campos.some((c) => c.includes('type="checkbox"'))).toBe(true);
    expect(SCRIPT_PAGAMENTO).not.toMatch(/card_?number|cvv|cvc|security|validade|numero do cart/i);
  });

  it('só segue para o endereço do gateway se for https', () => {
    expect(SCRIPT_PAGAMENTO).toContain('/^https:\\/\\//i.test(r.urlDeCheckout)');
  });

  it('nada de alert/confirm, de localStorage nem de recurso externo', () => {
    expect(SCRIPT_PAGAMENTO).not.toMatch(
      /\balert\(|\bconfirm\(|localStorage|sessionStorage/,
    );
    expect(SCRIPT_PAGAMENTO).not.toMatch(/<script|<link|src=|https?:\/\/[a-z]/i);
  });

  it('as frases são FIXAS: a da renovação, a do aviso da conta do gateway e as de recusa por motivo', () => {
    expect(SCRIPT_PAGAMENTO).toContain(
      'Renovação automática. Você pode cancelar quando quiser.',
    );
    // v0.49.5: a frase antiga ("o e-mail dela pode ser diferente do do Processo Vivo") ficou FALSA — o e-mail do
    // pagador tem de ser o da assinatura —, então saiu; entraram a ajuda do campo e o aviso da assinatura pendente.
    expect(SCRIPT_PAGAMENTO).not.toContain('pode ser diferente do e-mail do Processo Vivo');
    expect(SCRIPT_PAGAMENTO).toContain(
      'Use o mesmo e-mail com o qual você vai entrar (ou pagar) no Mercado Pago. Se for outro, o Mercado Pago recusa o pagamento.',
    );
    expect(SCRIPT_PAGAMENTO).toContain('Seu pagamento não foi concluído?');
    expect(SCRIPT_PAGAMENTO).toContain('Tentar de novo');
    for (const motivo of [
      'plano_sem_preco',
      'plano_nao_vendavel',
      'ciclo_nao_suportado',
      'conta_sem_email',
      'ja_assinante',
      'sem_recorrencia',
    ]) {
      expect(SCRIPT_PAGAMENTO).toContain(motivo);
    }
    // O texto do servidor nunca vai à tela: `e.message` não é lido.
    expect(SCRIPT_PAGAMENTO).not.toContain('e.message');
  });

  it('a confirmação: caixa de aceite nasce DESMARCADA, o botão nasce desabilitado e o clique confere o aceite', () => {
    expect(SCRIPT_PAGAMENTO).toContain('var termosAceitos=false;');
    expect(SCRIPT_PAGAMENTO).toContain("(termosAceitos?' checked':'')");
    expect(SCRIPT_PAGAMENTO).toContain("(termosAceitos?'':' disabled')");
    expect(SCRIPT_PAGAMENTO).toContain('if(!termosAceitos||!codigo)return;');
    // O botão "Assinar" da lista NÃO chama o checkout: abre a confirmação.
    expect(SCRIPT_PAGAMENTO).toContain("abrirConfirmacao(b.getAttribute('data-assinar'))");
    expect(SCRIPT_PAGAMENTO.match(/\/v1\/assinatura\/checkout/g)).toHaveLength(1);
    expect(SCRIPT_PAGAMENTO).toContain('Ambiente de teste, nenhuma cobrança real.');
    expect(SCRIPT_PAGAMENTO).toContain('Continuar para o pagamento');
    expect(SCRIPT_PAGAMENTO).toContain('Para trocar de plano, cancele a renovação atual primeiro.');
    // Destaque por TEXTO, não só por cor.
    expect(SCRIPT_PAGAMENTO).toContain('Plano escolhido');
  });

  it('v0.45.1: uma frase NOSSA para cada motivo de falha do gateway, e o status sozinho (proxy com HTML) vale como indisponível', () => {
    for (const motivo of ['email_pagador', 'credencial', 'parametro_invalido', 'indisponivel', 'desconhecido']) {
      expect(SCRIPT_PAGAMENTO).toContain(`${motivo}:'`);
    }
    expect(SCRIPT_PAGAMENTO).toContain(
      "if(!motivo&&e&&(e.status===502||e.status===503||e.status===504))motivo='indisponivel';",
    );
    expect(SCRIPT_PAGAMENTO).toContain('Fale com a gente');
    // As frases não citam o gateway por dentro: nada de código de erro, e-mail ou endereço.
    expect(SCRIPT_PAGAMENTO).not.toContain('bad_request');
  });

  it('nada fala em prazo (o produto não anuncia contagem de prazo na cobrança)', () => {
    const textos = SCRIPT_PAGAMENTO.match(/'[^'\n]*'/g) ?? [];
    expect(textos.filter((t) => /prazo/i.test(t))).toEqual([]);
  });

  it('cancelar a renovação diz que o plano segue até o fim do período já pago', () => {
    expect(SCRIPT_PAGAMENTO).toContain('Seu plano continua valendo');
    expect(SCRIPT_PAGAMENTO).toContain('até o fim do período já pago');
  });

  it('com a cobrança desligada o cartão fica vazio', () => {
    expect(SCRIPT_PAGAMENTO).toContain(
      "if(!pg||!pg.habilitado){alvo.innerHTML='';return}",
    );
  });
});
