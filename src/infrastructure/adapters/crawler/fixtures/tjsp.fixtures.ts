/**
 * Massa de teste simulando o que um crawler do e-SAJ (TJSP) extrairia da tela
 * de "Consulta de Processos de 1º Grau".
 *
 * Todos os números têm dígito verificador VÁLIDO — de propósito. Fixture com DV
 * inválido passa a suíte inteira sem exercitar `NumeroCNJ`, e o bug só aparece
 * contra o tribunal de verdade.
 *
 * Vocabulário do e-SAJ preservado onde importa (polo "Reqte"/"Reqdo", CPF
 * mascarado, despacho em texto corrido) para que o mapeamento seja realista.
 */

export interface AdvogadoFixture {
  nome: string;
  oab?: string;
  ufOab?: string;
}

export interface ParteFixture {
  nome: string;
  polo: 'ATIVO' | 'PASSIVO' | 'OUTROS';
  tipoPessoa: 'FISICA' | 'JURIDICA' | 'DESCONHECIDO';
  documento?: string;
  advogados: AdvogadoFixture[];
}

export interface MovimentacaoFixture {
  data: string;
  titulo: string;
  conteudo?: string;
}

export interface ProcessoFixture {
  numero: string;
  tribunal: string;
  vara: string;
  classe: string;
  assuntos: string[];
  dataDistribuicao: string;
  grau: string;
  valorCausa?: number;
  segredoJustica?: boolean;
  partes: ParteFixture[];
  movimentacoes: MovimentacaoFixture[];
}

