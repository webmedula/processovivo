import { describe, expect, it } from 'vitest';
import { ServicoPlanos } from '../../src/application/services/ServicoPlanos.js';
import type { NovoPlano } from '../../src/application/services/ServicoPlanos.js';
import { Assinatura } from '../../src/domain/entities/Assinatura.js';
import {
  PlanoDesconhecidoError,
  PlanoInvalidoError,
  PlanoJaExisteError,
  RegrasDeAssinaturaInvalidasError,
} from '../../src/domain/errors/index.js';
import type { RepositorioAssinaturas } from '../../src/domain/ports/RepositorioAssinaturas.js';
import { loggerSilencioso } from '../../src/infrastructure/logging/ConsoleLogger.js';
import { PlanosEmMemoria, RegrasEmMemoria } from '../helpers/planos.js';

const T0 = new Date('2026-09-28T12:00:00.000Z');
const dias = (n: number): Date => new Date(T0.getTime() + n * 86_400_000);

function assinaturasCom(lista: readonly Assinatura[]): RepositorioAssinaturas {
  // Só `todas` entra em jogo na visão geral.
  return { todas: async () => lista } as unknown as RepositorioAssinaturas;
}

function montar(assinaturas: readonly Assinatura[] = []): {
  servico: ServicoPlanos;
  planos: PlanosEmMemoria;
  regras: RegrasEmMemoria;
} {
  const planos = new PlanosEmMemoria();
  const regras = new RegrasEmMemoria();
  const servico = new ServicoPlanos({
    planos,
    regras,
    assinaturas: assinaturasCom(assinaturas),
    logger: loggerSilencioso,
    agora: () => T0,
  });
  return { servico, planos, regras };
}

const NOVO: NovoPlano = {
  codigo: 'escritorio',
  nome: 'Escritório',
  resumo: 'Peças, com atendimento prioritário.',
  recursos: ['consulta', 'acompanhamento', 'vigilancia', 'pecas'],
  disponivelParaContratacao: true,
  precoMensalCentavos: 19900,
};

function assinatura(workspace: string, plano: string, venceEmDias: number, ehTeste = false): Assinatura {
  return new Assinatura({
    workspace,
    plano,
    inicioEm: dias(-30),
    venceEm: dias(venceEmDias),
    ehTeste,
    diasDeCarencia: ehTeste ? 0 : 7,
  });
}

describe('ServicoPlanos — visão geral', () => {
  it('conta assinantes por plano e por status derivado', async () => {
    const { servico } = montar([
      assinatura('a', 'pecas', 30),
      assinatura('b', 'pecas', 10, true),
      assinatura('c', 'pecas', -3), // em carência
      assinatura('d', 'pecas', -30), // vencida
      assinatura('e', 'acompanhamento', 30),
    ]);

    const visao = await servico.visaoGeral();
    const pecas = visao.find((p) => p.codigo === 'pecas');
    expect(pecas?.assinantes).toEqual({ ativa: 1, teste: 1, carencia: 1, vencida: 1, cancelada: 0 });
    expect(pecas?.ehPlanoDoTeste).toBe(true);
    expect(visao.find((p) => p.codigo === 'ia')?.assinantes.ativa).toBe(0);
    // Na ordem configurada, do menor para o maior.
    expect(visao.map((p) => p.codigo)).toEqual(['acompanhamento', 'pecas', 'ia']);
  });
});

describe('ServicoPlanos — criar', () => {
  it('cria no fim da lista quando a ordem não é informada', async () => {
    const { servico, planos } = montar();
    const criado = await servico.criar(NOVO);

    expect(criado.ordem).toBe(40);
    expect(await planos.porCodigo('escritorio')).toEqual(criado);
    expect((await servico.aVenda()).map((p) => p.codigo)).toContain('escritorio');
  });

  it('normaliza o código para minúsculas e tira espaços das pontas', async () => {
    const { servico } = montar();
    const criado = await servico.criar({ ...NOVO, codigo: '  Escritorio ', nome: '  Escritório  ' });
    expect(criado.codigo).toBe('escritorio');
    expect(criado.nome).toBe('Escritório');
  });

  it('plano novo inclui o calendário e o centro de custos por padrão, mesmo que o formulário não os marque', async () => {
    const { servico } = montar();
    const criado = await servico.criar({ ...NOVO, recursos: ['consulta'] });
    expect(criado.recursos).toEqual(['consulta', 'calendario', 'custosDoProcesso']);
    const comEle = await servico.criar({
      ...NOVO,
      codigo: 'outro',
      recursos: ['calendario', 'consulta'],
    });
    expect(comEle.recursos).toEqual(['calendario', 'consulta', 'custosDoProcesso']);
    // Tirar depois, pela edição, continua possível: é o operador decidindo.
    const sem = await servico.atualizar('outro', { recursos: ['consulta'] });
    expect(sem.recursos).toEqual(['consulta']);
  });

  it('recusa código repetido', async () => {
    const { servico } = montar();
    await expect(servico.criar({ ...NOVO, codigo: 'pecas' })).rejects.toThrow(PlanoJaExisteError);
  });

  /*
   * REESCRITO na v0.50.0: antes recusava por `analiseIa` "não existir" (implementado: false). A IA passou a
   * ser vendável por DADO; o que segue recusado é o plano com IA à venda SEM preço (recurso cobrado por uso).
   */
  it('recusa criar à venda, sem preço, um plano com a análise por IA (custa a cada uso)', async () => {
    const { servico, planos } = montar();
    await expect(
      servico.criar({ ...NOVO, recursos: ['consulta', 'analiseIa'], precoMensalCentavos: null }),
    ).rejects.toThrow(PlanoInvalidoError);
    expect(await planos.porCodigo('escritorio')).toBeUndefined();
  });

  it('cria à venda um plano com a análise por IA quando tem preço', async () => {
    const { servico } = montar();
    const criado = await servico.criar({
      ...NOVO,
      recursos: ['consulta', 'analiseIa'],
      precoMensalCentavos: 9990,
    });
    expect(criado.disponivelParaContratacao).toBe(true);
  });
});

