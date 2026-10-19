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

  it('o pedido de checkout leva SÓ o código do plano e o aceite: preço, valor e e-mail nunca saem da tela', () => {
    expect(SCRIPT_PAGAMENTO).toContain('body:{plano:codigo,aceiteTermos:true}');
    // (as chaves `plano_sem_preco` e `conta_sem_email` são MOTIVOS de recusa, não campos do pedido)
    expect(SCRIPT_PAGAMENTO).not.toMatch(/\bvalor:|\bpreco:|\bemail:|payer/i);
  });

  it('o sistema nunca vê cartão: nenhum campo de número, validade ou código de segurança', () => {
    // O único campo da tela é a caixa de aceite dos Termos (v0.45.0).
    const campos = SCRIPT_PAGAMENTO.match(/<input[^>]*>/g) ?? [];
    expect(campos).toHaveLength(1);
    expect(campos[0]).toContain('type="checkbox"');
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
    expect(SCRIPT_PAGAMENTO).toContain('entre com a conta de quem vai pagar');
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
    expect(SCRIPT_PAGAMENTO).toContain('if(!termosAceitos||!confirmar)return;');
    // O botão "Assinar" da lista NÃO chama o checkout: abre a confirmação.
    expect(SCRIPT_PAGAMENTO).toContain("abrirConfirmacao(b.getAttribute('data-assinar'))");
    expect(SCRIPT_PAGAMENTO.match(/\/v1\/assinatura\/checkout/g)).toHaveLength(1);
    expect(SCRIPT_PAGAMENTO).toContain('Ambiente de teste, nenhuma cobrança real.');
    expect(SCRIPT_PAGAMENTO).toContain('Continuar para o pagamento');
    expect(SCRIPT_PAGAMENTO).toContain('Para trocar de plano, cancele a renovação atual primeiro.');
    // Destaque por TEXTO, não só por cor.
    expect(SCRIPT_PAGAMENTO).toContain('Plano escolhido');
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