export const PROCESSOS_TJSP: readonly ProcessoFixture[] = [
  {
    numero: '1234567-47.2023.8.26.0100',
    tribunal: 'TJSP',
    vara: '12ª Vara Cível do Foro Central Cível - Comarca de São Paulo',
    classe: 'Procedimento Comum Cível',
    assuntos: ['Rescisão do Contrato e Devolução do Dinheiro', 'Indenização por Dano Moral'],
    dataDistribuicao: '2023-03-14T09:12:00.000Z',
    grau: 'G1',
    valorCausa: 84500.0,
    partes: [
      {
        nome: 'Construtora Aurora Empreendimentos Ltda.',
        polo: 'ATIVO',
        tipoPessoa: 'JURIDICA',
        documento: '12.345.678/0001-90',
        advogados: [
          { nome: 'Mariana Duarte Coelho', oab: '234567', ufOab: 'SP' },
          { nome: 'Rafael Nogueira Prado', oab: '198432', ufOab: 'SP' },
        ],
      },
      {
        nome: 'Helena Vasconcelos Martins',
        polo: 'PASSIVO',
        tipoPessoa: 'FISICA',
        documento: '***.456.789-**',
        advogados: [{ nome: 'Otávio Bittencourt Lima', oab: '311204', ufOab: 'SP' }],
      },
    ],
    movimentacoes: [
      {
        data: '2024-11-08T14:03:00.000Z',
        titulo: 'Conclusos para decisão',
        conteudo:
          'Vistos. Considerando a juntada da contestação e a réplica já apresentada, ' +
          'especifiquem as partes, em 10 (dez) dias, as provas que pretendem produzir, ' +
          'justificando sua pertinência. Int.',
      },
      {
        data: '2024-10-22T11:47:00.000Z',
        titulo: 'Juntada de Petição de Réplica',
        conteudo:
          'Petição de réplica apresentada pela parte autora, refutando as preliminares ' +
          'de ilegitimidade passiva e prescrição arguidas em contestação.',
      },
      {
        data: '2024-09-30T16:20:00.000Z',
        titulo: 'Juntada de Petição de Contestação',
      },
      {
        data: '2023-03-14T09:12:00.000Z',
        titulo: 'Distribuído por sorteio',
      },
    ],
  },
  {
    numero: '0007652-12.2022.8.26.0224',
    tribunal: 'TJSP',
    vara: '3ª Vara Cível do Foro de Guarulhos',
    classe: 'Execução de Título Extrajudicial',
    assuntos: ['Cédula de Crédito Bancário'],
    dataDistribuicao: '2022-06-02T13:40:00.000Z',
    grau: 'G1',
    valorCausa: 231800.55,
    partes: [
      {
        nome: 'Banco Meridiano S.A.',
        polo: 'ATIVO',
        tipoPessoa: 'JURIDICA',
        documento: '98.765.432/0001-10',
        advogados: [{ nome: 'Mariana Duarte Coelho', oab: '234567', ufOab: 'SP' }],
      },
      {
        nome: 'Transportes Vale Verde Ltda. ME',
        polo: 'PASSIVO',
        tipoPessoa: 'JURIDICA',
        documento: '11.222.333/0001-44',
        advogados: [],
      },
    ],
    movimentacoes: [
      {
        data: '2025-02-17T10:05:00.000Z',
        titulo: 'Expedição de Certidão',
        conteudo:
          'Certifico e dou fé que decorreu o prazo legal sem manifestação da parte ' +
          'executada quanto à penhora realizada via SISBAJUD.',
      },
      {
        data: '2024-12-05T09:00:00.000Z',
        titulo: 'Penhora on-line - SISBAJUD',
      },
      {
        data: '2022-06-02T13:40:00.000Z',
        titulo: 'Distribuído por dependência',
      },
    ],
  },
  {
    numero: '1000234-92.2024.8.26.0011',
    tribunal: 'TJSP',
    vara: '2ª Vara Cível do Foro Regional de Pinheiros',
    classe: 'Procedimento do Juizado Especial Cível',
    assuntos: ['Fornecimento de Energia Elétrica'],
    dataDistribuicao: '2024-01-19T08:30:00.000Z',
    grau: 'G1',
    valorCausa: 15000.0,
    partes: [
      {
        nome: 'Paulo Sérgio Andrade',
        polo: 'ATIVO',
        tipoPessoa: 'FISICA',
        documento: '***.987.654-**',
        advogados: [{ nome: 'Rafael Nogueira Prado', oab: '198432', ufOab: 'SP' }],
      },
      {
        nome: 'Companhia Paulista de Energia S.A.',
        polo: 'PASSIVO',
        tipoPessoa: 'JURIDICA',
        documento: '55.444.333/0001-22',
        advogados: [{ nome: 'Departamento Jurídico CPE', oab: '150900', ufOab: 'SP' }],
      },
    ],
    movimentacoes: [
      {
        data: '2025-06-11T15:30:00.000Z',
        titulo: 'Audiência de conciliação designada',
        conteudo:
          'Designo audiência de conciliação para o dia 12/08/2025, às 14h00, ' +
          'a ser realizada por videoconferência.',
      },
      {
        data: '2024-01-19T08:30:00.000Z',
        titulo: 'Distribuído por sorteio',
      },
    ],
  },
  {
    numero: '5551234-79.2021.8.26.0053',
    tribunal: 'TJSP',
    vara: '7ª Vara de Fazenda Pública do Foro Central',
    classe: 'Mandado de Segurança Cível',
    assuntos: ['ICMS'],
    dataDistribuicao: '2021-11-08T10:15:00.000Z',
    grau: 'G1',
    segredoJustica: true,
    partes: [
      {
        nome: 'Parte protegida por segredo de justiça',
        polo: 'ATIVO',
        tipoPessoa: 'DESCONHECIDO',
        advogados: [],
      },
    ],
    movimentacoes: [
      {
        data: '2023-04-27T12:00:00.000Z',
        titulo: 'Sentença registrada',
      },
    ],
  },
];

/** Índice OAB (`numero/UF`) → números de processo, como um crawler montaria. */
export const PROCESSOS_POR_OAB: ReadonlyMap<string, readonly string[]> = new Map([
  ['234567/SP', ['1234567-47.2023.8.26.0100', '0007652-12.2022.8.26.0224']],
  ['198432/SP', ['1234567-47.2023.8.26.0100', '1000234-92.2024.8.26.0011']],
  ['311204/SP', ['1234567-47.2023.8.26.0100']],
  ['150900/SP', ['1000234-92.2024.8.26.0011']],
]);
