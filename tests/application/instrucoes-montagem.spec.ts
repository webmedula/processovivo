import { describe, expect, it } from 'vitest';
import {
  INSTRUCAO_DO_SISTEMA,
  prepararEntrada,
  type AtoParaAnalisar,
} from '../../src/application/politicas/entradaDoModelo.js';
import {
  INSTRUCAO_DA_PECA,
  montarEntradaDaPeca,
} from '../../src/application/politicas/entradaDaPeca.js';
import {
  INSTRUCAO_DO_RESUMO,
  INSTRUCAO_DO_RESUMO_1_0_0,
  INSTRUCAO_DO_RESUMO_1_1_0,
  prepararEntradaDoResumo,
} from '../../src/application/politicas/entradaDoResumo.js';
import { selecionarAtosParaResumo } from '../../src/application/politicas/selecionarAtosParaResumo.js';
import { lembreteFinal } from '../../src/domain/entities/InstrucoesDeIa.js';
import type { Movimentacao } from '../../src/domain/entities/Movimentacao.js';

/*
 * A regra do deploy: texto vazio = o prompt de antes, IDÊNTICO (nenhuma resposta da IA muda). Com texto, a
 * ordem é fixa → editável → lembrete, e o texto do CASO (a mensagem do usuário) não muda nunca.
 */

const BLOCO = 'Dê destaque ao prazo escrito e seja mais curto.';
const ATO: AtoParaAnalisar = {
  data: new Date('2099-10-05T12:00:00.000Z'),
  titulo: 'Despacho',
  conteudo:
    'Intime-se a parte autora para que se manifeste sobre o laudo pericial juntado aos autos, em quinze dias.',
};

describe('análise de ato', () => {
  it('sem instrução: o prompt de sistema é EXATAMENTE a constante de sempre', () => {
    expect(prepararEntrada(ATO).sistema).toBe(INSTRUCAO_DO_SISTEMA);
    expect(prepararEntrada(ATO, {}, { instrucao: '' }).sistema).toBe(
      INSTRUCAO_DO_SISTEMA,
    );
    expect(prepararEntrada(ATO, {}, { instrucao: '  \n ' }).sistema).toBe(
      INSTRUCAO_DO_SISTEMA,
    );
  });

  it('com instrução: fixa → bloco → lembrete; a mensagem do caso e o texto verificado não mudam', () => {
    const sem = prepararEntrada(ATO);
    const com = prepararEntrada(ATO, {}, { instrucao: BLOCO });
    expect(com.sistema.startsWith(INSTRUCAO_DO_SISTEMA)).toBe(true);
    expect(com.sistema.endsWith(lembreteFinal('ato'))).toBe(true);
    expect(com.sistema.indexOf(BLOCO)).toBeGreaterThan(INSTRUCAO_DO_SISTEMA.length - 1);
    expect(com.sistema.indexOf(BLOCO)).toBeLessThan(
      com.sistema.indexOf('LEMBRETE FINAL'),
    );
    expect(com.usuario).toBe(sem.usuario);
    expect(com.textoEnviado).toBe(sem.textoEnviado);
  });
});

describe('resumo do processo', () => {
  const movs: Movimentacao[] = [
    {
      data: new Date('2099-10-05T12:00:00.000Z'),
      titulo: 'Despacho',
      idExterno: 'djen:1',
      conteudo: ATO.conteudo as string,
    },
  ];
  const selecao = selecionarAtosParaResumo(movs, new Set());

  it('sem instrução: idêntico em cada versão do prompt', () => {
    expect(prepararEntradaDoResumo(selecao, {}, {}, {}).sistema).toBe(
      INSTRUCAO_DO_RESUMO,
    );
    expect(
      prepararEntradaDoResumo(selecao, {}, {}, { versao: 'resumo-1.1.0' }).sistema,
    ).toBe(INSTRUCAO_DO_RESUMO_1_1_0);
    expect(
      prepararEntradaDoResumo(selecao, {}, {}, { versao: 'resumo-1.0.0' }).sistema,
    ).toBe(INSTRUCAO_DO_RESUMO_1_0_0);
  });

  it('com instrução: fixa → bloco → lembrete, e a mensagem do caso é a mesma', () => {
    const sem = prepararEntradaDoResumo(selecao);
    const com = prepararEntradaDoResumo(selecao, {}, {}, { instrucao: BLOCO });
    expect(com.sistema.startsWith(INSTRUCAO_DO_RESUMO)).toBe(true);
    expect(com.sistema.endsWith(lembreteFinal('resumo'))).toBe(true);
    expect(com.sistema).toContain(BLOCO);
    expect(com.usuario).toBe(sem.usuario);
  });
});

describe('análise de peça', () => {
  const PAGINAS = [
    'PETIÇÃO INICIAL. A parte autora pede a restituição de valores pagos por um produto com defeito, conforme o documento anexo.',
  ];

  it('sem instrução: idêntico', () => {
    expect(montarEntradaDaPeca(PAGINAS).sistema).toBe(INSTRUCAO_DA_PECA);
    expect(montarEntradaDaPeca(PAGINAS, {}, { instrucao: '' }).sistema).toBe(
      INSTRUCAO_DA_PECA,
    );
  });

  it('com instrução: fixa → bloco → lembrete; páginas e recusas não mudam', () => {
    const sem = montarEntradaDaPeca(PAGINAS);
    const com = montarEntradaDaPeca(PAGINAS, {}, { instrucao: BLOCO });
    expect(com.sistema.startsWith(INSTRUCAO_DA_PECA)).toBe(true);
    expect(com.sistema.endsWith(lembreteFinal('peca'))).toBe(true);
    expect(com.usuario).toBe(sem.usuario);
    expect(com.textoEnviado).toBe(sem.textoEnviado);
    expect(com.suficiente).toBe(sem.suficiente);
  });
});
