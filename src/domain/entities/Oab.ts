import { OabInvalidaError } from '../errors/index.js';

const UFS = new Set([
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS',
  'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC',
  'SP', 'SE', 'TO',
]);

/**
 * Value Object da inscrição na OAB.
 *
 * A busca por OAB é o caso de uso que sustenta o produto (o advogado quer a
 * carteira inteira, não um processo por vez), e é justamente o que o DataJud
 * NÃO entrega — daí valer um tipo próprio em vez de duas strings soltas.
 */
export class Oab {
  private constructor(
    /** Somente dígitos, sem zeros à esquerda. */
    readonly numero: string,
    /** UF em maiúsculas. */
    readonly uf: string,
    /** Letra da subcategoria, quando informada (ex.: "N" de suplementar). */
    readonly letra: string | undefined,
  ) {
    Object.freeze(this);
  }

  /** @throws {OabInvalidaError} */
  static criar(numero: string, uf: string): Oab {
    const numeroBruto = (numero ?? '').trim().toUpperCase();
    const ufNormalizada = (uf ?? '').trim().toUpperCase();

    if (!UFS.has(ufNormalizada)) {
      throw new OabInvalidaError(`${numero}/${uf}`, `UF desconhecida "${uf}"`);
    }

    const match = /^(\d{1,7})([A-Z])?$/.exec(numeroBruto.replace(/[.\s-]/g, ''));
    if (!match?.[1]) {
      throw new OabInvalidaError(
        `${numero}/${uf}`,
        'esperado de 1 a 7 dígitos, com letra opcional ao final',
      );
    }

    const digitos = match[1].replace(/^0+(?=\d)/, '');
    return new Oab(digitos, ufNormalizada, match[2]);
  }

  static tentarCriar(numero: string, uf: string): Oab | null {
    try {
      return Oab.criar(numero, uf);
    } catch {
      return null;
    }
  }

  /** Ex.: "123456/SP" */
  get formatado(): string {
    return `${this.numero}${this.letra ?? ''}/${this.uf}`;
  }

  toString(): string {
    return this.formatado;
  }

  toJSON(): string {
    return this.formatado;
  }
}
