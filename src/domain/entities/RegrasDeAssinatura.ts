import { RegrasDeAssinaturaInvalidasError } from '../errors/index.js';
import { DIAS_DE_CARENCIA_PADRAO, DIAS_DE_TESTE } from './Assinatura.js';
import { descricaoDoRecurso, recursoImplementado } from './Plano.js';
import type { CodigoPlano, Plano } from './Plano.js';

/**
 * As regras que valem para TODA assinatura, e que o operador ajusta pelo
 * painel: quanto dura o teste, qual plano o teste libera e quantos dias de
 * carência depois do vencimento.
 *
 * **Nenhuma delas é retroativa, e isso é deliberado.** Teste mais curto vale
 * para quem se cadastrar depois da mudança — encurtar o teste de quem já está
 * testando seria mudar o trato no meio. Carência nova vale a partir da
 * próxima liberação de cada assinatura — a carência é gravada nela na hora em
 * que é liberada, como sempre foi.
 */
export interface RegrasDeAssinatura {
  readonly diasDeTeste: number;
  readonly planoDoTeste: CodigoPlano;
  readonly diasDeCarencia: number;
}

/**
 * O que valia antes de as regras serem editáveis — e o que vale enquanto
 * ninguém mudar nada. O teste libera `pecas` de propósito: um teste que só dá
 * acompanhamento mostra ao advogado exatamente o que o concorrente também faz,
 * e ele decide não assinar por uma razão que não é verdadeira.
 */
export const REGRAS_PADRAO: RegrasDeAssinatura = Object.freeze({
  diasDeTeste: DIAS_DE_TESTE,
  planoDoTeste: 'pecas',
  diasDeCarencia: DIAS_DE_CARENCIA_PADRAO,
});

export function validarRegras(
  regras: RegrasDeAssinatura,
  planos: readonly Plano[],
): void {
  if (
    !Number.isInteger(regras.diasDeTeste) ||
    regras.diasDeTeste < 1 ||
    regras.diasDeTeste > 90
  ) {
    throw new RegrasDeAssinaturaInvalidasError('O teste precisa durar de 1 a 90 dias.');
  }
  if (
    !Number.isInteger(regras.diasDeCarencia) ||
    regras.diasDeCarencia < 0 ||
    regras.diasDeCarencia > 60
  ) {
    throw new RegrasDeAssinaturaInvalidasError('A carência precisa ser de 0 a 60 dias.');
  }

  const plano = planos.find((p) => p.codigo === regras.planoDoTeste);
  if (!plano) {
    throw new RegrasDeAssinaturaInvalidasError(
      `O plano do teste ("${regras.planoDoTeste}") não existe.`,
    );
  }
  // Mesma trava de `validarPlano` para venda, aplicada ao teste: dar de
  // presente um recurso que não funciona é prometer o que não se entrega,
  // tanto quanto vendê-lo.
  const ausentes = plano.recursos.filter((r) => !recursoImplementado(r));
  if (ausentes.length > 0) {
    throw new RegrasDeAssinaturaInvalidasError(
      `O plano ${plano.nome} inclui ${ausentes.map((r) => descricaoDoRecurso(r).frase).join(', ')}, ` +
        'que ainda não existe no sistema — não pode ser o plano do teste.',
    );
  }
}