describe('ServicoPlanos — atualizar', () => {
  it('muda só o que veio, e mantém o resto', async () => {
    const { servico } = montar();
    const depois = await servico.atualizar('pecas', { precoMensalCentavos: 9990 });

    expect(depois.precoMensalCentavos).toBe(9990);
    expect(depois.nome).toBe('Peças');
    expect(depois.disponivelParaContratacao).toBe(true);
  });

  it('pausar e voltar à venda', async () => {
    const { servico } = montar();
    await servico.atualizar('acompanhamento', { disponivelParaContratacao: false });
    expect((await servico.aVenda()).map((p) => p.codigo)).toEqual(['pecas']);

    await servico.atualizar('acompanhamento', { disponivelParaContratacao: true });
    expect((await servico.aVenda()).map((p) => p.codigo)).toEqual(['acompanhamento', 'pecas']);
  });

  /*
   * REESCRITO na v0.50.0: a trava fixa ("a análise ainda não existe") virou regra de dado — o plano IA vai à
   * venda quando o operador põe PREÇO e "à venda" no /admin; sem preço continua recusado.
   */
  it('o plano de IA não vai à venda sem preço, e vai com preço e "à venda"', async () => {
    const { servico, planos } = montar();
    await expect(
      servico.atualizar('ia', { disponivelParaContratacao: true }),
    ).rejects.toThrow(/Defina o preço/);
    expect((await planos.porCodigo('ia'))?.disponivelParaContratacao).toBe(false);

    const depois = await servico.atualizar('ia', {
      disponivelParaContratacao: true,
      precoMensalCentavos: 9990,
    });
    expect(depois.disponivelParaContratacao).toBe(true);
    expect((await servico.aVenda()).map((p) => p.codigo)).toContain('ia');
    // Com preço e à venda, tirar o preço é recusado: nunca "IA à venda sem valor".
    await expect(
      servico.atualizar('ia', { precoMensalCentavos: null }),
    ).rejects.toThrow(/Defina o preço/);
  });

  it('recusa uma edição que tornaria inválido o plano do teste', async () => {
    // Pela porta dos fundos: as regras apontam para `pecas`, e dar a ele a análise por IA
    // faria o teste grátis presentear um recurso que custa a cada uso (v0.50.0).
    const { servico, planos } = montar();
    await expect(
      servico.atualizar('pecas', {
        disponivelParaContratacao: false,
        recursos: ['consulta', 'pecas', 'analiseIa'],
      }),
    ).rejects.toThrow(RegrasDeAssinaturaInvalidasError);
    expect((await planos.porCodigo('pecas'))?.recursos).not.toContain('analiseIa');
  });

  it('plano que não existe', async () => {
    const { servico } = montar();
    await expect(servico.atualizar('platina', { nome: 'x' })).rejects.toThrow(
      PlanoDesconhecidoError,
    );
  });
});

describe('ServicoPlanos — regras', () => {
  it('grava regras válidas', async () => {
    const { servico, regras } = montar();
    await servico.definirRegras({ diasDeTeste: 7, planoDoTeste: 'acompanhamento', diasDeCarencia: 3 });
    expect(regras.regras).toEqual({ diasDeTeste: 7, planoDoTeste: 'acompanhamento', diasDeCarencia: 3 });
  });

  it('recusa e NÃO grava regras inválidas', async () => {
    const { servico, regras } = montar();
    const antes = regras.regras;
    await expect(
      servico.definirRegras({ diasDeTeste: 7, planoDoTeste: 'ia', diasDeCarencia: 3 }),
    ).rejects.toThrow(RegrasDeAssinaturaInvalidasError);
    expect(regras.regras).toBe(antes);
  });
});
